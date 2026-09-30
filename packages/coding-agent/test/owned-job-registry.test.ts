import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { execCommand } from "@oh-my-pi/pi-coding-agent/exec/exec";
import {
	type OwnedJobRecord,
	OwnedJobRegistry,
	ownedJobRegistryPath,
	ownedProcessState,
	ownerToken,
	parseOwnedJobRegistry,
	verifyOwnedJobRegistry,
} from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import * as natives from "@oh-my-pi/pi-natives";
import { processIdentity } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as brokerClients from "@oh-my-pi/pi-coding-agent/launch/client";
import { modeService, startService } from "@oh-my-pi/pi-coding-agent/launch/services";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { DAEMON_BROKER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/launch/protocol";

/** Where the owner-marker scan can see every same-user process a shell may start. */
const OWNER_SCAN_COVERS_PLATFORM = process.platform === "linux";

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
		expect(records[0]).toMatchObject({ type: "invocation", complete: false });
		const header = records[0];
		if (header?.type !== "invocation") throw new Error("expected a header");
		expect(header.incompleteReasons).toContain("registry write failed");
		// The job whose start never reached disk is not carried as if it had been recorded.
		expect(records.some(record => record.type === "start")).toBe(false);
	});

	it("records a daemon broker it spawns as an internal helper that is never counted as work", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, {
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

	it("marks the registry incomplete when a service start ends without reporting its process", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, {
			runtimeDir: path.join(tempDir.path(), "runtime"),
			idleGraceMs: 100,
		});
		// The broker may have started the service when the request timed out in transit.
		vi.spyOn(client, "request").mockRejectedValue(new Error("Daemon start request timed out"));
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "session",
		};
		try {
			await expect(startService(session, { name: "svc", command: "sleep 30" })).rejects.toThrow("timed out");
			expect(registry.complete).toBe(false);
			const records = readRecords(ownedJobRegistryPath(sessionFile));
			expect(records).toContainEqual(
				expect.objectContaining({
					type: "incomplete",
					reason: "a service start ended without reporting its process",
				}),
			);
			// The pending start record is closed; nothing claims the service was recorded.
			expect(records.some(record => record.type === "start" && record.kind === "service")).toBe(false);
		} finally {
			vi.restoreAllMocks();
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
		// Clear only when nothing stood in the way: an unexaminable same-user process started
		// meanwhile (common on macOS) must read as unknown, never clear.
		expect(after.status).toBe(after.reasons.length === 0 ? "clear" : "unknown");
	});

	/** Seconds for a probe sleep: unique per run, so it is never confused with another process. */
	function uniqueSleep(): string {
		return String(4000 + Math.floor(Math.random() * 5000));
	}

	/**
	 * Run a throwaway agent on this test's session file that registers a live detached sleep,
	 * starts a marked-but-unregistered daemon, marks itself incomplete, then crashes. Returns
	 * both pids.
	 */
	async function crashEarlierInvocation(): Promise<{ recordedPid: number; markedPid: number }> {
		const script = path.join(tempDir.path(), "crash-resume.ts");
		const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry, ownerMarkerEnv } from ${JSON.stringify(registryModule)};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
				`const recorded = Bun.spawn(["/bin/sleep", ${JSON.stringify(uniqueSleep())}], { stdout: "ignore", stderr: "ignore", detached: true });`,
				"recorded.unref();",
				`registry.registerProcess({ kind: "process", pid: recorded.pid, command: "sleep" });`,
				`const marked = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { env: { ...process.env, ...ownerMarkerEnv() }, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
				"marked.unref();",
				`registry.markIncomplete("crashed invocation could not vouch");`,
				"console.log(JSON.stringify({ recordedPid: recorded.pid, markedPid: marked.pid }));",
				`process.kill(process.pid, "SIGKILL");`,
			].join("\n"),
		);
		const agent = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
		const pids = JSON.parse((await new Response(agent.stdout).text()).trim()) as {
			recordedPid: number;
			markedPid: number;
		};
		spawned.push(pids.recordedPid, pids.markedPid);
		expect(await agent.exited).not.toBe(0);
		return pids;
	}

	it("adopts a crashed earlier invocation's live processes and incompleteness when it resumes the file", async () => {
		const { recordedPid } = await crashEarlierInvocation();
		// This registry is a new invocation binding the same session file: a resume.
		registry.ensureHeader();
		expect(registry.liveProcessCount()).toBeGreaterThanOrEqual(1);
		expect(registry.openJobs()).toContainEqual(
			expect.objectContaining({
				pid: recordedPid,
				adoptedFrom: expect.objectContaining({ pid: expect.any(Number) }),
			}),
		);
		expect(registry.complete).toBe(false);
		expect(registry.incompleteReasons).toContain("inherited: crashed invocation could not vouch");
		// The file says so too: the resumed header is incomplete and the adopted record is ours.
		const records = readRecords(ownedJobRegistryPath(sessionFile));
		const headers = records.filter(record => record.type === "invocation");
		expect(headers.at(-1)).toMatchObject({ complete: false, invocation: { pid: process.pid } });
		expect(records).toContainEqual(
			expect.objectContaining({ type: "start", pid: recordedPid, invocationPid: process.pid }),
		);
	});

	it("scans the owner tokens of earlier invocations after a resume", async () => {
		const { markedPid } = await crashEarlierInvocation();
		registry.ensureHeader();
		const header = readRecords(ownedJobRegistryPath(sessionFile))
			.filter(record => record.type === "invocation")
			.at(-1);
		if (header?.type !== "invocation") throw new Error("expected a header");
		expect(header.inheritedOwnerMarkers).toHaveLength(1);
		// Only the crashed invocation's token marks this daemon; this invocation now finds it.
		expect(registry.scanOwnedProcesses().discovered).toBeGreaterThanOrEqual(1);
		expect(registry.openJobs()).toContainEqual(expect.objectContaining({ pid: markedPid, discovered: true }));
	});

	it("carries records into a file it already headered when switching back to it", () => {
		const first = sessionFile;
		const other = path.join(tempDir.path(), "2026-01-02_other.jsonl");
		registry.ensureHeader();
		sessionFile = other;
		registry.ensureHeader();
		registry.registerInProcessJob({ jobId: "job-on-other", kind: "async-job", command: "x" });
		sessionFile = first;
		registry.ensureHeader();
		expect(readRecords(ownedJobRegistryPath(first))).toContainEqual(
			expect.objectContaining({ type: "start", jobId: "job-on-other", carriedFrom: ownedJobRegistryPath(other) }),
		);
	});

	it("answers unknown when the invocation a consumer observed never reached the file", () => {
		// Only an ended invocation wrote this file; the one the consumer attested never did.
		const file = path.join(tempDir.path(), "ended.jobs.jsonl");
		fs.writeFileSync(file, `${JSON.stringify(header(0x7ffffff1, "5"))}\n`);
		const expectedInvocation = { pid: 0x7ffffff0, startId: "1" };
		const verdict = verifyOwnedJobRegistry(file, { expectedInvocation });
		expect(verdict.status).toBe("unknown");
		expect(verdict.reasons).toContain(`invocation ${expectedInvocation.pid} has no header in the registry`);
	});

	/** A header for a dead invocation (pids near the maximum never exist in tests). */
	function header(pid: number, startId: string): OwnedJobRecord {
		return {
			type: "invocation",
			version: 1,
			invocation: { pid, startId, startTime: 0 },
			sessionId: "s",
			complete: true,
			ownerMarker: { env: "OMP_OWNER", token: `omp1:${pid}:${startId}` },
			at: "2026-01-01T00:00:00.000Z",
		};
	}

	function inProcessStart(pid: number, jobId: string): OwnedJobRecord {
		return {
			type: "start",
			jobId,
			kind: "shell-run",
			pid,
			pgid: null,
			startTime: 0,
			startId: "5",
			command: "x",
			cwd: null,
			sleepable: false,
			inProcess: true,
			invocationPid: pid,
			registeredAt: "2026-01-01T00:00:00.000Z",
		};
	}

	it("never lets a later invocation with a reused pid close an earlier invocation's job", () => {
		const pid = 0x7ffffff2;
		const file = path.join(tempDir.path(), "reuse.jobs.jsonl");
		const end: OwnedJobRecord = {
			type: "end",
			jobId: "shell-run:1",
			how: "settled",
			invocationPid: pid,
			endedAt: "x",
		};
		fs.writeFileSync(
			file,
			[
				header(pid, "5"),
				inProcessStart(pid, "shell-run:1"),
				header(pid, "9"),
				inProcessStart(pid, "shell-run:1"),
				end,
			]
				.map(record => JSON.stringify(record))
				.join("\n"),
		);
		const verdict = verifyOwnedJobRegistry(file);
		expect(verdict.status).toBe("unknown");
		expect(verdict.reasons).toContain("shell-run shell-run:1 never ended");
	});

	it("treats unknown record types and malformed lines as unknown instead of guessing", () => {
		const pid = 0x7ffffff3;
		const file = path.join(tempDir.path(), "odd.jobs.jsonl");
		for (const odd of ['{"type":"heartbeat","jobId":"j","invocationPid":1}', "null", '{"type":"invocation"}']) {
			fs.writeFileSync(file, `${JSON.stringify(header(pid, "5"))}\n${odd}\n`);
			const verdict = verifyOwnedJobRegistry(file);
			expect(verdict.status).toBe("unknown");
		}
	});

	it("marks the registry incomplete for every PTY run, on every platform", () => {
		expect(registry.complete).toBe(true);
		const end = registry.beginPtyRun({ command: "vim notes.txt", cwd: tempDir.path() });
		expect(registry.complete).toBe(false);
		expect(registry.openJobs()).toContainEqual(
			expect.objectContaining({ kind: "shell-run", command: "vim notes.txt" }),
		);
		end();
		expect(registry.openJobs().some(record => record.kind === "shell-run")).toBe(false);
		expect(registry.complete).toBe(false);
	});

	it("gives extension, hook and custom-tool commands the owner marker", async () => {
		const result = await execCommand("/bin/sh", ["-c", 'printf %s "$OMP_OWNER"'], tempDir.path());
		expect(result.stdout.split(",")).toContain(ownerToken());
	});

	it("records the new process when a mode change restarts a service, keeping its sleepable mark", async () => {
		const first = Bun.spawn(["/bin/sleep", uniqueSleep()], { stdout: "ignore", stderr: "ignore" });
		const second = Bun.spawn(["/bin/sleep", uniqueSleep()], { stdout: "ignore", stderr: "ignore" });
		spawned.push(first.pid, second.pid);
		registry.registerProcess({
			kind: "service",
			jobId: "service:d1:1",
			pid: first.pid,
			command: "npm run dev",
			sleepable: true,
		});
		const daemon: DaemonSnapshot = {
			name: "web",
			id: "d1",
			state: "running",
			pid: second.pid,
			createdAt: 0,
			startedAt: 2,
			restartCount: 1,
			outputBytes: 0,
			persist: false,
			detached: true,
		};
		const client = await brokerClients.createDaemonBrokerClient(path.join(tempDir.path(), "project"), {
			runtimeDir: path.join(tempDir.path(), "runtime"),
			idleGraceMs: 100,
		});
		vi.spyOn(client, "request").mockResolvedValue({ op: "mode", daemon });
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		try {
			await modeService(toolSession(), "web", "detached");
			expect(registry.openJobs()).toContainEqual(
				expect.objectContaining({
					jobId: "service:d1:2",
					pid: second.pid,
					sleepable: true,
					command: "npm run dev",
				}),
			);
		} finally {
			vi.restoreAllMocks();
			client.close();
		}
	});

	function toolSession(): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "session",
		};
	}

	/**
	 * Start another invocation on this test's session file while this registry already has it
	 * bound (a second OMP resuming the same session). It records a detached sleep and an
	 * in-process job it never ends, prints its pid, and then either exits normally or stays up.
	 */
	async function startConcurrentInvocation(stayAlive: boolean): Promise<{ agentPid: number; recordedPid: number }> {
		const script = path.join(tempDir.path(), `concurrent-${stayAlive ? "alive" : "exit"}.ts`);
		const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry } from ${JSON.stringify(registryModule)};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "concurrent", pollIntervalMs: 0 });`,
				`const recorded = Bun.spawn(["/bin/sleep", ${JSON.stringify(uniqueSleep())}], { stdout: "ignore", stderr: "ignore", detached: true });`,
				"recorded.unref();",
				`registry.registerProcess({ kind: "process", pid: recorded.pid, command: "sleep" });`,
				`registry.registerInProcessJob({ jobId: "shell-run:1", kind: "shell-run", command: "long run" });`,
				"console.log(JSON.stringify({ agentPid: process.pid, recordedPid: recorded.pid }));",
				stayAlive ? "setInterval(() => {}, 1 << 30);" : "process.exit(0);",
			].join("\n"),
		);
		const agent = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
		const reader = agent.stdout.getReader();
		let text = "";
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();
		const pids = JSON.parse(text.trim()) as { agentPid: number; recordedPid: number };
		spawned.push(pids.recordedPid);
		if (stayAlive) spawned.push(pids.agentPid);
		else expect(await agent.exited).toBe(0);
		return pids;
	}

	it("sees work another invocation started on the same session file after this one bound it", async () => {
		registry.ensureHeader();
		expect(registry.liveProcessCount()).toBe(0);
		const { recordedPid } = await startConcurrentInvocation(false);
		// Every attest, quiesce and hang-up count runs the owner scan, which reads the new tail.
		registry.scanOwnedProcesses();
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.openJobs()).toContainEqual(
			expect.objectContaining({ pid: recordedPid, adoptedFrom: expect.any(Object) }),
		);
		// Its run never ended and it is gone: this registry cannot vouch for what that run started.
		expect(registry.complete).toBe(false);
		expect(registry.incompleteReasons.some(reason => reason.endsWith("left shell-run work unfinished"))).toBe(true);
	});

	it("counts another invocation still running on the same session file as live work", async () => {
		registry.ensureHeader();
		const { agentPid } = await startConcurrentInvocation(true);
		registry.scanOwnedProcesses();
		// Its own process and its recorded sleep.
		expect(registry.liveProcessCount()).toBe(2);
		expect(registry.complete).toBe(true);
		// Once it is gone, its unfinished run makes this registry incomplete.
		const agent = Bun.spawn(["/bin/kill", "-9", String(agentPid)]);
		await agent.exited;
		await eventually(() => ownedProcessState(agentPid, null) === "gone", "the other invocation to exit");
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.complete).toBe(false);
	});

	it("flags a crashed earlier invocation's unfinished in-process run on resume", async () => {
		const script = path.join(tempDir.path(), "crash-run.ts");
		const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry } from ${JSON.stringify(registryModule)};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
				`registry.registerInProcessJob({ jobId: "shell-run:1", kind: "shell-run", command: "long run" });`,
				`process.kill(process.pid, "SIGKILL");`,
			].join("\n"),
		);
		const agent = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "inherit" });
		expect(await agent.exited).not.toBe(0);
		// Nothing else is wrong with the file: only the open run can make the resume incomplete.
		registry.ensureHeader();
		expect(registry.complete).toBe(false);
		expect(registry.incompleteReasons.some(reason => reason.endsWith("left shell-run work unfinished"))).toBe(true);
	});

	it("never reads a header as complete unless `complete` is exactly true with no reasons", () => {
		const pid = 0x7ffffff4;
		for (const override of [{ complete: false, incompleteReasons: [] }, { complete: "false" }, { complete: 1 }]) {
			const file = path.join(tempDir.path(), "crafted.jobs.jsonl");
			fs.writeFileSync(file, `${JSON.stringify({ ...header(pid, "5"), ...override })}\n`);
			expect(verifyOwnedJobRegistry(file).status).toBe("unknown");
		}
		// A resume over such a file does not claim completeness either.
		fs.writeFileSync(
			ownedJobRegistryPath(sessionFile),
			`${JSON.stringify({ ...header(pid, "5"), complete: false, incompleteReasons: [] })}\n`,
		);
		registry.ensureHeader();
		expect(registry.complete).toBe(false);
	});

	it("treats malformed owner markers as a malformed header and never copies them", () => {
		const pid = 0x7ffffff5;
		for (const markers of [{}, [{}], [{ token: 7, startId: "1" }]]) {
			const file = ownedJobRegistryPath(sessionFile);
			fs.writeFileSync(file, `${JSON.stringify({ ...header(pid, "5"), inheritedOwnerMarkers: markers })}\n`);
			expect(verifyOwnedJobRegistry(file).status).toBe("unknown");
		}
		registry.ensureHeader();
		expect(registry.complete).toBe(false);
		const ours = readRecords(ownedJobRegistryPath(sessionFile))
			.filter(record => record.type === "invocation")
			.at(-1);
		if (ours?.type !== "invocation") throw new Error("expected this invocation's header");
		expect(ours.inheritedOwnerMarkers).toBeUndefined();
		// Every later scan still works.
		expect(registry.scanOwnedProcesses().supported).toBe(process.platform !== "win32");
	});

	it("starts a new line after a torn record so the next header is not swallowed", () => {
		const file = ownedJobRegistryPath(sessionFile);
		fs.writeFileSync(file, `${JSON.stringify(header(0x7ffffff6, "5"))}\n{"type":"start","jobId":"torn`);
		registry.ensureHeader();
		const parsed = parseOwnedJobRegistry(fs.readFileSync(file, "utf8"));
		expect(parsed.segments.map(segment => segment.header.invocation.pid)).toEqual([0x7ffffff6, process.pid]);
		expect(parsed.problems).toEqual(["registry has a malformed record"]);
	});

	it.skipIf(process.platform !== "linux")(
		"stops copying a taken-over owner token once nothing can carry it",
		async () => {
			const { markedPid, recordedPid } = await crashEarlierInvocation();
			registry.ensureHeader();
			for (const pid of [markedPid, recordedPid]) {
				const kill = Bun.spawn(["/bin/kill", "-9", String(pid)]);
				await kill.exited;
				await eventually(() => ownedProcessState(pid, null) === "gone", `pid ${pid} to exit`);
			}
			registry.liveProcessCount();
			// Two consecutive sound scans that find nobody carrying it.
			expect(registry.scanOwnedProcesses().sound).toBe(true);
			expect(registry.scanOwnedProcesses().sound).toBe(true);
			// The next file this invocation binds no longer lists the dead token.
			sessionFile = path.join(tempDir.path(), "2026-01-03_next.jsonl");
			registry.ensureHeader();
			const next = readRecords(ownedJobRegistryPath(sessionFile)).find(record => record.type === "invocation");
			if (next?.type !== "invocation") throw new Error("expected a header");
			expect(next.inheritedOwnerMarkers).toBeUndefined();
		},
	);

	/** Bind a fresh session file and return the taken-over tokens its new header lists. */
	function tokensOnNextBind(): string[] {
		sessionFile = path.join(tempDir.path(), `${crypto.randomUUID()}.jsonl`);
		registry.ensureHeader();
		const next = readRecords(ownedJobRegistryPath(sessionFile)).find(record => record.type === "invocation");
		if (next?.type !== "invocation") throw new Error("expected a header");
		return (next.inheritedOwnerMarkers ?? []).map(marker => marker.token);
	}

	function cleanScan(opaque: natives.MarkedProcess[] = []): natives.MarkedProcessScan {
		return { supported: true, hidden: false, processes: [], scanned: 1, unreadable: 0, redacted: 0, opaque };
	}

	it("keeps a taken-over token while work adopted from its invocation is open, and prunes it only after two clean scans", async () => {
		const pid = 0x7ffffff8;
		const token = `omp1:${pid}:5`;
		const child = Bun.spawn(["/bin/sleep", uniqueSleep()], { stdout: "ignore", stderr: "ignore" });
		spawned.push(child.pid);
		const identity = processIdentity(child.pid);
		const adopted: OwnedJobRecord = {
			type: "start",
			jobId: "process:1",
			kind: "process",
			pid: child.pid,
			pgid: null,
			startTime: identity.startTime ?? null,
			startId: identity.startId ?? null,
			command: "sleep",
			cwd: null,
			sleepable: false,
			inProcess: false,
			invocationPid: pid,
			registeredAt: "2026-01-01T00:00:00.000Z",
		};
		fs.writeFileSync(
			ownedJobRegistryPath(sessionFile),
			`${JSON.stringify(header(pid, "5"))}\n${JSON.stringify(adopted)}\n`,
		);
		registry.ensureHeader();
		expect(registry.liveProcessCount()).toBe(1);
		const scan = vi.spyOn(natives, "scanProcessesByEnv").mockReturnValue(cleanScan());
		try {
			// Its issuer is gone and no scan finds the token, but the adopted process could hand
			// it to a child at any time.
			registry.scanOwnedProcesses();
			registry.scanOwnedProcesses();
			expect(tokensOnNextBind()).toContain(token);
			child.kill("SIGKILL");
			await child.exited;
			expect(registry.liveProcessCount()).toBe(0);
			registry.scanOwnedProcesses();
			expect(tokensOnNextBind()).toContain(token);
			registry.scanOwnedProcesses();
			expect(tokensOnNextBind()).not.toContain(token);
			expect(scan).toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("never prunes a taken-over token while a tracked process's environment cannot be read", () => {
		const pid = 0x7ffffff9;
		const token = `omp1:${pid}:5`;
		fs.writeFileSync(ownedJobRegistryPath(sessionFile), `${JSON.stringify(header(pid, "5"))}\n`);
		registry.ensureHeader();
		const child = Bun.spawn(["/bin/sleep", uniqueSleep()], { stdout: "ignore", stderr: "ignore" });
		spawned.push(child.pid);
		const identity = processIdentity(child.pid);
		// Found once through a token; this registry now tracks it, but it adopted nothing.
		registry.registerProcess({ kind: "process", pid: child.pid, command: "sleep", discovered: true });
		const unreadable: natives.MarkedProcess = {
			pid: child.pid,
			ppid: process.pid,
			startId: identity.startId,
			command: "sleep",
		};
		vi.spyOn(natives, "scanProcessesByEnv").mockReturnValue(cleanScan([unreadable]));
		try {
			// Tracked, so counted and not opaque for soundness, but it may carry the token.
			expect(registry.scanOwnedProcesses().sound).toBe(true);
			expect(registry.scanOwnedProcesses().sound).toBe(true);
			expect(tokensOnNextBind()).toContain(token);
			vi.spyOn(natives, "scanProcessesByEnv").mockReturnValue(cleanScan());
			registry.scanOwnedProcesses();
			registry.scanOwnedProcesses();
			expect(tokensOnNextBind()).not.toContain(token);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
		"finds a child an adopted carrier with an unreadable environment forks after later scans",
		async () => {
			const dir = tempDir.path();
			const ready = path.join(dir, "carrier-ready");
			const forkNow = path.join(dir, "carrier-fork");
			const childPidFile = path.join(dir, "carrier-child");
			const carrier = path.join(dir, "carrier.ts");
			await Bun.write(
				carrier,
				[
					`import { dlopen, FFIType } from "bun:ffi";`,
					`import * as fs from "node:fs";`,
					`const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });`,
					// PR_SET_DUMPABLE 0: /proc/<pid>/environ is no longer readable by this user.
					"if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) process.exit(3);",
					`fs.writeFileSync(${JSON.stringify(ready)}, "");`,
					"const timer = setInterval(() => {",
					`\tif (!fs.existsSync(${JSON.stringify(forkNow)})) return;`,
					"\tclearInterval(timer);",
					`\tconst child = Bun.spawn(["/bin/sleep", ${JSON.stringify(uniqueSleep())}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
					"\tchild.unref();",
					`\tfs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
					"\tprocess.exit(0);",
					"}, 20);",
				].join("\n"),
			);
			const script = path.join(dir, "crash-carrier.ts");
			const registryModule = path.join(import.meta.dir, "../src/session/owned-job-registry.ts");
			await Bun.write(
				script,
				[
					`import { OwnedJobRegistry, ownerMarkerEnv, ownerToken } from ${JSON.stringify(registryModule)};`,
					`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
					`const carrier = Bun.spawn([process.execPath, ${JSON.stringify(carrier)}], { env: { ...process.env, ...ownerMarkerEnv() }, detached: true, stdin: "ignore", stdout: "ignore", stderr: "inherit" });`,
					"carrier.unref();",
					`registry.registerProcess({ kind: "process", pid: carrier.pid, command: "carrier" });`,
					"console.log(JSON.stringify({ carrierPid: carrier.pid, token: ownerToken() }));",
					`process.kill(process.pid, "SIGKILL");`,
				].join("\n"),
			);
			const agent = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
			const { carrierPid, token } = JSON.parse((await new Response(agent.stdout).text()).trim()) as {
				carrierPid: number;
				token: string;
			};
			spawned.push(carrierPid);
			expect(await agent.exited).not.toBe(0);
			await eventually(() => fs.existsSync(ready), "the carrier to hide its environment");
			// Precondition: the carrier's environment really cannot be read.
			expect(natives.scanProcessesByEnv("OMP_OWNER", [token], "0").opaque.map(proc => proc.pid)).toContain(
				carrierPid,
			);

			registry.ensureHeader();
			expect(registry.liveProcessCount()).toBe(1);
			registry.scanOwnedProcesses();
			registry.scanOwnedProcesses();
			// The carrier hands the token to a child and exits.
			fs.writeFileSync(forkNow, "");
			await eventually(
				() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf8") !== "",
				"the fork",
			);
			const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
			spawned.push(childPid);
			await eventually(() => ownedProcessState(carrierPid, null) === "gone", "the carrier to exit");
			expect(registry.scanOwnedProcesses().discovered).toBe(1);
			expect(registry.openJobs()).toContainEqual(expect.objectContaining({ pid: childPid, discovered: true }));
			expect(registry.liveProcessCount()).toBe(1);
		},
	);
});
