/**
 * Contracts: a blocking `task` call honours steer.
 *
 * With async execution off (or for `blocking: true` agents) the call waits on its
 * subagents inline. A queued steer must not wait behind them: the subagents still
 * running move to background jobs — re-homed, not restarted — and the call returns
 * at once so the steer is read at the next boundary.
 *
 * 1. A steer during a single inline spawn returns a steered notice; the same run
 *    continues as a job, survives the turn's abort, and delivers its result once.
 * 2. In a fan-out, spawns that finished before the steer keep their inline result;
 *    only the unsettled ones move.
 * 3. Cancelling the job cancels the subagent.
 * 4. Without a job manager, or without a steer, the call still waits inline.
 * 5. A spawn the job manager refuses stays inline and the call waits for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { SpawnRun } from "@oh-my-pi/pi-coding-agent/task/spawn-run";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

function createSession(manager: AsyncJobManager | undefined, asyncEnabled = false): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": asyncEnabled, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function steerContext(steer: AbortController): AgentToolContext {
	return { toolCall: { steeringSignal: steer.signal } } as unknown as AgentToolContext;
}

/** Lets queued promise callbacks and abort listeners run without waiting on the clock. */
async function flushTurns(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Subagents that run until their gate opens; each records the signal it ran under. */
function gatedSubagents() {
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const starts = new Map<string, PromiseWithResolvers<void>>();
	const signals = new Map<string, AbortSignal | undefined>();
	const runs = new Map<string, number>();
	const startOf = (id: string): PromiseWithResolvers<void> => {
		let start = starts.get(id);
		if (!start) {
			start = Promise.withResolvers<void>();
			starts.set(id, start);
		}
		return start;
	};
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const id = options.id ?? "?";
		runs.set(id, (runs.get(id) ?? 0) + 1);
		signals.set(id, options.signal);
		const gate = Promise.withResolvers<void>();
		gates.set(id, gate);
		startOf(id).resolve();
		const aborted = Promise.withResolvers<void>();
		options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		await Promise.race([gate.promise, aborted.promise]);
		if (options.signal?.aborted) return makeResult(id, { aborted: true, exitCode: 1, output: "" });
		return makeResult(id);
	});
	return {
		gates,
		signals,
		runs,
		async started(...ids: string[]): Promise<void> {
			await Promise.all(ids.map(id => startOf(id).promise));
		},
	};
}

