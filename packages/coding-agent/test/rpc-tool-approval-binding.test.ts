import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

// Real RPC mode, real bash tool and approval gate; only the model is scripted
// to request one bash call. The host decides the approval over the wire.
async function runApprovalScenario(
	answer: "approve" | "interrupt-then-late-approve",
): Promise<{ frames: Record<string, unknown>[]; markerExists: boolean; stderr: string }> {
	await using temp = await TempDir.create("@rpc-approval-binding-");
	const fixturePath = temp.join("runtime.ts");
	const sourceDir = path.resolve(import.meta.dir, "../src");
	const marker = temp.join("MARKER");
	await Bun.write(
		fixturePath,
		`
import { createMockModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../../ai/src/providers/mock.ts"))};
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline approval fixture refuses network"); };
const { session } = await createAgentSession({
  cwd: process.cwd(),
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
session.agent.streamFn = createMockModel({
  responses: [{ content: [{ type: "toolCall", name: "bash", arguments: { command: ${JSON.stringify(`touch ${marker}`)} } }] }],
  handler: { content: ["done"] },
}).stream;
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
	try {
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			frames.push(frame);
			if (frame.type === "ready") await send({ id: "p1", type: "prompt", message: "run it" });
			if (frame.type === "extension_ui_request" && frame.method === "select") {
				if (answer === "approve") {
					await send({ type: "extension_ui_response", id: frame.id, value: "Approve" });
				} else {
					await send({ id: "a1", type: "abort" });
					// A late answer racing the interrupt must not execute the call.
					await send({ type: "extension_ui_response", id: frame.id, value: "Approve" });
				}
			}
			if (frame.type === "prompt_result" || (frame.type === "agent_end" && answer !== "approve")) break;
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
	}
	return { frames, markerExists: fs.existsSync(marker), stderr: await stderr };
}

const toolCallIds = (frames: Record<string, unknown>[]) =>
	new Set(
		frames.flatMap(frame => {
			const id = frame.toolCallId;
			return typeof id === "string" ? [id] : [];
		}),
	);

describe("RPC tool-approval binding", () => {
	it("binds the approval dialog to the exact native call and runs it once approved", async () => {
		const { frames, markerExists, stderr } = await runApprovalScenario("approve");
		const ready = frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities, stderr).toContain("tool-approval-binding/1");
		const select = frames.find(frame => frame.type === "extension_ui_request" && frame.method === "select");
		const approval = select?.approval as { toolCallId: string; toolName: string; arguments: { command: string } };
		expect(approval, stderr).toBeDefined();
		expect(approval.toolName).toBe("bash");
		expect(approval.arguments.command).toEndWith("MARKER");
		expect(toolCallIds(frames).has(approval.toolCallId)).toBe(true);
		expect(markerExists).toBe(true);
	}, 30_000);

	it("an interrupt cancels the pending approval and a late approve never executes the call", async () => {
		const { frames, markerExists, stderr } = await runApprovalScenario("interrupt-then-late-approve");
		const select = frames.find(frame => frame.type === "extension_ui_request" && frame.method === "select");
		expect(select, stderr).toBeDefined();
		const cancel = frames.find(
			frame => frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === select?.id,
		);
		expect(cancel, stderr).toBeDefined();
		expect(markerExists).toBe(false);
	}, 30_000);
});
