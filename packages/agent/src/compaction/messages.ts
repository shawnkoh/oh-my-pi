import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type AgentMessage, LLM_MESSAGE_SOURCE } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import handoffSummaryContextPrompt from "./prompts/handoff-summary-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const HANDOFF_SUMMARY_TEMPLATE = handoffSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Harness compaction method that produced this summary (display metadata). */
	method?: string;
	providerPayload?: ProviderPayload;
	/** Runtime-only ordered archive blocks for snapcompact: old text region,
	 *  imaged middle, then new text region. When present, `summary` is already
	 *  the final lead-in text (no legacy wrapper applied). */
	blocks?: (TextContent | ImageContent)[];
	/** Snapcompact image blocks, kept for display counts / legacy consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	/**
	 * Thinking-binding rewrite marker when it must differ from `timestamp`: a
	 * natively replayed summary predates it before the retained tail so that
	 * tail's bound thinking stays valid. `timestamp` remains the commit time,
	 * which is what invalidates the tail's pre-compaction usage reports.
	 */
	historyRewriteAt?: number;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	const firstTextIndex = message.content.findIndex(content => content.type === "text");
	if (firstTextIndex < 0) return [{ type: "text", text }, ...message.content];

	const content: (TextContent | ImageContent)[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block.type !== "text") content.push(block);
		else if (index === firstTextIndex) content.push({ type: "text", text });
	}
	return content;
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary });
}
/**
 * Wrap a handoff document for injection into the successor context. Unlike the
 * generic compaction wrapper, this names the mechanism and pins authorship —
 * the document was written by a prior instance in its own voice, so without
 * this framing the successor misreads first-person "Next Steps" as fresh user
 * instructions (or tries to write the handoff again).
 */
export function renderHandoffSummaryContext(summary: string): string {
	return prompt.render(HANDOFF_SUMMARY_TEMPLATE, { summary });
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Optional metadata for {@link createCompactionSummaryMessage}. */
export interface CompactionSummaryMessageOptions {
	shortSummary?: string;
	providerPayload?: ProviderPayload;
	images?: ImageContent[];
	blocks?: (TextContent | ImageContent)[];
	warning?: string;
	/** Harness compaction method that produced this summary (e.g. "remote", "soft", "handoff"). */
	method?: string;
	/** Estimated context tokens after the rewrite, for display alongside `tokensBefore`. */
	tokensAfter?: number;
	/** See {@link CompactionSummaryMessage.historyRewriteAt}. */
	historyRewriteAt?: number;
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage {
	const { shortSummary, providerPayload, images, blocks, warning, method, tokensAfter, historyRewriteAt } = options;
	const imageBlocks =
		blocks?.filter((block): block is ImageContent => block.type === "image") ??
		(images && images.length > 0 ? images : undefined);
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		tokensAfter,
		method,
		providerPayload,
		blocks: blocks && blocks.length > 0 ? blocks : undefined,
		images: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
		warning,
		historyRewriteAt,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/** Message field name carrying an owner-provided user-role provider projection. */
const LLM_PROJECTION_KEY = "omp.llm";
/** Message field name carrying the projection's source id, stamped as {@link LLM_MESSAGE_SOURCE}. */
const LLM_PROJECTION_SOURCE_KEY = "omp.llm.source";

function isProjectionPart(part: unknown): part is TextContent | ImageContent {
	if (typeof part !== "object" || part === null || !("type" in part)) return false;
	if (part.type === "text") return "text" in part && typeof part.text === "string";
	if (part.type === "image") {
		return "data" in part && typeof part.data === "string" && "mimeType" in part && typeof part.mimeType === "string";
	}
	return false;
}

/**
 * Owner-declared provider projection of a custom record: `details["omp.llm"]`
 * with `role: "user"` and text/image content. Plain JSON data so it survives
 * session persistence; anything else is rejected so a malformed projection
 * falls back to the ordinary developer conversion instead of reaching the
 * provider half-validated.
 */
function readLlmProjection(
	details: unknown,
): { content: string | (TextContent | ImageContent)[]; source: string | undefined } | undefined {
	if (typeof details !== "object" || details === null || !(LLM_PROJECTION_KEY in details)) return undefined;
	const projection = details[LLM_PROJECTION_KEY];
	if (typeof projection !== "object" || projection === null) return undefined;
	if (!("role" in projection) || projection.role !== "user" || !("content" in projection)) return undefined;
	const content: unknown = projection.content;
	let validated: string | (TextContent | ImageContent)[];
	if (typeof content === "string") {
		validated = content;
	} else if (Array.isArray(content) && content.every(isProjectionPart)) {
		// The array is handed over as-is so hosts can deep-compare the provider
		// view against the projection they authored.
		validated = content;
	} else {
		return undefined;
	}
	const source = LLM_PROJECTION_SOURCE_KEY in details ? details[LLM_PROJECTION_SOURCE_KEY] : undefined;
	return { content: validated, source: typeof source === "string" ? source : undefined };
}

/**
 * Transform a single core-domain agent message to its LLM form; `undefined`
 * drops it from the provider request.
 *
 * Single source of truth for the core roles (user/developer/assistant/
 * toolResult) and the compaction messages owned by this package. Embedders
 * with their own app messages (e.g. the coding agent) handle their custom
 * roles and delegate every core role here — duplicating these cases is how
 * snapcompact frames once silently fell off the provider request.
 */
export function convertMessageToLlm(message: AgentMessage): Message | undefined {
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "custom":
			case "hookMessage": {
				const projection = readLlmProjection(message.details);
				if (projection) {
					// The record's own `content` is its display header; only the
					// owner's projection reaches the provider.
					const projected: Message & { [LLM_MESSAGE_SOURCE]?: string } = {
						role: "user",
						content: projection.content,
						attribution: message.attribution ?? "agent",
						timestamp: message.timestamp,
					};
					projected[LLM_MESSAGE_SOURCE] = projection.source;
					return projected;
				}
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return {
					role: "user",
					content: [
						{
							type: "text" as const,
							text: renderBranchSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					historyRewriteAt: message.timestamp,
					timestamp: message.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content:
						message.blocks !== undefined
							? [{ type: "text" as const, text: message.summary }, ...message.blocks]
							: [
									{
										type: "text" as const,
										text:
											message.method === "handoff"
												? renderHandoffSummaryContext(message.summary)
												: renderCompactionSummaryContext(message.summary),
									},
									...(message.images ?? []),
								],
					attribution: "agent",
					historyRewriteAt: message.historyRewriteAt ?? message.timestamp,
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
		}
	}

	switch (message.role) {
		case "user":
			return { ...message, attribution: message.attribution ?? "user" };
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.map(convertMessageToLlm).filter(message => message !== undefined);
}
