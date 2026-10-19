import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { requestSessionYield } from "@oh-my-pi/pi-coding-agent/session/session-yield";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

// The requester is a different process, with the same isolated OMP run directory.
if (process.argv[2] === "request") {
	process.exit(await requestSessionYield(process.argv[3]!, Number(process.argv[4])));
}

await Settings.init({ inMemory: true, cwd: process.cwd() });
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "fixture-only-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const mock = createMockModel({
	handler: async context => {
		if (JSON.stringify(context.messages.at(-1)).includes("hold")) {
			while (!fs.existsSync(path.join(process.cwd(), "release"))) await Bun.sleep(10);
		}
		return { content: ["done"] };
	},
});
const agent = new Agent({
	getApiKey: () => "fixture-only-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const sessionManager = SessionManager.create(process.cwd(), path.join(process.cwd(), "sessions"));
if (process.env.YIELD_FIXTURE_LAZY !== "1") {
	sessionManager.appendMessage({ role: "user", content: "fixture session", timestamp: Date.now() });
	// User-only appends intentionally remain lazy; force the real write that acquires the OS lease.
	await sessionManager.ensureOnDisk();
}
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
if (process.env.YIELD_FIXTURE_MODE !== "tui") {
	await runRpcMode(session, {
		setToolUIContext: ui => {
			const dialog = process.env.YIELD_FIXTURE_DIALOG;
			if (dialog === "approval") void ui.confirm("Fixture approval", "Continue?");
			if (dialog === "ask") {
				void (async () => {
					// Real clients must negotiate ask support before the host exposes this dialog.
					while (!ui.askDialog) await Bun.sleep(10);
					await ui.askDialog([{ id: "choice", question: "Choose", options: [{ label: "Yes" }, { label: "No" }] }]);
				})();
			}
		},
	});
} else {
	initTheme();
	const terminal = process.env.YIELD_FIXTURE_REAL_TTY === "1" ? undefined : new VirtualTerminal(120, 32);
	const composer = new Composer({ terminal: terminal ?? new ProcessTerminal() });
	const mode = new InteractiveMode(session, "fixture", undefined, () => {}, undefined, undefined, undefined, composer);
	await mode.init({ suppressWelcomeIntro: true });
	const pendingInput = mode.getUserInput();
	if (process.env.YIELD_FIXTURE_DRAFT) {
		if (terminal) terminal.sendInput(process.env.YIELD_FIXTURE_DRAFT);
		else mode.editor.setText(process.env.YIELD_FIXTURE_DRAFT);
	}
	await terminal?.waitForRender();
	const ready = {
		type: "fixture_ready",
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		artifactsDir: sessionManager.getArtifactsDir(),
	};
	fs.writeFileSync(path.join(process.cwd(), "holder.json"), JSON.stringify(ready));
	process.stdout.write(`${JSON.stringify(ready)}\n`);
	if (!terminal) {
		// The production terminal owns raw stdin; parent qualification types directly into the PTY.
		await pendingInput;
		await mode.shutdown();
		process.exit(0);
	}
	// Parent qualification may type through the actual composer: one JSON {text:"..."} per line.
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line) {
				const command: unknown = JSON.parse(line);
				if (command && typeof command === "object" && "text" in command && typeof command.text === "string") {
					terminal.sendInput(command.text);
				}
			}
			newline = buffer.indexOf("\n");
		}
	}
	await mode.shutdown();
}