describe("task honours steer in blocking mode", () => {
	const managers: AsyncJobManager[] = [];
	const delivered: Array<{ jobId: string; text: string }> = [];

	function createManager(options: { maxRunningJobs?: number } = {}): AsyncJobManager {
		const manager = new AsyncJobManager({
			...options,
			onJobComplete: (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
		delivered.length = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("moves a running single spawn to a job on steer and keeps it past the turn's abort", async () => {
		const subagents = gatedSubagents();
		const manager = createManager();
		const tool = await TaskTool.create(createSession(manager));
		const turn = new AbortController();
		const steer = new AbortController();

		const call = tool.execute(
			"tc-single",
			{ context: "ctx", tasks: [{ name: "Solo", task: "Long work." }] } as TaskParams,
			turn.signal,
			undefined,
			steerContext(steer),
		);
		await subagents.started("Solo");
		steer.abort();
		const result = await call;

		const text = firstText(result);
		expect(text).toContain("Steered:");
		expect(text).toContain("`Solo` (job `Solo`)");
		expect(text).not.toContain("Solo output.");
		expect(manager.getJob("Solo")?.status).toBe("running");

		// The turn ends after the steer; the moved subagent must not die with it.
		turn.abort();
		expect(subagents.signals.get("Solo")?.aborted).toBe(false);

		subagents.gates.get("Solo")!.resolve();
		await manager.getJob("Solo")!.promise;
		expect(manager.getJob("Solo")!.status).toBe("completed");
		await manager.waitForAll();
		expect(delivered.filter(entry => entry.jobId === "Solo")).toHaveLength(1);
		expect(delivered.find(entry => entry.jobId === "Solo")!.text).toContain("Solo output.");
		expect(subagents.runs.get("Solo")).toBe(1);
	});

	it("keeps finished spawns inline and moves only the unsettled ones", async () => {
		const subagents = gatedSubagents();
		const manager = createManager();
		const tool = await TaskTool.create(createSession(manager));
		const steer = new AbortController();

		// The steer must come after Quick settled inline: await its run's own result first.
		const runs = new Map<string, SpawnRun>();
		const attach = SpawnRun.prototype.attach;
		vi.spyOn(SpawnRun.prototype, "attach").mockImplementation(function (this: SpawnRun, owner) {
			if (this.identity.agentId) runs.set(this.identity.agentId, this);
			attach.call(this, owner);
		});
		const call = tool.execute(
			"tc-fanout",
			{
				context: "ctx",
				tasks: [
					{ name: "Quick", task: "Short work." },
					{ name: "Slow", task: "Long work." },
				],
			} as TaskParams,
			undefined,
			undefined,
			steerContext(steer),
		);
		await subagents.started("Quick", "Slow");
		subagents.gates.get("Quick")!.resolve();
		await runs.get("Quick")!.result;
		await flushTurns();
		steer.abort();
		const result = await call;

		const text = firstText(result);
		expect(text).toContain("Steered:");
		expect(text).toContain("1 subagent continues as a background job: `Slow` (job `Slow`)");
		expect(text).toContain("Quick output.");
		expect(text).not.toContain("cancelled before start");
		expect(result.details?.results.map(r => r.id)).toEqual(["Quick"]);
		expect(manager.getJob("Quick")).toBeUndefined();
		expect(manager.getJob("Slow")?.status).toBe("running");

		subagents.gates.get("Slow")!.resolve();
		await manager.getJob("Slow")!.promise;
		expect(manager.getJob("Slow")!.status).toBe("completed");
		expect(subagents.runs.get("Slow")).toBe(1);
	});

	it("cancels the subagent when its job is cancelled", async () => {
		const subagents = gatedSubagents();
		const manager = createManager();
		const tool = await TaskTool.create(createSession(manager));
		const steer = new AbortController();

		const call = tool.execute(
			"tc-cancel",
			{ context: "ctx", tasks: [{ name: "Doomed", task: "Long work." }] } as TaskParams,
			undefined,
			undefined,
			steerContext(steer),
		);
		await subagents.started("Doomed");
		steer.abort();
		await call;

		expect(manager.cancel("Doomed")).toBe(true);
		expect(subagents.signals.get("Doomed")?.aborted).toBe(true);
	});

	it("waits inline when the session has no job manager", async () => {
		const subagents = gatedSubagents();
		const tool = await TaskTool.create(createSession(undefined));
		const steer = new AbortController();

		let settled = false;
		const call = tool
			.execute(
				"tc-no-manager",
				{ context: "ctx", tasks: [{ name: "Bound", task: "Long work." }] } as TaskParams,
				undefined,
				undefined,
				steerContext(steer),
			)
			.finally(() => {
				settled = true;
			});
		await subagents.started("Bound");
		steer.abort();
		await flushTurns();
		expect(settled).toBe(false);

		subagents.gates.get("Bound")!.resolve();
		const result = await call;
		expect(firstText(result)).toContain("Bound output.");
		expect(firstText(result)).not.toContain("Steered:");
	});

	it("waits for a spawn the job manager refuses", async () => {
		const subagents = gatedSubagents();
		// A running filler job exhausts the cap, so registering the moved spawn throws.
		const manager = createManager({ maxRunningJobs: 1 });
		const filler = Promise.withResolvers<string>();
		manager.register("bash", "filler", () => filler.promise, { id: "filler" });
		const tool = await TaskTool.create(createSession(manager));
		const steer = new AbortController();

		let settled = false;
		const call = tool
			.execute(
				"tc-refused",
				{ context: "ctx", tasks: [{ name: "Kept", task: "Long work." }] } as TaskParams,
				undefined,
				undefined,
				steerContext(steer),
			)
			.finally(() => {
				settled = true;
			});
		await subagents.started("Kept");
		steer.abort();
		await flushTurns();
		expect(settled).toBe(false);
		expect(manager.getJob("Kept")).toBeUndefined();

		subagents.gates.get("Kept")!.resolve();
		const result = await call;
		filler.resolve("done");
		expect(firstText(result)).toContain("Kept output.");
	});

	it("moves the blocking half of a mixed call and reports both halves in one view", async () => {
		const subagents = gatedSubagents();
		const manager = createManager();
		const tool = await TaskTool.create(createSession(manager, true));
		const steer = new AbortController();
		const updates: TaskToolDetails[] = [];

		const call = tool.execute(
			"tc-mixed",
			{
				context: "ctx",
				tasks: [
					{ name: "Scout", agent: "scout", task: "Research." },
					{ name: "Worker", agent: "task", task: "Build." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
			steerContext(steer),
		);
		await subagents.started("Scout", "Worker");
		steer.abort();
		const result = await call;

		expect(firstText(result)).toContain("1 subagent continues as a background job: `Scout` (job `Scout`)");
		expect(manager.getJob("Scout")?.status).toBe("running");
		expect(result.details?.async?.state).toBe("running");

		// The background worker settles first: the shared view must still count the moved scout.
		subagents.gates.get("Worker")!.resolve();
		await manager.getJob("Worker")!.promise;
		const afterWorker = updates.at(-1)!;
		expect(afterWorker.async?.state).toBe("running");

		subagents.gates.get("Scout")!.resolve();
		await manager.getJob("Scout")!.promise;
		const last = updates.at(-1)!;
		expect(last.async?.state).toBe("completed");
		expect(new Map(last.progress?.map(row => [row.id, row.status]))).toEqual(
			new Map([
				["Scout", "completed"],
				["Worker", "completed"],
			]),
		);
		expect(subagents.runs.get("Scout")).toBe(1);
	});
});
