import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
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
