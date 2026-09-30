/**
 * Prompt completion reporting for RPC mode.
 *
 * Every accepted `prompt`/`abort_and_prompt` that is not answered synchronously
 * with `data.agentInvoked: false` gets exactly one `prompt_result` frame, emitted
 * once all work the prompt caused has settled: immediately for local-only slash
 * commands and failures, or after the terminal `agent_end` of the run the prompt
 * started or joined. Hosts correlate on the command `id` instead of inferring
 * ownership of an `agent_end` that carries no prompt identity.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { isRpcSessionSettled, type RpcSettleSession } from "./rpc-session-settle";
import type { RpcPromptError, RpcPromptResultFrame, RpcPromptStatus } from "./rpc-types";

/** A prompt accepted by RPC mode whose `prompt_result` is still owed; see {@link RpcPromptResults.begin}. */
export interface RpcPromptTicket {
	readonly id: string | undefined;
	/** Exact user text of a literal prompt, used to find its persisted message; undefined when parsing may rewrite it. */
	readonly text?: string;
}

interface RunOutcome {
	status: RpcPromptStatus;
	error?: RpcPromptError;
	/** Engine-local ordinal of the run whose yield answered the prompt; shared by prompts answered together. */
	run?: number;
	/** This prompt's entries in that run, resolved at the yield; present whenever `run` is. */
	attribution?: Attribution;
}

/** A prompt's own persisted user entry and the assistant entries that answered it. */
interface Attribution {
	prompt?: string;
	reply: string[];
}

/** Message entries a run persisted on the branch, from its first `agent_start` to its yield. */
type RunSegment = ReadonlyArray<{ id: string; role: string; text?: string }>;

/** Session surface the reporter reads: settle state plus the persisted branch. */
export type RpcPromptResultSession = RpcSettleSession & {
	readonly sessionManager: Pick<AgentSession["sessionManager"], "getLeafId" | "getBranch" | "getSessionId">;
};

interface OpenPrompt {
	/** `agent_start` count at acceptance; a later start begins a run this prompt may own. */
	startsAtBegin: number;
	/** Outcome of the first run started after acceptance, once the agent yielded it. */
	ownOutcome?: RunOutcome;
	/** Settled while another run was live: reported at the next yield that leaves nothing queued. */
	waiting: boolean;
}

/**
 * Correlates accepted prompts with the run that carries their work and emits
 * their `prompt_result`. Fed every session event through {@link observe}.
 *
 * A prompt reports when the agent **yields** its work (`agent_end` with
 * `yielded`), not when the session is done: background jobs may still wake the
 * session later (see {@link RpcSessionSettleWatcher}), which `sessionSettled`
 * on the frame reports.
 *
 * A prompt dispatched as a fresh turn owns the first run that starts after it
 * was accepted, so a late `agent_end` from an earlier run never settles it. A
 * prompt queued into a live run (steer/follow-up) resolves while that run
 * streams and reports at the first yield after its message left the queue.
 */
export class RpcPromptResults {
	#agentStarts = 0;
	/** Runs counted from the first `agent_start` after a yield; retries and continuations stay in the same run. */
	#runs = 0;
	#betweenRuns = true;
	#runStart: { leaf: string | null; sessionId: string } | undefined;
	#open = new Map<RpcPromptTicket, OpenPrompt>();
	readonly #session: RpcPromptResultSession;
	readonly #output: (frame: RpcPromptResultFrame) => void;

