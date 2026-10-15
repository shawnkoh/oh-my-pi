import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contracts: a steer denies a pending tool approval (approval-steer-deny/1).
 *
 * Real RPC mode, real bash tool and approval gate; only the model is scripted to
 * request one bash call. While its approval waits, the host sends input:
 * - an external delivery whose sender chose `steer`, or a user `steer`, denies the
 *   call: the dialog is cancelled, nothing runs, the agent is told who steered, and a
 *   late approve for the cancelled dialog runs nothing;
 * - an `aside` delivery leaves the approval pending: the host's approve still runs it.
 */
type Input = "steer-delivery" | "user-steer" | "aside-delivery";

function card(text: string) {
	return {
		customType: "external-card",
		content: "[card]",
		display: true,
		details: { "omp.llm": { role: "user", content: [{ type: "text", text }] }, "omp.llm.source": "src" },
	};
}

async function runScenario(
	input: Input,
	calls = 1,
): Promise<{ frames: Record<string, unknown>[]; markerExists: boolean; stderr: string }> {
	await using temp = await TempDir.create("@rpc-approval-steer-");
	const fixturePath = temp.join("runtime.ts");
	const sourceDir = path.resolve(import.meta.dir, "../src");
	// One marker file per bash call in the scripted tool batch.
	const markers = Array.from({ length: calls }, (_, call) => temp.join(`MARKER-${call}`));
	const toolCalls = markers.map(marker => ({
		type: "toolCall",
		name: "bash",
		arguments: { command: `touch ${marker}` },
	}));
	await Bun.write(
		fixturePath,
		`
import { createMockModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../../ai/src/providers/mock.ts"))};
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { createInMemoryAuthStorage } from ${JSON.stringify(path.resolve(import.meta.dir, "helpers/agent-session-setup.ts"))};
globalThis.fetch = async () => { throw new Error("Offline approval fixture refuses network"); };
const mock = createMockModel({
  responses: [{ content: ${JSON.stringify(toolCalls)} }],
  handler: { content: ["done"] },
});
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime(mock.model.provider, "test-key");
const { session } = await createAgentSession({
  cwd: process.cwd(),
  authStorage,
  model: mock.model,
  toolNames: ["bash"],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  skills: [],
  contextFiles: [],
  promptTemplates: [],
  slashCommands: [],
  settings: Settings.isolated({
    "compaction.enabled": false,
    "async.enabled": false,
    "bash.autoBackground.enabled": false,
    "bashInterceptor.enabled": false,
    "tools.approvalMode": "always-ask",
  }),
});
session.agent.streamFn = mock.stream;
await runRpcMode(session);
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
	const stderr = new Response(child.stderr).text();
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};
	const frames: Record<string, unknown>[] = [];
	let dialogId: unknown;
	try {
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			frames.push(frame);
			if (frame.type === "ready") await send({ id: "p1", type: "prompt", message: "run it" });
			if (frame.type === "extension_ui_request" && frame.method === "select") {
				// Input goes out once, on the first dialog. Any later dialog is approved at once:
				// a call it runs shows the batch rule (a queued steer denies the rest) failed.
				if (dialogId !== undefined) {
					await send({ type: "extension_ui_response", id: frame.id, value: "Approve" });
					continue;
				}
				dialogId = frame.id;
				if (input === "user-steer") await send({ id: "s1", type: "steer", message: "stop, do not run that" });
				else
					await send({
						id: "d1",
						type: "deliver",
						record: card("stop, do not run that"),
						options: { mode: input === "steer-delivery" ? "steer" : "aside" },
					});
			}
			// The input was admitted: deny inputs cancelled the dialog by now, so this late
			// approve answers nothing; after an aside the dialog is still pending and it runs.
			if (frame.type === "response" && (frame.id === "s1" || frame.id === "d1"))
				await send({ type: "extension_ui_response", id: dialogId, value: "Approve" });
			if (frame.type === "prompt_result") break;
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
	}
	return { frames, markerExists: markers.some(marker => fs.existsSync(marker)), stderr: await stderr };
}

function approvalOutcome(frames: Record<string, unknown>[]) {
	const select = frames.find(frame => frame.type === "extension_ui_request" && frame.method === "select");
	const approval = select?.approval as { toolCallId: string } | undefined;
	const cancel = frames.find(
		frame => frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === select?.id,
	);
	const end = frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === approval?.toolCallId);
	return { select, cancel, end };
}

describe("RPC approval denied by steer", () => {
	it("an external delivery whose sender chose steer denies the pending call and says why", async () => {
		const { frames, markerExists, stderr } = await runScenario("steer-delivery");
		const ready = frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities, stderr).toContain("approval-steer-deny/1");
		const { select, cancel, end } = approvalOutcome(frames);
		expect(select, stderr).toBeDefined();
		expect(cancel, stderr).toBeDefined();
		expect(end?.isError, stderr).toBe(true);
		const result = JSON.stringify(end?.result);
		expect(result).toContain("Tool call denied: bash");
		expect(result).toContain("An external sender (delivery ");
		expect(result).toContain("nothing ran");
		expect(markerExists).toBe(false);
	}, 30_000);

	it("a user steer denies the pending call and says the user steered", async () => {
		const { frames, markerExists, stderr } = await runScenario("user-steer");
		const { cancel, end } = approvalOutcome(frames);
		expect(cancel, stderr).toBeDefined();
		expect(end?.isError, stderr).toBe(true);
		expect(JSON.stringify(end?.result)).toContain("The user sent a steering message");
		expect(markerExists).toBe(false);
	}, 30_000);

	it("an aside delivery leaves the approval pending", async () => {
		const { frames, markerExists, stderr } = await runScenario("aside-delivery");
		const { cancel, end } = approvalOutcome(frames);
		expect(cancel, stderr).toBeUndefined();
		expect(end?.isError, stderr).toBe(false);
		expect(markerExists).toBe(true);
	}, 30_000);

	it("a steer still queued also denies the later approvals of its tool batch", async () => {
		const { frames, markerExists, stderr } = await runScenario("steer-delivery", 2);
		const ends = frames.filter(frame => frame.type === "tool_execution_end");
		expect(ends, stderr).toHaveLength(2);
		for (const end of ends) {
			expect(end.isError, stderr).toBe(true);
			expect(JSON.stringify(end.result)).toContain("An external sender (delivery ");
		}
		expect(markerExists).toBe(false);
	}, 30_000);
});
