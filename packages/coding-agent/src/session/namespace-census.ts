import * as fs from "node:fs";
import * as path from "node:path";

export interface CensusIdentity {
	v: 1;
	boot: string;
	pid1Start: string;
	canonical: { pid: number; start: string };
}
export interface CensusResult {
	complete: boolean;
	work: { pid: number; comm: string; ppid: number }[];
	reasons: string[];
}
export interface CensusRegistration {
	pid: number;
	startId: string | null;
	kind: string;
	supervisesLiveService?: boolean;
}
export interface CensusOptions {
	identity?: CensusIdentity;
	procRoot?: string;
	platform?: string;
	enginePid?: number;
	registered?: readonly CensusRegistration[];
	idleInfrastructure?: () => readonly { pid: number; start: string; label: string }[];
	/** Filesystem seam for deterministic race and read-error tests. */
	io?: { read(file: string): Buffer; list(root: string): string[] };
}
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
const bootId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
export function parseCensusIdentity(json: string): CensusIdentity {
	const value: unknown = JSON.parse(json);
	if (
		!object(value) ||
		Object.keys(value).sort().join() !== "boot,canonical,pid1Start,v" ||
		value.v !== 1 ||
		typeof value.boot !== "string" ||
		!bootId.test(value.boot) ||
		!decimal(value.pid1Start) ||
		!object(value.canonical) ||
		Object.keys(value.canonical).sort().join() !== "pid,start" ||
		!Number.isSafeInteger(value.canonical.pid) ||
		(value.canonical.pid as number) <= 1 ||
		!decimal(value.canonical.start)
	) {
		throw new Error("Invalid a13 launch identity");
	}
	return value as unknown as CensusIdentity;
}
export function parseProcStat(text: string, pid: number) {
	const end = text.lastIndexOf(")");
	const begin = text.indexOf("(");
	const fields = text
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	if (
		begin < 1 ||
		end < begin ||
		text.slice(0, begin).trim() !== String(pid) ||
		fields.length < 20 ||
		!/^[RSDZTtXxKWPI]$/.test(fields[0]!) ||
		!decimal(fields[1]) ||
		!decimal(fields[2]) ||
		!decimal(fields[19]) ||
		!Number.isSafeInteger(Number(fields[1])) ||
		!Number.isSafeInteger(Number(fields[2]))
	)
		throw new Error("malformed stat");
	return {
		pid,
		comm: text.slice(begin + 1, end),
		state: fields[0]!,
		ppid: Number(fields[1]),
		pgrp: Number(fields[2]),
		start: fields[19]!,
	};
}

export type StartupIdentityOptions = Pick<CensusOptions, "procRoot" | "platform">;

/** Check the owner-recorded namespace before startup can emit protocol output. */
export function checkStartupIdentity(
	identity: CensusIdentity | undefined,
	options: StartupIdentityOptions = {},
): "juiz.a13-identity-unreadable" | "juiz.a13-identity-mismatch" | undefined {
	if (!identity || (options.platform ?? process.platform) !== "linux") return;
	const root = options.procRoot ?? "/proc";
	try {
		const boot = fs.readFileSync(path.join(root, "sys/kernel/random/boot_id"), "utf8").trim();
		const pid1Start = parseProcStat(fs.readFileSync(path.join(root, "1/stat"), "utf8"), 1).start;
		if (!bootId.test(boot)) return "juiz.a13-identity-unreadable";
		if (boot !== identity.boot || pid1Start !== identity.pid1Start) return "juiz.a13-identity-mismatch";
	} catch {
		return "juiz.a13-identity-unreadable";
	}
}

