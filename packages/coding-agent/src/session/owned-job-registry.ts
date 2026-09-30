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
	type ProcessIdentity,
	processIdentity,
	type ShellRunResult,
	scanProcessesByEnv,
} from "@oh-my-pi/pi-natives";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export const OWNED_JOB_REGISTRY_VERSION = 1;
/** Longest command text stored in a registry record. */
const REGISTRY_COMMAND_MAX_CHARS = 4_096;
/**
 * - `async-job`: an in-process background job (async bash, eval, …).
 * - `subagent`: an in-process subagent run.
 * - `shell-run`: one embedded-shell command execution, foreground or background. Its
 *   external children live in their own sessions, so an unfinished run at a crash may
 *   have left processes that were never enumerated.
 * - `process`: an OS process a shell command left running (background, reparented, or a
 *   live member of a process group one of its commands led).
 * - `retained-shell`: a shell kept alive because a background job is still running. The job
 *   can start processes at any later time, and none of them is reported, so the record stays
 *   open until the job ends.
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
	| "retained-shell"
	| "service-start"
	| "process"
	| "service"
	| "internal";
export type InProcessJobKind = "async-job" | "subagent" | "shell-run" | "retained-shell" | "service-start";

export interface OwnedJobStartRecord {
	type: "start";
	jobId: string;
	kind: OwnedJobKind;
	/** OS pid; the agent process itself for in-process jobs. */
	pid: number;
	pgid: number | null;
	/** OS start time of `pid`, Unix epoch seconds. Display only; `null` when unreadable. */
	startTime: number | null;
	/**
	 * Clock-independent start identity of `pid` (see `processIdentity().startId`), compared
	 * for equality to detect pid reuse. `null` when it could not be read.
	 */
	startId: string | null;
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
	/** True for a live member of a process group a reported command led. */
	groupMember?: boolean;
	/**
	 * Set when the record was re-appended to this file after a session switch: the registry
	 * file the job was first recorded in. Its end is written to both files.
	 */
	carriedFrom?: string;
	/**
	 * Set when this invocation took over an earlier invocation's open record on binding the
	 * file (a resume): that invocation's identity. The process is counted as this
	 * invocation's work from then on.
	 */
	adoptedFrom?: InvocationIdentity;
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
	invocation: InvocationIdentity;
	sessionId: string;
	/** False when this invocation cannot enumerate every process it owns. */
	complete: boolean;
	incompleteReasons?: string[];
	/** Environment marker inherited by processes this invocation spawns (see {@link OWNER_MARKER_ENV}). */
	ownerMarker?: { env: string; token: string };
	/**
	 * Owner tokens of earlier invocations this invocation took over (their processes carry
	 * those tokens, not this one's), each with its invocation's start identity. Scanned
	 * alongside `ownerMarker`.
	 */
	inheritedOwnerMarkers?: InheritedOwnerMarker[];
	at: string;
}

export interface InheritedOwnerMarker {
	token: string;
	/** Start identity of the invocation that issued the token; `null` when it was unknown. */
	startId: string | null;
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
	/** Identity pinned at spawn. When omitted the registry reads it now. */
	startId?: string | null;
	startTime?: number | null;
	command: string;
	cwd?: string | null;
	sleepable?: boolean;
	reparented?: boolean;
	discovered?: boolean;
	groupMember?: boolean;
	/** Stable id; defaults to `<kind>:<pid>:<startId>`. */
	jobId?: string;
}

