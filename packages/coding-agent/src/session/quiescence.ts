/**
 * Input admission, work attestation and terminal attestation for an
 * {@link AgentSession}.
 *
 * A supervisor that wants to stop an agent without interrupting work needs a
 * decision that cannot race new input: the session closes every admission
 * path, counts all outstanding work, and either records a durable terminal
 * attestation (then the host exits) or reopens admission unchanged. Every
 * step of that decision is synchronous, so no input can interleave with it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { fsyncDirectory, type InvocationIdentity, type OwnerScanSummary, stripJsonl } from "./owned-job-registry";

/** Capability: `attest` + `quiesce_and_exit` with a terminal attestation file. */
export const QUIESCE_EXIT_CAPABILITY = "quiesce-exit/1";
/** Capability: durable owned-job registry next to the session file. */
export const OWNED_JOBS_CAPABILITY = "owned-jobs/1";
/** Capabilities advertised by hosts that wire quiesce-and-exit (RPC `get_state`, extension `ctx.capabilities`). */
export const SESSION_CAPABILITIES: readonly string[] = Object.freeze([QUIESCE_EXIT_CAPABILITY, OWNED_JOBS_CAPABILITY]);

export const TERMINAL_ATTESTATION_VERSION = 1;
export const WORK_ATTESTATION_VERSION = 1;

/** Why admission is closed. Admission closes only on the way out of the process. */
export type AdmissionCloser = "quiesce" | "hangup";

/** Thrown by every input-admission path while the session is closing for exit. */
export class AdmissionClosedError extends Error {
	readonly code = "admission_closed";
	constructor(
		readonly input: string,
		readonly closedBy: AdmissionCloser,
	) {
		super(`Session is exiting (${closedBy}); ${input} was not accepted`);
		this.name = "AdmissionClosedError";
	}
}

/**
 * Outstanding work, counted synchronously. Every field is a count; flags are
 * 0 or 1. Any non-zero field means the session is not quiescent.
 */
export interface WorkCounts {
	/** 1 while a turn is streaming or a prompt is in flight. */
	streaming: number;
	/** Input accepted but not yet consumed: steering/follow-up/next-turn queues, IRC records,
	 *  queued async results and launch completions, admitted submissions still preprocessing,
	 *  and host-registered sources (e.g. RPC commands read but not yet dispatched). */
	queuedInput: number;
	/** Running or queued background jobs other than subagents (async bash, eval, …). */
	asyncJobs: number;
	/** Running or queued subagent (task) jobs. */
	subagents: number;
	/** Shells kept alive because background jobs they started are still running. */
	retainedJobs: number;
	/** Registered owned processes (background/detached/service) still alive. */
	detachedJobs: number;
	/** 1 while compaction runs. */
	compacting: number;
	/** 1 while a handoff is being generated. */
	handoff: number;
	/** 1 while a goal continuation turn is scheduled. */
	goalContinuationScheduled: number;
	/** Continuations the session scheduled for itself (retries, compaction continuation, reminders). */
	scheduledTurns: number;
}

export const WORK_COUNT_KEYS = [
	"streaming",
	"queuedInput",
	"asyncJobs",
	"subagents",
	"retainedJobs",
	"detachedJobs",
	"compacting",
	"handoff",
	"goalContinuationScheduled",
	"scheduledTurns",
] as const satisfies readonly (keyof WorkCounts)[];

export type WorkCountKind = keyof WorkCounts;

/** Host-provided work that the session cannot see itself (see {@link AgentSession.registerWorkSource}). */
export interface SessionWorkSource {
	kind: WorkCountKind;
	/** Synchronous count; must never await. */
	count(): number;
}

/** A pending goal continuation (see {@link AgentSession.reserveGoalContinuation}). */
export interface GoalContinuationReservation {
	/** Stop counting the continuation as pending. Idempotent. */
	release(): void;
}

export function emptyWorkCounts(): WorkCounts {
	return {
		streaming: 0,
		queuedInput: 0,
		asyncJobs: 0,
		subagents: 0,
		retainedJobs: 0,
		detachedJobs: 0,
		compacting: 0,
		handoff: 0,
		goalContinuationScheduled: 0,
		scheduledTurns: 0,
	};
}

