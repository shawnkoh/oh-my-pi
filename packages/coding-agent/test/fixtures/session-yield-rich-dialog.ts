import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { requestSessionYield } from "@oh-my-pi/pi-coding-agent/session/session-yield";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

if (process.argv[2] === "request") {
	process.exit(await requestSessionYield(process.argv[3]!, Number(process.argv[4])));
}

await Settings.init({ inMemory: true, cwd: process.cwd() });
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.create(process.cwd(), path.join(process.cwd(), "sessions"));
sessionManager.appendMessage({ role: "user", content: "standalone dialogs", timestamp: Date.now() });
await sessionManager.ensureOnDisk();
const session = new AgentSession({
	agent: new Agent({
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	}),
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
initTheme();
const terminal = new VirtualTerminal(120, 32);
const mode = new InteractiveMode(
	session,
	"rich-dialog-fixture",
	undefined,
	() => {},
	undefined,
	undefined,
	undefined,
	new Composer({ terminal }),
);
await mode.init({ suppressWelcomeIntro: true });
void mode.getUserInput();
const ui = mode.getToolUIContext();
if (!ui?.askDialog || !ui.approve) throw new Error("Rich TUI dialog primitives unavailable");
const controllers = new Map<string, AbortController>();
const emit = (frame: object): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const snapshot = () => ({
	work: session.getWorkCounts(),
	streaming: session.isStreaming,
	focus: mode.ui.getFocused()?.constructor.name,
});
await terminal.waitForRender();
emit({ type: "ready", sessionId: session.sessionId, ...snapshot() });
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		const command: unknown = JSON.parse(line);
		if (!isRecord(command)) throw new Error("Expected command");
		if (command.type === "open") {
			const id = String(command.dialogId);
			const controller = new AbortController();
			controllers.set(id, controller);
			const options = { signal: controller.signal };
			const pending =
				command.kind === "ask"
					? ui.askDialog!(
							[{ id, question: `Choose ${id}`, options: [{ label: "Yes" }, { label: "No" }] }],
							options,
						)
					: ui.approve!({ compact: `Approve ${id}?`, full: `Approval for ${id}` }, options);
			void pending.then(value => {
				controllers.delete(id);
				emit({ type: "settled", dialogId: id, value: value ?? null, ...snapshot() });
			});
		} else if (command.type === "abort") {
			controllers.get(String(command.dialogId))?.abort();
		} else if (command.type === "key" && typeof command.text === "string") {
			terminal.sendInput(command.text);
		}
		await terminal.waitForRender();
		emit({ type: "response", id: command.id, ...snapshot() });
		newline = buffer.indexOf("\n");
	}
}
await mode.shutdown();
