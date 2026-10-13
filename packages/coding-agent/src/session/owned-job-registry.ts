/**
 * Durable registry of work an agent process owns, so a supervisor can tell
 * after the process is gone whether anything it started is still running.
 *
 * File: `<session file without .jsonl>.jobs.jsonl`, append-only JSONL. Every
 * record is written with a synchronous append + fsync before the registering
 * call returns. Each registry object that writes to a file first appends an
 * `invocation` header (with its random `writer` id); its `start`, `end` and
 * `incomplete` records carry the invocation pid and the same `writer`.
 *
 * Consumers decide per header segment ({@link verifyOwnedJobRegistry} is the rule):
 * - a header that is not exactly `complete: true` with no `incompleteReasons`, a
 *   header or start record of the wrong shape, or any `incomplete` record means some
 *   owned process may be missing: answer `unknown`;
 * - a `start` with `inProcess: true` and no `end` after its invocation ended
 *   means the job's descendants were never enumerated: answer `unknown`;
 * - a `start` with `inProcess: false` and no `end` is alive iff a live, non-zombie
 *   process with that `pid` has that `startId`;
 * - a scan for every owner token any header names finds processes nobody reported.
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
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { parseDaemonSnapshot } from "../launch/protocol";

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
 * - `service`: a named long-running service started through the launch broker. It stays work
 *   while the broker hosting it lives, even between processes (see `broker`).
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
	/**
	 * `service` only: the daemon broker hosting the service. The broker can relaunch the
	 * service under a new pid (a restart backoff, a `restart` request), so the service is
	 * work while its broker lives even once `pid` is gone, until a record ends it.
	 */
	broker?: ProcessRef;
	/**
	 * `service` only: the broker's id for the service and the metadata file where the broker
	 * publishes its state. Read by the engine only; consumers need not.
	 */
	daemon?: { id: string; meta: string };
	invocationPid: number;
	/** The `writer` of the header this record belongs to (see {@link RegistryReader}). */
	writer?: string;
	/** ISO-8601 timestamp. */
	registeredAt: string;
}

export interface OwnedJobEndRecord {
	type: "end";
	jobId: string;
	/** `exited`: the OS process was observed gone. `settled`: an in-process job finished. */
	how: "exited" | "settled";
	invocationPid: number;
	/** The `writer` of the header this record belongs to. */
	writer?: string;
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
	 * Random id of the registry object that wrote this header. Its `start`, `end` and
	 * `incomplete` records carry the same `writer`, so records of two session objects in one
	 * process are told apart (and a registry reading the file back skips its own).
	 */
	writer?: string;
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
	/** The `writer` of the header this record belongs to. */
	writer?: string;
	at: string;
}

export type OwnedJobRecord =
	| OwnedJobInvocationRecord
	| OwnedJobStartRecord
	| OwnedJobEndRecord
	| OwnedJobIncompleteRecord;

interface RegistryFileRead {
	reader: RegistryReader;
	/** Bytes consumed: every whole line before this offset has been fed to `reader`. */
	offset: number;
	problemsSeen: number;
	/** Last bytes consumed (at most {@link CONSUMED_TAIL_BYTES}); a rewrite in place changes them. */
	tail: Buffer;
	/** Unique per read of a file from its start; scopes what was taken over from it. */
	generation: number;
	/** `dev:ino` of the file when last read; a change means it was replaced. */
	identity?: string;
	/** File size at the previous read when it ended in an unterminated line. */
	tornAtSize?: number;
}

/** How many of the last consumed bytes a reader re-checks to detect a rewrite in place. */
const CONSUMED_TAIL_BYTES = 512;
/** A process identified by pid plus start identity (`null` when it could not be read). */
export interface ProcessRef {
	pid: number;
	startId: string | null;
}

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
	/** `service` only: the hosting broker; its identity is read now when not given. */
	broker?: { pid: number; startId?: string | null };
	/** `service` only: see {@link OwnedJobStartRecord.daemon}. */
	daemon?: { id: string; meta: string };
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

const PTY_RUN_UNTRACKED = "pty shell runs do not report spawned processes";

