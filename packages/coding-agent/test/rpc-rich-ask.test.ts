import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type PendingExtensionRequest, requestRpcAskDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const questions = [
	{
		id: "stack",
		question: "Which parts?",
		options: [
			{ label: "API", preview: "```go\nfunc main() {}\n```" },
			{ label: "UI", description: "SwiftUI" },
			{ label: "DB" },
		],
		multi: true,
		recommended: 1,
	},
	{ id: "go", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] },
];

const PNG = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

describe("rich ask reply validation", () => {
	const ask = async (answers: Record<string, unknown>, options: { rich?: boolean; acceptImages?: boolean } = {}) => {
		const pending = new Map<string, PendingExtensionRequest>();
		const frames: Array<Record<string, unknown>> = [];
		const result = requestRpcAskDialog(
			pending,
			frame => frames.push(frame as Record<string, unknown>),
			questions,
			{ acceptImages: options.acceptImages },
			options.rich,
		);
		const id = frames[0]?.id as string;
		pending.get(id)?.resolve({ type: "extension_ui_response", id, ...answers } as never);
		return { result, frames };
	};

	it("keeps upstream ask frame unchanged without rich opt-in", async () => {
		const { result, frames } = await ask({
			answers: [
				{ id: "stack", selectedOptions: ["API", "DB"] },
				{ id: "go", selectedOptions: [], customInput: "Ship Monday" },
			],
		});
		expect(frames[0]).not.toHaveProperty("acceptImages");
		expect(await result).toMatchObject({
			kind: "submit",
			results: [
				{ id: "stack", selectedOptions: ["API", "DB"] },
				{ id: "go", customInput: "Ship Monday" },
			],
		});
	});

	it("adds gated image answers, notes and chat redirect only when opted in", async () => {
		const { result, frames } = await ask(
			{
				answers: [
					{ id: "stack", selectedOptions: ["API"], note: "see image", noteImages: [PNG] },
					{ id: "go", selectedOptions: [], customInput: "Ship", customInputImages: [PNG] },
				],
			},
			{ rich: true, acceptImages: true },
		);
		expect(frames[0]).toMatchObject({
			method: "ask",
			acceptImages: true,
			questions: [
				{
					id: "stack",
					recommended: 1,
					options: [
						{ label: "API", preview: "```go\nfunc main() {}\n```" },
						{ label: "UI", description: "SwiftUI" },
						{ label: "DB" },
					],
				},
				{ id: "go" },
			],
		});
		expect(await result).toMatchObject({
			kind: "submit",
			results: [
				{ id: "stack", note: "see image", noteImages: [PNG] },
				{ id: "go", customInputImages: [PNG] },
			],
		});
		const chat = await ask({ chat: true }, { rich: true });
		expect(await chat.result).toEqual({ kind: "chat" });
	});

	it("throws for malformed extras, ungated images and malformed upstream answers", async () => {
		const valid = [
			{ id: "stack", selectedOptions: ["API"] },
			{ id: "go", selectedOptions: ["Yes"] },
		];
		for (const [answers, options] of [
			[[{ ...valid[0], note: "not negotiated" }, valid[1]], {}],
			[[{ ...valid[0], noteImages: [PNG] }, valid[1]], { rich: true }],
			[[{ ...valid[0], note: 42 }, valid[1]], { rich: true }],
			[
				[{ ...valid[0], noteImages: [{ ...PNG, mimeType: "image/svg+xml" }] }, valid[1]],
				{ rich: true, acceptImages: true },
			],
			[
				[{ ...valid[0], customInputImages: [{ ...PNG, data: "bad!" }] }, valid[1]],
				{ rich: true, acceptImages: true },
			],
			[[{ ...valid[0], selectedOptions: ["Invented"] }, valid[1]], { rich: true }],
			[[valid[0], { ...valid[1], selectedOptions: ["Yes", "No"] }], { rich: true }],
		] as const) {
			const { result } = await ask({ answers }, options);
			await expect(result).rejects.toThrow();
		}
		const chat = await ask({ chat: true });
		await expect(chat.result).rejects.toThrow();
		const malformedChat = await ask({ chat: true, answers: valid }, { rich: true });
		await expect(malformedChat.result).rejects.toThrow();
	});

	it("uses upstream timeout fallback and cancels the host dialog once", async () => {
		const pending = new Map<string, PendingExtensionRequest>();
		const onTimeout = vi.fn();
		const frames: Array<Record<string, unknown>> = [];
		const result = await requestRpcAskDialog(
			pending,
			frame => frames.push(frame as Record<string, unknown>),
			questions,
			{ timeout: 5, onTimeout },
			true,
		);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(frames.map(frame => frame.method)).toEqual(["ask", "cancel"]);
		expect(frames[1]?.targetId).toBe(frames[0]?.id);
		expect(pending.size).toBe(0);
		expect(result).toMatchObject({
			kind: "submit",
			results: [
				{ id: "stack", selectedOptions: ["UI"], timedOut: true },
				{ id: "go", selectedOptions: ["Yes"], timedOut: true },
			],
		});
	});
});

