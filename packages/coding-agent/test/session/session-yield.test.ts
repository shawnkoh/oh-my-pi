import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionOwnerPath, tryAcquireSessionLease } from "../../src/session/session-storage";
import { requestSessionYield, SESSION_YIELD_CAPABILITY } from "../../src/session/session-yield";

const originalOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
const roots: string[] = [];
const children: Bun.Subprocess<"pipe", "pipe", "inherit">[] = [];
const extraPids: number[] = [];

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-yield-test-"));
	roots.push(root);
	process.env.PI_TEST_SESSION_OWNERS_DIR = path.join(root, "owners");
	return { root, sessionId: crypto.randomUUID() };
}

async function spawnHolder(root: string, sessionId: string, mode = "idle") {
	const child = Bun.spawn(
		[process.execPath, path.resolve(import.meta.dir, "../fixtures/session-yield-holder.ts"), sessionId, mode, root],
		{ env: process.env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
	);
	children.push(child);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	async function nextRecord(): Promise<{ ready?: boolean; active: boolean; yielded: number }> {
		while (!pending.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`Holder exited before response (${await child.exited})`);
			pending += decoder.decode(chunk.value, { stream: true });
		}
		const newline = pending.indexOf("\n");
		const record = JSON.parse(pending.slice(0, newline));
		pending = pending.slice(newline + 1);
		return record;
	}
	const ready = await nextRecord();
	expect(ready.ready).toBe(true);
	return {
		child,
		ready,
		async command(command: string) {
			child.stdin.write(`${command}\n`);
			await child.stdin.flush();
			return nextRecord();
		},
	};
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	for (const pid of extraPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	if (originalOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
	else process.env.PI_TEST_SESSION_OWNERS_DIR = originalOwnersDir;
});

describe("bounded cross-process session yield", () => {
	test("idle holder advertises bounded metadata and exits with the actual lease released", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId);
		const metadataPath = `${getSessionOwnerPath(sessionId)}.lock`;
		const before = fs.statSync(metadataPath);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		expect(metadata.capabilities).toContain(SESSION_YIELD_CAPABILITY);
		expect(before.size).toBeLessThan(4096);
		expect(tryAcquireSessionLease(sessionId)).toBeNull();
		expect(await requestSessionYield(sessionId, 3000)).toBe(0);
		expect(await holder.child.exited).toBe(0);
		const probe = tryAcquireSessionLease(sessionId);
		expect(probe).not.toBeNull();
		probe?.release();
		expect(fs.statSync(metadataPath).ino).toBe(before.ino);
	});

	test("unknown or dead holder returns 3 even with stale metadata", async () => {
		const { root, sessionId } = setup();
		expect(await requestSessionYield(sessionId, 500)).toBe(3);
		const holder = await spawnHolder(root, sessionId);
		holder.child.kill();
		await holder.child.exited;
		expect(await requestSessionYield(sessionId, 500)).toBe(3);
	});

	test("a legacy live holder without a hook returns 5 and is never interrupted", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "unsupported");
		expect(await requestSessionYield(sessionId, 500)).toBe(5);
		expect(holder.child.exitCode).toBeNull();
		expect(tryAcquireSessionLease(sessionId)).toBeNull();
	});

	test("legacy successor does not inherit a dead capable holder's metadata", async () => {
		const { root, sessionId } = setup();
		const capable = await spawnHolder(root, sessionId);
		const owner = getSessionOwnerPath(sessionId);
		const inode = fs.statSync(`${owner}.lock`).ino;
		capable.child.kill();
		await capable.child.exited;
		const legacy = await spawnHolder(root, sessionId, "unsupported");
		expect(fs.statSync(`${owner}.lock`).ino).toBe(inode);
		expect(JSON.parse(fs.readFileSync(`${owner}.lock`, "utf8")).pid).toBe(capable.child.pid);
		expect(tryAcquireSessionLease(sessionId)).toBeNull();
		expect(await requestSessionYield(sessionId, 500)).toBe(5);
		expect(fs.existsSync(`${owner}.yield-request.json`)).toBe(false);
		expect(legacy.child.exitCode).toBeNull();
	});

	test("busy holder times out with 4 and never yields later when it becomes idle", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "busy");
		expect(await requestSessionYield(sessionId, 150)).toBe(4);
		expect(fs.existsSync(`${getSessionOwnerPath(sessionId)}.yield-request.json`)).toBe(false);
		expect((await holder.command("idle")).yielded).toBe(0);
		expect(await requestSessionYield(sessionId, 3000)).toBe(0);
	});

	test("expired and stale-holder requests cannot trigger a later yield", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId);
		const owner = getSessionOwnerPath(sessionId);
		const metadata = JSON.parse(fs.readFileSync(`${owner}.lock`, "utf8"));
		for (const request of [
			{ holderId: metadata.holderId, requestId: crypto.randomUUID(), deadline: Date.now() - 1 },
			{ holderId: crypto.randomUUID(), requestId: crypto.randomUUID(), deadline: Date.now() + 10_000 },
		]) {
			fs.writeFileSync(`${owner}.yield-request.json`, JSON.stringify(request));
			expect((await holder.command("inspect")).yielded).toBe(0);
		}
		expect(await requestSessionYield(sessionId, 3000)).toBe(0);
	});

	for (const mode of ["ack-only", "release-only", "reject"]) {
		test(`${mode} never reports success merely from acceptance or lease release`, async () => {
			const { root, sessionId } = setup();
			const holder = await spawnHolder(root, sessionId, mode);
			if (mode === "reject") expect(await requestSessionYield(sessionId, 250)).toBe(4);
			else
				await expect(requestSessionYield(sessionId, 250)).rejects.toThrow(
					"yield accepted but exit/release unconfirmed",
				);
			expect(holder.child.exitCode).toBeNull();
			expect((await holder.command("inspect")).yielded).toBe(1);
		});
	}

	test("holder exit alone is not success if a successor still holds the OS lease", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "successor");
		try {
			await expect(requestSessionYield(sessionId, 1000)).rejects.toThrow(
				"yield accepted but exit/release unconfirmed",
			);
			expect(await holder.child.exited).toBe(0);
			expect(tryAcquireSessionLease(sessionId)).toBeNull();
		} finally {
			const pidPath = path.join(root, "successor-pid");
			if (fs.existsSync(pidPath)) extraPids.push(Number(fs.readFileSync(pidPath, "utf8")));
		}
	});

	test("yield accepted before deadline reports unconfirmed exit, never busy4, when release is slow", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "slow-release");
		await expect(requestSessionYield(sessionId, 250)).rejects.toThrow("yield accepted but exit/release unconfirmed");
		expect(holder.child.exitCode).toBeNull();
		expect(tryAcquireSessionLease(sessionId)).toBeNull();
		expect((await holder.command("inspect")).yielded).toBe(1);
		expect(await holder.child.exited).toBe(0);
		const released = tryAcquireSessionLease(sessionId);
		expect(released).not.toBeNull();
		released?.release();
	});

	test("pending hook activates on a real lazy claim and disposal preserves lock inode", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "lazy");
		expect(holder.ready.active).toBe(false);
		expect(await requestSessionYield(sessionId, 500)).toBe(3);
		expect((await holder.command("claim")).active).toBe(true);
		const metadataPath = `${getSessionOwnerPath(sessionId)}.lock`;
		const inode = fs.statSync(metadataPath).ino;
		expect((await holder.command("dispose")).active).toBe(false);
		expect(fs.statSync(metadataPath).ino).toBe(inode);
		expect(JSON.parse(fs.readFileSync(metadataPath, "utf8")).capabilities).toEqual([]);
		expect(await requestSessionYield(sessionId, 500)).toBe(5);
	});

	test("registration and disposal preserve unrelated owner metadata and capabilities", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "lazy");
		const metadataPath = `${getSessionOwnerPath(sessionId)}.lock`;
		fs.writeFileSync(metadataPath, JSON.stringify({ custom: { value: 42 }, capabilities: ["other/1"] }));
		const inode = fs.statSync(metadataPath).ino;
		expect((await holder.command("claim")).active).toBe(true);
		const registered = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		expect(registered.custom).toEqual({ value: 42 });
		expect(registered.capabilities).toEqual(["other/1", SESSION_YIELD_CAPABILITY]);
		registered.capabilities.push("later/1");
		registered.another = "retained";
		// In-place update models another metadata participant without replacing the lease inode.
		const fd = fs.openSync(metadataPath, "r+");
		const text = JSON.stringify(registered);
		fs.writeSync(fd, text, 0, "utf8");
		fs.ftruncateSync(fd, Buffer.byteLength(text));
		fs.closeSync(fd);
		await holder.command("dispose");
		const disposed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		expect(disposed.custom).toEqual({ value: 42 });
		expect(disposed.another).toBe("retained");
		expect(disposed.capabilities).toEqual(["other/1", "later/1"]);
		expect(fs.statSync(metadataPath).ino).toBe(inode);
	});

	test("idle predicate exceptions fail closed without killing the holder", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "idle-error");
		expect(await requestSessionYield(sessionId, 150)).toBe(4);
		expect(holder.child.exitCode).toBeNull();
		expect((await holder.command("recover")).yielded).toBe(0);
		expect(await requestSessionYield(sessionId, 3000)).toBe(0);
	});

	test("shutdown rejection retires acceptance, does not retry it, and permits a fresh request", async () => {
		const { root, sessionId } = setup();
		const holder = await spawnHolder(root, sessionId, "reject");
		expect(await requestSessionYield(sessionId, 200)).toBe(4);
		const state = await holder.command("inspect");
		expect(state.yielded).toBe(1);
		expect(state.active).toBe(true);
		expect(fs.existsSync(`${getSessionOwnerPath(sessionId)}.yield-ack.json`)).toBe(false);
		await holder.command("recover");
		expect(await requestSessionYield(sessionId, 3000)).toBe(0);
	});

	if (process.platform !== "win32") {
		test("filesystem read errors fail closed without killing the holder", async () => {
			const { root, sessionId } = setup();
			const holder = await spawnHolder(root, sessionId);
			const owner = getSessionOwnerPath(sessionId);
			const requestPath = `${owner}.yield-request.json`;
			fs.symlinkSync(`${owner}.lock`, requestPath);
			expect((await holder.command("inspect")).yielded).toBe(0);
			expect(holder.child.exitCode).toBeNull();
			fs.unlinkSync(requestPath);
			expect(await requestSessionYield(sessionId, 3000)).toBe(0);
		});
	}

	test("untrusted session ids stay inside the private owner directory", () => {
		const { root } = setup();
		const owner = getSessionOwnerPath("../../outside/name");
		expect(path.dirname(owner)).toBe(path.join(root, "owners"));
		expect(path.basename(owner)).toMatch(/^h-[0-9a-f]{16}$/);
	});
});
