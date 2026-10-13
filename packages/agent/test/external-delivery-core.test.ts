import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import { convertMessageToLlm, defaultConvertToLlm } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	OwnedAsideAdmission,
	OwnedAsideMessage,
	StreamFn,
} from "@oh-my-pi/pi-agent-core/types";
import {
	ASIDE_MESSAGE_ADMIT,
	ASIDE_MESSAGE_COMMIT,
	ASIDE_MESSAGE_DEFER,
	ASIDE_MESSAGE_DISCARD,
	isOwnedAsideMessage,
	LLM_MESSAGE_SOURCE,
} from "@oh-my-pi/pi-agent-core/types";
import type { LiveSteering, Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

type Decision = OwnedAsideAdmission;

interface OwnedRecord {
	record: OwnedAsideMessage;
	/** Next admission answer; mutable so a test can cancel mid-flight. */
	decision: Decision;
	counts: { admit: number; commit: number; defer: number; discard: number };
}

/** An owned external record whose provider view is `text`; its display header never reaches the model. */
function createOwnedRecord(text: string, decision: Decision = "admit"): OwnedRecord {
	const counts = { admit: 0, commit: 0, defer: 0, discard: 0 };
	const owned: OwnedRecord = { decision, counts, record: undefined as unknown as OwnedAsideMessage };
	owned.record = {
		role: "custom",
		customType: "external-delivery",
		content: `header: ${text}`,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
		details: {
			"omp.llm": { role: "user", content: [{ type: "text", text }] },
			"omp.llm.source": `source:${text}`,
		},
		[ASIDE_MESSAGE_ADMIT]: () => {
			counts.admit++;
			return owned.decision;
		},
		[ASIDE_MESSAGE_DEFER]: () => {
			counts.defer++;
		},
		[ASIDE_MESSAGE_COMMIT]: () => {
			counts.commit++;
		},
		[ASIDE_MESSAGE_DISCARD]: () => {
			counts.discard++;
		},
	};
	return owned;
}

function textOf(message: Message): string {
	if (message.role === "assistant") {
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : `<${part.type}>`)).join("");
}

function sourceOf(message: Message): unknown {
	return Reflect.get(message, LLM_MESSAGE_SOURCE);
}

interface LoopRun {
	events: AgentEvent[];
	transcript: AgentMessage[];
	/** Provider-visible text of every request, in call order. */
	contexts: string[][];
}

async function runAgentLoop(
	prompts: AgentMessage[],
	config: Omit<AgentLoopConfig, "model" | "convertToLlm"> & Partial<Pick<AgentLoopConfig, "convertToLlm">>,
	responses: MockResponse[],
	tools: AgentTool[] = [],
	streamFn?: (mockStream: StreamFn) => StreamFn,
): Promise<LoopRun> {
	const mock = createMockModel({ responses });
	const contexts: string[][] = [];
	const recording: StreamFn = (model, context, options) => {
		contexts.push(context.messages.map(textOf));
		return mock.stream(model, context, options);
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const run = agentLoop(
		prompts,
		context,
		{ model: mock.model, convertToLlm: defaultConvertToLlm, ...config },
		undefined,
		streamFn ? streamFn(recording) : recording,
	);
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return { events, transcript: await run.result(), contexts };
}

const echoSchema = type({ value: "string" });
const echoTool: AgentTool<typeof echoSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echoes its argument",
	parameters: echoSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
	},
};
const echoCall: MockResponse = {
	content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "worked" } }],
};

/** A plain (unowned) custom record with the given details, as a persisted session would replay it. */
function customRecord(details: unknown, attribution: "agent" | "user" = "agent"): AgentMessage {
	return {
		role: "custom",
		customType: "external-delivery",
		content: "header: x",
		display: true,
		attribution,
		timestamp: 7,
		details,
	};
}

