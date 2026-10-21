import * as fs from "node:fs";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	getHeldSessionLeaseIdentity,
	getSessionOwnerPath,
	onSessionLeaseChanged,
	tryAcquireSessionLease,
} from "./session-storage";
import type { SessionManager } from "./session-manager";

export const SESSION_YIELD_CAPABILITY = "session-yield/1";
const POLL_MS = 25;
const MAX_RECORD_BYTES = 4095;

export interface SessionYieldHolder {
	(): void;
	readonly active: boolean;
}

interface HolderRecord {
	pid: number;
	holderId: string;
	capabilities: string[];
}
interface YieldRequest {
	holderId: string;
	requestId: string;
	deadline: number;
}

/** Read only a bounded regular file; malformed or half-written records fail closed. */
function readRecord(file: string): unknown {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
		const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
		const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
		if (length > MAX_RECORD_BYTES) return undefined;
		return JSON.parse(bytes.toString("utf8", 0, length));
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function isHolder(value: unknown): value is HolderRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as HolderRecord;
	return (
		Number.isSafeInteger(record.pid) &&
		record.pid > 0 &&
		typeof record.holderId === "string" &&
		Array.isArray(record.capabilities) &&
		record.capabilities.every(capability => typeof capability === "string")
	);
}

function isRequest(value: unknown): value is YieldRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as YieldRequest;
	return (
		typeof record.holderId === "string" && typeof record.requestId === "string" && Number.isFinite(record.deadline)
	);
}

/** Metadata is advisory. In particular, never replace/unlink the OS lock inode. */
function writeMetadata(file: string, record: HolderRecord): void {
	const previous = readRecord(file);
	const base = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
	const existingCapabilities =
		"capabilities" in base && Array.isArray(base.capabilities)
			? base.capabilities.filter((capability): capability is string => typeof capability === "string")
			: [];
	const capabilities = existingCapabilities.filter(capability => capability !== SESSION_YIELD_CAPABILITY);
	if (record.capabilities.includes(SESSION_YIELD_CAPABILITY)) capabilities.push(SESSION_YIELD_CAPABILITY);
	const text = JSON.stringify({ ...base, ...record, capabilities });
	if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error("Session owner metadata is too large");
	const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		if (!fs.fstatSync(fd).isFile()) throw new Error("Session owner metadata is not a regular file");
		fs.writeSync(fd, text, 0, "utf8");
		fs.ftruncateSync(fd, Buffer.byteLength(text));
	} finally {
		fs.closeSync(fd);
	}
}

