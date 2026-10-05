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
import { ExtensionActivityLedger, ServerActivityLedger, outstandingServerWork } from "../src/session/activity-ledger";
import { OwnedJobRegistry } from "../src/session/owned-job-registry";

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
		work: [
			{ pid: 4, comm: "a ) b", ppid: 0 },
			{ pid: 5, comm: "zombie", ppid: 1 },
		],
		reasons: [],
	});
	// A zombie engine pid is never the engine, and a dead canonical main is never allowlisted.
	expect(namespaceCensus({ ...f.options, enginePid: 5 }).work).toContainEqual({ pid: 5, comm: "zombie", ppid: 1 });
	f.add(2, "sleep", 1, "20", "Z");
	expect(namespaceCensus(f.options).reasons.join()).toContain("canonical-mismatch");
});
test("registered identities are counted once; internal helpers require exact idle evidence", () => {
	const f = fixture();
	f.add(4);
	f.add(5);
	f.add(6);
	f.add(7);
	f.options.registered = [
		{ pid: 4, startId: "40", kind: "process" },
		{ pid: 5, startId: "50", kind: "internal" },
		{ pid: 6, startId: "60", kind: "internal" },
		{ pid: 7, startId: "71", kind: "internal" },
	];
	expect(
		namespaceCensus(f.options)
			.work.map(p => p.pid)
			.sort(),
	).toEqual([5, 6, 7]);
	f.options.idleInfrastructure = () => [{ pid: 7, start: "70", label: "audited" }];
	expect(
		namespaceCensus(f.options)
			.work.map(p => p.pid)
			.sort(),
	).toEqual([5, 6]);
});

test("forged internal registry records cannot exclude a live process", () => {
	const f = fixture();
	f.add(process.pid, "live-test-process", 1, "40");
	const options = {
		getSessionFile: () => path.join(f.root, "session.jsonl"),
		getSessionId: () => "test",
		pollIntervalMs: 0,
	};
	const writer = new OwnedJobRegistry(options);
	writer.registerProcess({ kind: "process", pid: process.pid, startId: "40", command: "live-test-process" });
	const file = writer.path!;
	writer.close();
	const records = fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	for (const record of records) if (record.type === "start") record.kind = "internal";
	fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const reader = new OwnedJobRegistry(options);
	try {
		reader.ensureHeader();
		f.options.registered = reader.openJobs();
		f.options.idleInfrastructure = () => reader.idleHelpers();
		expect(namespaceCensus(f.options).work).toContainEqual({ pid: process.pid, comm: "live-test-process", ppid: 1 });
	} finally {
		reader.close();
	}
});

test.each(["mcp", "lsp"] as const)("a %s server request arriving mid-census consumes another pass", kind => {
	const f = fixture();
	const server = new ServerActivityLedger(kind, "census-test");
	const before = outstandingServerWork();
	let hold: { release(): void } | undefined;
	let passes = 0;
	f.options.ledgerSnapshot = () => JSON.stringify({ count: outstandingServerWork(), reasons: [] });
	f.options.io = {
		list: root => fs.readdirSync(root),
		read: file => {
			if (file.endsWith("self/mountinfo") && ++passes === 2) hold = server.hold();
			return fs.readFileSync(file);
		},
	};
	try {
		expect(namespaceCensus(f.options)).toEqual({ complete: false, work: [], reasons: ["census-ledger-unstable"] });
		expect(passes).toBe(3);
		expect(outstandingServerWork()).toBe(before + 1);
	} finally {
		hold?.release();
	}
});

test("extension holds changing mid-census cannot establish stability", () => {
	const f = fixture();
	const ledger = new ExtensionActivityLedger();
	let hold: { release(): void } | undefined;
	let passes = 0;
	f.options.ledgerSnapshot = () =>
		JSON.stringify({
			count: ExtensionActivityLedger.outstandingWork(),
			reasons: ExtensionActivityLedger.completenessReasons(),
		});
	f.options.io = {
		list: root => fs.readdirSync(root),
		read: file => {
			if (file.endsWith("self/mountinfo")) {
				passes++;
				if (hold) {
					hold.release();
					hold = undefined;
				} else hold = ledger.hold("background");
			}
			return fs.readFileSync(file);
		},
	};
	try {
		expect(namespaceCensus(f.options)).toEqual({ complete: false, work: [], reasons: ["census-ledger-unstable"] });
		expect(passes).toBe(3);
	} finally {
		hold?.release();
		ledger.dispose();
	}
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

test("CLI identity guard precedes launch, help, version, and other early output", () => {
	const f = fixture();
	for (const unreadable of [false, true]) {
		if (unreadable) fs.unlinkSync(path.join(f.root, "1/stat"));
		const flag = `--a13-identity=${JSON.stringify({ ...identity, pid1Start: "11" })}`;
		for (const argv of [
			["--mode", "rpc", flag],
			["--mode", "rpc-ui", flag],
			["--mode", "rpc", flag, "--help"],
			["launch", "--mode", "rpc-ui", flag, "--help"],
			["--version", "--mode", "rpc", flag],
			["--license", flag],
			["--smoke-test", flag],
			["--profile", "guard-test", "--alias", "guard-test", flag],
			["--help", "--", flag],
		]) {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
					import { runCli } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli.ts"))};
					await runCli(${JSON.stringify(argv)}, {
						platform: "linux", procRoot: ${JSON.stringify(f.root)}
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
	}
});

test("CLI rejects malformed, split, and duplicate identity before help", () => {
	const flag = `--a13-identity=${JSON.stringify(identity)}`;
	for (const args of [
		["--a13-identity={}"],
		["--a13-identity={bad"],
		["--a13-identity", JSON.stringify(identity)],
		[flag, flag],
		["--", "--a13-identity={}"],
	]) {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
				import { runCli } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli.ts"))};
				await runCli(${JSON.stringify(["--mode", "rpc", ...args, "--help"])}, {
					platform: "linux", procRoot: "/nonexistent"
				});
				`,
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 30_000 },
		);
		expect(child.exitCode).toBe(2);
		expect(child.stdout.toString()).toBe("");
		expect(child.stderr.toString()).toContain("Error:");
		expect(child.stderr.toString()).toContain("--a13-identity");
	}
});
