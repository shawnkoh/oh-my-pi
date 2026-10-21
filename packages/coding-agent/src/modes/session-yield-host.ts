import type { AgentSession } from "../session/agent-session";
import { hasOutstandingWork } from "../session/quiescence";

export const SESSION_YIELD_NOTICE = "This Thread continues in another Session";

type YieldSession = Pick<
	AgentSession,
	"isAdmissionClosed" | "isDisposed" | "getWorkCounts" | "attest" | "quiesceForExit"
>;

/** Include every registered host work source, not just the provider's streaming flag. */
export function isSessionYieldIdle(session: YieldSession): boolean {
	return !session.isDisposed && !session.isAdmissionClosed() && !hasOutstandingWork(session.getWorkCounts());
}

/** Fence all session admissions synchronously, before a host flushes output or starts teardown. */
export function fenceSessionYield(session: YieldSession): void {
	const operationId = `session-yield-${crypto.randomUUID()}`;
	const attestation = session.attest(operationId, operationId);
	const result = session.quiesceForExit({
		operationId,
		attempt: 0,
		completeness: "attested",
		epoch: attestation.epoch,
		instanceId: attestation.instanceId,
		sessionId: attestation.session.id,
		deadline: Date.now() + 1_000,
	});
	if (result.status === "refused") throw new Error(`Session yield refused: ${result.reason}`);
}

/** stderr survives TUI teardown, including a final render that would erase the composer. */
export function displaySessionYield(draft: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stderr.write(`\n${draft ? `Unsent input:\n${draft}\n\n` : ""}${SESSION_YIELD_NOTICE}\n`, error => {
		if (error) reject(error);
		else resolve();
	});
	return promise;
}
