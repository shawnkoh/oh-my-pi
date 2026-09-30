import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

describe("RPC goal command", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start(options: {
		continuation: boolean;
		script?: "complete" | "idle";
		plan?: boolean;
	}): Promise<RpcClient> {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "goal-rpc-agent.ts")],
			cwd: directory,
			env: {
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				GOAL_RPC_CONTINUATION: options.continuation ? "1" : "0",
				GOAL_RPC_SCRIPT: options.script ?? "complete",
				GOAL_RPC_PLAN: options.plan ? "1" : "0",
			},
		});
		await client.start();
		return client;
	}

	test("get is a read without a model call; create activates the goal tool without prompting", async () => {
		const rpc = await start({ continuation: false });
		expect(await rpc.goal("get")).toEqual({ goal: null, state: null });
		expect((await rpc.getState()).goal).toBeNull();

		const created = await rpc.goal("create", { objective: "  ship it  ", tokenBudget: 5000 });
		expect(created.goal).toMatchObject({ objective: "ship it", status: "active", tokenBudget: 5000 });
		expect(created.state).toMatchObject({ enabled: true, mode: "active" });

		const state = await rpc.getState();
		expect(state.goal?.goal.objective).toBe("ship it");
		expect(state.dumpTools?.map(tool => tool.name)).toContain("goal");
		// Continuation is off: nothing ran, so no model turn happened.
		expect(state.messageCount).toBe(0);
		expect(state.isStreaming).toBe(false);
	}, 30_000);

	test("plan mode refuses create and resume", async () => {
		const rpc = await start({ continuation: true, plan: true });
		await expect(rpc.goal("create", { objective: "not while planning" })).rejects.toThrow(
			"Exit plan mode before starting a goal.",
		);
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.messageCount).toBe(0);
	}, 30_000);

	test("continuation stops after a turn with no progress and the goal stays active", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "loop forever" });
			await withTimeout(settled.promise, 15_000, "No-progress continuation never settled");
		} finally {
			unsubscribe();
		}
		const state = await rpc.getState();
		expect(state.goal?.goal.status).toBe("active");
		expect(state.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toHaveLength(1);
	}, 30_000);

	test("create refuses a second goal, a paused goal, and invalid input; pause/resume/drop restore tools", async () => {
		const rpc = await start({ continuation: false });
		await expect(rpc.goal("create", { objective: "   " })).rejects.toMatchObject({ command: "goal" });
		await expect(rpc.goal("create", { objective: "x", tokenBudget: 0 })).rejects.toMatchObject({ command: "goal" });
		await expect(rpc.goal("resume")).rejects.toMatchObject({ command: "goal" });

		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		expect(toolsBefore).not.toContain("goal");
		await rpc.goal("create", { objective: "first" });
		await expect(rpc.goal("create", { objective: "second" })).rejects.toMatchObject({ command: "goal" });

		const paused = await rpc.goal("pause");
		expect(paused.goal?.status).toBe("paused");
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		await expect(rpc.goal("create", { objective: "second" })).rejects.toMatchObject({ command: "goal" });

		const resumed = await rpc.goal("resume");
		expect(resumed.goal).toMatchObject({ objective: "first", status: "active" });
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toContain("goal");

		const dropped = await rpc.goal("drop");
		expect(dropped.goal).toBeNull();
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		expect((await rpc.goal("create", { objective: "again" })).goal?.status).toBe("active");
	}, 30_000);

	test("with rpc continuation opted in, create drives turns until the agent completes the goal", async () => {
		const rpc = await start({ continuation: true });
		const updates: Array<string | undefined> = [];
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "goal_updated") updates.push(event.state?.goal.status ?? "none");
		});
		const unsubscribeSettled = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "finish the task" });
			await withTimeout(settled.promise, 15_000, "Goal continuation never settled");
		} finally {
			unsubscribe();
			unsubscribeSettled();
		}
		expect(updates).toContain("complete");
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.isSettled).toBe(true);
		expect(state.dumpTools?.map(tool => tool.name)).not.toContain("goal");
		const messages = await rpc.getMessages();
		const continuations = messages.filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations.length).toBeGreaterThanOrEqual(1);
		// The goal tool, not a text prompt, completed it.
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.toolName === "goal" &&
					JSON.stringify(message.content).includes("complete"),
			),
		).toBe(true);
	}, 30_000);
});
