import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../src/launch/broker";
import * as brokerClients from "../src/launch/client";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../src/launch/client";
import { daemonMetadataPath } from "../src/launch/paths";
import * as presence from "../src/launch/presence";
import { registerDaemonProjectPresence } from "../src/launch/presence";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonRpcResult,
} from "../src/launch/protocol";
import { startService } from "../src/launch/services";
import type { ToolSession } from "../src/tools";
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

/** Let other tasks (the embedded broker included) run before continuing. */
function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Pids no process has; their identity is stubbed per test. */
const FAKE_SERVICE_PID = 0x7ffffff0;
const FAKE_BROKER_PID = 0x7ffffff1;
const FAKE_AGENT_PID = 0x7ffffff2;

/** Answer `processIdentity` from `stubs` for the fake pids, and truthfully otherwise. */
function stubIdentities(stubs: Map<number, natives.ProcessIdentity>): void {
	const realIdentity = natives.processIdentity;
	vi.spyOn(natives, "processIdentity").mockImplementation(pid => stubs.get(pid) ?? realIdentity(pid));
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

/** A sleep duration no other process uses, so its processes can be found by their argv. */
function markerSleep(): string {
	return String(10_000_000 + Math.floor(Math.random() * 9_000_000));
}

/** Live (not zombie) processes running `sleep <marker>`. */
function liveSleeps(marker: string): number[] {
	const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,stat=,args="]).stdout.toString();
	const pids: number[] = [];
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match || match[2]!.startsWith("Z")) continue;
		if (/(^|\/)sleep /.test(match[3]!) && match[3]!.endsWith(` ${marker}`)) pids.push(Number(match[1]));
	}
	return pids;
}

/**
 * The processes running `sleep <marker>` once `pid` itself does: the broker publishes a pid
 * as soon as it forks, before the child has exec'd its program.
 */
async function liveSleepsOnce(marker: string, pid: number): Promise<number[]> {
	await eventually(() => liveSleeps(marker).includes(pid), `pid ${pid} to run its program`);
	return liveSleeps(marker);
}

