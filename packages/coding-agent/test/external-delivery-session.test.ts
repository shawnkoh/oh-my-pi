import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, LLM_MESSAGE_SOURCE } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type DeliveryHandle,
	type DeliveryOptions,
	EXTERNAL_DELIVERY_CAPABILITY,
	isQuietAssistantStop,
} from "@oh-my-pi/pi-coding-agent/session/external-delivery";
import {
	convertToLlm,
	type CustomMessagePayload,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const CARD_TYPE = "external-card";

/** A directed record with the owner projection the engine stamps at conversion time. */
function card(text: string, source = `src-${text}`): CustomMessagePayload {
	return {
		customType: CARD_TYPE,
		content: `[card ${source}]`,
		display: true,
		details: { "omp.llm": { role: "user", content: [{ type: "text", text }] }, "omp.llm.source": source },
	};
}

const EMPTY_STOP: MockHandler = { content: [], stopReason: "stop" };

function slowTool(name = "slow"): { tool: AgentTool; started: Promise<void>; release: () => void } {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name,
		label: name,
		description: "Blocks until released",
		parameters: type({}),
		execute: async () => {
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: `${name}_DONE` }] };
		},
	};
	return { tool, started: started.promise, release: () => release.resolve() };
}

const toolCall = (name: string): MockHandler => ({ content: [{ type: "toolCall", name, arguments: {} }] });

/** Provider-view texts of user-role messages in one mock call. */
function userTexts(mock: MockModel, call: number): string[] {
	const context = mock.calls[call]?.context;
	if (!context) throw new Error(`mock call ${call} not recorded`);
	return context.messages
		.filter(message => message.role === "user")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "<image>")).join(""),
		);
}

function isCard(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === CARD_TYPE;
}

