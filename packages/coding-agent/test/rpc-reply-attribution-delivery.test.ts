import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown>;
type Entry = { id: string; type: string; message?: { role: string; content: unknown }; customType?: string };

function card(text: string) {
	return {
		customType: "external-card",
		content: `[card ${text}]`,
		display: true,
		details: { "omp.llm": { role: "user", content: [{ type: "text", text }] }, "omp.llm.source": "src-test" },
	};
}

function textOf(entry: Entry | undefined): string {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text = content
		.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
		.join("");
	// Context reminders may precede a user message's own text.
	return text.split("</system-reminder>").at(-1)?.trim() ?? "";
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Real RPC process with external delivery and an extension command; only the model is scripted.
describe("reply attribution with deliveries and extension commands", () => {
	let directory: string;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-attr-delivery-"));
	});

	afterEach(async () => {
		child?.kill();
		await child?.exited;
		child = undefined;
		await removeWithRetries(directory);
	});

	function start() {
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "reply-attribution-delivery-agent.ts")],
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
		const send = async (fields: object): Promise<string> => {
			const requestId = `cmd-${++id}`;
			proc.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
			await proc.stdin.flush();
			return requestId;
		};
		const until = async (match: (frame: Frame) => boolean): Promise<Frame> => {
			for (const frame of received) if (match(frame)) return frame;
			for (;;) {
				const frame = await receive();
				if (match(frame)) return frame;
			}
		};
		const entries = async (): Promise<Entry[]> => {
			const requestId = await send({ type: "get_entries" });
			const response = await until(frame => frame.type === "response" && frame.id === requestId);
			const data = response.data;
			return data && typeof data === "object" && "entries" in data && Array.isArray(data.entries)
				? data.entries
				: [];
		};
		return { send, until, entries };
	}

	test("a delivery during a prompt's run ends that prompt's reply", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const prompt = await rpc.send({ type: "prompt", message: "slow P", literal: true });
		// The model's first reply takes 1.5 s from here: deliver while it streams.
		await rpc.until(frame => frame.type === "agent_start");
		await rpc.send({ type: "deliver", record: card("D"), options: { mode: "steer" } });
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === prompt);
		await rpc.until(frame => frame.type === "session_settled");
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		const reply = stringsOf(result.replyEntryIds).map(id => textOf(byId.get(id)));
		expect(textOf(byId.get(String(result.promptEntryId)))).toBe("slow P");
		expect(reply.length).toBeGreaterThan(0);
		// The answer to the delivery is never credited as the prompt's reply.
		expect(reply.every(text => !text.includes("answer-to:D"))).toBe(true);
		expect(reply.at(-1)).toBe("answer-to:slow P");
	}, 30_000);

	test("a delivery wake while an extension command runs is not credited to the command", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const command = await rpc.send({ type: "prompt", message: "/slowsend" });
		// The command's handler waits 1.5 s before sending: deliver once it has been accepted.
		await rpc.until(frame => frame.type === "response" && frame.id === command);
		await rpc.send({ type: "deliver", record: card("wake"), options: { mode: "steer" } });
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === command);
		await rpc.until(frame => frame.type === "session_settled");
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		// The command's own run (its sendUserMessage) is reported: a later run than the wake's.
		expect(result.run).toBe(2);
		expect(textOf(byId.get(String(result.promptEntryId)))).toBe("from-command");
		expect(stringsOf(result.replyEntryIds).map(id => textOf(byId.get(id)))).toEqual(["answer-to:from-command"]);
	}, 30_000);

	test("a wake before an extension command changes session does not abort the command", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const command = await rpc.send({ type: "prompt", message: "/slownew" });
		await rpc.until(frame => frame.type === "response" && frame.id === command);
		await rpc.send({ type: "deliver", record: card("wake"), options: { mode: "steer" } });
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === command);
		await rpc.until(frame => frame.type === "session_settled");
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		expect(result.status).toBe("completed");
		expect(textOf(byId.get(String(result.promptEntryId)))).toBe("after-new");
		expect(stringsOf(result.replyEntryIds).map(id => textOf(byId.get(id)))).toEqual(["answer-to:after-new"]);
	}, 30_000);

	test("a command's send into a live run leaves that run's prompts attributed and completed", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		// The command's handler waits for a run, so the prompt that starts one follows at once.
		const command = await rpc.send({ type: "prompt", message: "/sendlive" });
		const prompt = await rpc.send({ type: "prompt", message: "slow X", literal: true });
		const promptResult = await rpc.until(frame => frame.type === "prompt_result" && frame.id === prompt);
		const commandResult = await rpc.until(frame => frame.type === "prompt_result" && frame.id === command);
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		expect(promptResult.status).toBe("completed");
		expect(commandResult.status).toBe("completed");
		expect(textOf(byId.get(String(promptResult.promptEntryId)))).toBe("slow X");
	}, 30_000);

	test("a command's send into a later live run reports that run, not a wake that already yielded", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const command = await rpc.send({ type: "prompt", message: "/slowsend" });
		await rpc.until(frame => frame.type === "response" && frame.id === command);
		// Wake run 1 starts and yields while the handler sleeps.
		await rpc.send({ type: "deliver", record: card("wake"), options: { mode: "steer" } });
		await rpc.until(frame => frame.type === "agent_end");
		// Run 2 streams for 1.5 s, so the command's send is queued into it.
		const prompt = await rpc.send({ type: "prompt", message: "slow L", literal: true });
		const promptResult = await rpc.until(frame => frame.type === "prompt_result" && frame.id === prompt);
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === command);
		await rpc.until(frame => frame.type === "session_settled");
		// Reported at run 2's yield with run 2's outcome; work queued into a live run claims no entries.
		expect(promptResult.run).toBe(2);
		expect(result).toMatchObject({ run: 2, status: "completed", sessionSettled: true });
	}, 30_000);

	test("goal context steered into a run ends the prompt's reply", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const prompt = await rpc.send({ type: "prompt", message: "slow P", literal: true });
		await rpc.until(frame => frame.type === "agent_start");
		await rpc.send({ type: "goal", op: "create", objective: "w5 goal objective" });
		const result = await rpc.until(frame => frame.type === "prompt_result" && frame.id === prompt);
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		const reply = stringsOf(result.replyEntryIds).map(id => textOf(byId.get(id)));
		expect(reply).toEqual(["answer-to:slow P"]);
	}, 30_000);

	test("an extension command that changes session keeps its ticket; a host prompt it detached is aborted", async () => {
		const rpc = start();
		await rpc.until(frame => frame.type === "ready");
		const command = await rpc.send({ type: "prompt", message: "/delayed-new" });
		// A host prompt accepted while the command's handler waits; its run is detached by the new session.
		const prompt = await rpc.send({ type: "prompt", message: "slow host", literal: true });
		const promptResult = await rpc.until(frame => frame.type === "prompt_result" && frame.id === prompt);
		const commandResult = await rpc.until(frame => frame.type === "prompt_result" && frame.id === command);
		const byId = new Map((await rpc.entries()).map(entry => [entry.id, entry]));
		expect(promptResult.status).toBe("aborted");
		expect(commandResult.status).toBe("completed");
		expect(textOf(byId.get(String(commandResult.promptEntryId)))).toBe("after-delayed-new");
		expect(stringsOf(commandResult.replyEntryIds).map(id => textOf(byId.get(id)))).toEqual([
			"answer-to:after-delayed-new",
		]);
	}, 30_000);
});