// Real rpc-ui process, real ask tool; only the model is scripted to call ask.
async function runAskHost(
	optIn: boolean,
): Promise<{ ready?: Record<string, unknown>; methods: string[]; stderr: string }> {
	await using temp = await TempDir.create("@rpc-rich-ask-");
	const fixturePath = temp.join("runtime.ts");
	const sourceDir = path.resolve(import.meta.dir, "../src");
	await Bun.write(
		fixturePath,
		`
import { createMockModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../../ai/src/providers/mock.ts"))};
import { getBundledModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../../catalog/src/models.ts"))};
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { AuthStorage } from ${JSON.stringify(path.join(sourceDir, "session/auth-storage.ts"))};
import { initTheme } from ${JSON.stringify(path.resolve(import.meta.dir, "../../tui/src/theme/theme.ts"))};
globalThis.fetch = async () => { throw new Error("Offline ask fixture refuses network"); };
initTheme();
const authStorage = await AuthStorage.create("auth.db");
authStorage.keys.setRuntime("anthropic", "test-key");
const { session, setToolUIContext } = await createAgentSession({
  cwd: process.cwd(),
  model: getBundledModel("anthropic", "claude-sonnet-4-5"),
  authStorage,
  toolNames: ["ask"],
  interactivePrompts: true,
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  skills: [],
  contextFiles: [],
  promptTemplates: [],
  slashCommands: [],
  settings: Settings.isolated({ "compaction.enabled": false }),
});
const mock = createMockModel({
  responses: [{ content: [{ type: "toolCall", name: "ask", arguments: ${JSON.stringify({ questions })} }] }],
  handler: { content: ["thanks"] },
});
session.agent.streamFn = mock.stream;
session.subscribe(event => {
  if (event.type === "agent_end") process.stderr.write("CALLS:" + JSON.stringify(mock.calls.at(-1)?.context.messages.at(-1)) + "\\n");
});
await runRpcMode(session, { setToolUIContext });
`,
	);
	const child = Bun.spawn([process.execPath, fixturePath], {
		cwd: temp.path(),
		env: {
			PATH: Bun.env.PATH,
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 25_000,
	});
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};
	const methods: string[] = [];
	let ready: Record<string, unknown> | undefined;
	try {
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "ready") {
				ready = frame;
				if (optIn) await send({ id: "c1", type: "set_ask_dialog", enabled: true, rich: true });
				await send({ id: "p1", type: "prompt", message: "ask me" });
			}
			if (frame.type === "extension_ui_request" && typeof frame.method === "string") {
				// Presentation frames (status widgets) are not dialogs.
				if (frame.method !== "setWidget" && frame.method !== "setStatus") methods.push(frame.method);
				if (frame.method === "select") {
					// Fallback path: answer the first iterative question by cancelling.
					await send({ type: "extension_ui_response", id: frame.id, cancelled: true });
				}
				if (frame.method === "ask") {
					await send({
						type: "extension_ui_response",
						id: frame.id,
						answers: [
							{ id: "stack", selectedOptions: ["API", "DB"], note: "please review" },
							{
								id: "go",
								selectedOptions: [],
								customInput: "Ship after [Image #1]",
								customInputImages: [PNG],
							},
						],
					});
				}
			}
			if (frame.type === "prompt_result") break;
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
	}
	const stderr = await new Response(child.stderr).text();
	return { ready, methods, stderr };
}

describe("RPC rich ask end to end", () => {
	it("after opt-in, delivers the host's multi-select, custom answer and image to the model", async () => {
		const { ready, methods, stderr } = await runAskHost(true);
		expect(ready?.capabilities, stderr).toContain("rich-ask/2");
		expect(methods, stderr).toEqual(["ask"]);
		const toolResult = JSON.parse(stderr.split("CALLS:")[1]?.split("\n")[0] ?? "null");
		const text = JSON.stringify(toolResult);
		expect(text, stderr).toContain("API");
		expect(text).toContain("DB");
		expect(text).toContain("Ship after");
		expect(text).toContain("please review");
		expect(text).toContain('"type":"image"');
		expect(text).not.toContain("image omitted");
	}, 30_000);

	it("without opt-in, an older host keeps the select fallback and is never sent ask", async () => {
		const { methods, stderr } = await runAskHost(false);
		expect(methods, stderr).not.toContain("ask");
		expect(methods[0], stderr).toBe("select");
	}, 30_000);
});

/** Sends `set_ask_dialog` commands to a real RPC process and returns each response's `data`, in order. */
async function negotiateAskDialog(mode: "rpc" | "rpc-ui", commands: object[]): Promise<unknown[]> {
	await using temp = await TempDir.create("@rpc-ask-negotiation-");
	// The quiesce fixture wires the tool UI context exactly as `--mode rpc-ui` does.
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "quiesce-rpc-agent.ts")], {
		cwd: temp.path(),
		env: { ...process.env, PI_CODING_AGENT_DIR: temp.path(), PI_NO_TITLE: "1", QUIESCE_FIXTURE_MODE: mode },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 25_000,
	});
	const ids = commands.map((_, index) => `ask-${index}`);
	const data = new Map<string, unknown>();
	try {
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "ready") {
				child.stdin.write(
					commands
						.map(
							(command, index) => `${JSON.stringify({ ...command, id: ids[index], type: "set_ask_dialog" })}\n`,
						)
						.join(""),
				);
				await child.stdin.flush();
			}
			if (frame.type === "response" && typeof frame.id === "string" && ids.includes(frame.id)) {
				expect(frame.success).toBe(true);
				data.set(frame.id, frame.data);
				if (data.size === ids.length) break;
			}
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
	}
	return ids.map(id => data.get(id));
}

describe("set_ask_dialog rich negotiation", () => {
	it("in rpc-ui grants rich only with an enabled dialog, and answers a plain request without a rich key", async () => {
		const responses = await negotiateAskDialog("rpc-ui", [
			{ enabled: true, rich: true },
			{ enabled: false, rich: true },
			{ enabled: true },
		]);
		expect(responses).toEqual([{ enabled: true, rich: true }, { enabled: false, rich: false }, { enabled: true }]);
	}, 30_000);

	it("in plain rpc, without a tool UI context, refuses rich", async () => {
		expect(await negotiateAskDialog("rpc", [{ enabled: true, rich: true }])).toEqual([
			{ enabled: true, rich: false },
		]);
	}, 30_000);
});
