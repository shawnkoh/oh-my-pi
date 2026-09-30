/**
 * External delivery (`external-delivery/1`): directed records handed to the
 * session by an embedder that needs honest receipts for them.
 *
 * Each record is a `custom` message that owns its admission (ADMIT/DEFER/
 * COMMIT/DISCARD hooks from agent-core). The owner is a tri-state
 * `queued → accepted | cancelled | discarded`; an accepted owner settles once
 * the evaluation it joined has fully settled (retries, compaction and other
 * continuations included).
 *
 * An *evaluation* is one in-flight prompt cycle of the session. It is
 * *delivery-owned* when its initial prompt set consisted only of owned records
 * and no interactive input (see `isUserAuthoredQueuedMessage`) ever joined;
 * only such an evaluation may finish quietly (empty final stop removed, no
 * recovery, no continuation reminders).
 */
import {
	type AgentEvent,
	type AgentMessage,
	ASIDE_MESSAGE_ADMIT,
	ASIDE_MESSAGE_COMMIT,
	ASIDE_MESSAGE_DEFER,
	ASIDE_MESSAGE_DISCARD,
	isOwnedAsideMessage,
	LLM_MESSAGE_SOURCE,
	type OwnedAsideAdmission,
	type OwnedAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { CustomMessage, NormalizedCustomMessagePayload } from "./messages";
import { isUserAuthoredQueuedMessage } from "./queued-messages";

/** Capability id an embedder checks before using `deliverMessage`. */
export const EXTERNAL_DELIVERY_CAPABILITY = "external-delivery/1";

export type DeliveryMode = "aside" | "steer";
export type DeliveryMechanism = "wake" | "aside" | "steer-boundary";
export type DeliveryState = "queued" | "accepted" | "cancelled" | "discarded" | "settled";

export interface DeliveryOptions {
	/** `aside`: never interrupts; `steer`: forces the next turn (never accepted as an aside). */
	mode: DeliveryMode;
	/** Advisory: the deliverer expects a quiet completion. */
	quiet?: true;
	/** Idle after an operator interrupt still wakes (the interrupt latch stays set). */
	wakeAfterInterrupt?: true;
	/** Idle in plan mode still wakes. */
	wakeInPlanMode?: true;
}

export interface DeliveryAcceptance {
	at: number;
	mode: DeliveryMode;
	mechanism: DeliveryMechanism;
}

export interface DeliverySettlement {
	outcome: "quiet" | "text" | "refused" | "error" | "aborted";
	/** Exactly one stamped user-role projection reached a completed main request. */
	included: boolean;
	/** Main-evaluation provider requests observed while the record was in context. */
	requests: number;
	/** No other admitted input joined the owning evaluation. */
	sole: boolean;
	/** An interactive input joined the owning evaluation. */
	interactive: boolean;
}

export interface DeliveryHandle {
	readonly id: string;
	state(): DeliveryState;
	readonly accepted: Promise<DeliveryAcceptance>;
	/** Resolves only after `accepted`. */
	readonly settled: Promise<DeliverySettlement>;
	/** Resolves iff the record was never accepted and dropped at a committed transition/disposal. */
	readonly discarded: Promise<{ reason: string }>;
	/** True iff the record was still queued. A cancelled record is refused by every later admission. */
	cancel(): boolean;
}

/** Externally held record listing (RPC `get_state`). */
export interface ExternalDeliveryListing {
	deliveryId: string;
	state: DeliveryState;
	mode: DeliveryMode;
}

/** Session capabilities the delivery registry borrows. */
export interface ExternalDeliveryHost {
	isSessionTransitioning(): boolean;
	isDisposed(): boolean;
	/** Returns still-queued records the loop handed back (deferred admission, loop ended before insert). */
	requeue(records: OwnedAsideMessage[]): void;
	/** Removes a retired record from every host queue. */
	removeQueued(record: AgentMessage): void;
	isClassifierRefusal(message: AssistantMessage): boolean;
}

/** Provider view an owned record projects: `details["omp.llm"]` with `details["omp.llm.source"]`. */
interface IntendedProjection {
	source: string;
	content: string | (TextContent | ImageContent)[];
	attribution: string;
	timestamp: number;
}

type OwnedRecord = CustomMessage & OwnedAsideMessage;

function readIntendedProjection(record: CustomMessage): IntendedProjection | undefined {
	const details = record.details;
	if (!isRecord(details)) return undefined;
	const projection = details["omp.llm"];
	const source = details["omp.llm.source"];
	if (!isRecord(projection) || projection.role !== "user" || typeof source !== "string") return undefined;
	const content: unknown = projection.content;
	if (typeof content !== "string" && !Array.isArray(content)) return undefined;
	// The core projection validates the parts; the host only needs the shape for deep-equality.
	const projectedContent = content as IntendedProjection["content"];
	return {
		source,
		content: projectedContent,
		attribution: record.attribution ?? "agent",
		timestamp: record.timestamp,
	};
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) if (!deepEqual(left[i], right[i])) return false;
		return true;
	}
	// Both sides are non-null, non-array objects here; only string-keyed reads follow.
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	if (leftKeys.length !== Object.keys(rightRecord).length) return false;
	for (const key of leftKeys) {
		if (!Object.hasOwn(rightRecord, key)) return false;
		if (!deepEqual(leftRecord[key], rightRecord[key])) return false;
	}
	return true;
}

