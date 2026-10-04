import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { LITERAL_INPUT_CAPABILITY } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord, readJsonl, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

// A remote host that may send conversation must not reach administrative
// commands through message text. `/fast on` is a real builtin with visible
// state; `/greet` is a registered prompt template.
describe("RPC literal input", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-literal-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "literal-input-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	async function promptAndSettle(message: string, literal: boolean): Promise<void> {
		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			await client.prompt(message, undefined, { literal });
			await withTimeout(idle.promise, 10_000, `turn for ${message} did not finish`);
		} finally {
			unsubscribe();
		}
	}

	const userTexts = async () =>
		(await client.getMessages())
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.map(part => (part.type === "text" ? part.text : `[${part.type}]`)).join(""),
			);

	test("advertises literal-input/1 on the ready frame", async () => {
		await client.start();
		expect(client.capabilities).toContain(LITERAL_INPUT_CAPABILITY);
	}, 30_000);
	test("literal prompts reach the model verbatim and run no builtin or template", async () => {
		await client.start();
		expect((await client.getState()).fastModeEnabled).toBe(false);

		await promptAndSettle("/fast on", true);
		await promptAndSettle("/greet world", true);
		await promptAndSettle("^anthropic/claude-sonnet-4-5 hi", true);

		expect((await client.getState()).fastModeEnabled).toBe(false);
		expect(await userTexts()).toEqual(["/fast on", "/greet world", "^anthropic/claude-sonnet-4-5 hi"]);
	}, 30_000);

	test("the same text without literal still dispatches, proving the fixture exercises real parsing", async () => {
		await client.start();
		await client.prompt("/fast on");
		expect((await client.getState()).fastModeEnabled).toBe(true);

		await promptAndSettle("/greet world", false);
		expect(await userTexts()).toEqual(["EXPANDED TEMPLATE world"]);
	}, 30_000);

	test("a hook rewrite to a slash command is still literal, while ordinary input dispatches it", async () => {
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "input-hook-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
		await promptAndSettle("command:", true);
		expect(await userTexts()).toEqual(["/fast on"]);
		expect((await client.getState()).fastModeEnabled).toBe(false);
		await promptAndSettle("/fast on", true);
		expect(await userTexts()).toEqual(["/fast on", "/fast on"]);
		expect((await client.getState()).fastModeEnabled).toBe(false);
		await client.prompt("/fast on");
		expect((await client.getState()).fastModeEnabled).toBe(true);
	}, 30_000);

	test("literal follow-up and steer queue the exact text, including extension-looking commands", async () => {
		await client.start();
		await client.followUp("/greet queued", undefined, { literal: true });
		expect((await client.getState()).queuedMessages.followUp).toEqual(["/greet queued"]);
		// An idle steer may begin delivery immediately; its exact text is asserted below.
		await client.steer("/greet steered", undefined, { literal: true });
		await client.followUp("/fast on", undefined, { literal: true });
		expect((await client.getState()).fastModeEnabled).toBe(false);

		// The idle steer may already be running; a literal prompt is acknowledged once admitted,
		// so it joins as a follow-up rather than racing the live run.
		await client.prompt("go", undefined, { literal: true, streamingBehavior: "followUp" });
		await client.waitForSettled(10_000);
		const texts = await userTexts();
		expect(texts).toContain("/fast on");
		expect(texts).toContain("/greet queued");
		// Without literal, steer expands templates (see the control test), so this proves the bypass.
		expect(texts).toContain("/greet steered");
		expect(texts.some(text => text.includes("EXPANDED TEMPLATE"))).toBe(false);
		expect((await client.getState()).fastModeEnabled).toBe(false);
	}, 30_000);

	test("a non-boolean literal is refused instead of parsed", async () => {
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "literal-input-rpc-agent.ts")],
			{
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const responses: Record<string, unknown>[] = [];
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "ready") {
					for (const [index, type] of ["prompt", "steer", "follow_up"].entries()) {
						child.stdin.write(
							`${JSON.stringify({ id: `c${index}`, type, message: "/fast on", literal: "true" })}\n`,
						);
					}
					child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
					await child.stdin.flush();
				}
				if (frame.type === "response") responses.push(frame);
				if (frame.type === "response" && frame.id === "state") break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}
		expect(responses.slice(0, 3).map(response => response.success)).toEqual([false, false, false]);
		expect((responses[3]?.data as { fastModeEnabled?: boolean })?.fastModeEnabled).toBe(false);
	}, 30_000);
});