describe("external delivery: provider projection", () => {
	it("projects details['omp.llm'] as a stamped user message and keeps the display header out", () => {
		const { record } = createOwnedRecord("please review");
		const converted = convertMessageToLlm(record);
		const expected: Message & { [LLM_MESSAGE_SOURCE]: string } = {
			role: "user",
			content: [{ type: "text", text: "please review" }],
			attribution: "agent",
			timestamp: record.timestamp,
			[LLM_MESSAGE_SOURCE]: "source:please review",
		};
		expect(converted).toEqual(expected);
		expect(JSON.stringify(converted)).not.toContain("header:");
	});

	it("keeps an explicit attribution and accepts string content and hook messages", () => {
		const projection = { "omp.llm": { role: "user", content: "plain text" }, "omp.llm.source": "s1" };
		expect(convertMessageToLlm(customRecord(projection, "user"))).toMatchObject({
			role: "user",
			attribution: "user",
		});

		const hook: AgentMessage = {
			role: "hookMessage",
			customType: "legacy",
			content: "header",
			display: true,
			timestamp: 1,
			details: projection,
		};
		const expected: Message & { [LLM_MESSAGE_SOURCE]: string } = {
			role: "user",
			content: "plain text",
			attribution: "agent",
			timestamp: 1,
			[LLM_MESSAGE_SOURCE]: "s1",
		};
		expect(convertMessageToLlm(hook)).toEqual(expected);
	});

	it("falls back to the developer conversion for every other shape", () => {
		const expected: Message = {
			role: "developer",
			content: [{ type: "text", text: "header: x" }],
			attribution: "agent",
			timestamp: 7,
		};
		const malformed: unknown[] = [
			undefined,
			{ other: 1 },
			{ "omp.llm": "text" },
			{ "omp.llm": { role: "developer", content: "x" } },
			{ "omp.llm": { role: "user" } },
			{ "omp.llm": { role: "user", content: 42 } },
			{ "omp.llm": { role: "user", content: [{ type: "text" }] } },
			{ "omp.llm": { role: "user", content: [{ type: "file", data: "" }] } },
			{ "omp.llm": { role: "user", content: [{ type: "image", data: "abc" }] } },
			{ "omp.llm": { role: "user", content: [{ type: "text", text: "ok" }, null] } },
		];
		for (const details of malformed) {
			const converted = convertMessageToLlm(customRecord(details));
			expect(converted).toEqual(expected);
			expect(sourceOf(converted as Message)).toBeUndefined();
		}
	});

	it("stamps undefined when the source is missing or not a string, without losing the projection", () => {
		const noSource = convertMessageToLlm(customRecord({ "omp.llm": { role: "user", content: "t" } }));
		expect(noSource?.role).toBe("user");
		expect(sourceOf(noSource as Message)).toBeUndefined();
		const numericSource = convertMessageToLlm(
			customRecord({ "omp.llm": { role: "user", content: "t" }, "omp.llm.source": 7 }),
		);
		expect(numericSource?.role).toBe("user");
		expect(sourceOf(numericSource as Message)).toBeUndefined();
	});

	it("survives a JSON round-trip of the record", () => {
		const { record } = createOwnedRecord("persisted");
		const revived: AgentMessage = JSON.parse(JSON.stringify(record));
		expect(isOwnedAsideMessage(revived)).toBe(false);
		const converted = convertMessageToLlm(revived);
		expect(converted).toEqual(convertMessageToLlm(record));
		expect(sourceOf(converted as Message)).toBe("source:persisted");
		expect(defaultConvertToLlm([revived]).map(textOf)).toEqual(["persisted"]);
	});
});

