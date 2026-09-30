import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

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

	function start() {
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "external-delivery-rpc-agent.ts")],
			{
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1", NO_COLOR: "1" },
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
		return { command, until, received, receive };
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
		expect(state.data).toMatchObject({ capabilities: ready.capabilities, externalDeliveries: [] });
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
