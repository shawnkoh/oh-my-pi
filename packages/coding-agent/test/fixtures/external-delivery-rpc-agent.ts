import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch and session; the model echoes the provider view so a test
// can prove what reached it. A prompt that starts with "/" is answered too, so
// slash interpretation (or its absence) is observable.
// DELIVERY_FIXTURE_INPUT_HOOK_MS: an RPC input hook that takes that long (async).
// DELIVERY_FIXTURE_MODEL_DELAY_MS: each model reply takes that long.
const hookMs = Number(process.env.DELIVERY_FIXTURE_INPUT_HOOK_MS ?? 0);
const modelDelayMs = Number(process.env.DELIVERY_FIXTURE_MODEL_DELAY_MS ?? 0);
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.inMemory(process.cwd());
let extensionRunner: ExtensionRunner | undefined;
if (hookMs > 0) {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("input", async () => {
				await Bun.sleep(hookMs);
				return undefined;
			});
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"slow-input-hook",
	);
	extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
}
const mock = createMockModel({
	handler: context => {
		const userTexts = context.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.map(part => (part.type === "text" ? part.text : "")).join(""),
			);
		return { content: [`seen:${JSON.stringify(userTexts)}`], delayMs: modelDelayMs };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	convertToLlm,
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
	modelRegistry,
	extensionRunner,
});
await runRpcMode(session);