function matchesProjection(message: Message, projection: IntendedProjection): boolean {
	if (message.role !== "user") return false;
	if (!(LLM_MESSAGE_SOURCE in message) || message[LLM_MESSAGE_SOURCE] !== projection.source) return false;
	return (
		message.attribution === projection.attribution &&
		message.timestamp === projection.timestamp &&
		deepEqual(message.content, projection.content)
	);
}

function isSilentBlock(block: AssistantMessage["content"][number]): boolean {
	return block.type === "thinking" || (block.type === "text" && !/\S/.test(block.text));
}

/** A final `stop` whose blocks are all thinking (any signature) or whitespace text. */
export function isQuietAssistantStop(
	message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">,
): boolean {
	return message.stopReason === "stop" && message.errorMessage === undefined && message.content.every(isSilentBlock);
}

/** Text, tool-call, image, server-tool or redacted output the recipient produced. */
function hasDeliverableOutput(message: AssistantMessage): boolean {
	return message.content.some(block => !isSilentBlock(block));
}

/** Inputs admitted to an evaluation: prompts, steering, asides, follow-ups, continuations. */
function isEvaluationInput(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "developer"
	);
}

/** One in-flight prompt cycle as seen by the owners admitted into it. */
class DeliveryEvaluation {
	readonly owners: ExternalDeliveryOwner[] = [];
	/** Inputs admitted so far (owned records included). */
	inputs = 0;
	interactive = false;
	aborted = false;
	/** True while the initial prompt set is still being observed (before the first assistant message). */
	#initial = true;
	#initialAllOwned = true;
	#ownedInitial = 0;
	#assistantStreaming = false;
	/** Stamp counts of the main request currently in flight, consumed at its assistant `message_end`. */
	#pendingRequest: Map<ExternalDeliveryOwner, number> | undefined;

	get deliveryOwned(): boolean {
		return this.#initialAllOwned && this.#ownedInitial > 0 && !this.interactive;
	}

	get assistantStreaming(): boolean {
		return this.#assistantStreaming;
	}

	noteInput(message: AgentMessage): void {
		this.inputs++;
		if (isUserAuthoredQueuedMessage(message)) this.interactive = true;
		if (!this.#initial) return;
		if (isOwnedAsideMessage(message)) this.#ownedInitial++;
		else this.#initialAllOwned = false;
	}

	noteAssistantStart(): void {
		this.#initial = false;
		this.#assistantStreaming = true;
	}

	noteAssistantEnd(message: AssistantMessage): void {
		this.#initial = false;
		this.#assistantStreaming = false;
		const pending = this.#pendingRequest;
		this.#pendingRequest = undefined;
		for (const owner of this.owners) {
			owner.lastAssistant = message;
			if (hasDeliverableOutput(message)) owner.producedOutput = true;
		}
		if (!pending || message.stopReason === "error") return;
		for (const [owner, count] of pending) if (count === 1) owner.included = true;
	}

	/** Observes the provider view of one main request after the whole `convertToLlm` pipeline. */
	noteRequest(converted: readonly Message[]): void {
		const pending = new Map<ExternalDeliveryOwner, number>();
		for (const owner of this.owners) {
			owner.requests++;
			const projection = owner.projection;
			if (!projection) continue;
			let count = 0;
			for (const message of converted) if (matchesProjection(message, projection)) count++;
			pending.set(owner, count);
		}
		this.#pendingRequest = pending;
	}
}

/** Owner tri-state and receipts for one delivered record. */
export class ExternalDeliveryOwner {
	readonly id: string;
	readonly mode: DeliveryMode;
	readonly options: DeliveryOptions;
	readonly record: OwnedRecord;
	readonly projection: IntendedProjection | undefined;
	/** Scheduling branch the record last took; reported at acceptance. */
	mechanism: DeliveryMechanism = "wake";
	/** Times the loop deferred admission and the host re-queued the record. */
	deferrals = 0;
	requests = 0;
	included = false;
	producedOutput = false;
	lastAssistant: AssistantMessage | undefined;
	readonly handle: DeliveryHandle;
	#state: DeliveryState = "queued";
	readonly #accepted = Promise.withResolvers<DeliveryAcceptance>();
	readonly #settled = Promise.withResolvers<DeliverySettlement>();
	readonly #discarded = Promise.withResolvers<{ reason: string }>();

