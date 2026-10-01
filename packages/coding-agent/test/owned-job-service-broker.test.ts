import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../src/launch/client";
import { daemonMetadataPath } from "../src/launch/paths";
import { registerDaemonProjectPresence } from "../src/launch/presence";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../src/launch/protocol";
import {
	type OwnedJobRecord,
	OwnedJobRegistry,
	ownedJobRegistryPath,
	ownedProcessState,
	parseOwnedJobRegistry,
	verifyOwnedJobRegistry,
} from "../src/session/owned-job-registry";

/**
 * Run a daemon broker inside this process (its pid is this process's) and wait until it
 * serves. `finished` settles once it shut down.
 */
async function startEmbeddedBroker(
	projectDir: string,
	runtimeDir: string,
	restartBackoffBaseMs: number,
): Promise<{ finished: Promise<void> }> {
	const keys = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV] as const;
	const previous = keys.map(key => process.env[key]);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({
		restartBackoffBaseMs,
		onListening: () => listening.resolve(true),
	});
	for (const [index, key] of keys.entries()) {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	}
	if (!(await Promise.race([listening.promise, finished.then(() => false)]))) {
		throw new Error("embedded daemon broker did not claim its scope");
	}
	return { finished };
}

function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll `condition` (bounded). */
async function eventually(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await pause(20);
	}
}

function publishedState(meta: string): { state?: string; pid?: number } {
	try {
		return JSON.parse(fs.readFileSync(meta, "utf8")).daemon ?? {};
	} catch {
		return {};
	}
}

function readRecords(file: string): OwnedJobRecord[] {
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as OwnedJobRecord);
}

/** Seconds for a probe sleep, unique per run so it is never confused with another process. */
function uniqueSleep(): string {
	return String(7600 + Math.floor(Math.random() * 300));
}

