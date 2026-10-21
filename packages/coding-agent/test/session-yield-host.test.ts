import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const fixture = path.join(import.meta.dir, "fixtures", "session-yield-host.ts");
type Frame = Record<string, unknown>;

/** Actual hosts in child processes: exiting never mocks away session disposal or lease release. */
class YieldHost {
	readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: Frame[] = [];
	readonly stderr: Promise<string>;
	readonly finishedReading: Promise<void>;
	#stderrText = "";
	#waiters: Array<{
		match: (frame: Frame) => boolean;
		resolve: (frame: Frame) => void;
		reject: (error: Error) => void;
	}> = [];

	constructor(
		readonly cwd: string,
		readonly env: Record<string, string | undefined>,
	) {
		this.child = Bun.spawn([process.execPath, fixture], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.stderr = this.#readStderr();
		this.finishedReading = this.#read();
	}

	async #readStderr(): Promise<string> {
		const decoder = new TextDecoder();
		for await (const chunk of this.child.stderr) this.#stderrText += decoder.decode(chunk, { stream: true });
		this.#stderrText += decoder.decode();
		return this.#stderrText;
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
		for (const waiter of this.#waiters.splice(0))
			waiter.reject(new Error("Host stdout closed before matching frame"));
	}

	waitFor(match: (frame: Frame) => boolean): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve, reject });
		return withTimeout(promise, 15_000, "Host frame did not arrive").catch(error => {
			throw new Error(
				`${String(error)}\nExit code: ${this.child.exitCode}\nFrames: ${JSON.stringify(this.frames.slice(-20))}\nStderr: ${this.#stderrText}`,
			);
		});
	}

	send(command: object): void {
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
		this.child.stdin.flush();
	}

	async request(id: string, command: object): Promise<Frame> {
		this.send({ id, ...command });
		return this.waitFor(frame => frame.type === "response" && frame.id === id);
	}

	async yield(sessionId: string, timeoutMs = 3_000): Promise<number> {
		const requester = Bun.spawn([process.execPath, fixture, "request", sessionId, String(timeoutMs)], {
			cwd: this.cwd,
			env: this.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			return await withTimeout(requester.exited, 15_000, "Yield requester did not finish");
		} finally {
			requester.kill();
		}
	}
}

function sessionId(frame: Frame): string {
	if (!isRecord(frame.data) || typeof frame.data.sessionId !== "string") throw new Error("Missing session id");
	return frame.data.sessionId;
}

