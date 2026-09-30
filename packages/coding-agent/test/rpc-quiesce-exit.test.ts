import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type QuiesceResult, terminalAttestationPath } from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { isRecord, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown> & { type?: string; id?: string; data?: Record<string, unknown> };

/** Drives the RPC fixture over raw JSONL so tests control how frames are batched into reads. */
class RpcProcess {
	readonly frames: Frame[] = [];
	readonly child: Bun.Subprocess<"pipe", "pipe", "inherit">;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

	constructor(argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) {
		this.child = Bun.spawn(argv, {
			cwd: options.cwd,
			env: options.env,
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

const MODES: Array<"rpc" | "rpc-ui"> = ["rpc", "rpc-ui"];

function sha256OfFile(file: string): string {
	return new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The request fields that bind a quiesce to the attestation it was built from. */
function boundTo(attest: Frame): Record<string, unknown> {
	const data = attest.data ?? {};
	const session = data.session;
	return {
		epoch: data.epoch,
		instanceId: data.instanceId,
		sessionId: isRecord(session) ? session.id : undefined,
	};
}

describe.skipIf(process.platform === "win32").each(MODES)("RPC quiesce_and_exit (%s)", mode => {
	let tempDir: TempDir;
	let rpc: RpcProcess;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-rpc-quiesce-");
		rpc = new RpcProcess([process.execPath, path.join(import.meta.dir, "fixtures", "quiesce-rpc-agent.ts")], {
			cwd: tempDir.path(),
			env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.path(), PI_NO_TITLE: "1", QUIESCE_FIXTURE_MODE: mode },
		});
		await rpc.waitFor(frame => frame.type === "ready", "ready");
	}, 30_000);

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
		expect(state.data?.capabilities).toEqual(expect.arrayContaining(["quiesce-exit/1", "owned-jobs/1"]));
		const file = String(state.data?.sessionFile);

		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "op-1", nonce: "n-1" });
		expect(attest.data).toMatchObject({ operationId: "op-1", nonce: "n-1", admission: "open" });
		const epoch = Number(attest.data?.epoch);

		const quiesce = await rpc.request({
			id: "q1",
			type: "quiesce_and_exit",
			operationId: "op-1",
			attempt: 1,
			...boundTo(attest),
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
	}, 30_000);

	it("refuses every mutating command after a passed quiesce and exits with the transcript as attested", async () => {
		const file = await sessionFile();
		await rpc.request({ id: "p0", type: "prompt", message: "materialize the transcript" });
		await rpc.waitFor(frame => frame.type === "agent_end", "agent_end");
		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "op-3", nonce: "n-1" });
		rpc.send(
			{
				id: "q1",
				type: "quiesce_and_exit",
				operationId: "op-3",
				attempt: 1,
				...boundTo(attest),
				deadline: Date.now() + 30_000,
			},
			{ id: "p1", type: "prompt", message: "too late" },
			{ id: "s1", type: "steer", message: "too late" },
			{ id: "f1", type: "follow_up", message: "too late" },
			{ id: "n1", type: "set_session_name", name: "renamed after exit" },
			{ id: "n2", type: "new_session" },
			{ id: "g1", type: "get_state" },
		);
		const quiesce = await rpc.waitFor(frame => frame.type === "response" && frame.id === "q1", "q1");
		expect(quiesce.data).toMatchObject({ status: "quiesced", operationId: "op-3", attempt: 1 });
		for (const id of ["p1", "s1", "f1", "n1", "n2"]) {
			const refused = await rpc.waitFor(frame => frame.type === "response" && frame.id === id, id);
			expect(refused).toMatchObject({ success: false, code: "admission_closed" });
		}
		// Reads still answer while the process exits.
		expect(await rpc.waitFor(frame => frame.type === "response" && frame.id === "g1", "g1")).toMatchObject({
			success: true,
		});
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(0);
		// The response frame is wire JSON: its shape is the TerminalAttestation contract.
		const result: QuiesceResult = quiesce.data as unknown as QuiesceResult;
		if (result.status !== "quiesced") throw new Error("expected quiesced");
		expect(sha256OfFile(file)).toBe(result.attestation.session.sha256 ?? "");
		expect(fs.statSync(file).size).toBe(result.attestation.session.size ?? -1);
	}, 30_000);

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
				...boundTo(attest),
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
			...boundTo(reattest),
			deadline: Date.now() + 30_000,
		});
		expect(quiesce.data).toMatchObject({ status: "quiesced", attempt: 2 });
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(0);
	}, 30_000);

	it("records an interrupted hang-up when SIGHUP arrives mid-turn", async () => {
		const file = await sessionFile();
		await rpc.request({ id: "p1", type: "prompt", message: "hold this turn" });
		await rpc.waitFor(frame => frame.type === "agent_start", "agent_start");
		rpc.child.kill("SIGHUP");
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(129);
		const onDisk = JSON.parse(fs.readFileSync(terminalAttestationPath(file), "utf8"));
		expect(onDisk).toMatchObject({ kind: "hangup", signal: "sighup", interrupted: true });
		expect(onDisk.counts.streaming).toBe(1);
	}, 30_000);

	it("attests the final transcript on a SIGTERM hang-up: the file after exit matches the digest", async () => {
		const file = await sessionFile();
		await rpc.request({ id: "p0", type: "prompt", message: "materialize the transcript" });
		await rpc.waitFor(frame => frame.type === "agent_end", "agent_end");
		await rpc.request({ id: "p1", type: "prompt", message: "hold this turn" });
		await rpc.waitFor(frame => frame.type === "agent_start", "agent_start");
		rpc.child.kill("SIGTERM");
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(143);
		const onDisk = JSON.parse(fs.readFileSync(terminalAttestationPath(file), "utf8"));
		expect(onDisk).toMatchObject({ kind: "hangup", signal: "sigterm", interrupted: true });
		expect(onDisk.session.sha256).toBe(sha256OfFile(file));
		expect(onDisk.session.size).toBe(fs.statSync(file).size);
	}, 30_000);

	it("exits with code 1 and no attestation when it cannot be written after the transcript is final", async () => {
		const file = await sessionFile();
		await rpc.request({ id: "p0", type: "prompt", message: "materialize the transcript" });
		await rpc.waitFor(frame => frame.type === "agent_end", "agent_end");
		fs.mkdirSync(path.join(terminalAttestationPath(file), "occupied"), { recursive: true });
		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "op-u", nonce: "n" });
		const quiesce = await rpc.request({
			id: "q1",
			type: "quiesce_and_exit",
			operationId: "op-u",
			attempt: 1,
			...boundTo(attest),
			deadline: Date.now() + 30_000,
		});
		expect(quiesce.data).toMatchObject({ status: "exit_unattested", reason: "attestation_unavailable" });
		expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(1);
	}, 30_000);
});

