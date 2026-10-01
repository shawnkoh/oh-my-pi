import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	type PendingExtensionRequest,
	parseRpcAskResponse,
	requestRpcAskDialog,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
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
	const reply = (results: unknown[]) => ({
		type: "extension_ui_response" as const,
		id: "x",
		ask: { kind: "submit", results },
	});

	it("accepts a well-formed multi-question answer and keeps engine-owned fields", () => {
		const parsed = parseRpcAskResponse(
			reply([
				{ id: "stack", selectedOptions: ["API", "DB"], note: "see [Image #1]", noteImages: [PNG] },
				{ id: "go", selectedOptions: [], customInput: "Ship Monday" },
			]) as never,
			questions,
			{ acceptImages: true },
		);
		expect(parsed).toEqual({
			kind: "submit",
			results: [
				{
					id: "stack",
					question: "Which parts?",
					options: ["API", "UI", "DB"],
					multi: true,
					selectedOptions: ["API", "DB"],
					note: "see [Image #1]",
					noteImages: [PNG],
				},
				{
					id: "go",
					question: "Ship it?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: [],
					customInput: "Ship Monday",
				},
			],
		});
	});

	it("fails closed on replies that do not match what was asked", () => {
		const cases: unknown[][] = [
			[{ id: "stack", selectedOptions: ["API"] }],
			[
				{ id: "go", selectedOptions: ["Yes"] },
				{ id: "stack", selectedOptions: ["API"] },
			],
			[
				{ id: "stack", selectedOptions: ["Invented"] },
				{ id: "go", selectedOptions: ["Yes"] },
			],
			[
				{ id: "stack", selectedOptions: ["API"] },
				{ id: "go", selectedOptions: ["Yes", "No"] },
			],
			[
				{ id: "stack", selectedOptions: ["API", "API"] },
				{ id: "go", selectedOptions: ["Yes"] },
			],
			[
				{
					id: "stack",
					selectedOptions: ["API"],
					customInputImages: [{ type: "image", data: "x", mimeType: "text/html" }],
				},
				{ id: "go", selectedOptions: [] },
			],
			// A single choice is an option or custom text, not both.
			[
				{ id: "stack", selectedOptions: ["API"] },
				{ id: "go", selectedOptions: ["Yes"], customInput: "also this" },
			],
			// Images must be base64 raster data.
			[
				{ id: "stack", selectedOptions: [], noteImages: [{ ...PNG, data: "not base64!" }] },
				{ id: "go", selectedOptions: [] },
			],
			[
				{ id: "stack", selectedOptions: [], noteImages: [{ ...PNG, mimeType: "image/svg+xml" }] },
				{ id: "go", selectedOptions: [] },
			],
		];
		for (const results of cases) {
			expect(parseRpcAskResponse(reply(results) as never, questions, { acceptImages: true })).toBeUndefined();
		}
		// Images are refused when the engine did not offer image answers.
		expect(
			parseRpcAskResponse(
				reply([
					{ id: "stack", selectedOptions: [], noteImages: [PNG] },
					{ id: "go", selectedOptions: [] },
				]) as never,
				questions,
			),
		).toBeUndefined();
		expect(
			parseRpcAskResponse({ type: "extension_ui_response", id: "x", ask: { kind: "chat" } } as never, questions),
		).toEqual({
			kind: "chat",
		});
	});

	it("ignores a host-claimed timeout: only the engine marks answers timed out", () => {
		const parsed = parseRpcAskResponse(
			reply([
				{ id: "stack", selectedOptions: ["API"], timedOut: true },
				{ id: "go", selectedOptions: ["Yes"], timedOut: true },
			]) as never,
			questions,
		);
		expect(parsed?.kind === "submit" && parsed.results.some(result => "timedOut" in result)).toBe(false);
	});

	it("auto-selects the recommended option when the engine timeout expires, not cancelling the turn", async () => {
		const pending = new Map<string, PendingExtensionRequest>();
		const onTimeout = vi.fn();
		const frames: Array<Record<string, unknown>> = [];
		const result = await requestRpcAskDialog(
			pending,
			frame => frames.push(frame as Record<string, unknown>),
			questions,
			{
				timeout: 5,
				onTimeout,
			},
		);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		// The host's still-open question is closed, so it cannot answer a settled dialog.
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

	it("sends every question with previews, recommendation and multi in one request", async () => {
		const pending = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		void requestRpcAskDialog(pending, output, questions, { acceptImages: true });
		expect(output.mock.calls[0]?.[0]).toMatchObject({
			type: "extension_ui_request",
			method: "ask",
			acceptImages: true,
			questions: [
				{
					id: "stack",
					multi: true,
					recommended: 1,
					options: [
						{ label: "API", preview: "```go\nfunc main() {}\n```" },
						{ label: "UI", description: "SwiftUI" },
						{ label: "DB" },
					],
				},
				{ id: "go", multi: false },
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
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { initTheme } from ${JSON.stringify(path.resolve(import.meta.dir, "../../tui/src/theme/theme.ts"))};
globalThis.fetch = async () => { throw new Error("Offline ask fixture refuses network"); };
initTheme();
const { session, setToolUIContext } = await createAgentSession({
  cwd: process.cwd(),
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
				if (optIn) await send({ id: "c1", type: "set_ui_capabilities", capabilities: ["rich-ask/1"] });
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
						ask: {
							kind: "submit",
							results: [
								{ id: "stack", selectedOptions: ["API", "DB"] },
								{
									id: "go",
									selectedOptions: [],
									customInput: "Ship after [Image #1]",
									customInputImages: [PNG],
								},
							],
						},
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
		expect(ready?.capabilities, stderr).toContain("rich-ask/1");
		expect(methods, stderr).toEqual(["ask"]);
		const toolResult = JSON.parse(stderr.split("CALLS:")[1]?.split("\n")[0] ?? "null");
		const text = JSON.stringify(toolResult);
		expect(text, stderr).toContain("API");
		expect(text).toContain("DB");
		expect(text).toContain("Ship after");
		expect(text).toContain('"type":"image"');
		expect(text).not.toContain("image omitted");
	}, 30_000);

	it("without opt-in, an older host keeps the select fallback and is never sent ask", async () => {
		const { methods, stderr } = await runAskHost(false);
		expect(methods, stderr).not.toContain("ask");
		expect(methods[0], stderr).toBe("select");
	}, 30_000);
});