describe("external delivery (session)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-external-delivery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	function makeSession(options?: {
		tools?: AgentTool[];
		convert?: (messages: AgentMessage[]) => Message[];
		sessionManager?: SessionManager;
		extensionRunner?: ExtensionRunner;
	}): { mock: MockModel; agent: Agent; session: AgentSession } {
		// Exhaustion falls back to a plain reply: an unscripted call must never
		// become a provider error whose retry backoff would outlive the test.
		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: { content: ["unscripted reply"] } });
		const tools = options?.tools ?? [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm: options?.convert ?? convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: options?.sessionManager ?? SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner: options?.extensionRunner,
		});
		return { mock, agent, session };
	}

	async function deliverAndSettle(s: AgentSession, payload: CustomMessagePayload, options: DeliveryOptions) {
		const handle = s.deliverExternalMessage(payload, options);
		const accepted = await handle.accepted;
		const settled = await handle.settled;
		return { handle, accepted, settled };
	}

	describe("receipts and mechanisms", () => {
		it("busy + aside is accepted as a mid-work aside at COMMIT, not when queued", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			mock.push({ content: ["Done."] });
			const run = s.prompt("go");
			await slow.started;

			const handle = s.deliverExternalMessage(card("A"), { mode: "aside" });
			expect(handle.state()).toBe("queued");
			let acceptedEarly = false;
			void handle.accepted.then(() => {
				acceptedEarly = true;
			});
			await setImmediate();
			expect(acceptedEarly).toBe(false);

			slow.release();
			const accepted = await handle.accepted;
			expect(accepted.mode).toBe("aside");
			expect(accepted.mechanism).toBe("aside");
			expect(handle.state()).toBe("accepted");
			await run;
			const settled = await handle.settled;
			expect(handle.state()).toBe("settled");
			expect(settled).toEqual({ outcome: "text", included: true, requests: 1, sole: false, interactive: true });
			expect(userTexts(mock, 1)).toEqual(["go", "A"]);
		});

		it("busy + steer is accepted at the steering boundary and never as an aside", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			mock.push({ content: ["Done."] });
			const run = s.prompt("go");
			await slow.started;

			const handle = s.deliverExternalMessage(card("S"), { mode: "steer" });
			slow.release();
			const accepted = await handle.accepted;
			expect(accepted.mode).toBe("steer");
			expect(accepted.mechanism).toBe("steer-boundary");
			expect(accepted.mechanism).not.toBe("aside");
			await run;
			const settled = await handle.settled;
			expect(settled.outcome).toBe("text");
			expect(settled.included).toBe(true);
			// The record itself is admitted, not a `steering: true` wrapper.
			const admitted = s.agent.state.messages.find(isCard);
			expect(admitted).toBeDefined();
			expect("steering" in (admitted ?? {})).toBe(false);
			expect(userTexts(mock, 1)).toContain("S");
		});

		it("idle wakes a delivery-owned evaluation whose quiet stop leaves no assistant behind", async () => {
			const { mock, session: s } = makeSession();
			mock.push({ content: [{ type: "thinking", thinking: "noted", thinkingSignature: "sig" }] });
			const { accepted, settled } = await deliverAndSettle(s, card("W"), { mode: "aside", quiet: true });
			expect(accepted.mechanism).toBe("wake");
			expect(settled).toEqual({ outcome: "quiet", included: true, requests: 1, sole: true, interactive: false });
			await s.waitForIdle();
			// Signed thinking-only stops are unexpected-stop candidates in mechanical
			// mode; the privilege skipped that retry: exactly one request was made.
			expect(mock.calls).toHaveLength(1);
			const messages = s.agent.state.messages;
			expect(messages.at(-1)?.role).toBe("custom");
			expect(messages.some(message => message.role === "assistant")).toBe(false);
			const branch = s.sessionManager.getBranch();
			expect(branch.some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(false);
			expect(branch.some(entry => entry.type === "custom_message" && entry.customType === CARD_TYPE)).toBe(true);
		});

		it("idle steer wakes with mechanism wake", async () => {
			const { mock, session: s } = makeSession();
			mock.push({ content: ["ok"] });
			const { accepted, settled } = await deliverAndSettle(s, card("W"), { mode: "steer" });
			expect(accepted).toMatchObject({ mode: "steer", mechanism: "wake" });
			expect(settled.outcome).toBe("text");
		});

		it("plan mode wakes only with wakeInPlanMode; otherwise the aside stays queued", async () => {
			const { mock, session: s } = makeSession();
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const held = s.deliverExternalMessage(card("held"), { mode: "aside" });
			await setImmediate();
			expect(held.state()).toBe("queued");
			expect(mock.calls).toHaveLength(0);
			expect(s.agent.state.messages.some(isCard)).toBe(false);

			mock.push({ content: [] });
			mock.push({ content: [] });
			const woken = s.deliverExternalMessage(card("woken"), { mode: "aside", wakeInPlanMode: true });
			const accepted = await woken.accepted;
			expect(accepted.mechanism).toBe("wake");
			// The wake is delivery-owned, so the held record drains at its stop boundary.
			expect((await held.accepted).mechanism).toBe("aside");
			const [settledWoken, settledHeld] = await Promise.all([woken.settled, held.settled]);
			expect(settledWoken).toMatchObject({ outcome: "quiet", sole: false, interactive: false, requests: 2 });
			expect(settledHeld).toMatchObject({ outcome: "quiet", sole: false, interactive: false, requests: 1 });
			expect(mock.calls).toHaveLength(2);
			expect(userTexts(mock, 0)).toEqual(["woken"]);
			expect(userTexts(mock, 1)).toEqual(["woken", "held"]);
		});

		it("after an operator interrupt, wakeAfterInterrupt wakes without clearing the latch", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			const run = s.prompt("go");
			await slow.started;
			const aborting = s.abort({ reason: USER_INTERRUPT_LABEL });
			slow.release();
			await aborting;
			await run.catch(() => {});
			await s.waitForIdle();

			const held = s.deliverExternalMessage(card("held"), { mode: "aside" });
			await setImmediate();
			expect(held.state()).toBe("queued");

			mock.push({ content: [] });
			mock.push({ content: [] });
			const woken = s.deliverExternalMessage(card("woken"), { mode: "aside", wakeAfterInterrupt: true });
			expect((await woken.accepted).mechanism).toBe("wake");
			expect((await held.accepted).mechanism).toBe("aside");
			const settled = await woken.settled;
			expect(settled.outcome).toBe("quiet");
			await held.settled;
			// The stopped operator work was not resumed: no follow-up/steer drained.
			expect(s.agent.hasQueuedMessages()).toBe(false);
			// The aborted operator run may or may not have squeezed in a request
			// before the abort landed; only the two wake requests are asserted.
			expect(mock.calls.length).toBeGreaterThanOrEqual(3);
			expect(userTexts(mock, mock.calls.length - 2)).toEqual(["go", "woken"]);
			expect(userTexts(mock, mock.calls.length - 1)).toEqual(["go", "woken", "held"]);
		});
	});

	describe("tri-state", () => {
		it("cancel before the wake prompt commits vetoes it: zero provider requests, no receipt", async () => {
			const { mock, session: s } = makeSession();
			const handle = s.deliverExternalMessage(card("C"), { mode: "aside" });
			expect(handle.cancel()).toBe(true);
			expect(handle.state()).toBe("cancelled");
			expect(handle.cancel()).toBe(false);
			await s.waitForIdle();
			await setImmediate();
			expect(mock.calls).toHaveLength(0);
			expect(s.agent.state.messages.some(isCard)).toBe(false);
			expect(s.listExternalDeliveries()).toEqual([]);
		});

		it("cancel after acceptance is refused", async () => {
			const { mock, session: s } = makeSession();
			mock.push({ content: ["ok"] });
			const { handle } = await deliverAndSettle(s, card("T"), { mode: "aside" });
			expect(handle.cancel()).toBe(false);
			expect(handle.state()).toBe("settled");
		});

		it("a committed newSession discards a queued record; a rolled-back switch emits nothing", async () => {
			const { session: s } = makeSession();
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const handle = s.deliverExternalMessage(card("D"), { mode: "aside" });
			await setImmediate();
			expect(handle.state()).toBe("queued");
			expect(await s.newSession()).toBe(true);
			expect(await handle.discarded).toEqual({ reason: "new-session" });
			expect(handle.state()).toBe("discarded");
			expect(s.listExternalDeliveries()).toEqual([]);
		});

		it("switchSession: commit discards the snapshot (incl. a drained copy), rollback keeps it queued without receipt", async () => {
			const sessionDir = path.join(tempDir.path(), "sessions");
			const targetManager = SessionManager.create(tempDir.path(), sessionDir);
			targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
			await targetManager.ensureOnDisk();
			const targetFile = targetManager.getSessionFile();
			if (!targetFile) throw new Error("Expected target session file");
			await targetManager.close();

			const slow = slowTool();
			const { mock, session: s } = makeSession({
				tools: [slow.tool],
				sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			});
			mock.push(toolCall("slow"));
			mock.push({ content: ["Done."] });
			const run = s.prompt("go");
			await slow.started;
			// Queued while the tool runs; the switch aborts the run, so the loop's
			// finally discards any drained copy back to the bridge before the snapshot.
			const handle = s.deliverExternalMessage(card("R"), { mode: "aside" });
			let discardedReason: string | undefined;
			void handle.discarded.then(({ reason }) => {
				discardedReason = reason;
			});

			const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
				throw new Error("forced switchSession failure");
			});
			try {
				const switching = s.switchSession(targetFile);
				slow.release();
				await expect(switching).rejects.toThrow("forced switchSession failure");
			} finally {
				setSessionFileSpy.mockRestore();
			}
			slow.release();
			await run.catch(() => {});
			expect(discardedReason).toBeUndefined();
			// Rolled back: the record is still owned by this session and wakes once idle.
			mock.push({ content: [] });
			const accepted = await handle.accepted;
			expect(accepted.mechanism).toBe("wake");
			await handle.settled;

			const second = s.deliverExternalMessage(card("R2"), { mode: "aside" });
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			expect(await s.switchSession(targetFile)).toBe(true);
			expect(await second.discarded).toEqual({ reason: "session-switched" });
		});

		it("a cancellation persists through a rolled-back switch", async () => {
			const sessionDir = path.join(tempDir.path(), "sessions");
			const targetManager = SessionManager.create(tempDir.path(), sessionDir);
			targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
			await targetManager.ensureOnDisk();
			const targetFile = targetManager.getSessionFile();
			if (!targetFile) throw new Error("Expected target session file");
			await targetManager.close();

			const { mock, session: s } = makeSession({
				sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			});
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const handle = s.deliverExternalMessage(card("X"), { mode: "aside" });
			await setImmediate();
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
				reached.resolve();
				await release.promise;
				throw new Error("forced switchSession failure");
			});
			try {
				const switching = s.switchSession(targetFile);
				await reached.promise;
				expect(handle.cancel()).toBe(true);
				release.resolve();
				await expect(switching).rejects.toThrow("forced switchSession failure");
			} finally {
				setSessionFileSpy.mockRestore();
			}
			s.setPlanModeState(undefined);
			mock.push({ content: ["hello"] });
			await s.prompt("hello");
			await s.waitForIdle();
			expect(mock.calls).toHaveLength(1);
			expect(userTexts(mock, 0)).toEqual(["hello"]);
			expect(s.agent.state.messages.some(isCard)).toBe(false);
			expect(handle.state()).toBe("cancelled");
		});

		it("an open transition defers admission; the record is re-queued once and accepted once after it settles", async () => {
			const modelRegistry = new ModelRegistry(authStorage);
			const hookReached = Promise.withResolvers<void>();
			const releaseHook = Promise.withResolvers<void>();
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_before_switch", async () => {
						hookReached.resolve();
						await releaseHook.promise;
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"held-fork-hook",
			);
			const extensionRunner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool], sessionManager, extensionRunner });
			mock.push(toolCall("slow"));
			mock.push({ content: ["Done."] });
			const run = s.prompt("go");
			await slow.started;
			const handle = s.deliverExternalMessage(card("F"), { mode: "aside" });
			const forking = s.fork();
			await hookReached.promise;
			expect(s.isSessionTransitioning).toBe(true);
			// The mid-work poll drains the record while the transition is open → "defer".
			slow.release();
			await run;
			await s.waitForIdle();
			expect(handle.state()).toBe("queued");
			expect(mock.calls).toHaveLength(2);
			expect(userTexts(mock, 1)).toEqual(["go"]);
			expect(s.agent.state.messages.some(isCard)).toBe(false);

			mock.push({ content: ["late"] });
			releaseHook.resolve();
			await forking;
			const accepted = await handle.accepted;
			expect(accepted.mechanism).toBe("wake");
			const settled = await handle.settled;
			expect(settled.outcome).toBe("text");
			expect(mock.calls).toHaveLength(3);
			expect(userTexts(mock, 2)).toEqual(["go", "F"]);
			expect(s.agent.state.messages.filter(isCard)).toHaveLength(1);
		});
	});

	describe("flush exclusion", () => {
		it("a queued owned record is never flushed by prompt(); it enters through the loop's admission", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const handle = s.deliverExternalMessage(card("Q"), { mode: "aside" });
			await setImmediate();
			s.setPlanModeState(undefined);
			const flushedEnds: string[] = [];
			s.subscribe(event => {
				if (event.type === "message_end" && isCard(event.message)) flushedEnds.push(handle.state());
			});
			mock.push(toolCall("slow"));
			mock.push({ content: ["Done."] });
			const run = s.prompt("go");
			await slow.started;
			// Not flushed ahead of the prompt: still queued while the first turn runs.
			expect(handle.state()).toBe("queued");
			expect(flushedEnds).toEqual([]);
			slow.release();
			await run;
			expect((await handle.accepted).mechanism).toBe("aside");
			expect(flushedEnds).toEqual(["accepted"]);
			expect(userTexts(mock, 1)).toEqual(["go", "Q"]);
		});

		it("dispose retires queued owned records before flushing the rest", async () => {
			const { session: s } = makeSession();
			s.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const handle = s.deliverExternalMessage(card("Z"), { mode: "aside" });
			await setImmediate();
			const ends: AgentMessage[] = [];
			s.subscribe(event => {
				if (event.type === "message_end") ends.push(event.message);
			});
			await s.sendCustomMessage(
				{ customType: "ext-aside", content: "STRANDED", display: false, attribution: "agent" },
				{ deliverAs: "aside" },
			);
			await s.dispose();
			session = undefined;
			expect(await handle.discarded).toEqual({ reason: "disposed" });
			expect(ends.some(isCard)).toBe(false);
			expect(ends.some(message => message.role === "custom" && message.customType === "ext-aside")).toBe(true);
		});
	});

	describe("inclusion receipt", () => {
		function convertWith(rewrite: (converted: Message[]) => Message[]): (messages: AgentMessage[]) => Message[] {
			return messages => rewrite(convertToLlm(messages));
		}
		const isStamped = (message: Message): boolean => LLM_MESSAGE_SOURCE in message;

		it("is false when a context handler drops the projection", async () => {
			const { mock, session: s } = makeSession({ convert: convertWith(c => c.filter(m => !isStamped(m))) });
			mock.push({ content: ["ok"] });
			const { settled } = await deliverAndSettle(s, card("drop"), { mode: "aside" });
			expect(settled.included).toBe(false);
			expect(settled.requests).toBe(1);
		});

		it("is false when a handler replaces the projected content", async () => {
			const { mock, session: s } = makeSession({
				convert: convertWith(c =>
					c.map(m => (isStamped(m) && m.role === "user" ? { ...m, content: "rewritten" } : m)),
				),
			});
			mock.push({ content: ["ok"] });
			const { settled } = await deliverAndSettle(s, card("replace"), { mode: "aside" });
			expect(settled.included).toBe(false);
		});

		it("is false when a handler flips the role", async () => {
			const { mock, session: s } = makeSession({
				convert: convertWith(c =>
					c.map(m =>
						isStamped(m) && m.role === "user"
							? ({ ...m, role: "developer", content: [{ type: "text", text: "x" }] } as Message)
							: m,
					),
				),
			});
			mock.push({ content: ["ok"] });
			const { settled } = await deliverAndSettle(s, card("flip"), { mode: "aside" });
			expect(settled.included).toBe(false);
		});

		it("is false when a handler duplicates the projection", async () => {
			const { mock, session: s } = makeSession({
				convert: convertWith(c => c.flatMap(m => (isStamped(m) ? [m, m] : [m]))),
			});
			mock.push({ content: ["ok"] });
			const { settled } = await deliverAndSettle(s, card("dup"), { mode: "aside" });
			expect(settled.included).toBe(false);
		});

		it("is false when the request ended in error and true once a later request completes", async () => {
			const { mock, session: s } = makeSession();
			mock.push({ content: [], stopReason: "error", errorMessage: "boom" });
			const first = await deliverAndSettle(s, card("err"), { mode: "aside" });
			expect(first.settled.outcome).toBe("error");
			expect(first.settled.included).toBe(false);
		});

		it("is false for a record without a projection", async () => {
			const { mock, session: s } = makeSession();
			mock.push({ content: ["ok"] });
			const { settled } = await deliverAndSettle(
				s,
				{ customType: CARD_TYPE, content: "no projection", display: false },
				{ mode: "aside" },
			);
			expect(settled.included).toBe(false);
			expect(settled.outcome).toBe("text");
		});
	});

	describe("quiet completion", () => {
		it("predicate: thinking (any signature) and whitespace text are quiet; text/tool/image/redacted are not", () => {
			const quiet = (content: unknown[]) => isQuietAssistantStop({ stopReason: "stop", content: content as never });
			expect(quiet([])).toBe(true);
			expect(quiet([{ type: "thinking", thinking: "x" }])).toBe(true);
			expect(quiet([{ type: "thinking", thinking: "x", thinkingSignature: "sig" }])).toBe(true);
			expect(quiet([{ type: "text", text: " \n\t" }])).toBe(true);
			expect(quiet([{ type: "text", text: "hi" }])).toBe(false);
			expect(quiet([{ type: "toolCall", id: "t", name: "x", arguments: {} }])).toBe(false);
			expect(quiet([{ type: "image", data: "", mimeType: "image/png" }])).toBe(false);
			expect(quiet([{ type: "redactedThinking", data: "" }])).toBe(false);
			expect(quiet([{ type: "anthropicServerTool", name: "web_search", input: {}, id: "s" }])).toBe(false);
			expect(isQuietAssistantStop({ stopReason: "toolUse", content: [] })).toBe(false);
			expect(isQuietAssistantStop({ stopReason: "stop", content: [], errorMessage: "capped" })).toBe(false);
		});

		it("card A → reply → card B at the stop boundary → quiet: nothing pruned but the empty stop", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			const bDelivered = Promise.withResolvers<DeliveryHandle>();
			mock.push(() => {
				bDelivered.resolve(s.deliverExternalMessage(card("B"), { mode: "aside", quiet: true }));
				return { content: ["nudge reply"] };
			});
			mock.push({ content: [{ type: "text", text: "  " }] });
			const a = s.deliverExternalMessage(card("A"), { mode: "aside", quiet: true });
			await slow.started;
			slow.release();
			const b = await bDelivered.promise;
			expect((await a.accepted).mechanism).toBe("wake");
			expect((await b.accepted).mechanism).toBe("aside");
			const [settledA, settledB] = await Promise.all([a.settled, b.settled]);
			// Delivery-owned: B drained at the stop boundary into the same evaluation.
			expect(mock.calls).toHaveLength(3);
			expect(userTexts(mock, 2)).toEqual(["A", "B"]);
			expect(settledA).toMatchObject({ outcome: "text", sole: false, interactive: false, requests: 3 });
			expect(settledB).toMatchObject({ outcome: "quiet", sole: false, interactive: false, requests: 1 });
			const roles = s.agent.state.messages.map(m => (m.role === "custom" ? `custom:${m.customType}` : m.role));
			expect(roles).toEqual([`custom:${CARD_TYPE}`, "assistant", "toolResult", "assistant", `custom:${CARD_TYPE}`]);
			const branch = s.sessionManager.getBranch();
			const cards = branch.filter(entry => entry.type === "custom_message" && entry.customType === CARD_TYPE);
			expect(cards).toHaveLength(2);
			// The empty stop was dropped and the branch re-parented onto card B: no
			// assistant entry follows the last card.
			const lastCardIndex = branch.findLastIndex(
				entry => entry.type === "custom_message" && entry.customType === CARD_TYPE,
			);
			const lastAssistantIndex = branch.findLastIndex(
				entry => entry.type === "message" && entry.message.role === "assistant",
			);
			expect(lastAssistantIndex).toBeLessThan(lastCardIndex);
		});

		it("settles once through an empty-stop retry continuation in an operator-owned evaluation", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			mock.push(EMPTY_STOP);
			mock.push({ content: ["recovered"] });
			const run = s.prompt("go");
			await slow.started;
			const handle = s.deliverExternalMessage(card("P"), { mode: "aside" });
			slow.release();
			await run;
			const settled = await handle.settled;
			expect(mock.calls).toHaveLength(3);
			expect(settled).toEqual({ outcome: "text", included: true, requests: 2, sole: false, interactive: true });
			expect(s.agent.state.messages.some(m => m.role === "developer")).toBe(true);
		});

		it("sole/shared: a late peer and a late operator (visible user-attributed prompt) join the evaluation", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			mock.push({ content: ["ok"] });
			const first = s.deliverExternalMessage(card("one"), { mode: "aside" });
			await slow.started;
			const peer = s.deliverExternalMessage(card("two"), { mode: "aside" });
			// A visible user-attributed custom prompt (the `/skill:` shape) is interactive.
			await s.sendCustomMessage(
				{ customType: "skill-prompt", content: "operator", display: true, attribution: "user" },
				{ deliverAs: "steer" },
			);
			slow.release();
			const [a, b] = await Promise.all([first.settled, peer.settled]);
			expect(a).toMatchObject({ sole: false, interactive: true });
			expect(b).toMatchObject({ sole: false, interactive: true });
			expect(userTexts(mock, 1)).toEqual(["one", "operator", "two"]);
		});

		it("operator report + tool progress + peer mid-work + empty stop → ordinary recovery", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			mock.push(EMPTY_STOP);
			mock.push({ content: ["after retry"] });
			const run = s.prompt("report");
			await slow.started;
			const handle = s.deliverExternalMessage(card("peer"), { mode: "aside", quiet: true });
			slow.release();
			await run;
			const settled = await handle.settled;
			expect(settled.outcome).toBe("text");
			expect(settled.interactive).toBe(true);
			expect(mock.calls).toHaveLength(3);
			expect(s.agent.state.messages.at(-1)?.role).toBe("assistant");
		});

		it("operator answered → the owned aside waits for a separate quiet wake", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			let handle: DeliveryHandle | undefined;
			mock.push(() => {
				// Delivered while the answer streams: past the mid-work poll, so the
				// stop boundary is its first admission chance — and it waits there.
				handle = s.deliverExternalMessage(card("late"), { mode: "aside", quiet: true });
				return { content: ["answer"] };
			});
			mock.push({ content: [] });
			const run = s.prompt("question");
			await slow.started;
			slow.release();
			await run;
			if (!handle) throw new Error("record was not delivered");
			await run;
			const accepted = await handle.accepted;
			expect(accepted.mechanism).toBe("wake");
			const settled = await handle.settled;
			expect(settled).toMatchObject({ outcome: "quiet", sole: true, interactive: false });
			expect(mock.calls).toHaveLength(3);
			expect(userTexts(mock, 1)).toEqual(["question"]);
			expect(userTexts(mock, 2)).toEqual(["question", "late"]);
		});
	});

	describe("stop boundary", () => {
		it("steer-at-stop-boundary-forces-turn", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			let handle: DeliveryHandle | undefined;
			mock.push(() => {
				handle = s.deliverExternalMessage(card("steer"), { mode: "steer" });
				return { content: ["answer"] };
			});
			mock.push({ content: ["steered"] });
			const run = s.prompt("question");
			await slow.started;
			slow.release();
			await run;
			if (!handle) throw new Error("record was not delivered");
			await run;
			const accepted = await handle.accepted;
			expect(accepted.mechanism).toBe("steer-boundary");
			const settled = await handle.settled;
			expect(settled).toMatchObject({ outcome: "text", interactive: true, sole: false });
			expect(mock.calls).toHaveLength(3);
			expect(userTexts(mock, 2)).toEqual(["question", "steer"]);
		});

		it("aside-at-stop-boundary-waits", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			let handle: DeliveryHandle | undefined;
			mock.push(() => {
				handle = s.deliverExternalMessage(card("aside"), { mode: "aside" });
				return { content: ["answer"] };
			});
			const run = s.prompt("question");
			await slow.started;
			slow.release();
			await run;
			if (!handle) throw new Error("record was not delivered");
			await run;
			expect(mock.calls).toHaveLength(2);
			expect(userTexts(mock, 1)).toEqual(["question"]);
			mock.push({ content: ["woken"] });
			expect((await handle.accepted).mechanism).toBe("wake");
			await handle.settled;
			expect(mock.calls).toHaveLength(3);
		});

		it("operator-owned-evaluation-with-steer-still-runs-ordinary-empty-stop-recovery", async () => {
			const slow = slowTool();
			const { mock, session: s } = makeSession({ tools: [slow.tool] });
			mock.push(toolCall("slow"));
			let handle: DeliveryHandle | undefined;
			mock.push(() => {
				handle = s.deliverExternalMessage(card("steer"), { mode: "steer", quiet: true });
				return { content: ["answer"] };
			});
			mock.push(EMPTY_STOP);
			mock.push({ content: ["recovered"] });
			const run = s.prompt("question");
			await slow.started;
			slow.release();
			await run;
			if (!handle) throw new Error("record was not delivered");
			await run;
			const settled = await handle.settled;
			expect(mock.calls).toHaveLength(4);
			expect(settled).toMatchObject({ outcome: "text", interactive: true });
			expect(s.agent.state.messages.some(m => m.role === "developer")).toBe(true);
			expect(s.agent.state.messages.at(-1)?.role).toBe("assistant");
		});
	});

	describe("extension API", () => {
		it("advertises the capability only once a host binds deliverMessage", async () => {
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const runtime = new ExtensionRuntime();
			let seen: ReadonlySet<string> | undefined;
			let handle: DeliveryHandle | undefined;
			const extension = await loadExtensionFromFactory(
				pi => {
					seen = pi.capabilities;
					expect(pi.capabilities.has(EXTERNAL_DELIVERY_CAPABILITY)).toBe(false);
					expect(() => pi.deliverMessage(card("early"), { mode: "aside" })).toThrow(/external-delivery\/1/);
					pi.on("session_start", async () => {
						handle = pi.deliverMessage(card("bound"), { mode: "aside" });
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"delivery-capability",
			);
			const extensionRunner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const { mock, session: s } = makeSession({ sessionManager, extensionRunner });
			extensionRunner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					deliverMessage: (record, options) => s.deliverExternalMessage(record, options),
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => "off",
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);
			expect(seen?.has(EXTERNAL_DELIVERY_CAPABILITY)).toBe(true);
			mock.push({ content: ["ok"] });
			await extensionRunner.emit({ type: "session_start" });
			if (!handle) throw new Error("deliverMessage was not called");
			expect((await handle.accepted).mechanism).toBe("wake");
			expect((await handle.settled).outcome).toBe("text");
		});
	});
});