describe.skipIf(process.platform === "win32")("owned-job registry: broker-hosted services", () => {
	let tempDir: TempDir;
	let sessionFile: string;
	let registry: OwnedJobRegistry;
	const spawned: number[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-service-broker-");
		sessionFile = path.join(tempDir.path(), "2026-01-01_session.jsonl");
		registry = new OwnedJobRegistry({
			getSessionFile: () => sessionFile,
			getSessionId: () => "session",
			pollIntervalMs: 0,
		});
		OwnedJobRegistry.setInstance(registry);
	});

	afterEach(() => {
		for (const pid of spawned.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		registry.close();
		OwnedJobRegistry.setInstance(undefined);
		tempDir.removeSync();
	});

	it("keeps counting a service its broker is about to relaunch, records the relaunch, and ends it once the broker stops it", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		fs.mkdirSync(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		// A long backoff keeps the service in `restarting` for the whole check.
		const broker = await startEmbeddedBroker(projectDir, runtimeDir, 60_000);
		const brokerPid = process.pid;
		const meta = daemonMetadataPath(runtimeDir, "svc");
		const serviceJobs = () => registry.openJobs().flatMap(job => (job.kind === "service" ? [job.jobId] : []));
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "svc",
					application: "/bin/sleep",
					args: [uniqueSleep()],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "on-failure",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("service did not start");
			const first = started.daemon;
			const firstPid = started.daemon.pid;
			spawned.push(firstPid);
			const firstJob = `service:${first.id}:${first.startedAt}`;
			registry.registerProcess({
				kind: "service",
				jobId: firstJob,
				pid: firstPid,
				command: "sleep",
				broker: { pid: brokerPid },
				daemon: { id: first.id, meta },
			});
			expect(registry.liveProcessCount()).toBe(1);

			// Killed out of band: the broker settles it as failed and arms a relaunch.
			process.kill(firstPid, "SIGKILL");
			await eventually(() => publishedState(meta).state === "restarting", "the restart backoff");
			expect(ownedProcessState(firstPid, null)).toBe("gone");
			expect(registry.liveProcessCount()).toBe(1);
			expect(serviceJobs()).toEqual([firstJob]);

			// Relaunched (as `omp ps restart` does): the new process carries the work.
			const restarted = await client.request({ op: "restart", name: "svc" });
			if (restarted.op !== "restart" || restarted.daemon.pid === undefined)
				throw new Error("service did not relaunch");
			const secondPid = restarted.daemon.pid;
			spawned.push(secondPid);
			await eventually(() => publishedState(meta).pid === secondPid, "the relaunch to be published");
			expect(registry.liveProcessCount()).toBe(1);
			expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([
				expect.objectContaining({
					pid: secondPid,
					jobId: `service:${first.id}:${restarted.daemon.startedAt}`,
					broker: expect.objectContaining({ pid: brokerPid }),
				}),
			]);

			// Stopped terminally by the broker: nothing is left to relaunch.
			await client.request({ op: "stop", name: "svc", timeoutMs: 2_000 });
			await eventually(() => registry.liveProcessCount() === 0, "the stopped service to end");
			expect(serviceJobs()).toEqual([]);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 30_000);

	it("verifies a crashed agent's service as blocked while its broker lives, and releases it once the broker is gone", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const home = path.join(tempDir.path(), "home");
		fs.mkdirSync(projectDir);
		fs.mkdirSync(home);
		const script = path.join(tempDir.path(), "crash-service.ts");
		const src = path.join(import.meta.dir, "../src");
		await Bun.write(
			script,
			[
				`import { OwnedJobRegistry } from ${JSON.stringify(path.join(src, "session/owned-job-registry.ts"))};`,
				`import { modeService, startService } from ${JSON.stringify(path.join(src, "launch/services.ts"))};`,
				`import { daemonClientForProject } from ${JSON.stringify(path.join(src, "launch/client.ts"))};`,
				`import { Settings } from ${JSON.stringify(path.join(src, "config/settings.ts"))};`,
				`const registry = new OwnedJobRegistry({ getSessionFile: () => ${JSON.stringify(sessionFile)}, getSessionId: () => "crashed", pollIntervalMs: 0 });`,
				"OwnedJobRegistry.setInstance(registry);",
				`const session = { cwd: ${JSON.stringify(projectDir)}, hasUI: false, settings: Settings.isolated(), getSessionFile: () => null, getSessionSpawns: () => "*", getSessionId: () => "crashed" };`,
				`const { daemon } = await startService(session, { name: "svc", command: "/bin/sleep ${uniqueSleep()}", pty: false });`,
				// Persistent: the broker keeps hosting it after this agent is gone.
				`await modeService(session, "svc", "persist");`,
				`const client = await daemonClientForProject(${JSON.stringify(projectDir)});`,
				"console.log(JSON.stringify({ pid: daemon.pid, runtimeDir: client.runtimeDir }));",
				`process.kill(process.pid, "SIGKILL");`,
			].join("\n"),
		);
		// The agent's broker scope lives under its own home, never the user's.
		const env: Record<string, string> = { HOME: home };
		for (const [key, value] of Object.entries(process.env)) {
			if (
				value === undefined ||
				key === "HOME" ||
				key.startsWith("XDG_") ||
				key.startsWith("PI_") ||
				key === "OMP_PROFILE"
			)
				continue;
			env[key] = value;
		}
		const agent = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "inherit" });
		const output = (await new Response(agent.stdout).text()).trim();
		expect(await agent.exited).not.toBe(0);
		const { pid: servicePid, runtimeDir } = JSON.parse(output) as { pid: number; runtimeDir: string };
		expect(runtimeDir.startsWith(home)).toBe(true);
		spawned.push(servicePid);
		const brokerClient: DaemonBrokerClient = await createDaemonBrokerClient(projectDir, { runtimeDir });
		// Keep the broker from idling out until the check is done.
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			const record = readRecords(ownedJobRegistryPath(sessionFile)).find(
				entry => entry.type === "start" && entry.kind === "service",
			);
			if (record?.type !== "start" || !record.broker) throw new Error("expected a service record with its broker");
			const brokerPid = record.broker.pid;
			expect(ownedProcessState(brokerPid, record.broker.startId)).toBe("alive");
			expect(verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile))).toMatchObject({
				status: "blocked",
				live: [expect.objectContaining({ pid: servicePid })],
			});

			// The service process is gone; its broker still hosts it and could relaunch it.
			process.kill(servicePid, "SIGKILL");
			await eventually(() => ownedProcessState(servicePid, record.startId) === "gone", "the service to exit");
			expect(verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile))).toMatchObject({
				status: "blocked",
				live: [expect.objectContaining({ jobId: record.jobId, broker: brokerPid })],
			});

			// With its broker gone, nothing can relaunch it.
			await brokerClient.request({ op: "shutdown" }).catch(() => undefined);
			await eventually(
				() => ownedProcessState(brokerPid, record.broker?.startId) === "gone",
				"the broker to exit",
				15_000,
			);
			const after = verifyOwnedJobRegistry(ownedJobRegistryPath(sessionFile));
			expect(after.live).toEqual([]);
			expect(after.status).toBe(after.reasons.length === 0 ? "clear" : "unknown");
		} finally {
			await presence.close();
			await brokerClient.request({ op: "shutdown" }).catch(() => undefined);
			brokerClient.close();
		}
	}, 45_000);

	it("treats a service record whose broker has the wrong shape as malformed", () => {
		const header = {
			type: "invocation",
			version: 1,
			invocation: { pid: 1, startId: "1" },
			sessionId: "s",
			complete: true,
		};
		const start = {
			type: "start",
			jobId: "service:d:1",
			kind: "service",
			pid: 2,
			startId: "2",
			inProcess: false,
			invocationPid: 1,
			broker: { pid: "3", startId: "3" },
		};
		const parsed = parseOwnedJobRegistry(`${JSON.stringify(header)}\n${JSON.stringify(start)}\n`);
		expect(parsed.problems).toContain("registry has a malformed start record");
		expect(parsed.segments[0]?.open.size).toBe(0);
	});
});
