import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcGoalController, type RpcGoalSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

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
		script?: "complete" | "idle" | "slow";
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
		// One continuation after create, and a second after that turn yielded unfinished.
		expect(continuations).toHaveLength(2);
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

	test("host abort of a continuation turn pauses the goal and starts no further goal turn", async () => {
		const rpc = await start({ continuation: true, script: "slow" });
		let agentStarts = 0;
		const started = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "agent_start") {
				agentStarts++;
				started.resolve();
			}
		});
		let state: RpcSessionState;
		try {
			await rpc.goal("create", { objective: "long task" });
			await withTimeout(started.promise, 10_000, "Continuation turn never started");
			await rpc.abort();
			// A continuation escaping the abort is admitted synchronously one macrotask after
			// the aborted run's agent_end; this later round-trip would observe it as busy.
			state = await rpc.getState();
		} finally {
			unsubscribe();
		}
		expect(agentStarts).toBe(1);
		expect(state.goal?.goal.status).toBe("paused");
		expect(state.isStreaming).toBe(false);
		expect(state.isSettled).toBe(true);
	}, 30_000);

	test("a new session leaves the previous session's goal, goal tool and continuation behind", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => firstSettle.resolve());
		try {
			await rpc.goal("create", { objective: "belongs to the first session" });
			await withTimeout(firstSettle.promise, 15_000, "First session never settled");
		} finally {
			unsubscribe();
		}
		expect((await rpc.newSession()).cancelled).toBe(false);
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		// A turn in the new session must not pick up the old objective's continuation.
		await rpc.promptAndWait("hello in the second session");
		const s2 = await rpc.getState();
		expect(s2.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toEqual([]);
		expect((await rpc.goal("create", { objective: "second session goal" })).goal?.status).toBe("active");
	}, 30_000);

	test("prompt_result reports the session unsettled when a goal continuation follows the prompt", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribeSettled = rpc.onSessionSettled(() => firstSettle.resolve());
		const results = new Map<string, boolean>();
		const unsubscribeResults = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.sessionSettled);
		});
		try {
			await rpc.goal("create", { objective: "keep going" });
			// The first continuation makes no progress, so the loop stops and the session settles.
			await withTimeout(firstSettle.promise, 15_000, "Initial continuation never settled");
			const events = await rpc.promptAndWait("host input re-arms the goal");
			expect(events.some(event => event.type === "agent_end")).toBe(true);
		} finally {
			unsubscribeSettled();
			unsubscribeResults();
		}
		// The host prompt re-armed continuation; a goal turn follows it, so the prompt's
		// own result must not claim the session settled.
		expect([...results.values()]).toEqual([false]);
	}, 30_000);
});

describe("RpcGoalController continuation gate", () => {
	const agentEnd = { type: "agent_end", messages: [], isTerminal: true } as unknown as AgentSessionEvent;
	const hostInput = { type: "message_start", message: { role: "user", content: [] } } as unknown as AgentSessionEvent;

	function fakeSession(admit: (customType: string) => Promise<boolean>) {
		const goal: Goal = {
			id: "g1",
			objective: "o",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
		};
		let idle = Promise.withResolvers<void>();
		idle.resolve();
		const session = {
			settings: Settings.isolated({ "goal.continuationModes": ["rpc"] }),
			isDisposed: false,
			isSessionTransitioning: false,
			isStreaming: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			getPlanModeState: () => undefined,
			getGoalModeState: () => ({ enabled: true, mode: "active" as const, goal }),
			getTodoPhases: () => [],
			goalRuntime: { buildContinuationPrompt: () => "continue" },
			promptCustomMessage: (message: { customType: string }) => admit(message.customType),
			waitForIdle: () => idle.promise,
		};
		let dropped = 0;
		const controller = new RpcGoalController(session as unknown as RpcGoalSession, () => dropped++);
		return {
			session,
			controller,
			dropped: () => dropped,
			/** Hold waitForIdle until {@link release}. */
			hold: () => {
				idle = Promise.withResolvers<void>();
			},
			release: () => idle.resolve(),
		};
	}

	test("a continuation decided before the session closes is never admitted after it", async () => {
		const admitted: string[] = [];
		const { session, controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		controller.observe(agentEnd);
		expect(controller.continuationPending).toBe(true);
		session.isDisposed = true;
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(controller.continuationPending).toBe(false);

		// A host abort closes the gate before the aborted run's agent_end arrives.
		session.isDisposed = false;
		controller.stopForHostAbort();
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);

		// Host input re-arms it; the next yield continues exactly once.
		controller.observe(hostInput);
		controller.observe(agentEnd);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a rejected continuation does not claim the next run as its own", async () => {
		let calls = 0;
		const { controller } = fakeSession(async () => {
			calls++;
			if (calls === 1) throw new Error("Agent is busy");
			return true;
		});

		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(calls).toBe(1);
		// Another source's run ends without tool activity. It is not a continuation turn,
		// so it must not count as "no progress" and stop the goal loop.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(calls).toBe(2);
	});

	test("a continuation that finds the session busy or is refused releases settlement", async () => {
		let result = true;
		const admitted: string[] = [];
		const { session, controller, dropped } = fakeSession(async customType => {
			admitted.push(customType);
			return result;
		});

		// Another turn was admitted while the continuation waited: dropped, settle re-checked.
		session.hasAdmittedSubmission = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(1);

		// Mid-transition: dropped the same way.
		session.hasAdmittedSubmission = false;
		session.isSessionTransitioning = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(2);

		// Admitted but the session refuses to start it: no run follows, so settlement is released.
		session.isSessionTransitioning = false;
		result = false;
		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(dropped()).toBe(3);
		expect(controller.continuationPending).toBe(false);
	});

	test("a session change voids a waiting continuation; a cancelled change resumes it", async () => {
		const admitted: string[] = [];
		const { controller, hold, release } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		hold();
		controller.observe(agentEnd);
		expect(controller.continuationPending).toBe(true);
		await controller.beginSessionChange();
		expect(controller.continuationPending).toBe(false);
		release();
		await nextMacrotask();
		expect(admitted).toEqual([]);

		await controller.endSessionChange(true);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});
});
