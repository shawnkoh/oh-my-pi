/**
 * Goal mode for RPC hosts (`--mode rpc` and `--mode rpc-ui`).
 *
 * The durable lifecycle (create/resume/pause/drop, accounting, persistence) is
 * `GoalRuntime`, shared with the TUI and the `goal` tool. This controller adds
 * what `InteractiveMode` otherwise owns: the goal tool's place in the active
 * tool set, completion/drop exit, reattach after a session change, and an
 * opt-in continuation driver keyed to agent lifecycle events instead of an
 * editor idle window.
 */
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { logger } from "@oh-my-pi/pi-utils";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../../goals/settings";
import { type GoalModeState, goalContinuationActivity, goalFromModeData } from "../../goals/state";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { nextActionableTask } from "../../tools/todo";

/** `goal.continuationModes` value that enables automatic continuation for RPC hosts. */
export const RPC_GOAL_CONTINUATION_MODE = "rpc";

export type RpcGoalOp = "get" | "create" | "resume" | "pause" | "drop";

export interface RpcGoalCommand {
	op: RpcGoalOp;
	objective?: string;
	token_budget?: number;
}

export interface RpcGoalResult {
	goal: Goal | null;
	state: GoalModeState | null;
}

export type RpcGoalSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "goalRuntime"
	| "getGoalModeState"
	| "setGoalModeState"
	| "getPlanModeState"
	| "getEnabledToolNames"
	| "setActiveToolsByName"
	| "sendGoalModeContext"
	| "getTodoPhases"
	| "promptCustomMessage"
	| "isStreaming"
	| "isDisposed"
	| "hasAdmittedSubmission"
	| "queuedMessageCount"
>;

export class RpcGoalController {
	readonly #session: RpcGoalSession;
	/** Active tool set before goal mode added `goal`; restored when the goal ends. */
	#previousTools: string[] | undefined;
	/** Continuation turns submitted whose terminal `agent_end` has not arrived. */
	#pendingContinuationTurns = 0;
	#previousContinuationActivity: string | undefined;
	/** A continuation turn made no new progress; wait for the host before continuing. */
	#suppressContinuation = false;
	/** A continuation is scheduled for the next macrotask and not yet admitted. */
	#continuationScheduled = false;
	/** Tool-set restoration triggered by session events; commands and reads wait for it. */
	#exitTask: Promise<void> = Promise.resolve();

	constructor(session: RpcGoalSession) {
		this.#session = session;
	}

	/**
	 * True while a goal continuation has been decided but not yet admitted. Hosts and
	 * quiescence checks must treat the session as busy during this window.
	 */
	get continuationPending(): boolean {
		return this.#continuationScheduled;
	}

	/**
	 * The host interrupted the session (`abort`). Stop automatic continuation until
	 * the host acts again (a prompt, steer, follow-up, or `goal resume`/`create`).
	 * Called before the abort starts, so the aborted run's own `agent_end` cannot
	 * schedule another goal turn. The runtime separately pauses the interrupted goal.
	 */
	stopForHostAbort(): void {
		this.#suppressContinuation = true;
		this.#continuationScheduled = false;
	}

