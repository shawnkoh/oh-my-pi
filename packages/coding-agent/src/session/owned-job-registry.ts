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
import {
	type MarkedProcessScan,
	processStartTime,
	type SpawnedProcess,
	scanProcessesByEnv,
} from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

export const OWNED_JOB_REGISTRY_VERSION = 1;
/**
 * - `async-job`: an in-process background job (async bash, eval, …).
 * - `subagent`: an in-process subagent run.
 * - `shell-run`: one embedded-shell command execution, foreground or background. Its
 *   external children live in their own sessions, so an unfinished run at a crash may
 *   have left processes that were never enumerated.
 * - `process`: an OS process a shell command left running (background or reparented).
 * - `internal`: an engine helper daemon this invocation started (daemon broker, text
 *   prediction). Shared by every agent process in its scope and not Thread work: it exits on
 *   its own idle timer once no agent process in that scope is connected. Never counted as
 *   outstanding work; services it hosts are recorded separately as `service`.
 * - `service`: a named long-running service started through the launch broker.
 * - `service-start`: a service launch request whose process id is not known yet.
 */
export type OwnedJobKind =
	| "async-job"
	| "subagent"
	| "shell-run"
	| "service-start"
	| "process"
	| "service"
	| "internal";
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
	/** True for a process found by the owner-marker scan rather than registered at spawn. */
	discovered?: boolean;
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
	/** Environment marker inherited by processes this invocation spawns (see {@link OWNER_MARKER_ENV}). */
	ownerMarker?: { env: string; token: string };
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
	kind: "process" | "service" | "internal";
	pid: number;
	pgid?: number | null;
	startTime?: number | null;
	command: string;
	cwd?: string | null;
	sleepable?: boolean;
	reparented?: boolean;
	discovered?: boolean;
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

/**
 * Environment variable every process the agent spawns for work inherits (shell runs, PTY
 * shells, services). Its value lists owner tokens separated by `,`: an agent started from
 * another agent's shell appends its own token to the one it inherited. A process that
 * double-forks, calls setsid or reparents keeps its environment, so a scan for the token
 * finds it even though no pid was ever reported. A process that clears its environment
 * (`env -i`, some daemonizers) is not found.
 */
export const OWNER_MARKER_ENV = "OMP_OWNER";

/** This invocation's owner token: `omp1:<pid>:<OS start time>`. */
export function ownerToken(): string {
	const invocation = currentInvocation();
	return `omp1:${invocation.pid}:${invocation.startTime ?? "unknown"}`;
}

/** Environment overlay that marks a spawned process as owned by this invocation. */
export function ownerMarkerEnv(): Record<string, string> {
	const token = ownerToken();
	const inherited = process.env[OWNER_MARKER_ENV];
	const tokens = inherited ? inherited.split(",").filter(entry => entry.length > 0 && entry !== token) : [];
	return { [OWNER_MARKER_ENV]: [...tokens, token].join(",") };
}

/**
 * True where the owner-marker scan can see the environment of every same-user process a
 * shell may start. macOS withholds the environment of its own platform binaries (`sh`,
 * `zsh`, `sleep`, …) from the scan; Windows has no scan.
 */
export const OWNER_SCAN_COVERS_PLATFORM = process.platform === "linux";

/** Outcome of one owner-marker scan. */
export interface OwnerScanSummary {
	/** False when the platform has no scan. */
	supported: boolean;
	/**
	 * True when every same-user process that could carry this invocation's marker was
	 * examined: none started since this invocation began had an unreadable or empty
	 * environment (other than processes the registry already tracks by pid).
	 */
	sound: boolean;
	scanned: number;
	/** Marked processes the registry did not track until this scan (now recorded). */
	discovered: number;
	/** Unexaminable processes started since this invocation began that the registry does not track. */
	opaque: Array<{ pid: number; command: string }>;
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
			...(input.discovered ? { discovered: true } : {}),
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
	 * Synchronously check every open OS-process record, record the ones that exited, and
	 * return how many owned processes are still alive. `internal` helpers are tracked (their
	 * exit is recorded) but never counted.
	 */
	liveProcessCount(): number {
		let alive = 0;
		for (const [jobId, open] of this.#open) {
			if (open.record.inProcess) continue;
			if (!isOwnedProcessAlive(open.record.pid, open.record.startTime)) this.end(jobId, "exited");
			else if (open.record.kind !== "internal") alive++;
		}
		return alive;
	}