/** Synchronous: callers must close admission before invoking this census. Never reads environ. */
export function namespaceCensus(options: CensusOptions): CensusResult {
	const unknown = (reason: string): CensusResult => ({ complete: false, work: [], reasons: [reason] });
	if (!options.identity) return unknown("census-identity-missing");
	if ((options.platform ?? process.platform) !== "linux") return unknown("census-unsupported-platform");
	const identity = options.identity;
	const root = options.procRoot ?? "/proc";
	const io = options.io ?? {
		read: (file: string) => fs.readFileSync(file),
		list: (dir: string) => fs.readdirSync(dir),
	};
	const read = (file: string) => io.read(path.join(root, file));
	try {
		const pass = () => {
			const mounts = read("self/mountinfo").toString().trim().split("\n");
			const mount = mounts.find(line => line.split(" ")[4] === "/proc");
			if (!mount || !mount.includes(" - proc ")) throw new Error("proc-mount-unverified");
			if (
				mount
					.split(/[ ,]/)
					.some(
						option =>
							(option === "hidepid" || option.startsWith("hidepid=")) &&
							option !== "hidepid=0" &&
							option !== "hidepid=off",
					)
			)
				throw new Error("hidepid");
			if (read("sys/kernel/random/boot_id").toString().trim() !== identity.boot) throw new Error("boot-mismatch");
			const list = () => {
				const pids = io
					.list(root)
					.filter(name => /^\d+$/.test(name))
					.map(Number);
				if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1) || new Set(pids).size !== pids.length)
					throw new Error("duplicate-or-invalid-pid");
				return pids;
			};
			const pids = list();
			const vanished: number[] = [];
			const members: string[] = [];
			const work: CensusResult["work"] = [];
			const idle = options.idleInfrastructure?.() ?? [];
			let boundary = false;
			let canonical = false;
			for (const pid of pids) {
				try {
					const proc = parseProcStat(read(`${pid}/stat`).toString(), pid);
					const cmdline = read(`${pid}/cmdline`);
					const status = read(`${pid}/status`).toString();
					if (!/^Uid:\s+\d+\s+\d+\s+\d+\s+\d+\s*$/m.test(status)) throw new Error("malformed Uid");
					if (cmdline.length && cmdline[cmdline.length - 1] !== 0) throw new Error("malformed cmdline");
					if (proc.state === "Z" || proc.state === "X" || proc.state === "x") continue;
					let classification = "work";
					if (pid === 1) {
						if (proc.start !== identity.pid1Start || proc.comm !== "openshell-sandb")
							throw new Error("boundary-mismatch");
						boundary = true;
						classification = "boundary";
					} else if (pid === identity.canonical.pid) {
						if (proc.start !== identity.canonical.start || !cmdline.equals(Buffer.from("sleep\0infinity\0")))
							throw new Error("canonical-mismatch");
						canonical = true;
						classification = "canonical";
					} else if (pid === (options.enginePid ?? process.pid)) classification = "engine";
					else if (proc.ppid !== 0) {
						const records =
							options.registered?.filter(record => record.pid === pid && record.startId === proc.start) ?? [];
						if (records.some(record => record.kind !== "internal")) classification = "registered";
						else if (records.some(record => record.kind === "internal" && record.supervisesLiveService === false))
							classification = "internal";
						else if (
							records.length === 0 &&
							idle.some(server => server.pid === pid && server.start === proc.start)
						)
							classification = "idle-infrastructure";
					}
					members.push(`${pid}:${proc.start}:${classification}`);
					if (classification === "work") work.push({ pid, comm: proc.comm, ppid: proc.ppid });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") vanished.push(pid);
					else throw new Error(`pid-${pid}: ${String(error)}`);
				}
			}
			const end = new Set(list());
			if (vanished.some(pid => end.has(pid))) throw new Error("vanish-unconfirmed");
			if (!boundary || !canonical) throw new Error("required-identity-missing");
			return { signature: members.sort().join("\n"), work, settled: [...end].every(pid => pids.includes(pid)) };
		};
		let previous = pass();
		for (let round = 0; round < 3; round++) {
			const current = pass();
			if (previous.settled && current.settled && previous.signature === current.signature)
				return { complete: true, work: current.work, reasons: [] };
			previous = current;
		}
		return unknown("census-unstable");
	} catch (error) {
		return unknown(`census-${String(error)}`);
	}
}