export function hasOutstandingWork(counts: WorkCounts): boolean {
	return WORK_COUNT_KEYS.some(key => counts[key] > 0);
}

export interface SessionIdentity {
	id: string;
	/** Session JSONL path, or `null` for a non-persistent session. */
	file: string | null;
	/**
	 * Terminal attestations only: byte size and SHA-256 of the session file once it is final
	 * (nothing is appended afterwards). `null` when no file exists or the backend keeps no
	 * local file; for a `hangup` attestation they are filled in after teardown finishes, and
	 * stay `null` if the process dies first.
	 */
	size?: number | null;
	sha256?: string | null;
}

export interface OwnedJobRegistryState {
	/** Registry JSONL path, or `null` when the session has no registry. */
	path: string | null;
	/**
	 * False when some owned process may be missing: a registry `incomplete` marker, or an
	 * owner-marker scan that could not examine every candidate process (`ownerScan.sound`).
	 */
	complete: boolean;
	/** The owner-marker scan behind `detachedJobs`; `null` without a registry. */
	ownerScan: OwnerScanSummary | null;
}

/** Read-only snapshot answering an `attest` request. */
export interface WorkAttestation {
	version: typeof WORK_ATTESTATION_VERSION;
	operationId: string;
	nonce: string;
	/** Monotonic activity epoch; changes whenever work starts or input is admitted. */
	epoch: number;
	/**
	 * Random id of this session object in this process. A quiesce request must echo it, so a
	 * request built from one invocation's attestation can never pass in another (epochs
	 * restart in every process).
	 */
	instanceId: string;
	session: SessionIdentity;
	invocation: InvocationIdentity;
	counts: WorkCounts;
	admission: "open" | "closed";
	registry: OwnedJobRegistryState;
	/** ISO-8601 timestamp. */
	observedAt: string;
}

export interface QuiesceRequest {
	operationId: string;
	/** Non-negative integer; each new attempt for an operation must use a higher number. */
	attempt: number;
	/** The epoch from the attestation the caller based its decision on. */
	epoch: number;
	/** The `instanceId` from that attestation. */
	instanceId: string;
	/**
	 * The `session.id` from that attestation. After `new_session`/`switch_session` the
	 * request is refused (`session_mismatch`): it would attest a different transcript.
	 */
	sessionId: string;
	/**
	 * Absolute deadline, Unix epoch milliseconds, compared against the agent host's clock
	 * (`Date.now()` in the agent process). The attempt never executes at or after it. A
	 * supervisor on another host should derive it from the attestation's `observedAt` plus a
	 * relative budget so clock offset between hosts cannot extend it.
	 */
	deadline: number;
}

export type QuiesceRefusalReason =
	| "invalid_request"
	| "invocation_mismatch"
	| "session_mismatch"
	| "stale_attempt"
	| "admission_closed"
	| "deadline_expired"
	| "epoch_mismatch"
	| "work_active"
	| "attestation_unavailable";

export interface TerminalAttestation {
	version: typeof TERMINAL_ATTESTATION_VERSION;
	kind: "quiesce" | "hangup";
	operationId?: string;
	attempt?: number;
	session: SessionIdentity;
	invocation: InvocationIdentity;
	/** The session object's `instanceId` (see {@link WorkAttestation.instanceId}). */
	instanceId: string;
	epoch: number;
	/** Counts captured with admission closed, before any teardown. */
	counts: WorkCounts;
	/** True when any work was outstanding at capture (always false for `quiesce`). */
	interrupted: boolean;
	/** Registry complete and the owner-marker scan sound (see {@link OwnedJobRegistryState}). */
	registryComplete: boolean;
	registryPath: string | null;
	ownerScan: OwnerScanSummary | null;
	/** Signal that triggered a `hangup` capture. */
	signal?: string;
	/** ISO-8601 timestamp. */
	writtenAt: string;
}