describe("external delivery: prompt commit", () => {
	it("admits an owned prompt: appended, committed once, provider sees only the projection", async () => {
		const owned = createOwnedRecord("review this");
		const { events, transcript, contexts } = await runAgentLoop([owned.record], {}, [{ content: ["ok"] }]);

		expect(contexts).toEqual([["review this"]]);
		expect(transcript[0]).toBe(owned.record);
		expect(owned.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
		expect(events.filter(e => e.type === "message_start" && e.message === owned.record)).toHaveLength(1);
	});

	it("drops a vetoed owned prompt: no request, agent_start then agent_end with no messages", async () => {
		const owned = createOwnedRecord("cancelled", "drop");
		const deferred: AgentMessage[][] = [];
		const { events, transcript, contexts } = await runAgentLoop(
			[owned.record],
			{ onDeferredMessages: messages => deferred.push(messages) },
			[],
		);

		expect(events.map(e => e.type)).toEqual(["agent_start", "agent_end"]);
		expect(transcript).toEqual([]);
		expect(contexts).toEqual([]);
		expect(deferred).toEqual([]);
		expect(owned.counts).toEqual({ admit: 1, commit: 0, defer: 0, discard: 0 });
	});

	it("defers an owned prompt to the host once and admits it on the re-run", async () => {
		const owned = createOwnedRecord("later", "defer");
		const deferred: AgentMessage[][] = [];
		const first = await runAgentLoop([owned.record], { onDeferredMessages: messages => deferred.push(messages) }, []);
		expect(first.events.map(e => e.type)).toEqual(["agent_start", "agent_end"]);
		expect(first.contexts).toEqual([]);
		expect(deferred).toEqual([[owned.record]]);
		expect(owned.counts).toEqual({ admit: 1, commit: 0, defer: 1, discard: 0 });

		owned.decision = "admit";
		const second = await runAgentLoop([owned.record], { onDeferredMessages: messages => deferred.push(messages) }, [
			{ content: ["ok"] },
		]);
		expect(second.contexts).toEqual([["later"]]);
		expect(deferred).toHaveLength(1);
		expect(owned.counts).toEqual({ admit: 2, commit: 1, defer: 1, discard: 0 });
	});

	it("keeps a vetoed owned prompt out while admitting the prompts beside it, in order", async () => {
		const dropped = createOwnedRecord("gone", "drop");
		const admitted = createOwnedRecord("kept");
		const { transcript, contexts } = await runAgentLoop(
			[dropped.record, createUserMessage("hello"), admitted.record],
			{},
			[{ content: ["ok"] }],
		);

		expect(contexts).toEqual([["hello", "kept"]]);
		expect(transcript.map(m => m.role)).toEqual(["user", "custom", "assistant"]);
		expect(transcript).not.toContain(dropped.record);
		expect(dropped.counts.commit).toBe(0);
		expect(admitted.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
	});
});

describe("external delivery: loop-top commit", () => {
	it("admits, defers or drops owned asides at the mid-work boundary and admits the re-queued one later", async () => {
		const admitted = createOwnedRecord("admit me");
		const deferred = createOwnedRecord("defer me", "defer");
		const dropped = createOwnedRecord("drop me", "drop");
		const handedToHost: AgentMessage[][] = [];
		let requeued: AgentMessage[] = [];
		let midWorkOffered = false;
		const boundaries: boolean[] = [];
		const { contexts } = await runAgentLoop(
			[createUserMessage("start")],
			{
				onDeferredMessages: messages => {
					handedToHost.push(messages);
					for (const message of messages) {
						if (!isOwnedAsideMessage(message)) throw new Error("expected an owned record");
						// Host re-queues once, for a later boundary; the owner admits it then.
						deferred.decision = "admit";
						requeued = [...requeued, message];
					}
				},
				getAsideMessages: async boundary => {
					if (!boundary) throw new Error("boundary was not passed");
					boundaries.push(boundary.atStopBoundary);
					if (!boundary.atStopBoundary && !midWorkOffered) {
						midWorkOffered = true;
						return [admitted.record, deferred.record, dropped.record];
					}
					return requeued.splice(0);
				},
			},
			[echoCall, { content: ["second"] }, { content: ["third"] }],
			[echoTool],
		);

		expect(boundaries).toEqual([false, true, true]);
		expect(contexts).toHaveLength(3);
		expect(contexts[1]).toEqual(["start", "", "worked", "admit me"]);
		expect(contexts[2]).toEqual(["start", "", "worked", "admit me", "second", "defer me"]);
		expect(handedToHost).toEqual([[deferred.record]]);
		expect(admitted.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
		expect(deferred.counts).toEqual({ admit: 2, commit: 1, defer: 1, discard: 0 });
		expect(dropped.counts).toEqual({ admit: 1, commit: 0, defer: 0, discard: 0 });
	});

	it("ends without another request when every stop-boundary steering record is vetoed", async () => {
		const dropped = createOwnedRecord("cancelled", "drop");
		let offered = false;
		const { events, contexts, transcript } = await runAgentLoop(
			[createUserMessage("start")],
			{
				getSteeringMessages: async () => {
					if (offered) return [];
					offered = true;
					return [dropped.record];
				},
			},
			[{ content: ["first"] }],
		);

		expect(contexts).toHaveLength(1);
		expect(transcript.map(textOf as (m: AgentMessage) => string)).toEqual(["start", "first"]);
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(dropped.counts).toEqual({ admit: 1, commit: 0, defer: 0, discard: 0 });
	});

	it("ends without another request when every drained stop-boundary aside is vetoed", async () => {
		const dropped = createOwnedRecord("cancelled", "drop");
		let offered = false;
		const polls: boolean[] = [];
		const { contexts } = await runAgentLoop(
			[createUserMessage("start")],
			{
				getAsideMessages: async boundary => {
					polls.push(boundary?.atStopBoundary === true);
					if (offered) return [];
					offered = true;
					return [dropped.record];
				},
			},
			[{ content: ["first"] }],
		);

		expect(contexts).toHaveLength(1);
		expect(polls).toEqual([true, true]);
		expect(dropped.counts).toEqual({ admit: 1, commit: 0, defer: 0, discard: 0 });
	});
});

/** Runs a conversation whose first provider call drives `steer` against the offered live-steering source. */
function liveSteeringRun(
	queue: AgentMessage[],
	steer: (live: LiveSteering) => Promise<void>,
	responses: MockResponse[],
	config: Partial<AgentLoopConfig> = {},
): Promise<LoopRun> {
	return runAgentLoop(
		[createUserMessage("start")],
		{
			getSteeringMessages: async () => queue.splice(0),
			waitForSteeringMessages: async () => {},
			...config,
		},
		responses,
		[],
		mockStream => async (model, context, options) => {
			if (!options?.liveSteering) throw new Error("live steering was not offered");
			if (context.messages.length === 1) await steer(options.liveSteering);
			return mockStream(model, context, options);
		},
	);
}

describe("external delivery: live steering exclusion", () => {
	it("holds an owned batch for the boundary: no live conversion, no write, one boundary acceptance", async () => {
		const owned = createOwnedRecord("review this");
		const queue: AgentMessage[] = [];
		let conversionsWithRecord = 0;
		let claimed = true;
		const { contexts, transcript } = await liveSteeringRun(
			queue,
			async live => {
				queue.push(owned.record);
				claimed = (await live.claim(new AbortController().signal)) !== undefined;
			},
			[{ content: ["first"] }, { content: ["second"] }],
			{
				convertToLlm: messages => {
					if (messages.includes(owned.record)) conversionsWithRecord++;
					return defaultConvertToLlm(messages);
				},
			},
		);

		expect(claimed).toBe(false);
		expect(contexts).toEqual([["start"], ["start", "first", "review this"]]);
		expect(conversionsWithRecord).toBe(1);
		expect(transcript).toContain(owned.record);
		expect(owned.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
	});

	it("defers a mixed [human, owned] batch whole and keeps boundary order", async () => {
		const owned = createOwnedRecord("owned note");
		const human = createUserMessage("use tabs");
		const queue: AgentMessage[] = [];
		let claimed = true;
		const { contexts, transcript } = await liveSteeringRun(
			queue,
			async live => {
				queue.push(human, owned.record);
				claimed = (await live.claim(new AbortController().signal)) !== undefined;
			},
			[{ content: ["first"] }, { content: ["second"] }],
		);

		expect(claimed).toBe(false);
		expect(contexts[1]).toEqual(["start", "first", "use tabs", "owned note"]);
		expect(transcript.indexOf(human)).toBeLessThan(transcript.indexOf(owned.record));
		expect(human.liveSteered).toBeUndefined();
		expect(owned.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
	});

	it("still delivers a human-only batch live (control)", async () => {
		const human = createUserMessage("use tabs");
		const queue: AgentMessage[] = [];
		let claimedView: string[] | undefined;
		const { contexts } = await liveSteeringRun(
			queue,
			async live => {
				queue.push(human);
				const claim = await live.claim(new AbortController().signal);
				claimedView = claim?.messages.map(textOf);
				claim?.accept();
			},
			[{ content: ["first"] }, { content: ["second"] }],
		);

		expect(claimedView).toEqual(["use tabs"]);
		expect(contexts[1]).toEqual(["start", "first", "use tabs"]);
		expect(human.liveSteered).toBe(true);
	});

	it("drops an owned record cancelled between the live dequeue and the boundary: no write, no commit", async () => {
		const owned = createOwnedRecord("stale");
		const queue: AgentMessage[] = [];
		let claimed = true;
		const { contexts, transcript } = await liveSteeringRun(
			queue,
			async live => {
				queue.push(owned.record);
				claimed = (await live.claim(new AbortController().signal)) !== undefined;
				owned.decision = "drop";
			},
			[{ content: ["first"] }],
		);

		expect(claimed).toBe(false);
		expect(contexts).toEqual([["start"]]);
		expect(transcript).not.toContain(owned.record);
		expect(owned.counts).toEqual({ admit: 1, commit: 0, defer: 0, discard: 0 });
	});
});

describe("external delivery: stop-boundary semantics", () => {
	it("a queued steer forces the next turn while an aside waits for the drain", async () => {
		const steer = createUserMessage("steer now");
		const aside = createOwnedRecord("aside later");
		let steerOffered = false;
		let asideOffered = false;
		const boundaries: boolean[] = [];
		let providerCalls = 0;
		const { contexts } = await runAgentLoop(
			[createUserMessage("start")],
			{
				getSteeringMessages: async () => {
					// Queued while the model produced "second"; dequeued at that stop boundary.
					if (steerOffered || providerCalls < 2) return [];
					steerOffered = true;
					return [steer];
				},
				getAsideMessages: async boundary => {
					boundaries.push(boundary?.atStopBoundary === true);
					if (asideOffered || !boundary?.atStopBoundary) return [];
					asideOffered = true;
					return [aside.record];
				},
			},
			[echoCall, { content: ["second"] }, { content: ["third"] }, { content: ["fourth"] }],
			[echoTool],
			mockStream => (model, context, options) => {
				providerCalls++;
				return mockStream(model, context, options);
			},
		);

		expect(contexts).toHaveLength(4);
		// Mid-work poll, then the drain twice: the steer's turn ran without any aside poll in between.
		expect(boundaries).toEqual([false, true, true]);
		expect(contexts[2]).toEqual(["start", "", "worked", "second", "steer now"]);
		expect(contexts[3]).toEqual(["start", "", "worked", "second", "steer now", "third", "aside later"]);
		expect(aside.counts).toEqual({ admit: 1, commit: 1, defer: 0, discard: 0 });
	});
});

describe("external delivery: Agent bookkeeping", () => {
	it("forgets vetoed steering instead of restoring it to the queue, without losing later records", async () => {
		const mock = createMockModel({ responses: [{ content: ["first"] }] });
		const agent = new Agent({ streamFn: mock.stream, steeringMode: "all" });
		const dropped = createOwnedRecord("cancelled", "drop");
		const deferred = createOwnedRecord("later", "defer");
		const human = createUserMessage("also this");
		const handedToHost: AgentMessage[][] = [];
		agent.onDeferredMessages = messages => handedToHost.push(messages);
		agent.steer(dropped.record);
		agent.steer(deferred.record);
		agent.steer(human);

		await agent.prompt("start");

		expect(handedToHost).toEqual([[deferred.record]]);
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.state.messages.filter(m => m === human)).toHaveLength(1);
		expect(agent.state.messages).not.toContain(dropped.record);
		expect(agent.state.messages).not.toContain(deferred.record);
		expect(mock.calls[0]?.context.messages.map(textOf)).toEqual(["start", "also this"]);
	});

	it("wakes with a deferred prompt as an empty run and admits it on the next wake", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		const owned = createOwnedRecord("wake", "defer");
		const handedToHost: AgentMessage[][] = [];
		agent.onDeferredMessages = messages => handedToHost.push(messages);
		const types: string[] = [];
		agent.subscribe(event => types.push(event.type));

		await agent.prompt(owned.record);
		expect(types).toEqual(["agent_start", "agent_end"]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(handedToHost).toEqual([[owned.record]]);
		expect(mock.calls).toHaveLength(0);

		owned.decision = "admit";
		await agent.prompt(owned.record);
		expect(agent.state.messages[0]).toBe(owned.record);
		expect(mock.calls).toHaveLength(1);
		expect(owned.counts).toEqual({ admit: 2, commit: 1, defer: 1, discard: 0 });
	});

	it("passes the boundary to the aside provider and applies a swapped converter on the next request", async () => {
		const mock = createMockModel({ responses: [echoCall, { content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, tools: [echoTool], messages: [] },
			streamFn: mock.stream,
		});
		const boundaries: Array<{ atStopBoundary: boolean }> = [];
		agent.setAsideMessageProvider(boundary => {
			boundaries.push(boundary);
			return [];
		});
		const inner = agent.getConvertToLlm();
		const seen: string[][] = [];
		agent.setConvertToLlm(async messages => {
			const converted = await inner(messages);
			seen.push(converted.map(textOf));
			return converted;
		});

		await agent.prompt("start");

		expect(boundaries).toEqual([{ atStopBoundary: false }, { atStopBoundary: true }]);
		expect(seen).toEqual([["start"], ["start", "", "worked"]]);
	});
});
