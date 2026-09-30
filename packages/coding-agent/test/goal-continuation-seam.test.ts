import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { isAdmissionGatedRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { type AgentSession, AgentSession as Session } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { QuiesceResult } from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * A host goal controller that follows the session seam contract: reserve at the terminal
 * `agent_end` (synchronously, inside the event), then in the next macrotask release the
 * reservation and submit the hidden continuation in the same synchronous step.
 */
class StubGoalController {
	refused = 0;
	submitted = 0;
	readonly #session: AgentSession;
	#remaining: number;

	constructor(session: AgentSession, continuations: number) {
		this.#session = session;
		this.#remaining = continuations;
		session.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal === false || this.#remaining === 0) return;
			const reservation = session.reserveGoalContinuation();
			if (!reservation) {
				this.refused++;
				return;
			}
			this.#remaining--;
			setImmediate(() => {
				reservation.release();
				this.submitted++;
				void this.#session
					.promptCustomMessage({ customType: "goal-continuation", content: "continue", display: false })
					.catch(() => undefined);
			});
		});
	}
}

describe("goal continuation reservation seam", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let mock: MockModel;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-goal-seam-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(bashExecutor, "retainedShellWorkCount").mockReturnValue(0);
	});

	afterEach(async () => {
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
		mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new Session({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
			agentId: "Main",
		});
		return session;
	}

	it("never lets a quiesce pass between the terminal agent_end and the continuation submission", async () => {
		const s = createSession();
		const controller = new StubGoalController(s, 1);
		let inWindow: { scheduled: number; quiesce: QuiesceResult } | undefined;
		const continuationEnded = Promise.withResolvers<void>();
		let terminalEnds = 0;
		s.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal === false) return;
			terminalEnds++;
			// Registered after the controller: runs right after it reserved, inside the same event.
			if (terminalEnds === 1) {
				inWindow = {
					scheduled: s.getWorkCounts().goalContinuationScheduled,
					quiesce: s.quiesceForExit({
						operationId: "op",
						attempt: 1,
						epoch: s.activityEpoch,
						deadline: Date.now() + 60_000,
					}),
				};
			} else {
				continuationEnded.resolve();
			}
		});

		await s.prompt("start the goal");
		await continuationEnded.promise;
		expect(mock.calls.length).toBe(2);

		expect(inWindow?.scheduled).toBe(1);
		expect(inWindow?.quiesce).toMatchObject({ status: "refused", reason: "work_active" });
		expect(controller.submitted).toBe(1);
		expect(s.isAdmissionClosed()).toBe(false);
		// Released at submission: nothing is left pending once the continuation turn ended.
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
	});

	it("refuses a reservation once admission is closed, so no continuation is scheduled", async () => {
		const s = createSession();
		const epoch = s.activityEpoch;
		const reservation = s.reserveGoalContinuation();
		expect(s.activityEpoch).toBeGreaterThan(epoch);
		expect(
			s.quiesceForExit({ operationId: "op", attempt: 1, epoch: s.activityEpoch, deadline: Date.now() + 60_000 }),
		).toMatchObject({ status: "refused", reason: "work_active" });

		// A dropped continuation releases its reservation; releasing twice changes nothing.
		reservation?.release();
		reservation?.release();
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
		expect(
			s.quiesceForExit({ operationId: "op", attempt: 2, epoch: s.activityEpoch, deadline: Date.now() + 60_000 }),
		).toMatchObject({ status: "quiesced" });
		expect(s.reserveGoalContinuation()).toBeUndefined();
	});

	it("gates RPC goal ops that can start a continuation turn, but not reads", () => {
		expect(isAdmissionGatedRpcCommand({ type: "goal", op: "create" })).toBe(true);
		expect(isAdmissionGatedRpcCommand({ type: "goal", op: "resume" })).toBe(true);
		expect(isAdmissionGatedRpcCommand({ type: "goal", op: "get" })).toBe(false);
		expect(isAdmissionGatedRpcCommand({ type: "goal", op: "pause" })).toBe(false);
		expect(isAdmissionGatedRpcCommand({ type: "deliver" })).toBe(true);
		expect(isAdmissionGatedRpcCommand({ type: "get_state" })).toBe(false);
	});
});
