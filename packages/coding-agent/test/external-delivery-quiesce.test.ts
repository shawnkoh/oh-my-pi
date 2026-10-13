import { describe, expect, it } from "bun:test";
import { ASIDE_MESSAGE_COMMIT } from "@oh-my-pi/pi-agent-core";
import { ExternalDeliveries } from "@oh-my-pi/pi-coding-agent/session/external-delivery";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";

describe("external deliveries as quiesce work", () => {
	it("counts an accepted delivery until its evaluation settles, wherever its record is", () => {
		const deliveries = new ExternalDeliveries({
			isSessionTransitioning: () => false,
			isDisposed: () => false,
			requeue: () => {},
			removeQueued: () => {},
			isClassifierRefusal: () => false,
		});
		const owner = deliveries.create(
			normalizeCustomMessagePayload({
				customType: "external-card",
				content: "[card]",
				display: true,
				details: { "omp.llm": { role: "user", content: "hello" }, "omp.llm.source": "src" },
			}),
			{ mode: "aside" },
		);
		expect(deliveries.pendingCount()).toBe(1);
		// The loop committed the record into context: no host queue holds it any more, but
		// its settlement receipt is still owed.
		owner.record[ASIDE_MESSAGE_COMMIT]?.();
		expect(owner.state).toBe("accepted");
		expect(deliveries.pendingCount()).toBe(1);
		deliveries.onAgentEvent({ type: "agent_start" });
		deliveries.settleEvaluation();
		expect(owner.state).toBe("settled");
		expect(deliveries.pendingCount()).toBe(0);
	});
});
