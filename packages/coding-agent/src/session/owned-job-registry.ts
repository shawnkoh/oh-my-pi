/**
 * Durable registry of work an agent process owns, so a supervisor can tell
 * after the process is gone whether anything it started is still running.
 *
 * File: `<session file without .jsonl>.jobs.jsonl`, append-only JSONL. Every
 * record is written with a synchronous append + fsync before the registering
 * call returns. Each process invocation that writes to a file first appends an
 * `invocation` record; `start` and `end` records carry the invocation pid.
 *
 * Consumers decide per invocation:
 * - any `incomplete` record, or an `invocation` record with `complete: false`,
 *   means some owned process may be missing: answer `unknown`;
 * - a `start` with `inProcess: true` and no `end` after its invocation ended
 *   means the job's descendants were never enumerated: answer `unknown`;
 * - a `start` with `inProcess: false` and no `end` is alive iff a process with
 *   that `pid` exists whose OS start time equals `startTime`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { processStartTime, type SpawnedProcess } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

export const OWNED_JOB_REGISTRY_VERSION = 1;
/**
 * - `async-job`: an in-process background job (async bash, eval, …).
 * - `subagent`: an in-process subagent run.
 * - `shell-run`: one embedded-shell command execution, foreground or background. Its
 *   external children live in their own sessions, so an unfinished run at a crash may
 *   have left processes that were never enumerated.
 * - `process`: an OS process a shell command left running (background or reparented).
 * - `service`: a named long-running service started through the launch broker.
 * - `service-start`: a service launch request whose process id is not known yet.
 */
export type OwnedJobKind = "async-job" | "subagent" | "shell-run" | "service-start" | "process" | "service";
export type InProcessJobKind = "async-job" | "subagent" | "shell-run" | "service-start";

export interface OwnedJobStartRecord {
	type: "start";
	jobId: string;
	kind: OwnedJobKind;
	/** OS pid; the agent process itself for in-process jobs. */
	pid: number;
	pgid: number | null;
	/** OS start time of `pid`, Unix epoch seconds; `null` when unreadable. */
	startTime: number | null;
	command: string;
	cwd: string | null;
	/** Set only by the spawning call's explicit option; never changed afterwards. */
	sleepable: boolean;
	/** True when the job lives inside the agent process and ends with it. */
	inProcess: boolean;
	/** True for a process that escaped the shell's process tree (e.g. `nohup cmd &`). */
	reparented?: boolean;
	invocationPid: number;
	/** ISO-8601 timestamp. */
	registeredAt: string;
}

export interface OwnedJobEndRecord {
	type: "end";
	jobId: string;
	/** `exited`: the OS process was observed gone. `settled`: an in-process job finished. */
	how: "exited" | "settled";
	invocationPid: number;
	endedAt: string;
}

export interface OwnedJobInvocationRecord {
	type: "invocation";
	version: typeof OWNED_JOB_REGISTRY_VERSION;
	invocation: { pid: number; startTime: number | null };
	sessionId: string;
	/** False when this invocation cannot enumerate every process it owns. */
	complete: boolean;
	incompleteReasons?: string[];
	at: string;
}

export interface OwnedJobIncompleteRecord {
	type: "incomplete";
	reason: string;
	invocationPid: number;
	at: string;
}

export type OwnedJobRecord =
	| OwnedJobInvocationRecord
	| OwnedJobStartRecord
	| OwnedJobEndRecord
	| OwnedJobIncompleteRecord;

export interface OwnedProcessInput {
	kind: "process" | "service";
	pid: number;
	pgid?: number | null;
	startTime?: number | null;
	command: string;
	cwd?: string | null;
	sleepable?: boolean;
	reparented?: boolean;
	/** Stable id; defaults to `<kind>:<pid>:<startTime>`. */
	jobId?: string;
}

interface OpenJob {
	record: OwnedJobStartRecord;
	/** Registry file the start record went to; the end record goes to the same file. */
	file: string | null;
}

export interface OwnedJobRegistryOptions {
	/** Current session JSONL path, or `null`/`undefined` when the session is not persisted. */
	getSessionFile: () => string | null | undefined;
	getSessionId: () => string;
	/** Called synchronously whenever a job is registered. */
	onRegister?: (record: OwnedJobStartRecord) => void;
	/** Liveness poll interval for open OS-process records; 0 disables polling. */
	pollIntervalMs?: number;
}

/** `<session file without .jsonl>.jobs.jsonl` */
export function ownedJobRegistryPath(sessionFile: string): string {
	return `${stripJsonl(sessionFile)}.jobs.jsonl`;
}