describe.skipIf(process.platform === "win32")("RPC hang-up capture order", () => {
	it("counts work that another exit cleanup tears down, because the capture runs first", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-hangup-order-");
		const rpc = new RpcProcess([process.execPath, path.join(import.meta.dir, "fixtures", "quiesce-rpc-agent.ts")], {
			cwd: tempDir.path(),
			env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.path(), PI_NO_TITLE: "1", QUIESCE_FIXTURE_PENDING: "1" },
		});
		try {
			await rpc.waitFor(frame => frame.type === "ready", "ready");
			const state = await rpc.request({ id: "s1", type: "get_state" });
			const file = String(state.data?.sessionFile);
			rpc.child.kill("SIGHUP");
			expect(await withTimeout(rpc.child.exited, 15_000, "RPC process did not exit")).toBe(129);
			const onDisk = JSON.parse(fs.readFileSync(terminalAttestationPath(file), "utf8"));
			expect(onDisk).toMatchObject({ kind: "hangup", interrupted: true });
			expect(onDisk.counts.queuedInput).toBe(1);
		} finally {
			rpc.child.kill("SIGKILL");
			await rpc.child.exited;
		}
	}, 30_000);
});

// The real CLI entry in each protocol mode: proves the wiring main.ts does for `--mode rpc-ui`
// (tool UI context, hasUI) keeps the same command table, capability advertisement and gate.
describe.skipIf(process.platform === "win32").each(MODES)("CLI --mode %s quiesce_and_exit", mode => {
	let tempDir: TempDir;
	let rpc: RpcProcess;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-cli-quiesce-");
		const packageRoot = path.join(import.meta.dir, "..");
		const agentDir = path.join(tempDir.path(), "agent");
		rpc = new RpcProcess(
			[
				process.execPath,
				path.join(packageRoot, "src", "cli.ts"),
				"--mode",
				mode,
				"--session-dir",
				path.join(tempDir.path(), "sessions"),
				"--no-extensions",
				"--no-skills",
				"--no-rules",
			],
			{
				cwd: tempDir.path(),
				env: {
					...process.env,
					ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
					XDG_DATA_HOME: tempDir.path(),
					XDG_CONFIG_HOME: tempDir.path(),
					PI_CODING_AGENT_DIR: agentDir,
				},
			},
		);
		await rpc.waitFor(frame => frame.type === "ready", "ready");
	}, 30_000);

	afterEach(async () => {
		rpc.child.kill("SIGKILL");
		await rpc.child.exited;
		tempDir.removeSync();
	});

	it("advertises capabilities, refuses later input and exits 0 with the attestation on disk", async () => {
		const state = await rpc.request({ id: "s1", type: "get_state" });
		expect(state.data?.capabilities).toEqual(expect.arrayContaining(["quiesce-exit/1", "owned-jobs/1"]));
		const attest = await rpc.request({ id: "a1", type: "attest", operationId: "cli", nonce: "n" });
		expect(attest.data).toMatchObject({ operationId: "cli", nonce: "n", admission: "open" });
		rpc.send(
			{
				id: "q1",
				type: "quiesce_and_exit",
				operationId: "cli",
				attempt: 1,
				...boundTo(attest),
				deadline: Date.now() + 30_000,
			},
			{ id: "p1", type: "prompt", message: "too late" },
		);
		const quiesce = await rpc.waitFor(frame => frame.type === "response" && frame.id === "q1", "q1");
		expect(quiesce.data).toMatchObject({ status: "quiesced", operationId: "cli", attempt: 1 });
		const refused = await rpc.waitFor(frame => frame.type === "response" && frame.id === "p1", "p1");
		expect(refused).toMatchObject({ success: false, code: "admission_closed" });
		expect(await withTimeout(rpc.child.exited, 20_000, "CLI did not exit")).toBe(0);
		expect(fs.existsSync(String(quiesce.data?.path))).toBe(true);
	}, 30_000);
});
