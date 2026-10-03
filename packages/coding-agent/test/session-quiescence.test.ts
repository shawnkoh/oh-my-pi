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
import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ExtensionActivityLedger, ServerActivityLedger } from "@oh-my-pi/pi-coding-agent/session/activity-ledger";
import * as activityLedger from "@oh-my-pi/pi-coding-agent/session/activity-ledger";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { DeliveryHandle } from "@oh-my-pi/pi-coding-agent/session/external-delivery";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
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
import type { CensusResult } from "../src/session/namespace-census";

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
		ExtensionActivityLedger.resetForTests();
		tempDir = TempDir.createSync("@omp-quiesce-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		providerGate = undefined;
		// Retained shells are process-global; other suites' background jobs must not leak in.
		vi.spyOn(bashExecutor, "retainedShellWorkCount").mockReturnValue(0);
		// Other transport suites deliberately leave cancelled remote work unsettled.
		vi.spyOn(activityLedger, "outstandingServerWork").mockReturnValue(0);
	});

	afterEach(async () => {
		providerGate?.resolve();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		ExtensionActivityLedger.resetForTests();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	interface SessionParts {
		sessionManager: SessionManager;
		modelRegistry: ModelRegistry;
		extensionRunner?: ExtensionRunner;
		census?: CensusResult;
		instance?: boolean;
	}

	function sessionParts(): SessionParts {
		return {
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		};
	}

	function createSession(parts: SessionParts = sessionParts(), agentId = "Main"): AgentSession {
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
			a13Instance: parts.instance === false ? undefined : { sandboxId: "test-sandbox", generation: "1" },
			a13Extinct: parts.instance === false ? undefined : [],
			namespaceCensus: parts.census ? () => parts.census! : undefined,
			sessionManager: parts.sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: parts.modelRegistry,
			ownedAsyncJobManager: manager,
			agentId,
			...(parts.extensionRunner ? { extensionRunner: parts.extensionRunner } : {}),
		});
		return session;
	}

	async function createSessionWithExtension(
		factory: ExtensionFactory,
		agentId = "Main",
		label = "quiesce",
	): Promise<AgentSession> {
		const parts = sessionParts();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, label);
		parts.extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			parts.sessionManager,
			parts.modelRegistry,
		);
		return createSession(parts, agentId);
	}

	it("strict census work refuses without changing attested retirement", () => {
		const census: CensusResult = { complete: true, work: [{ pid: 999, comm: "unowned", ppid: 0 }], reasons: [] };
		const s = createSession({ ...sessionParts(), census });
		const result = s.quiesceForExit(request(s, { completeness: "strict" }));
		expect(result.status).toBe("refused");
		if (result.status !== "refused") throw new Error("expected refusal");
		expect(result.reason).toBe("work_active");
		expect(result.snapshot.counts.detachedJobs).toBe(1);
		expect(result.snapshot.census).toEqual(census);
		expect(
			s.quiesceForExit(request(s, { operationId: "attested-after-census", completeness: "attested" })).status,
		).toBe("quiesced");
	});

	it("missing instance refuses strict retirement but leaves attested retirement unchanged", () => {
		const s = createSession({ ...sessionParts(), instance: false, census: { complete: true, work: [], reasons: [] } });
		const strict = s.quiesceForExit(request(s, { completeness: "strict" }));
		expect(strict).toMatchObject({ status: "refused", reason: "completeness_unknown" });
		if (strict.status !== "refused") throw new Error("expected refusal");
		expect(strict.snapshot.completenessReasons).toContain("instance_identity_missing");
		expect(s.quiesceForExit(request(s, { operationId: "attested" })).status).toBe("quiesced");
	});

	/** A quiesce request built from a fresh attestation (its epoch, instance id and session). */
	function request(s: AgentSession, overrides: Partial<QuiesceRequest> = {}): QuiesceRequest {
		const attested = s.attest("op-1", "nonce");
		return {
			operationId: "op-1",
			completeness: "attested",
			attempt: 1,
			epoch: attested.epoch,
			instanceId: attested.instanceId,
			sessionId: attested.session.id,
			deadline: Date.now() + 60_000,
			...overrides,
		};
	}

	it("refuses unsettled server activity only under strict retirement", () => {
		const server = new ServerActivityLedger("mcp", "session-ledger-test");
		server.sent(1);
		vi.spyOn(activityLedger, "outstandingServerWork").mockImplementation(() => server.count);
		const s = createSession();
		try {
			const strict = s.quiesceForExit(request(s, { completeness: "strict" }));
			expect(strict.status === "refused" && strict.reason).toBe("work_active");
			if (strict.status === "refused") expect(strict.snapshot.counts.scheduledTurns).toBe(1);
			expect(s.quiesceForExit(request(s, { attempt: 2 })).status).toBe("quiesced");
		} finally {
			server.processExited();
		}
	});

	it("names an undeclared extension in strict refusal, without changing attested retirement", async () => {
		const s = await createSessionWithExtension(() => {});
		const strict = s.quiesceForExit(request(s, { completeness: "strict" }));
		expect(strict.status).toBe("refused");
		if (strict.status !== "refused") throw new Error("expected refusal");
		expect(strict.reason).toBe("completeness_unknown");
		expect(strict.snapshot.completenessReasons).toContain("extension_work_reporting_unknown:quiesce");
		expect(s.quiesceForExit(request(s, { attempt: 2 })).status).toBe("quiesced");
	});

	it("counts extension holds only under strict and releases them idempotently", async () => {
		const parts = sessionParts();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.workReporting = "complete";
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"reporting",
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			parts.sessionManager,
			parts.modelRegistry,
		);
		parts.extensionRunner = runner;
		const s = createSession(parts);
		const first = runner.createContext().holdWork("background request");
		const second = runner.createContext().holdWork("another request");
		expect(runner.workCompletenessReasons()).toEqual([]);
		expect(s.getWorkCounts(true).scheduledTurns).toBe(2);
		expect(s.getWorkCounts().scheduledTurns).toBe(0);
		const refusal = s.quiesceForExit(request(s, { completeness: "strict" }));
		expect(refusal.status === "refused" && refusal.reason).toBe("work_active");
		first.release();
		first.release();
		expect(s.getWorkCounts(true).scheduledTurns).toBe(1);
		second.release();
		expect(s.getWorkCounts(true).scheduledTurns).toBe(0);
		extension.workReporting = undefined;
		runner.setSuspendedExtensions(() => true);
		const suspended = s.quiesceForExit(request(s, { attempt: 2, completeness: "strict" }));
		expect(suspended.status === "refused" && suspended.reason).toBe("completeness_unknown");
		if (suspended.status === "refused") {
			expect(suspended.snapshot.completenessReasons).toContain("extension_work_reporting_unknown:reporting");
		}
		expect(s.quiesceForExit(request(s, { attempt: 3 })).status).toBe("quiesced");
	});

	it("keeps a completed child's hold visible to main through parking and disposal", async () => {
		let hold: { release(): void } | undefined;
		const child = await createSessionWithExtension(api => {
			api.workReporting = "complete";
			api.on("agent_end", (_event, ctx) => {
				hold = ctx.holdWork("child background effects");
			});
		}, "0-Child", "child");
		const main = await createSessionWithExtension(api => {
			api.workReporting = "complete";
		});
		try {
			await child.prompt("complete the child task");
			expect(child.isStreaming).toBe(false);
			expect(hold).toBeDefined();
			for (const parked of [false, true]) {
				if (parked) await child.dispose();
				const refusal = main.quiesceForExit(request(main, { completeness: "strict", attempt: parked ? 2 : 1 }));
				expect(refusal.status === "refused" && refusal.reason).toBe("work_active");
				expect(main.getWorkCounts(true).scheduledTurns).toBe(1);
				expect(main.getWorkCounts().scheduledTurns).toBe(0);
			}
			hold!.release();
			hold!.release();
			expect(main.getWorkCounts(true).scheduledTurns).toBe(0);
		} finally {
			hold?.release();
			await child.dispose();
		}
	});

	it("names a child-only undeclared extension in main strict completeness, even after disposal", async () => {
		const child = await createSessionWithExtension(() => {}, "0-Child", "child-only");
		const main = await createSessionWithExtension(api => {
			api.workReporting = "complete";
		});
		try {
			for (const disposed of [false, true]) {
				if (disposed) await child.dispose();
				const refusal = main.quiesceForExit(request(main, { completeness: "strict", attempt: disposed ? 2 : 1 }));
				expect(refusal.status === "refused" && refusal.reason).toBe("completeness_unknown");
				if (refusal.status === "refused") {
					expect(refusal.snapshot.completenessReasons).toContain("extension_work_reporting_unknown:child-only");
					expect(refusal.snapshot.completenessReasons).not.toContain("extension_work_reporting_unknown:quiesce");
				}
			}
			expect(main.quiesceForExit(request(main, { attempt: 3 })).status).toBe("quiesced");
		} finally {
			await child.dispose();
		}
	});

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

	it("exposes extension quiescence only with an exit host and refuses the running handler's own exit", async () => {
		let context: ExtensionContext | undefined;
		const refusals: string[] = [];
		const s = await createSessionWithExtension(pi => {
			pi.on("session_start", (_event, ctx) => {
				context = ctx;
				if (!ctx.capabilities.includes("quiesce-exit/2")) return;
				const attested = ctx.attest("op-1", "extension");
				expect(attested.nonce).toBe("extension");
				const result = ctx.quiesceAndExit(request(s));
				refusals.push(result.status);
			});
		});
		const errors: unknown[] = [];
		const hooks = {
			reportSendError: (_action: string, error: Error) => {
				errors.push(error);
			},
			reportRuntimeError: (error: unknown) => {
				errors.push(error);
			},
		};
		await initializeExtensions(s, hooks);
		expect(context?.capabilities).toEqual([]);
		expect(() => context!.attest("op-1", "unavailable")).toThrow();
		const exited = Promise.withResolvers<number>();
		await initializeExtensions(s, { ...hooks, mode: "rpc", onQuiesced: exited.resolve });
		expect(errors).toEqual([]);
		expect(context?.capabilities).toEqual(["quiesce-exit/2", "owned-jobs/1"]);
		expect(refusals).toEqual(["refused"]);
		expect(s.isAdmissionClosed()).toBe(false);
		expect(context!.quiesceAndExit(request(s, { attempt: 2 })).status).toBe("quiesced");
		expect(await exited.promise).toBe(0);
	});

	it("invalidates an attestation when a host-dispatched handler starts and then settles", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const s = await createSessionWithExtension(pi => {
			pi.on("session_start", async () => {
				started.resolve();
				await release.promise;
			});
		});
		const oldRequest = request(s);
		const dispatched = s.extensionRunner!.emit({ type: "session_start" });
		try {
			await started.promise;
			expect(s.getWorkCounts().scheduledTurns).toBe(1);
		} finally {
			release.resolve();
			await dispatched;
		}
		expect(s.getWorkCounts().scheduledTurns).toBe(0);
		expect(s.quiesceForExit(oldRequest)).toMatchObject({ status: "refused", reason: "epoch_mismatch" });
		expect(s.quiesceForExit(request(s, { attempt: 2 }))).toMatchObject({ status: "quiesced" });
	});

	it.each(["scoped callback", "managed timer"] as const)(
		"counts a host %s until settlement and invalidates the old attestation",
		async kind => {
			const s = await createSessionWithExtension(() => {});
			const runner = s.extensionRunner!;
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const handler = () => {
				started.resolve();
				return release.promise;
			};
			const oldRequest = request(s);
			if (kind === "managed timer") vi.useFakeTimers();
			const dispatched =
				kind === "scoped callback" ? runner.runScoped(handler) : runner.createContext().setTimeout(handler, 0);
			try {
				if (kind === "managed timer") vi.advanceTimersByTime(0);
				await started.promise;
				expect(s.getWorkCounts().scheduledTurns).toBe(1);
				expect(s.quiesceForExit(request(s))).toMatchObject({ status: "refused", reason: "work_active" });
			} finally {
				release.resolve();
				await release.promise;
				if (dispatched instanceof Promise) await dispatched;
				if (kind === "managed timer") vi.useRealTimers();
			}
			expect(s.getWorkCounts().scheduledTurns).toBe(0);
			expect(s.quiesceForExit({ ...oldRequest, attempt: 2 })).toMatchObject({
				status: "refused",
				reason: "epoch_mismatch",
			});
			expect(s.quiesceForExit(request(s, { attempt: 3 }))).toMatchObject({ status: "quiesced" });
		},
	);

	it("keeps parked subagents parked after a passed quiesce", async () => {
		const s = createSession();
		const registry = AgentRegistry.global();
		const id = `Quiesce-${crypto.randomUUID()}`;
		const ref = registry.register({ id, displayName: "parked", kind: "sub", status: "parked", session: null });
		try {
			expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced" });
			await expect(AgentLifecycleManager.global().ensureLive(id)).rejects.toThrow("the session is exiting");
			expect(registry.get(id)).toMatchObject({ status: "parked", session: null });
		} finally {
			registry.unregister(id, ref);
		}
	});

	it.each([undefined, null, "", "unknown", 1])(
		"rejects completeness %j without consuming the attempt",
		completeness => {
			const s = createSession();
			const valid = request(s);
			const invalid = { ...valid, completeness } as unknown as QuiesceRequest;
			if (completeness === undefined) delete (invalid as Partial<QuiesceRequest>).completeness;
			expect(s.quiesceForExit(invalid)).toMatchObject({ status: "refused", reason: "invalid_request" });
			expect(s.isAdmissionClosed()).toBe(false);
			expect(s.quiesceForExit(valid)).toMatchObject({ status: "quiesced", attempt: valid.attempt });
		},
	);

	it("refuses incomplete registry coverage only for strict retirement and memoizes the refusal", () => {
		const s = createSession();
		const registry = s.ownedJobRegistry!;
		registry.beginPtyRun({ command: "finished PTY", cwd: tempDir.path() })();
		const strict = request(s, { completeness: "strict" });
		const result = s.quiesceForExit(strict);
		expect(result).toMatchObject({
			status: "refused",
			reason: "completeness_unknown",
			snapshot: { registry: { path: registry.path, complete: false } },
		});
		expect(s.isAdmissionClosed()).toBe(false);
		expect(fs.existsSync(terminalAttestationPath(s.sessionFile!))).toBe(false);
		expect(s.quiesceForExit({ ...strict, completeness: "attested" })).toBe(result);
		expect(s.quiesceForExit(request(s, { attempt: 2 }))).toMatchObject({
			status: "quiesced",
			attestation: { registryComplete: false },
		});
	});

	it("rechecks the strict epoch when a scan discovers a process that has already exited", () => {
		const s = createSession();
		const strict = request(s, { completeness: "strict" });
		const registry = s.ownedJobRegistry!;
		const scan = { supported: true, sound: true, scanned: 1, discovered: 1, opaque: [] };
		vi.spyOn(registry, "scanAndCount").mockImplementationOnce(() => {
			// Model the race deterministically, using real registration to advance the epoch.
			const id = registry.registerProcess({
				kind: "process",
				pid: process.pid,
				startId: "test-exited-process",
				command: "discovered process",
				discovered: true,
			})!;
			registry.end(id, "settled");
			return { scan, live: 0 };
		});
		const result = s.quiesceForExit(strict);
		expect(result).toMatchObject({ status: "refused", reason: "epoch_mismatch" });
		if (result.status !== "refused") throw new Error("expected refusal");
		expect(hasOutstandingWork(result.snapshot.counts)).toBe(false);
		expect(result.snapshot.epoch).toBeGreaterThan(strict.epoch);
		expect(result.snapshot.registry).toBeUndefined();
		expect(s.isAdmissionClosed()).toBe(false);
	});

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

	it("keeps parked agents parked from the pass until dispose ends, and lifts that even when dispose throws", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		try {
			AgentRegistry.global().register({
				id: "0-Parked",
				displayName: "task",
				kind: "sub",
				session: null,
				status: "parked",
			});
			AgentLifecycleManager.global().adopt("0-Parked", {
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("reviver ran");
				},
			});
			const s = createSession();
			expect(s.quiesceForExit(request(s)).status).toBe("quiesced");
			await expect(AgentLifecycleManager.global().ensureLive("0-Parked")).rejects.toThrow(
				/cannot be revived: the session is exiting/,
			);

			vi.spyOn(s.sessionManager, "close").mockRejectedValue(new Error("disk failed"));
			session = undefined;
			await expect(s.dispose()).rejects.toThrow("disk failed");
			// The refusal is process-wide: a failed teardown must not leave every parked agent of a
			// host that keeps running unrevivable.
			await expect(AgentLifecycleManager.global().ensureLive("0-Parked")).rejects.toThrow("reviver ran");
		} finally {
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
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

	it.each([false, true])("recovers a real exit append failure on sealed retry (repeat failure: %s)", async repeatFailure => {
		const s = createSession({ ...sessionParts(), census: { complete: true, work: [], reasons: [] } });
		vi.spyOn(s.ownedJobRegistry!, "scanAndCount").mockReturnValue({
			scan: { supported: true, sound: true, scanned: 1, discovered: 0, opaque: [] },
			live: 0,
		});
		await s.prompt("materialize the transcript");
		const req = request(s, { completeness: "strict" });
		const write = fs.writeSync;
		const failure = new Error("transient ENOSPC");
		const writer = vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
			if (String(args[1]).includes('"session_exit"')) throw failure;
			return Reflect.apply(write, fs, args);
		});
		const blocked = s.quiesceForExit(req);
		expect(blocked).toMatchObject({ status: "sealed_blocked", progress: { finalized: false } });
		expect(() => s.sessionManager.flushSync()).toThrow(failure);
		writer.mockRestore();
		let attempt = 2;
		if (repeatFailure) {
			const rename = fs.renameSync;
			const publish = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
				if (to === s.sessionFile) throw new Error("storage still unavailable");
				return rename(from, to);
			});
			expect(s.quiesceForExit({ ...req, attempt })).toMatchObject({
				status: "sealed_blocked", progress: { finalized: false },
			});
			expect(() => s.sessionManager.flushSync()).toThrow(failure);
			publish.mockRestore();
			attempt++;
		}
		expect(s.attest("sealed", "nonce")).toMatchObject({ admission: "closed", sealed: true, epoch: req.epoch });
		s.sessionManager.appendCustomEntry("must_not_append", {});
		const passed = s.quiesceForExit({ ...req, attempt });
		expect(passed.status).toBe("quiesced");
		expect(() => s.sessionManager.flushSync()).not.toThrow();
		const entries = fs.readFileSync(s.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(entries.filter(entry => entry.customType === "session_exit")).toHaveLength(1);
		expect(entries.filter(entry => entry.customType === "must_not_append")).toEqual([]);
		expect(readAttestation(s)).toMatchObject({ kind: "quiesce", attempt });
		expect(s.attest("still-sealed", "nonce")).toMatchObject({ admission: "closed", sealed: true });
	});

	it.each(["finalize", "bind", "counts", "evaluation_throw", "work", "unknown", "publish", "published_then_throw"])(
		"retains a sealed strict session after %s failure and retires on a newer attempt",
		async failure => {
			const census: CensusResult = { complete: true, work: [], reasons: [] };
			const s = createSession({ ...sessionParts(), census });
			vi.spyOn(s.ownedJobRegistry!, "scanAndCount").mockReturnValue({
				scan: { supported: true, sound: true, scanned: 1, discovered: 0, opaque: [] },
				live: 0,
			});
			await s.prompt("materialize the transcript");
			const req = request(s, { completeness: "strict" });
			const finalize = s.sessionManager.finalizeForExit.bind(s.sessionManager);
			const target = terminalAttestationPath(s.sessionFile!);
			const bind = s.ownedJobRegistry!.ensureHeader.bind(s.ownedJobRegistry);
			let finalizing = false;
			let broken = true;
			s.registerWorkSource({
				kind: "scheduledTurns",
				strictOnly: true,
				count: () => {
					if (broken && finalizing && failure === "evaluation_throw") throw new Error("count failed");
					return broken && finalizing && failure === "counts" ? 1 : 0;
				},
			});
			vi.spyOn(s.ownedJobRegistry!, "ensureHeader").mockImplementation(() => {
				if (broken && finalizing && failure === "bind") throw new Error("bind failed");
				return bind();
			});
			vi.spyOn(s.sessionManager, "finalizeForExit").mockImplementation(() => {
				finalizing = true;
				if (broken && failure === "finalize") throw new Error("finalize failed");
				const digest = finalize();
				if (broken && failure === "work") census.work = [{ pid: 999, comm: "late", ppid: 0 }];
				if (broken && failure === "unknown") {
					census.complete = false;
					census.reasons = ["late_unknown"];
				}
				if (broken && failure === "publish") fs.mkdirSync(path.join(target, "occupied"), { recursive: true });
				return digest;
			});
			const rename = fs.renameSync;
			vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
				rename(from, to);
				if (broken && failure === "published_then_throw" && to === target) {
					broken = false;
					throw new Error("publication bookkeeping failed");
				}
			});
			const result = s.quiesceForExit(req);
			expect(result.status).toBe("sealed_blocked");
			expect(quiesceEndsProcess(result)).toBe(false);
			expect(s.isSealedBlocked).toBe(true);
			if (result.status !== "sealed_blocked") throw new Error("expected sealed block");
			expect(result.progress).toEqual({
				finalized: failure !== "finalize",
				bound: failure !== "finalize" && failure !== "bind",
				attested: false,
			});
			expect(s.quiesceForExit({ ...req, operationId: "late", deadline: 0 })).toMatchObject({
				reason: "deadline_expired",
			});
			expect(s.quiesceForExit({ ...req, operationId: "epoch", epoch: req.epoch + 1 })).toMatchObject({
				reason: "epoch_mismatch",
			});
			expect(s.quiesceForExit({ ...req, instanceId: "foreign" })).toMatchObject({ reason: "invocation_mismatch" });
			expect(s.quiesceForExit({ ...req, sessionId: "foreign" })).toMatchObject({ reason: "session_mismatch" });
			expect(s.attest("read", "n")).toMatchObject({ admission: "closed", sealed: true, epoch: req.epoch });
			expect(s.quiesceForExit(req)).toBe(result);
			expect(s.quiesceForExit({ ...req, attempt: 0 })).toMatchObject({ reason: "stale_attempt" });
			expect(s.quiesceForExit({ ...req, operationId: "attested", completeness: "attested" })).toMatchObject({
				reason: "admission_closed",
			});
			if (failure !== "publish") expect(readAttestation(s).kind).toBe("sealed_blocked");
			const sealedBytes = fs.readFileSync(s.sessionFile!, "utf8");
			s.sessionManager.appendCustomEntry("must_not_append", {});
			expect(fs.readFileSync(s.sessionFile!, "utf8")).toBe(sealedBytes);
			broken = false;
			census.complete = true;
			census.work = [];
			census.reasons = [];
			if (failure === "publish") fs.rmSync(target, { recursive: true });
			const passed = s.quiesceForExit({ ...req, attempt: 2 });
			expect(passed.status).toBe("quiesced");
			expect(quiesceEndsProcess(passed)).toBe(true);
			expect(readAttestation(s)).toMatchObject({ kind: "quiesce", attempt: 2 });
			expect(fs.readFileSync(s.sessionFile!, "utf8")).toBe(sealedBytes);
		},
	);

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

	/** An external-delivery record (`external-delivery/1`) with its required provider projection. */
	function deliveryCard(text: string): CustomMessagePayload {
		return {
			customType: "external-card",
			content: `[card ${text}]`,
			display: true,
			details: { "omp.llm": { role: "user", content: [{ type: "text", text }] }, "omp.llm.source": `src-${text}` },
		};
	}

	/** Deliver an aside the session holds without waking (plan mode, no `wakeInPlanMode`). */
	function holdDelivery(s: AgentSession, text: string): DeliveryHandle {
		s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const held = s.deliverExternalMessage(deliveryCard(text), { mode: "aside" });
		expect(held.state()).toBe("queued");
		return held;
	}

	it("refuses while an external delivery is held, and passes once it is cancelled", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const held = holdDelivery(s, "held");
		expect(s.getWorkCounts().queuedInput).toBeGreaterThan(0);
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "refused", reason: "work_active" });
		expect(held.cancel()).toBe(true);
		expect(s.quiesceForExit(request(s, { attempt: 2 }))).toMatchObject({ status: "quiesced" });
		expect(mock.calls.length).toBe(1);
	});

	it("refuses a quiesce built before a delivery was admitted, even once it is gone again", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		// Held, so the delivery neither starts a turn nor leaves anything counted once cancelled.
		s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const req = request(s);
		const held = s.deliverExternalMessage(deliveryCard("brief"), { mode: "aside" });
		expect(held.cancel()).toBe(true);
		expect(s.getWorkCounts().queuedInput).toBe(0);
		expect(s.quiesceForExit(req)).toMatchObject({ status: "refused", reason: "epoch_mismatch" });
	});

	it("never accepts an external delivery after a pass: the handle is already discarded", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		expect(s.quiesceForExit(request(s))).toMatchObject({ status: "quiesced" });
		const epoch = s.activityEpoch;
		const late = s.deliverExternalMessage(deliveryCard("late"), { mode: "steer" });
		expect(late.state()).toBe("discarded");
		expect(await late.discarded).toEqual({ reason: "admission_closed" });
		expect(late.cancel()).toBe(false);
		expect(s.listExternalDeliveries()).toEqual([]);
		expect(s.activityEpoch).toBe(epoch);
		await s.waitForIdle();
		expect(mock.calls.length).toBe(1);
	});

	it("records a hang-up with a held external delivery as interrupted", async () => {
		const s = createSession();
		await s.prompt("materialize the transcript");
		const held = holdDelivery(s, "held");
		await s.dispose({ reason: postmortem.Reason.SIGHUP });
		session = undefined;
		const onDisk = readAttestation(s);
		expect(onDisk).toMatchObject({ kind: "hangup", signal: "sighup", interrupted: true });
		expect(onDisk.counts.queuedInput).toBeGreaterThan(0);
		expect(await held.discarded).toEqual({ reason: "disposed" });
	});

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
				'if (manager.getSessionFile() !== process.argv[2]) throw new Error("fixture did not acquire the original session");',
				'process.stdout.write("owned\\n");',
				"for await (const _line of console) {}",
				"await manager.close();",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, sessionFile], {
			env: { ...process.env },
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
		await s.sessionManager.flush();
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
			completeness: "attested",
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
		// The reviewer itself reports nothing queued or running: only the parked boundary is work,
		// and it is counted as streaming because the wait runs inside the agent loop's turn end.
		const pendingWork = Object.getOwnPropertyDescriptor(AdvisorRuntime.prototype, "pendingWork");
		if (!pendingWork) throw new Error("expected AdvisorRuntime.pendingWork");
		Object.defineProperty(AdvisorRuntime.prototype, "pendingWork", { configurable: true, get: () => 0 });
		try {
			const s = createAdvisedSession({ "advisor.syncBacklog": "strict" });
			const run = s.prompt("hello");
			await entered.promise;
			expect(s.getWorkCounts().streaming).toBe(1);
			expect(s.quiesceForExit(request(s))).toMatchObject({ status: "refused", reason: "work_active" });
			release.resolve();
			await run;
			await s.waitForIdle();
			expect(s.getWorkCounts()).toMatchObject({ streaming: 0, scheduledTurns: 0 });
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
