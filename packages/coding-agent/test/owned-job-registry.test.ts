import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import {
	isOwnedProcessAlive,
	type OwnedJobRecord,
	OwnedJobRegistry,
	ownedJobRegistryPath,
} from "@oh-my-pi/pi-coding-agent/session/owned-job-registry";
import { processStartTime } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

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
	});
});
