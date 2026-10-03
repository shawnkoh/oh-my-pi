import { readFileSync } from "node:fs";

export interface IdleSafeProcess {
	pid: number;
	start: string;
	label: string;
}

const servers = new Set<ServerActivityLedger>();

/** Transport promises can reject before work settles. Only wire replies or process death settle requests. */
export class ServerActivityLedger {
	readonly #requests = new Set<string | number>();
	#handlers = 0;
	#identity?: IdleSafeProcess;
	name: string;

	constructor(
		readonly kind: "mcp" | "lsp",
		name: string,
	) {
		this.name = name;
	}

	get count(): number {
		return this.#requests.size + this.#handlers;
	}

	sent(id: string | number): void {
		servers.add(this);
		this.#requests.add(id);
	}

	replied(id: string | number): void {
		this.#requests.delete(id);
		this.#prune();
	}

	hold(): { release(): void } {
		servers.add(this);
		this.#handlers++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.#handlers--;
				this.#prune();
			},
		};
	}

	/** Capture at spawn, not at census time: never bless a reused PID. */
	bindProcess(pid: number): void {
		this.#identity = readProcessIdentity(pid, `${this.kind}:${this.name}`);
		servers.add(this);
	}

	/** Losing the reader is not process extinction and cannot justify an exclusion. */
	disconnected(): void {
		this.#identity = undefined;
		this.#prune();
	}

	processExited(): void {
		this.#identity = undefined;
		this.#requests.clear();
		// Local handlers can still be applying effects after their peer exits.
		this.#prune();
	}

	idleSafeIdentity(names: readonly string[]): IdleSafeProcess | undefined {
		if (this.count !== 0 || !names.includes(this.name) || !this.#identity) return undefined;
		const current = readProcessIdentity(this.#identity.pid, `${this.kind}:${this.name}`);
		return current?.start === this.#identity.start ? current : undefined;
	}

	#prune(): void {
		if (!this.#identity && this.count === 0) servers.delete(this);
	}
}

function readProcessIdentity(pid: number, label: string): IdleSafeProcess | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		if (!stat.startsWith(`${pid} (`) || end < 0) return undefined;
		const start = stat
			.slice(end + 2)
			.trim()
			.split(/\s+/)[19];
		if (!start || !/^\d+$/.test(start)) return undefined;
		return { pid, start, label };
	} catch {
		return undefined;
	}
}

export function outstandingServerWork(): number {
	let count = 0;
	for (const server of servers) count += server.count;
	return count;
}

/** E2 census input. Configuration asserts an audited lifecycle contract, not mere idleness. */
export function idleSafeServerProcesses(names: readonly string[]): IdleSafeProcess[] {
	const identities: IdleSafeProcess[] = [];
	for (const server of servers) {
		const identity = server.idleSafeIdentity(names);
		if (identity) identities.push(identity);
	}
	return identities;
}
