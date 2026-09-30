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
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type OwnedJobRecord, ownedJobRegistryPath } from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import {
	AdmissionClosedError,
	type QuiesceRequest,
	type TerminalAttestation,
	terminalAttestationPath,
} from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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

	function createSession(): AgentSession {
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
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager: manager,
			agentId: "Main",
		});
		return session;
	}

	function request(s: AgentSession, overrides: Partial<QuiesceRequest> = {}): QuiesceRequest {
		return { operationId: "op-1", attempt: 1, epoch: s.activityEpoch, deadline: Date.now() + 60_000, ...overrides };
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

	it("refuses when input was admitted in the same tick, reopens, and runs that input", async () => {
		for (const admit of [
			(s: AgentSession) => s.prompt("racing prompt"),
			(s: AgentSession) => s.steer("racing steer"),
			(s: AgentSession) => s.followUp("racing follow-up"),
			(s: AgentSession) => s.sendUserMessage("racing user message"),
		]) {
			const s = createSession();
			const epoch = s.activityEpoch;
			const pending = admit(s);
			const result = s.quiesceForExit(request(s, { epoch }));
			expect(result).toMatchObject({ status: "refused" });
			if (result.status !== "refused") throw new Error("unreachable");
			// Either the input counts as outstanding or it already moved the epoch.
			expect(["work_active", "epoch_mismatch"]).toContain(result.reason);
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

	it("answers each attempt once and never executes an expired or stale attempt", () => {
		const s = createSession();
		const expired = s.quiesceForExit(request(s, { attempt: 1, deadline: Date.now() - 1 }));
		expect(expired).toMatchObject({ status: "refused", reason: "deadline_expired" });
		expect(s.isAdmissionClosed()).toBe(false);

		// Same attempt again: refused without evaluation, even though it would now pass.
		expect(s.quiesceForExit(request(s, { attempt: 1 }))).toMatchObject({ reason: "duplicate_attempt" });
		expect(s.quiesceForExit(request(s, { attempt: 0 }))).toMatchObject({ reason: "stale_attempt" });
		expect(fs.existsSync(terminalAttestationPath(s.sessionFile!))).toBe(false);

		expect(s.quiesceForExit(request(s, { attempt: 2, epoch: s.activityEpoch + 1 }))).toMatchObject({
			reason: "epoch_mismatch",
		});
		expect(s.isAdmissionClosed()).toBe(false);
		expect(s.quiesceForExit(request(s, { attempt: 3 }))).toMatchObject({ status: "quiesced" });
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
});