/** OS identity of this process: pid plus OS start time (Unix epoch seconds) for pid-reuse safety. */
export interface InvocationIdentity {
	pid: number;
	/** `null` when the OS start time could not be read. */
	startTime: number | null;
}

let cachedInvocation: InvocationIdentity | undefined;

export function currentInvocation(): InvocationIdentity {
	if (cachedInvocation?.pid === process.pid) return cachedInvocation;
	let startTime: number | null = null;
	try {
		startTime = processStartTime(process.pid);
	} catch {
		startTime = null;
	}
	cachedInvocation = { pid: process.pid, startTime };
	return cachedInvocation;
}

export function stripJsonl(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
}

export function fsyncDirectory(dir: string): void {
	if (process.platform === "win32") return;
	let fd: number | undefined;
	try {
		fd = fs.openSync(dir, "r");
		fs.fsyncSync(fd);
	} catch {
		// Directory fsync is best-effort on filesystems that reject it.
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
/** True when a process with `pid` exists and, when `startTime` is known, started at that instant. */
export function isOwnedProcessAlive(pid: number, startTime: number | null): boolean {
	let observed: number | null;
	try {
		observed = processStartTime(pid);
	} catch {
		// Unreadable identity: fall back to existence so a live process is never reported gone.
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
	if (observed === null) return false;
	return startTime === null || observed === startTime;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class OwnedJobRegistry {
	static #instance: OwnedJobRegistry | undefined;

	/** The registry of the process's root session; subagents register into it. */
	static instance(): OwnedJobRegistry | undefined {
		return OwnedJobRegistry.#instance;
	}

	static setInstance(value: OwnedJobRegistry | undefined): void {
		OwnedJobRegistry.#instance = value;
	}

	readonly #options: OwnedJobRegistryOptions;
	readonly #open = new Map<string, OpenJob>();
	/** Files that already carry this invocation's `invocation` record. */
	readonly #headered = new Set<string>();
	readonly #incompleteReasons: string[] = [];
	#monitor: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: OwnedJobRegistryOptions) {
		this.#options = options;
		if (process.platform === "win32") {
			this.#incompleteReasons.push("platform: detached descendants are not tracked on Windows");
		}
		if (currentInvocation().startTime === null) {
			this.#incompleteReasons.push("invocation start time unavailable");
		}
	}

	/** Registry path for the current session file, or `null` when the session is not persisted. */
	get path(): string | null {
		const sessionFile = this.#options.getSessionFile();
		return sessionFile ? ownedJobRegistryPath(sessionFile) : null;
	}

	/** False once any owned process may have escaped registration in this invocation. */
	get complete(): boolean {
		return this.#incompleteReasons.length === 0;
	}

	get incompleteReasons(): readonly string[] {
		return this.#incompleteReasons;
	}

	/** Write this invocation's header to the current registry file if it is not there yet. */
	ensureHeader(): void {
		const file = this.path;
		if (file) this.#ensureHeader(file);
	}

	/** Mark this invocation's registry incomplete. Idempotent per reason. */
	markIncomplete(reason: string): void {
		if (this.#incompleteReasons.includes(reason)) return;
		this.#incompleteReasons.push(reason);
		const record: OwnedJobIncompleteRecord = {
			type: "incomplete",
			reason,
			invocationPid: process.pid,
			at: new Date().toISOString(),
		};
		const files = new Set(this.#headered);
		const current = this.path;
		if (current) files.add(current);
		for (const file of files) this.#append(file, record);
	}

	/** Register an in-process job (async job or subagent). Returns the registry job id. */
	registerInProcessJob(input: { jobId: string; kind: InProcessJobKind; command: string; cwd?: string }): string {
		const invocation = currentInvocation();
		this.#start({
			type: "start",
			jobId: input.jobId,
			kind: input.kind,
			pid: invocation.pid,
			pgid: null,
			startTime: invocation.startTime,
			command: input.command,
			cwd: input.cwd ?? null,
			sleepable: false,
			inProcess: true,
			invocationPid: invocation.pid,
			registeredAt: new Date().toISOString(),
		});
		return input.jobId;
	}

	/** Register an OS process the agent owns. Returns the registry job id (existing id when already open). */
	registerProcess(input: OwnedProcessInput): string {
		const startTime = input.startTime ?? readStartTime(input.pid);
		const jobId = input.jobId ?? `${input.kind}:${input.pid}:${startTime ?? "unknown"}`;
		if (this.#open.has(jobId)) return jobId;
		this.#start({
			type: "start",
			jobId,
			kind: input.kind,
			pid: input.pid,
			pgid: input.pgid ?? null,
			startTime,
			command: input.command,
			cwd: input.cwd ?? null,
			sleepable: input.sleepable === true,
			inProcess: false,
			...(input.reparented ? { reparented: true } : {}),
			invocationPid: process.pid,
			registeredAt: new Date().toISOString(),
		});
		this.#ensureMonitor();
		return jobId;
	}

	/** Register processes a shell run left alive. `undefined` means the shell could not report them. */
	registerShellSurvivors(
		spawned: readonly SpawnedProcess[] | undefined,
		context: { command: string; cwd?: string | null },
	): void {
		if (spawned === undefined) {
			this.markIncomplete("shell backend does not report spawned processes");
			return;
		}
		for (const proc of spawned) {
			this.registerProcess({
				kind: "process",
				pid: proc.pid,
				pgid: proc.pgid ?? null,
				startTime: proc.startTime ?? null,
				command: context.command,
				cwd: context.cwd ?? null,
				reparented: proc.reparented,
			});
		}
	}

	/** Record that a job ended. No-op for unknown or already-ended ids. */
	end(jobId: string, how: OwnedJobEndRecord["how"]): void {
		const open = this.#open.get(jobId);
		if (!open) return;
		this.#open.delete(jobId);
		if (!open.file) return;
		this.#append(open.file, {
			type: "end",
			jobId,
			how,
			invocationPid: process.pid,
			endedAt: new Date().toISOString(),
		});
	}

	/**
	 * Synchronously check every open OS-process record, record the ones that
	 * exited, and return how many are still alive.
	 */
	liveProcessCount(): number {
		let alive = 0;
		for (const [jobId, open] of this.#open) {
			if (open.record.inProcess) continue;
			if (isOwnedProcessAlive(open.record.pid, open.record.startTime)) alive++;
			else this.end(jobId, "exited");
		}
		return alive;
	}

	/** Open records (both in-process and OS processes), for diagnostics and tests. */
	openJobs(): OwnedJobStartRecord[] {
		return Array.from(this.#open.values(), open => open.record);
	}

	/** Stop liveness polling. Open records stay open on disk: they may outlive this process. */
	close(): void {
		this.#closed = true;
		clearInterval(this.#monitor);
		this.#monitor = undefined;
	}

	#start(record: OwnedJobStartRecord): void {
		const file = this.path;
		this.#open.set(record.jobId, { record, file });
		if (file) this.#append(file, record);
		try {
			this.#options.onRegister?.(record);
		} catch (error) {
			logger.warn("Owned job registration listener failed", { error: String(error) });
		}
	}

	#ensureHeader(file: string): void {
		if (this.#headered.has(file)) return;
		this.#headered.add(file);
		const invocation = currentInvocation();
		const header: OwnedJobInvocationRecord = {
			type: "invocation",
			version: OWNED_JOB_REGISTRY_VERSION,
			invocation,
			sessionId: this.#options.getSessionId(),
			complete: this.complete,
			...(this.complete ? {} : { incompleteReasons: [...this.#incompleteReasons] }),
			at: new Date().toISOString(),
		};
		this.#write(file, header);
	}

	#append(file: string, record: OwnedJobRecord): void {
		this.#ensureHeader(file);
		this.#write(file, record);
	}

	#write(file: string, record: OwnedJobRecord): void {
		try {
			const dir = path.dirname(file);
			const created = !fs.existsSync(file);
			if (created) fs.mkdirSync(dir, { recursive: true });
			const fd = fs.openSync(file, "a", 0o600);
			try {
				fs.writeSync(fd, `${JSON.stringify(record)}\n`);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			if (created) fsyncDirectory(dir);
		} catch (error) {
			// A registry that failed to persist a record cannot vouch for completeness.
			if (!this.#incompleteReasons.includes("registry write failed")) {
				this.#incompleteReasons.push("registry write failed");
			}
			logger.warn("Owned job registry write failed", { file, error: String(error) });
		}
	}

	#ensureMonitor(): void {
		if (this.#monitor || this.#closed) return;
		const interval = this.#options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		if (interval <= 0) return;
		this.#monitor = setInterval(() => {
			this.liveProcessCount();
			const hasProcesses = Array.from(this.#open.values()).some(open => !open.record.inProcess);
			if (!hasProcesses && this.#monitor) {
				clearInterval(this.#monitor);
				this.#monitor = undefined;
			}
		}, interval);
		this.#monitor.unref?.();
	}
}

function readStartTime(pid: number): number | null {
	try {
		return processStartTime(pid);
	} catch {
		return null;
	}
}
