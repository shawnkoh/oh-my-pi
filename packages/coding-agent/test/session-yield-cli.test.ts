import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

async function run(...args: string[]): Promise<number> {
	await using temp = await TempDir.create("@omp-session-yield-cli-");
	const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "session", ...args], {
		cwd: temp.path(),
		env: {
			PATH: process.env.PATH,
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			PI_TEST_SESSION_OWNERS_DIR: temp.join("owners"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			PI_NO_TITLE: "1",
			CI: "true",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		timeout: 15_000,
	});
	return await child.exited;
}

describe("session yield CLI", () => {
	it("returns no-holder rather than resolving or creating a transcript", async () => {
		expect(await run("yield", "disposable-missing-session", "--timeout", "0.01")).toBe(3);
	}, 20_000);

	it.each(["-1", "NaN", "Infinity", "", "1e309"])(
		"rejects invalid timeout %j",
		async timeout => {
			expect(await run("yield", "disposable-missing-session", `--timeout=${timeout}`)).toBe(1);
		},
		20_000,
	);

	it("rejects an output argument instead of silently targeting a holder", async () => {
		expect(await run("yield", "disposable-missing-session", "unexpected")).toBe(1);
	}, 20_000);
});
