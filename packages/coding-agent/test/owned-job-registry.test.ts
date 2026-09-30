import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import {
	isOwnedProcessAlive,
	OWNER_SCAN_COVERS_PLATFORM,
	type OwnedJobRecord,
	OwnedJobRegistry,
	ownedJobRegistryPath,
	verifyOwnedJobRegistry,
} from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import { processStartTime } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { DAEMON_BROKER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/launch/protocol";

function readRecords(file: string): OwnedJobRecord[] {
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as OwnedJobRecord);
}

function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

describe.skipIf(process.platform === "win32")("owned-job registry", () => {
	let tempDir: TempDir;
	let sessionFile: string;
	let registry: OwnedJobRegistry;
	const spawned: number[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-owned-jobs-");
		sessionFile = path.join(tempDir.path(), "2026-01-01_session.jsonl");
		registry = new OwnedJobRegistry({
			getSessionFile: () => sessionFile,
			getSessionId: () => "session",
			pollIntervalMs: 0,
		});
		OwnedJobRegistry.setInstance(registry);
	});

	afterEach(() => {
		for (const pid of spawned.splice(0)) killQuietly(pid);
		registry.close();
		OwnedJobRegistry.setInstance(undefined);
		tempDir.removeSync();
	});

	it("records a nohup'd, double-forked descendant with its real pid before executeBash returns", async () => {
		const result = await executeBash("nohup /bin/sleep 30 >/dev/null 2>&1 & echo $!", { cwd: tempDir.path() });
		const intermediatePid = Number(result.output.trim());

		// No waiting: the record must already be on disk when the call returns.
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		const proc = records.find(record => record.type === "start" && record.kind === "process");
		if (proc?.type !== "start") throw new Error("expected a process start record");
		spawned.push(proc.pid);
		expect(proc.reparented).toBe(true);
		expect(proc.pid).not.toBe(intermediatePid);
		expect(proc.startTime).toBe(processStartTime(proc.pid));
		expect(isOwnedProcessAlive(proc.pid, proc.startTime)).toBe(true);
		expect(proc.sleepable).toBe(false);

		// The shell run itself was recorded before it ran and closed once it settled.
		const run = records.find(record => record.type === "start" && record.kind === "shell-run");
		if (run?.type !== "start") throw new Error("expected a shell-run record");
		expect(records.some(record => record.type === "end" && record.jobId === run.jobId)).toBe(true);
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.complete).toBe(true);
	});

	it("records an observed exit and never confuses a reused pid with the original process", async () => {
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		spawned.push(child.pid);
		const startTime = processStartTime(child.pid);
		const jobId = registry.registerProcess({ kind: "service", pid: child.pid, command: "sleep 30", sleepable: true });
		expect(isOwnedProcessAlive(child.pid, (startTime ?? 0) - 1)).toBe(false);
		expect(registry.liveProcessCount()).toBe(1);

		child.kill("SIGKILL");
		await child.exited;
		expect(registry.liveProcessCount()).toBe(0);
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		expect(records.find(record => record.type === "start" && record.jobId === jobId)).toMatchObject({
			kind: "service",
			sleepable: true,
			startTime,
		});
		expect(records.find(record => record.type === "end" && record.jobId === jobId)).toMatchObject({ how: "exited" });
	});

	it("marks the registry incomplete when a shell cannot report spawned processes", () => {
		registry.registerShellSurvivors(undefined, { command: "legacy", cwd: null });
		expect(registry.complete).toBe(false);
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		expect(records[0]).toMatchObject({ type: "invocation", complete: false });
		expect(records.some(record => record.type === "incomplete")).toBe(true);
	});

	it("records a daemon broker it spawns as an internal helper that is never counted as work", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(projectDir);
		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir: path.join(tempDir.path(), "runtime"),
			idleGraceMs: 100,
		});
		try {
			await client.request({ op: "ping" });
			const record = readRecords(ownedJobRegistryPath(sessionFile)).find(
				entry => entry.type === "start" && entry.kind === "internal",
			);
			if (record?.type !== "start") throw new Error("expected an internal start record");
			expect(record.command).toBe(DAEMON_BROKER_WORKER_ARG);
			expect(isOwnedProcessAlive(record.pid, record.startTime)).toBe(true);
			expect(registry.liveProcessCount()).toBe(0);
		} finally {
			// With no client left the broker exits on its own idle timer.
			client.close();
		}
	});

	it("leaves a crashed agent's live job detectable from the registry file alone", async () => {
		const script = path.join(tempDir.path(), "crash.ts");
		const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry } from ${JSON.stringify(registryModule)};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
				`const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore", detached: true });`,
				`child.unref();`,
				`registry.registerProcess({ kind: "process", pid: child.pid, command: "sleep 30" });`,
				`process.kill(process.pid, "SIGKILL");`,
			].join("\n"),
		);
		const agent = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "inherit" });
		expect(await agent.exited).not.toBe(0);

		const records = readRecords(ownedJobRegistryPath(sessionFile));
		const invocation = records.find(record => record.type === "invocation");
		const proc = records.find(record => record.type === "start");
		if (invocation?.type !== "invocation" || proc?.type !== "start") throw new Error("expected registry records");
		spawned.push(proc.pid);
		// The agent is gone, its job is not: pid + start time still identify a live process.
		expect(isOwnedProcessAlive(invocation.invocation.pid, invocation.invocation.startTime)).toBe(false);
		expect(records.some(record => record.type === "end")).toBe(false);
		expect(isOwnedProcessAlive(proc.pid, proc.startTime)).toBe(true);
		expect(verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile))).toMatchObject({
			status: "blocked",
			live: [expect.objectContaining({ pid: proc.pid })],
		});
	});

	/** A program that daemonizes itself: spawns a setsid'd grandchild, prints its pid, exits. */
	async function writeDaemonizer(program: string[]): Promise<string> {
		const launcher = path.join(tempDir.path(), "daemonize.ts");
		await Bun.write(
			launcher,
			[
				`const child = Bun.spawn(${JSON.stringify(program)}, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
				"child.unref();",
				"console.log(child.pid);",
				"process.exit(0);",
			].join("\n"),
		);
		return launcher;
	}

	it("finds a self-daemonizing descendant no pid report covered, through the inherited owner marker", async () => {
		const launcher = await writeDaemonizer([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"]);
		const result = await executeBash(`${process.execPath} ${launcher}`, { cwd: tempDir.path() });
		const daemonPid = Number(result.output.trim());
		spawned.push(daemonPid);
		// Brush saw only the launcher, which exited: nothing reported the daemon.
		expect(registry.openJobs().some(job => job.pid === daemonPid)).toBe(false);

		const scan = registry.scanOwnedProcesses();
		expect(scan.discovered).toBe(1);
		const record = registry.openJobs().find(job => job.pid === daemonPid);
		expect(record).toMatchObject({ kind: "process", discovered: true, startTime: processStartTime(daemonPid) });
		expect(registry.liveProcessCount()).toBe(1);
		// Durable: the discovery is in the file, and a second scan does not duplicate it.
		expect(registry.scanOwnedProcesses().discovered).toBe(0);
		expect(
			readRecords(ownedJobRegistryPath(sessionFile)).filter(
				entry => entry.type === "start" && entry.pid === daemonPid,
			),
		).toHaveLength(1);
	});

	it("reports the scan unsound where a daemon's environment is hidden, and finds it where it is not", async () => {
		const launcher = await writeDaemonizer(["/bin/sleep", "30"]);
		const result = await executeBash(`${process.execPath} ${launcher}`, { cwd: tempDir.path() });
		const daemonPid = Number(result.output.trim());
		spawned.push(daemonPid);
		const scan = registry.scanOwnedProcesses();
		if (OWNER_SCAN_COVERS_PLATFORM) {
			expect(scan.discovered).toBe(1);
		} else {
			// macOS withholds a platform binary's environment: the daemon is not found, and the
			// scan says it cannot vouch for it instead of reading as clear.
			expect(scan.discovered).toBe(0);
			expect(scan.sound).toBe(false);
			expect(scan.opaque.some(entry => entry.pid === daemonPid)).toBe(true);
		}
	});

	it("verifies a crashed agent's escaped daemon as blocked, and never as clear while it runs", async () => {
		const script = path.join(tempDir.path(), "crash-escape.ts");
		const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry, ownerMarkerEnv } from ${JSON.stringify(registryModule)};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
				"registry.ensureHeader();",
				// Marked like any shell run, but never registered: only the marker can find it.
				`const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { env: { ...process.env, ...ownerMarkerEnv() }, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
				"child.unref();",
				"console.log(child.pid);",
				`process.kill(process.pid, "SIGKILL");`,
			].join("\n"),
		);
		const agent = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
		const daemonPid = Number((await new Response(agent.stdout).text()).trim());
		spawned.push(daemonPid);
		expect(await agent.exited).not.toBe(0);

		const verdict = verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile));
		expect(verdict.status).toBe("blocked");
		expect(verdict.live).toEqual([expect.objectContaining({ pid: daemonPid, jobId: `marked:${daemonPid}` })]);

		const daemon = Bun.spawn(["/bin/kill", "-9", String(daemonPid)]);
		await daemon.exited;
		const after = verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile));
		expect(after.live).toEqual([]);
		expect(after.status).toBe(OWNER_SCAN_COVERS_PLATFORM && after.reasons.length === 0 ? "clear" : "unknown");
	});
});
