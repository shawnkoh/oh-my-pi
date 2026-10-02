import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs, validateGoalStartup } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

async function launch(args: string[]): Promise<{ exitCode: number; stderr: string }> {
	using dir = TempDir.createSync("@omp-goal-flag-");
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", ...args], {
		cwd: dir.path(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

describe("--goal launch option", () => {
	it("parses a quoted objective as one value, not a positional prompt", () => {
		const args = parseArgs(["--goal=Inspect the importer"]);
		expect(args.goal).toBe("Inspect the importer");
		expect(args.messages).toEqual([]);
	});

	it("accepts a leading hyphen with equals syntax and preserves internal newlines", () => {
		expect(parseArgs(["--goal=-inspect"]).goal).toBe("-inspect");
		expect(parseArgs(["--goal", "Inspect\nthen fix"]).goal).toBe("Inspect\nthen fix");
	});

	it("rejects a flag-looking objective without letting that flag act", () => {
		const args = parseArgs(["--goal", "-p", "hello"]);
		expect(args.invalidFlagValues).toContain("--goal requires an objective.");
		// Like every string flag, `--goal` takes the next token as its value (here rejected):
		// `-p` never switches to print mode behind the error.
		expect(args.print).toBeFalsy();
	});

	it("rejects print mode with a usage exit before a model request", async () => {
		const result = await launch(["-p", "--goal", "Inspect the importer"]);
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--goal requires an interactive terminal");
	}, 30_000);

	it("rejects positional input instead of sending a second prompt after activation", () => {
		expect(() => validateGoalStartup(parseArgs(["--goal", "Inspect the importer", "hello"]), true)).toThrow(
			"--goal cannot be combined with a positional message",
		);
	});

	it("rejects plan startup, resumed sessions, and disabled goal mode", () => {
		expect(() => validateGoalStartup(parseArgs(["--goal", "x", "--plan-yolo"]), true)).toThrow("--plan-yolo");
		expect(() => validateGoalStartup(parseArgs(["--goal", "x", "--continue"]), true)).toThrow(
			"requires a fresh session",
		);
		expect(() => validateGoalStartup(parseArgs(["--goal", "x"]), false)).toThrow("goal.enabled");
		expect(() => validateGoalStartup(parseArgs(["--goal", "x"]), true, undefined, true)).toThrow(
			"plan.defaultOnStartup",
		);
	});

	it("starts a fresh goal instead of implicitly resuming a previous transcript", async () => {
		using dir = TempDir.createSync("@omp-goal-resume-");
		const previous = SessionManager.inMemory();
		previous.appendMessage({ role: "user", content: "Earlier conversation", timestamp: Date.now() });
		const resume = vi.spyOn(SessionManager, "continueRecent").mockResolvedValue(previous);
		const settings = Settings.isolated({ autoResume: true });
		try {
			const ordinaryArgs = parseArgs([]);
			const ordinary = await createSessionManager(ordinaryArgs, dir.path(), settings);
			expect(ordinary?.getEntries()).toHaveLength(1);
			expect(ordinaryArgs.continue).toBe(true);

			const goalArgs = parseArgs(["--goal", "New objective"]);
			const fresh = await createSessionManager(goalArgs, dir.path(), settings);
			expect(fresh).toBeUndefined();
			expect(goalArgs.continue).toBeUndefined();
			expect(resume).toHaveBeenCalledTimes(1);
		} finally {
			resume.mockRestore();
			await previous.close();
		}
	});
});
