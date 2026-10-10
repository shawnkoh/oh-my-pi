import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalContinuationModes } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { QuiesceRequest } from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

// The RPC goal controller on the session's quiesce seam: a decided continuation is
// session work until submitted or dropped, and none is scheduled once admission closes.
describe("RPC goal continuation and quiesce", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
	});

	function request(s: AgentSession, attempt: number): QuiesceRequest {
		const attested = s.attest(`op-${attempt}`, "nonce");
		return {
			operationId: `op-${attempt}`,
			completeness: "attested",
			attempt: 1,
			epoch: attested.epoch,
			instanceId: attested.instanceId,
			sessionId: attested.session.id,
			deadline: Date.now() + 60_000,
		};
	}

	async function start(): Promise<{ s: AgentSession; controller: RpcGoalController }> {
		tempDir = TempDir.createSync("@omp-goal-quiesce-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		// Isolated, never the process-global instance: Settings.init returns an existing global
		// (possibly persisting) instance, so writing through it could reach the real config.yml.
		const settings = Settings.isolated({ [cfgAsyncEnabled.id]: false, [cfgGoalContinuationModes.id]: ["rpc"] });
		({ session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		}));
		const s = session;
		const mock = createMockModel({ handler: () => ({ content: ["working"], delayMs: 10_000 }) });
		s.agent.streamFn = mock.stream;
		const controller = new RpcGoalController(s);
		s.subscribe(event => controller.observe(event));
		return { s, controller };
	}

	it("a decided continuation is work that refuses quiesce until it is dropped", async () => {
		const { s, controller } = await start();
		const epoch = s.activityEpoch;
		await controller.handle({ op: "create", objective: "keep going" });
		expect(controller.continuationPending).toBe(true);
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(1);
		expect(s.activityEpoch).toBeGreaterThan(epoch);
		expect(s.quiesceForExit(request(s, 1))).toMatchObject({ status: "refused", reason: "work_active" });
		controller.stopForHostAbort();
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
	});

	it("the reservation is released when the continuation is submitted", async () => {
		const { s, controller } = await start();
		let started = false;
		s.subscribe(event => {
			if (event.type === "agent_start") started = true;
		});
		await controller.handle({ op: "create", objective: "keep going" });
		for (let i = 0; i < 100 && !started; i++) await Bun.sleep(10);
		expect(started).toBe(true);
		// The submitted turn is streaming work now; the reservation no longer counts.
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
		await s.abort();
	});

	it("once admission is closed no continuation is scheduled", async () => {
		const { s, controller } = await start();
		const result = s.quiesceForExit(request(s, 1));
		expect(result.status).not.toBe("refused");
		expect(s.isAdmissionClosed()).toBe(true);
		await controller.handle({ op: "create", objective: "after the pass" }).catch(() => undefined);
		expect(controller.continuationPending).toBe(false);
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
	});
});