	constructor(
		id: string,
		payload: NormalizedCustomMessagePayload,
		options: DeliveryOptions,
		hooks: {
			admit: (owner: ExternalDeliveryOwner) => OwnedAsideAdmission;
			commit: (owner: ExternalDeliveryOwner) => void;
			discard: (owner: ExternalDeliveryOwner) => void;
			cancel: (owner: ExternalDeliveryOwner) => void;
		},
	) {
		this.id = id;
		this.mode = options.mode;
		this.options = options;
		this.record = {
			role: "custom",
			customType: payload.customType,
			content: payload.content,
			display: payload.display,
			details: payload.details,
			attribution: "agent",
			timestamp: Date.now(),
			[ASIDE_MESSAGE_ADMIT]: () => hooks.admit(this),
			[ASIDE_MESSAGE_DEFER]: () => {
				this.deferrals++;
			},
			[ASIDE_MESSAGE_COMMIT]: () => hooks.commit(this),
			[ASIDE_MESSAGE_DISCARD]: () => hooks.discard(this),
		};
		this.projection = readIntendedProjection(this.record);
		this.handle = {
			id,
			state: () => this.#state,
			accepted: this.#accepted.promise,
			settled: this.#settled.promise,
			discarded: this.#discarded.promise,
			cancel: () => {
				if (!this.cancel()) return false;
				hooks.cancel(this);
				return true;
			},
		};
	}

	get state(): DeliveryState {
		return this.#state;
	}

	get terminal(): boolean {
		return this.#state === "cancelled" || this.#state === "discarded" || this.#state === "settled";
	}

