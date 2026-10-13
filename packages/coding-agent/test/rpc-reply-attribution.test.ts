import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

// Real RPC dispatch and session persistence; only the model reply is scripted.
describe("RPC reply attribution", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-reply-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("prompt_result names the session entry that holds the reply", async () => {
		await client.start();
		expect(client.capabilities).toContain("reply-attribution/1");
		const result = Promise.withResolvers<RpcPromptResultFrame>();
		const unsubscribe = client.onPromptResult(frame => {
			if (frame.id) result.resolve(frame);
		});
		try {
			await client.prompt("/hello", undefined, { literal: true });
			const frame = await withTimeout(result.promise, 10_000, "prompt_result did not arrive");
			const { entries } = await client.getEntries();
			const ids = (role: string) =>
				entries.filter(entry => entry.type === "message" && entry.message.role === role).map(entry => entry.id);
			expect(frame.run).toBe(1);
			expect([frame.promptEntryId]).toEqual(ids("user"));
			expect(frame.replyEntryIds).toEqual(ids("assistant"));
			expect(frame.replyEntryIds?.length).toBe(1);
		} finally {
			unsubscribe();
		}
	}, 30_000);
});
