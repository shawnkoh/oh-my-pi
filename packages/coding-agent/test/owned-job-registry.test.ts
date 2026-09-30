import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import {
	OWNER_SCAN_COVERS_PLATFORM,
	type OwnedJobRecord,
	OwnedJobRegistry,
	ownedJobRegistryPath,
	ownedProcessState,
	verifyOwnedJobRegistry,
} from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import { processIdentity } from "@oh-my-pi/pi-natives";
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
		expect(proc.startId).toBe(processIdentity(proc.pid).startId!);
		expect(ownedProcessState(proc.pid, proc.startId)).toBe("alive");
		expect(proc.sleepable).toBe(false);

		// The shell run itself was recorded before it ran and closes once it settled and no
		// background job of its shell is left running.
		const run = records.find(record => record.type === "start" && record.kind === "shell-run");
		if (run?.type !== "start") throw new Error("expected a shell-run record");
		const registryFile = ownedJobRegistryPath(sessionFile);
		await eventually(
			() => readRecords(registryFile).some(record => record.type === "end" && record.jobId === run.jobId),
			"the shell-run end record",
		);
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.complete).toBe(true);
	});

	/** Poll `condition` (bounded); the native shell reports asynchronously. */
	async function eventually(condition: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}

	it("has the shell-run record on disk while the run is still in flight", async () => {
		const release = path.join(tempDir.path(), "release");
		const run = executeBash(`while [ ! -e ${release} ]; do /bin/sleep 0.05; done`, { cwd: tempDir.path() });
		const registryFile = ownedJobRegistryPath(sessionFile);
		const runStart = () =>
			fs.existsSync(registryFile)
				? readRecords(registryFile).find(record => record.type === "start" && record.kind === "shell-run")
				: undefined;
		try {
			await eventually(() => runStart() !== undefined, "the shell-run start record");
			const start = runStart();
			if (start?.type !== "start") throw new Error("expected a shell-run start record");
			expect(readRecords(registryFile).some(record => record.type === "end" && record.jobId === start.jobId)).toBe(
				false,
			);
		} finally {
			fs.writeFileSync(release, "");
			await run;
		}
	});

	it("keeps a retained-shell record open while a background job can still start processes", async () => {
		// The job forks its long-lived child only after the run returned: no survivor report sees it.
		const result = await executeBash("{ /bin/sleep 0.3; /bin/sleep 4; } >/dev/null 2>&1 & echo started", {
			cwd: tempDir.path(),
			sessionKey: `retained-${Date.now()}:async:1`,
		});
		expect(result.output.trim()).toBe("started");
		await eventually(
			() => registry.openJobs().some(record => record.kind === "retained-shell"),
			"the retained-shell record",
		);
		// A crash now must not read as "complete, nothing live".
		const verdict = verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile));
		expect(verdict.status).toBe("live");
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		const retained = records.find(record => record.type === "start" && record.kind === "retained-shell");
		if (retained?.type !== "start") throw new Error("expected a retained-shell start record");
		expect(records.some(record => record.type === "end" && record.jobId === retained.jobId)).toBe(false);
	});

	it("records an observed exit and never confuses a reused pid with the original process", async () => {
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		spawned.push(child.pid);
		const startId = processIdentity(child.pid).startId;
		const jobId = registry.registerProcess({ kind: "service", pid: child.pid, command: "sleep 30", sleepable: true });
		// Same pid, different start identity: a reused pid is a different process.
		expect(ownedProcessState(child.pid, `${startId}0`)).toBe("gone");
		expect(registry.liveProcessCount()).toBe(1);

		child.kill("SIGKILL");
		await child.exited;
		expect(registry.liveProcessCount()).toBe(0);
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		expect(records.find(record => record.type === "start" && record.jobId === jobId)).toMatchObject({
			kind: "service",
			sleepable: true,
			startId,
		});
		expect(records.find(record => record.type === "end" && record.jobId === jobId)).toMatchObject({ how: "exited" });
	});

	it.skipIf(process.platform !== "darwin")(
		"counts a process whose identity cannot be read as alive and never records it as ended",
		() => {
			// launchd (pid 1) exists, but its identity is not readable by an unprivileged user.
			expect(processIdentity(1).state).toBe("unreadable");
			const jobId = registry.registerProcess({ kind: "process", pid: 1, startId: "1", command: "launchd" });
			expect(registry.liveProcessCount()).toBe(1);
			const records = readRecords(ownedJobRegistryPath(sessionFile));
			expect(records.some(record => record.type === "end" && record.jobId === jobId)).toBe(false);
			expect(verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile)).status).not.toBe("clear");
		},
	);

	it("marks the registry incomplete when a shell cannot report spawned processes", () => {
		registry.registerShellSurvivors({ spawnedProcesses: undefined }, { command: "legacy", cwd: null });
		expect(registry.complete).toBe(false);
		expect(readRecords(ownedJobRegistryPath(sessionFile))[0]).toMatchObject({
			type: "invocation",
			complete: false,
			incompleteReasons: ["shell backend does not report spawned processes"],
		});
		registry.registerShellSurvivors({ spawnedProcesses: [], spawnedComplete: false }, { command: "x", cwd: null });
		expect(readRecords(ownedJobRegistryPath(sessionFile))).toContainEqual(
			expect.objectContaining({
				type: "incomplete",
				reason: "a shell run could not report every process it spawned",
			}),
		);
	});

	it("carries open records into the new registry file on a session switch and ends them in both", async () => {
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		spawned.push(child.pid);
		const jobId = registry.registerProcess({ kind: "process", pid: child.pid, command: "sleep 30" })!;
		const firstFile = ownedJobRegistryPath(sessionFile);
		sessionFile = path.join(tempDir.path(), "2026-01-02_switched.jsonl");
		const secondFile = ownedJobRegistryPath(sessionFile);
		registry.ensureHeader();

		const carried = readRecords(secondFile);
		expect(carried[0]).toMatchObject({ type: "invocation" });
		expect(carried).toContainEqual(expect.objectContaining({ type: "start", jobId, carriedFrom: firstFile }));
		expect(verifyOwnedJobRegistry(secondFile).status).toBe("live");

		child.kill("SIGKILL");
		await child.exited;
		expect(registry.liveProcessCount()).toBe(0);
		for (const file of [firstFile, secondFile]) {
			expect(readRecords(file)).toContainEqual(expect.objectContaining({ type: "end", jobId, how: "exited" }));
		}
	});

	it("persists a failed registry write as incomplete once the registry can write again", () => {
		// A directory where the registry file should be: every append fails.
		fs.mkdirSync(ownedJobRegistryPath(sessionFile), { recursive: true });
		registry.registerInProcessJob({ jobId: "job-1", kind: "async-job", command: "x" });
		expect(registry.complete).toBe(false);

		sessionFile = path.join(tempDir.path(), "2026-01-02_writable.jsonl");
		registry.ensureHeader();
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		expect(records[0]).toMatchObject({
			type: "invocation",
			complete: false,
			incompleteReasons: ["registry write failed"],
		});
		// The job whose start never reached disk is not carried as if it had been recorded.
		expect(records.some(record => record.type === "start")).toBe(false);
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
			expect(ownedProcessState(record.pid, record.startId)).toBe("alive");
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
		// The agent is gone, its job is not: pid + start identity still identify a live process.
		expect(ownedProcessState(invocation.invocation.pid, invocation.invocation.startId)).toBe("gone");
		expect(records.some(record => record.type === "end")).toBe(false);
		expect(ownedProcessState(proc.pid, proc.startId)).toBe("alive");
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
		expect(record).toMatchObject({ kind: "process", discovered: true, startId: processIdentity(daemonPid).startId });
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
