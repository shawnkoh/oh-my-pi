import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type PendingExtensionRequest,
	requestRpcSelect,
	RPC_TOOL_APPROVAL_TIMEOUT_MS,
} from "../src/modes/rpc/rpc-mode";

const approval = { toolCallId: "call-1", toolName: "bash", arguments: { command: "rm /fixture/victim" } };

function dialogFrames() {
	const frames: { id: string; method: string }[] = [];
	const output = (frame: object) => {
		if (!("id" in frame) || typeof frame.id !== "string" || !("method" in frame) || typeof frame.method !== "string")
			throw new Error("Not a dialog frame");
		frames.push({ id: frame.id, method: frame.method });
	};
	return { frames, output };
}

afterEach(() => vi.useRealTimers());

describe("unanswered RPC approval", () => {
	it("denies at the deadline and withdraws the request before a late approval", async () => {
		vi.useFakeTimers();
		const pending = new Map<string, PendingExtensionRequest>();
		const { frames, output } = dialogFrames();
		const result = requestRpcSelect(pending, output, "Allow?", ["Approve", "Deny"], { approval });
		const outcome = result.catch(error => error);
		vi.advanceTimersByTime(RPC_TOOL_APPROVAL_TIMEOUT_MS - 1);
		expect(pending.has(frames[0].id)).toBe(true);
		vi.advanceTimersByTime(1);
		expect((await outcome).message).toContain("no approver in RPC Session; use an allowed command or ask Ops");
		expect(pending.has(frames[0].id)).toBe(false);
		expect(frames[1]?.method).toBe("cancel");
	});

	it("honors an explicit answer before the deadline without a later cancellation", async () => {
		vi.useFakeTimers();
		const pending = new Map<string, PendingExtensionRequest>();
		const { frames, output } = dialogFrames();
		const result = requestRpcSelect(pending, output, "Allow?", ["Approve", "Deny"], { approval });
		vi.advanceTimersByTime(RPC_TOOL_APPROVAL_TIMEOUT_MS - 1);
		pending.get(frames[0].id)!.resolve({ type: "extension_ui_response", id: frames[0].id, value: "Approve" });
		expect(await result).toBe("Approve");
		vi.advanceTimersByTime(RPC_TOOL_APPROVAL_TIMEOUT_MS);
		expect(frames.some(frame => frame.method === "cancel")).toBe(false);
	});

	it("leaves ordinary questions pending beyond the approval deadline", async () => {
		vi.useFakeTimers();
		const pending = new Map<string, PendingExtensionRequest>();
		const { frames, output } = dialogFrames();
		const result = requestRpcSelect(pending, output, "Which?", ["Keep", "Change"]);
		vi.advanceTimersByTime(RPC_TOOL_APPROVAL_TIMEOUT_MS * 2);
		pending.get(frames[0].id)!.resolve({ type: "extension_ui_response", id: frames[0].id, value: "Keep" });
		expect(await result).toBe("Keep");
	});

	it("clears the deadline when the session rejects its pending dialogs", async () => {
		vi.useFakeTimers();
		const pending = new Map<string, PendingExtensionRequest>();
		const { frames, output } = dialogFrames();
		const result = requestRpcSelect(pending, output, "Allow?", ["Approve", "Deny"], { approval });
		const outcome = result.catch(error => error);
		pending.get(frames[0].id)!.reject(new Error("session ended"));
		expect((await outcome).message).toBe("session ended");
		vi.advanceTimersByTime(RPC_TOOL_APPROVAL_TIMEOUT_MS);
		expect(frames.some(frame => frame.method === "cancel")).toBe(false);
		expect(pending.size).toBe(0);
	});
});
