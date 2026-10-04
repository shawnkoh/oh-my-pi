import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC engine capabilities", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-capabilities-"));
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

	test("the ready frame and get_state advertise one list: protocol features, external delivery and quiesce", async () => {
		expect(client.capabilities).toEqual([]);
		await client.start();
		// Plain `--mode rpc` has no tool UI context, so no `rich-ask/2`.
		expect(client.capabilities).toEqual([
			"literal-input/1",
			"tool-approval-binding/1",
			"reply-attribution/1",
			"external-delivery/1",
			"quiesce-exit/2",
			"owned-jobs/1",
		]);
		const state = await client.getState();
		expect(state.capabilities).toEqual([...client.capabilities]);
	}, 30_000);
});