	/** Admission veto consulted by the loop immediately before append. */
	admit(transitioning: boolean): OwnedAsideAdmission {
		if (this.#state !== "queued") return "drop";
		return transitioning ? "defer" : "admit";
	}

	/** The loop appended the record: `queued → accepted`. */
	commit(): void {
		if (this.#state !== "queued") return;
		this.#state = "accepted";
		this.#accepted.resolve({ at: Date.now(), mode: this.mode, mechanism: this.mechanism });
	}

	/** Dropped at a committed transition or disposal: `queued → discarded`. */
	discard(reason: string): boolean {
		if (this.#state !== "queued") return false;
		this.#state = "discarded";
		this.#discarded.resolve({ reason });
		return true;
	}

	cancel(): boolean {
		if (this.#state !== "queued") return false;
		this.#state = "cancelled";
		return true;
	}

	settle(settlement: DeliverySettlement): void {
		if (this.#state !== "accepted") return;
		this.#state = "settled";
		this.#settled.resolve(settlement);
	}

	outcome(
		isClassifierRefusal: (message: AssistantMessage) => boolean,
		aborted: boolean,
	): DeliverySettlement["outcome"] {
		const last = this.lastAssistant;
		if (aborted || last?.stopReason === "aborted") return "aborted";
		if (!last) return "error";
		if (last.stopReason === "error") return isClassifierRefusal(last) ? "refused" : "error";
		if (this.producedOutput) return "text";
		return isQuietAssistantStop(last) ? "quiet" : "error";
	}
}

/**
 * Registry of every live external record plus the evaluation bookkeeping that
 * turns loop events into receipts. Owned by the session; all bookkeeping is
 * synchronous so it observes events in emission order.
 */
export class ExternalDeliveries {
	readonly #host: ExternalDeliveryHost;
	readonly #owners = new Map<string, ExternalDeliveryOwner>();
	readonly #byRecord = new WeakMap<AgentMessage, ExternalDeliveryOwner>();
	#evaluation: DeliveryEvaluation | undefined;
	#sequence = 0;

	constructor(host: ExternalDeliveryHost) {
		this.#host = host;
	}

	create(payload: NormalizedCustomMessagePayload, options: DeliveryOptions): ExternalDeliveryOwner {
		const id = `delivery_${++this.#sequence}_${Date.now().toString(36)}`;
		const owner = new ExternalDeliveryOwner(id, payload, options, {
			admit: target => target.admit(this.#host.isSessionTransitioning()),
			commit: target => {
				target.commit();
				this.#ensureEvaluation().owners.push(target);
			},
			discard: target => this.#loopDiscard(target),
			cancel: target => this.#retire(target),
		});
		this.#owners.set(id, owner);
		this.#byRecord.set(owner.record, owner);
		return owner;
	}

	ownerOf(record: AgentMessage): ExternalDeliveryOwner | undefined {
		return this.#byRecord.get(record);
	}

	/** Every record still queued or accepted-but-unsettled. */
	list(): ExternalDeliveryListing[] {
		const listing: ExternalDeliveryListing[] = [];
		for (const owner of this.#owners.values()) {
			listing.push({ deliveryId: owner.id, state: owner.state, mode: owner.mode });
		}
		return listing;
	}

	/** Whether any owner is still queued (unaccepted, not retired). */
	hasQueued(): boolean {
		for (const owner of this.#owners.values()) if (owner.state === "queued") return true;
		return false;
	}

	cancel(id: string): boolean {
		const owner = this.#owners.get(id);
		if (!owner) return false;
		return owner.handle.cancel();
	}

	/** Discards every unaccepted owner (committed transition or disposal). Rollback never calls this. */
	retireAll(reason: string): void {
		// Snapshot: #retire deletes from #owners while we iterate.
		// oxlint-disable-next-line unicorn/no-useless-spread
		for (const owner of [...this.#owners.values()]) {
			if (!owner.discard(reason)) continue;
			this.#retire(owner);
		}
	}

	/** Drops records whose owner is no longer queued (cancelled/discarded) from a restored snapshot. */
	prune<T extends AgentMessage>(records: readonly T[]): T[] {
		return records.filter(record => {
			const owner = this.#byRecord.get(record);
			return owner === undefined || owner.state === "queued";
		});
	}

	/** Core `onDeferredMessages` hook: re-queue each deferred record exactly once per deferral. */
	onDeferred(messages: readonly AgentMessage[]): void {
		const requeue: OwnedAsideMessage[] = [];
		for (const message of messages) {
			const owner = this.#byRecord.get(message);
			if (owner?.state === "queued") requeue.push(owner.record);
		}
		if (requeue.length > 0) this.#host.requeue(requeue);
	}

	/** Wraps the agent's converter so every main request's provider view is observed. */
	wrapConvertToLlm(
		convert: (messages: AgentMessage[]) => Message[] | Promise<Message[]>,
	): (messages: AgentMessage[]) => Message[] | Promise<Message[]> {
		return messages => {
			const converted = convert(messages);
			const observe = (result: Message[]): Message[] => {
				const evaluation = this.#evaluation;
				// A conversion while an assistant message streams is a live-steering
				// batch, not a main request.
				if (evaluation && !evaluation.assistantStreaming) evaluation.noteRequest(result);
				return result;
			};
			return converted instanceof Promise ? converted.then(observe) : observe(converted);
		};
	}

	/** Synchronous bookkeeping at the top of the session's agent event handler. */
	onAgentEvent(event: AgentEvent): void {
		if (event.type === "agent_start") {
			this.#ensureEvaluation();
			return;
		}
		const evaluation = this.#evaluation;
		if (!evaluation) return;
		if (event.type === "message_start" && event.message.role === "assistant") {
			evaluation.noteAssistantStart();
		} else if (event.type === "message_end") {
			if (event.message.role === "assistant") evaluation.noteAssistantEnd(event.message);
			else if (isEvaluationInput(event.message)) evaluation.noteInput(event.message);
		}
	}

	/** Whether the current evaluation may finish quietly on this final stop. */
	quietPrivilege(message: AssistantMessage): boolean {
		return this.#evaluation?.deliveryOwned === true && isQuietAssistantStop(message);
	}

	/** Stop-boundary drain policy: owned asides join a finished run only when it is delivery-owned. */
	drainsOwnedAtStopBoundary(): boolean {
		return this.#evaluation?.deliveryOwned === true;
	}

	/** Settles every owner admitted into the evaluation that just settled. */
	settleEvaluation(options?: { aborted?: boolean }): void {
		const evaluation = this.#evaluation;
		if (!evaluation) return;
		this.#evaluation = undefined;
		const aborted = options?.aborted === true || evaluation.aborted;
		for (const owner of evaluation.owners) {
			owner.settle({
				outcome: owner.outcome(message => this.#host.isClassifierRefusal(message), aborted),
				included: owner.included,
				requests: owner.requests,
				sole: evaluation.inputs <= 1,
				interactive: evaluation.interactive,
			});
			this.#owners.delete(owner.id);
		}
	}

	#ensureEvaluation(): DeliveryEvaluation {
		return (this.#evaluation ??= new DeliveryEvaluation());
	}

	#retire(owner: ExternalDeliveryOwner): void {
		this.#host.removeQueued(owner.record);
		this.#owners.delete(owner.id);
	}

	/** The loop drained the record but ended before inserting it. */
	#loopDiscard(owner: ExternalDeliveryOwner): void {
		if (owner.state !== "queued") return;
		if (this.#host.isDisposed()) {
			owner.discard("disposed");
			this.#retire(owner);
			return;
		}
		// Still queued: hand it back so a later poll (or a committed transition's
		// retirement) decides its fate instead of losing the drained copy.
		this.#host.requeue([owner.record]);
	}
}