/** Settles (never rejects) once `request` does. */
function settledFlag(request: Promise<unknown>): { readonly done: boolean } {
	const flag = { done: false };
	request.then(
		() => {
			flag.done = true;
		},
		() => {
			flag.done = true;
		},
	);
	return flag;
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
		vi.restoreAllMocks();
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
			// Another session object binding the file (as a resume does) takes it over too.
			const resumed = new OwnedJobRegistry({
				getSessionFile: () => sessionFile,
				getSessionId: () => "session",
				pollIntervalMs: 0,
			});
			try {
				resumed.ensureHeader();
				expect(resumed.openJobs()).toContainEqual(expect.objectContaining({ kind: "service", pid: firstPid }));
			} finally {
				resumed.close();
			}

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

	it("never lets the in-process count reach zero while a restart request relaunches a live service", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		fs.mkdirSync(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startEmbeddedBroker(projectDir, runtimeDir, 1_000);
		const meta = daemonMetadataPath(runtimeDir, "svc");
		try {
			// As the agent starts services: no restart policy of its own.
			const started = await client.request({
				op: "start",
				spec: {
					name: "svc",
					application: "/bin/sleep",
					args: [uniqueSleep()],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("service did not start");
			spawned.push(started.daemon.pid);
			registry.registerProcess({
				kind: "service",
				jobId: `service:${started.daemon.id}:${started.daemon.startedAt}`,
				pid: started.daemon.pid,
				command: "sleep",
				broker: { pid: process.pid },
				daemon: { id: started.daemon.id, meta },
			});

			// `omp ps restart svc`: count as quiesce does (`detachedJobs`) for the whole request.
			let settled = false;
			const restart = client.request({ op: "restart", name: "svc" }).finally(() => {
				settled = true;
			});
			const counts: number[] = [];
			while (!settled) {
				counts.push(registry.liveProcessCount());
				await nextTurn();
			}
			const restarted = await restart;
			if (restarted.op !== "restart" || restarted.daemon.pid === undefined)
				throw new Error("service did not relaunch");
			const secondPid = restarted.daemon.pid;
			spawned.push(secondPid);
			await eventually(() => publishedState(meta).pid === secondPid, "the relaunch to be published");
			counts.push(registry.liveProcessCount());

			expect(counts.length).toBeGreaterThan(1);
			expect(counts.filter(count => count === 0)).toEqual([]);
			expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([
				expect.objectContaining({
					pid: secondPid,
					jobId: `service:${started.daemon.id}:${restarted.daemon.startedAt}`,
					broker: expect.objectContaining({ pid: process.pid }),
				}),
			]);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 30_000);

	/**
	 * Run `body` against a PTY service (as `startService` starts them: no restart policy) in an
	 * embedded broker, with its `service` record registered. With `slowStop` the service
	 * ignores SIGTERM, so a stop takes its whole grace period before SIGKILL. Every process
	 * running the service's marker sleep is killed afterwards, orphans included.
	 */
	async function withPtyService(
		body: (service: {
			client: DaemonBrokerClient;
			meta: string;
			marker: string;
			projectDir: string;
			started: DaemonSnapshot;
		}) => Promise<void>,
		options: { slowStop?: boolean } = {},
	): Promise<void> {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		fs.mkdirSync(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startEmbeddedBroker(projectDir, runtimeDir, 1_000);
		const meta = daemonMetadataPath(runtimeDir, "svc");
		const marker = markerSleep();
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "svc",
					application: options.slowStop ? "/bin/sh" : "/bin/sleep",
					args: options.slowStop ? ["-c", `trap '' TERM; exec /bin/sleep ${marker}`] : [marker],
					env: {},
					cwd: projectDir,
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("service did not start");
			registry.registerProcess({
				kind: "service",
				jobId: `service:${started.daemon.id}:${started.daemon.startedAt}`,
				pid: started.daemon.pid,
				command: "sleep",
				broker: { pid: process.pid },
				daemon: { id: started.daemon.id, meta },
			});
			await body({ client, meta, marker, projectDir, started: started.daemon });
		} finally {
			spawned.push(...liveSleeps(marker));
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}

	it("never lets the count reach zero when a second restart arrives while the first relaunches a PTY service", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const first = client.request({ op: "restart", name: "svc" });
			const firstDone = settledFlag(first);
			let second: Promise<DaemonRpcResult> | undefined;
			let secondDone = { done: false };
			const counts: number[] = [];
			while (!firstDone.done || !secondDone.done) {
				counts.push(registry.liveProcessCount());
				// The first relaunch is under way: its new process is not spawned yet.
				const published = publishedState(meta);
				if (!second && !firstDone.done && published.state === "running" && published.pid === undefined) {
					second = client.request({ op: "restart", name: "svc" });
					secondDone = settledFlag(second);
				}
				if (!second && firstDone.done) throw new Error("the first relaunch was never observed under way");
				await nextTurn();
			}
			const last = await second;
			if (last?.op !== "restart") throw new Error("second restart failed");
			const finalPid = last.daemon.pid;
			if (finalPid === undefined) throw new Error("second restart left no process");
			await eventually(() => publishedState(meta).pid === finalPid, "the last relaunch to be published");
			counts.push(registry.liveProcessCount());

			expect(counts.filter(count => count === 0)).toEqual([]);
			expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([
				expect.objectContaining({ pid: finalPid }),
			]);
			expect(await liveSleepsOnce(marker, finalPid)).toEqual([finalPid]);
		});
	}, 30_000);

	it("runs a stop and a restart sent together in order, losing neither", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const stop = client.request({ op: "stop", name: "svc", timeoutMs: 2_000 });
			const restart = client.request({ op: "restart", name: "svc" });
			const stopped = await stop;
			const restarted = await restart;
			if (stopped.op !== "stop" || restarted.op !== "restart") throw new Error("unexpected results");
			expect(["exited", "failed"]).toContain(stopped.daemon.state);
			const pid = restarted.daemon.pid;
			if (pid === undefined) throw new Error("the restart left no process");
			await eventually(() => publishedState(meta).pid === pid, "the relaunch to be published");
			expect(await liveSleepsOnce(marker, pid)).toEqual([pid]);
		});
	}, 30_000);

	it("runs a restart and a stop sent together in order: the service ends stopped, with no process left", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const restart = client.request({ op: "restart", name: "svc" });
			const stop = client.request({ op: "stop", name: "svc", timeoutMs: 2_000 });
			const restarted = await restart;
			const stopped = await stop;
			if (stopped.op !== "stop" || restarted.op !== "restart") throw new Error("unexpected results");
			expect(["exited", "failed"]).toContain(stopped.daemon.state);
			await eventually(() => liveSleeps(marker).length === 0, "every service process to exit");
			expect(["exited", "failed"]).toContain(publishedState(meta).state ?? "unpublished");
			expect(registry.liveProcessCount()).toBe(0);
		});
	}, 30_000);

	it("leaves no orphan when two restarts arrive together, and a stop then ends every process", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const results = await Promise.all([
				client.request({ op: "restart", name: "svc" }),
				client.request({ op: "restart", name: "svc" }),
			]);
			const last = results[1];
			if (last.op !== "restart" || last.daemon.pid === undefined) throw new Error("the restart left no process");
			const pid = last.daemon.pid;
			await eventually(() => publishedState(meta).pid === pid, "the relaunch to be published");
			expect(await liveSleepsOnce(marker, pid)).toEqual([pid]);

			await client.request({ op: "stop", name: "svc", timeoutMs: 2_000 });
			await eventually(() => liveSleeps(marker).length === 0, "every service process to exit");
		});
	}, 30_000);

	/** A PTY spec for service `svc` running `sleep <marker>`, as a `start` request carries it. */
	function sleepSpec(marker: string, cwd: string) {
		return {
			name: "svc",
			application: "/bin/sleep",
			args: [marker],
			env: {},
			cwd,
			pty: true,
			restart: "no" as const,
			persist: false,
			detached: false,
		};
	}

	it("runs a stop, a restart and a replacing start sent together in order, leaving only the replacement", async () => {
		await withPtyService(
			async ({ client, meta, marker, projectDir }) => {
				const replacement = markerSleep();
				try {
					const [stopped, restarted, started] = await Promise.allSettled([
						client.request({ op: "stop", name: "svc", timeoutMs: 1_000 }),
						client.request({ op: "restart", name: "svc" }),
						client.request({ op: "start", spec: sleepSpec(replacement, projectDir), replace: true }),
					]);
					// In arrival order: the restart relaunches the service before the start replaces it.
					expect(stopped.status).toBe("fulfilled");
					expect(restarted.status).toBe("fulfilled");
					if (started.status !== "fulfilled" || started.value.op !== "start") throw new Error("start failed");
					const pid = started.value.daemon.pid;
					if (pid === undefined) throw new Error("the replacement has no process");
					await eventually(() => liveSleeps(marker).length === 0, "the replaced service's processes to exit");
					expect(publishedState(meta)).toMatchObject({ id: started.value.daemon.id, pid });
					expect(await liveSleepsOnce(replacement, pid)).toEqual([pid]);
				} finally {
					spawned.push(...liveSleeps(replacement));
				}
			},
			{ slowStop: true },
		);
	}, 30_000);

	it("refuses a restart queued behind a replacing start instead of relaunching the replaced service", async () => {
		await withPtyService(
			async ({ client, meta, marker, projectDir }) => {
				const replacement = markerSleep();
				try {
					const [started, restarted] = await Promise.allSettled([
						client.request({ op: "start", spec: sleepSpec(replacement, projectDir), replace: true }),
						client.request({ op: "restart", name: "svc" }),
					]);
					if (started.status !== "fulfilled" || started.value.op !== "start") throw new Error("start failed");
					expect(restarted.status).toBe("rejected");
					expect(restarted.status === "rejected" ? String(restarted.reason) : "").toContain("svc was replaced");
					const pid = started.value.daemon.pid;
					if (pid === undefined) throw new Error("the replacement has no process");
					await eventually(() => liveSleeps(marker).length === 0, "the replaced service's processes to exit");
					expect(publishedState(meta)).toMatchObject({ id: started.value.daemon.id, pid });
					expect(await liveSleepsOnce(replacement, pid)).toEqual([pid]);
				} finally {
					spawned.push(...liveSleeps(replacement));
				}
			},
			{ slowStop: true },
		);
	}, 30_000);

	it("switches a PTY service to detached through the broker without losing count of it", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const mode = client.request({ op: "mode", name: "svc", mode: "detached" });
			const done = settledFlag(mode);
			const counts: number[] = [];
			while (!done.done) {
				counts.push(registry.liveProcessCount());
				await nextTurn();
			}
			const switched = await mode;
			if (switched.op !== "mode" || switched.daemon.pid === undefined)
				throw new Error("mode switch left no process");
			const pid = switched.daemon.pid;
			await eventually(() => publishedState(meta).pid === pid, "the detached process to be published");
			counts.push(registry.liveProcessCount());
			expect(switched.daemon.detached).toBe(true);
			expect(counts.filter(count => count === 0)).toEqual([]);
			expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([expect.objectContaining({ pid })]);
			expect(await liveSleepsOnce(marker, pid)).toEqual([pid]);
		});
	}, 30_000);

	it("leaves one process when a switch to detached and a restart arrive together", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			const [switched, restarted] = await Promise.all([
				client.request({ op: "mode", name: "svc", mode: "detached" }),
				client.request({ op: "restart", name: "svc" }),
			]);
			if (switched.op !== "mode" || restarted.op !== "restart") throw new Error("unexpected results");
			const pid = restarted.daemon.pid;
			if (pid === undefined) throw new Error("the restart left no process");
			await eventually(() => publishedState(meta).pid === pid, "the last relaunch to be published");
			expect(await liveSleepsOnce(marker, pid)).toEqual([pid]);
		});
	}, 30_000);

	it("still runs a lifecycle request queued behind one that failed", async () => {
		await withPtyService(async ({ client, meta, marker }) => {
			await client.request({ op: "stop", name: "svc", timeoutMs: 2_000 });
			const [mode, restart] = await Promise.allSettled([
				// A mode change of a stopped service fails.
				client.request({ op: "mode", name: "svc", mode: "persist" }),
				client.request({ op: "restart", name: "svc" }),
			]);
			expect(mode.status).toBe("rejected");
			if (restart.status !== "fulfilled" || restart.value.op !== "restart")
				throw new Error("the restart did not run");
			const pid = restart.value.daemon.pid;
			if (pid === undefined) throw new Error("the restart left no process");
			await eventually(() => publishedState(meta).pid === pid, "the relaunch to be published");
			expect(await liveSleepsOnce(marker, pid)).toEqual([pid]);
		});
	}, 30_000);

	it("refuses a restart whose turn comes once the broker is shutting down", async () => {
		await withPtyService(
			async ({ client }) => {
				const [, restarted] = await Promise.allSettled([
					client.request({ op: "stop", name: "svc", timeoutMs: 1_000 }),
					client.request({ op: "restart", name: "svc" }),
					client.request({ op: "shutdown" }),
				]);
				expect(restarted.status).toBe("rejected");
				expect(restarted.status === "rejected" ? String(restarted.reason) : "").toContain("shutting down");
			},
			{ slowStop: true },
		);
	}, 30_000);

	it("ends a service record once its broker hosts another service of that name", () => {
		stubIdentities(new Map([[FAKE_SERVICE_PID, { state: "gone" }]]));
		const meta = path.join(tempDir.path(), "meta.json");
		// Still running, but a different service: a `start` with `replace` took the name.
		fs.writeFileSync(meta, JSON.stringify({ daemon: { id: "replacement", state: "running" } }));
		registry.registerProcess({
			kind: "service",
			jobId: "service:original:1",
			pid: FAKE_SERVICE_PID,
			startId: "5",
			command: "svc",
			broker: { pid: process.pid },
			daemon: { id: "original", meta },
		});
		expect(registry.liveProcessCount()).toBe(0);
		expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([]);
	});

	it("ends the record when a restart request's relaunch fails", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const serviceDir = path.join(tempDir.path(), "service-cwd");
		fs.mkdirSync(projectDir);
		fs.mkdirSync(serviceDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startEmbeddedBroker(projectDir, runtimeDir, 1_000);
		const meta = daemonMetadataPath(runtimeDir, "svc");
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "svc",
					application: "/bin/sleep",
					args: [uniqueSleep()],
					env: {},
					cwd: serviceDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("service did not start");
			spawned.push(started.daemon.pid);
			registry.registerProcess({
				kind: "service",
				jobId: `service:${started.daemon.id}:${started.daemon.startedAt}`,
				pid: started.daemon.pid,
				command: "sleep",
				broker: { pid: process.pid },
				daemon: { id: started.daemon.id, meta },
			});
			// Its working directory is gone, so the relaunch cannot start.
			fs.rmSync(serviceDir, { recursive: true });
			await client.request({ op: "restart", name: "svc" });
			await eventually(() => publishedState(meta).state === "failed", "the failed relaunch to be published");
			expect(registry.liveProcessCount()).toBe(0);
			expect(registry.openJobs().filter(job => job.kind === "service")).toEqual([]);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 30_000);

	it("keeps counting a gone service while its broker's metadata cannot be read", () => {
		stubIdentities(new Map([[FAKE_SERVICE_PID, { state: "gone" }]]));
		registry.registerProcess({
			kind: "service",
			jobId: "service:d:1",
			pid: FAKE_SERVICE_PID,
			startId: "5",
			command: "svc",
			broker: { pid: process.pid },
			// A directory: reading it as the broker's metadata fails.
			daemon: { id: "d", meta: tempDir.path() },
		});
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.openJobs().map(job => job.jobId)).toEqual(["service:d:1"]);
	});

	it("never ends a service record whose own process cannot be examined, whatever its broker", () => {
		stubIdentities(
			new Map([
				[FAKE_SERVICE_PID, { state: "unreadable" }],
				[FAKE_BROKER_PID, { state: "gone" }],
			]),
		);
		registry.registerProcess({
			kind: "service",
			jobId: "service:d:1",
			pid: FAKE_SERVICE_PID,
			startId: "5",
			command: "svc",
			broker: { pid: FAKE_BROKER_PID, startId: "7" },
			daemon: { id: "d", meta: tempDir.path() },
		});
		expect(registry.liveProcessCount()).toBe(1);
		expect(registry.openJobs().map(job => job.jobId)).toEqual(["service:d:1"]);
	});

	it("verifies a gone service as unexaminable, never ended, when its own process or its broker cannot be read", () => {
		const unreadableService = FAKE_SERVICE_PID;
		const goneService = 0x7ffffff3;
		const unreadableBroker = 0x7ffffff4;
		stubIdentities(
			new Map<number, natives.ProcessIdentity>([
				[FAKE_AGENT_PID, { state: "gone" }],
				[unreadableService, { state: "unreadable" }],
				[FAKE_BROKER_PID, { state: "gone" }],
				[goneService, { state: "gone" }],
				[unreadableBroker, { state: "unreadable" }],
			]),
		);
		const file = path.join(tempDir.path(), "crashed.jobs.jsonl");
		const service = (jobId: string, pid: number, broker: number) => ({
			type: "start",
			jobId,
			kind: "service",
			pid,
			pgid: null,
			startTime: null,
			startId: "5",
			command: "svc",
			cwd: null,
			sleepable: false,
			inProcess: false,
			broker: { pid: broker, startId: "7" },
			invocationPid: FAKE_AGENT_PID,
			registeredAt: "2026-01-01T00:00:00.000Z",
		});
		const lines = [
			{
				type: "invocation",
				version: 1,
				invocation: { pid: FAKE_AGENT_PID, startId: "1" },
				sessionId: "crashed",
				complete: true,
			},
			service("service:a:1", unreadableService, FAKE_BROKER_PID),
			service("service:b:1", goneService, unreadableBroker),
		];
		fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		const verdict = verifyOwnedJobRegistry(file);
		expect(verdict.status).toBe("unknown");
		expect(verdict.live).toEqual([]);
		expect(verdict.reasons).toContain(`service service:a:1 (pid ${unreadableService}) cannot be examined`);
		expect(verdict.reasons).toContain(`service service:b:1 (pid ${goneService}) cannot be examined`);
	});

	it("stops vouching for a service whose broker cannot be identified or is already gone", async () => {
		stubIdentities(new Map([[FAKE_BROKER_PID, { state: "gone" }]]));
		registry.registerProcess({
			kind: "service",
			jobId: "service:d:1",
			pid: process.pid,
			command: "svc",
			broker: { pid: FAKE_BROKER_PID },
			daemon: { id: "d", meta: tempDir.path() },
		});
		expect(registry.incompleteReasons).toContain("a service's daemon broker was gone when the service was recorded");

		const projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, {
			runtimeDir: path.join(tempDir.path(), "runtime"),
			idleGraceMs: 100,
		});
		const daemon: DaemonSnapshot = {
			name: "web",
			id: "w",
			state: "running",
			pid: process.pid,
			createdAt: 0,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		vi.spyOn(client, "request").mockImplementation(async operation =>
			operation.op === "start"
				? { op: "start", daemon, readyTimedOut: false }
				: { op: "logs", name: "web", text: "", cursor: 0, timedOut: false, state: "running" },
		);
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		// No live broker named in the scope's lease.
		vi.spyOn(presence, "readLiveDaemonBrokerPid").mockResolvedValue(undefined);
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "session",
		};
		try {
			await startService(session, { name: "web", command: "npm run dev" });
			expect(registry.incompleteReasons).toContain("a service's daemon broker could not be identified");
			expect(registry.openJobs().find(job => job.jobId === "service:w:1")?.broker).toBeUndefined();
		} finally {
			client.close();
		}
	});

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
