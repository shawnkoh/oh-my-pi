import { posix } from "node:path";
import type { SessionManager, SessionHistoryReadView } from "../../session/session-manager";

export interface SessionHistoryRequest {
	readId: string;
	expectedSessionId: string;
	expectedSessionPath: string;
	before: number;
	limit: number;
	expiresAt: number;
}
export interface SessionHistoryEntry {
	index: number;
	entryId?: string;
	timestamp?: string;
	kind: "user" | "assistant" | "tool-result" | "compaction";
	attribution?: string;
	text?: string;
	truncated?: boolean;
	images?: number;
	tools?: string[];
	toolName?: string;
	isError?: boolean;
	model?: string;
}
export interface SessionHistoryPage {
	sessionId: string;
	sourceKind: "native-engine";
	total: number;
	omittedLines: 0;
	leafEntryId: string;
	entries: SessionHistoryEntry[];
}
export type SessionHistoryCode = "session-history-changed" | "session-source-unavailable" | "session-read-busy" |
	"session-read-expired" | "session-page-too-large" | "invalid-arguments";
export class SessionHistoryError extends Error {
	constructor(readonly code: SessionHistoryCode) { super(code); }
}
const TEXT = 16 * 1024;
const STRUCTURE = 16 * 1024 * 1024;
const PAGE = 512 * 1024;
const MAX_ENTRIES = 100_000;
function refuse(code: SessionHistoryCode): never { throw new SessionHistoryError(code); }
function metadata(value: unknown, max = 1024): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") return refuse("session-source-unavailable");
	// UTF-16 length first: never walk an unbounded string just to reject it.
	if (value.length > max || Buffer.byteLength(value) > max) return refuse("session-page-too-large");
	return value;
}
export function validateSessionHistoryRequest(request: SessionHistoryRequest): void {
	if (!request || typeof request.readId !== "string" || !request.readId || request.readId.length > 256 ||
		Buffer.byteLength(request.readId) > 256 || typeof request.expectedSessionId !== "string" ||
		!request.expectedSessionId || request.expectedSessionId.length > 256 || Buffer.byteLength(request.expectedSessionId) > 256 ||
		typeof request.expectedSessionPath !== "string" || !request.expectedSessionPath ||
		request.expectedSessionPath.length > 1024 || Buffer.byteLength(request.expectedSessionPath) > 1024 ||
		!Number.isSafeInteger(request.before) || request.before < 0 || !Number.isSafeInteger(request.limit) ||
		request.limit < 1 || request.limit > 100 || !Number.isSafeInteger(request.expiresAt)) refuse("invalid-arguments");
}
function cleanAbsolute(value: string): boolean {
	return value.startsWith("/") && !value.includes("\0") && !value.includes("\\") && posix.normalize(value) === value;
}

