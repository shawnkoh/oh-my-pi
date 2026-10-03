import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkStartupIdentity,
	namespaceCensus,
	parseCensusIdentity,
	parseProcStat,
	type CensusOptions,
} from "../src/session/namespace-census";
import { parseArgs } from "../src/cli/args";

const identity = {
	v: 1 as const,
	boot: "12345678-1234-1234-1234-123456789abc",
	pid1Start: "10",
	canonical: { pid: 2, start: "20" },
};
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "census-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "self"));
	fs.mkdirSync(path.join(root, "sys/kernel/random"), { recursive: true });
	fs.writeFileSync(path.join(root, "self/mountinfo"), "1 0 0:1 / /proc rw - proc proc rw\n");
	fs.writeFileSync(path.join(root, "sys/kernel/random/boot_id"), identity.boot);
	const add = (pid: number, comm = "worker", ppid = 1, start = String(pid * 10), state = "S") => {
		fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
		fs.writeFileSync(
			path.join(root, `${pid}/stat`),
			`${pid} (${comm}) ${state} ${ppid} 1 ${Array(16).fill("0").join(" ")} ${start}`,
		);
		fs.writeFileSync(path.join(root, `${pid}/cmdline`), pid === 2 ? "sleep\0infinity\0" : "worker\0");
		fs.writeFileSync(path.join(root, `${pid}/status`), "Uid:\t1000\t1000\t1000\t1000\n");
	};
	add(1, "openshell-sandb", 0);
	add(2);
	add(3);
	const options: CensusOptions = { identity, procRoot: root, platform: "linux", enginePid: 3 };
	return { root, add, options };
}
test("exact launch schema and single-element flag", () => {
	expect(parseArgs([`--a13-identity=${JSON.stringify(identity)}`]).a13Identity).toEqual(identity);
	for (const value of [
		{ ...identity, extra: true },
		{ ...identity, v: 2 },
		{ ...identity, pid1Start: 10 },
		{ ...identity, canonical: { pid: 0, start: "2" } },
		{ ...identity, boot: "bad" },
	]) {
		expect(() => parseCensusIdentity(JSON.stringify(value))).toThrow();
	}
	expect(() => parseArgs(["--a13-identity={bad"])).toThrow();
});
test("last closing parenthesis, zombies, and ppid zero work", () => {
	const f = fixture();
	f.add(4, "a ) b", 0);
	f.add(5, "zombie", 1, "50", "Z");
	expect(parseProcStat(fs.readFileSync(path.join(f.root, "4/stat"), "utf8"), 4)).toMatchObject({
		comm: "a ) b",
		start: "40",
		ppid: 0,
	});
	expect(namespaceCensus(f.options)).toEqual({
		complete: true,
		work: [{ pid: 4, comm: "a ) b", ppid: 0 }],
		reasons: [],
	});
});
test("registered identities are counted once; internal helpers require exact idle evidence", () => {
	const f = fixture();
	f.add(4);
	f.add(5);
	f.add(6);
	f.add(7);
	f.options.registered = [
		{ pid: 4, startId: "40", kind: "process" },
		{ pid: 5, startId: "50", kind: "internal", supervisesLiveService: false },
		{ pid: 6, startId: "60", kind: "internal", supervisesLiveService: true },
		{ pid: 7, startId: "71", kind: "internal", supervisesLiveService: false },
	];
	expect(
		namespaceCensus(f.options)
			.work.map(p => p.pid)
			.sort(),
	).toEqual([6, 7]);
	f.options.idleInfrastructure = () => [{ pid: 7, start: "70", label: "audited" }];
	expect(namespaceCensus(f.options).work.map(p => p.pid)).toEqual([6]);
});
test("hidden mounts, malformed metadata, missing identity and canonical mismatch fail closed", () => {
	const f = fixture();
	expect(namespaceCensus({}).reasons).toEqual(["census-identity-missing"]);
	expect(namespaceCensus({ identity, platform: "darwin" }).reasons).toEqual(["census-unsupported-platform"]);
	fs.writeFileSync(path.join(f.root, "self/mountinfo"), "1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n");
	expect(namespaceCensus(f.options).reasons.join()).toContain("hidepid");
	for (const disabled of ["hidepid=0", "hidepid=off"]) {
		fs.writeFileSync(path.join(f.root, "self/mountinfo"), `1 0 0:1 / /proc rw - proc proc rw,${disabled}\n`);
		expect(namespaceCensus(f.options).reasons.join()).not.toContain("hidepid");
	}
	fs.writeFileSync(path.join(f.root, "self/mountinfo"), "1 0 0:1 / /proc rw - proc proc rw\n");
	fs.writeFileSync(path.join(f.root, "2/cmdline"), "sleep\0different\0");
	expect(namespaceCensus(f.options).reasons.join()).toContain("canonical-mismatch");
	f.add(2);
	fs.writeFileSync(path.join(f.root, "2/stat"), "bad");
	expect(namespaceCensus(f.options).reasons.join()).toContain("malformed stat");
});
test("read errors, duplicate pids, and unconfirmed ENOENT are unknown", () => {
	for (const code of ["EACCES", "ENOENT"]) {
		const f = fixture();
		f.add(4);
		f.options.io = {
			list: root => fs.readdirSync(root),
			read: file => {
				if (file.endsWith("4/stat")) throw Object.assign(new Error(code), { code });
				return fs.readFileSync(file);
			},
		};
		expect(namespaceCensus(f.options).complete).toBe(false);
	}
	const f = fixture();
	f.options.io = { read: file => fs.readFileSync(file), list: root => [...fs.readdirSync(root), "2"] };
	expect(namespaceCensus(f.options).reasons.join()).toContain("duplicate");
});
test("ENOENT is gone only after relisting; changing starts never stabilize", () => {
	const f = fixture();
	f.add(4);
	f.options.io = {
		list: root => fs.readdirSync(root),
		read: file => {
			if (file.endsWith("4/stat")) {
				fs.rmSync(path.join(f.root, "4"), { recursive: true });
				throw Object.assign(new Error("gone"), { code: "ENOENT" });
			}
			return fs.readFileSync(file);
		},
	};
	expect(namespaceCensus(f.options)).toEqual({ complete: true, work: [], reasons: [] });
	f.add(4);
	let generation = 40;
	f.options.io.read = file => {
		if (file.endsWith("4/stat")) f.add(4, "worker", 1, String(++generation));
		return fs.readFileSync(file);
	};
	expect(namespaceCensus(f.options).reasons).toEqual(["census-unstable"]);
});