function publishRecord(file: string, record: YieldRequest): void {
	const temporary = `${file}.${record.requestId}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** Keep a host bound to the manager's real identity, not only explicit UI switches. */
export function followSessionYieldHolder(options: {
	sessionManager: Pick<SessionManager, "getSessionId" | "onSessionIdentityChanged">;
	isIdle: () => boolean;
	yield: () => Promise<void>;
}): SessionYieldHolder {
	let holder: SessionYieldHolder | undefined;
	const bind = () => {
		holder?.();
		const sessionId = options.sessionManager.getSessionId();
		holder = startSessionYieldHolder({
			sessionId,
			isIdle: () => options.sessionManager.getSessionId() === sessionId && options.isIdle(),
			yield: options.yield,
		});
	};
	const unsubscribe = options.sessionManager.onSessionIdentityChanged(bind);
	bind();
	const dispose = () => {
		unsubscribe();
		holder?.();
	};
	return Object.defineProperty(dispose, "active", {
		get: () => holder?.active ?? false,
	}) as SessionYieldHolder;
}

/** Pending hooks activate synchronously on a real lease claim; metadata never grants ownership. */
export function startSessionYieldHolder(options: {
	sessionId: string;
	isIdle: () => boolean;
	yield: () => Promise<void>;
}): SessionYieldHolder {
	const ownerPath = getSessionOwnerPath(options.sessionId);
	const metadataPath = `${ownerPath}.lock`;
	const requestPath = `${ownerPath}.yield-request.json`;
	const ackPath = `${ownerPath}.yield-ack.json`;
	let leaseIdentity: string | undefined;
	let holder: HolderRecord | undefined;
	let disposed = false;
	let yielding = false;
	let handledRequestId: string | undefined;
	const revoke = () => {
		if (!holder || getHeldSessionLeaseIdentity(options.sessionId) !== leaseIdentity) return;
		const current = readRecord(metadataPath);
		if (isHolder(current) && current.holderId === holder.holderId) {
			writeMetadata(metadataPath, { ...holder, capabilities: [] });
		}
	};
	const unsubscribe = onSessionLeaseChanged(options.sessionId, identity => {
		if (identity === undefined) {
			revoke();
			holder = undefined;
			leaseIdentity = undefined;
			return;
		}
		const record: HolderRecord = {
			pid: process.pid,
			holderId: crypto.randomUUID(),
			capabilities: [SESSION_YIELD_CAPABILITY],
		};
		writeMetadata(metadataPath, record);
		leaseIdentity = identity;
		holder = record;
		yielding = false;
		handledRequestId = undefined;
	});
	const rejectYield = (error: unknown, requestId: string) => {
		if (handledRequestId === requestId) yielding = false;
		logger.warn("Session yield shutdown failed", { sessionId: options.sessionId, requestId, error: String(error) });
		try {
			const ack = readRecord(ackPath);
			if (isRequest(ack) && ack.requestId === requestId) fs.rmSync(ackPath, { force: true });
		} catch (cleanupError) {
			logger.warn("Session yield acknowledgement cleanup failed", {
				sessionId: options.sessionId,
				error: String(cleanupError),
			});
		}
	};
	const timer = setInterval(() => {
		if (disposed || yielding || !holder || getHeldSessionLeaseIdentity(options.sessionId) !== leaseIdentity) return;
		try {
			const current = readRecord(metadataPath);
			if (!isHolder(current) || current.holderId !== holder.holderId) return;
			const request = readRecord(requestPath);
			if (
				!isRequest(request) ||
				request.holderId !== holder.holderId ||
				request.requestId === handledRequestId ||
				request.deadline <= Date.now()
			)
				return;
			if (!options.isIdle()) return;
			// No await may intervene between this fence and host admission closure.
			// The ack is acceptance only, never successful release.
			if (request.deadline <= Date.now()) return;
			publishRecord(ackPath, request);
			if (request.deadline <= Date.now()) return;
			handledRequestId = request.requestId;
			yielding = true;
			try {
				void options.yield().catch(error => rejectYield(error, request.requestId));
			} catch (error) {
				rejectYield(error, request.requestId);
			}
		} catch (error) {
			logger.warn("Session yield request could not be handled", {
				sessionId: options.sessionId,
				error: String(error),
			});
		}
	}, POLL_MS);
	timer.unref();
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		clearInterval(timer);
		revoke();
	};
	return Object.defineProperty(dispose, "active", {
		get: () => !disposed && !yielding && !!holder && getHeldSessionLeaseIdentity(options.sessionId) === leaseIdentity,
	}) as SessionYieldHolder;
}

/** 0 requires matching acceptance, actual holder exit, and actual OS lease release. */
export async function requestSessionYield(sessionId: string, timeoutMs: number): Promise<0 | 3 | 4 | 5> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Session yield timeout must be nonnegative");
	const deadline = Date.now() + timeoutMs;
	const ownerPath = getSessionOwnerPath(sessionId);
	const metadataPath = `${ownerPath}.lock`;
	const requestPath = `${ownerPath}.yield-request.json`;
	const ackPath = `${ownerPath}.yield-ack.json`;
	const requestId = crypto.randomUUID();
	// Serialize clients independently of the holder lease; never delete gate inodes.
	let gate = tryAcquireFileLock(`${ownerPath}.yield-client`);
	while (!gate && Date.now() < deadline) {
		await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
		gate = tryAcquireFileLock(`${ownerPath}.yield-client`);
	}
	if (!gate) return 4;
	try {
		const probe = tryAcquireSessionLease(sessionId);
		if (probe) {
			probe.release();
			return 3;
		}
		const holder = readRecord(metadataPath);
		if (!isHolder(holder) || !holder.capabilities.includes(SESSION_YIELD_CAPABILITY)) return 5;
		try {
			process.kill(holder.pid, 0);
		} catch (error) {
			// The inode persists across holders. A legacy successor must not inherit
			// a dead capable holder's advertisement merely by owning its OS lease.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return 5;
			throw error;
		}
		const request: YieldRequest = { holderId: holder.holderId, requestId, deadline };
		if (Date.now() >= deadline) return 4;
		publishRecord(requestPath, request);
		while (Date.now() < deadline) {
			const ack = readRecord(ackPath);
			if (
				isRequest(ack) &&
				ack.holderId === holder.holderId &&
				ack.requestId === requestId &&
				ack.deadline === deadline
			) {
				let exited = false;
				try {
					process.kill(holder.pid, 0);
				} catch (error) {
					exited = (error as NodeJS.ErrnoException).code === "ESRCH";
				}
				if (exited) {
					const released = tryAcquireSessionLease(sessionId);
					if (released) {
						released.release();
						return 0;
					}
				}
			}
			await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
		}
		const ack = readRecord(ackPath);
		if (
			isRequest(ack) &&
			ack.holderId === holder.holderId &&
			ack.requestId === requestId &&
			ack.deadline === deadline
		) {
			throw new Error("yield accepted but exit/release unconfirmed");
		}
		return 4;
	} finally {
		try {
			const request = readRecord(requestPath);
			if (isRequest(request) && request.requestId === requestId) fs.rmSync(requestPath, { force: true });
			const ack = readRecord(ackPath);
			if (isRequest(ack) && ack.requestId === requestId) fs.rmSync(ackPath, { force: true });
		} finally {
			gate.release();
		}
	}
}
