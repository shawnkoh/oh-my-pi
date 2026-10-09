import { afterEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";
import { projectSessionHistory, type SessionHistoryRequest } from "../src/modes/rpc/rpc-session-history";

const id = "11111111-1111-4111-8111-111111111111";
const file = `/workspace/sessions/test_${id}.jsonl`;
const managers: SessionManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); });
async function load(lines: unknown[], cwd = "/workspace"): Promise<SessionManager> {
	const storage = new MemorySessionStorage();
	await storage.writeText(file, [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-09T00:00:00.000Z", cwd }), ...lines.map(line => JSON.stringify(line)), ""].join("\n"));
	const manager = await SessionManager.open(file, "/workspace/sessions", storage, { suppressBreadcrumb: true });
	managers.push(manager);
	return manager;
}
function request(overrides: Partial<SessionHistoryRequest> = {}): SessionHistoryRequest {
	return { readId: "read", expectedSessionId: id, expectedSessionPath: file, before: 0, limit: 100, expiresAt: Date.now() + 5000, ...overrides };
}
function message(id: string, text: string, parentId: string | null = null) {
	return { type: "message", id, parentId, message: { role: "user", content: text } };
}

describe("bounded native committed session history", () => {
	it("matches the shared Go fixture and pages the newest journal branch rather than selected leaf", async () => {
		const raw = await Bun.file(new URL("./fixtures/session-history/ordinary.jsonl", import.meta.url)).text();
		const expected = await Bun.file(new URL("./fixtures/session-history/ordinary.expected.json", import.meta.url)).json();
		const manager = await load(raw.trim().split("\n").slice(1).map(line => JSON.parse(line)));
		manager.branch("q");
		const page = await projectSessionHistory(manager, request(), new AbortController().signal);
		expect(page).toEqual({ ...expected, sessionId: id, sourceKind: "native-engine" });
		const older = await projectSessionHistory(manager, request({ before: 5, limit: 2 }), new AbortController().signal);
		expect(older.entries).toEqual(expected.entries.slice(2, 4));
		expect(older.total).toBe(6);
		expect(older.leafEntryId).toBe("last");
	});

	it("truncates UTF-8 before a split rune and never appends later parts after truncation", async () => {
		const manager = await load([{ type: "message", id: "m", parentId: null, message: { role: "user", content: [
			{ type: "text", text: "a".repeat(16383) + "😀" }, { type: "text", text: "late" }, { type: "image", data: "hidden" },
		] } }]);
		const page = await projectSessionHistory(manager, request(), new AbortController().signal);
		expect(page.entries).toEqual([{ index: 1, entryId: "m", kind: "user", text: "a".repeat(16383), truncated: true, images: 1 }]);
	});

	it("rejects identity selectors, dirty paths, header escapes and invalid paging", async () => {
		const manager = await load([message("m", "visible")]);
		for (const override of [{ expectedSessionId: "other" }, { expectedSessionPath: "/workspace/sessions/../sessions/test.jsonl" }]) {
			await expect(projectSessionHistory(manager, request(override), new AbortController().signal)).rejects.toMatchObject({ code: "session-source-unavailable" });
		}
		for (const override of [{ before: -1 }, { before: 1.5 }, { limit: 101 }, { expiresAt: Date.now() + 60_000 }]) {
			await expect(projectSessionHistory(manager, request(override), new AbortController().signal)).rejects.toMatchObject({ code: "invalid-arguments" });
		}
		const outside = await load([], "/workspace-other");
		await expect(projectSessionHistory(outside, request(), new AbortController().signal)).rejects.toMatchObject({ code: "session-source-unavailable" });
		await expect(projectSessionHistory(manager, request({ expiresAt: Date.now() - 1 }), new AbortController().signal)).rejects.toMatchObject({ code: "session-read-expired" });
	});

	it("yields to control work and refuses revision changes and cancellation", async () => {
		const lines = Array.from({ length: 1000 }, (_, i) => message(`m${i}`, "hello", i ? `m${i - 1}` : null));
		const manager = await load(lines);
		const changing = projectSessionHistory(manager, request(), new AbortController().signal);
		setImmediate(() => manager.appendCustomEntry("revision-change"));
		await expect(changing).rejects.toMatchObject({ code: "session-history-changed" });
		const controller = new AbortController();
		const canceled = projectSessionHistory(manager, request(), controller.signal);
		setImmediate(() => controller.abort());
		await expect(canceled).rejects.toMatchObject({ code: "session-read-expired" });
	});

	it("refuses oversized links, metadata, content arrays and escaped pages without returning partial history", async () => {
		const oversizedID = await load([message("x".repeat(257), "text")]);
		await expect(projectSessionHistory(oversizedID, request(), new AbortController().signal)).rejects.toMatchObject({ code: "session-page-too-large" });
		const metadata = await load([{ type: "message", id: "tool", parentId: null, message: { role: "toolResult", toolName: "x".repeat(1025), content: "secret" } }]);
		await expect(projectSessionHistory(metadata, request(), new AbortController().signal)).rejects.toMatchObject({ code: "session-page-too-large" });
		const parts = await load([{ type: "message", id: "parts", parentId: null, message: { role: "user", content: Array.from({ length: 100001 }, () => ({ type: "image", data: "hidden" })) } }]);
		await expect(projectSessionHistory(parts, request(), new AbortController().signal)).rejects.toMatchObject({ code: "session-page-too-large" });
		const escaped = await load(Array.from({ length: 8 }, (_, i) => message(`m${i}`, "\u0001".repeat(16384), i ? `m${i - 1}` : null)));
		await expect(projectSessionHistory(escaped, request(), new AbortController().signal)).rejects.toMatchObject({ code: "session-page-too-large" });
		const smaller = await projectSessionHistory(escaped, request({ limit: 1 }), new AbortController().signal);
		expect(smaller.entries[0]?.text).toBe("\u0001".repeat(16384));
		expect(smaller.total).toBe(8);
	});

	it("treats absent parent links as linear without exposing hidden tool-output strings", async () => {
		const manager = await load([
			{ type: "message", id: "one", message: { role: "user", content: "visible" } },
			{ type: "message", id: "two", message: { role: "toolResult", toolName: "read", content: "hidden".repeat(100000) } },
		]);
		const page = await projectSessionHistory(manager, request(), new AbortController().signal);
		expect(page.entries).toEqual([{ index: 1, entryId: "one", kind: "user", text: "visible" }, { index: 2, entryId: "two", kind: "tool-result", toolName: "read" }]);
	});
});
