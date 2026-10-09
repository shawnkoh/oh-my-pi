import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { RpcHistoryAdmission } from "../src/modes/rpc/rpc-history-admission";
import { RpcInputDispatcher } from "../src/modes/rpc/rpc-mode";
import { RpcOutputWriter } from "../src/modes/rpc/rpc-output";
import { SessionManager } from "../src/session/session-manager";
import type { projectSessionHistory, SessionHistoryPage } from "../src/modes/rpc/rpc-session-history";
import type { RpcResponse } from "../src/modes/rpc/rpc-types";

const query = (readId: string) => ({
	id: readId, type: "get_session_history" as const, readId,
	expectedSessionId: "session-1", expectedSessionPath: "/workspace/sessions/session-1.jsonl",
	before: 0, limit: 1, expiresAt: Date.now() + 3_000,
});

const page = {
	sessionId: "session-1", sourceKind: "native-engine", total: 0,
	omittedLines: 0, leafEntryId: "", entries: [],
} as SessionHistoryPage;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe("RPC native history credit", () => {
	it("bypasses the serial queue, refuses overlap, and retains canceled computation until exit", async () => {
		const pending = Promise.withResolvers<SessionHistoryPage>();
		const serial = Promise.withResolvers<void>();
		const emitted: RpcResponse[] = [];
		const writer = new RpcOutputWriter(new Writable({ write(chunk, _encoding, callback) {
			emitted.push(JSON.parse(String(chunk)));
			callback();
		} }), error => { throw error; });
		const controller = new RpcHistoryAdmission(SessionManager.inMemory(), writer,
			response => emitted.push(response),
			(async () => pending.promise) as typeof projectSessionHistory);
		const dispatcher = new RpcInputDispatcher({ deps: {
			handleCommand: async command => {
				await serial.promise;
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			},
			output: response => emitted.push(response as RpcResponse),
			errorResponse: (id, command, error) => ({ id, type: "response", command, success: false, error }),
			pendingExtensionRequests: new Map(), onHostToolResult: () => {}, onHostToolUpdate: () => {}, onHostUriResult: () => {},
			handleImmediateCommand: command => {
				if (command.type === "get_session_history") controller.start(command);
				if (command.type === "cancel_session_history") controller.cancel(command.readId);
			},
		} });
		dispatcher.dispatch({ type: "abort_retry", id: "blocked" });
		dispatcher.dispatch(query("first"));
		dispatcher.dispatch({ type: "cancel_session_history", readId: "first" });
		dispatcher.dispatch(query("second"));
		expect(emitted).toMatchObject([{ command: "get_session_history", code: "session-read-busy" }]);
		pending.resolve(page);
		await tick();
		dispatcher.dispatch(query("third"));
		await tick();
		// The canceled projector exited; successor can start without a late first response.
		expect(emitted.every(frame => frame.id !== "first")).toBe(true);
		controller.cancel("third");
		serial.resolve();
		await dispatcher.drain();
		await writer.close();
	});

	it("a canceled unsent response is discarded without delaying ordinary output", async () => {
		const chunks: string[] = [];
		const stalled = Promise.withResolvers<void>();
		let first = true;
		const sink = new Writable({ write(chunk, _encoding, callback) {
			chunks.push(String(chunk));
			if (first) { first = false; void stalled.promise.then(() => callback()); }
			else callback();
		} });
		const writer = new RpcOutputWriter(sink, error => { throw error; });
		writer.write(['{"type":"response","id":"ordinary-1"}\n']);
		let delivered: boolean | undefined;
		const discard = writer.defer('{"type":"response","id":"history"}\n', performance.now() + 500,
			value => { delivered = value; });
		writer.write(['{"type":"response","id":"ordinary-2"}\n']);
		discard();
		stalled.resolve();
		await writer.close();
		expect(delivered).toBe(false);
		expect(chunks.join("")).toBe('{"type":"response","id":"ordinary-1"}\n{"type":"response","id":"ordinary-2"}\n');
	});

	it("expires a stalled unsent frame and keeps ordinary responses ahead of history", async () => {
		const first = Promise.withResolvers<void>();
		const frames: string[] = [];
		const sink = new Writable({ write(chunk, _encoding, callback) {
			frames.push(String(chunk));
			if (frames.length === 1) void first.promise.then(() => callback());
			else callback();
		} });
		const writer = new RpcOutputWriter(sink, error => { throw error; });
		writer.write(['{"id":"control-1"}\n']);
		const completion = Promise.withResolvers<boolean>();
		writer.defer('{"id":"expired-history"}\n', performance.now() + 1, completion.resolve);
		writer.write(['{"id":"control-2"}\n']);
		expect(await completion.promise).toBe(false);
		first.resolve();
		await writer.close();
		expect(frames.join("")).toBe('{"id":"control-1"}\n{"id":"control-2"}\n');
	});

	it("retains credit for a history frame already handed to a stalled sink", async () => {
		const pending = Promise.withResolvers<void>();
		const sink = new Writable({ write(_chunk, _encoding, callback) { void pending.promise.then(() => callback()); } });
		const writer = new RpcOutputWriter(sink, error => { throw error; });
		let completion: boolean | undefined;
		const discard = writer.defer('{"type":"response","id":"history"}\n', performance.now() + 500,
			value => { completion = value; });
		await tick();
		discard();
		expect(completion).toBeUndefined();
		pending.resolve();
		await writer.close();
		expect(completion).toBe(true);
	});

	it("revalidates the captured revision immediately before delayed stdout delivery", async () => {
		const blocked = Promise.withResolvers<void>();
		const received = Promise.withResolvers<RpcResponse>();
		const manager = SessionManager.inMemory();
		const sink = new Writable({ write(chunk, _encoding, callback) {
			const frame = JSON.parse(String(chunk));
			if (frame.id === "control") void blocked.promise.then(() => callback());
			else { received.resolve(frame); callback(); }
		} });
		const writer = new RpcOutputWriter(sink, error => { throw error; });
		writer.write(['{"id":"control"}\n']);
		const history = new RpcHistoryAdmission(manager, writer, () => {}, async () => page);
		history.start(query("snapshot"));
		await tick();
		manager.appendCustomEntry("invalidating-append");
		blocked.resolve();
		expect(await received.promise).toMatchObject({
			id: "snapshot", command: "get_session_history", success: false, code: "session-history-changed",
		});
		await writer.close();
	});
});
