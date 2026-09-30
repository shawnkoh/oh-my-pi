import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs, validateGoalStartup } from "@oh-my-pi/pi-coding-agent/cli/args";
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

	it("does not consume a following option as the objective", () => {
		const args = parseArgs(["--goal", "-p", "hello"]);
		expect(args.invalidFlagValues).toContain("--goal requires an objective.");
		expect(args.print).toBe(true);
		expect(args.messages).toEqual(["hello"]);
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
	});
});
