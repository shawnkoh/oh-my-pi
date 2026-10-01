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
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("RPC goal controller on the quiesce seam", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
	});

	it("counts a scheduled continuation as work and refuses quiesce until it is submitted or dropped", async () => {
		tempDir = TempDir.createSync("@omp-goal-seam-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = await Settings.init({ inMemory: true, cwd });
		cfgAsyncEnabled.set(settings, false);
		cfgGoalContinuationModes.set(settings, ["rpc"]);
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
		const mock = createMockModel({
			handler: () => ({
				content: [{ type: "toolCall", id: `t${Date.now()}`, name: "goal", arguments: { op: "get" } }],
			}),
		});
		s.agent.streamFn = mock.stream;
		const controller = new RpcGoalController(s);
		s.subscribe(event => controller.observe(event));

		const epoch = s.activityEpoch;
		await controller.handle({ op: "create", objective: "keep going" });
		// Decided (create on an idle session) but not yet submitted: pending work, epoch moved.
		expect(controller.continuationPending).toBe(true);
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(1);
		expect(s.activityEpoch).toBeGreaterThan(epoch);
		const attested = s.attest("op", "nonce");
		expect(
			s.quiesceForExit({
				operationId: "op",
				attempt: 1,
				epoch: attested.epoch,
				instanceId: attested.instanceId,
				sessionId: attested.session.id,
				deadline: Date.now() + 60_000,
			}),
		).toMatchObject({ status: "refused", reason: "work_active" });

		// Host abort drops the pending continuation and releases its reservation.
		controller.stopForHostAbort();
		expect(controller.continuationPending).toBe(false);
		expect(s.getWorkCounts().goalContinuationScheduled).toBe(0);
	});
});
