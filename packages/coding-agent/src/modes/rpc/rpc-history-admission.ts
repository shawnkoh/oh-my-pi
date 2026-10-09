import type { SessionManager } from "../../session/session-manager";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";
import { projectSessionHistory, validateSessionHistoryRequest, SessionHistoryError, type SessionHistoryRequest } from "./rpc-session-history";
import type { RpcCommand, RpcResponse } from "./rpc-types";
import type { RpcOutputWriter } from "./rpc-output";

type Query = Extract<RpcCommand, { type: "get_session_history" }>;
const HISTORY_ERRORS: Record<string, true> = {
	"session-history-changed": true, "session-source-unavailable": true, "session-read-busy": true,
	"session-read-expired": true, "session-page-too-large": true, "invalid-arguments": true,
};

/** Owns the single query credit until computation and its stdout response have both settled. */
export class RpcHistoryAdmission {
	#active: { readId: string; controller: AbortController; discard?: () => void } | undefined;

	constructor(
		private readonly manager: SessionManager,
		private readonly writer: Pick<RpcOutputWriter, "defer">,
		private readonly respond: (response: RpcResponse) => void,
		private readonly project: typeof projectSessionHistory = projectSessionHistory,
	) {}

	start(command: Query): void {
		const id = typeof command.id === "string" && command.id.length <= 256 &&
			Buffer.byteLength(command.id) <= 256 ? command.id : undefined;
		const failure = (code: string): RpcResponse => ({
			id, type: "response", command: "get_session_history", success: false, error: code, code,
		});
		const fail = (code: string) => this.respond(failure(code));
		if (command.id !== undefined && id === undefined) return fail("invalid-arguments");
		if (this.#active) return fail("session-read-busy");
		const request: SessionHistoryRequest = {
			readId: command.readId, expectedSessionId: command.expectedSessionId,
			expectedSessionPath: command.expectedSessionPath, before: command.before,
			limit: command.limit, expiresAt: command.expiresAt,
		};
		try {
			validateSessionHistoryRequest(request);
		} catch {
			return fail("invalid-arguments");
		}
		const remaining = request.expiresAt - Date.now();
		if (remaining <= 0) return fail("session-read-expired");
		if (remaining > 5_000) return fail("invalid-arguments");
		const deadline = performance.now() + remaining;
		const view = this.manager.captureHistoryReadView();
		const active = { readId: request.readId, controller: new AbortController(), discard: undefined as (() => void) | undefined };
		this.#active = active;
		const defer = (line: string, checkRevision: boolean) => {
			active.discard = this.writer.defer(line, deadline, () => {
				if (this.#active === active) this.#active = undefined;
			}, () => {
				if (active.controller.signal.aborted || performance.now() >= deadline) return undefined;
				if (checkRevision && !view?.isCurrent())
					return `${JSON.stringify(failure("session-history-changed"))}\n`;
				return line;
			});
		};
		void (async () => {
			try {
				const page = await this.project(this.manager, request, active.controller.signal);
				if (active.controller.signal.aborted || performance.now() >= deadline) return;
				const line = await encodeHistoryResponse(
					{ id, type: "response", command: "get_session_history", success: true, data: page },
					() => {
						if (active.controller.signal.aborted || performance.now() >= deadline)
							throw new SessionHistoryError("session-read-expired");
						if (!view?.isCurrent()) throw new SessionHistoryError("session-history-changed");
					},
				);
				defer(line, true);
			} catch (cause) {
				if (!active.controller.signal.aborted) {
					const code = cause && typeof cause === "object" && "code" in cause &&
						typeof cause.code === "string" && Object.hasOwn(HISTORY_ERRORS, cause.code)
						? cause.code : "session-source-unavailable";
					if (performance.now() < deadline) defer(`${JSON.stringify(failure(code))}\n`, false);
				}
			} finally {
				// A deferred response still owns credit until discarded or its sink callback.
				if (this.#active === active && !active.discard) this.#active = undefined;
			}
		})();
	}

	cancel(readId: unknown): void {
		if (typeof readId !== "string" || this.#active?.readId !== readId) return;
		this.cancelActive();
	}

	cancelActive(): void {
		const active = this.#active;
		if (!active) return;
		active.controller.abort();
		active.discard?.();
		// A frame already handed to stdout cannot be retracted: its callback retains
		// the slot. An in-flight projector likewise keeps credit until it exits.
	}
}

/** Encode only the bounded projector's constructed response, yielding even within a tool-name array. */
async function encodeHistoryResponse(
	response: Extract<RpcResponse, { command: "get_session_history"; success: true }>,
	check: () => void,
): Promise<string> {
	// The projector accounts escaped page bytes before retention; the correlation id
	// was bounded at admission. Refuse before allocating a complete envelope.
	if (512 * 1024 + 6 * 256 + 256 > MAX_RPC_FRAME_BYTES)
		throw new SessionHistoryError("session-page-too-large");
	const chunks: string[] = [];
	let bytes = 1, sinceYield = 0, items = 0;
	const append = async (chunk: string) => {
		const size = Buffer.byteLength(chunk);
		bytes += size;
		if (bytes > MAX_RPC_FRAME_BYTES) throw new SessionHistoryError("session-page-too-large");
		chunks.push(chunk);
		sinceYield += size;
		if (++items >= 256 || sinceYield >= 64 * 1024) {
			check();
			await new Promise<void>(resolve => setImmediate(resolve));
			items = sinceYield = 0;
		}
		check();
	};
	const encode = async (value: unknown): Promise<void> => {
		if (Array.isArray(value)) {
			await append("[");
			for (let i = 0; i < value.length; i++) {
				if (i) await append(",");
				await encode(value[i]);
			}
			await append("]");
		} else if (value !== null && typeof value === "object") {
			await append("{");
			let first = true;
			for (const [key, child] of Object.entries(value)) {
				if (child === undefined) continue;
				if (!first) await append(",");
				first = false;
				await append(`${JSON.stringify(key)}:`);
				await encode(child);
			}
			await append("}");
		} else {
			// Individual strings are at most the 16 KiB text prefix; never raw entries.
			const encoded = JSON.stringify(value);
			if (encoded === undefined) throw new SessionHistoryError("session-source-unavailable");
			await append(encoded);
		}
	};
	check();
	await encode(response);
	check();
	return `${chunks.join("")}\n`;
}