/** No I/O, no context-message reconstruction, and no references retained across a yield. */
export async function projectSessionHistory(manager: SessionManager, request: SessionHistoryRequest, signal: AbortSignal): Promise<SessionHistoryPage> {
	validateSessionHistoryRequest(request);
	const remaining = request.expiresAt - Date.now();
	if (remaining <= 0) refuse("session-read-expired");
	if (remaining > 5000) refuse("invalid-arguments");
	const deadline = performance.now() + remaining;
	const view = manager.captureHistoryReadView();
	if (!view) refuse("session-source-unavailable");
	const sessionId = metadata(view.sessionId, 256);
	const sessionFile = metadata(view.sessionFile);
	const cwd = metadata(view.cwd);
	if (sessionId !== request.expectedSessionId || sessionFile !== request.expectedSessionPath ||
		!cleanAbsolute(sessionFile) || !sessionFile.startsWith("/workspace/sessions/") ||
		!posix.basename(sessionFile).endsWith(`_${sessionId}.jsonl`) || !cleanAbsolute(cwd) ||
		(cwd !== "/workspace" && !cwd.startsWith("/workspace/"))) refuse("session-source-unavailable");
	if (view.entryCount > MAX_ENTRIES) refuse("session-page-too-large");
	const budget = new ReadBudget(view, signal, deadline);
	budget.check();
	const links = new Map<string, { parent: string; position: number }>();
	let leaf = "";
	let structuralBytes = 0;
	for (let i = 0; i < view.entryCount; i++) {
		await budget.step();
		const entry = view.getEntry(i);
		if (!entry) refuse("session-history-changed");
		const id = metadata(entry.id, 256);
		if (!id) refuse("session-source-unavailable");
		const parent = entry.parentId === undefined ? leaf : metadata(entry.parentId, 256);
		if (links.has(id)) refuse("session-source-unavailable");
		structuralBytes += 64 + Buffer.byteLength(id) + Buffer.byteLength(parent);
		if (structuralBytes > STRUCTURE) refuse("session-page-too-large");
		links.set(id, { parent, position: i });
		leaf = id;
		await budget.step(Buffer.byteLength(id) + Buffer.byteLength(parent));
	}
	const chain = new Set<number>();
	for (let id = leaf; id;) {
		await budget.step();
		const link = links.get(id);
		if (!link) break; // Same orphan-chain boundary as the disk projector.
		if (chain.has(link.position)) refuse("session-source-unavailable");
		structuralBytes += 16;
		if (structuralBytes > STRUCTURE) refuse("session-page-too-large");
		chain.add(link.position);
		id = link.parent;
	}
	// Identify the requested window without retaining projected text from other entries.
	const selected: { position: number; index: number }[] = [];
	let total = 0;
	for (let i = 0; i < view.entryCount; i++) {
		await budget.step();
		if (!chain.has(i)) continue;
		if (!await isProjected(view, i, budget)) continue;
		total++;
		if (request.before && total >= request.before) continue;
		if (selected.length === request.limit) selected.shift();
		selected.push({ position: i, index: total });
	}
	const page: SessionHistoryPage = { sessionId, sourceKind: "native-engine", total, omittedLines: 0, leafEntryId: leaf, entries: [] };
	let pageBytes = Buffer.byteLength(JSON.stringify(page));
	const reserve = (bytes: number) => {
		pageBytes += bytes;
		if (pageBytes > PAGE) refuse("session-page-too-large");
	};
	for (const item of selected) {
		await budget.step();
		const entry = view.getEntry(item.position);
		if (!entry) refuse("session-history-changed");
		const out: SessionHistoryEntry = { index: item.index, kind: "compaction" };
		const entryId = metadata(entry.id, 256), timestamp = metadata(entry.timestamp);
		if (entryId) out.entryId = entryId;
		if (timestamp) out.timestamp = timestamp;
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult") {
				out.kind = "tool-result";
				const name = metadata(msg.toolName);
				if (name) out.toolName = name;
				if (msg.isError) out.isError = true;
			} else if (msg.role === "user" || msg.role === "assistant") {
				out.kind = msg.role;
				if (msg.role === "user") {
					const attribution = metadata("attribution" in msg ? msg.attribution : undefined);
					if (attribution) out.attribution = attribution;
				} else {
					const provider = metadata(msg.provider), model = metadata(msg.model);
					if (provider && model) out.model = metadata(`${provider}/${model}`);
				}
				reserve(Buffer.byteLength(JSON.stringify(out)) + 1);
				await budget.step(Buffer.byteLength(JSON.stringify(out)));
				await projectContent(view, item.position, out, budget, reserve);
				page.entries.push(out);
				continue;
			}
		}
		reserve(Buffer.byteLength(JSON.stringify(out)) + 1);
		await budget.step(Buffer.byteLength(JSON.stringify(out)));
		page.entries.push(out);
	}
	budget.check();
	return page;
}