	get #state(): RpcGoalResult {
		const state = this.#session.getGoalModeState();
		return { goal: state?.goal ?? null, state: state ?? null };
	}

	/** Resolves once event-triggered goal exits (completion, drop) have restored the tool set. */
	settled(): Promise<void> {
		return this.#exitTask;
	}

	#queueExit(exit: () => Promise<void>): void {
		this.#exitTask = this.#exitTask.then(exit).catch(reportControllerError);
	}

	async handle(command: RpcGoalCommand): Promise<RpcGoalResult> {
		await this.#exitTask;
		switch (command.op) {
			case "get":
				return this.#state;
			case "create":
				return await this.#create(command);
			case "resume":
				return await this.#resume();
			case "pause":
				await this.#session.goalRuntime.pauseGoal();
				await this.#exit();
				return this.#state;
			case "drop":
				// The runtime's `goal_updated(dropped)` queues the exit.
				await this.#session.goalRuntime.dropGoal();
				await this.#exitTask;
				return this.#state;
			default: {
				const op: never = command.op;
				throw new Error(`Unknown goal op: ${String(op)}`);
			}
		}
	}

	#assertCanEnter(): void {
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			throw new Error("Goal mode is disabled (goal.enabled).");
		}
		if (this.#session.getPlanModeState()?.enabled) {
			throw new Error("Exit plan mode before starting a goal.");
		}
	}

	async #create(command: RpcGoalCommand): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		const objective = command.objective?.trim();
		if (!objective) throw new Error("objective is required when op=create");
		const tokenBudget = command.token_budget;
		if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
			throw new Error("token_budget must be a positive integer when provided");
		}
		const current = this.#session.getGoalModeState();
		if (current?.enabled) throw new Error("A goal is already active. Drop it before creating another.");
		if (current?.goal.status === "paused") {
			throw new Error("Resume or drop the paused goal before creating another.");
		}
		await this.#enter(() => this.#session.goalRuntime.createGoal({ objective, tokenBudget }));
		return this.#state;
	}

	async #resume(): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		const current = this.#session.getGoalModeState();
		if (current?.enabled) return this.#state;
		if (current?.goal.status !== "paused") throw new Error("No paused goal to resume.");
		await this.#enter(() => this.#session.goalRuntime.resumeGoal());
		return this.#state;
	}

	async #enter(start: () => Promise<GoalModeState>): Promise<void> {
		// Record the exact active set (a `goal` tool the host already enabled stays enabled afterwards).
		const previousTools = this.#session.getEnabledToolNames();
		this.#previousTools = previousTools;
		const state = await start();
		await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		this.#session.setGoalModeState(state);
		this.#resetContinuation();
		if (this.#session.isStreaming) {
			await this.#session.sendGoalModeContext({ deliverAs: "steer" });
			return;
		}
		this.#scheduleContinuation();
	}

	/** Restore the pre-goal tool set. Idempotent. */
	async #exit(): Promise<void> {
		const previousTools = this.#previousTools;
		this.#previousTools = undefined;
		this.#resetContinuation();
		if (previousTools) await this.#session.setActiveToolsByName(previousTools);
	}

	async #completeExit(): Promise<void> {
		const state = this.#session.getGoalModeState();
		await this.#exit();
		this.#session.setGoalModeState(undefined);
		this.#session.sessionManager.appendModeChange("none");
		this.#session.sessionManager.appendCustomEntry("goal-completed", {
			objective: state?.goal.objective,
			tokensUsed: state?.goal.tokensUsed,
			tokenBudget: state?.goal.tokenBudget,
			timeUsedSeconds: state?.goal.timeUsedSeconds,
		});
	}

	#resetContinuation(): void {
		this.#pendingContinuationTurns = 0;
		this.#previousContinuationActivity = undefined;
		this.#suppressContinuation = false;
	}

	/**
	 * Restore a goal journaled in the current session (startup, new/switch/branch/open),
	 * mirroring the TUI's reattach. Controller state from the previous session is discarded.
	 */
	async reconcile(): Promise<void> {
		this.#previousTools = undefined;
		this.#resetContinuation();
		const context = this.#session.sessionManager.buildSessionContext();
		const runtime = this.#session.goalRuntime;
		if (context.mode !== "goal" && context.mode !== "goal_paused") {
			runtime.clearAccounting();
			return;
		}
		const goal = cfgGoalEnabled.get(this.#session.settings) ? goalFromModeData(context.modeData) : undefined;
		if (!goal) {
			runtime.clearAccounting();
			this.#session.sessionManager.appendModeChange("none");
			return;
		}
		this.#session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
		const restored = await runtime.onThreadResumed();
		if (!restored?.goal) return;
		const previousTools = this.#session.getEnabledToolNames();
		this.#previousTools = previousTools;
		await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	}

	/**
	 * Feed session events. Must run before the RPC settle watcher observes the same
	 * event so a continuation is admitted before settlement is evaluated.
	 */
	observe(event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			// A host prompt re-arms continuation after a no-progress stop.
			this.#resetContinuation();
			return;
		}
		if (event.type === "goal_updated") {
			const status = event.state?.goal.status;
			if (status === "dropped") {
				this.#queueExit(() => this.#exit());
			} else if (event.state?.enabled && this.#previousTools === undefined) {
				// Created by the agent's `goal` tool rather than this controller.
				this.#previousTools = this.#session.getEnabledToolNames();
			}
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		if (this.#pendingContinuationTurns > 0) {
			this.#pendingContinuationTurns--;
			const activity = goalContinuationActivity(event.messages);
			this.#suppressContinuation = activity.length === 0 || activity === this.#previousContinuationActivity;
			this.#previousContinuationActivity = activity;
		}
		if (this.#session.getGoalModeState()?.mode === "exiting") {
			this.#queueExit(() => this.#completeExit());
			return;
		}
		this.#scheduleContinuation();
	}

	/**
	 * The continuation turn to start now, or undefined when any gate is closed.
	 * Every gate is read from the live session at submission time; there is no
	 * cached "idle" inference. A disposed session never admits a continuation.
	 */
	#continuationPrompt(): string | undefined {
		const session = this.#session;
		if (!cfgGoalContinuationModes.get(session.settings).includes(RPC_GOAL_CONTINUATION_MODE)) return undefined;
		if (this.#suppressContinuation || session.isDisposed) return undefined;
		if (session.getPlanModeState()?.enabled) return undefined;
		const state = session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return undefined;
		if (session.isStreaming || session.hasAdmittedSubmission || session.queuedMessageCount > 0) return undefined;
		const phases = session.getTodoPhases();
		if (!nextActionableTask(phases) && phases.some(phase => phase.tasks.some(task => task.status === "blocked"))) {
			return undefined;
		}
		return session.goalRuntime.buildContinuationPrompt();
	}

	/**
	 * Start the next goal turn one macrotask after the triggering event: after the
	 * run has fully yielded, and before the settle watcher's check, so the session
	 * never reports settled while a continuation is about to be admitted.
	 */
	#scheduleContinuation(): void {
		if (this.#continuationScheduled || !this.#continuationPrompt()) return;
		this.#continuationScheduled = true;
		setImmediate(() => {
			if (!this.#continuationScheduled) return;
			this.#continuationScheduled = false;
			// Re-check every gate: an abort, disposal, pause or host input may have landed meanwhile.
			const prompt = this.#continuationPrompt();
			if (!prompt) return;
			this.#pendingContinuationTurns++;
			// Admission is synchronous inside promptCustomMessage, so the gate check and
			// the admitted submission cannot be separated by another event.
			this.#session
				.promptCustomMessage({ customType: "goal-continuation", content: prompt, display: false })
				.then(dispatched => {
					if (!dispatched) this.#pendingContinuationTurns = Math.max(0, this.#pendingContinuationTurns - 1);
				}, reportControllerError);
		});
	}
}

function reportControllerError(error: unknown): void {
	logger.warn("RPC goal controller failed", { error: error instanceof Error ? error.message : String(error) });
}
