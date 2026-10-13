import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processIdentity, scanProcessesByEnv } from "../native/index.js";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs `script` in `/bin/sh` with the marker set, waits for the shell to exit,
 * and returns the pid its detached descendant writes as the first stdout line.
 * The descendant keeps stdout open, so only the first line is read.
 */
async function launchDetached(script: string, owner: string, ...args: string[]) {
	const launcher = Bun.spawn(["/bin/sh", "-c", script, ...args], {
		env: { ...process.env, OMP_OWNER: owner },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const reader = launcher.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("\n")) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	expect(await launcher.exited).toBe(0);
	return { launcherPid: launcher.pid, pid: Number(text.split("\n")[0]) };
}

describe.skipIf(process.platform === "win32")("scanProcessesByEnv", () => {
	it("finds a marked double-forked grandchild and names the token it carries", async () => {
		const token = `omp1:t:${process.pid}`;
		const other = `omp1:other:${process.pid}`;
		// `( cmd & )` forks twice and the subshell exits at once, so the sleeper
		// is reparented. Bun is the sleeper because macOS withholds the
		// environment of Apple platform binaries such as /bin/sleep. It prints its
		// pid once running, so the scan below cannot race its exec.
		const { launcherPid, pid } = await launchDetached(
			'( "$0" -e "process.stdout.write(process.pid + \\"\\\\n\\"); setTimeout(() => {}, 30000)" </dev/null 2>/dev/null & ) ; exit 0',
			`x,${token}`,
			process.execPath,
		);
		try {
			expect(pid).toBeGreaterThan(0);
			const scan = scanProcessesByEnv("OMP_OWNER", [other, token]);
			expect(scan.supported).toBe(true);
			expect(scan.processes.map(entry => entry.pid)).toEqual([pid]);
			const [found] = scan.processes;
			// The requested token it carries, not the first one requested.
			expect(found.token).toBe(token);
			expect(found.ppid).not.toBe(launcherPid);
			expect(found.startTime).toBeNumber();
			expect(processIdentity(pid).startTime).toBe(found.startTime!);
			expect(found.startId).toBe(processIdentity(pid).startId!);
			expect(scanProcessesByEnv("OMP_OWNER", [`${token}0`]).processes).toEqual([]);
			// No tokens match nothing, but the scan still runs.
			const empty = scanProcessesByEnv("OMP_OWNER", []);
			expect(empty.processes).toEqual([]);
			expect(empty.scanned).toBeGreaterThan(0);
		} finally {
			if (isAlive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	it("sees a marked /bin/sleep daemon on Linux; macOS withholds its environment", async () => {
		const token = `omp1:sleep:${process.pid}`;
		// Every process the launcher starts is newer than this test process.
		const since = processIdentity(process.pid).startId!;
		// `$!` is the sleeper's pid: the forked child that execs /bin/sleep.
		const { pid } = await launchDetached("( /bin/sleep 7414 </dev/null >/dev/null & echo $! ) ; exit 0", token);
		try {
			expect(isAlive(pid)).toBe(true);
			const scan = scanProcessesByEnv("OMP_OWNER", [token], since);
			if (process.platform === "darwin") {
				expect(scan.processes.map(entry => entry.pid)).not.toContain(pid);
				expect(scan.redacted).toBeGreaterThan(0);
				// Hidden, but started after `since`: listed as opaque with its start id.
				const opaque = scan.opaque.find(entry => entry.pid === pid);
				expect(opaque?.startId).toBe(processIdentity(pid).startId!);
				expect(opaque?.token).toBeUndefined();
				// A later `since` excludes it.
				const later = scanProcessesByEnv("OMP_OWNER", [token], (BigInt(opaque!.startId!) + 1n).toString());
				expect(later.opaque.map(entry => entry.pid)).not.toContain(pid);
			} else {
				expect(scan.processes.map(entry => entry.pid)).toContain(pid);
			}
		} finally {
			if (isAlive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	it.skipIf(process.platform !== "darwin")("never reports macOS as hiding processes", () => {
		expect(scanProcessesByEnv("OMP_OWNER", ["x"]).hidden).toBe(false);
	});

	it("rejects an opaqueSince that is not a start id", () => {
		expect(() => scanProcessesByEnv("OMP_OWNER", ["x"], "1.5")).toThrow(/opaqueSince/);
	});

	it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
		"counts a process whose environment it cannot read as opaque only if it started since opaqueSince",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natives-opaque-"));
			const script = path.join(dir, "hidden.ts");
			fs.writeFileSync(
				script,
				[
					`import { dlopen, FFIType } from "bun:ffi";`,
					`const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });`,
					// PR_SET_DUMPABLE 0: its /proc files become root's, so its environment is unreadable.
					"if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) process.exit(3);",
					"console.log(process.pid);",
					"setInterval(() => {}, 1 << 30);",
				].join("\n"),
			);
			const hidden = Bun.spawn([process.execPath, script], {
				env: { ...process.env, OMP_OWNER: "omp1:hidden:1" },
				stdio: ["ignore", "pipe", "inherit"],
			});
			try {
				const reader = hidden.stdout.getReader();
				let text = "";
				while (!text.includes("\n")) {
					const { done, value } = await reader.read();
					if (done) break;
					text += new TextDecoder().decode(value);
				}
				reader.releaseLock();
				const pid = Number(text.trim());
				expect(pid).toBe(hidden.pid);
				expect(() => fs.readFileSync(`/proc/${pid}/environ`)).toThrow();
				const startId = processIdentity(pid).startId!;
				const opaquePids = (since: string) =>
					scanProcessesByEnv("OMP_OWNER", ["omp1:hidden:1"], since).opaque.map(entry => entry.pid);
				// Started at or after the earliest invocation scanned for: it could be ours.
				expect(opaquePids(startId)).toContain(pid);
				// Older than every invocation scanned for: not ours, whatever it carries.
				expect(opaquePids((BigInt(startId) + 1n).toString())).not.toContain(pid);
			} finally {
				hidden.kill("SIGKILL");
				await hidden.exited;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