test("startup identity matches trimmed boot and PID 1 start after the last parenthesis", () => {
	const f = fixture();
	f.add(1, "boundary ) with ) parentheses", 0, identity.pid1Start);
	fs.writeFileSync(path.join(f.root, "sys/kernel/random/boot_id"), `${identity.boot}\n`);
	expect(checkStartupIdentity(identity, f.options)).toBeUndefined();
});

test("startup identity rejects boot and PID 1 mismatches", () => {
	const f = fixture();
	expect(checkStartupIdentity({ ...identity, boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, f.options)).toBe(
		"juiz.a13-identity-mismatch",
	);
	expect(checkStartupIdentity({ ...identity, pid1Start: "11" }, f.options)).toBe("juiz.a13-identity-mismatch");
});

test("startup identity fails closed on unreadable or malformed proc identity", () => {
	const f = fixture();
	const bootFile = path.join(f.root, "sys/kernel/random/boot_id");
	fs.unlinkSync(bootFile);
	expect(checkStartupIdentity(identity, f.options)).toBe("juiz.a13-identity-unreadable");
	fs.writeFileSync(bootFile, "not-a-uuid");
	expect(checkStartupIdentity(identity, f.options)).toBe("juiz.a13-identity-unreadable");
	fs.writeFileSync(bootFile, identity.boot);
	fs.writeFileSync(path.join(f.root, "1/stat"), "1 (bad) S 0 1");
	expect(checkStartupIdentity(identity, f.options)).toBe("juiz.a13-identity-unreadable");
	// Unreadable takes precedence even if the other component mismatches.
	expect(checkStartupIdentity({ ...identity, boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, f.options)).toBe(
		"juiz.a13-identity-unreadable",
	);
	fs.unlinkSync(path.join(f.root, "1/stat"));
	expect(checkStartupIdentity(identity, f.options)).toBe("juiz.a13-identity-unreadable");
});

test("startup identity skips absent flags and non-Linux without reading proc", () => {
	expect(checkStartupIdentity(undefined, { platform: "linux", procRoot: "/nonexistent" })).toBeUndefined();
	expect(checkStartupIdentity(identity, { platform: "darwin", procRoot: "/nonexistent" })).toBeUndefined();
});

test("RPC startup exits before any protocol output when launch identity cannot be verified", () => {
	const f = fixture();
	for (const unreadable of [false, true]) {
		if (unreadable) fs.unlinkSync(path.join(f.root, "1/stat"));
		const argv = ["--mode", "rpc", `--a13-identity=${JSON.stringify({ ...identity, pid1Start: "11" })}`];
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
				import { runRootCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/main.ts"))};
				import { parseArgs } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli/args.ts"))};
				const args = ${JSON.stringify(argv)};
				await runRootCommand(parseArgs(args), args, {
					startupIdentity: { platform: "linux", procRoot: ${JSON.stringify(f.root)} }
				});
			`,
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 30_000 },
		);
		expect(child.exitCode).toBe(3);
		expect(child.stdout.toString()).toBe("");
		expect(child.stderr.toString()).toBe(
			`${unreadable ? "juiz.a13-identity-unreadable" : "juiz.a13-identity-mismatch"}\n`,
		);
	}
});
