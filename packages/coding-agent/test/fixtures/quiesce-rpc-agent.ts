import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcLiveSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem } from "@oh-my-pi/pi-utils";

// Real RPC dispatch, session and on-disk session files; only the model is scripted.
// A prompt containing "hold" blocks in the provider until the process is signalled.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const never = Promise.withResolvers<void>();
const mock = createMockModel({
	handler: async context => {
		const last = JSON.stringify(context.messages.at(-1) ?? "");
		if (last.includes("hold")) await never.promise;
		return { content: ["done"] };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(process.cwd(), path.join(process.cwd(), "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
	agentId: "Main",
});
// `QUIESCE_FIXTURE_PENDING=1`: one unit of queued input that a cleanup registered after the
// session tears down, like the MCP notification debounce timers do.
if (process.env.QUIESCE_FIXTURE_PENDING === "1") {
	let pending = 1;
	session.registerWorkSource({ kind: "queuedInput", count: () => pending });
	postmortem.register("fixture-pending-cleanup", () => {
		pending = 0;
	});
}
// Files release the provider-independent live controller at exact lifecycle boundaries.
const createLiveSession: RpcLiveSessionFactory = ({ callbacks }) => {
	let muted = false;
	const waitFor = (name: string) =>
		new Promise<void>(resolve => {
			const file = path.join(process.cwd(), name);
			const watcher = fs.watch(process.cwd(), () => {
				if (fs.existsSync(file)) {
					watcher.close();
					resolve();
				}
			});
			if (fs.existsSync(file)) {
				watcher.close();
				resolve();
			}
		});
	return {
		get muted() {
			return muted;
		},
		toggleMute() {
			muted = !muted;
		},
		async start() {
			callbacks.onPhase("connecting");
			await waitFor("live-start-release");
			callbacks.onPhase("listening");
		},
		async stop() {
			process.stdout.write('{"type":"fixture_live_closing"}\n');
			await waitFor("live-stop-release");
			callbacks.onTerminal();
		},
	};
};
// `QUIESCE_FIXTURE_MODE=rpc-ui` wires the tool UI context exactly as `--mode rpc-ui` does.
await runRpcMode(session, {
	...(process.env.QUIESCE_FIXTURE_MODE === "rpc-ui" ? { setToolUIContext: () => {} } : {}),
	createLiveSession,
});
