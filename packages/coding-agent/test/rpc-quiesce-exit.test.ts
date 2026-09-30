import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { terminalAttestationPath } from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown> & { type?: string; id?: string; data?: Record<string, unknown> };

/** Drives the RPC fixture over raw JSONL so tests control how frames are batched into reads. */
class RpcProcess {
	readonly frames: Frame[] = [];
	readonly child: Bun.Subprocess<"pipe", "pipe", "inherit">;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

	constructor(cwd: string) {
		this.child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "quiesce-rpc-agent.ts")], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		void this.#read();
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
				const frame = JSON.parse(line) as Frame;
				this.frames.push(frame);
				for (const waiter of this.#waiters.filter(w => w.match(frame))) {
					this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
					waiter.resolve(frame);
				}
			}
		}
	}

	waitFor(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, 15_000, `timed out waiting for ${label}`);
	}

	send(...commands: object[]): void {
		// One write: every frame lands in the same read.
		this.child.stdin.write(commands.map(command => `${JSON.stringify(command)}\n`).join(""));
		this.child.stdin.flush();
	}

	async request(command: { id: string } & Record<string, unknown>): Promise<Frame> {
		this.send(command);
		return this.waitFor(frame => frame.type === "response" && frame.id === command.id, String(command.type));
	}
}

describe.skipIf(process.platform === "win32")("RPC quiesce_and_exit", () => {
	let tempDir: TempDir;
	let rpc: RpcProcess;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-rpc-quiesce-");
		rpc = new RpcProcess(tempDir.path());
		await rpc.waitFor(frame => frame.type === "ready", "ready");
	});

	afterEach(async () => {
		rpc.child.kill("SIGKILL");
		await rpc.child.exited;
		tempDir.removeSync();
	});

	async function sessionFile(): Promise<string> {
		const state = await rpc.request({ id: "state", type: "get_state" });
		return String(state.data?.sessionFile);
	}

	it("advertises the capabilities and exits after a passed quiesce with the attestation on disk", async () => {
		const state = await rpc.request({ id: "s1", type: "get_state" });
		expect(state.data?.capabilities).toEqual(["quiesce-exit/1", "owned-jobs/1"]);
		const file = String(state.data?.sessionFile);

		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "op-1", nonce: "n-1" });
		expect(attest.data).toMatchObject({ operationId: "op-1", nonce: "n-1", admission: "open" });
		const epoch = Number(attest.data?.epoch);

		const quiesce = await rpc.request({
			id: "q1",
			type: "quiesce_and_exit",
			operationId: "op-1",
			attempt: 1,
			epoch,
			deadline: Date.now() + 30_000,
		});
		expect(quiesce).toMatchObject({
			command: "quiesce_and_exit",
			success: true,
			data: { status: "quiesced", operationId: "op-1", attempt: 1 },
		});
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(0);
		const onDisk = JSON.parse(fs.readFileSync(terminalAttestationPath(file), "utf8"));
		expect(onDisk).toMatchObject({ kind: "quiesce", operationId: "op-1", attempt: 1, epoch, interrupted: false });
	});

	it("refuses when a prompt shares the read with the quiesce, runs the prompt, and exits on a fresh attempt", async () => {
		const file = await sessionFile();
		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "op-2", nonce: "n-1" });
		rpc.send(
			{ id: "p1", type: "prompt", message: "racing prompt" },
			{
				id: "q1",
				type: "quiesce_and_exit",
				operationId: "op-2",
				attempt: 1,
				epoch: attest.data?.epoch,
				deadline: Date.now() + 30_000,
			},
		);
		const refused = await rpc.waitFor(frame => frame.type === "response" && frame.id === "q1", "q1");
		expect(refused.data).toMatchObject({ status: "refused", attempt: 1 });
		await rpc.waitFor(frame => frame.type === "agent_end", "agent_end");
		expect(fs.existsSync(terminalAttestationPath(file))).toBe(false);

		const reattest = await rpc.request({ id: "a2", type: "attest", operationId: "op-2", nonce: "n-2" });
		const quiesce = await rpc.request({
			id: "q2",
			type: "quiesce_and_exit",
			operationId: "op-2",
			attempt: 2,
			epoch: reattest.data?.epoch,
			deadline: Date.now() + 30_000,
		});
		expect(quiesce.data).toMatchObject({ status: "quiesced", attempt: 2 });
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(0);
	});

	it("records an interrupted hang-up when SIGHUP arrives mid-turn", async () => {
		const file = await sessionFile();
		await rpc.request({ id: "p1", type: "prompt", message: "hold this turn" });
		await rpc.waitFor(frame => frame.type === "agent_start", "agent_start");
		rpc.child.kill("SIGHUP");
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(129);
		const onDisk = JSON.parse(fs.readFileSync(terminalAttestationPath(file), "utf8"));
		expect(onDisk).toMatchObject({ kind: "hangup", signal: "sighup", interrupted: true });
		expect(onDisk.counts.streaming).toBe(1);
	});
});
