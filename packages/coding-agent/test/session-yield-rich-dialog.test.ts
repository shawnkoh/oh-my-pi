import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const fixture = path.join(import.meta.dir, "fixtures", "session-yield-rich-dialog.ts");
type Frame = Record<string, unknown>;

class RichDialogHost {
	readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: Frame[] = [];
	readonly stderr: Promise<string>;
	readonly reading: Promise<void>;
	readonly env: Record<string, string | undefined>;
	#sequence = 0;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

	constructor(readonly cwd: string) {
		this.env = { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1" };
		this.child = Bun.spawn([process.execPath, fixture], {
			cwd,
			env: this.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.stderr = new Response(this.child.stderr).text();
		this.reading = this.#read();
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.startsWith("{")) continue;
				const frame: unknown = JSON.parse(line);
				if (!isRecord(frame)) continue;
				this.frames.push(frame);
				for (const waiter of this.#waiters.filter(waiter => waiter.match(frame))) {
					this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
					waiter.resolve(frame);
				}
			}
		}
	}

	waitFor(match: (frame: Frame) => boolean): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, 15_000, "Rich dialog frame did not arrive");
	}

	async request(command: object): Promise<Frame> {
		const id = String(++this.#sequence);
		this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		this.child.stdin.flush();
		return this.waitFor(frame => frame.type === "response" && frame.id === id);
	}

	async yield(sessionId: string, timeout = 3_000): Promise<number> {
		const requester = Bun.spawn([process.execPath, fixture, "request", sessionId, String(timeout)], {
			cwd: this.cwd,
			env: this.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			return await withTimeout(requester.exited, 15_000, "Yield requester did not exit");
		} finally {
			requester.kill();
		}
	}
}

function expectBusy(frame: Frame, count: number, focus: string): void {
	expect(frame.streaming).toBe(false);
	expect(frame.work).toMatchObject({ queuedInput: count });
	expect(frame.focus).toBe(focus);
}

describe.skipIf(process.platform === "win32")("standalone rich TUI dialogs block session yield", () => {
	let temp: TempDir;
	let host: RichDialogHost;
	let sessionId: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-yield-rich-dialog-");
		host = new RichDialogHost(temp.path());
		const ready = await host.waitFor(frame => frame.type === "ready");
		sessionId = String(ready.sessionId);
	});
	afterEach(async () => {
		host.child.kill("SIGKILL");
		await host.child.exited;
		await host.reading;
		temp.removeSync();
	});

	it.each(["ask", "approval"])(
		"does not dismiss a standalone %s on yield expiry",
		async kind => {
			const focus = kind === "ask" ? "AskDialogComponent" : "ApprovalDialogComponent";
			expectBusy(await host.request({ type: "open", kind, dialogId: "first" }), 1, focus);
			expect(await host.yield(sessionId, 150)).toBe(4);
			expectBusy(await host.request({ type: "status" }), 1, focus);
			expect(host.frames.some(frame => frame.type === "settled")).toBe(false);
			await host.request({ type: "key", text: "\x1b" });
			const settled = await host.waitFor(frame => frame.type === "settled" && frame.dialogId === "first");
			expect(settled.value).toBe(kind === "ask" ? null : false);
			expect(settled.work).toMatchObject({ queuedInput: 0 });
			expect(await host.yield(sessionId)).toBe(0);
			expect(await host.child.exited).toBe(0);
		},
		30_000,
	);

	it("counts queued requests across cancellation and advancement without phantom busy work", async () => {
		expectBusy(await host.request({ type: "open", kind: "ask", dialogId: "first" }), 1, "AskDialogComponent");
		expectBusy(await host.request({ type: "open", kind: "ask", dialogId: "cancelled" }), 2, "AskDialogComponent");
		expectBusy(await host.request({ type: "open", kind: "approval", dialogId: "next" }), 3, "AskDialogComponent");
		expectBusy(await host.request({ type: "abort", dialogId: "cancelled" }), 2, "AskDialogComponent");
		expect(await host.yield(sessionId, 150)).toBe(4);
		await host.request({ type: "abort", dialogId: "first" });
		expectBusy(await host.request({ type: "status" }), 1, "ApprovalDialogComponent");
		expect(await host.yield(sessionId, 150)).toBe(4);
		expectBusy(await host.request({ type: "status" }), 1, "ApprovalDialogComponent");
		await host.request({ type: "abort", dialogId: "next" });
		expect((await host.request({ type: "status" })).work).toMatchObject({ queuedInput: 0 });
		expect(await host.yield(sessionId)).toBe(0);
		expect(await host.child.exited).toBe(0);
	}, 30_000);
	it("keeps the ask answer available after an expired yield, then yields cleanly", async () => {
		expectBusy(await host.request({ type: "open", kind: "ask", dialogId: "answer" }), 1, "AskDialogComponent");
		expect(await host.yield(sessionId, 150)).toBe(4);
		await host.request({ type: "key", text: "\r" });
		const settled = await host.waitFor(frame => frame.type === "settled" && frame.dialogId === "answer");
		expect(settled.value).toMatchObject({ kind: "submit", results: [expect.anything()] });
		expect(settled.work).toMatchObject({ queuedInput: 0 });
		expect(await host.yield(sessionId)).toBe(0);
		expect(await host.child.exited).toBe(0);
	}, 30_000);
});
