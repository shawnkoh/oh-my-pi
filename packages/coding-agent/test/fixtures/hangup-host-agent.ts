import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { postmortem } from "@oh-my-pi/pi-utils";

// A host with its own signal teardown, as interactive and ACP modes have: on SIGHUP it disposes
// the session, whose extension `session_shutdown` handler appends an entry. `HANGUP_HOST_ORDER`
// is `after` (the host registers its cleanup after the session, like interactive mode) or
// `before` (like ACP mode, whose later sessions register after the host).
const host: { session?: AgentSession } = {};
const teardown = createSessionTeardown({
	getDraftText: () => "",
	beginDispose: reason => host.session?.beginDispose(reason),
	saveDraft: async text => {
		await host.session?.sessionManager.saveDraft(text);
	},
	disposeSession: async reason => host.session?.dispose({ reason }),
});
const registerHost = () => postmortem.register("session-teardown", reason => teardown(reason));
if (process.env.HANGUP_HOST_ORDER === "before") registerHost();

const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("session_shutdown", () => {
			pi.appendEntry("shutdown-state", { saved: true });
		});
	},
	cwd,
	new EventBus(),
	runtime,
	"hangup-host",
);
const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	}),
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
	agentId: "Main",
	extensionRunner: new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry),
});
host.session = session;
await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
if (process.env.HANGUP_HOST_ORDER !== "before") registerHost();
await session.prompt("materialize the transcript");
console.log(JSON.stringify({ sessionFile: session.sessionFile }));
setInterval(() => {}, 1 << 30);