class ReadBudget {
	#steps = 0;
	#bytes = 0;
	#parts = 0;
	#inspected = 0;
	constructor(private view: SessionHistoryReadView, private signal: AbortSignal, private deadline: number) {}
	check(): void {
		if (this.signal.aborted || performance.now() >= this.deadline) refuse("session-read-expired");
		if (!this.view.isCurrent()) refuse("session-history-changed");
	}
	async step(bytes = 0, part = false): Promise<void> {
		if (part && ++this.#parts > MAX_ENTRIES) refuse("session-page-too-large");
		this.#inspected += bytes;
		if (this.#inspected > STRUCTURE) refuse("session-page-too-large");
		this.#bytes += bytes;
		if (++this.#steps >= 256 || this.#bytes >= 64 * 1024) {
			this.check();
			await new Promise<void>(resolve => setImmediate(resolve));
			this.#steps = this.#bytes = 0;
		}
		this.check();
	}
}

async function isProjected(view: SessionHistoryReadView, position: number, budget: ReadBudget): Promise<boolean> {
	const entry = view.getEntry(position);
	if (!entry) refuse("session-history-changed");
	if (entry.type === "compaction") return true;
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	if (role === "toolResult") return true;
	if (role !== "user" && role !== "assistant") return false;
	const content = entry.message.content;
	if (typeof content === "string") return content.length > 0;
	// Entry/parts are never used again after yielding without a revision check.
	for (let i = 0; i < content.length; i++) {
		await budget.step(0, true);
		const current = view.getEntry(position);
		if (!current || current.type !== "message" || !Array.isArray(current.message.content)) refuse("session-history-changed");
		const part = current.message.content[i];
		if (part && (part.type === "image" || part.type === "toolCall" || (part.type === "text" && part.text.length > 0))) return true;
	}
	return false;
}

async function projectContent(view: SessionHistoryReadView, position: number, out: SessionHistoryEntry, budget: ReadBudget, reserve: (bytes: number) => void): Promise<void> {
	let text = "", textBytes = 0, images = 0;
	let truncated = false;
	const append = async (value: string) => {
		if (truncated) return;
		// Copy only a bounded prefix, never encode/join the original large string.
		const separator = textBytes > 0 ? "\n" : "";
		const room = Math.max(0, TEXT - textBytes - separator.length);
		let prefix = value.slice(0, room);
		// Do not split a surrogate pair before UTF-8 truncation.
		if (prefix.length < value.length && /[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
		const encoded = Buffer.from(prefix);
		let cut = Math.min(room, encoded.length);
		while (cut > 0 && cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut--;
		prefix = encoded.subarray(0, cut).toString("utf8");
		await budget.step(encoded.length);
		if (prefix.length < value.length || (separator && textBytes === TEXT)) truncated = true;
		const added = (textBytes < TEXT ? separator : "") + prefix;
		if (added) {
			reserve(Buffer.byteLength(JSON.stringify(added)) - 2 + (textBytes === 0 ? 10 : 0));
			text += added;
			textBytes += Buffer.byteLength(added);
		}
	};
	const entry = view.getEntry(position);
	if (!entry || entry.type !== "message") refuse("session-history-changed");
	if (typeof entry.message.content === "string") await append(entry.message.content);
	else {
		const count = entry.message.content.length;
		for (let i = 0; i < count; i++) {
			await budget.step(0, true);
			const current = view.getEntry(position);
			if (!current || current.type !== "message" || !Array.isArray(current.message.content)) refuse("session-history-changed");
			const part = current.message.content[i];
			if (!part) continue;
			if (part.type === "text") await append(part.text);
			else if (part.type === "image") images++;
			else if (part.type === "toolCall") {
				const name = metadata(part.name);
				reserve(Buffer.byteLength(JSON.stringify(name)) + (out.tools ? 1 : 11));
				(out.tools ??= []).push(name);
				await budget.step(Buffer.byteLength(name));
			}
		}
	}
	if (text) out.text = text;
	if (truncated) { reserve(17); out.truncated = true; }
	if (images) { reserve(20); out.images = images; }
}