/** Outcome of one owner-marker scan. */
export interface OwnerScanSummary {
	/** False when the platform has no scan. */
	supported: boolean;
	/**
	 * True when every same-user process that could carry this invocation's marker was
	 * examined: none started since this invocation began had an unreadable or empty
	 * environment (other than processes the registry already tracks by pid). From
	 * {@link OwnedJobRegistry.scanAndCount}, also false when counted processes kept exiting
	 * between scan and count.
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

/**
 * Liveness of the work an open OS-process record stands for: its process, or, for a
 * `service` record whose process is gone, the broker hosting it — a live broker can still
 * relaunch the service, so it counts as alive until its broker is gone too.
 */
export function recordedWorkState(record: Pick<OwnedJobStartRecord, "pid" | "startId" | "broker">): OwnedProcessState {
	const own = ownedProcessState(record.pid, record.startId);
	if (own !== "gone" || !record.broker) return own;
	return ownedProcessState(record.broker.pid, record.broker.startId);
}

/**
 * What a daemon broker last published about one service (the `daemon` of its `meta.json`),
 * or `undefined` when that is unreadable or malformed: the caller then keeps the record open.
 */
function readServiceHostState(meta: string): DaemonSnapshot | undefined {
	try {
		const decoded: unknown = JSON.parse(fs.readFileSync(meta, "utf8"));
		return parseDaemonSnapshot(isRecordObject(decoded) ? decoded.daemon : undefined);
	} catch {
		return undefined;
	}
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

function isStartIdValue(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && /^\d+$/.test(value));
}

function isOwnerMarkerList(value: unknown): value is InheritedOwnerMarker[] {
	return (
		Array.isArray(value) &&
		value.every(entry => isRecordObject(entry) && typeof entry.token === "string" && isStartIdValue(entry.startId))
	);
}

/**
 * A header this rule can trust: every field a consumer reads has the type the writer
 * produces. Anything else (a `complete` that is not a boolean, reasons or markers of the
 * wrong shape) is a malformed header, never read leniently.
 */
function isHeader(value: Record<string, unknown>): value is Record<string, unknown> & OwnedJobInvocationRecord {
	const invocation = value.invocation;
	const marker = value.ownerMarker;
	const reasons = value.incompleteReasons;
	return (
		value.type === "invocation" &&
		isRecordObject(invocation) &&
		Number.isSafeInteger(invocation.pid) &&
		isStartIdValue(invocation.startId) &&
		typeof value.sessionId === "string" &&
		typeof value.complete === "boolean" &&
		(reasons === undefined || (Array.isArray(reasons) && reasons.every(reason => typeof reason === "string"))) &&
		(marker === undefined ||
			(isRecordObject(marker) && typeof marker.env === "string" && typeof marker.token === "string")) &&
		(value.inheritedOwnerMarkers === undefined || isOwnerMarkerList(value.inheritedOwnerMarkers)) &&
		(value.writer === undefined || typeof value.writer === "string")
	);
}

function isProcessRef(value: unknown): value is ProcessRef {
	return isRecordObject(value) && Number.isSafeInteger(value.pid) && isStartIdValue(value.startId);
}

function isStartRecord(value: Record<string, unknown>): value is Record<string, unknown> & OwnedJobStartRecord {
	const daemon = value.daemon;
	return (
		typeof value.jobId === "string" &&
		typeof value.kind === "string" &&
		Number.isSafeInteger(value.pid) &&
		typeof value.inProcess === "boolean" &&
		isStartIdValue(value.startId) &&
		(value.broker === undefined || isProcessRef(value.broker)) &&
		(daemon === undefined ||
			(isRecordObject(daemon) && typeof daemon.id === "string" && typeof daemon.meta === "string"))
	);
}

/**
 * The incomplete reasons a header states. A header counts as complete only when
 * `complete` is exactly `true` and it lists no reason.
 */
export function headerIncompleteReasons(header: OwnedJobInvocationRecord): string[] {
	const reasons = header.incompleteReasons ?? [];
	if (header.complete === true && reasons.length === 0) return [];
	return reasons.length > 0 ? reasons : ["invocation incomplete"];
}

/**
 * Incremental registry parser. A record belongs to the latest preceding header whose
 * invocation has its `invocationPid` and, when the record carries `writer`, whose `writer`
 * is the same: a pid reused by a later invocation never ends or reopens an earlier
 * invocation's jobs, and two session objects in one process never end or hide each other's.
 * Malformed lines, unknown record types, headers or start records of the wrong shape and
 * records with no owning header are reported as problems rather than guessed at. {@link feed}
 * keeps a trailing partial line until more text (or {@link finish}) arrives, so a file can be
 * read while another process appends to it.
 */
export class RegistryReader {
	readonly segments: RegistrySegment[] = [];
	readonly problems: string[] = [];
	readonly #latestByPid = new Map<number, RegistrySegment>();
	/** Keyed by `<pid>:<writer>`. */
	readonly #latestByWriter = new Map<string, RegistrySegment>();
	#pending = "";

