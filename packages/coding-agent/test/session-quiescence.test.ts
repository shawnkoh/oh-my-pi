import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type OwnedJobRecord,
	ownedJobRegistryPath,
	ownedProcessState,
	ownerMarkerEnv,
} from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import * as natives from "@oh-my-pi/pi-natives";
import { AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import {
	AdmissionClosedError,
	hasOutstandingWork,
	type QuiesceRequest,
	quiesceEndsProcess,
	quiesceExitCode,
	retireTerminalAttestationSync,
	type TerminalAttestation,
	terminalAttestationPath,
} from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../src/session/session-manager.ts");

describe("AgentSession quiesce-and-exit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let mock: MockModel;
	let manager: AsyncJobManager;
	/** Resolved to release a turn blocked in the mock provider. */
	let providerGate: PromiseWithResolvers<void> | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-quiesce-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		providerGate = undefined;
		// Retained shells are process-global; other suites' background jobs must not leak in.
		vi.spyOn(bashExecutor, "retainedShellWorkCount").mockReturnValue(0);
	});

	afterEach(async () => {
		providerGate?.resolve();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	interface SessionParts {
		sessionManager: SessionManager;
		modelRegistry: ModelRegistry;
		extensionRunner?: ExtensionRunner;
	}

	function sessionParts(): SessionParts {
		return {
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		};
	}

	function createSession(parts: SessionParts = sessionParts()): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		mock = createMockModel({
			handler: async () => {
				if (providerGate) await providerGate.promise;
				return { content: ["ok"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		manager = new AsyncJobManager({ maxRunningJobs: 4 });
		session = new AgentSession({
			agent,
			sessionManager: parts.sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: parts.modelRegistry,
			ownedAsyncJobManager: manager,
			agentId: "Main",
			...(parts.extensionRunner ? { extensionRunner: parts.extensionRunner } : {}),
		});
		return session;
	}

	async function createSessionWithExtension(factory: ExtensionFactory): Promise<AgentSession> {
		const parts = sessionParts();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, "quiesce");
		parts.extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			parts.sessionManager,
			parts.modelRegistry,
		);
		return createSession(parts);
	}

	/** A quiesce request built from a fresh attestation (its epoch, instance id and session). */
	function request(s: AgentSession, overrides: Partial<QuiesceRequest> = {}): QuiesceRequest {
		const attested = s.attest("op-1", "nonce");
		return {
			operationId: "op-1",
			attempt: 1,
			epoch: attested.epoch,
			instanceId: attested.instanceId,
			sessionId: attested.session.id,
			deadline: Date.now() + 60_000,
			...overrides,
		};
	}

	function readAttestation(s: AgentSession): TerminalAttestation {
		return JSON.parse(fs.readFileSync(terminalAttestationPath(s.sessionFile!), "utf8")) as TerminalAttestation;
	}

	async function turnStarted(s: AgentSession): Promise<void> {
		const started = Promise.withResolvers<void>();
		const unsubscribe = s.subscribe(event => {
			if (event.type === "agent_start") started.resolve();
		});
		await started.promise;
		unsubscribe();
	}

	it("exits an idle session with a durable attestation and admits nothing afterwards", async () => {
		const s = createSession();
		const attested = s.attest("op-1", "nonce-1");
		expect(attested.nonce).toBe("nonce-1");
		expect(Object.values(attested.counts).every(count => count === 0)).toBe(true);

		const result = s.quiesceForExit(request(s, { epoch: attested.epoch }));
		expect(result.status).toBe("quiesced");
		const onDisk = readAttestation(s);
		expect(onDisk).toMatchObject({ kind: "quiesce", operationId: "op-1", attempt: 1, interrupted: false });
		expect(onDisk.epoch).toBe(attested.epoch);

		// Every admission path now refuses; nothing reaches the provider.
		const outcomes = await Promise.allSettled([
			s.prompt("late prompt"),
			s.steer("late steer"),
			s.followUp("late follow-up"),
			s.sendUserMessage("late user message"),
			s.sendCustomMessage({ customType: "ext", content: "late", display: false }, { triggerTurn: true }),
			s.executeBash("echo late"),
		]);
		for (const outcome of outcomes) {
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(AdmissionClosedError);
		}
		expect(() =>
			s.queueDeferredMessage({ role: "custom", customType: "x", content: "late", display: false, timestamp: 0 }),
		).toThrow(AdmissionClosedError);
		const ircMessage: IrcMessage = { id: "m1", from: "peer", to: "Main", body: "late", ts: Date.now() };
		expect(() => s.deliverIrcMessage(ircMessage)).toThrow(AdmissionClosedError);
		const completion: DaemonCompletionNotification = {
			event: "daemon-completed",
			completionId: "c1",
			owner: "Main",
			daemon: {
				name: "svc",
				id: "d1",
				state: "exited",
				createdAt: 0,
				startedAt: 0,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
			},
		};
		await expect(s.queueLaunchCompletion(completion)).rejects.toBeInstanceOf(AdmissionClosedError);
		expect(mock.calls.length).toBe(0);
	});

	it("refuses with work_active when input admitted before the attestation is still outstanding", async () => {
		for (const admit of [
			(s: AgentSession) => s.prompt("racing prompt"),
			(s: AgentSession) => s.steer("racing steer"),
			(s: AgentSession) => s.followUp("racing follow-up"),
			(s: AgentSession) => s.sendUserMessage("racing user message"),
		]) {
			const s = createSession();
			const pending = admit(s);
			// Attest after the admission: the epoch is current, so only counting can refuse.
			const result = s.quiesceForExit(request(s));
			expect(result).toMatchObject({ status: "refused", reason: "work_active" });
			expect(s.isAdmissionClosed()).toBe(false);
			expect(fs.existsSync(terminalAttestationPath(s.sessionFile!))).toBe(false);
			await pending;
			// Nothing was lost: the admitted input is still queued or already delivered.
			const counts = s.getWorkCounts();
			expect(counts.queuedInput + mock.calls.length).toBeGreaterThan(0);
			await s.dispose();
			session = undefined;
			AsyncJobManager.resetForTests();
		}
	});

	it("refuses while an extension handler is still running after the turn went idle", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const s = await createSessionWithExtension(pi => {
			pi.on("turn_end", async () => {
				entered.resolve();
				await gate.promise;
			});
		});
		const turn = s.prompt("hello");
		await entered.promise;
		await turn;
		expect(s.isStreaming).toBe(false);
		const result = s.quiesceForExit(request(s));
		expect(result).toMatchObject({ status: "refused", reason: "work_active" });
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.snapshot.counts.scheduledTurns).toBeGreaterThan(0);
		gate.resolve();
		await s.waitForIdle();
		expect(s.quiesceForExit(request(s, { attempt: 2 }))).toMatchObject({ status: "quiesced" });
	});

	it("starts no provider turn from an internal producer after a pass", async () => {
		const s = createSession();
		s.yieldQueue.register<string>("test-notice", {
			build: notes => ({
				role: "custom",
				customType: "test-notice",
				content: notes.join("\n"),
				display: false,
				timestamp: 0,
			}),
		});
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced" });
		s.yieldQueue.enqueue("test-notice", "late notice");
		await expect(s.yieldQueue.enqueueWithReceipt("test-notice", "late receipt")).rejects.toBeInstanceOf(
			AdmissionClosedError,
		);
		await expect(s.runEphemeralTurn({ promptText: "side question" })).rejects.toBeInstanceOf(AdmissionClosedError);
		await s.waitForIdle();
		expect(s.yieldQueue.size()).toBe(0);
		expect(mock.calls.length).toBe(0);
	});

	it("refuses while a background job runs and never cancels it", async () => {
		const s = createSession();
		const release = Promise.withResolvers<void>();
		let aborted = false;
		manager.register(
			"bash",
			"long job",
			async ({ signal }) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				await release.promise;
				return "done";
			},
			{ ownerId: "Main" },
		);
		const result = s.quiesceForExit(request(s));
		expect(result).toMatchObject({ status: "refused", reason: "work_active" });
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.snapshot.counts.asyncJobs).toBe(1);
		expect(aborted).toBe(false);
		expect(s.isAdmissionClosed()).toBe(false);
		release.resolve();
	});

	it("records a job in the registry before register() returns and its end once settled", async () => {
		const s = createSession();
		const release = Promise.withResolvers<void>();
		const epochBefore = s.activityEpoch;
		const job = manager.register("task", "subagent run", async () => {
			await release.promise;
			return "done";
		});
		const registryFile = ownedJobRegistryPath(s.sessionFile!);
		const readRecords = () =>
			fs
				.readFileSync(registryFile, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as OwnedJobRecord);
		const start = readRecords().find(record => record.type === "start");
		if (start?.type !== "start") throw new Error("expected a start record");
		expect(start).toMatchObject({ kind: "subagent", inProcess: true, pid: process.pid, sleepable: false });
		expect(s.activityEpoch).toBeGreaterThan(epochBefore);
		release.resolve();
		await manager.getJob(job)?.promise;
		expect(readRecords().some(record => record.type === "end" && record.jobId === start.jobId)).toBe(true);
	});

	it("evaluates each attempt once: a repeat replays its answer, an older one never executes", () => {
		const s = createSession();
		const expired = s.quiesceForExit(request(s, { attempt: 1, deadline: Date.now() - 1 }));
		expect(expired).toMatchObject({ status: "refused", reason: "deadline_expired" });
		expect(s.isAdmissionClosed()).toBe(false);

		// Same attempt again: the original answer, not a fresh evaluation that would now pass.
		expect(s.quiesceForExit(request(s, { attempt: 1 }))).toEqual(expired);
		expect(s.quiesceForExit(request(s, { attempt: 0 }))).toMatchObject({ reason: "stale_attempt" });
		expect(fs.existsSync(terminalAttestationPath(s.sessionFile!))).toBe(false);

		expect(s.quiesceForExit(request(s, { attempt: 2, epoch: s.activityEpoch + 1 }))).toMatchObject({
			reason: "epoch_mismatch",
		});
		expect(s.isAdmissionClosed()).toBe(false);
		const passed = s.quiesceForExit(request(s, { attempt: 3 }));
		expect(passed).toMatchObject({ status: "quiesced" });
		// A retry after a lost response learns the attempt passed.
		expect(s.quiesceForExit(request(s, { attempt: 3 }))).toBe(passed);
	});

	it("refuses a request built from another session object's attestation, even with a matching epoch", async () => {
		const other = createSession();
		const foreign = other.attest("op-1", "nonce");
		await other.dispose();
		AsyncJobManager.resetForTests();
		const s = createSession();
		const result = s.quiesceForExit(request(s, { instanceId: foreign.instanceId }));
		expect(result).toMatchObject({ status: "refused", reason: "invocation_mismatch" });
		expect(s.isAdmissionClosed()).toBe(false);
		expect(fs.existsSync(terminalAttestationPath(s.sessionFile!))).toBe(false);
		// A foreign request does not use up the attempt number of this session's operation.
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced", attempt: 1 });
	});

	it("refuses a request attested for a different session after a session switch", async () => {
		const s = createSession();
		await s.prompt("materialize the first session");
		const before = request(s);
		await s.newSession();
		// The switch moves the epoch as well, so the stale request is refused either way.
		expect(s.activityEpoch).toBeGreaterThan(before.epoch);
		const result = s.quiesceForExit({ ...before, epoch: s.activityEpoch });
		expect(result).toMatchObject({ status: "refused", reason: "session_mismatch" });
		expect(s.isAdmissionClosed()).toBe(false);
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced", attempt: 1 });
	});

	it("exits unattested instead of wedging when the attestation cannot be written after the seal", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		// A non-empty directory where the attestation goes: the atomic rename fails after the seal.
		const target = terminalAttestationPath(s.sessionFile!);
		fs.mkdirSync(path.join(target, "occupied"), { recursive: true });
		const result = s.quiesceForExit(request(s));
		expect(result).toMatchObject({ status: "exit_unattested", reason: "attestation_unavailable" });
		expect(quiesceEndsProcess(result)).toBe(true);
		expect(quiesceExitCode(result)).toBe(1);
		// The transcript is final and no input is taken; a retry learns the same outcome.
		expect(s.isAdmissionClosed()).toBe(true);
		expect(s.quiesceForExit(request(s))).toBe(result);
		// The unpublished attestation is not left behind where it could be mistaken for one.
		const dir = path.dirname(target);
		expect(fs.readdirSync(dir).filter(name => name.startsWith(`${path.basename(target)}.`))).toEqual([]);
	});

	it("keeps the transcript final on exit_unattested even when finalizing it failed", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		vi.spyOn(s.sessionManager, "finalizeForExit").mockImplementation(() => {
			throw new Error("flush failed");
		});
		const file = s.sessionFile!;
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "exit_unattested" });
		const size = fs.statSync(file).size;
		s.sessionManager.appendCustomEntry("late", { after: "exit" });
		s.sessionManager.flushSync();
		expect(fs.statSync(file).size).toBe(size);
	});

	it("removes a crashed writer's unpublished attestation when the session is opened again", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const file = s.sessionFile!;
		const stale = `${terminalAttestationPath(file)}.${0x7ffffff7}.tmp`;
		fs.writeFileSync(stale, "{}");
		await s.dispose();
		session = undefined;
		AsyncJobManager.resetForTests();
		createSession({
			sessionManager: await SessionManager.open(file, path.join(tempDir.path(), "sessions")),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("retires the previous attestation even when a stale temp entry cannot be removed", () => {
		const sessionFile = path.join(tempDir.path(), "sweep.jsonl");
		const attestation = terminalAttestationPath(sessionFile);
		fs.writeFileSync(attestation, JSON.stringify({ invocation: { pid: 0x7ffffff7, startId: "5" } }));
		// A directory where a dead writer's temp file would be: removing it fails.
		fs.mkdirSync(`${attestation}.${0x7ffffff7}.tmp`);
		expect(retireTerminalAttestationSync(sessionFile)).toBe(
			path.join(tempDir.path(), `sweep.terminal.${0x7ffffff7}-5.json`),
		);
		expect(fs.existsSync(attestation)).toBe(false);
	});

	it("refuses while a session switch is still being set up", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const s = await createSessionWithExtension(pi => {
			pi.on("session_before_switch", async () => {
				entered.resolve();
				await gate.promise;
			});
		});
		const switching = s.newSession();
		await entered.promise;
		const result = s.quiesceForExit(request(s));
		expect(result).toMatchObject({ status: "refused", reason: "work_active" });
		gate.resolve();
		await switching;
	});

	it("refuses while the session is being moved", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		vi.spyOn(s.sessionManager, "moveTo").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
		});
		try {
			const moving = s.moveSession(path.join(tempDir.path(), "elsewhere"));
			await entered.promise;
			expect(s.quiesceForExit(request(s))).toMatchObject({ status: "refused", reason: "work_active" });
			gate.resolve();
			await moving;
		} finally {
			vi.restoreAllMocks();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"never quiesces while a tracked process hands its owner marker to a child between the scan and the count",
		async () => {
			const s = createSession();
			await s.prompt("materialize the transcript");
			const dir = tempDir.path();
			const trigger = path.join(dir, "fork-now");
			const childFile = path.join(dir, "child-pid");
			const carrierScript = path.join(dir, "carrier.ts");
			const sleepSeconds = String(5000 + Math.floor(Math.random() * 4000));
			await Bun.write(
				carrierScript,
				[
					`import * as fs from "node:fs";`,
					"const timer = setInterval(() => {",
					`\tif (!fs.existsSync(${JSON.stringify(trigger)})) return;`,
					"\tclearInterval(timer);",
					`\tconst child = Bun.spawn(["/bin/sleep", ${JSON.stringify(sleepSeconds)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
					"\tchild.unref();",
					`\tfs.writeFileSync(${JSON.stringify(childFile)}, String(child.pid));`,
					"\tprocess.exit(0);",
					"}, 5);",
				].join("\n"),
			);
			const carrier = Bun.spawn([process.execPath, carrierScript], {
				env: { ...process.env, ...ownerMarkerEnv() },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "inherit",
			});
			let childPid: number | undefined;
			try {
				const registry = s.ownedJobRegistry!;
				registry.registerProcess({ kind: "process", pid: carrier.pid, command: "carrier" });
				const req = request(s);
				// Only the timing is forced: right after the quiesce's own scan returns, the carrier
				// forks a marked child and exits, before the processes are counted.
				const realScan = natives.scanProcessesByEnv;
				let armed = true;
				vi.spyOn(natives, "scanProcessesByEnv").mockImplementation((name, tokens, since) => {
					const result = realScan(name, tokens, since);
					if (!armed) return result;
					armed = false;
					fs.writeFileSync(trigger, "");
					const deadline = Date.now() + 10_000;
					while (
						!(fs.existsSync(childFile) && fs.readFileSync(childFile, "utf8") !== "") ||
						ownedProcessState(carrier.pid, null) !== "gone"
					) {
						if (Date.now() > deadline) throw new Error("the carrier never forked and exited");
						Bun.sleepSync(5);
					}
					childPid = Number(fs.readFileSync(childFile, "utf8"));
					return result;
				});
				expect(s.quiesceForExit(req)).toMatchObject({ status: "refused", reason: "work_active" });
				expect(registry.openJobs()).toContainEqual(expect.objectContaining({ pid: childPid, discovered: true }));
			} finally {
				carrier.kill("SIGKILL");
				if (childPid !== undefined) process.kill(childPid, "SIGKILL");
			}
		},
	);

	it("starts no scheduled continuation after a pass", async () => {
		const s = createSession();
		// A transcript an agent.continue() could resume from.
		s.agent.appendMessage({ role: "user", content: "resume from here", timestamp: Date.now() });
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced" });
		s.resumeAfterAskReanswer();
		await s.waitForIdle();
		expect(mock.calls.length).toBe(0);
	});

	it("retires a previous invocation's terminal attestation when the session is opened again", async () => {
		const first = createSession();
		await first.prompt("materialize the transcript");
		expect(first.quiesceForExit(request(first))).toMatchObject({ status: "quiesced" });
		const sessionFile = first.sessionFile!;
		await first.dispose();
		session = undefined;
		AsyncJobManager.resetForTests();

		const reopened = createSession({
			sessionManager: await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions")),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		// The stale attestation no longer sits where a consumer looks for this exit.
		expect(fs.existsSync(terminalAttestationPath(sessionFile))).toBe(false);
		const dir = path.dirname(sessionFile);
		const base = path.basename(sessionFile, ".jsonl");
		expect(
			fs.readdirSync(dir).some(name => name.startsWith(`${base}.terminal.`) && name !== `${base}.terminal.json`),
		).toBe(true);
		// The latest registry header is this invocation's, written at bind.
		const headers = fs
			.readFileSync(ownedJobRegistryPath(sessionFile), "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as OwnedJobRecord)
			.filter(record => record.type === "invocation");
		expect(headers.length).toBe(2);
		expect(reopened.isAdmissionClosed()).toBe(false);
	});

	it("reopens admission after a refusal so later input runs normally", async () => {
		const s = createSession();
		expect(s.quiesceForExit(request(s, { epoch: s.activityEpoch + 5 }))).toMatchObject({ status: "refused" });
		await s.prompt("after refusal");
		expect(mock.calls.length).toBe(1);
	});

	it("captures pre-teardown work on hang-up mid-turn with queued input and a running job", async () => {
		const s = createSession();
		providerGate = Promise.withResolvers<void>();
		const turn = s.prompt("long turn");
		await turnStarted(s);
		await s.followUp("queued behind the turn");
		const release = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"background",
			async () => {
				await release.promise;
				return "done";
			},
			{ ownerId: "Main" },
		);

		const disposed = s.dispose({ reason: postmortem.Reason.SIGHUP });
		// Written synchronously by beginDispose(), before any queue clear or cancellation.
		const onDisk = readAttestation(s);
		expect(onDisk).toMatchObject({ kind: "hangup", signal: "sighup", interrupted: true });
		expect(onDisk.counts.streaming).toBe(1);
		expect(onDisk.counts.queuedInput).toBeGreaterThan(0);
		expect(onDisk.counts.asyncJobs).toBe(1);
		await expect(s.prompt("after hang-up")).rejects.toBeInstanceOf(AdmissionClosedError);

		providerGate.resolve();
		release.resolve();
		await disposed;
		await turn.catch(() => undefined);
		session = undefined;
	});

	it("records an idle hang-up as not interrupted", async () => {
		const s = createSession();
		await s.dispose({ reason: postmortem.Reason.SIGTERM });
		session = undefined;
		expect(readAttestation(s)).toMatchObject({ kind: "hangup", signal: "sigterm", interrupted: false });
	});

	function sha256OfFile(file: string): string {
		return new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex");
	}

	it("attests the final transcript: the session file after exit matches the attested hash", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const result = s.quiesceForExit(request(s));
		if (result.status !== "quiesced") throw new Error(`expected quiesced, got ${JSON.stringify(result)}`);
		const file = s.sessionFile!;
		expect(result.attestation.session.sha256).toBe(sha256OfFile(file));
		// The exit record is part of the attested bytes, not appended afterwards.
		expect(fs.readFileSync(file, "utf8")).toContain('"customType":"session_exit"');

		// Teardown (extension hooks, exit recorder, draft save, close) must not change the file.
		await s.sessionManager.saveDraft("draft typed after quiesce");
		await s.dispose();
		session = undefined;
		expect(sha256OfFile(file)).toBe(result.attestation.session.sha256!);
		expect(fs.statSync(file).size).toBe(result.attestation.session.size!);
		expect(readAttestation(s).session).toMatchObject({
			size: result.attestation.session.size,
			sha256: result.attestation.session.sha256,
		});
	});

	it("attests an absent transcript as absent and never creates it afterwards", async () => {
		const s = createSession();
		const result = s.quiesceForExit(request(s));
		if (result.status !== "quiesced") throw new Error("expected quiesced");
		expect(result.attestation.session).toMatchObject({ size: null, sha256: null });
		await s.sessionManager.saveDraft("draft typed after quiesce");
		await s.dispose();
		session = undefined;
		expect(fs.existsSync(s.sessionFile!)).toBe(false);
	});

	it("adds the final transcript digest to a hang-up attestation once teardown closes it", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		await s.dispose({ reason: postmortem.Reason.SIGTERM });
		session = undefined;
		const onDisk = readAttestation(s);
		expect(onDisk.kind).toBe("hangup");
		expect(onDisk.session.sha256).toBe(sha256OfFile(s.sessionFile!));
	});

	/** Another process that opens `sessionFile` and writes to it, so it owns the file until closed. */
	async function spawnSessionFileOwner(sessionFile: string): Promise<{ close(): Promise<void> }> {
		const script = path.join(tempDir.path(), "session-file-owner.ts");
		await Bun.write(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
				"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
				'manager.appendMessage({ role: "user", content: "owner turn", timestamp: Date.now() });',
				"await manager.flush();",
				'process.stdout.write("owned\\n");',
				"for await (const _line of console) {}",
				"await manager.close();",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, sessionFile], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = child.stdout.getReader();
		let out = "";
		while (!out.includes("owned\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`session file owner exited early: ${await new Response(child.stderr).text()}`);
			out += new TextDecoder().decode(value);
		}
		return {
			close: async () => {
				child.stdin.end();
				await child.exited;
			},
		};
	}

	it("attests the sibling the transcript moved to when another process owns the session file", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const original = s.sessionFile!;
		// Give up this process's claim on the file; another process takes it by writing.
		await s.sessionManager.close();
		const owner = await spawnSessionFileOwner(original);
		try {
			const result = s.quiesceForExit(request(s));
			if (result.status !== "quiesced") throw new Error(`expected quiesced, got ${JSON.stringify(result)}`);
			// Recording the exit moved the transcript to a fresh sibling instead of writing into the owner's file.
			const sibling = s.sessionFile!;
			expect(sibling).not.toBe(original);
			expect(path.dirname(sibling)).toBe(path.dirname(original));
			expect(fs.readFileSync(sibling, "utf8")).toContain('"customType":"session_exit"');
			expect(fs.readFileSync(original, "utf8")).not.toContain('"customType":"session_exit"');

			// The attestation, its file and the registry are bound to the sibling that holds the transcript.
			expect(result.path).toBe(terminalAttestationPath(sibling));
			expect(fs.existsSync(terminalAttestationPath(original))).toBe(false);
			expect(result.attestation.session).toMatchObject({
				id: s.sessionId,
				file: sibling,
				size: fs.statSync(sibling).size,
				sha256: sha256OfFile(sibling),
			});
			expect(result.attestation.registryPath).toBe(ownedJobRegistryPath(sibling));
			expect(fs.existsSync(ownedJobRegistryPath(sibling))).toBe(true);

			await s.dispose();
			session = undefined;
			expect(sha256OfFile(sibling)).toBe(result.attestation.session.sha256!);
			expect(readAttestation(s).session.file).toBe(sibling);
		} finally {
			await owner.close();
		}
	}, 30_000);

	it.skipIf(process.platform === "win32")(
		"refuses to quiesce while a self-daemonized descendant of a shell run is alive",
		async () => {
			const s = createSession();
			const launcher = path.join(tempDir.path(), "daemonize.ts");
			await Bun.write(
				launcher,
				[
					'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });',
					"child.unref();",
					"console.log(child.pid);",
					"process.exit(0);",
				].join("\n"),
			);
			const run = await s.executeBash(`${process.execPath} ${launcher}`);
			const daemonPid = Number(run.output.trim());
			try {
				const result = s.quiesceForExit(request(s));
				expect(result).toMatchObject({ status: "refused", reason: "work_active" });
				if (result.status !== "refused") throw new Error("unreachable");
				expect(result.snapshot.counts.detachedJobs).toBe(1);
				expect(s.attest("op", "n").registry.ownerScan?.discovered).toBe(0);
			} finally {
				process.kill(daemonPid, "SIGKILL");
			}
		},
		30_000,
	);
});

describe("AgentSession quiesce with an advisor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	/** Resolved to let advisor reviews finish; reviews block on it while set. */
	let advisorGate: PromiseWithResolvers<void> | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-quiesce-advisor-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		advisorGate = undefined;
		vi.spyOn(bashExecutor, "retainedShellWorkCount").mockReturnValue(0);
	});

	afterEach(async () => {
		advisorGate?.resolve();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createAdvisedSession(advisorSettings: Record<string, unknown>): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const primary = createMockModel({ handler: async () => ({ content: ["done"] }) });
		const advisor = createMockModel({
			handler: async () => {
				await advisorGate?.promise;
				return { content: ["advisor quiet"] };
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...advisorSettings });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [] },
				streamFn: primary.stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
			agentId: "Main",
			advisorTools: [],
			advisorStreamFn: advisor.stream,
		});
		if (!session.setAdvisorEnabled(true)) throw new Error("expected an advisor runtime");
		return session;
	}

	function request(s: AgentSession): QuiesceRequest {
		const attested = s.attest("op-1", "nonce");
		return {
			operationId: "op-1",
			attempt: 1,
			epoch: attested.epoch,
			instanceId: attested.instanceId,
			sessionId: attested.session.id,
			deadline: Date.now() + 60_000,
		};
	}

	it("counts a primary boundary parked on a strict advisor as outstanding work", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(AdvisorRuntime.prototype, "waitForCatchup").mockImplementation(() => {
			entered.resolve();
			return release.promise.then(() => true);
		});
		// The reviewer itself reports nothing queued or running: only the parked boundary is work.
		const pendingWork = Object.getOwnPropertyDescriptor(AdvisorRuntime.prototype, "pendingWork");
		if (!pendingWork) throw new Error("expected AdvisorRuntime.pendingWork");
		Object.defineProperty(AdvisorRuntime.prototype, "pendingWork", { configurable: true, get: () => 0 });
		try {
			const s = createAdvisedSession({ "advisor.syncBacklog": "strict" });
			const run = s.prompt("hello");
			await entered.promise;
			expect(s.getWorkCounts().scheduledTurns).toBeGreaterThan(0);
			expect(s.quiesceForExit(request(s))).toMatchObject({ status: "refused", reason: "work_active" });
			release.resolve();
			await run;
			await s.waitForIdle();
			expect(s.getWorkCounts().scheduledTurns).toBe(0);
		} finally {
			release.resolve();
			Object.defineProperty(AdvisorRuntime.prototype, "pendingWork", pendingWork);
		}
	});

	it("counts a scheduled review but not an update the review cadence holds back", async () => {
		advisorGate = Promise.withResolvers<void>();
		const s = createAdvisedSession({ "advisor.syncBacklog": "off", "advisor.reviewInterval": 2 });
		await s.prompt("first");
		await s.waitForIdle();
		// The first boundary's update was captured but held for the second one's review.
		expect(hasOutstandingWork(s.getWorkCounts())).toBe(false);

		await s.prompt("second");
		// The second boundary sent both updates for review; the review is still running.
		expect(s.getWorkCounts().scheduledTurns).toBeGreaterThan(0);
		advisorGate.resolve();
		await s.waitForAdvisorCatchup(5_000);
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced" });
	});
});
