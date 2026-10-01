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

	/**
	 * A script that makes itself non-dumpable (its environment unreadable to us), then writes
	 * its pid to the file named by its first argument and stays up.
	 */
	async function writeHiddenSleeper(dir: string): Promise<string> {
		const script = path.join(dir, "hidden.ts");
		await fs.writeFile(
			script,
			[
				`import { dlopen, FFIType } from "bun:ffi";`,
				`import { writeFileSync } from "node:fs";`,
				`const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });`,
				"if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) process.exit(3);",
				"writeFileSync(process.argv[2], String(process.pid));",
				"setInterval(() => {}, 1 << 30);",
			].join("\n"),
		);
		return script;
	}

	async function waitForFile(file: string): Promise<number> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const text = await fs.readFile(file, "utf8").catch(() => "");
			if (text) return Number(text);
			if (Date.now() > deadline) throw new Error(`${file} was never written`);
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 10);
			await promise;
		}
	}

	it.skipIf(process.platform !== "linux")(
		"stays complete next to an unrelated process whose environment it cannot read",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-unrelated-"));
			const ready = path.join(dir, "pid");
			const unrelated = Bun.spawn([process.execPath, await writeHiddenSleeper(dir), ready], {
				stdio: ["ignore", "ignore", "inherit"],
			});
			try {
				expect(await waitForFile(ready)).toBe(unrelated.pid);
				const { result, bang } = await runWithBang(
					'/bin/sh -c \'/bin/sleep 7471 >/dev/null 2>&1 & printf "bang=%s\\n" "$!"\'',
				);
				const spawned = result.spawnedProcesses ?? [];
				try {
					expect(result.spawnedComplete).toBe(true);
					expect(spawned.map(entry => entry.pid)).toEqual([bang]);
				} finally {
					killReported(spawned.map(entry => entry.pid));
				}
			} finally {
				unrelated.kill("SIGKILL");
				await unrelated.exited;
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"reports a process left in the run's group with its identity even when its environment is unreadable",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-member-"));
			const script = await writeHiddenSleeper(dir);
			const ready = path.join(dir, "pid");
			// The sh waits until its child is non-dumpable, then exits, leaving it in the group.
			const { result, bang } = await runWithBang(
				`/bin/sh -c '${process.execPath} ${script} ${ready} >/dev/null 2>&1 & ` +
					`while [ ! -s ${ready} ]; do sleep 0.01; done; printf "bang=%s\\n" "$!"'`,
			);
			const spawned = result.spawnedProcesses ?? [];
			try {
				expect(result.spawnedComplete).toBe(true);
				const member = spawned.find(entry => entry.pid === bang);
				expect(member?.groupMember).toBe(true);
				expect(member?.startId).toBe(processIdentity(bang).startId!);
			} finally {
				killReported(spawned.map(entry => entry.pid));
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);
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
