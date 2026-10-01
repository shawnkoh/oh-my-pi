import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { terminalAttestationPath } from "@oh-my-pi/pi-coding-agent/session/quiescence";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

function sha256OfFile(file: string): string {
	return new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
	}
	reader.releaseLock();
	return text.trim();
}

describe.skipIf(process.platform === "win32").each(["after", "before"] as const)(
	"SIGHUP with a host teardown registered %s the session",
	order => {
		it("persists what extension session_shutdown handlers write and attests the final transcript", async () => {
			using tempDir = TempDir.createSync("@omp-hangup-host-");
			const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "hangup-host-agent.ts")], {
				cwd: tempDir.path(),
				env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.path(), PI_NO_TITLE: "1", HANGUP_HOST_ORDER: order },
				stdout: "pipe",
				stderr: "inherit",
			});
			try {
				const { sessionFile } = JSON.parse(await firstLine(child.stdout)) as { sessionFile: string };
				child.kill("SIGHUP");
				expect(await withTimeout(child.exited, 15_000, "host did not exit")).toBe(129);
				expect(fs.readFileSync(sessionFile, "utf8")).toContain('"customType":"shutdown-state"');
				const attestation = JSON.parse(fs.readFileSync(terminalAttestationPath(sessionFile), "utf8"));
				expect(attestation).toMatchObject({ kind: "hangup", signal: "sighup" });
				expect(attestation.session.sha256).toBe(sha256OfFile(sessionFile));
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
		}, 30_000);
	},
);
