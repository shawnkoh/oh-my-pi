import { describe, expect, it } from "bun:test";
import { processStartTime, Shell } from "../native/index.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart` for `pid` in UTC, as Unix epoch seconds. */
function psStartTime(pid: number): number {
	const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
		env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
	});
	// e.g. "Wed Sep 30 12:34:56 2026"
	const [, month, day, time, year] = result.stdout.toString().trim().split(/\s+/);
	const [hours, minutes, seconds] = time.split(":").map(Number);
	const monthIndex = MONTHS.indexOf(month);
	expect(monthIndex).toBeGreaterThanOrEqual(0);
	return Date.UTC(Number(year), monthIndex, Number(day), hours, minutes, seconds) / 1000;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("Shell spawnedProcesses", () => {
	it("reports the live reparented grandchild of `nohup cmd &` with its OS start time", async () => {
		const shell = new Shell({});
		let bang = "";
		const result = await shell.run({ command: "nohup /bin/sleep 30 >/dev/null 2>&1 & echo $!" }, (err, chunk) => {
			if (!err) bang += chunk;
		});
		const reparented = (result.spawnedProcesses ?? []).filter(entry => entry.reparented);
		try {
			expect(result.exitCode).toBe(0);
			expect(reparented).toHaveLength(1);
			const [entry] = reparented;
			// `$!` is the intermediate that exits immediately; the report is the real process.
			expect(entry.pid).not.toBe(Number(bang.trim()));
			expect(isAlive(entry.pid)).toBe(true);
			expect(entry.pgid).toBe(Number(bang.trim()));
			expect(entry.startTime).toBeNumber();
			expect(processStartTime(entry.pid)).toBe(entry.startTime!);
			expect(psStartTime(entry.pid)).toBe(entry.startTime!);
		} finally {
			for (const entry of result.spawnedProcesses ?? []) {
				if (isAlive(entry.pid)) process.kill(entry.pid, "SIGKILL");
			}
		}
	});

	it("returns null for a process that does not exist", () => {
		expect(processStartTime(process.pid)).toBe(psStartTime(process.pid));
		expect(processStartTime(0x7ffffff0)).toBeNull();
	});
});
