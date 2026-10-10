import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("SessionManager committed history read view", () => {
	it("indexes the full journal through a fixed boundary rather than the selected branch", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendCustomEntry("root");
		const abandoned = manager.appendCustomEntry("abandoned");
		manager.branch(root);
		const newest = manager.appendCustomEntry("newest");
		manager.branch(root);
		const view = manager.captureHistoryReadView()!;
		expect(view.entryCount).toBe(3);
		expect([0, 1, 2].map(index => view.getEntry(index)?.id)).toEqual([root, abandoned, newest]);
		expect(manager.getLeafId()).toBe(root);
		for (const index of [-1, 0.5, 3, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(view.getEntry(index)).toBeUndefined();
		}
		expect(view.isCurrent()).toBe(true);
		manager.appendCustomEntry("later");
		expect(view.isCurrent()).toBe(false);
		expect(view.getEntry(0)).toBeUndefined();
		expect(manager.captureHistoryReadView()?.entryCount).toBe(4);
	});

	it("invalidates on leaf, header, and in-place journal changes", async () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendCustomEntry("first");
		manager.appendCustomEntry("second");
		const leafView = manager.captureHistoryReadView()!;
		manager.branch(first);
		expect(leafView.isCurrent()).toBe(false);

		const headerView = manager.captureHistoryReadView()!;
		await manager.setAdditionalDirectories(["/extra-root"]);
		expect(headerView.isCurrent()).toBe(false);
		const titleView = manager.captureHistoryReadView()!;
		await manager.setSessionName("Updated", "user");
		expect(titleView.getEntry(0)).toBeUndefined();

		const mutated = manager.appendCustomEntry("before");
		const rewriteView = manager.captureHistoryReadView()!;
		const entry = manager.getEntry(mutated);
		if (!entry || entry.type !== "custom") throw new Error("missing custom entry");
		entry.customType = "after";
		await manager.rewriteEntries();
		expect(rewriteView.getEntry(0)).toBeUndefined();
		expect(manager.captureHistoryReadView()?.getEntry(3)).toMatchObject({ customType: "after" });
		const replacementView = manager.captureHistoryReadView()!;
		const snapshot = manager.captureState();
		manager.restoreState(snapshot);
		expect(replacementView.isCurrent()).toBe(false);
	});

	it("captures recorded header cwd, not a temporary runtime fallback cwd", () => {
		const manager = SessionManager.inMemory("/recorded");
		const recorded = manager.captureHistoryReadView()!;
		manager.setCwdWithoutRelocation("/runtime");
		expect(recorded.isCurrent()).toBe(false);
		expect(manager.captureHistoryReadView()?.cwd).toBe("/recorded");
	});

	it("never exposes an unresolved batch and invalidates both commit and rollback views", async () => {
		const manager = SessionManager.create("/cwd", "/sessions", new MemorySessionStorage());
		const initial = manager.appendCustomEntry("initial");
		const beforeCommit = manager.captureHistoryReadView()!;
		await manager.appendEntriesAtomically(() => {
			manager.appendCustomEntry("committed");
			expect(manager.captureHistoryReadView()).toBeUndefined();
			expect(beforeCommit.isCurrent()).toBe(false);
		});
		expect(beforeCommit.getEntry(0)).toBeUndefined();
		const afterCommit = manager.captureHistoryReadView()!;
		expect(afterCommit.entryCount).toBe(2);
		await expect(
			manager.appendEntriesAtomically(() => {
				manager.appendCustomEntry("rolled-back");
				expect(manager.captureHistoryReadView()).toBeUndefined();
				throw new Error("abort batch");
			}),
		).rejects.toThrow("abort batch");
		expect(afterCommit.isCurrent()).toBe(false);
		const afterRollback = manager.captureHistoryReadView()!;
		expect(afterRollback.entryCount).toBe(2);
		expect(afterRollback.getEntry(0)?.id).toBe(initial);
		await manager.close();
	});

	it("rejects stale identities after session replacement and terminal release", async () => {
		const manager = SessionManager.create("/cwd", "/sessions", new MemorySessionStorage());
		manager.appendCustomEntry("old");
		const old = manager.captureHistoryReadView()!;
		await manager.newSession();
		expect(old.isCurrent()).toBe(false);
		expect(old.getEntry(0)).toBeUndefined();
		const fresh = manager.captureHistoryReadView()!;
		expect(fresh.sessionId).not.toBe(old.sessionId);
		expect(fresh.entryCount).toBe(0);
		manager.releaseRetainedEntries();
		expect(fresh.isCurrent()).toBe(false);
		expect(manager.captureHistoryReadView()).toBeUndefined();
	});
});
