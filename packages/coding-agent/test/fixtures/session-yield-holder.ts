import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { FileSessionStorage } from "../../src/session/session-storage";
import { type SessionYieldHolder, startSessionYieldHolder } from "../../src/session/session-yield";

const [sessionId, mode, root] = process.argv.slice(2);
const storage = new FileSessionStorage();
let release: (() => void) | null = null;
let idle = mode !== "busy";
let yielded = 0;
let refuseYield = mode === "reject";
let idleThrows = mode === "idle-error";
let dispose: SessionYieldHolder | undefined;
if (mode !== "lazy") {
	release = storage.claimSession(sessionId, path.join(root, "missing-session.jsonl"));
	if (!release) throw new Error("Disposable holder could not acquire session lease");
}
if (mode !== "unsupported") {
	dispose = startSessionYieldHolder({
		sessionId,
		isIdle: () => {
			if (idleThrows) throw new Error("Host idle predicate failed");
			return idle;
		},
		yield: async () => {
			yielded++;
			if (refuseYield) throw new Error("Host refused shutdown");
			if (mode === "ack-only") return;
			if (mode === "slow-release") await Bun.sleep(1000);
			release?.();
			if (mode === "release-only") return;
			if (mode === "successor") {
				const successor = Bun.spawn([process.execPath, import.meta.path, sessionId, "unsupported", root], {
					env: process.env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "inherit",
				});
				const reader = successor.stdout.getReader();
				await reader.read();
				fs.writeFileSync(path.join(root, "successor-pid"), String(successor.pid));
			}
			process.exit(0);
		},
	});
}
createInterface({ input: process.stdin }).on("line", command => {
	if (command === "idle") idle = true;
	if (command === "recover") {
		refuseYield = false;
		idleThrows = false;
	}
	if (command === "claim") release = storage.claimSession(sessionId, path.join(root, "missing-session.jsonl"));
	if (command === "dispose") dispose?.();
	// An explicit timer barrier lets the test observe several holder polling turns.
	setTimeout(() => console.log(JSON.stringify({ yielded, active: dispose?.active ?? false })), 100);
});
setInterval(() => {}, 1000);
console.log(JSON.stringify({ ready: true, active: dispose?.active ?? false }));
