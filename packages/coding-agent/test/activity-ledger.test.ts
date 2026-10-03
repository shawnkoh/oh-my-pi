import { describe, expect, it } from "bun:test";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { getLspActivity, sendRequest, startMessageReader } from "../src/lsp/client";
import type { LspClient } from "../src/lsp/types";
import { StdioTransport } from "../src/mcp/transports/stdio";
import { idleSafeServerProcesses, ServerActivityLedger } from "../src/session/activity-ledger";
import { TempDir } from "@oh-my-pi/pi-utils";

// Real subprocess I/O and process-exit callbacks cannot be advanced with fake timers.
async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("ledger did not reach expected state");
		await Bun.sleep(5);
	}
}

describe("strict outstanding-activity ledger", () => {
	it.each(["result", "error", "exit"])("keeps cancelled MCP work until %s", async outcome => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: [
				"-e",
				`
				const readline = require('node:readline');
				let pending;
				readline.createInterface({input:process.stdin}).on('line', line => {
					const msg = JSON.parse(line);
					if (msg.method === 'wait') pending = msg.id;
					if (msg.method === 'settle') {
						if (${JSON.stringify(outcome)} === 'exit') process.exit(0);
						console.log(JSON.stringify({jsonrpc:'2.0', id:pending,
							...(${JSON.stringify(outcome)} === 'error' ? {error:{code:-1,message:'failed'}} : {result:{done:true}})}));
					}
				});
			`,
			],
			timeout: 0,
		});
		await transport.connect();
		try {
			const abort = new AbortController();
			const request = transport.request("wait", {}, { signal: abort.signal });
			expect(transport.activity.count).toBe(1);
			abort.abort(new Error("cancelled by caller"));
			await expect(request).rejects.toThrow("cancelled by caller");
			expect(transport.activity.count).toBe(1);
			await transport.notify("settle");
			await until(() => transport.activity.count === 0);
		} finally {
			await transport.close();
		}
	});

	it("counts LSP cancellation until a late wire reply, not promise rejection", async () => {
		const fixture = lspFixture();
		const reader = startMessageReader(fixture.client);
		try {
			const abort = new AbortController();
			const request = sendRequest(fixture.client, "textDocument/hover", {}, abort.signal);
			await fixture.written.promise;
			await fixture.client.writeQueue;
			expect(getLspActivity(fixture.client).count).toBe(1);
			abort.abort(new Error("cancelled"));
			await expect(request).rejects.toThrow("cancelled");
			expect(fixture.client.pendingRequests.size).toBe(0);
			expect(getLspActivity(fixture.client).count).toBe(1);
			fixture.receive({ jsonrpc: "2.0", id: 1, error: { code: -32800, message: "cancelled" } });
			await until(() => getLspActivity(fixture.client).count === 0);
		} finally {
			fixture.close();
			await reader;
		}
	});

	it.each([false, true])(
		"settles cancelled LSP work on process death, not mux disconnect (shared=%s)",
		async shared => {
			const fixture = lspFixture(false, shared);
			const abort = new AbortController();
			const request = sendRequest(fixture.client, "textDocument/hover", {}, abort.signal);
			const ledger = getLspActivity(fixture.client);
			try {
				await fixture.client.writeQueue;
				abort.abort(new Error("cancelled"));
				await expect(request).rejects.toThrow("cancelled");
				fixture.close();
				await fixture.client.proc.exited;
				expect(ledger.count).toBe(shared ? 1 : 0);
			} finally {
				fixture.close();
				// The test's simulated shared server is now stopped too, not just its link.
				ledger.processExited();
			}
		},
	);

	it("keeps server-initiated applyEdit counted through its response write", async () => {
		const temp = TempDir.createSync("@omp-ledger-");
		const fixture = lspFixture(true);
		const reader = startMessageReader(fixture.client);
		try {
			const file = path.join(temp.path(), "edited.txt");
			await Bun.write(file, "before\n");
			fixture.receive({
				jsonrpc: "2.0",
				id: 91,
				method: "workspace/applyEdit",
				params: {
					edit: {
						changes: {
							[pathToFileURL(file).href]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
									newText: "after",
								},
							],
						},
					},
				},
			});
			await fixture.written.promise;
			expect(await Bun.file(file).text()).toBe("after\n");
			expect(getLspActivity(fixture.client).count).toBe(1);
			fixture.release.resolve();
			await until(() => getLspActivity(fixture.client).count === 0);
		} finally {
			fixture.close();
			await reader;
			temp.removeSync();
		}
	});

	it("never excludes uncontracted or unknown process identities", () => {
		const server = new ServerActivityLedger("mcp", "unknown-test-server");
		server.bindProcess(2147483647);
		expect(server.idleSafeIdentity([server.name])).toBeUndefined();
		expect(idleSafeServerProcesses([])).toEqual([]);
		server.processExited();
	});

	it.skipIf(process.platform !== "linux")("only excludes a contracted live process with a zero ledger", () => {
		const server = new ServerActivityLedger("mcp", "idle-safe-test");
		server.bindProcess(process.pid);
		try {
			expect(server.idleSafeIdentity([])).toBeUndefined();
			const identity = server.idleSafeIdentity([server.name]);
			expect(identity).toMatchObject({ pid: process.pid, label: "mcp:idle-safe-test" });
			expect(identity?.start).toMatch(/^\d+$/);
			server.sent(1);
			expect(server.idleSafeIdentity([server.name])).toBeUndefined();
			server.replied(1);
			const hold = server.hold();
			expect(server.idleSafeIdentity([server.name])).toBeUndefined();
			hold.release();
			expect(server.idleSafeIdentity([server.name])).toEqual(identity);
		} finally {
			server.processExited();
		}
	});
});

function lspFixture(blockWrite = false, sharedMux = false) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const exited = Promise.withResolvers<number>();
	const release = Promise.withResolvers<void>();
	const written = Promise.withResolvers<void>();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		release.resolve();
		controller.close();
		exited.resolve(0);
	};
	const client: LspClient = {
		name: "ledger-lsp",
		cwd: process.cwd(),
		config: { command: "ledger-lsp", fileTypes: [".txt"], rootMarkers: [] },
		proc: {
			sharedMux,
			exited: exited.promise,
			exitCode: null,
			stdin: {
				write: chunk => {
					written.resolve();
					return typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
				},
				flush: async () => {
					if (blockWrite) await release.promise;
					return 0;
				},
			},
			stdout: new ReadableStream({
				start: stream => {
					controller = stream;
				},
			}),
			peekStderr: () => "",
			kill: close,
		},
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
	return {
		client,
		close,
		written,
		release,
		receive: (message: object) => {
			const body = JSON.stringify(message);
			controller.enqueue(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
		},
	};
}