	/** @param session read for queue state, persisted entry ids and, at report time, the `sessionSettled` predicate. */
	constructor(session: RpcPromptResultSession, output: (frame: RpcPromptResultFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/** Open a ticket before the prompt starts any work. Close it with exactly one report or {@link discard}. */
	begin(id: string | undefined, literalText?: string): RpcPromptTicket {
		const ticket: RpcPromptTicket = literalText === undefined ? { id } : { id, text: literalText };
		this.#open.set(ticket, { startsAtBegin: this.#agentStarts, waiting: false });
		return ticket;
	}

	/**
	 * The prompt's command scheduled agent work (for example an extension
	 * command's `sendUserMessage`). When nothing is streaming, that work starts
	 * a fresh run, and the prompt owns that run, not an earlier one (such as a
	 * delivery wake while the command's handler ran). Work queued into a live
	 * run leaves ownership unchanged. When a command schedules work from idle
	 * more than once, the run started by the last such work is reported.
	 * Known limit: a send that lands while a wake run is unwinding (still
	 * streaming, past its last queue poll) is queued, so that wake still
	 * answers the prompt.
	 */
	rebase(ticket: RpcPromptTicket): void {
		const open = this.#open.get(ticket);
		if (!open || open.waiting || this.#session.isStreaming) return;
		open.ownOutcome = undefined;
		open.startsAtBegin = this.#agentStarts;
	}

	/** Drop a ticket whose command was rejected before it was accepted (no `prompt_result` is owed). */
	discard(ticket: RpcPromptTicket): void {
		this.#open.delete(ticket);
	}

	/**
	 * The prompt's work reached the agent (dispatched or queued). Reports now if
	 * its own run already settled, otherwise at the next terminal `agent_end`.
	 */
	settle(ticket: RpcPromptTicket): void {
		const open = this.#open.get(ticket);
		if (!open) return;
		if (open.ownOutcome) {
			this.#report(ticket, true, open.ownOutcome);
		} else if (this.#session.isStreaming || this.#agentStarts > open.startsAtBegin) {
			// Queued into a live run, or its own run paused for agent-owned follow-up work (e.g. a retry).
			open.waiting = true;
		} else {
			// Idle with no run since acceptance: an abort won the race before dispatch.
			this.#report(ticket, true, { status: "aborted" });
		}
	}

	/** The prompt was handled locally without an agent turn. */
	completeLocal(ticket: RpcPromptTicket): void {
		this.#report(ticket, false, { status: "completed" });
	}

	/** The prompt failed before reaching the agent. */
	fail(ticket: RpcPromptTicket, message: string): void {
		this.#report(ticket, false, { status: "error", error: { message, retryable: false } });
	}

	/**
	 * Mark every open prompt aborted after a session transition. Transitions
	 * detach the agent before aborting it, so the interrupted run never
	 * publishes a terminal `agent_end` for them.
	 */
	abortOpen(): void {
		// The detached run never yields; the next start begins a new run in the new session.
		this.#betweenRuns = true;
		this.#runStart = undefined;
		for (const [ticket, open] of this.#open) {
			if (open.waiting) this.#report(ticket, true, { status: "aborted" });
			else open.ownOutcome ??= { status: "aborted" };
		}
	}

	/** Track run boundaries; call after the event has been written so `prompt_result` follows its `agent_end`. */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#agentStarts++;
			if (this.#betweenRuns) {
				this.#betweenRuns = false;
				this.#runs++;
				const manager = this.#session.sessionManager;
				this.#runStart = { leaf: manager.getLeafId(), sessionId: manager.getSessionId() };
			}
			return;
		}
		if (event.type !== "agent_end") return;
		// Older sessions omit `yielded`; only their terminal ends were yields.
		if (!(event.yielded ?? event.isTerminal !== false)) return;
		// An end with no start since the last yield belongs to no run this engine counted.
		const inRun = !this.#betweenRuns;
		this.#betweenRuns = true;
		if (this.#open.size === 0) return;
		const outcome = runOutcome(event.messages);
		// A still-queued steer/follow-up has not been read by the agent yet.
		const queueDrained = this.#session.queuedMessageCount === 0;
		// Every prompt this yield answers, in acceptance order: those waiting on it
		// report now, a prompt whose own run this was reports when it settles.
		const answered: Array<[RpcPromptTicket, OpenPrompt]> = [];
		for (const [ticket, open] of this.#open) {
			if (open.waiting ? queueDrained : !open.ownOutcome && this.#agentStarts > open.startsAtBegin) {
				answered.push([ticket, open]);
			}
		}
		// Attribution is resolved once for all of them, before any report.
		const attributions = inRun
			? attribute(
					answered.map(([ticket]) => ticket),
					this.#segment(),
				)
			: undefined;
		for (const [index, [ticket, open]] of answered.entries()) {
			const own: RunOutcome = attributions
				? { ...outcome, run: this.#runs, attribution: attributions[index] }
				: outcome;
			if (open.waiting) this.#report(ticket, true, own);
			else open.ownOutcome = own;
		}
	}

	/**
	 * Snapshot, at the yield, of the message entries the run persisted: those
	 * after its start leaf on the current branch of the same session. A session
	 * switch or a branch that no longer holds the start leaf yields nothing.
	 */
	#segment(): RunSegment | undefined {
		const start = this.#runStart;
		const manager = this.#session.sessionManager;
		if (!start || manager.getSessionId() !== start.sessionId) return undefined;
		const branch = manager.getBranch();
		const from = start.leaf === null ? 0 : branch.findIndex(entry => entry.id === start.leaf) + 1;
		if (from === 0 && start.leaf !== null) return undefined;
		const entries = branch.slice(from).flatMap((entry): RunSegment[number][] => {
			if (entry.type === "custom_message") return isReplyBoundary(entry) ? [{ id: entry.id, role: "boundary" }] : [];
			if (entry.type !== "message") return [];
			const message = entry.message;
			if (message.role === "user") return [{ id: entry.id, role: "user", text: userText(message.content) }];
			return message.role === "assistant" ? [{ id: entry.id, role: "assistant" }] : [];
		});
		return entries;
	}

	#report(ticket: RpcPromptTicket, agentInvoked: boolean, outcome: RunOutcome): void {
		if (!this.#open.delete(ticket)) return;
		// A prompt command's response is written after the handler's remaining
		// microtasks; deferring to the next macrotask keeps every prompt_result
		// behind the response for the same id and lets queue drains land before
		// `sessionSettled` is read.
		setImmediate(() => {
			const frame: RpcPromptResultFrame = {
				type: "prompt_result",
				id: ticket.id,
				agentInvoked,
				status: outcome.status,
				sessionSettled: isRpcSessionSettled(this.#session),
			};
			if (outcome.error) frame.error = outcome.error;
			if (outcome.run !== undefined) {
				frame.run = outcome.run;
				if (outcome.attribution?.prompt) frame.promptEntryId = outcome.attribution.prompt;
				frame.replyEntryIds = outcome.attribution?.reply ?? [];
			}
			this.#output(frame);
		});
	}
}

/**
 * Each answered prompt's own user entry and the assistant entries after it up
 * to the next user entry. A literal prompt is identified by its exact text
 * only when no other prompt answered by this yield has the same text and one
 * user entry carries it: a steer can overtake an earlier follow-up, so
 * acceptance order is not delivery order. A parsed prompt is identified only
 * when it is the sole prompt answered and the run delivered one user message.
 * Anything else is claimed as nothing, never guessed.
 */
function attribute(tickets: readonly RpcPromptTicket[], segment: RunSegment | undefined): Attribution[] {
	if (!segment) return tickets.map(() => ({ reply: [] }));
	const users = segment.filter(entry => entry.role === "user");
	const count = <T>(values: T[], value: T) => values.filter(candidate => candidate === value).length;
	const texts = tickets.map(ticket => ticket.text);
	return tickets.map(ticket => {
		let own: (typeof segment)[number] | undefined;
		if (ticket.text !== undefined) {
			const matches = users.filter(entry => entry.text === ticket.text);
			if (count(texts, ticket.text) === 1 && matches.length === 1) own = matches[0];
		} else if (tickets.length === 1 && users.length === 1) {
			own = users[0];
		}
		if (!own) return { reply: [] };
		const reply: string[] = [];
		for (const entry of segment.slice(segment.indexOf(own) + 1)) {
			if (entry.role === "user" || entry.role === "boundary") break;
			reply.push(entry.id);
		}
		return { prompt: own.id, reply };
	});
}

/** Custom entries the model reads as a new input it answers, not as context for the prompt. */
const REPLY_BOUNDARY_CUSTOM_TYPES: ReadonlySet<string> = new Set(["goal-mode-context", "irc:incoming"]);

/**
 * A persisted custom entry that ends the preceding reply: an owner-projected
 * external input (a delivery, carrying `details["omp.llm"]`), goal-mode
 * context steered into a live run, or an incoming subagent message. Such entries are never a prompt's own
 * message, so they are not counted when identifying prompts.
 */
function isReplyBoundary(entry: { customType: string; details?: unknown }): boolean {
	if (REPLY_BOUNDARY_CUSTOM_TYPES.has(entry.customType)) return true;
	const details = entry.details;
	return typeof details === "object" && details !== null && "omp.llm" in details;
}

function userText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string"
		? content
		: content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Outcome of a run, read from its final assistant message. */
function runOutcome(messages: readonly AgentMessage[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return { status: "error", error: promptError(message) };
		if (message.stopReason === "aborted") return { status: "aborted" };
		return { status: "completed" };
	}
	return { status: "completed" };
}

function promptError(message: AssistantMessage): RpcPromptError {
	const errorId = AIError.classifyMessage({
		api: message.api,
		provider: message.provider,
		model: message.model,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorClassificationMessage: message.errorClassificationMessage,
		errorStatus: message.errorStatus,
	});
	const error: RpcPromptError = {
		message: message.errorMessage ? stripRawHttpRequestDiagnostics(message.errorMessage) : "Provider request failed",
		provider: message.provider,
		model: message.model,
		retryable: AIError.is(errorId, AIError.Flag.Transient),
	};
	if (message.errorStatus !== undefined) error.httpStatus = message.errorStatus;
	return error;
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
	/** Called as each agent-message task is scheduled, before it can start a run. */
	onAgentMessageTask?: () => void;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt's result must wait for the agent work.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.onAgentMessageTask?.();
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			scope.onAgentMessageTask?.();
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(
		startPrompt: () => Promise<T>,
		onAgentMessageTask?: () => void,
	): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
			onAgentMessageTask,
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

/**
 * Route a started prompt's resolution into its `prompt_result`: `false` without
 * extension-scheduled agent work completes locally, agent work settles through
 * the run, and a rejection is reported via `onError` and as a failed result.
 */
export function reportPromptResult(input: {
	ticket: RpcPromptTicket;
	prompt: Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (!agentInvoked) await input.waitForExtensionAgentMessageTasks?.();
			if (agentInvoked || input.hasExtensionAgentMessageTask?.()) input.results.settle(input.ticket);
			else input.results.completeLocal(input.ticket);
		})
		.catch(cause => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			input.onError(error);
			input.results.fail(input.ticket, error.message);
		});
}

/**
 * Start a prompt under extension-message tracking and report its `prompt_result`.
 *
 * `startPrompt` receives an admission callback to forward as
 * `PromptOptions.onPromptAdmitted`. The returned promise resolves once the
 * prompt is admitted, or once it settles without ever being admitted; it never
 * rejects, since a failure is already routed to `onError` and the failed
 * `prompt_result`. Await it to acknowledge the command only after admission.
 */
export function watchAndReportPromptResult(input: {
	ticket: RpcPromptTicket;
	startPrompt: (onPromptAdmitted: () => void) => Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): Promise<void> {
	const admitted = Promise.withResolvers<void>();
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(
		() => input.startPrompt(admitted.resolve),
		() => input.results.rebase(input.ticket),
	);
	reportPromptResult({
		ticket: input.ticket,
		prompt: trackedPrompt.prompt,
		results: input.results,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
	const settled = () => admitted.resolve();
	void trackedPrompt.prompt.then(settled, settled);
	return admitted.promise;
}