describe.skipIf(process.platform === "win32")("actual session yield hosts", () => {
	let temp: TempDir;
	let host: YieldHost | undefined;

	beforeEach(() => {
		temp = TempDir.createSync("@omp-yield-host-");
	});
	afterEach(async () => {
		if (host) {
			host.child.kill("SIGKILL");
			await host.child.exited;
			await host.finishedReading;
		}
		temp.removeSync();
	});

	function launch(mode = "rpc", extra: Record<string, string> = {}): YieldHost {
		host = new YieldHost(temp.path(), {
			...process.env,
			PI_CODING_AGENT_DIR: temp.path(),
			PI_NO_TITLE: "1",
			PI_TEST_SESSION_OWNERS_DIR: temp.join("owners"),
			YIELD_FIXTURE_MODE: mode,
			...extra,
		});
		return host;
	}

	it("advertises the actual RPC holder and flushes the notice before release and exit", async () => {
		const rpc = launch();
		const ready = await rpc.waitFor(frame => frame.type === "ready");
		expect(ready.capabilities).toContain("session-yield/1");
		const id = sessionId(await rpc.request("state", { type: "get_state" }));
		expect(await rpc.yield(id)).toBe(0);
		expect(await rpc.child.exited).toBe(0);
		await rpc.finishedReading;
		expect(rpc.frames).toContainEqual(
			expect.objectContaining({ type: "notice", message: "This Thread continues in another Session" }),
		);
		expect(await rpc.yield(id)).toBe(3);
	}, 30_000);

	it("does not advertise an unleased session, then activates after its lazy first write", async () => {
		const rpc = launch("rpc", { YIELD_FIXTURE_LAZY: "1" });
		const ready = await rpc.waitFor(frame => frame.type === "ready");
		expect(ready.capabilities).not.toContain("session-yield/1");
		await rpc.request("prompt", { type: "prompt", message: "materialize" });
		await rpc.waitFor(frame => frame.type === "agent_end");
		const state = await rpc.request("state", { type: "get_state" });
		expect(isRecord(state.data) ? state.data.capabilities : undefined).toContain("session-yield/1");
		expect(await rpc.yield(sessionId(state))).toBe(0);
	}, 30_000);

	it("lets a busy provider finish and never exits for a timed-out request later", async () => {
		const rpc = launch();
		await rpc.waitFor(frame => frame.type === "ready");
		const id = sessionId(await rpc.request("state", { type: "get_state" }));
		await rpc.request("hold", { type: "prompt", message: "hold" });
		await rpc.waitFor(frame => frame.type === "agent_start");
		expect(await rpc.yield(id, 150)).toBe(4);
		fs.writeFileSync(temp.join("release"), "release");
		await rpc.waitFor(frame => frame.type === "agent_end");
		// This deliberately tests expiry across a child-process platform clock; parent fake timers cannot drive it.
		await Bun.sleep(150);
		expect(await rpc.request("still-alive", { type: "get_state" })).toMatchObject({ success: true });
		expect(
			rpc.frames.some(
				frame => frame.type === "notice" && frame.message === "This Thread continues in another Session",
			),
		).toBe(false);
		expect(await rpc.yield(id)).toBe(0);
	}, 30_000);

	it.each(["approval", "ask"])(
		"waits out a pending %s without dismissing it",
		async dialog => {
			const rpc = launch("rpc", { YIELD_FIXTURE_DIALOG: dialog });
			await rpc.waitFor(frame => frame.type === "ready");
			if (dialog === "ask") await rpc.request("enable-ask", { type: "set_ask_dialog", enabled: true });
			const pending = await rpc.waitFor(
				frame => frame.type === "extension_ui_request" && frame.method === (dialog === "ask" ? "ask" : "confirm"),
			);
			const id = sessionId(await rpc.request("state", { type: "get_state" }));
			expect(await rpc.yield(id, 150)).toBe(4);
			rpc.send({ type: "extension_ui_response", id: pending.id, cancelled: true });
			expect(await rpc.request("still-alive", { type: "get_state" })).toMatchObject({ success: true });
			expect(await rpc.yield(id)).toBe(0);
		},
		30_000,
	);

	it("disposes and rebinds the holder when RPC switches session", async () => {
		const rpc = launch();
		await rpc.waitFor(frame => frame.type === "ready");
		const oldId = sessionId(await rpc.request("old", { type: "get_state" }));
		await rpc.request("new", { type: "new_session" });
		await rpc.request("prompt", { type: "prompt", message: "materialize new session" });
		await rpc.waitFor(frame => frame.type === "agent_end");
		const newId = sessionId(await rpc.request("new-state", { type: "get_state" }));
		expect(newId).not.toBe(oldId);
		expect(await rpc.yield(oldId)).toBe(3);
		expect(await rpc.yield(newId)).toBe(0);
	}, 30_000);

	it.each(["rpc", "tui"])(
		"keeps %s yield available after an outgoing switch flush fails",
		async mode => {
			const holder = launch(mode, { YIELD_FIXTURE_FAIL_SWITCH_FLUSH: "1" });
			const ready = await holder.waitFor(frame => frame.type === (mode === "rpc" ? "ready" : "fixture_ready"));
			const state = mode === "rpc" ? await holder.request("before", { type: "get_state" }) : ready;
			const id = mode === "rpc" ? sessionId(state) : String(state.sessionId);
			fs.writeFileSync(temp.join("fail-switch-flush"), "fail once");
			if (mode === "rpc") {
				if (!isRecord(state.data)) throw new Error("Missing session state");
				const failed = await holder.request("switch", {
					type: "switch_session",
					sessionPath: state.data.sessionFile,
				});
				expect(failed).toMatchObject({ success: false });
				expect(String(failed.error)).toContain("Fixture outgoing flush failure");
				expect(sessionId(await holder.request("after", { type: "get_state" }))).toBe(id);
			} else {
				holder.send({ switch: true });
				const failed = await holder.waitFor(frame => frame.type === "fixture_switch_failed");
				expect(failed.sessionId).toBe(id);
				expect(String(failed.error)).toContain("Fixture outgoing flush failure");
			}
			expect(await holder.yield(id)).toBe(0);
			expect(await holder.child.exited).toBe(0);
		},
		30_000,
	);

	it("follows a whole-session RPC fork without accepting the old holder's request", async () => {
		const rpc = launch();
		await rpc.waitFor(frame => frame.type === "ready");
		const oldId = sessionId(await rpc.request("old", { type: "get_state" }));
		const oldMetadata = JSON.parse(fs.readFileSync(temp.join(`owners/${oldId}.lock`), "utf8"));
		expect(await rpc.request("fork", { type: "fork" })).toMatchObject({ success: true });
		const state = await rpc.request("fork-state", { type: "get_state" });
		const newId = sessionId(state);
		expect(newId).not.toBe(oldId);
		expect(isRecord(state.data) ? state.data.capabilities : undefined).toContain("session-yield/1");
		const newMetadata = JSON.parse(fs.readFileSync(temp.join(`owners/${newId}.lock`), "utf8"));
		expect(newMetadata.holderId).not.toBe(oldMetadata.holderId);
		expect(JSON.parse(fs.readFileSync(temp.join(`owners/${oldId}.lock`), "utf8")).capabilities).not.toContain(
			"session-yield/1",
		);
		// Keep an outgoing request live while the new identity accepts and exits.
		fs.writeFileSync(
			temp.join(`owners/${oldId}.yield-request.json`),
			JSON.stringify({
				holderId: oldMetadata.holderId,
				requestId: "stale-fork-request",
				deadline: Date.now() + 60_000,
			}),
		);
		expect(await rpc.request("alive-after-replay", { type: "get_state" })).toMatchObject({ success: true });
		expect(await rpc.yield(oldId)).toBe(3);
		expect(await rpc.yield(newId)).toBe(0);
		expect(fs.existsSync(temp.join(`owners/${oldId}.yield-ack.json`))).toBe(false);
	}, 30_000);

	it("follows a whole-session TUI fork", async () => {
		const tui = launch("tui");
		const ready = await tui.waitFor(frame => frame.type === "fixture_ready");
		tui.send({ fork: true });
		const forked = await tui.waitFor(frame => frame.type === "fixture_forked");
		expect(forked.sessionId).not.toBe(ready.sessionId);
		expect(await tui.yield(String(ready.sessionId))).toBe(3);
		expect(await tui.yield(String(forked.sessionId))).toBe(0);
	}, 30_000);

	it("follows a persistence-driven sibling after an external transcript replacement", async () => {
		const rpc = launch("rpc", { YIELD_FIXTURE_REWRITE: "1" });
		await rpc.waitFor(frame => frame.type === "ready");
		const state = await rpc.request("before-replacement", { type: "get_state" });
		const oldId = sessionId(state);
		if (!isRecord(state.data) || typeof state.data.sessionFile !== "string") throw new Error("Missing transcript");
		const foreign = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "foreign-replacement",
			timestamp: new Date().toISOString(),
			cwd: temp.path(),
		})}\n`;
		await rpc.request("prompt", { type: "prompt", message: "persist into a sibling" });
		await rpc.waitFor(frame => frame.type === "fixture_rewrite_ready");
		fs.writeFileSync(state.data.sessionFile, foreign);
		fs.writeFileSync(temp.join("rewrite"), "release the full rewrite");
		await rpc.waitFor(frame => frame.type === "agent_end");
		const sibling = await rpc.request("sibling-state", { type: "get_state" });
		const newId = sessionId(sibling);
		expect(newId).not.toBe(oldId);
		expect(fs.readFileSync(state.data.sessionFile, "utf8")).toBe(foreign);
		expect(isRecord(sibling.data) ? sibling.data.capabilities : undefined).toContain("session-yield/1");
		expect(await rpc.yield(oldId)).toBe(3);
		expect(await rpc.yield(newId)).toBe(0);
	}, 30_000);

	it("revokes before last release while the predecessor stays alive and a legacy successor holds the lease", async () => {
		const predecessor = launch("release");
		const ready = await predecessor.waitFor(frame => frame.type === "fixture_ready");
		const id = String(ready.sessionId);
		const metadataPath = temp.join(`owners/${id}.lock`);
		const before = fs.statSync(metadataPath);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		fs.writeFileSync(
			metadataPath,
			JSON.stringify({
				...metadata,
				unrelated: "preserved",
				capabilities: [...metadata.capabilities, "other/1"],
			}),
		);
		predecessor.send({ release: true });
		await predecessor.waitFor(frame => frame.type === "fixture_released");
		expect(predecessor.child.exitCode).toBeNull();
		expect(fs.statSync(metadataPath).ino).toBe(before.ino);
		expect(JSON.parse(fs.readFileSync(metadataPath, "utf8"))).toMatchObject({
			unrelated: "preserved",
			capabilities: ["other/1"],
		});
		const successor = new YieldHost(temp.path(), {
			...predecessor.env,
			YIELD_FIXTURE_MODE: "legacy",
			YIELD_FIXTURE_LEGACY_ID: id,
		});
		try {
			await successor.waitFor(frame => frame.type === "fixture_ready");
			const successorMetadata = fs.readFileSync(metadataPath, "utf8");
			expect(await predecessor.yield(id, 150)).toBe(5);
			expect(predecessor.child.exitCode).toBeNull();
			expect(successor.child.exitCode).toBeNull();
			expect(fs.statSync(metadataPath).ino).toBe(before.ino);
			expect(fs.readFileSync(metadataPath, "utf8")).toBe(successorMetadata);
			// Disposing the predecessor's old hook after takeover must not mutate successor metadata.
			predecessor.child.stdin.end();
			await predecessor.child.exited;
			await predecessor.finishedReading;
			expect(fs.readFileSync(metadataPath, "utf8")).toBe(successorMetadata);
		} finally {
			successor.child.stdin.end();
			await successor.child.exited;
			await successor.finishedReading;
		}
	}, 30_000);

	it("preserves and visibly prints unsent composer text before the TUI exits", async () => {
		const draft = "unsent fixture composer text";
		const tui = launch("tui", { YIELD_FIXTURE_DRAFT: draft });
		const ready = await tui.waitFor(frame => frame.type === "fixture_ready");
		expect(typeof ready.sessionId).toBe("string");
		expect(await tui.yield(String(ready.sessionId))).toBe(0);
		expect(await tui.child.exited).toBe(0);
		const stderr = await tui.stderr;
		expect(stderr).toContain(`Unsent input:\n${draft}\n\nThis Thread continues in another Session`);
		const artifactsDir = String(ready.artifactsDir);
		// The same draft sidecar consumed by --resume must survive the holder's exit.
		expect(fs.readFileSync(path.join(artifactsDir, "draft.txt"), "utf8")).toContain(draft);
	}, 30_000);
});