interface OpenJob {
	record: OwnedJobStartRecord;
	/** Registry files holding the start record; the end record goes to each of them. */
	files: string[];
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

/**
 * OS identity of this process: pid plus a clock-independent start identity (pid-reuse
 * safety); `startTime` (epoch seconds) is for display.
 */
export interface InvocationIdentity {
	pid: number;
	/** `null` when the OS start identity could not be read. */
	startId: string | null;
	startTime: number | null;
}

let cachedInvocation: InvocationIdentity | undefined;

export function currentInvocation(): InvocationIdentity {
	if (cachedInvocation?.pid === process.pid) return cachedInvocation;
	const identity = readIdentity(process.pid);
	cachedInvocation = { pid: process.pid, startId: identity.startId ?? null, startTime: identity.startTime ?? null };
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

/** This invocation's owner token: `omp1:<pid>:<start identity>`. */
export function ownerToken(): string {
	const invocation = currentInvocation();
	return `omp1:${invocation.pid}:${invocation.startId ?? "unknown"}`;
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

const PTY_RUN_UNTRACKED = "pty shell runs do not report spawned processes";

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
export type OwnedProcessState = "alive" | "gone" | "unreadable";

/**
 * Liveness of a recorded process. `gone`: no such process, a zombie, or the pid now belongs
 * to a process with a different start identity. `unreadable`: it exists (or cannot be proven
 * gone) but its identity cannot be read — callers treat it as alive and never record an end.
 */
export function ownedProcessState(pid: number, startId: string | null | undefined): OwnedProcessState {
	const identity = readIdentity(pid);
	if (identity.state === "gone") return "gone";
	if (identity.state === "unreadable" || identity.startId === undefined) return "unreadable";
	if (startId != null && identity.startId !== startId) return "gone";
	return startId == null ? "unreadable" : "alive";
}

function readIdentity(pid: number): ProcessIdentity {
	try {
		return processIdentity(pid);
	} catch {
		return { state: "unreadable" };
	}
}

function truncateCommand(command: string): string {
	return command.length > REGISTRY_COMMAND_MAX_CHARS ? command.slice(0, REGISTRY_COMMAND_MAX_CHARS) : command;
}

const INHERITED_PREFIX = "inherited: ";

/** An earlier invocation's incomplete reason as this invocation's (never nested). */
function inheritedReason(reason: string): string {
	return reason.startsWith(INHERITED_PREFIX) ? reason : `${INHERITED_PREFIX}${reason}`;
}

/** Records one invocation wrote to a registry file, in file order. */
export interface RegistrySegment {
	header: OwnedJobInvocationRecord;
	/** Start records with no matching end (keyed by job id; ids restart per invocation). */
	open: Map<string, OwnedJobStartRecord>;
	/** Reasons from `incomplete` records. */
	incomplete: string[];
}

export interface ParsedRegistry {
	segments: RegistrySegment[];
	/** Lines that could not be attributed or understood; each makes the file unable to vouch. */
	problems: string[];
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHeader(value: Record<string, unknown>): value is Record<string, unknown> & OwnedJobInvocationRecord {
	const invocation = value.invocation;
	return value.type === "invocation" && isRecordObject(invocation) && typeof invocation.pid === "number";
}

/**
 * Parse a registry file. A record belongs to the latest preceding header whose invocation
 * has its `invocationPid`, so a pid reused by a later invocation never ends or reopens an
 * earlier invocation's jobs. Malformed lines, unknown record types and records with no
 * owning header are reported as problems rather than guessed at.
 */
export function parseOwnedJobRegistry(text: string): ParsedRegistry {
	const segments: RegistrySegment[] = [];
	const problems: string[] = [];
	const latestByPid = new Map<number, RegistrySegment>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			problems.push("registry has a malformed record");
			continue;
		}
		if (!isRecordObject(value)) {
			problems.push("registry has a malformed record");
			continue;
		}
		if (value.type === "invocation") {
			if (!isHeader(value)) {
				problems.push("registry has a malformed invocation header");
				continue;
			}
			const segment: RegistrySegment = { header: value, open: new Map(), incomplete: [] };
			segments.push(segment);
			latestByPid.set(value.invocation.pid, segment);
			continue;
		}
		if (value.type !== "start" && value.type !== "end" && value.type !== "incomplete") {
			problems.push(`registry has a record of unknown type ${JSON.stringify(value.type)}`);
			continue;
		}
		const segment = typeof value.invocationPid === "number" ? latestByPid.get(value.invocationPid) : undefined;
		if (!segment) {
			problems.push(`registry has a ${value.type} record with no invocation header`);
			continue;
		}
		if (value.type === "incomplete") {
			segment.incomplete.push(typeof value.reason === "string" ? value.reason : "incomplete");
		} else if (typeof value.jobId !== "string") {
			problems.push(`registry has a ${value.type} record without a job id`);
		} else if (value.type === "start") {
			segment.open.set(value.jobId, value as unknown as OwnedJobStartRecord);
		} else {
			segment.open.delete(value.jobId);
		}
	}
	return { segments, problems };
}

/** Numerically smallest start identity; `"0"` (everything counts as recent) when any is unknown. */
function earliestStartId(startIds: Iterable<string | null>): string {
	let earliest: bigint | undefined;
	for (const startId of startIds) {
		if (startId === null || !/^\d+$/.test(startId)) return "0";
		const value = BigInt(startId);
		if (earliest === undefined || value < earliest) earliest = value;
	}
	return (earliest ?? 0n).toString();
}

/** Every owner token a header asks consumers to scan for, with its issuing invocation's start id. */
function headerMarkers(header: OwnedJobInvocationRecord): InheritedOwnerMarker[] {
	const markers: InheritedOwnerMarker[] = [];
	if (header.ownerMarker) markers.push({ token: header.ownerMarker.token, startId: header.invocation.startId });
	for (const marker of header.inheritedOwnerMarkers ?? []) markers.push(marker);
	return markers;
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
	/** Open jobs keyed by job id (ids are unique within one invocation). */
	readonly #open = new Map<string, OpenJob>();
	/** Files whose `invocation` header for this invocation was written successfully. */
	readonly #headered = new Set<string>();
	readonly #incompleteReasons: string[] = [];
	/** Incomplete reasons already persisted per file (in its header or an `incomplete` record). */
	readonly #persistedReasons = new Map<string, Set<string>>();
	/** Owner tokens of earlier invocations adopted from bound files, by token. */
	readonly #inheritedMarkers = new Map<string, InheritedOwnerMarker>();
	/** Files whose earlier invocations were already examined for adoption. */
	readonly #adoptedFiles = new Set<string>();
	#monitor: NodeJS.Timeout | undefined;
	#closed = false;
	#ptyRuns = 0;

	constructor(options: OwnedJobRegistryOptions) {
		this.#options = options;
		if (process.platform === "win32") {
			this.#incompleteReasons.push("platform: detached descendants are not tracked on Windows");
		}
		if (currentInvocation().startId === null) {
			this.#incompleteReasons.push("invocation start identity unavailable");
		}
	}

	/** Registry path for the current session file, or `null` when the session is not persisted. */
	get path(): string | null {
		const sessionFile = this.#options.getSessionFile();
		return sessionFile ? ownedJobRegistryPath(sessionFile) : null;
	}

	/**
	 * False once any owned process may have escaped registration in this invocation, and
	 * while the session is not persisted (a registry with no file vouches for nothing).
	 */
	get complete(): boolean {
		return this.#incompleteReasons.length === 0 && this.path !== null;
	}

	get incompleteReasons(): readonly string[] {
		return this.path === null ? [...this.#incompleteReasons, "session is not persisted"] : this.#incompleteReasons;
	}

	/**
	 * Bind the registry to the current session file: write this invocation's header now (so
	 * the file names the latest invocation even before any job starts) and carry every open
	 * record into it. Called on session open, resume and every switch.
	 */
	ensureHeader(): void {
		const file = this.path;
		if (file) this.#prepare(file);
	}

	/** Mark this invocation's registry incomplete. Idempotent per reason. */
	markIncomplete(reason: string): void {
		if (!this.#incompleteReasons.includes(reason)) this.#incompleteReasons.push(reason);
		const files = new Set(this.#headered);
		const current = this.path;
		if (current) files.add(current);
		for (const file of files) this.#prepare(file);
	}

	/** Register an in-process job (async job, subagent, shell run). Returns the registry job id. */
	registerInProcessJob(input: { jobId: string; kind: InProcessJobKind; command: string; cwd?: string }): string {
		const invocation = currentInvocation();
		this.#start({
			type: "start",
			jobId: input.jobId,
			kind: input.kind,
			pid: invocation.pid,
			pgid: null,
			startTime: invocation.startTime,
			startId: invocation.startId,
			command: truncateCommand(input.command),
			cwd: input.cwd ?? null,
			sleepable: false,
			inProcess: true,
			invocationPid: invocation.pid,
			registeredAt: new Date().toISOString(),
		});
		return input.jobId;
	}

	/**
	 * Record a PTY shell run for its duration. A PTY reports none of the processes it starts,
	 * and a survivor that replaces its environment carries no owner marker, so the registry
	 * can no longer vouch for every process — on every platform, even where the owner-marker
	 * scan is sound. Returns the function that ends the run record.
	 */
	beginPtyRun(input: { command: string; cwd: string }): () => void {
		this.markIncomplete(PTY_RUN_UNTRACKED);
		const jobId = this.registerInProcessJob({ jobId: `pty-run:${++this.#ptyRuns}`, kind: "shell-run", ...input });
		return () => this.end(jobId, "settled");
	}

	/**
	 * Register an OS process the agent owns. Returns the registry job id (the existing id when
	 * already open), or `undefined` when no identity was pinned and the pid is already gone.
	 */
	registerProcess(input: OwnedProcessInput): string | undefined {
		let startId = input.startId ?? null;
		let startTime = input.startTime ?? null;
		if (startId === null) {
			const identity = readIdentity(input.pid);
			if (identity.state === "gone") return undefined;
			startId = identity.startId ?? null;
			startTime ??= identity.startTime ?? null;
		}
		const jobId = input.jobId ?? `${input.kind}:${input.pid}:${startId ?? "unknown"}`;
		if (this.#open.has(jobId)) return jobId;
		this.#start({
			type: "start",
			jobId,
			kind: input.kind,
			pid: input.pid,
			pgid: input.pgid ?? null,
			startTime,
			startId,
			command: truncateCommand(input.command),
			cwd: input.cwd ?? null,
			sleepable: input.sleepable === true,
			inProcess: false,
			...(input.reparented ? { reparented: true } : {}),
			...(input.discovered ? { discovered: true } : {}),
			...(input.groupMember ? { groupMember: true } : {}),
			invocationPid: process.pid,
			registeredAt: new Date().toISOString(),
		});
		this.#ensureMonitor();
		return jobId;
	}

	/**
	 * Register processes a shell run left alive. A result without a survivor list (a backend
	 * that does not report), or whose list may be missing processes, marks the registry
	 * incomplete.
	 */
	registerShellSurvivors(
		result: Pick<ShellRunResult, "spawnedProcesses" | "spawnedComplete">,
		context: { command: string; cwd?: string | null },
	): void {
		const spawned = result.spawnedProcesses;
		if (spawned === undefined) {
			this.markIncomplete("shell backend does not report spawned processes");
			return;
		}
		if (result.spawnedComplete === false) {
			this.markIncomplete("a shell run could not report every process it spawned");
		}
		for (const proc of spawned) {
			this.registerProcess({
				kind: "process",
				pid: proc.pid,
				pgid: proc.pgid ?? null,
				startId: proc.startId ?? null,
				startTime: proc.startTime ?? null,
				command: context.command,
				cwd: context.cwd ?? null,
				reparented: proc.reparented,
				groupMember: proc.groupMember,
			});
		}
	}

	/** Record that a job ended. No-op for unknown or already-ended ids. */
	end(jobId: string, how: OwnedJobEndRecord["how"]): void {
		const open = this.#open.get(jobId);
		if (!open) return;
		this.#open.delete(jobId);
		const record: OwnedJobEndRecord = {
			type: "end",
			jobId,
			how,
			invocationPid: process.pid,
			endedAt: new Date().toISOString(),
		};
		for (const file of open.files) this.#append(file, record);
	}

	/**
	 * Synchronously check every open OS-process record, record the ones that exited, and
	 * return how many owned processes may still be alive. A process whose identity cannot be
	 * read counts as alive and is never recorded as ended. `internal` helpers are tracked
	 * (their exit is recorded) but never counted.
	 */
	liveProcessCount(): number {
		let alive = 0;
		for (const [jobId, open] of this.#open) {
			if (open.record.inProcess) continue;
			if (ownedProcessState(open.record.pid, open.record.startId) === "gone") this.end(jobId, "exited");
			else if (open.record.kind !== "internal") alive++;
		}
		return alive;
	}

	/**
	 * Scan same-user processes for this invocation's owner marker and every marker it
	 * inherited from earlier invocations of a bound file. Every live marked process the
	 * registry does not already track is recorded as a discovered `process` (and is then
	 * counted by {@link liveProcessCount}). Synchronous; a few tens of milliseconds.
	 */
	scanOwnedProcesses(): OwnerScanSummary {
		const invocation = currentInvocation();
		const inherited = [...this.#inheritedMarkers.values()];
		const tokens = [ownerToken(), ...inherited.map(marker => marker.token)];
		const since = earliestStartId([invocation.startId, ...inherited.map(marker => marker.startId)]);
		let scan: MarkedProcessScan;
		try {
			scan = scanProcessesByEnv(OWNER_MARKER_ENV, tokens, since);
		} catch (error) {
			logger.warn("Owner-marker scan failed", { error: String(error) });
			return { supported: false, sound: false, scanned: 0, discovered: 0, opaque: [] };
		}
		let discovered = 0;
		for (const proc of scan.processes) {
			if (this.#tracks(proc.pid, proc.startId ?? null)) continue;
			this.registerProcess({
				kind: "process",
				pid: proc.pid,
				pgid: proc.pgid ?? null,
				startId: proc.startId ?? null,
				startTime: proc.startTime ?? null,
				command: proc.command,
				discovered: true,
			});
			discovered++;
		}
		const opaque = scan.opaque
			.filter(proc => !this.#tracks(proc.pid, proc.startId ?? null))
			.map(proc => ({ pid: proc.pid, command: proc.command }));
		return {
			supported: scan.supported,
			sound: scan.supported && !scan.hidden && opaque.length === 0,
			scanned: scan.scanned,
			discovered,
			opaque,
		};
	}

	#tracks(pid: number, startId: string | null): boolean {
		for (const open of this.#open.values()) {
			const record = open.record;
			if (!record.inProcess && record.pid === pid && (startId === null || record.startId === startId)) {
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
		const open: OpenJob = { record, files: [] };
		// Header and carried records are written before the new record joins `#open`, so it
		// is never carried twice. A file the start record did not reach gets no end record.
		if (file && this.#append(file, record)) open.files.push(file);
		this.#open.set(record.jobId, open);
		try {
			this.#options.onRegister?.(record);
		} catch (error) {
			logger.warn("Owned job registration listener failed", { error: String(error) });
		}
	}

	/**
	 * Make `file` a faithful registry of this invocation. On first binding, take over what
	 * earlier invocations of the file left behind (see {@link #adoptEarlierInvocations});
	 * then the header (retried until written), every open record not yet in it (carried
	 * over from another session file, on every bind — including a switch back), and every
	 * incomplete reason not yet persisted to it.
	 */
	#prepare(file: string): void {
		const adopted = this.#adoptedFiles.has(file) ? [] : this.#adoptEarlierInvocations(file);
		if (!this.#headered.has(file)) {
			const reasons = [...this.#incompleteReasons];
			const inherited = [...this.#inheritedMarkers.values()];
			const header: OwnedJobInvocationRecord = {
				type: "invocation",
				version: OWNED_JOB_REGISTRY_VERSION,
				invocation: currentInvocation(),
				sessionId: this.#options.getSessionId(),
				complete: reasons.length === 0,
				...(reasons.length === 0 ? {} : { incompleteReasons: reasons }),
				ownerMarker: { env: OWNER_MARKER_ENV, token: ownerToken() },
				...(inherited.length === 0 ? {} : { inheritedOwnerMarkers: inherited }),
				at: new Date().toISOString(),
			};
			if (this.#write(file, header)) {
				this.#headered.add(file);
				this.#persistedReasons.set(file, new Set(reasons));
			}
		}
		const headered = this.#headered.has(file);
		for (const record of adopted) {
			if (this.#open.has(record.jobId)) continue;
			const open: OpenJob = { record, files: [] };
			if (headered && this.#write(file, record)) open.files.push(file);
			this.#open.set(record.jobId, open);
			this.#ensureMonitor();
		}
		if (!headered) return;
		for (const open of this.#open.values()) {
			const origin = open.files[0];
			if (origin === undefined || open.files.includes(file)) continue;
			if (this.#write(file, { ...open.record, carriedFrom: origin })) open.files.push(file);
		}
		const persisted = this.#persistedReasons.get(file);
		if (!persisted) return;
		for (const reason of this.#incompleteReasons) {
			if (persisted.has(reason)) continue;
			const record: OwnedJobIncompleteRecord = {
				type: "incomplete",
				reason,
				invocationPid: process.pid,
				at: new Date().toISOString(),
			};
			if (this.#write(file, record)) persisted.add(reason);
		}
	}

	/**
	 * First binding of `file` (resume, or a switch to an existing session): whoever wrote it
	 * before — an earlier invocation, or an earlier session object in this process — may have
	 * left processes running, or could not vouch for everything it started. This registry
	 * inherits both, so its own counts and completeness never read clearer than the file:
	 * - their incomplete state (header `complete:false`, `incomplete` records, in-process jobs
	 *   never ended, unparseable lines) becomes this registry's incomplete state;
	 * - their owner tokens are scanned from now on;
	 * - every open OS-process record that is not provably gone is returned for adoption
	 *   (re-appended under this invocation with `adoptedFrom`).
	 */
	#adoptEarlierInvocations(file: string): OwnedJobStartRecord[] {
		this.#adoptedFiles.add(file);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (error) {
			if (isEnoent(error)) return [];
			this.#noteIncomplete("an earlier registry could not be read");
			return [];
		}
		const parsed = parseOwnedJobRegistry(text);
		for (const problem of parsed.problems) this.#noteIncomplete(inheritedReason(problem));
		const me = currentInvocation();
		const ownToken = ownerToken();
		const adopted: OwnedJobStartRecord[] = [];
		for (const segment of parsed.segments) {
			const earlier = segment.header.invocation;
			for (const marker of headerMarkers(segment.header)) {
				if (marker.token !== ownToken) this.#inheritedMarkers.set(marker.token, marker);
			}
			if (!segment.header.complete) {
				for (const reason of segment.header.incompleteReasons ?? ["invocation incomplete"]) {
					this.#noteIncomplete(inheritedReason(reason));
				}
			}
			for (const reason of segment.incomplete) this.#noteIncomplete(inheritedReason(reason));
			for (const record of segment.open.values()) {
				if (record.kind === "internal") continue;
				if (record.inProcess) {
					this.#noteIncomplete(`an earlier invocation (pid ${earlier.pid}) left ${record.kind} work unfinished`);
					continue;
				}
				if (ownedProcessState(record.pid, record.startId) === "gone") continue;
				const { carriedFrom: _carried, ...rest } = record;
				adopted.push({
					...rest,
					adoptedFrom: record.adoptedFrom ?? earlier,
					invocationPid: me.pid,
					registeredAt: new Date().toISOString(),
				});
			}
		}
		return adopted;
	}

	/** Add an incomplete reason without writing (the caller persists it with the header). */
	#noteIncomplete(reason: string): void {
		if (!this.#incompleteReasons.includes(reason)) this.#incompleteReasons.push(reason);
	}

	#append(file: string, record: OwnedJobRecord): boolean {
		this.#prepare(file);
		return this.#headered.has(file) && this.#write(file, record);
	}

	/** Append one fsynced record. A failure marks the registry incomplete (persisted on the next successful write). */
	#write(file: string, record: OwnedJobRecord): boolean {
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
			return true;
		} catch (error) {
			// A registry that failed to persist a record cannot vouch for completeness.
			if (!this.#incompleteReasons.includes(REGISTRY_WRITE_FAILED)) {
				this.#incompleteReasons.push(REGISTRY_WRITE_FAILED);
			}
			logger.warn("Owned job registry write failed", { file, error: String(error) });
			return false;
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

const REGISTRY_WRITE_FAILED = "registry write failed";

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

export interface VerifyOwnedJobRegistryOptions {
	/**
	 * The invocation the consumer last observed (from `attest`, `get_state` or a terminal
	 * attestation). When the file has no header for it, that invocation's records may never
	 * have reached the file (every write failed), so the answer is at best `unknown`.
	 */
	expectedInvocation?: { pid: number; startId: string | null };
}

/**
 * Evaluate a registry file the way a supervisor must after the agent exited. `internal`
 * helpers never block. Consumers in other languages reimplement exactly this rule:
 *
 * 1. A record belongs to the latest preceding header whose invocation has its
 *    `invocationPid`; job ids restart in every invocation. A malformed line, a record of
 *    unknown type, or one with no owning header makes the answer at best `unknown`.
 * 2. Header `complete:false` and `incomplete` records make the answer at best `unknown`.
 *    With `expectedInvocation`, a missing header for it does too.
 * 3. A process is identified by pid plus `startId` (clock-independent; compare for equality
 *    only). It is gone when no process has the pid, it is a zombie, or its `startId` differs;
 *    a process whose identity cannot be read is neither gone nor proven alive (`unknown`).
 * 4. An invocation still running means the registry is not final (`live`); one that cannot
 *    be examined makes the answer `unknown`.
 * 5. Open in-process records (runs, retained shells, jobs) that never ended mean `unknown`.
 * 6. One owner-marker scan for every token any header names (`ownerMarker` and
 *    `inheritedOwnerMarkers`), counting processes started since the earliest of their
 *    invocations: marked processes block; unexaminable or hidden ones (see
 *    {@link OwnerScanSummary}) make the answer `unknown`.
 */
export function verifyOwnedJobRegistry(file: string, options: VerifyOwnedJobRegistryOptions = {}): OwnedJobVerdict {
	const reasons: string[] = [];
	const live: OwnedJobVerdict["live"] = [];
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { status: "unknown", live, reasons: [`registry unreadable: ${String(error)}`] };
	}
	const { segments, problems } = parseOwnedJobRegistry(text);
	reasons.push(...problems);
	if (segments.length === 0) reasons.push("registry has no invocation header");
	const expected = options.expectedInvocation;
	if (
		expected &&
		!segments.some(
			segment =>
				segment.header.invocation.pid === expected.pid && segment.header.invocation.startId === expected.startId,
		)
	) {
		reasons.push(`invocation ${expected.pid} has no header in the registry`);
	}
	for (const { header, incomplete } of segments) {
		if (!header.complete) reasons.push(...(header.incompleteReasons ?? ["invocation incomplete"]));
		reasons.push(...incomplete);
	}
	for (const { header } of segments) {
		const { invocation } = header;
		const state = ownedProcessState(invocation.pid, invocation.startId);
		if (state === "alive") {
			return { status: "live", live, reasons: [`invocation ${invocation.pid} is still running`] };
		}
		if (state === "unreadable") reasons.push(`invocation ${invocation.pid} cannot be examined`);
	}
	for (const segment of segments) {
		for (const record of segment.open.values()) {
			if (record.kind === "internal") continue;
			if (record.inProcess) {
				reasons.push(`${record.kind} ${record.jobId} never ended`);
				continue;
			}
			const state = ownedProcessState(record.pid, record.startId);
			if (state === "alive") {
				if (live.some(entry => entry.pid === record.pid)) continue;
				live.push({ jobId: record.jobId, kind: record.kind, pid: record.pid, command: record.command });
			} else if (state === "unreadable") {
				reasons.push(`${record.kind} ${record.jobId} (pid ${record.pid}) cannot be examined`);
			}
		}
	}
	const markers = new Map<string, InheritedOwnerMarker>();
	let env: string | undefined;
	for (const { header } of segments) {
		if (!header.ownerMarker) {
			reasons.push(`invocation ${header.invocation.pid} recorded no owner marker`);
		} else {
			env ??= header.ownerMarker.env;
			if (header.ownerMarker.env !== env) reasons.push("registry uses more than one owner-marker variable");
		}
		for (const marker of headerMarkers(header)) markers.set(marker.token, marker);
	}
	if (env !== undefined) {
		try {
			const since = earliestStartId([...markers.values()].map(marker => marker.startId));
			const scan = scanProcessesByEnv(env, [...markers.keys()], since);
			if (!scan.supported) reasons.push("owner-marker scan unsupported on this platform");
			if (scan.hidden) reasons.push("owner-marker scan cannot see every process (hidepid)");
			for (const proc of scan.opaque) reasons.push(`process ${proc.pid} (${proc.command}) environment unexaminable`);
			for (const proc of scan.processes) {
				if (live.some(entry => entry.pid === proc.pid)) continue;
				live.push({ jobId: `marked:${proc.pid}`, kind: "process", pid: proc.pid, command: proc.command });
			}
		} catch (error) {
			reasons.push(`owner-marker scan failed: ${String(error)}`);
		}
	}
	if (live.length > 0) return { status: "blocked", live, reasons };
	return { status: reasons.length > 0 ? "unknown" : "clear", live, reasons };
}
