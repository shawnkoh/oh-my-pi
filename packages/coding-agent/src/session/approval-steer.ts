/**
 * A steer denies a pending tool approval.
 *
 * An approval prompt runs inside its tool call and waits for an answer, so steering
 * (which joins at the next tool-batch boundary) could otherwise sit behind it for as
 * long as nobody answers. A user-authored steer, or an external delivery whose sender
 * chose `steer`, therefore denies the pending call: nothing runs, the agent is told why,
 * and the steer is read at the boundary. Asides, follow-ups, background-job completions
 * and other agent-authored steering never deny.
 */

/** Abort reason of an approval-steer watch: who sent the steer that denied the approval. */
export class ApprovalSteerDenial extends Error {
	constructor(readonly sender: string) {
		super(`${sender} sent a steering message while this approval was pending`);
		this.name = "ApprovalSteerDenial";
	}
}

/** What a tool call denied by a steer reports to the agent. */
export function approvalSteerDenialMessage(toolName: string, denial: ApprovalSteerDenial): string {
	return (
		`Tool call denied: ${toolName}. ${denial.message}, so the call was denied and nothing ran. ` +
		"Read that message; if the call is still needed, make it again."
	);
}
