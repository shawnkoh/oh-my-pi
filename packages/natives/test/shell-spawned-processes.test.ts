import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processIdentity, Shell } from "../native/index.js";

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

/** Runs `command` in a fresh shell; it must print `bang=<pid>` first. */
async function runWithBang(command: string) {
	const shell = new Shell({});
	let output = "";
	const result = await shell.run({ command }, (err, chunk) => {
		if (!err) output += chunk;
	});
	const bang = Number(/bang=(\d+)/.exec(output)?.[1]);
	return { result, bang };
}

function killReported(pids: Iterable<number>) {
	for (const pid of pids) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
}

describe.skipIf(process.platform === "win32")("Shell spawnedProcesses", () => {
	it("reports the live reparented grandchild of `nohup cmd &` with its identity", async () => {
		const { result, bang } = await runWithBang("nohup /bin/sleep 7411 >/dev/null 2>&1 & printf 'bang=%s\\n' \"$!\"");
		const reparented = (result.spawnedProcesses ?? []).filter(entry => entry.reparented);
		try {
			expect(result.exitCode).toBe(0);
			expect(result.spawnedComplete).toBe(true);
			expect(reparented).toHaveLength(1);
			const [entry] = reparented;
			// `$!` is the intermediate that exits immediately; the report is the real process.
			expect(entry.pid).not.toBe(bang);
			expect(isAlive(entry.pid)).toBe(true);
			expect(entry.pgid).toBe(bang);
			expect(entry.startTime).toBeNumber();
			expect(processIdentity(entry.pid).startTime).toBe(entry.startTime!);
			expect(psStartTime(entry.pid)).toBe(entry.startTime!);
			expect(entry.startId).toBeString();
			expect(processIdentity(entry.pid)).toEqual({
				state: "running",
				startId: entry.startId!,
				startTime: entry.startTime!,
			});
		} finally {
			killReported(reparented.map(entry => entry.pid));
		}
	});

	it("reports a process left in the group of an exited child as a group member", async () => {
		const { result, bang } = await runWithBang(
			'/bin/sh -c \'/bin/sleep 7412 >/dev/null 2>&1 & printf "bang=%s\\n" "$!"\'',
		);
		const spawned = result.spawnedProcesses ?? [];
		try {
			expect(result.exitCode).toBe(0);
			expect(result.spawnedComplete).toBe(true);
			expect(spawned).toHaveLength(1);
			const [entry] = spawned;
			expect(entry.pid).toBe(bang);
			expect(entry.groupMember).toBe(true);
			expect(entry.reparented).toBe(false);
			expect(entry.startId).toBe(processIdentity(bang).startId!);
		} finally {
			killReported(spawned.filter(entry => entry.pid === bang).map(entry => entry.pid));
		}
	});

	it("reports a process a `nohup` launch left in its detached group", async () => {
		// The reparented sh exits at once; its background sleep stays in the detached session's group.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-nohup-group-"));
		const pidFile = path.join(dir, "pid");
		try {
			const { result, bang } = await runWithBang(
				`nohup /bin/sh -c '/bin/sleep 7418 >/dev/null 2>&1 & echo $! >${pidFile}' >/dev/null 2>&1 & ` +
					`while [ ! -s ${pidFile} ]; do sleep 0.01; done; printf 'bang=%s\\n' "$(cat ${pidFile})"`,
			);
			const spawned = result.spawnedProcesses ?? [];
			try {
				expect(result.exitCode).toBe(0);
				const entry = spawned.find(candidate => candidate.pid === bang);
				// Listed as a group member, or the run admits its list may be incomplete.
				if (result.spawnedComplete) {
					expect(entry?.groupMember).toBe(true);
					expect(entry?.startId).toBe(processIdentity(bang).startId!);
				}
				expect(entry !== undefined || !result.spawnedComplete).toBe(true);
			} finally {
				killReported(spawned.filter(entry => entry.pid === bang).map(entry => entry.pid));
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reports what a command started under the `timeout` builtin left behind", async () => {
		// `timeout` installs its own spawn observer; the `sh` it starts must still reach the run's
		// registry, or the sleep left in that sh's process group is never found.
		const { result, bang } = await runWithBang(
			'timeout 60 /bin/sh -c \'/bin/sleep 7437 >/dev/null 2>&1 & printf "bang=%s\\n" "$!"\'',
		);
		const spawned = result.spawnedProcesses ?? [];
		try {
			expect(result.spawnedComplete).toBe(true);
			expect(spawned.map(entry => entry.pid)).toEqual([bang]);
			expect(spawned[0].groupMember).toBe(true);
			expect(isAlive(bang)).toBe(true);
		} finally {
			killReported(spawned.filter(entry => entry.pid === bang).map(entry => entry.pid));
		}
	});

	it("reports nothing, completely, for commands that already exited", async () => {
		const shell = new Shell({});
		const result = await shell.run({ command: "/bin/sh -c true; true" });
		expect(result.spawnedProcesses).toEqual([]);
		expect(result.spawnedComplete).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("processIdentity", () => {
	it("reports a running process with a start id that is stable and unique", async () => {
		const self = processIdentity(process.pid);
		expect(self.state).toBe("running");
		expect(self.startId).toMatch(/^\d+$/);
		expect(self.startTime).toBe(psStartTime(process.pid));
		expect(processIdentity(process.pid)).toEqual(self);

		const child = Bun.spawn(["/bin/sleep", "7413"], { stdio: ["ignore", "ignore", "ignore"] });
		try {
			const running = processIdentity(child.pid);
			expect(running.state).toBe("running");
			expect(running.startId).not.toBe(self.startId!);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
		expect(processIdentity(child.pid)).toEqual({ state: "gone" });
	});

	it("never reports another user's live process as gone", () => {
		const init = processIdentity(1);
		expect(init.state).not.toBe("gone");
		expect(init.startId !== undefined).toBe(init.state === "running");
	});

	it("reports a pid with no process as gone", () => {
		expect(processIdentity(0x7ffffff0)).toEqual({ state: "gone" });
	});
});
