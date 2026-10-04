import * as fs from "node:fs";
import * as path from "node:path";
import { spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcLiveSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import * as predictClient from "@oh-my-pi/pi-coding-agent/predict/client";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch, session and on-disk session files; only the model is scripted.
// A prompt containing "hold" blocks in the provider until the process is signalled.
// `QUIESCE_FIXTURE_INPUT_HOOK=1`: an RPC input hook that holds text containing "gate-wait"
// until a `gate-release` file appears in the working directory, so that input stays in the
// ordered input gate.
// `QUIESCE_FIXTURE_PREDICT=1`: word prediction is on and its engine answers only once input
// admission has closed, so a `predict_word` can be in flight across a quiesce. A request made
// connection-only answers no suggestion, as with no daemon connection open.
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
const sessionManager = SessionManager.create(process.cwd(), path.join(process.cwd(), "sessions"));
let extensionRunner: ExtensionRunner | undefined;
if (process.env.QUIESCE_FIXTURE_INPUT_HOOK === "1") {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("input", async event => {
				const release = path.join(process.cwd(), "gate-release");
				if (event.text.includes("gate-wait")) while (!fs.existsSync(release)) await Bun.sleep(10);
				return undefined;
			});
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"gate-wait-input-hook",
	);
	extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
}
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({
		"compaction.enabled": false,
		...(process.env.QUIESCE_FIXTURE_PREDICT === "1" ? { "spelling.autocomplete": "ngram" } : {}),
	}),
	modelRegistry,
	ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
	agentId: "Main",
	extensionRunner,
});
if (process.env.QUIESCE_FIXTURE_PREDICT === "1") {
	spyOn(predictClient, "requestTextPrediction").mockImplementation(async (_method, _before, _prefix, options) => {
		if (options?.connectedOnly) return { engine: "ngram", suggestion: null };
		while (!session.isAdmissionClosed()) await Bun.sleep(10);
		return { engine: "ngram", suggestion: { suffix: "er", confidence: 1 } };
	});
}
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