	/** Parse every complete line of `text` (appended to what was fed before). */
	feed(text: string): void {
		const lines = (this.#pending + text).split("\n");
		this.#pending = lines.pop() ?? "";
		for (const line of lines) this.#line(line);
	}

	/** The file ended: a trailing partial line is a torn record. */
	finish(): void {
		const rest = this.#pending;
		this.#pending = "";
		this.#line(rest);
	}

	#line(line: string): void {
		if (!line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.problems.push("registry has a malformed record");
			return;
		}
		if (!isRecordObject(value)) {
			this.problems.push("registry has a malformed record");
			return;
		}
		if (value.type === "invocation") {
			if (!isHeader(value)) {
				this.problems.push("registry has a malformed invocation header");
				return;
			}
			const segment: RegistrySegment = { header: value, open: new Map(), incomplete: [] };
			this.segments.push(segment);
			this.#latestByPid.set(value.invocation.pid, segment);
			if (value.writer !== undefined) this.#latestByWriter.set(`${value.invocation.pid}:${value.writer}`, segment);
			return;
		}
		if (value.type !== "start" && value.type !== "end" && value.type !== "incomplete") {
			this.problems.push(`registry has a record of unknown type ${JSON.stringify(value.type)}`);
			return;
		}
		if (value.writer !== undefined && typeof value.writer !== "string") {
			this.problems.push(`registry has a ${value.type} record with a malformed writer`);
			return;
		}
		const pid = value.invocationPid;
		const segment =
			typeof pid !== "number"
				? undefined
				: value.writer === undefined
					? this.#latestByPid.get(pid)
					: this.#latestByWriter.get(`${pid}:${value.writer}`);
		if (!segment) {
			this.problems.push(`registry has a ${value.type} record with no invocation header`);
			return;
		}
		if (value.type === "incomplete") {
			segment.incomplete.push(typeof value.reason === "string" ? value.reason : "incomplete");
		} else if (typeof value.jobId !== "string") {
			this.problems.push(`registry has a ${value.type} record without a job id`);
		} else if (value.type === "start") {
			if (isStartRecord(value)) segment.open.set(value.jobId, value);
			else this.problems.push("registry has a malformed start record");
		} else {
			segment.open.delete(value.jobId);
		}
	}
}

/** Parse a whole registry file (see {@link RegistryReader}). */
export function parseOwnedJobRegistry(text: string): ParsedRegistry {
	const reader = new RegistryReader();
	reader.feed(text);
	reader.finish();
	return { segments: reader.segments, problems: reader.problems };
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

/** The invocation that issued an `omp1:<pid>:<startId>` token; `undefined` for another format. */
function tokenInvocation(token: string): { pid: number; startId: string | null } | undefined {
	const match = /^omp1:(\d+):(\d+|unknown)$/.exec(token);
	if (!match) return undefined;
	return { pid: Number(match[1]), startId: match[2] === "unknown" ? null : match[2] };
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Scan-and-count rounds before an answer that never settled is reported unsound. */
export const SCAN_SETTLE_ROUNDS = 3;

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
	/** Owner tokens of other invocations taken over from bound files, by token. */
	readonly #inheritedMarkers = new Map<string, InheritedOwnerMarker>();
	/** Per bound file: its incremental reader and read position. */
	readonly #readers = new Map<string, RegistryFileRead>();
	/** Foreign headers, reasons and records already acted on (adopted or flagged). */
	readonly #handledForeign = new Set<string>();
	/** Other invocations that wrote a bound file and are still running (or cannot be examined). */
	readonly #foreignInvocations = new Map<string, InvocationIdentity>();
	/** Identifies this registry's header and records in a file it reads back. */
	readonly #writerId = crypto.randomUUID();
	/** Taken-over tokens the previous owner scan found prunable; pruned if the next agrees. */
	#prunable = new Set<string>();
	/** Counted processes and other invocations found gone so far (see {@link scanAndCount}). */
	#vanished = 0;
	/** Reads started so far (see {@link RegistryFileRead.generation}). */
	#readGenerations = 0;
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
		const broker = input.broker && this.#pinBroker(input.broker);
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
			...(broker ? { broker } : {}),
			...(input.daemon ? { daemon: input.daemon } : {}),
			invocationPid: process.pid,
			registeredAt: new Date().toISOString(),
		});
		this.#ensureMonitor();
		return jobId;
	}

	/**
	 * The identity of a service's broker. A broker that is already gone cannot vouch for the
	 * service it hosted: the registry stops vouching instead.
	 */
	#pinBroker(broker: { pid: number; startId?: string | null }): ProcessRef | undefined {
		if (broker.startId != null) return { pid: broker.pid, startId: broker.startId };
		const identity = readIdentity(broker.pid);
		if (identity.state === "gone") {
			this.markIncomplete("a service's daemon broker was gone when the service was recorded");
			return undefined;
		}
		return { pid: broker.pid, startId: identity.startId ?? null };
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
	 * (their exit is recorded) but never counted. Another invocation still running on a bound
	 * session file (or one that cannot be examined) counts too: its work is not visible here.
	 */
	liveProcessCount(): number {
		let alive = 0;
		let foreignEnded = false;
		for (const [key, invocation] of this.#foreignInvocations) {
			if (ownedProcessState(invocation.pid, invocation.startId) === "gone") {
				this.#foreignInvocations.delete(key);
				foreignEnded = true;
				this.#vanished++;
			} else {
				alive++;
			}
		}
		// What an invocation that just ended left behind must be taken over before counting.
		if (foreignEnded) this.refresh();
		for (const [jobId, open] of this.#open) {
			if (open.record.inProcess) continue;
			if (ownedProcessState(open.record.pid, open.record.startId) !== "gone") {
				if (open.record.kind !== "internal") alive++;
			} else if (this.#serviceStillHosted(open.record)) {
				alive++;
			} else {
				if (open.record.kind !== "internal") this.#vanished++;
				this.end(jobId, "exited");
			}
		}
		return alive;
	}

	/**
	 * Whether a `service` record whose own process is gone is still work: its broker is alive
	 * (or cannot be examined) and has not published the service as terminal. A relaunched
	 * service whose new process the broker published is recorded as a new `service` record,
	 * which carries the work from then on. Unreadable broker state counts as still hosted.
	 */
	#serviceStillHosted(record: OwnedJobStartRecord): boolean {
		if (record.kind !== "service" || !record.broker) return false;
		if (ownedProcessState(record.broker.pid, record.broker.startId) === "gone") return false;
		if (!record.daemon) return true;
		const host = readServiceHostState(record.daemon.meta);
		if (!host) return true;
		// The broker replaced this service with another of the same name: not this one any more.
		if (host.id !== record.daemon.id) return false;
		if (Object.hasOwn(TERMINAL_STATES, host.state)) return false;
		if (host.pid === undefined) return true;
		const successor = this.registerProcess({
			kind: "service",
			jobId: `service:${host.id}:${host.startedAt}`,
			pid: host.pid,
			command: record.command,
			cwd: record.cwd,
			sleepable: record.sleepable,
			broker: record.broker,
			daemon: record.daemon,
		});
		return successor === undefined || successor === record.jobId;
	}

	/**
	 * Owner scan, then {@link liveProcessCount}, as one consistent answer. A tracked process (or
	 * another invocation) that exits between the two can have handed the owner marker to a
	 * child the scan did not see yet, so the round is repeated while anything counted at scan
	 * time vanished before the count. After {@link SCAN_SETTLE_ROUNDS} unsettled rounds the
	 * scan is reported unsound. Taken-over tokens are pruned only on a settled round.
	 */
	scanAndCount(): { scan: OwnerScanSummary; live: number } {
		let discovered = 0;
		for (let round = 1; ; round++) {
			const vanishedBefore = this.#vanished;
			const { summary, raw } = this.#scan();
			discovered += summary.discovered;
			const live = this.liveProcessCount();
			if (this.#vanished === vanishedBefore) {
				this.#pruneAfter(raw);
				return { scan: { ...summary, discovered }, live };
			}
			this.#prunable.clear();
			if (round === SCAN_SETTLE_ROUNDS) {
				return { scan: { ...summary, sound: false, discovered }, live };
			}
		}
	}

	/**
	 * Read what other invocations appended to every registry file this registry bound since
	 * the last read and take it over (see {@link #takeOver}) into the current file. Another
	 * process can have a session open at the same time, including one this registry switched
	 * away from; this is how its work becomes visible here. Runs before every owner scan (so on
	 * every `attest`, quiesce and hang-up capture).
	 */
	refresh(): void {
		const current = this.path;
		const target = current && this.#readers.has(current) ? current : undefined;
		for (const file of this.#readers.keys()) this.#adopt(target ?? file, this.#readTail(file));
		if (target && this.#headered.has(target)) this.#prepare(target);
	}

	/**
	 * Scan same-user processes for this invocation's owner marker and every marker it took
	 * over from other invocations of a bound file. Every live marked process the registry
	 * does not already track is recorded as a discovered `process` (and is then counted by
	 * {@link liveProcessCount}). Synchronous; a few tens of milliseconds. Use
	 * {@link scanAndCount} when the count must agree with the scan.
	 */
	scanOwnedProcesses(): OwnerScanSummary {
		const { summary, raw } = this.#scan();
		this.#pruneAfter(raw);
		return summary;
	}

	#scan(): { summary: OwnerScanSummary; raw: MarkedProcessScan | undefined } {
		this.refresh();
		const invocation = currentInvocation();
		const inherited = [...this.#inheritedMarkers.values()];
		const tokens = [ownerToken(), ...inherited.map(marker => marker.token)];
		const since = earliestStartId([invocation.startId, ...inherited.map(marker => marker.startId)]);
		let scan: MarkedProcessScan;
		try {
			scan = scanProcessesByEnv(OWNER_MARKER_ENV, tokens, since);
		} catch (error) {
			logger.warn("Owner-marker scan failed", { error: String(error) });
			return { summary: { supported: false, sound: false, scanned: 0, discovered: 0, opaque: [] }, raw: undefined };
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
		const sound = scan.supported && !scan.hidden && opaque.length === 0;
		return { summary: { supported: scan.supported, sound, scanned: scan.scanned, discovered, opaque }, raw: scan };
	}

	/**
	 * Pruning needs the raw scan clean: a tracked process whose environment cannot be read is
	 * counted, but it may still carry a token and hand it to a child later. Any other scan
	 * breaks the run of consecutive clean scans.
	 */
	#pruneAfter(scan: MarkedProcessScan | undefined): void {
		if (scan?.supported && !scan.hidden && scan.opaque.length === 0) this.#pruneInheritedMarkers(scan);
		else this.#prunable.clear();
	}

	/**
	 * Stop scanning for a taken-over token once nothing can carry it any more: its invocation
	 * is gone, no open record was adopted from that invocation, and two consecutive scans that
	 * examined every candidate process (none unreadable, tracked or not) found no process with
	 * it. Two scans, because a carrier can fork and exit between one scan's process listing and
	 * its environment reads. Keeps headers from growing with every resume. The token stays in
	 * the header that issued it, so consumers still scan it.
	 */
	#pruneInheritedMarkers(scan: MarkedProcessScan): void {
		const carried = new Set(scan.processes.map(proc => proc.token));
		const prunable = new Set<string>();
		for (const token of this.#inheritedMarkers.keys()) {
			if (carried.has(token)) continue;
			const issuer = tokenInvocation(token);
			if (!issuer || issuer.pid === process.pid || this.#holdsWorkAdoptedFrom(issuer)) continue;
			if (ownedProcessState(issuer.pid, issuer.startId) !== "gone") continue;
			if (this.#prunable.has(token)) this.#inheritedMarkers.delete(token);
			else prunable.add(token);
		}
		this.#prunable = prunable;
	}

	/** Whether an open record was taken over from the invocation `issuer`. */
	#holdsWorkAdoptedFrom(issuer: { pid: number; startId: string | null }): boolean {
		for (const open of this.#open.values()) {
			const from = open.record.adoptedFrom;
			if (from && from.pid === issuer.pid && from.startId === issuer.startId) return true;
		}
		return false;
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
	 * Make `file` a faithful registry of this invocation. On first binding, read what other
	 * writers put in the file and take it over (see {@link #takeOver}); then the header
	 * (retried until written), every open record not yet in it (carried over from another
	 * session file, on every bind — including a switch back), and every incomplete reason not
	 * yet persisted to it.
	 */
	#prepare(file: string): void {
		const adopted = this.#readers.has(file) ? [] : this.#readTail(file);
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
				writer: this.#writerId,
				...(inherited.length === 0 ? {} : { inheritedOwnerMarkers: inherited }),
				at: new Date().toISOString(),
			};
			if (this.#write(file, header)) {
				this.#headered.add(file);
				this.#persistedReasons.set(file, new Set(reasons));
			}
		}
		this.#adopt(file, adopted);
		if (!this.#headered.has(file)) return;
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

	/** Open adopted records under this invocation, re-appended to `file` when it is headered. */
	#adopt(file: string, adopted: OwnedJobStartRecord[]): void {
		const headered = this.#headered.has(file);
		for (const record of adopted) {
			if (this.#open.has(record.jobId)) continue;
			const open: OpenJob = { record, files: [] };
			if (headered && this.#write(file, record)) open.files.push(file);
			this.#open.set(record.jobId, open);
			this.#ensureMonitor();
		}
	}

	/**
	 * Parse what `file` gained since the last read (everything on the first read) and take
	 * over what other writers put there. Only whole lines are consumed; a line another process
	 * is still appending is read next time. A file replaced by another one, or truncated or
	 * rewritten in place, is read again from the start; a file that was read and then removed
	 * makes the registry incomplete. Returns the records to adopt.
	 */
	#readTail(file: string): OwnedJobStartRecord[] {
		let state = this.#readers.get(file) ?? this.#newRead(file);
		let fd: number;
		try {
			fd = fs.openSync(file, "r");
		} catch (error) {
			if (!isEnoent(error)) this.#noteIncomplete("a registry file could not be read");
			// Records this reader consumed (this invocation's own included) are gone with it.
			else if (state.identity !== undefined) {
				this.#noteIncomplete("a registry file this invocation read was removed");
			}
			return [];
		}
		try {
			const stat = fs.fstatSync(fd);
			state = this.#checkFileIdentity(file, state, stat);
			const size = stat.size;
			if (state.offset > 0 && !this.#stillHoldsConsumed(fd, state, size)) {
				// Truncated or rewritten in place: what was consumed may no longer be in the file.
				this.#noteIncomplete("the registry file was rewritten while this invocation had it open");
				state = this.#newRead(file, state.identity);
			}
			if (size > state.offset) {
				const bytes = Buffer.allocUnsafe(size - state.offset);
				const read = fs.readSync(fd, bytes, 0, bytes.byteLength, state.offset);
				const complete = bytes.subarray(0, read).lastIndexOf(0x0a) + 1;
				if (complete > 0) {
					state.reader.feed(bytes.subarray(0, complete).toString("utf8"));
					state.offset += complete;
					const consumed = Buffer.concat([state.tail, bytes.subarray(0, complete)]);
					state.tail = Buffer.from(consumed.subarray(Math.max(0, consumed.byteLength - CONSUMED_TAIL_BYTES)));
				}
			}
			const torn = size > state.offset;
			// An unterminated last line that did not grow since the previous read, with no other
			// invocation of the file running to finish it, is a record its writer died writing.
			if (torn && state.tornAtSize === size && !this.#foreignInvocationRunning()) {
				this.#noteIncomplete("a registry file ends in a torn record");
			}
			state.tornAtSize = torn ? size : undefined;
		} catch (error) {
			this.#noteIncomplete("a registry file could not be read");
			logger.warn("Owned job registry read failed", { file, error: String(error) });
			return [];
		} finally {
			fs.closeSync(fd);
		}
		const { reader, generation } = state;
		for (const problem of reader.problems.slice(state.problemsSeen)) this.#noteIncomplete(inheritedReason(problem));
		state.problemsSeen = reader.problems.length;
		const adopted: OwnedJobStartRecord[] = [];
		reader.segments.forEach((segment, index) => {
			if (segment.header.writer !== this.#writerId)
				adopted.push(...this.#takeOver(segment, `${generation}:${index}`));
		});
		return adopted;
	}

	/** Whether the last bytes this reader consumed are still where it read them. */
	#stillHoldsConsumed(fd: number, state: RegistryFileRead, size: number): boolean {
		if (size < state.offset) return false;
		const length = state.tail.byteLength;
		const current = Buffer.alloc(length);
		return fs.readSync(fd, current, 0, length, state.offset - length) === length && current.equals(state.tail);
	}

	/** A fresh read of `file` from its start, with its own take-over scope. */
	#newRead(file: string, identity?: string): RegistryFileRead {
		const state: RegistryFileRead = {
			reader: new RegistryReader(),
			offset: 0,
			problemsSeen: 0,
			tail: Buffer.alloc(0),
			generation: ++this.#readGenerations,
			identity,
		};
		this.#readers.set(file, state);
		return state;
	}

	/**
	 * Note the identity of `file` as just opened. Another file put in its place may lack
	 * records `state` already consumed, this invocation's own included: the registry stops
	 * vouching and the file is read again from the start. Returns the state to use.
	 */
	#checkFileIdentity(file: string, state: RegistryFileRead, stat: fs.Stats): RegistryFileRead {
		const identity = `${stat.dev}:${stat.ino}`;
		if (state.identity !== undefined && state.identity !== identity) {
			this.#noteIncomplete("the registry file was replaced while this invocation had it open");
			return this.#newRead(file, identity);
		}
		state.identity = identity;
		return state;
	}

	#foreignInvocationRunning(): boolean {
		for (const invocation of this.#foreignInvocations.values()) {
			if (ownedProcessState(invocation.pid, invocation.startId) !== "gone") return true;
		}
		return false;
	}

	/**
	 * Take over what another writer of a bound file — an earlier or concurrent invocation, or
	 * another session object in this process — left, so this registry never reads clearer
	 * than the file:
	 * - its incomplete state (header not exactly `complete: true`, `incomplete` records)
	 *   becomes this registry's, as does an in-process job it never ended once it is gone (at
	 *   once for another session object in this process, which is not watched);
	 * - its owner tokens are scanned from now on;
	 * - while it is still running (or cannot be examined) it counts as live work;
	 * - every open OS-process record that is not provably gone is returned for adoption
	 *   (re-appended under this invocation with `adoptedFrom`).
	 * Idempotent per segment and record within one read of one file (`scope`: the read's
	 * generation and the segment's index): re-reading acts only on what is new, and the same
	 * writer's segment in another file, or in a file read again from its start, is its own.
	 */
	#takeOver(segment: RegistrySegment, scope: string): OwnedJobStartRecord[] {
		const me = currentInvocation();
		const writer = segment.header.invocation;
		const key = `${writer.pid}:${writer.startId ?? "unknown"}:${segment.header.writer ?? ""}`;
		const segmentKey = `${scope}:${key}`;
		if (!this.#handledForeign.has(segmentKey)) {
			this.#handledForeign.add(segmentKey);
			const ownToken = ownerToken();
			for (const marker of headerMarkers(segment.header)) {
				if (marker.token !== ownToken) this.#inheritedMarkers.set(marker.token, marker);
			}
			for (const reason of headerIncompleteReasons(segment.header)) this.#noteIncomplete(inheritedReason(reason));
		}
		segment.incomplete.forEach((reason, reasonIndex) => {
			const reasonKey = `${segmentKey}:incomplete:${reasonIndex}`;
			if (this.#handledForeign.has(reasonKey)) return;
			this.#handledForeign.add(reasonKey);
			this.#noteIncomplete(inheritedReason(reason));
		});
		// This process's other session objects are not separate invocations: never "live work".
		const sameProcess = writer.pid === me.pid;
		const writerGone = sameProcess || ownedProcessState(writer.pid, writer.startId) === "gone";
		if (writerGone) this.#foreignInvocations.delete(key);
		else this.#foreignInvocations.set(key, writer);
		const adopted: OwnedJobStartRecord[] = [];
		for (const record of segment.open.values()) {
			if (record.kind === "internal") continue;
			const recordKey = `${segmentKey}:${record.jobId}`;
			if (this.#handledForeign.has(recordKey)) continue;
			if (record.inProcess) {
				// Unfinished only once its writer is gone; while it runs it is counted as live.
				// Job ids are per writer: one equal to an id of this registry is a different job.
				if (!writerGone) continue;
				this.#handledForeign.add(recordKey);
				this.#noteIncomplete(inheritedReason(`invocation ${writer.pid} left ${record.kind} work unfinished`));
				continue;
			}
			this.#handledForeign.add(recordKey);
			// The same process (process job ids name pid and start identity) is already tracked.
			if (this.#open.has(record.jobId) || recordedWorkState(record) === "gone") continue;
			const { carriedFrom: _carried, writer: _writer, ...rest } = record;
			adopted.push({
				...rest,
				adoptedFrom: record.adoptedFrom ?? writer,
				invocationPid: me.pid,
				registeredAt: new Date().toISOString(),
			});
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
			const fd = fs.openSync(file, "a+", 0o600);
			try {
				const stat = fs.fstatSync(fd);
				const read = this.#readers.get(file);
				if (read) this.#checkFileIdentity(file, read, stat);
				// A torn last line (a writer that died mid-record) must not swallow this record.
				const size = stat.size;
				let separator = "";
				if (size > 0) {
					const last = Buffer.alloc(1);
					fs.readSync(fd, last, 0, 1, size - 1);
					if (last[0] !== 0x0a) separator = "\n";
				}
				const stamped = record.type === "invocation" ? record : { ...record, writer: this.#writerId };
				fs.writeSync(fd, `${separator}${JSON.stringify(stamped)}\n`);
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
	 * - `blocked`: a recorded or marked process, or the broker of a recorded service, is alive
	 *   (listed in `live`).
	 * - `unknown`: the registry or scan cannot vouch for every process (see `reasons`).
	 * - `live`: an invocation that wrote the registry is still running; ask it (`attest`).
	 */
	status: "clear" | "blocked" | "unknown" | "live";
	/** `broker`: the live broker that keeps a service whose own process is gone. */
	live: Array<{ jobId: string; kind: OwnedJobKind; pid: number; command: string; broker?: number }>;
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
 *    `invocationPid` and, when the record has a `writer`, the same `writer`; job ids restart
 *    per header. A malformed line, a record of unknown type, a start record without a string
 *    `jobId` and `kind`, an integer `pid`, a boolean `inProcess` and a decimal-string or null
 *    `startId`, a non-string `writer`, or a record with no owning header makes the answer at
 *    best `unknown`.
 * 2. A header counts as complete only when `complete` is exactly `true` and it lists no
 *    `incompleteReasons`; headers whose fields have the wrong type are malformed (rule 1).
 *    Incomplete headers and `incomplete` records make the answer at best `unknown`. With
 *    `expectedInvocation`, a missing header for it does too.
 * 3. A process is identified by pid plus `startId` (clock-independent; compare for equality
 *    only). It is gone when no process has the pid, it is a zombie, or its `startId` differs;
 *    a process whose identity cannot be read is neither gone nor proven alive (`unknown`).
 *    A `service` record with a `broker` (pid plus `startId` of the daemon broker hosting it)
 *    whose own process is gone is still work while that broker is alive (`blocked`; broker
 *    unreadable → `unknown`): the broker can relaunch it. `broker` or `daemon` present with
 *    the wrong shape is malformed (rule 1).
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
		reasons.push(...headerIncompleteReasons(header));
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
			const state = recordedWorkState(record);
			if (state === "alive") {
				if (live.some(entry => entry.pid === record.pid)) continue;
				const broker =
					record.broker && ownedProcessState(record.pid, record.startId) === "gone"
						? record.broker.pid
						: undefined;
				live.push({
					jobId: record.jobId,
					kind: record.kind,
					pid: record.pid,
					command: record.command,
					...(broker === undefined ? {} : { broker }),
				});
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