	/**
	 * Scan same-user processes for this invocation's owner marker. Every live marked process
	 * the registry does not already track is recorded as a discovered `process` (and is then
	 * counted by {@link liveProcessCount}). Synchronous; a few tens of milliseconds.
	 */
	scanOwnedProcesses(): OwnerScanSummary {
		const invocation = currentInvocation();
		let scan: MarkedProcessScan;
		try {
			scan = scanProcessesByEnv(OWNER_MARKER_ENV, ownerToken(), invocation.startTime ?? undefined);
		} catch (error) {
			logger.warn("Owner-marker scan failed", { error: String(error) });
			return { supported: false, sound: false, scanned: 0, discovered: 0, opaque: [] };
		}
		let discovered = 0;
		for (const proc of scan.processes) {
			if (this.#tracks(proc.pid, proc.startTime ?? null)) continue;
			this.registerProcess({
				kind: "process",
				pid: proc.pid,
				pgid: proc.pgid ?? null,
				startTime: proc.startTime ?? null,
				command: proc.command,
				discovered: true,
			});
			discovered++;
		}
		const opaque = scan.opaque
			.filter(proc => !this.#tracks(proc.pid, proc.startTime ?? null))
			.map(proc => ({ pid: proc.pid, command: proc.command }));
		return {
			supported: scan.supported,
			sound: scan.supported && opaque.length === 0,
			scanned: scan.scanned,
			discovered,
			opaque,
		};
	}

	#tracks(pid: number, startTime: number | null): boolean {
		for (const open of this.#open.values()) {
			const record = open.record;
			if (!record.inProcess && record.pid === pid && (startTime === null || record.startTime === startTime)) {
				return true;
			}
		}
		return false;
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
			ownerMarker: { env: OWNER_MARKER_ENV, token: ownerToken() },
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

/** A consumer's verdict on a registry after its agent process may have exited. */
export interface OwnedJobVerdict {
	/**
	 * - `clear`: every invocation ended, every recorded process ended, and a sound owner-marker
	 *   scan found no live marked process.
	 * - `blocked`: a recorded or marked process is alive (listed in `live`).
	 * - `unknown`: the registry or scan cannot vouch for every process (see `reasons`).
	 * - `live`: an invocation that wrote the registry is still running; ask it (`attest`).
	 */
	status: "clear" | "blocked" | "unknown" | "live";
	live: Array<{ jobId: string; kind: OwnedJobKind; pid: number; command: string }>;
	reasons: string[];
}

/**
 * Evaluate a registry file the way a supervisor must after the agent exited. `internal`
 * helpers never block. Consumers in other languages reimplement exactly this rule:
 * header/incomplete markers, open records checked by pid + start time, then an owner-marker
 * scan per invocation token whose unexaminable processes (see {@link OwnerScanSummary}) make
 * the answer `unknown` unless something is already known to be alive.
 */
export function verifyOwnedJobRegistry(file: string): OwnedJobVerdict {
	const reasons: string[] = [];
	const live: OwnedJobVerdict["live"] = [];
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { status: "unknown", live, reasons: [`registry unreadable: ${String(error)}`] };
	}
	const invocations = new Map<number, OwnedJobInvocationRecord>();
	const open = new Map<string, OwnedJobStartRecord>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: OwnedJobRecord;
		try {
			record = JSON.parse(line) as OwnedJobRecord;
		} catch {
			reasons.push("registry has a malformed record");
			continue;
		}
		if (record.type === "invocation") {
			invocations.set(record.invocation.pid, record);
			if (!record.complete) reasons.push(...(record.incompleteReasons ?? ["invocation incomplete"]));
		} else if (record.type === "incomplete") reasons.push(record.reason);
		else if (record.type === "start") open.set(record.jobId, record);
		else open.delete(record.jobId);
	}
	if (invocations.size === 0) reasons.push("registry has no invocation header");
	for (const invocation of invocations.values()) {
		if (isOwnedProcessAlive(invocation.invocation.pid, invocation.invocation.startTime)) {
			return { status: "live", live, reasons: [`invocation ${invocation.invocation.pid} is still running`] };
		}
	}
	for (const record of open.values()) {
		if (record.kind === "internal") continue;
		if (record.inProcess) {
			reasons.push(`${record.kind} ${record.jobId} never ended`);
			continue;
		}
		if (isOwnedProcessAlive(record.pid, record.startTime)) {
			live.push({ jobId: record.jobId, kind: record.kind, pid: record.pid, command: record.command });
		}
	}
	for (const invocation of invocations.values()) {
		const marker = invocation.ownerMarker;
		if (!marker) {
			reasons.push(`invocation ${invocation.invocation.pid} recorded no owner marker`);
			continue;
		}
		const scan = scanProcessesByEnv(marker.env, marker.token, invocation.invocation.startTime ?? undefined);
		if (!scan.supported) reasons.push("owner-marker scan unsupported on this platform");
		for (const proc of scan.opaque) reasons.push(`process ${proc.pid} (${proc.command}) environment unexaminable`);
		for (const proc of scan.processes) {
			if (live.some(entry => entry.pid === proc.pid)) continue;
			live.push({ jobId: `marked:${proc.pid}`, kind: "process", pid: proc.pid, command: proc.command });
		}
	}
	if (live.length > 0) return { status: "blocked", live, reasons };
	return { status: reasons.length > 0 ? "unknown" : "clear", live, reasons };
}