export type QuiesceResult =
	| {
			status: "quiesced";
			operationId: string;
			attempt: number;
			attestation: TerminalAttestation;
			/** Where the attestation was written. */
			path: string;
	  }
	| {
			status: "refused";
			operationId: string;
			attempt: number;
			reason: QuiesceRefusalReason;
			/** Work observed while deciding (admission was closed at that instant). */
			snapshot: { epoch: number; counts: WorkCounts; observedAt: string };
	  }
	| {
			/**
			 * The session was idle and its transcript was made final, but the terminal
			 * attestation could not be written. The host exits anyway (exit code 1); no
			 * attestation exists, so consumers take the registry path.
			 */
			status: "exit_unattested";
			operationId: string;
			attempt: number;
			reason: "attestation_unavailable";
			error: string;
			snapshot: { epoch: number; counts: WorkCounts; observedAt: string };
	  };

/** True when the host must exit after answering this result. */
export function quiesceEndsProcess(result: QuiesceResult): boolean {
	return result.status === "quiesced" || result.status === "exit_unattested";
}

/** Process exit code after a result that ends the process. */
export function quiesceExitCode(result: QuiesceResult): number {
	return result.status === "quiesced" ? 0 : 1;
}

/**
 * After a quiesce result ends the process, the longest the host lets teardown run before it
 * ends the process anyway (the attestation, if any, is already written).
 */
export const QUIESCE_EXIT_DEADLINE_MS = 30_000;

/** `<session file without .jsonl>.terminal.json` */
export function terminalAttestationPath(sessionFile: string): string {
	return `${stripJsonl(sessionFile)}.terminal.json`;
}

/** Throw unless the attestation's directory exists (created if needed) and is writable. */
export function assertAttestationWritable(file: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	fs.accessSync(dir, fs.constants.W_OK);
}

/**
 * Durably publish `attestation` at `file`: write a sibling temp file, fsync it,
 * rename over the target, then fsync the directory. Synchronous on purpose —
 * the quiesce decision must complete before the event loop can admit input.
 */
export function writeTerminalAttestationSync(file: string, attestation: TerminalAttestation): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const temp = attestationTempPath(file, process.pid);
	try {
		const fd = fs.openSync(temp, "w", 0o600);
		try {
			fs.writeSync(fd, `${JSON.stringify(attestation, null, 2)}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, file);
	} catch (error) {
		// An unpublished attestation must not be left where it could be mistaken for one.
		fs.rmSync(temp, { force: true });
		throw error;
	}
	fsyncDirectory(dir);
}

function attestationTempPath(file: string, pid: number): string {
	return `${file}.${pid}.tmp`;
}

/**
 * Remove temp attestations whose writer is gone (a crash between write and publish). Best
 * effort: an entry that cannot be removed (a directory of that name, a permission error) is
 * left, and never stops the retirement that follows.
 */
function sweepAttestationTempFiles(file: string): void {
	const dir = path.dirname(file);
	const prefix = `${path.basename(file)}.`;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const match = name.startsWith(prefix) ? /^(\d+)\.tmp$/.exec(name.slice(prefix.length)) : null;
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || isProcessRunning(pid)) continue;
		try {
			fs.rmSync(path.join(dir, name), { force: true });
		} catch (error) {
			logger.warn("Could not remove a stale terminal attestation temp file", { name, error: String(error) });
		}
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Retire a terminal attestation left by an earlier invocation of this session: rename it to
 * `<base>.terminal.<pid>-<startId>.json` (its writer's identity) and fsync the directory, so
 * `<base>.terminal.json` only ever describes the latest invocation's exit. Unpublished temp
 * attestations of writers that are gone are removed. Returns the retired path, or `null`
 * when there was nothing to retire.
 */
export function retireTerminalAttestationSync(sessionFile: string): string | null {
	const file = terminalAttestationPath(sessionFile);
	sweepAttestationTempFiles(file);
	let writer = "unknown";
	try {
		const previous = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TerminalAttestation>;
		if (previous.invocation) writer = `${previous.invocation.pid}-${previous.invocation.startId ?? "unknown"}`;
	} catch (error) {
		if (isEnoent(error)) return null;
	}
	const retired = `${stripJsonl(sessionFile)}.terminal.${writer}.json`;
	fs.renameSync(file, retired);
	fsyncDirectory(path.dirname(file));
	return retired;
}
