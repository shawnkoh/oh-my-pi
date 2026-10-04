import { afterEach, beforeEach, expect, test, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../src/cli/args";
import {
	canFence,
	incompleteReason,
	instanceIdentity,
	parseExtinctValue,
	parseInstanceValue,
	sameInstance,
	type InstanceIdentity,
} from "../src/session/instance-identity";
import {
	OwnedJobRegistry,
	RegistryReader,
	currentInvocation,
	parseOwnedJobRegistry,
	verifyOwnedJobRegistry,
	type OwnedJobInvocationRecord,
	type VerifyOwnedJobRegistryOptions,
} from "../src/session/owned-job-registry";
import fixtures from "./fixtures/a13-extinction.json";

const A = { sandboxId: "S", generation: "1", startKey: "boot:10" };
const B = { sandboxId: "S", generation: "2", startKey: "boot:20" };
const C = { sandboxId: "S", generation: "3", startKey: "boot:30" };
let temp: TempDir;
let registry: OwnedJobRegistry | undefined;
const identity = natives.processIdentity;
beforeEach(() => {
	temp = TempDir.createSync("@omp-extinction-");
	currentInvocation();
	spyOn(natives, "processIdentity").mockImplementation(pid =>
		pid === process.pid ? identity(pid) : { state: "gone" },
	);
	spyOn(natives, "scanProcessesByEnv").mockReturnValue({
		...fixtures.observations.ownerScan,
		unreadable: 0,
		redacted: 0,
	});
});
afterEach(() => {
	registry?.close();
	registry = undefined;
	mock.restore();
	temp.removeSync();
});

function header(instance: InstanceIdentity = A): OwnedJobInvocationRecord {
	return {
		type: "invocation",
		version: 1,
		invocation: { pid: 700001, startId: "10", startTime: null },
		sessionId: "test",
		complete: true,
		ownerMarker: { env: "OMP_OWNER", token: "historical" },
		instance,
		at: "2026-10-03T00:00:00Z",
	};
}
function bind(records: unknown[], extinct: InstanceIdentity[] = [A], currentInstance = B): string {
	const session = path.join(temp.path(), "session.jsonl");
	const file = path.join(temp.path(), "session.jobs.jsonl");
	fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
	registry = new OwnedJobRegistry({
		getSessionFile: () => session,
		getSessionId: () => "test",
		currentInstance,
		extinct,
		pollIntervalMs: 0,
	});
	registry.ensureHeader();
	return file;
}

for (const vector of fixtures.schemaCases)
	test(`shared schema: ${vector.name}`, () => {
		const parse = () => parseInstanceValue(JSON.stringify(vector.value));
		if (vector.valid) expect<unknown>(parse()).toEqual(vector.value);
		else expect(parse).toThrow();
	});

for (const vector of fixtures.registryCases)
	test(`shared registry: ${vector.name}`, () => {
		const options: VerifyOwnedJobRegistryOptions = vector.options;
		const text = vector.records.map(record => JSON.stringify(record)).join("\n") + "\n";
		const parsed = parseOwnedJobRegistry(text, options);
		expect(parsed.segments.map(segment => [...segment.open.values()].map(record => record.jobId))).toEqual(
			vector.openBySegment,
		);
		expect(parsed.problems.map(problem => problem.split(":", 1)[0])).toEqual(vector.problemCategories);
		const file = path.join(temp.path(), "vector.jobs.jsonl");
		fs.writeFileSync(file, text);
		expect<string>(verifyOwnedJobRegistry(file, options).status).toBe(vector.status);
	});

for (const vector of fixtures.provenanceRejectCases)
	test(`shared provenance rejection: ${vector.name}`, () => {
		const issuer = vector.issuer as InstanceIdentity;
		expect(instanceIdentity(issuer)).toBeNull();
		expect(incompleteReason({ category: "pty-untracked", text: "uncertainty", issuer }).issuer).toBeNull();
		expect(canFence("pty-untracked", issuer, vector.extinct)).toBe(false);
		expect(canFence("pty-untracked", issuer, [issuer])).toBe(false);
		expect(sameInstance(issuer, A)).toBe(false);
		expect(sameInstance(A, issuer)).toBe(false);
	});

for (const vector of fixtures.launchRejectCases)
	test(`shared launch rejection before help: ${vector.name}`, () => {
		const args = [
			`--a13-instance=${JSON.stringify(vector.instance)}`,
			`--a13-extinct=${JSON.stringify(vector.extinct)}`,
		];
		expect(() => parseArgs(args)).toThrow();
		const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--help", ...args], {
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(2);
		expect(child.stdout.toString()).toBe("");
	});

for (const [category, fenced] of Object.entries(fixtures.categories))
	test(`historical category: ${category}`, () => {
		const prior = { ...header(), complete: false, incompleteReasons: [{ category, text: "uncertainty", issuer: A }] };
		const file = bind([
			prior,
			{
				type: "incomplete",
				invocationPid: prior.invocation.pid,
				reason: { category, text: "another uncertainty", issuer: A },
			},
		]);
		expect(registry!.complete).toBe(fenced);
		const options = { expectedInvocation: currentInvocation(), currentInstance: B, extinct: [A] };
		// The verifier observes the engine after exit; this test controls that observation.
		spyOn(natives, "processIdentity").mockReturnValue({ state: "gone" });
		expect(verifyOwnedJobRegistry(file, options).status).toBe(fenced ? "clear" : "unknown");
	});

test("schema byte bounds, list bounds, pair and reserved flag enforcement", () => {
	for (const value of [
		{ ...A, sandboxId: "é".repeat(65) },
		{ ...A, startKey: "é".repeat(65) },
	])
		expect(() => parseInstanceValue(JSON.stringify(value))).toThrow();
	expect(parseInstanceValue(JSON.stringify({ ...A, sandboxId: "é".repeat(64) })).sandboxId).toBe("é".repeat(64));
	expect(() => parseInstanceValue(" ".repeat(513) + JSON.stringify(A))).toThrow();
	const list = Array.from({ length: 64 }, (_, i) => ({ ...A, generation: String(i) }));
	expect(parseExtinctValue(JSON.stringify(list))).toEqual(list);
	for (const value of [[...list, B], [A, A], [A, { ...A, startKey: "other" }], [null], {}])
		expect(() => parseExtinctValue(JSON.stringify(value))).toThrow();
	expect(() => parseExtinctValue(" ".repeat(40 * 1024) + "[]")).toThrow();
	const instance = `--a13-instance=${JSON.stringify(A)}`;
	const extinct = "--a13-extinct=[]";
	expect(parseArgs([instance, extinct], new Map([["a13-instance", { type: "boolean" }]]))).toMatchObject({
		a13Instance: A,
		a13Extinct: [],
	});
	for (const argv of [
		[instance],
		[extinct],
		[instance, extinct, instance],
		[instance, extinct, extinct],
		["--a13-instance", JSON.stringify(A), extinct],
		[instance, "--a13-extinct", "[]"],
		["--a13-instance={}", extinct],
	])
		expect(() => parseArgs(argv)).toThrow();
});

test("authorization precedes deletion, permitting a later authorized end", () => {
	const reader = new RegistryReader({ extinct: [A] });
	const start = {
		type: "start",
		invocationPid: 700001,
		jobId: "job",
		kind: "async-job",
		pid: 700001,
		startId: "10",
		inProcess: true,
	};
	const end = { type: "end", reason: "extinct", invocationPid: 700001, jobId: "job", targetStartId: "10", issuer: B };
	reader.feed([header(), start, end].map(value => JSON.stringify(value)).join("\n") + "\n");
	expect(reader.segments[0].open.has("job")).toBe(true);
	reader.feed(JSON.stringify({ ...end, issuer: A }) + "\n");
	expect(reader.segments[0].open.has("job")).toBe(false);
	expect(reader.problems.map(problem => problem.split(":", 1)[0])).toEqual(["parse-extinct-target"]);
});

test("startup writes an authorized historical end and can reread it", () => {
	const file = bind([
		header(),
		{
			type: "start",
			invocationPid: 700001,
			jobId: "job",
			kind: "async-job",
			pid: 700001,
			startId: "10",
			inProcess: true,
		},
	]);
	expect(registry!.complete).toBe(true);
	registry!.ensureHeader();
	expect(registry!.complete).toBe(true);
	const parsed = parseOwnedJobRegistry(fs.readFileSync(file, "utf8"), {
		currentInstance: B,
		expectedInvocation: currentInvocation(),
		extinct: [A],
	});
	expect(parsed.problems).toEqual([]);
	expect(parsed.segments[0].open.size).toBe(0);
});

test("unlisted, missing, malformed and contradictory provenance remain unknown", () => {
	for (const issuer of [
		C,
		null,
		{ sandboxId: "S", generation: "1" },
		{ ...A, generation: "01" },
		{ ...A, startKey: "contradictory" },
	]) {
		registry?.close();
		const prior = { ...header(), incompleteReasons: [{ category: "pty-untracked", text: "uncertainty", issuer }] };
		bind([prior]);
		expect(registry!.complete).toBe(false);
	}
});

test("fresh failures remain even if the owner list includes the current instance", () => {
	bind([], [B]);
	registry!.markIncomplete("current scan failed", "scan-unsound");
	registry!.ensureHeader();
	expect(registry!.complete).toBe(false);
});

test("current instance claimed by another invocation is never fenced", () => {
	bind([{ ...header(B), incompleteReasons: [{ category: "pty-untracked", text: "uncertainty", issuer: B }] }], [B]);
	expect(registry!.complete).toBe(false);
});

test("takeover keeps original issuing instance through another carrier", () => {
	const file = bind(
		[
			{
				...header(),
				complete: false,
				incompleteReasons: [{ category: "pty-untracked", text: "uncertainty", issuer: A }],
			},
		],
		[],
	);
	const records = fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	const carried = records.find(record => record.type === "invocation" && record.instance.generation === "2");
	expect(carried.inheritedOwnerMarkers).toContainEqual({ token: "historical", startId: "10", issuer: A });
	expect(carried.incompleteReasons).toContainEqual({
		category: "pty-untracked",
		text: "inherited: uncertainty",
		issuer: A,
	});
	registry!.close();
	// Model B after process exit without relying on host PID reuse.
	carried.invocation = { pid: 700002, startId: "20", startTime: null };
	bind([carried], [A, B], C);
	expect(registry!.complete).toBe(true);
});

test("marker and reason dedupe includes issuer", () => {
	const prior = {
		...header(),
		inheritedOwnerMarkers: [
			{ token: "same", startId: "10", issuer: A },
			{ token: "same", startId: "10", issuer: C },
		],
		incompleteReasons: [
			{ category: "pty-untracked", text: "same", issuer: A },
			{ category: "pty-untracked", text: "same", issuer: C },
		],
	};
	const file = bind([prior], []);
	const latest = parseOwnedJobRegistry(fs.readFileSync(file, "utf8")).segments.at(-1)!.header;
	expect(latest.inheritedOwnerMarkers!.filter(marker => marker.token === "same").map(marker => marker.issuer)).toEqual(
		[A, C],
	);
	expect(latest.incompleteReasons).toEqual([
		{ category: "pty-untracked", text: "inherited: same", issuer: A },
		{ category: "pty-untracked", text: "inherited: same", issuer: C },
	]);
});

test("CLI exits 2 before help or startup on malformed, split, duplicate, or unpaired instance flags", () => {
	const instance = `--a13-instance=${JSON.stringify(A)}`;
	const extinct = "--a13-extinct=[]";
	for (const args of [
		[instance],
		[extinct],
		[instance, extinct, instance],
		[instance, extinct, extinct],
		["--a13-instance", JSON.stringify(A), extinct],
		[instance, "--a13-extinct", "[]"],
		["--a13-instance={bad", extinct],
		[instance, "--a13-extinct={}"],
		["--", "--a13-instance={}"],
	]) {
		const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--help", ...args], {
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(2);
		expect(child.stdout.toString()).toBe("");
	}
});

test("unfenced markers remain in the scan and completeness even after clean scans", () => {
	bind([header()], []);
	registry!.scanAndCount();
	registry!.scanAndCount();
	expect(registry!.complete).toBe(false);
	expect(natives.scanProcessesByEnv).toHaveBeenLastCalledWith(
		"OMP_OWNER",
		expect.arrayContaining(["historical"]),
		"10",
	);
});

test("adopted open records dedupe by original invocation and issuer, not job id", () => {
	spyOn(natives, "processIdentity").mockImplementation(pid =>
		pid === process.pid
			? identity(pid)
			: pid === 700003
				? { state: "running", startId: "30", startTime: 30, pgid: 700003 }
				: { state: "gone" },
	);
	const original = { pid: 700001, startId: "10", startTime: null };
	const starts = [A, C].map(issuer => ({
		type: "start",
		invocationPid: 700002,
		jobId: "same",
		kind: "process",
		pid: 700003,
		startId: "30",
		inProcess: false,
		command: "worker",
		issuer,
		adoptedFrom: original,
	}));
	const file = bind([{ ...header(B), invocation: { pid: 700002, startId: "20", startTime: null } }, ...starts], [], {
		...C,
		generation: "4",
	});
	expect(registry!.openJobs().map(record => record.issuer)).toEqual([A, C]);
	const parsed = parseOwnedJobRegistry(fs.readFileSync(file, "utf8"));
	expect([...parsed.segments[0].open.values()].map(record => record.issuer)).toEqual([A, C]);
});

test("malformed adoption provenance cannot authorize an extinction end", () => {
	for (const adoptedFrom of [null, {}, { pid: "700001", startId: "10" }]) {
		const records = [
			header(),
			{
				type: "start",
				invocationPid: 700001,
				jobId: "job",
				kind: "async-job",
				pid: 700001,
				startId: "10",
				inProcess: true,
				issuer: A,
				adoptedFrom,
			},
			{ type: "end", reason: "extinct", invocationPid: 700001, jobId: "job", targetStartId: "10", issuer: A },
		];
		const parsed = parseOwnedJobRegistry(records.map(record => JSON.stringify(record)).join("\n"), { extinct: [A] });
		expect(
			[...parsed.segments[0].open.values()].map(record => ({ jobId: record.jobId, issuer: record.issuer })),
		).toEqual([{ jobId: "job", issuer: null }]);
		expect(parsed.problems.map(problem => problem.split(":", 1)[0])).toEqual(["parse-extinct-target"]);
	}
});
