import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown>;

function card(text: string, source: string, header = `[card ${source}]`) {
	return {
		customType: "external-card",
		content: header,
		display: true,
		details: { "omp.llm": { role: "user", content: [{ type: "text", text }] }, "omp.llm.source": source },
	};
}

describe("external delivery over RPC", () => {
	let directory: string;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-delivery-"));
	});

	afterEach(async () => {
		child?.kill();
		await child?.exited;
		child = undefined;
		await removeWithRetries(directory);
	});

	function start(fixtureEnv: Record<string, string> = {}) {
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "external-delivery-rpc-agent.ts")],
			{
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1", NO_COLOR: "1", ...fixtureEnv },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		child = proc;
		const stderr = new Response(proc.stderr).text();
		const lines = readLines(proc.stdout, AbortSignal.timeout(30_000));
		const decoder = new TextDecoder();
		const received: Frame[] = [];
		const receive = async (): Promise<Frame> => {
			const line = await lines.next();
			if (line.done) throw new Error(`RPC child ended: ${await stderr}`);
			const frame = JSON.parse(decoder.decode(line.value)) as Frame;
			received.push(frame);
			return frame;
		};
		let id = 0;
		const command = async (fields: object): Promise<Frame> => {
			const requestId = `cmd-${++id}`;
			proc.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
			await proc.stdin.flush();
			for (;;) {
				const frame = await receive();
				if (frame.type === "response" && frame.id === requestId) return frame;
			}
		};
		/** Reads until a frame satisfies `match`, returning it. */
		const until = async (match: (frame: Frame) => boolean): Promise<Frame> => {
			for (const frame of received) if (match(frame)) return frame;
			for (;;) {
				const frame = await receive();
				if (match(frame)) return frame;
			}
		};
		/** Writes several frames in one stdin write, so the engine reads them back to back. */
		const pipeline = async (frames: object[]): Promise<void> => {
			proc.stdin.write(frames.map(frame => `${JSON.stringify(frame)}\n`).join(""));
			await proc.stdin.flush();
		};
		return { command, until, received, receive, pipeline };
	}

	test("the ready frame advertises the capability before any command", async () => {
		const rpc = start();
		const ready = await rpc.receive();
		expect(ready.type).toBe("ready");
		expect(ready.capabilities).toContain("external-delivery/1");
		// Advertised before negotiation: a v1-only host can read it from the first frame.
		expect(rpc.received.length).toBe(1);
		// The same list is queryable without side effects before any effectful command.
		const state = await rpc.command({ type: "get_state" });
		expect(state.success).toBe(true);
		expect(state.data).toMatchObject({ externalDeliveries: [] });
		expect(isRecord(state.data) && state.data.capabilities).toEqual(ready.capabilities);
	}, 30_000);

	test("a deliver pipelined after a prompt whose input hook is still running waits for that prompt", async () => {
		const rpc = start({ DELIVERY_FIXTURE_INPUT_HOOK_MS: "50", DELIVERY_FIXTURE_MODEL_DELAY_MS: "100" });
		await rpc.until(frame => frame.type === "ready");

		// One write: the deliver is read while the prompt's hook is still running.
		await rpc.pipeline([
			{ id: "p1", type: "prompt", message: "hello" },
			{ id: "d1", type: "deliver", record: card("pipelined", "src-p"), options: { mode: "aside" } },
		]);

		const delivered = await rpc.until(frame => frame.type === "response" && frame.id === "d1");
		expect(delivered).toMatchObject({ command: "deliver", success: true });
		const deliveryId = delivered.deliveryId as string;
		// The idle session was not woken under the prompt: the prompt is admitted, not refused as busy.
		const prompted = await rpc.until(frame => frame.type === "response" && frame.id === "p1");
		expect(prompted).toMatchObject({ command: "prompt", success: true });
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p1");
		expect(result).toMatchObject({ status: "completed" });
		expect(result.error).toBeUndefined();

		// The record waited behind the prompt's turn dispatch: the prompt reached the model alone
		// first, then the held aside was admitted (here woken, since that turn had no step boundary
		// left to fold it into) and the model saw it after the prompt.
		const accepted = await rpc.until(frame => frame.type === "delivery_accepted" && frame.deliveryId === deliveryId);
		expect(accepted).toMatchObject({ mode: "aside" });
		const settled = await rpc.until(frame => frame.type === "delivery_settled" && frame.deliveryId === deliveryId);
		expect(settled).toMatchObject({ included: true });
		const replies = rpc.received
			.filter(frame => frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant")
			.map(frame => JSON.stringify(frame.message));
		expect(replies[0]).toContain('seen:[\\"hello\\"]');
		expect(replies.at(-1)).toContain('seen:[\\"hello\\",\\"pipelined\\"]');
		expect(rpc.received.filter(frame => frame.type === "response" && frame.success === false)).toEqual([]);
	}, 30_000);

	/** Assistant replies so far, as the mock model's `seen:[...]` text. */
	function replies(received: Frame[]): string[] {
		return received
			.filter(frame => frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant")
			.map(frame => JSON.stringify(frame.message));
	}

	test("a prompt whose input hook delivers and awaits acceptance completes instead of hanging", async () => {
		const rpc = start({ DELIVERY_FIXTURE_HOOK_DELIVERS: "1", DELIVERY_FIXTURE_MODEL_DELAY_MS: "100" });
		await rpc.until(frame => frame.type === "ready");

		// The hook's own delivery is not parked behind the prompt's dispatch hold: it wakes the
		// idle session and is accepted, so the hook returns. The prompt then meets that running
		// turn and, with no streamingBehavior, is refused as busy like any prompt during a turn.
		await rpc.pipeline([{ id: "p1", type: "prompt", message: "deliver:from-hook" }]);
		expect(await rpc.until(frame => frame.type === "response" && frame.id === "p1")).toMatchObject({
			command: "prompt",
			success: false,
			error: expect.stringContaining("Agent is already processing"),
		});
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p1")).toMatchObject({
			status: "error",
		});
		await rpc.until(frame => frame.type === "session_settled");
		expect(replies(rpc.received)).toEqual([expect.stringContaining('seen:[\\"from-hook\\"]')]);

		// With streamingBehavior the same prompt queues behind the hook's turn and completes.
		await rpc.pipeline([{ id: "p2", type: "prompt", message: "deliver:second", streamingBehavior: "followUp" }]);
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p2")).toMatchObject({
			status: "completed",
		});
		expect(replies(rpc.received).at(-1)).toContain('seen:[\\"from-hook\\",\\"second\\",\\"deliver:second\\"]');
	}, 30_000);

	/** Sends `prompt "deliver:<text>"` and expects the documented busy trade-off: the hook's own
	 *  delivery wakes the session and is accepted (so the hook returns), and the prompt is refused. */
	async function expectHookDeliveryCompletes(
		rpc: { pipeline(frames: object[]): Promise<void>; until(match: (frame: Frame) => boolean): Promise<Frame> },
		id: string,
		text: string,
	) {
		await rpc.pipeline([{ id, type: "prompt", message: `deliver:${text}` }]);
		expect(await rpc.until(frame => frame.type === "response" && frame.id === id)).toMatchObject({
			command: "prompt",
			success: false,
			error: expect.stringContaining("Agent is already processing"),
		});
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === id)).toMatchObject({
			status: "error",
		});
		await rpc.until(
			frame =>
				frame.type === "message_end" &&
				isRecord(frame.message) &&
				frame.message.role === "assistant" &&
				JSON.stringify(frame.message).includes(`\\"${text}\\"`),
		);
	}

	test("after a host abort, a prompt whose input hook awaits its delivery still completes", async () => {
		const rpc = start({ DELIVERY_FIXTURE_HOOK_DELIVERS: "1", DELIVERY_FIXTURE_MODEL_DELAY_MS: "100" });
		await rpc.until(frame => frame.type === "ready");
		await rpc.pipeline([{ id: "p1", type: "prompt", message: "hello" }]);
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p1")).toMatchObject({
			status: "completed",
		});
		// The abort latches the interrupt; only the held prompt behind the hook would clear it,
		// so the hook's delivery (no wakeAfterInterrupt) is covered by that prompt instead.
		expect(await rpc.command({ type: "abort" })).toMatchObject({ success: true });
		await expectHookDeliveryCompletes(rpc, "p2", "after-abort");
	}, 30_000);

	test("in plan mode, a prompt whose input hook awaits its delivery still completes", async () => {
		const rpc = start({
			DELIVERY_FIXTURE_HOOK_DELIVERS: "1",
			DELIVERY_FIXTURE_MODEL_DELAY_MS: "100",
			DELIVERY_FIXTURE_PLAN_MODE: "1",
		});
		await rpc.until(frame => frame.type === "ready");
		await expectHookDeliveryCompletes(rpc, "p1", "in-plan");
	}, 30_000);

	test("a steer whose input hook awaits its delivery does not deadlock a prompt queued behind it", async () => {
		// The 50 ms hook delay lets the prompt (and its dispatch hold) enter the gate before
		// the steer's hook delivers.
		const rpc = start({
			DELIVERY_FIXTURE_HOOK_DELIVERS: "1",
			DELIVERY_FIXTURE_INPUT_HOOK_MS: "50",
			DELIVERY_FIXTURE_MODEL_DELAY_MS: "100",
		});
		await rpc.until(frame => frame.type === "ready");

		await rpc.pipeline([
			{ id: "s1", type: "steer", message: "deliver:steered" },
			{ id: "p2", type: "prompt", message: "after", streamingBehavior: "followUp" },
		]);
		expect(await rpc.until(frame => frame.type === "response" && frame.id === "s1")).toMatchObject({
			success: true,
		});
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p2")).toMatchObject({
			status: "completed",
		});
		expect(replies(rpc.received).at(-1)).toContain('seen:[\\"steered\\",\\"deliver:steered\\",\\"after\\"]');
		expect(rpc.received.filter(frame => frame.type === "response" && frame.success === false)).toEqual([]);
	}, 30_000);

	test("a prompt sent during a turn whose input hook delivers and awaits acceptance completes without wedging input", async () => {
		// The model delay keeps p1's turn running while p2's hook delivers into it.
		const rpc = start({ DELIVERY_FIXTURE_HOOK_DELIVERS: "1", DELIVERY_FIXTURE_MODEL_DELAY_MS: "600" });
		await rpc.until(frame => frame.type === "ready");
		await rpc.pipeline([{ id: "p1", type: "prompt", message: "hello" }]);
		await rpc.until(frame => frame.type === "agent_start");
		await rpc.pipeline([{ id: "p2", type: "prompt", message: "deliver:mid", streamingBehavior: "followUp" }]);
		// Without the exemption the hook's delivery is stranded under p2's own dispatch hold
		// and p2 never settles (the test times out).
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p2")).toMatchObject({
			status: "completed",
		});
		await rpc.pipeline([{ id: "p3", type: "prompt", message: "later", streamingBehavior: "followUp" }]);
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p3")).toMatchObject({
			status: "completed",
		});
		const all = replies(rpc.received).join("\n");
		expect(all).toContain('\\"mid\\"');
		expect(replies(rpc.received).at(-1)).toContain('\\"later\\"');
		expect(rpc.received.filter(frame => frame.type === "response" && frame.success === false)).toEqual([]);
	}, 30_000);

	test("a new_session while an input hook awaits its delivery discards it, and the hook and later input go on", async () => {
		// The model delay keeps p1's turn running, so p2's hook delivery is still queued when
		// new_session discards it; the hook races `accepted` with `discarded` and returns.
		const rpc = start({ DELIVERY_FIXTURE_HOOK_DELIVERS: "1", DELIVERY_FIXTURE_MODEL_DELAY_MS: "600" });
		await rpc.until(frame => frame.type === "ready");
		await rpc.pipeline([{ id: "p1", type: "prompt", message: "hello" }]);
		await rpc.until(frame => frame.type === "agent_start");
		await rpc.pipeline([{ id: "p2", type: "prompt", message: "deliver:mid", streamingBehavior: "followUp" }]);
		// Wait until the hook's delivery is queued in p1's running turn, then switch sessions.
		for (;;) {
			const state = await rpc.command({ type: "get_state" });
			const deliveries = isRecord(state.data) ? state.data.externalDeliveries : undefined;
			if (Array.isArray(deliveries) && deliveries.length > 0) break;
		}
		await rpc.pipeline([{ id: "n1", type: "new_session" }]);
		expect(await rpc.until(frame => frame.type === "response" && frame.id === "n1")).toMatchObject({
			success: true,
		});
		// A hook awaiting only `accepted` never returns here and every later input wedges
		// behind it (the test times out).
		await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p2");
		await rpc.pipeline([{ id: "p3", type: "prompt", message: "later" }]);
		expect(await rpc.until(frame => frame.type === "prompt_result" && frame.id === "p3")).toMatchObject({
			status: "completed",
		});
		expect(replies(rpc.received).at(-1)).toContain('seen:[\\"later\\"]');
	}, 30_000);

	test("deliver never parses commands, and receipts correlate by the engine-minted delivery id", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");

		// The header and the projection both look like a slash command; neither
		// is interpreted — the projection text reaches the model verbatim.
		const response = await rpc.command({
			type: "deliver",
			record: card("/new please", "src-a", "/new"),
			options: { mode: "aside", quiet: true, wakeAfterInterrupt: true, wakeInPlanMode: true },
		});
		expect(response).toMatchObject({ command: "deliver", success: true });
		const deliveryId = response.deliveryId;
		expect(typeof deliveryId).toBe("string");
		expect(deliveryId).not.toBe(response.id);
		expect(response.data).toEqual({ deliveryId });

		const accepted = await rpc.until(frame => frame.type === "delivery_accepted");
		expect(accepted).toMatchObject({ deliveryId, mode: "aside", mechanism: "wake" });
		expect(typeof accepted.at).toBe("number");
		const settled = await rpc.until(frame => frame.type === "delivery_settled");
		expect(settled).toMatchObject({
			deliveryId,
			outcome: "text",
			included: true,
			requests: 1,
			sole: true,
			interactive: false,
		});
		const reply = await rpc.until(
			frame =>
				frame.type === "message_end" &&
				typeof frame.message === "object" &&
				frame.message !== null &&
				(frame.message as Frame).role === "assistant",
		);
		expect(JSON.stringify(reply.message)).toContain('seen:[\\"/new please\\"]');
		const state = await rpc.command({ type: "get_state" });
		expect((state.data as Frame).externalDeliveries).toEqual([]);
		// The session was not replaced by a `/new` interpretation.
		expect((state.data as Frame).messageCount).toBe(2);
	}, 30_000);

	test("cancel_delivery removes a queued record and get_state lists held records", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		// An operator interrupt latch: an aside without wakeAfterInterrupt stays queued.
		expect(await rpc.command({ type: "abort" })).toMatchObject({ success: true });

		const queued = await rpc.command({ type: "deliver", record: card("held", "src-h"), options: { mode: "aside" } });
		const queuedId = queued.deliveryId as string;
		const state = await rpc.command({ type: "get_state" });
		expect((state.data as Frame).externalDeliveries).toEqual([
			{ deliveryId: queuedId, state: "queued", mode: "aside" },
		]);

		expect(await rpc.command({ type: "cancel_delivery", deliveryId: "nope" })).toMatchObject({
			command: "cancel_delivery",
			success: true,
			cancelled: false,
			data: { cancelled: false },
		});
		expect(await rpc.command({ type: "cancel_delivery", deliveryId: 42 })).toMatchObject({ success: false });
		expect(await rpc.command({ type: "cancel_delivery", deliveryId: queuedId })).toMatchObject({
			cancelled: true,
			data: { cancelled: true },
		});
		expect(await rpc.until(frame => frame.type === "delivery_cancelled")).toEqual({
			type: "delivery_cancelled",
			deliveryId: queuedId,
		});
		expect(await rpc.command({ type: "cancel_delivery", deliveryId: queuedId })).toMatchObject({ cancelled: false });
		expect(((await rpc.command({ type: "get_state" })).data as Frame).externalDeliveries).toEqual([]);

		// A wake past the latch admits only the surviving record.
		const woken = await rpc.command({
			type: "deliver",
			record: card("after", "src-w"),
			options: { mode: "steer", wakeAfterInterrupt: true },
		});
		const wokenId = woken.deliveryId as string;
		const accepted = await rpc.until(frame => frame.type === "delivery_accepted" && frame.deliveryId === wokenId);
		expect(accepted).toMatchObject({ mode: "steer", mechanism: "wake" });
		await rpc.until(frame => frame.type === "delivery_settled" && frame.deliveryId === wokenId);
		expect(rpc.received.some(frame => frame.type === "delivery_accepted" && frame.deliveryId === queuedId)).toBe(
			false,
		);
		const reply = await rpc.until(
			frame =>
				frame.type === "message_end" &&
				typeof frame.message === "object" &&
				frame.message !== null &&
				(frame.message as Frame).role === "assistant",
		);
		expect(JSON.stringify(reply.message)).toContain('seen:[\\"after\\"]');
	}, 30_000);

	test("deliver rejects an unknown mode without touching the session", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		expect(await rpc.command({ type: "deliver", record: card("x", "s"), options: { mode: "shout" } })).toMatchObject({
			command: "deliver",
			success: false,
		});
		expect(((await rpc.command({ type: "get_state" })).data as Frame).externalDeliveries).toEqual([]);
	}, 30_000);
});
