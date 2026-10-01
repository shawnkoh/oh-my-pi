import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Real SDK session, RPC dispatch and external delivery; only the model is
// scripted. Every reply names the newest input it answers ("answer-to:<text>"),
// and a reply to text starting with "slow" takes 1.5 s, so deliveries and
// extension command work can land while it streams.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
cfgAsyncEnabled.set(settings, false);
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
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
	extensions: [
		pi => {
			// Sleeps, then schedules agent work: a wake in between must not be credited to it.
			pi.registerCommand("slowsend", {
				description: "wait 1.5 s, then send a user message",
				handler: async () => {
					await Bun.sleep(1_500);
					pi.sendUserMessage("from-command");
				},
			});
			// Sends into a live run, then keeps working past its yield: that send joins the live run.
			pi.registerCommand("sendlive", {
				description: "wait for a run, send into it, then wait for it to end",
				handler: async (_args, ctx) => {
					while (ctx.isIdle()) await Bun.sleep(20);
					pi.sendUserMessage("mid", { deliverAs: "steer" });
					while (!ctx.isIdle()) await Bun.sleep(20);
					await Bun.sleep(100);
				},
			});
			// Sleeps, starts a new session, then sends: a host prompt accepted meanwhile is detached by the change.
			pi.registerCommand("delayed-new", {
				description: "wait, start a new session, then send a user message",
				handler: async (_args, ctx) => {
					await Bun.sleep(300);
					await ctx.newSession();
					pi.sendUserMessage("after-delayed-new");
				},
			});
			// Same, but starts a new session first: the wake before it must not pre-abort the command.
			pi.registerCommand("slownew", {
				description: "wait 1.5 s, start a new session, then send a user message",
				handler: async (_args, ctx) => {
					await Bun.sleep(1_500);
					await ctx.newSession();
					pi.sendUserMessage("after-new");
				},
			});
		},
	],
});
// Context reminders may precede the text; the reply names only the input's final line.
function lastInput(messages: readonly { role: string; content: unknown }[]): string {
	const last = [...messages].reverse().find(message => message.role === "user");
	if (!last) return "";
	const content = last.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
						.join("")
				: "";
	return text.split("</system-reminder>").at(-1)?.trim() ?? "";
}
const mock = createMockModel({
	handler: context => {
		const input = lastInput(context.messages);
		return { content: [`answer-to:${input}`], delayMs: input.startsWith("slow") ? 1_500 : 0 };
	},
});
session.agent.streamFn = mock.stream;
await runRpcMode(session);
