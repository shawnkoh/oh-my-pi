# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, host-tool updates/results, and host-URI results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, and host-tool/host-URI requests and cancellations

This is a custom JSONL protocol, not JSON-RPC 2.0.

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/agent-session-events.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- `--no-ui` (with `--mode rpc` or `--mode rpc-ui`) runs extensions headless: `ctx.hasUI` is `false`, dialogs resolve to their defaults, and extension presentation updates are dropped. With `rpc-ui`, tool UI such as `ask` remains enabled. With `rpc`, no UI requests are emitted except for a host-issued `login`. See [Extension UI Sub-Protocol](#extension-ui-sub-protocol) for the exact boundaries.
- CLI RPC modes disable automatic session title generation (`PI_NO_TITLE=1`) to avoid an extra model call. `rpc-ui` also sets `PI_NO_PTY=1`.
- RPC/ACP pin neutral defaults for settings declaring the corresponding `protocolDefault`, including task isolation/execution, memory, advisor, and advisor tier settings. RPC additionally pins async-job and bash/eval auto-background defaults. Explicit project/global config, `--config`, and isolated settings remain authoritative; on-disk config changes are watched in long-lived CLI RPC processes. Todo settings are not host-defaulted.
- The process claims stdin before extension discovery, then parses it one non-empty JSONL line at a time. Malformed JSON emits a recoverable `command: "parse"` failure and does not terminate the loop.
- At startup it writes a `ready` frame before processing commands. The frame advertises supported protocol versions and transport limits.
- When stdin closes, pending extension UI, host-tool, and host-URI requests are rejected; accepted commands are drained, the session is disposed, pending stdout is delivered, and normal shutdown exits with code `0`. A session-persistence failure still latched at disposal exits with code `1` after delivering its `notice` frame.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Protocol v1 stdout frames are a single JSON object followed by `\n`. The server caps each physical stdout frame at 1 MiB, including the newline. Inbound frames are always one unchunked JSONL object; clients SHOULD keep them within the advertised physical-frame limit. Input is not reassembled from `rpc_chunk` frames.

The initial ready frame uses protocol v1 and advertises the opt-in lossless transport (shown for `--mode rpc-ui`):

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864,
  "capabilities": ["literal-input/1", "tool-approval-binding/1", "reply-attribution/1", "external-delivery/1", "quiesce-exit/1", "owned-jobs/1", "rich-ask/2"]
}
```

`capabilities` lists versioned engine features (`name/major`); older engines omit it.
`rich-ask/2` is advertised only by `--mode rpc-ui`. The same list is returned by
`get_state.capabilities`, so a host attached after startup can negotiate without
a destructive command. Rich ask requires explicit opt-in.

Clients that support protocol v2 SHOULD immediately send:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects use an uninterrupted sequence of `rpc_chunk` frames rather than content truncation. Each chunk carries a base64 segment of the UTF-8 JSON object:

```json
{
  "type": "rpc_chunk",
  "chunkId": "rpc-1",
  "index": 0,
  "count": 7,
  "byteLength": 1600042,
  "data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

Clients MUST validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the advertised reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The TypeScript `RpcFrameDecoder`, exported from `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame`, implements this validation. The bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it.

For an oversized `agent_end` in either version, the encoder first removes the leading messages already delivered unchanged in `message_end` frames and adds `messageCount` with the original count. Hosts must retain streamed messages rather than treating `agent_end.messages` as a complete transcript.

Legacy clients may ignore the added ready fields and remain on v1. In v1, an oversized response becomes `success: false` with `error: "RPC response exceeded the transport limit"`; oversized events may have strings, arrays, or object fields elided. If a v2 logical frame exceeds 64 MiB after terminal-frame compaction, responses receive the same overflow error, other events produce `rpc_frame_error`, and `agent_end` falls back to an empty `messages` array plus `messageCount`. Large history APIs should use pagination rather than depending on arbitrarily large logical frames.

Output goes directly to stdout while the reader keeps up. Under backpressure, the server spills pending bytes to a private temporary file and drains it in 64 KiB blocks, preserving frame order. This limits queued output memory at the cost of disk I/O and temporary disk usage, which can grow until the reader catches up. The file is removed when the backlog drains or the process shuts down. Output or spool failures are logged, dispose the session, and exit with code `1`.

Clients MUST continue reading stdout after closing stdin. Normal EOF and extension-requested shutdown wait for pending output delivery; a client that keeps its stdout pipe open without reading can delay exit indefinitely.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
7. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)
8. Available-commands updates (`{ type: "available_commands_update", commands }`), emitted at startup and whenever command metadata changes
9. Prompt completion (`{ type: "prompt_result", id?, agentInvoked, status, error?, sessionSettled }`), unless the response already completed the prompt locally; see [`prompt` payload](#prompt-payload)
10. Session quiescence (`{ type: "session_settled" }`); see [Yield vs settled](#yield-vs-settled)
11. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
12. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)
13. Transport overflow notifications (`rpc_frame_error`), when an event cannot fit within the transport limits

Protocol v2 may wrap oversized logical frames from these categories in `rpc_chunk` frames.

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses echo the request `id` when one was provided.
- Malformed JSON and synchronous dispatch failures emit `command: "parse"` without an `id`. Exceptions while handling a recognized command emit a failure with that command's `type` and `id`.
- Ordinary `prompt` handling acknowledges after the message is admitted (queued, given an idle turn slot, or routed to an extension command), not before native `input` handlers or image preparation finish, and without waiting for the agent run. `abort_and_prompt` first awaits the abort, then acknowledges. A failure before admission is the command's error response. A failure after admission can still emit a later error response with the same `id`.
- An accepted `prompt` or `abort_and_prompt` completes exactly once: either its success response carries `data.agentInvoked: false` (finished locally), or a later `prompt_result` frame with the same `id` reports how its work ended. `prompt_result` is always written after the response for that `id`.

## Command Schema (canonical)

`RpcCommand` is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp", literal?: boolean }`
- `{ id?, type: "steer", message: string, images?: ImageContent[], literal?: boolean }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[], literal?: boolean }`
- `{ id?, type: "remove_queued_message", message: string, queue: "steering" | "followUp" }`
- `{ id?, type: "promote_queued_message", message: string }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[], literal?: boolean }`
- `{ id?, type: "new_session", parentSession?: string }`
- `{ id?, type: "open_session", sessionDir: string }`

With `literal: true` (capability `literal-input/1`) input hooks run first with source `"rpc"`; a handled hook consumes the input, and transformed text/images are honoured. The resulting text is admitted as plain user text, never interpreted as slash, skill, builtin, extension or custom command, prompt template, or model mention. Hosts that let remote users converse but not administer the session through message text should always send it. The upstream ordered input gate acknowledges prompts only after admission. The model's tools and per-turn features still behave normally. A non-boolean `literal` is refused with an error response.

### Protocol

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "goal", op: "get" | "create" | "resume" | "pause" | "drop", objective?: string, token_budget?: number }`
- `{ id?, type: "set_ask_dialog", enabled: boolean, rich?: boolean }` — opt in to upstream ask and optionally `rich-ask/2`; response `{enabled, rich:true}` only when requested and supported
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "get_entries", since?: string }`
- `{ id?, type: "get_tree" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "set_event_filter", events: string[] | null, messageUpdates?: "full" | "delta" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`
- `{ id?, type: "cancel_subagent", subagentId: string }`
- `{ id?, type: "steer_subagent", subagentId: string, message: string }`

### Quiescence

- `{ id?, type: "attest", operationId: string, nonce: string }`
- `{ id?, type: "quiesce_and_exit", operationId: string, attempt: number, epoch: number, instanceId: string, sessionId: string, deadline: number }`

Both run on receipt, ahead of any queued command; see [Quiesce and exit](#quiesce-and-exit).

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

`get_available_models` waits for background model discovery before returning. `set_model` also waits when the requested model is not already in the available catalog; it returns the selected `Model` or a `Model not found: <provider>/<modelId>` failure.

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`
- `{ id?, type: "get_available_thinking_levels" }`

`ThinkingLevel` is `"inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Discovery returns `"off"` followed by the live model's supported efforts, omitting `"inherit"` and the session-only `"auto"` selector.

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Cache warming

- `{ id?, type: "set_cache_warming", mode: "off" | "streaming" | "idle" }`

Sets `providers.cacheWarming` for the current session without writing `config.yml`.
`off` clears scheduled refreshes and aborts any refresh in flight; `streaming`
warms during active agent runs; `idle` also warms between runs. Enabling warming
does not replay an old, cancelled run: the next real provider request arms it.
Invalid modes return the usual `success: false` response. Success reports the
effective mode after applying the override:

```json
{"id":"warming-off","type":"response","command":"set_cache_warming","success":true,"data":{"mode":"off"}}
```

The TypeScript client exposes `setCacheWarming(mode): Promise<CacheWarmingMode>`.

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` is dispatched concurrently: the RPC server continues reading commands
while the shell command runs, so `abort_bash` (or any other command) sent
during a long-running `bash` is handled without waiting for it to finish on
its own. The `bash` response is emitted when the command completes; hosts
correlate it via `id`. Ordering across concurrent commands is not guaranteed
— clients MUST match responses on `id`, not on emission order.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

`handoff` fails while a response is streaming. On success, its payload is `{ savedPath? }` or `null` when no handoff was produced. Session transitions (`new_session`, `switch_session`, `branch`, `open_session`) report cancellation when an extension prevents the transition.

### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor` when more messages remain. Cursors are bound to the session ID, durable leaf, and message count. The server rejects stale cursors if the session changes between requests, and refuses to start a paging walk while the session is streaming or compacting. Failed page requests carry a machine-readable `code` on the error response — `session_busy` (session is streaming or compacting) or `stale_cursor` (the snapshot behind the cursor changed, e.g. a background bash appended a message between pages) — so clients can react without matching error-message text. Pages default to 100 messages; `limit` must be an integer from 1 through 256. The page builder normally caps serialized message content at 768 KiB, but always includes at least one message, so a single large message can exceed that budget. A v1 caller can page ordinary histories, but an individual message whose response exceeds the 1 MiB physical-frame ceiling produces an overflow error; retrieving it losslessly requires negotiated v2 framing.

The bundled TypeScript `RpcClient.getMessages()` and Python `RpcClient.get_messages()` drain this paged endpoint automatically after negotiating v2. They retain the legacy monolithic command when connected to a v1 server, and on either `session_busy` or `stale_cursor` they discard partial pages and fall back to the legacy best-effort snapshot. Direct `getMessagesPage()` and `get_messages_page()` calls remain strict so incremental hosts never mix snapshots silently.

### External delivery commands

- `{ id?, type: "deliver", record: CustomMessagePayload, options: { mode: "aside" | "steer", quiet?: true, wakeAfterInterrupt?: true, wakeInPlanMode?: true } }`
- `{ id?, type: "cancel_delivery", deliveryId: string }`

Both require `external-delivery/1` in `ready.capabilities`. See
[External delivery](#external-delivery) for the record shape, receipts and
events.

`deliver` and `cancel_delivery` are dispatched independently of the ordered
native-input gate used by `prompt`, `steer`, `follow_up`, and `abort_and_prompt`,
so a `deliver` read after a `prompt` that is still running its input hooks or
preparing attachments can be acknowledged first. Its record still never overtakes
that prompt: from the moment a `prompt` or `abort_and_prompt` enters the gate until
it is admitted (or queued, handled locally, or dropped), the session holds its turn
dispatch, and a delivery arriving meanwhile is held instead of waking the idle
session (waking it would get the prompt refused as busy). The held record reaches the
model after the prompt: folded into the prompt's turn at a step boundary, or woken
once that turn yields (`mechanism: "wake"`). When the prompt is handled locally or
dropped, the record wakes the session on its own. `steer` and `follow_up` do not
hold turn dispatch. Wait for `delivery_accepted` and `delivery_settled` to learn what
actually happened. Cancellation succeeds only before acceptance.

An extension input hook may deliver a record itself (`pi.deliverMessage`) and wait for
it. Such a delivery, made directly in the hook's own async code path (not from within
event emissions or observers it triggers), is never held behind these holds while the hook runs,
whether or not a turn is running: they belong to the hook's own input and to input
queued behind it, which cannot proceed until the hook returns. For the same reason,
while the hook runs it counts as part of that host input: a host `abort` still in effect
or plan mode does not hold it either, as if it had set `wakeAfterInterrupt` and
`wakeInPlanMode` (the interrupt itself stays in effect until host input clears it). If a
turn is running, the record joins it at a step boundary, or wakes the session once that
turn ends. Otherwise it wakes the idle session at once, and the input then meets that
running turn: a `prompt` without `streamingBehavior`, or an `abort_and_prompt`, is
refused as busy (a same-id error response with the busy message and a `prompt_result`
with `status: "error"`); a `prompt` with `streamingBehavior`, a `steer` or a `follow_up`
is queued into the turn. A prompt's own setup window (an earlier admitted prompt still
setting up its turn) does hold it; when that window closes without starting a turn while
the hook still runs, the record wakes then, still exempt from the host's holds, the
interrupt and plan mode. The exemption covers only the hook's own deliveries, and only
while the hook runs. Every session/agent event emission to subscribers and extension
observer dispatch runs outside that scope, even when triggered by an API the hook calls
(abort, compaction, goal updates, queue changes or session transitions), including
command-metadata, session-change and run-state subscribers. Promises,
timers and callbacks created by those observers remain outside it. Input-hook dispatch
itself retains the scope. Turns the hook starts and their settlement callbacks also run
outside it. When the hook returns, a record of its own still parked waits like any other delivery.

Every later RPC input waits until the hook returns; neither `abort` nor a session change
ends a hook. So a hook that waits for its own delivery must observe every way it can end
while the hook runs:

- Wait for `Promise.race([handle.accepted, handle.discarded])`, never `accepted` (or
  `settled`) alone. A record not yet accepted is discarded by a committed session change
  (`new_session`, a session switch) or by shutdown, and `accepted` and `settled` then
  never resolve.
- Do not `cancel()` a delivery the hook waits for: a cancelled record resolves neither
  `accepted` nor `discarded`.
- While the session's agent subscription is disconnected for compaction or a session
  transition, even a hook's own delivery stays queued, not accepted. Reconnection and
  the stranded drain resume it (or the transition discards it). A failed, uncommitted
  new-session or switch operation reconnects the retained session, including when
  persistence flushing fails; its parked deliveries resume after the transition ends.
  Start/await a compaction the hook calls before awaiting its delivery's acceptance;
  an observer must not await acceptance that depends on its own operation completing.
- Make the delivery in the hook's async context. A delivery handed to code that runs in
  a context the hook did not create (a worker or loop started before the hook, a native
  callback) is not exempt: it parks behind the hook's own input and is accepted only after
  the hook returns.

Within these rules the race settles while the hook still runs.

Separate deliveries have no ordering guarantee relative to each other: a record held by
one gate (for example a pooled turn's parked wake) can reach the model after a record
delivered later. Order deliveries that depend on each other by waiting for
`delivery_accepted` before sending the next.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

Login forwards ordinary OAuth input prompts only after the provider emits an
authorization URL. Prompts marked `secret: true` are always rejected with a
failed `login` response directing the user to the terminal UI; no ordinary
`input` request is emitted. RPC does not negotiate secret-input support.

### Word prediction

- `{ id?, type: "predict_word", text: string, cursor: number }` → `data: { suffix: string | null }`
- `{ id?, type: "predict_word_feedback", text: string, cursor: number, suggestion: string, accepted: boolean }`

Composer ghost text for hosts that render their own input box. `text` is the
whole draft and `cursor` a UTF-16 offset into it. The server applies the same
gates as the terminal editor (the cursor must sit at the end of its line and
end a prose word; code, paths, and slash commands get nothing) and answers from the engine selected by
`spelling.autocomplete`; `off` always answers `suffix: null`.

`predict_word` is dispatched concurrently like `bash`, so a slow prediction
never delays other commands; match responses on `id`. Per session the server
keeps one engine request in flight: a request arriving while one runs waits,
and a newer one replaces it, answering the replaced request `suffix: null`.
Hosts may send on every keystroke; only the newest draft reaches the engine.

The first request may take seconds (worst case about two minutes) while the
shared prediction daemon starts and loads its engine. When the daemon cannot
start or answer, `predict_word` fails (`success: false`), and keeps failing
fast for about 30 seconds while the daemon is backed off. Treat failures as
"no ghost text" rather than surfacing them per keystroke.

Send `predict_word_feedback` with the `text` and `cursor` at which a
suggestion was shown: `accepted: true` when the user took it, `false` when
they typed past it. Feedback tunes the engine's learned state.

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string, code?: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged once the message is admitted — an idle turn has started for it, it has been pushed onto the steer/follow-up/aside queue while the agent is busy, or it has been routed to a registered extension command (before that command's handler runs) — not after a model turn finishes. Admission runs any image normalization first (and, for a text-only model with vision description enabled, the vision-description call), so those complete before the acknowledgement. The vision-description call is capped at 20 seconds, which keeps the acknowledgement inside the bundled clients' 30-second request timeout; past the cap the image is still saved and the model is told its description is unavailable. The same applies to a `/skill:` invocation sent through `prompt`. A prompt that settles without ever being admitted (dropped by an `abort`, or failing first) is acknowledged once it settles. Gating the acknowledgement does not change completion: the prompt still completes exactly once, through `data.agentInvoked: false` or its `prompt_result` (below).

`prompt` starts after previously received ordinary commands, such as `new_session` or `set_model`, have completed. Its admission then runs in the background: the RPC server keeps handling later commands — `abort`, `steer`, `follow_up`, `get_state`, and so on — without waiting for slow image normalization or vision description. An `abort` that lands while a prompt's images are still being prepared cancels the vision-description call and drops the prompt, whether it would have started an idle turn or been queued with `streamingBehavior`.

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is the completion signal for builtin slash commands that finish synchronously without starting an agent turn; no `prompt_result` follows. Every other accepted `prompt` (and every `abort_and_prompt`) is completed by one `prompt_result` frame carrying the command `id`, once its local outcome or agent yield is known. Background work need not have settled:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": true, "status": "completed", "sessionSettled": true }
```

- `agentInvoked: false`: the prompt finished locally (an extension or custom command that started no turn) or failed before reaching the agent.
- `agentInvoked: true`: the prompt was dispatched or queued for agent work; normal completion reports when the agent **yielded** — see [Yield vs settled](#yield-vs-settled). An abort that wins before dispatch can still report `true` with `status: "aborted"`. A prompt dispatched as a fresh turn reports the first run that started after it was accepted, so a late `agent_end` from an earlier run never completes it. A prompt queued into a live run (`streamingBehavior`) reports at the first yield after its message left the queue. An `agent_end` with `yielded: false` (the agent is retrying, compacting, or answering a stop-time reminder) never completes a prompt.
- `status`: `"completed"`, `"aborted"` (interrupted by `abort`, `abort_and_prompt`, or a session transition, or dropped by an abort before dispatch), or `"error"`.
- `error` (only with `status: "error"`): `{ message, provider?, model?, httpStatus?, retryable }`. `message` is the provider's error text with OMP-local diagnostics (such as saved request-dump paths) removed. `retryable` marks a transient failure; OMP's own automatic retries have already been exhausted. A prompt that fails before reaching the agent also gets the legacy error response with the same `id` before its `prompt_result`.
- `run`, `promptEntryId` and `replyEntryIds` (capability `reply-attribution/1`). `run` is the engine-local ordinal of the run whose yield answered the prompt. A run spans retries and continuations up to that yield, and prompts reported with the same `run` were answered together, such as a follow-up folded into a live turn. `promptEntryId` is the session entry of the prompt's own user message. `replyEntryIds` are the assistant entries that followed it, up to the next user message; the last is the reply. A `literal` prompt is found by its exact text, unless another prompt answered by the same yield has the same text. Any other prompt is attributed only when it is the sole prompt answered and its run delivered a single user message. Every persisted user message counts: a host `steer`, an extension `sendUserMessage` or a subagent steer ends the preceding reply early and makes parsed prompts unattributable; skill prompts are never attributed. An external delivery or goal-mode context that arrives during the run also ends the preceding reply, without affecting which prompt is identified. A command that schedules agent work (for example an extension command calling `sendUserMessage`) is attributed to the run that work starts, not to a delivery wake that ran while its handler was working; if it schedules work from idle more than once, the last such run is reported. Work it queues into a live run joins that run and is reported at that run's yield, even if an earlier run already yielded while its handler worked. An incoming subagent message also ends the preceding reply. Entries are read at the yield. `replyEntryIds` is empty, and `promptEntryId` absent, rather than guessed when the prompt cannot be identified or the session or branch changed during the run. A move to a sibling session file (a new session id whose `parentSession` is the old one, made when another process wrote the session file) keeps the transcript and is not a session change. All three are absent for local-only commands.
- `sessionSettled`: whether the session is already done when the result is written — see [Yield vs settled](#yield-vs-settled). `false` means background work can still wake the agent; a `session_settled` frame follows once it has.

A failed provider turn is not a failed command: the prompt response is still `success: true`, and the turn ends with a normal terminal `agent_end` whose last assistant message has `stopReason: "error"`. Use `prompt_result.status` rather than parsing that message.

Local-only slash commands may emit `command_output` frames before completing. They do not emit `agent_end`.

### Yield vs settled

For agent-invoking work, a prompt's `prompt_result` reports the **agent yield**: it finished its turn (`agent_end` with `yielded: true`), or the prompt was aborted before dispatch or by a session transition. Local-only results and pre-dispatch errors do not require an `agent_end`. The **session is done** only when nothing can wake it again — no run is live or admitted, no steer/follow-up is queued, and no background job (auto-backgrounded `bash`, async `task`, `eval`) or pending delivery will inject its result and start a follow-up turn.

- `session_settled` is written once per stretch of agent activity, when the session becomes done. If background work was pending at the yield, OMP waits it out; any follow-up runs it triggers stream normally (`agent_start` … `agent_end`) before `session_settled`. It always follows the `prompt_result` frames of the final yield, and is not emitted for prompts that never reached the agent.
- `prompt_result.sessionSettled` answers the same question at the yield, so a host can tear down immediately when it is `true`.
- `get_state` reports `isSettled` (same predicate) and `hasPendingAsyncWork`, for hosts that attach mid-stream.

Wait on `prompt_result` to present a turn's answer; wait on `session_settled` (or `isSettled`) before treating the conversation as finished, e.g. before pausing or recycling a sandbox.

### `open_session` payload

`open_session` binds the process to a host-keyed conversation directory — the runtime equivalent of `--session-dir <dir> --continue`, so a pre-spawned process can adopt a thread after startup. It continues the newest non-empty session in `sessionDir`, or starts a fresh session there when none exists. Reopening the session that is already active (including a still-empty fresh session in the same directory) is a no-op that does not interrupt a running turn; otherwise the current run is aborted as with `switch_session`, and open prompts complete with `status: "aborted"`.

```json
{ "cancelled": false, "resumed": true, "sessionId": "01a0...", "sessionFile": "/srv/threads/t1/2026-...jsonl" }
```

`resumed` is `false` when a fresh session was started. The command fails when the process runs without persistence (`--no-session`).

A successful `open_session` also marks still-open RPC prompt tickets aborted, even for an already-open directory; in that no-op case the underlying turn continues streaming. `cancelled: true` leaves the active session and prompt tickets unchanged.

### `remove_queued_message` payload

Remove the first matching user-authored message from the selected pending queue:

```json
{"id":"req_2","type":"remove_queued_message","message":"Use the existing parser","queue":"steering"}
{"id":"req_2","type":"response","command":"remove_queued_message","success":true,"data":{"removed":true}}
```

`message` first matches the original submitted text retained before slash/custom-command rewriting, prompt-template expansion, or `^model` mention substitution; if that finds nothing, it matches the exact queue-chip text. Removal never reruns a command or template to find a match. Queued RPC skill commands retain their original `/skill:<name>` invocation as the chip text. Removal also drops that message's attachments and contiguous preceding hidden user companions (keyword notices, image descriptions, and video source paths), preserving other messages and the other queue.

Companions and their prompt are enqueued and dequeued as a complete group, including in `one-at-a-time` mode. Once that group leaves the pending queue for delivery, a removal request cannot report success after only part of its context has been emitted.

Agent-authored entries never match, including internal handoffs with `role: "user"` and `attribution: "agent"`. With duplicate text, each request removes only the first matching occurrence; repeating a successful request can remove another occurrence.

The check and removal are synchronous: `data.removed: false` means no matching user message is pending in that queue at dispatch time. Already-dequeued messages and inputs still being preprocessed cannot be cancelled by this command. Live-steered input may remain visible in queue snapshots until the transcript records it, even though it has already left the removable pending queue. It does not resend input, abort a turn, or change interruption behavior. Non-string `message` values and missing or invalid `queue` values produce an error response.

A removal request may hide the chip or restore its draft only after `removed: true`; normal delivery still removes chips through queue snapshots. Older runtimes reject this command; clients must not fall back to aborting or resending queued messages. The TypeScript client exposes `removeQueuedMessage(message, queue): Promise<{ removed: boolean }>`.

The official Python client exposes `remove_queued_message(message, queue) -> RemoveQueuedMessageResult`; inspect its `.removed` boolean rather than the result object's truthiness.

### `promote_queued_message` payload

Move the first matching user-authored follow-up to the end of the steering queue:

```json
{"id":"req_3","type":"promote_queued_message","message":"Use the existing parser"}
{"id":"req_3","type":"response","command":"promote_queued_message","success":true,"data":{"promoted":true}}
```

The command moves the existing queued message, including its attachments and contiguous preceding hidden user companions, without reprocessing or duplicating it. `message` matches exactly as for `remove_queued_message`, so agent-authored entries never match. With duplicate text, each request moves only the first matching follow-up; repeating a successful request can move another occurrence.

`data.promoted: false` means no matching user follow-up is pending at dispatch time (for example, it was already delivered). Non-string `message` values produce an error response. Existing steering, follow-up, and interrupt modes still apply; promotion does not abort the model stream or guarantee cancellation of running tools. While the agent is idle, a promoted message starts a turn right away, including after a user `abort` — promoting is an explicit request to steer now. The move is reported as one `queue_update` in which the message has already left `followUp` and joined `steering`.

Since `prompt` acknowledges only once the message is admitted (see above), a `promote_queued_message` sent immediately after a queued `prompt`'s acknowledgement reliably observes it. Older runtimes reject this command; clients must not fall back to `steer`, which would enqueue a duplicate. The TypeScript client exposes `promoteQueuedMessage(message): Promise<{ promoted: boolean }>`, and its `prompt(message, images?, options?)` accepts `"steer"` or `"followUp"`, or `{ streamingBehavior, literal }`, to queue a prompt sent while the agent is busy. Literal prompts follow the same admission rule.

The official Python client exposes `promote_queued_message(message) -> PromoteQueuedMessageResult`; inspect its `.promoted` boolean rather than the result object's truthiness.

### `get_state` payload

`tokensPerSecond` is a number when output throughput is available and `null`
otherwise. `fastModeEnabled` reports the session's selected model-family tier
(`priority` or `ultrafast`), while `fastModeActive` reports the actual computed
active state. For Fireworks, `providers.fireworksTier: priority` is independent
of the `/fast` family setting, so `fastModeActive` may remain `true` for a model
that `/fast` cannot toggle. Fireworks `-fast` serving variants do not use priority.

For direct Anthropic, a provider rejection of `speed: "fast"` uses a sticky
fallback scoped by the resolved endpoint and exact model: `fastModeEnabled` may
remain `true` while `fastModeActive` is `false`. An explicit `set_fast_mode`
enable expresses retry intent and clears that fallback so the provider attempt
is re-armed.

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "fastModeEnabled": false,
  "tokensPerSecond": null,
  "fastModeActive": false,
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "hasPendingAsyncWork": false,
  "isSettled": true,
  "queuedMessages": { "steering": [], "followUp": [] },
  "todoPhases": [
    {
      "name": "Todos",
      "tasks": [
        {
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  },
  "capabilities": [
    "literal-input/1",
    "tool-approval-binding/1",
    "reply-attribution/1",
    "external-delivery/1",
    "quiesce-exit/1",
    "owned-jobs/1"
  ]
}
```

Fields whose values are `undefined` are omitted from JSON, including an unset
model/thinking level, session name/file, or unavailable `contextUsage`.
`dumpTools` may also include each tool's `examples` alongside its schema.

`capabilities` repeats the ready frame's capability list. `externalDeliveries`
lists every delivery record the session still holds as
`{ deliveryId, state: "queued" | "accepted", mode }`; settled, cancelled and
discarded records drop out of the list once their receipt event is emitted.

`queuedMessages` holds the same displayable queue-chip text as the `queue_update`
event below. Use this text with `remove_queued_message`, subject to its pending-queue
boundary: live-steered input stays visible until recorded but is no longer removable.
Clients should render the queue from these snapshots instead of tracking chips
independently, and treat removal responses as confirmation rather than a second
source of truth. `queuedMessageCount` also includes advisor cards and pending
next-turn messages, so it is not necessarily the number of user-authored chips.

### `goal` payload

`goal` manages goal mode with the same lifecycle as the interactive `/goal` command.
Every op answers `{ goal: Goal | null, state: GoalModeState | null }`; `get_state`
carries the same state as `goal`. `goal_updated` events report every change,
including those made by the agent's `goal` tool.

- `get` only reads. It never starts a turn.
- `create` needs `goal.enabled`, a non-empty `objective`, and no active or paused
  goal. It is refused in plan mode, and `token_budget` must be a positive integer.
  It adds the `goal` tool to the active tools.
- `resume` resumes a paused goal (refused in plan mode). `pause` and `drop` restore
  the active tools from before the goal started.
- Failures are ordinary `success: false` responses.

Goals do not continue on their own over RPC unless `goal.continuationModes`
contains `"rpc"`; this covers both `--mode rpc` and `--mode rpc-ui`. When enabled,
`create`/`resume` and each terminal `agent_end` decide whether to start another goal
turn, sent as a hidden `goal-continuation` message.

- The turn starts once the yielding run has fully unwound. At that moment the goal
  must still be active, the session idle with nothing queued and no host input in its
  input hooks or setting up its turn (the continuation waits for that input; if it
  starts a run, that run's end decides again), plan mode off, open todos not all
  blocked, and the session not being disposed.
- While the turn is decided but not yet started, `get_state.isSettled`,
  `prompt_result.sessionSettled` and `session_settled` treat the session as busy.
  `session_settled` follows if the continuation is abandoned.
- `abort` stops continuation before the abort takes effect; the interrupted goal is
  paused. Only host input re-arms it: a `prompt`, `steer`, `follow_up` or
  `abort_and_prompt` that the session accepts (not handled by an input hook; a
  `prompt` once it is admitted, or a builtin that runs the agent such as `/retry`; a
  `steer` or `follow_up` once it is queued, so a refused one does not), or
  `goal create`/`resume`. A turn the host did not start (an extension's
  `sendUserMessage`, a delivery or job wake) does not, so a goal the agent's `goal`
  tool resumes during such a turn stays stopped until host input.
- Continuation also stops after a goal turn with no new tool activity. Host input
  re-arms it, and so does the end of any turn that was not a goal continuation.
- A session change leaves the previous goal and its tool behind and restores a goal
  journaled in the target session. This covers `new_session`, `switch_session`,
  `branch` and `open_session`, and the same changes made by extension commands. A
  change is detected by the transcript id, so a host-pinned `--provider-session-id`
  does not hide it. A goal turn that is waiting or becomes due while a change is in
  progress is held. If the change is cancelled, or leaves the session unchanged
  (tree navigation, reopening the open session), the goal continues. A move to a
  sibling session file (a new session id whose `parentSession` is the old one, made
  when another process wrote the session file) keeps the session too: the goal
  continues and a host abort stays in force. While such a turn is held, the session
  is not reported as settled.

When the agent completes the goal, the goal tool is removed again and
`get_state.goal` becomes `null`.

### Quiesce and exit

A client must check `ready.capabilities` (or `get_state.capabilities`) for
`quiesce-exit/1` before sending `attest` or `quiesce_and_exit`, and for
`owned-jobs/1` before relying on the owned-job registry file.

A supervisor that wants the agent to exit without interrupting work first takes a
read-only snapshot, then asks the process to exit only if nothing changed:

1. `attest` → `data`: `{ version: 1, operationId, nonce, epoch, instanceId,
   session: { id, file }, invocation: { pid, startId, startTime }, counts,
   admission: "open" | "closed", registry: { path, complete, ownerScan }, observedAt }`.
   `counts` has `streaming`, `queuedInput`, `asyncJobs`, `subagents`, `retainedJobs`,
   `detachedJobs`, `compacting`, `handoff`, `goalContinuationScheduled`,
   `scheduledTurns`; any non-zero value means work is outstanding. `queuedInput`
   includes commands this process has read but not yet answered, user input still in
   the ordered input gate (waiting its turn, in input hooks or skill/attachment
   preparation; an `abort_and_prompt` is answered before its prompt gets there),
   notifications received but not yet queued (MCP resource changes inside their
   debounce window), and every [external delivery](#external-delivery) the session
   still holds (`queued`, or `accepted` and not yet settled). Each owned delivery counts
   once, even while parked in the bridge queue; accepted-but-unsettled owners remain
   counted after leaving all queues. Commands still answered after the pass (the
   read-only list below) are not counted.
   `asyncJobs` and `subagents` count background jobs until their run has unwound,
   including a cancelled job that is still stopping; a parked subagent is not work.
   `scheduledTurns` includes turns scheduled to start, retry and TTSR resumes, event
   and extension handlers still running after the agent went idle, message
   persistence in flight, advisor reviews queued or running, a primary turn boundary
   held by an advisor sync catch-up wait (`advisor.syncBacklog`), and an in-flight
   cache-warming request; updates the advisor review cadence holds back for a later
   review are not work. `streaming` includes side-channel (ephemeral) turns. `epoch`
   increases whenever input is admitted or work starts. `instanceId` is random per
   session object and process. `detachedJobs` counts live owned processes, including
   ones found by the owner-marker scan below; `registry.complete` is false unless that
   scan was `sound` and the session is persisted.
2. `quiesce_and_exit` `{ operationId, attempt, epoch, instanceId, sessionId, deadline }`,
   with `epoch`, `instanceId` and `sessionId` (`session.id`) copied from the attestation
   the decision is based on. `deadline` is Unix epoch milliseconds compared against the
   agent host's clock (`Date.now()` in the agent process); a supervisor on another host
   should derive it from the attestation's `observedAt` plus a relative budget. The
   process closes every input path, then requires the `instanceId` and `sessionId` to
   match, all counts zero, `epoch` unchanged and the deadline not reached — all without
   yielding, so no input can interleave. A session switch (`new_session`,
   `switch_session`, `open_session`, `branch` to another session) also advances `epoch`.
   - Pass → `data: { status: "quiesced", operationId, attempt, attestation, path }`.
     Before the attestation is written the transcript is made final (the exit record
     is appended, flushed and the file sealed), and `attestation.session` carries its
     `size` and `sha256`; nothing is appended to the session file afterwards. If
     another process owns the session file, the exit record moves the transcript to a
     fresh sibling in the same directory (a new session id whose `parentSession` is the
     old one); `attestation.session`, `path` and `registryPath` then name that sibling,
     the file actually hashed.
     `attestation` (`kind: "quiesce"`, with `invocation` and `instanceId`) was already
     fsync'd to `path` (`<session file without .jsonl>.terminal.json`) before the
     response is written; the process then disposes the session and exits with code
     0. From the pass on, only read-only commands run (`attest`, `get_*`,
     `negotiate_protocol`, `set_event_filter`, `set_subagent_subscription`,
     `set_ask_dialog`, `predict_word`, `predict_word_feedback`, `goal` `get`); every
     other command — input and state-changing commands alike, including
     `cancel_subagent`, `steer_subagent`, `deliver` and `cancel_delivery` — fails with
     `code: "admission_closed"` (no delivery can be held after a pass, since a held one
     refuses the quiesce; after a hang-up, held records are discarded with `disposed`
     during teardown), no internal producer (queued notifications, scheduled
     continuations, IRC wakes, cache warming) starts a provider call, and no parked
     subagent is revived. An extension's `deliverMessage` after that point is not
     admitted: it returns a handle already discarded with `admission_closed`.
     `predict_word` and `predict_word_feedback` use only a prediction-daemon
     connection the process already holds: without one, `predict_word` answers
     `suffix: null` and feedback is dropped, so neither starts the daemon, its broker
     or a model download after the pass.
   - Exit without attestation → `data: { status: "exit_unattested", operationId,
     attempt, reason: "attestation_unavailable", error, snapshot }`. The session was
     idle and its transcript was made final, but the attestation could not be written.
     The process exits anyway, with code 1; there is no terminal attestation for this
     exit, so the consumer decides from the registry (`verifyOwnedJobRegistry`).
   - Refusal → `data: { status: "refused", operationId, attempt, reason, snapshot:
     { epoch, counts, observedAt } }`. Admission is reopened and nothing is cancelled.
     `reason` is one of `work_active`, `epoch_mismatch`, `deadline_expired`,
     `invocation_mismatch` (the `instanceId` belongs to another session object or
     process), `session_mismatch` (the session was switched since the attestation),
     `stale_attempt`, `admission_closed`, `invalid_request`, `attestation_unavailable`
     (no session file, or the attestation directory is not writable).

Each `(operationId, attempt)` is evaluated once: repeating it returns the original
answer unchanged (so a retry after a lost response learns whether it passed), and a
lower attempt is refused with `stale_attempt` without evaluation; an expired deadline
never executes. Malformed requests and requests refused with `invocation_mismatch` or
`session_mismatch` do not use up the attempt number. Once a result ends the process,
teardown gets at most 30 seconds before the process is ended regardless.

Extensions (`ctx.quiesceAndExit`) cannot quiesce from inside their own command or event
handler: the running handler is outstanding work, so the answer is `work_active`.
Call it from outside any handler (for example from a timer or an external trigger).

On SIGHUP or SIGTERM the process writes the same file with `kind: "hangup"`,
`signal`, and `interrupted: true` when any count was non-zero, capturing the counts
before any other exit cleanup clears queues, timers or jobs. It then makes the
transcript final and adds its `size` and `sha256`, as a passed quiesce does; afterwards
the same read-only allowlist applies. In interactive and ACP hosts the digest is added
after the host's own teardown (so `session_shutdown` handlers' writes are covered);
exit cleanup gets at most 10 seconds, and a teardown that outlives it ends with the
process killed before the digest is added: `session.size` and `session.sha256` are then
absent, and the attestation binds no transcript content. If teardown's last writes
move the transcript to a sibling because another process owns the session file, the
completed attestation names the sibling and is written next to it; the capture next
to the original file keeps its pre-teardown identity and no digest.

**Which attestation describes an exit.** When a session is opened, resumed or
switched to, the agent renames any `<base>.terminal.json` an earlier invocation left to
`<base>.terminal.<pid>-<startId>.json` (its writer's identity, directory fsync'd),
removes unpublished `<base>.terminal.json.<pid>.tmp` files whose writer is gone, and
writes its own registry header. A terminal attestation is valid for a request only if
its `operationId`/`attempt` match the request and its `invocation` equals the invocation
the consumer last observed through `attest` (or `get_state`).

**Decide from both.** A clean terminal attestation is necessary, not sufficient: after
observing that the process exited, a consumer must also run
`verifyOwnedJobRegistry(path, { expectedInvocation })` with that invocation and treat
the session as clear only if the attestation is clean **and** the verdict is `clear`.
The attestation describes what this invocation could see when it decided; the registry
check also covers what happened afterwards or elsewhere (another invocation writing the
same session file, a process that outlived the exit). A registry with no header for the
expected invocation may be missing that invocation's records, and answers `unknown`.

The owned-job registry (`<session file without .jsonl>.jobs.jsonl`, append-only,
fsync'd per record; a writer that finds a torn last line starts a new line first) lists
processes and in-process jobs the agent started: `invocation` headers (`complete:
false` when some process may be untracked; `writer`, a random id of the registry object;
`inheritedOwnerMarkers` when it took over other invocations, below), `start` records
(`jobId`, `kind`, `pid`, `pgid`, `startId`, `startTime` in Unix seconds for display,
`command` (at most 4096 characters), `cwd`, `sleepable`, `inProcess`, `reparented?`,
`groupMember?`, `discovered?`, `carriedFrom?`, `adoptedFrom?`; `service` records also
`broker?` and `daemon?`, below), `end` records, and
`incomplete` records; `start`, `end` and `incomplete` records carry `invocationPid` and
the `writer` of their header (records written before `writer` existed have none). A
record belongs to the latest preceding header whose invocation has its `invocationPid`
and, when the record has a `writer`, the same `writer` — so two session objects in one
process writing the same file never end or hide each other's jobs; job ids restart per
header. `startId` is an opaque,
clock-independent start identity (Linux: start ticks since boot; macOS: start time in
microseconds; Windows: creation `FILETIME`) compared for equality only. An open record
with `inProcess: false` is alive iff a live, non-zombie process with that `pid` has that
`startId`; a process whose identity cannot be read counts as possibly alive. An open
`inProcess` record after its invocation ended, or any incomplete marker, means the
registry cannot vouch for every process. `kind: "retained-shell"` stays open while a
shell is kept alive for a running background job, which can start processes nobody
reports. Every time the agent binds a session file (a switch, including a switch back)
it re-appends every open start record not yet in that file with `carriedFrom` naming
the first file; the end record then goes to every file holding the start.

**Other invocations of the same session file.** OMP does not lock a session file: a
resume can bind a file earlier invocations wrote, and a second OMP can have it open at
the same time. The agent reads what other writers append — on first binding a file and
again, incrementally, before every owner scan (so on every `attest`, `quiesce_and_exit`
and hang-up capture), for every file it has bound, not only the current one — and takes
it over into the current file. It reads only whole lines: an unterminated last line that
stays the same across two reads while no other invocation of the file is running is a
record its writer died writing, and makes this invocation incomplete. A registry file
replaced by another file (a different inode), or truncated or rewritten in place (the
last 512 bytes it consumed are no longer where it read them), also makes it incomplete
and is read again from the start; a registry file it read that has since been removed
makes it incomplete. What it takes over, separately for every file it reads and every
read of a file from its start:
- every open process record that is not provably gone is re-appended under this
  invocation with `adoptedFrom` and counted in `detachedJobs`;
- another invocation still running (or one whose identity cannot be read) counts as one
  live process in `detachedJobs`, so no quiesce passes while it can still start work;
- their owner tokens go into `inheritedOwnerMarkers` and are scanned from then on,
  counting unexaminable processes started since the earliest of those invocations; a
  token stops being copied into new headers only when its invocation is gone, no open
  record was adopted from that invocation, and two consecutive scans that could examine
  every candidate process — tracked or not — found none carrying it, with no counted
  process exiting between those scans and their counts (the header that issued it still
  names it, so consumers keep scanning it). Two scans that each miss a carrier that
  forks and exits during its own scan could still drop a token whose child lives; only
  this invocation's later headers and attestations lose it;
- their incomplete state — a header that is not exactly `complete: true` with no reasons
  (every header, including a writer's repeated one), an `incomplete` record, an
  in-process job still open once its invocation is gone, an unparseable line — makes
  this invocation incomplete too (`inherited: <reason>`). Another session object in the
  same process is not watched for liveness: its open in-process jobs make this one
  incomplete at once, and it never counts as live work.
Incompleteness therefore sticks to a session file: once an invocation could not vouch
for everything it started, no later invocation of that file claims `complete`.

`kind: "internal"` records are engine helper daemons this invocation started (the
daemon broker `__omp_worker_daemon_broker`, text prediction
`__omp_worker_text_predict`). They are shared by every agent process in their scope,
run no Thread work, and exit on their own idle timer (broker: a few seconds after the
last agent process in its scope disconnects, stopping non-persistent children such as
text prediction) — so they never count as outstanding work, alive or not. Services a
broker hosts, including persistent or detached ones that outlive it, have their own
`service` records; a mode change that restarts a service records the new process with
the `sleepable` value given at start. A helper started by a different agent process
has no record here; consumers identify it by that worker selector in its argv.

**Services and their broker.** A `service` record's `pid` is the service's current
process, but the broker hosting it can relaunch it under a new pid — after an
out-of-band kill while a restart policy holds (`restarting`, its backoff), on a
`restart` request (`omp ps restart`), or on a switch to `detached`. So each `service`
record carries `broker: { pid, startId }`, the identity of the broker serving the
service's scope when it was recorded (read from the scope's `broker.pid` lease), and
`daemon: { id, meta }`, the broker's id for the service and the `meta.json` where the
broker publishes it. A service is work while its own process is alive **or** its
broker is alive: the record is not ended merely because its pid is gone. The agent
itself reads `meta` (the consumer rule below does not): it ends the record once the
broker publishes the service `exited` or `failed`, or replaced by another service of
that name, and when it reads `meta` after the broker published a relaunched process,
records that process as a new `service` record (`jobId` `service:<id>:<startedAt>`,
same `command`, `cwd`, `sleepable`, `broker` and `daemon`); metadata it cannot read
keeps the service counted. A `restart` request (and a switch to `detached`) publishes
the service as `restarting` from the stop until the relaunched process runs, so no
read in between ends the record. The broker runs `stop`, `restart`, `mode` requests
and a `start` that takes an existing service's name one at a time per service, in
arrival order. A request whose turn comes after a `start` replaced the service, or
once the broker is shutting down, is refused rather than acting on a process the broker
no longer tracks; a `start` that is still stopping the service it replaces, or still
setting up, when shutdown begins is refused before it launches anything. So
overlapping requests never leave a process the broker does not track. A refused
request is not re-sent to the replacement: a `stop` refused because a `start` replaced
the service leaves the replacement running, and a caller that wants it stopped sends
`stop` again. Requests can still end the record before a relaunch: a `stop` followed by
a `restart` stops the service (ending its record) and then relaunches it, and that
relaunch is the scan-covered class below. A service whose broker could
not be identified, or was gone when the service was recorded, marks the registry
incomplete. The agent
services start with no restart policy, so the broker relaunches one only on request.
A relaunch the record cannot follow comes back only through the owner-marker scan (the
service's environment carries `OMP_OWNER`), as an anonymous `discovered` process
(Linux) or as unexaminable (macOS, `unknown`): a `restart` of a service already
published `exited` or `failed` (its record ended with it), and a relaunch by a later
broker of the scope after the recorded one exited — records keep the broker that
recorded them, so a detached service that a successor broker recovers is followed by
its pid while that process lives, and by the scan after that. The agent never stops a
broker or a service to clear an answer.

**Owner marker.** Every process the agent starts for work — embedded shell runs,
PTY shells, named services, apps the browser tool launches (`app.path`, also recorded as
`process`), and commands run by extensions (`pi.exec`), hooks and custom tools — inherits
`OMP_OWNER`, a comma-separated list of owner tokens `omp1:<pid>:<startId>` (an agent
started from another agent's shell appends its token to the inherited list; the shared
daemon broker gets none). Each `invocation` header records `ownerMarker: { env:
"OMP_OWNER", token }`. A process that double-forks, calls `setsid` or otherwise escapes
the shell keeps its environment, so `attest`, `quiesce_and_exit` and a hang-up capture
scan processes that run as (or were started by) this user — real, effective or saved uid
— for the token, record every live marked process the registry did not track as a
`start` record with `discovered: true`, and count it in `detachedJobs`. A counted
process (or another invocation) that exits between the scan and the count may have
handed the marker to a child the scan did not see, so the scan and count are repeated
while that happens; after 3 rounds that never settle, `sound` is false. `ownerScan` is
`{ supported, sound, scanned, discovered, opaque }` (`discovered` summed over the
rounds): `opaque` lists candidate processes (this user's) started since the earliest
invocation scanned for whose environment could not be examined — setuid or
non-dumpable descendants, or a process in another Landlock domain such as a separate
`openshell exec` session — which could hide the marker; a process that started before
every invocation scanned for is never the agent's and is ignored whatever it carries.
`sound` is false if any opaque process exists, if the OS hides processes from the scan
(Linux `/proc` mounted with `hidepid`), or if the rounds never settled.

Limits — the classes that can read as clear on Linux, where the scan is otherwise sound,
so a consumer must keep its own host process census as a required cross-check:
- a process that clears or replaces its environment (`env -i`, `sudo` with `env_reset`,
  some daemonizers) carries no marker, so the scan cannot find it — whether it escapes
  while a shell run is still in flight (`sh -c 'setsid env -i cmd &'` leaves all counts
  zero) or later; embedded shell runs report only the processes they themselves spawned
  and were still alive when the run ended;
- processes started through the extension `user_bash` hook (the extension runs them
  itself) or on an ACP client terminal (they run in the client) are not registered;
- engine infrastructure is neither marked nor registered: MCP stdio servers, language
  servers (including the shared LSP mux daemon), the IDA worker, the tiny-model title
  worker, the blob broker, the shared headless Chromium and the browser relay daemon
  (both started through the daemon broker with no marker) and the Chromium the browser
  tool launches in-process through puppeteer in SDK and `bun` hosts (detached). They run
  no Thread work; the LSP mux, blob broker, title worker and broker-hosted browsers are
  shared helpers that can outlive one agent process;
- a writer in another pid namespace that shares the session directory (a sibling
  container, `unshare -p`) has pids that mean nothing here: its invocation and processes
  read as gone, so the registry and the verifier assume every writer of a session file
  runs in the consumer's pid namespace;
- a marked process no earlier scan found, which the scan lists but which forks a marked
  child and exits before its environment is read, is dropped by that scan without a
  trace: nothing counted vanished, so the answer settles while the child runs. The
  window is one environment read; the verifier's later scan finds the child.

Paths that mark the registry incomplete instead: every PTY shell run (on every
platform), eval runs (their long-lived kernels are not marked), a shell run whose spawn
report is incomplete (a live process it could not identify, a process left in a group
the run created whose `/proc/<pid>/stat` cannot be read, an unreported `nohup … &`
reparent, a failed run), a background job still running when its run was cancelled, a
service start or mode change that ended without reporting its process, and any debug
(DAP) session. A shell run identifies its processes by pid and start time: through a
pidfd where `pidfd_open` works, otherwise from `/proc/<pid>/stat` (older kernels, and
sandboxes such as OpenShell whose seccomp filter fails `pidfd_open` with `ENOSYS`), so
a run whose processes are all visible reports itself complete either way. Its group
enumeration reads only `/proc/<pid>/stat`, so processes whose environment cannot be
read, unrelated or not, never make it incomplete. Whether a group the run created still
has members is asked with `kill(-pgid, 0)`: only `ESRCH` means it has none, and
`EPERM` (a member exists that is not ours to signal, such as a setuid program) or any
other failure means it may still have one. Only where every process-group
signal is refused (OpenShell's seccomp filter fails them all with `EPERM`; detected by
probing the agent's own group, once per thread) does the process table decide instead:
a group counts as gone only when two complete listings in a row show no member of it,
zombies included. On macOS the kernel withholds the
environment of Apple platform binaries (`sh`, `zsh`, `sleep`, …), so the scan is almost
never `sound` there and consumers get `unknown` rather than a false clear. Windows has
no scan.

**Processes outside the agent's tree.** Processes the agent never launched — started by
an operator or a harness, for example with `openshell exec`, even under the agent's uid
and in the same sandbox — are not agent work: they are not in the registry, never count
in `attest`, and the host process census (E4) accounts for them. The scan cannot tell
one from an escaped descendant of the agent only when it started after the agent and
its environment cannot be read (an `openshell exec` session is a separate Landlock
domain, so the agent cannot read it): it is then `opaque`, `sound` is false, and the
answer stays `unknown` until it exits. One that started before the agent, or runs as
another uid, has no effect.

**Consumer rule after the agent exited** (`verifyOwnedJobRegistry(path, {
expectedInvocation })` in `@oh-my-pi/pi-coding-agent/session/owned-job-registry`
implements it):
1. Attribute each record to the latest preceding header with its `invocationPid` and,
   when the record has a `writer`, the same `writer`. At best `unknown` for: a malformed
   line; an unknown record type; a header whose fields do not have the types above
   (`invocation.pid` an integer, `invocation.startId` a decimal string or null,
   `sessionId` a string, `complete` a boolean, `incompleteReasons` strings, `writer` a
   string, `ownerMarker` and every `inheritedOwnerMarkers` entry with string
   `token`/`env` and a decimal-string or null `startId`); a start record without a string
   `jobId` and `kind`, an integer `pid`, a boolean `inProcess` and a decimal-string or
   null `startId`, or with a `broker` that is not `{ pid: integer, startId:
   decimal-string | null }` or a `daemon` that is not `{ id: string, meta: string }`; a
   record with a non-string `writer`; a record with no such header.
   With `expectedInvocation`, no header for it → at best `unknown`.
2. Any invocation still alive (pid + `startId`) → `live`: use `attest` instead; one
   whose identity cannot be read → at best `unknown`.
3. A header counts as complete only when `complete` is exactly `true` and it lists no
   `incompleteReasons`; any other header, or any `incomplete` record → at best `unknown`.
4. Open records, ignoring `internal`: `inProcess` → `unknown`; otherwise alive by pid +
   `startId` → `blocked`; identity unreadable → at best `unknown`. A record with a
   `broker` (only `service` records have one) whose own process is gone is still work
   while its broker is alive by pid + `startId` → `blocked` (the verdict's `live` entry
   names it in `broker`); broker identity unreadable → at best `unknown`; broker gone →
   ended. Consumers do not read `daemon`. Until the broker exits (a few seconds after
   the last agent process of its scope disconnects, unless it hosts a persistent
   service), this also blocks on a service that already exited after its agent crashed:
   only the agent, which reads the broker's metadata, can tell that apart. Any other
   agent process, presence or persistent service in the same broker scope keeps that
   broker alive, so in a shared project scope this can last as long as they do.
5. One scan for every token in any header's `ownerMarker` and
   `inheritedOwnerMarkers`: any live match → `blocked`; an unexaminable process started
   since the earliest of those invocations, a scan that reports hidden processes, or no
   scan on the platform → at best `unknown`.
6. Otherwise `clear`.

### `set_fast_mode` payload

`set_fast_mode` changes whether fast mode is enabled for the session. The
request is:

```json
{ "id": "req_fast_on", "type": "set_fast_mode", "enabled": true }
```

On success, `data` always contains both `enabled` and `active`. These are the
actual computed values: `enabled` reports the session setting, and `active`
reports the resulting active state, including any provider-level Fireworks
priority setting:

For direct Anthropic, an explicit enable also re-arms a provider attempt after
the sticky rejection fallback, even when fast mode was already enabled.

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": true, "active": true }
}
```

Enabling fast mode on a model without a service-tier family, or an OpenAI-family
model that does not offer the priority tier, fails with the error below:

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": false,
  "error": "Fast mode is unavailable for the current model."
}
```

Disabling fast mode is idempotent, including on an unsupported model. It
succeeds as an off/no-op result, but disabling `/fast` does not override
provider-level settings, so a successful disable does not guarantee
`active: false`. For example, with an unsupported
`fireworks/deepseek-v4-flash` model and `providers.fireworksTier: priority`,
the response reports the session setting as disabled while the provider
priority keeps the computed active state true:

```json
{
  "id": "req_fast_off",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": false, "active": true }
}
```

The corresponding `get_state` result reports the same computed state:

```json
{
  "fastModeEnabled": false,
  "fastModeActive": true
}
```

### `set_ask_dialog` payload

`set_ask_dialog` opts the host in to the `ask` extension UI request (see
[Extension UI Sub-Protocol](#extension-ui-sub-protocol)). It is off by default
for every process; until a host enables it, the `ask` tool keeps prompting with
one `select` (plus `editor` for free text) per choice. Builds without the
command answer with a failed `response`, so hosts should keep the `select`
fallback when enabling fails.

```json
{ "id": "req_ask", "type": "set_ask_dialog", "enabled": true }
```

```json
{
  "id": "req_ask",
  "type": "response",
  "command": "set_ask_dialog",
  "success": true,
  "data": { "enabled": true }
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns `{ todoPhases }`.
Phases use `{ name, tasks }`; tasks retain `{ content, status, blocker? }`. There
are no phase or task IDs. Status is `"pending"`, `"in_progress"`, `"completed"`,
`"abandoned"`, or `"blocked"`. Snapshot cloning drops extra fields, including
task `details` and `notes`.

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "name": "Evaluation",
      "tasks": [
        {
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are registered before the next model call. New non-hidden tools
are enabled automatically; new hidden tools are registered without being enabled.
Re-sending `set_host_tools` replaces the previous host-owned set, preserving the
enabled state of surviving host tools. Names must be unique and cannot conflict
with an existing non-host tool.

Definitions also accept `hidden?: boolean`,
`loadMode?: "essential" | "discoverable"`, and `readsSkillUris?: boolean`.
Set `readsSkillUris: true` when the tool can read `skill://` instruction content;
prompt builders use this capability to decide whether to include skill guidance.
An explicit load mode wins. When omitted, known essential built-in names remain
`"essential"`; other host tools default to `"discoverable"`. `toolNames` in the
response lists the registered names.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Scheme names are trimmed and lowercased and must match `[a-z][a-z0-9+.-]*`.
`writable` and `immutable` default to `false`. Re-sending `set_host_uri_schemes`
replaces the entire previous set — schemes missing from the new list are
unregistered; an empty list clears all host schemes.

Every built-in scheme (`local://`, `skill://`, `artifact://`, `security://`,
`mcp://`, …) is reserved: RPC hosts cannot register or shadow one, and the
request fails with `Host URI scheme is reserved by OMP: <scheme>://`.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_stream_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `cache_warming_start`, `cache_warming_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `model_changed`, `thinking_level_changed`, `config_warnings_changed`
- `advisor_cost_changed`, `advisor_yielded`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`, `notice`, `goal_updated`
- `queue_update`
- `delivery_accepted`, `delivery_settled`, `delivery_discarded`, `delivery_cancelled`

### `queue_update` event

```json
{ "type": "queue_update", "steering": ["Use the existing parser"], "followUp": [] }
```

Emitted whenever the displayable steering/follow-up queue changes: a `steer`,
`follow_up`, or queued `prompt` adds to it; delivery into the transcript,
`remove_queued_message`, an abort that drops in-flight queued messages,
or a session switch removes from or clears it. The server coalesces this
against the last value sent — a mutation that leaves the snapshot unchanged
(for example, an agent-authored aside that never renders as a chip) never
re-emits. `steering`/`followUp` mirror `get_state`'s `queuedMessages` field and
carry the queue-chip text accepted by `remove_queued_message` while the message
is still pending. Live-steered messages stay listed until recorded in the
transcript, even after they cease to be removable. Render the queue from this
event rather than tracking chips independently, and treat removal replies as
confirmation of a change rather than independent queue state.

Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

`message_start`, `message_update`, and `message_end` carry a `messageId` string assigned by RPC mode. One message keeps the same id from its start through every update to its end; ids are unique within the process. Records injected mid-stream (advisor cards, IRC messages) get their own id and do not disturb the id of the reply streaming around them.

`set_event_filter` restricts which session event frames are written: pass the event `type` strings to forward, or `null` to forward everything (the default). The response echoes the active selection as `{ events, messageUpdates }`. The filter applies to all events emitted through the session subscription, not just the common types listed above; every other outbound category (responses, `prompt_result`, `session_settled`, extension UI and host tool/URI requests, `extension_error`, `available_commands_update`, subagent frames, builtin slash-command side channels, and session-persistence `notice` frames) is unaffected by this filter. Hosts that fail closed on unknown event kinds can pin the set they understand here instead of breaking when OMP adds an event.

The optional `messageUpdates: "delta"` projects only `message_update` frames to `{ type: "message_update", messageId, message: { role }, assistantMessageEvent }`: `assistantMessageEvent.partial` is omitted, while all other event fields (including subtype, `delta`, and `contentIndex`) are preserved. `message_start`, `message_end`, and all other frames are unchanged; `message_end` still carries the full message. Block-ending events such as `text_end`, `thinking_end`, and `toolcall_end` retain their block content or tool call, so hosts must still accept chunked protocol-v2 frames for large blocks and full messages. Switching modes mid-message does not change its `messageId`. The projection applies to the session's own frames only: `subagent_event` payloads forwarded under `set_subagent_subscription` level `"events"` keep their full `message_update` snapshots.

Each command replaces the whole filter state: omitting `messageUpdates` resets it to `"full"`, the default, which retains the original full snapshots. An invalid `events` shape (anything other than `null` or an array of non-empty strings), or a mode other than `"full"` or `"delta"`, returns an error without changing either setting. Event names are not checked against a fixed catalog; unknown non-empty names are accepted. Projection works in protocol v1 and v2, including with `events: null`. Detect support from the echoed `data.messageUpdates` field: older servers ignore the option and do not echo it. This opt-in is raw-protocol only; the TypeScript `RpcClient` and Python client keep their full-message listener contracts.

`agent_end` has this session-level shape (in addition to optional telemetry fields):

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
  yielded?: boolean;
  awaitingAsyncWork?: boolean;
}
```

`yielded` is `true` when the agent finished its turn: the end is terminal, or the session resumes only for queued input or background-job results. It is `false` while the agent continues its own work (retry, compaction continuation, stop-time reminders). Frames from older runtimes omit it; treat those as yielded only when terminal.

`isTerminal: false` means a continuation or possible async delivery remains.
`awaitingAsyncWork: true` identifies a non-terminal end whose only possible
resume is a background-job result; cancelled or suppressed delivery may mean
no follow-up run occurs. The optional fields keep older frames terminal-compatible
when `isTerminal` is absent. Use `yielded` for a prompt's yield and
`session_settled` for quiescence, rather than assuming every non-terminal end
guarantees another turn.

### Cache warming events

Each refresh handed to the provider stream emits one start and one matching end
(a session disposed mid-refresh emits no end).
Warm-or-stop decisions that do not send a request emit neither. These are
session events, so **both types must be listed in `set_event_filter` when a filter
is active** to observe complete refresh lifecycles:

```ts
{
  type: "cache_warming_start";
  phase: "streaming" | "idle";
  provider: string;
  model: string; // model id
}
{
  type: "cache_warming_end";
  phase: "streaming" | "idle"; // same phase as the matching start
  provider: string;
  model: string;
  outcome: "hit" | "miss" | "error" | "aborted";
  usage?: Usage;
  warmingStopReason?: string;
}
```

- `hit`: the refresh read cached tokens without writing a new cache entry.
- `miss`: it read no cached tokens or wrote cache tokens; warming stops.
- `error`: no response was available or the response reported an error; warming stops.
- `aborted`: the run was cancelled or replaced while the refresh was in flight.

`usage` is present only when the refresh was recorded as a `model_usage` entry
(`purpose: "cache-warm"`, or `"cache-warm:extension-override"` when an extension
forced it). This includes paid misses, errors, and `aborted` refreshes the
provider had already accepted (usage reported before the cancellation); an
abort before the provider responded has no usage. Summing `usage.cost.total`
attributes the warming costs already included in `get_session_stats`, rather
than adding another charge.

These events are ordinary session events, so `--mode json` output includes them
as well.

`warmingStopReason` explains why warming stopped because of or during the
refresh, for example `"refresh missed the cache"`, `"refresh failed"`,
`"cache warming disabled"`, or `"conversation context changed"`. It is absent
when warming continues: the refresh rescheduled, or a new request replaced the
run.

## External delivery

`external-delivery/1` lets a host hand the session a record authored by
another actor (a peer agent, an operator on another device, a mailbox) without
it going through prompt or slash-command parsing, and get a receipt that says
exactly whether and how the model saw it. Extensions get the same surface as
`ExtensionAPI.deliverMessage(record, options)` with `ExtensionAPI.capabilities`
(a `ReadonlySet<string>`) for negotiation; `deliverMessage` throws when the
capability is absent.

The record is a custom message payload (`customType`, `content`, `display`,
`details`, optional `attribution`). `content` is the display form and never
reaches a provider. The provider view MUST be declared in `details`:

```json
{
  "customType": "peer-mail",
  "content": "[mail from T-42]",
  "display": true,
  "details": {
    "omp.llm": { "role": "user", "content": [{ "type": "text", "text": "..." }] },
    "omp.llm.source": "mail:01ABC"
  }
}
```

`omp.llm.content` is a string or an array of `text`/`image` parts. A record
without a valid projection (wrong role, unknown part type, missing string
`omp.llm.source`) is rejected by `deliver` with an error response; it is never
sent as a fallback developer message.

`options.mode`:

- `aside` never interrupts. Idle: it wakes a turn. Busy: it joins the running
  evaluation at the next poll. At a stop boundary it only joins a run the
  deliveries themselves own; otherwise it waits for its own wake once the run
  settles.
- `steer` forces the next turn boundary and is never accepted as an aside.

For `aside` only: idle in plan mode holds the record unless `wakeInPlanMode`
is set; idle after an operator interrupt holds it unless `wakeAfterInterrupt`
is set (the interrupt latch is not cleared). A record an RPC input hook delivers
while it runs is not held by either (see
[External delivery commands](#external-delivery-commands)). A `steer` always wakes. A record
delivered while a prompt is waiting on manual-compaction cleanup or setting up
its turn, or while a session transition is open, is held and folds into or
follows that turn rather than racing it; a prompt that only runs an extension
command does not hold it. Pressing Esc in the interactive UI parks a queued
`steer` instead of dropping it; it wakes as soon as the abort settles.

Receipts, one event each, all carrying `deliveryId`:

- `delivery_accepted` `{ at, mode, mechanism: "wake" | "aside" | "steer-boundary" }` when the
  loop commits the record into context (never when merely queued).
- `delivery_settled` `{ outcome: "quiet" | "text" | "refused" | "error" | "aborted", included, requests, sole, interactive }`
  when the owning evaluation ends. `included` is true only when exactly one
  stamped projection reached a main request that completed without error or
  abort. `sole` means no other queue-delivered input (prompt, steer, follow-up,
  another record, a hidden or synthetic prompt, a goal continuation, an
  extension message, hook output) joined the evaluation; records the engine
  injects on its own (soft-requirement reminders, execution additional
  context, todo/context nudges, plan/goal context frames) do not count.
  `interactive`
  means an operator-authored input joined. A delivery-owned evaluation may end
  quietly (thinking only, no visible text or tool call) and reports `quiet`
  without the usual empty-response retry.
- `delivery_discarded` `{ reason }` when the session lets go of a queued
  record without admitting it: `new-session`, `session-switched`, `disposed`.
  An extension `deliverMessage` made after the session closed input admission
  (a passed quiesce or a hang-up) returns a handle already discarded with
  `admission_closed`; RPC `deliver` then fails with `code: "admission_closed"`.
- `delivery_cancelled` when `cancel_delivery` succeeded (only while `queued`).

`delivery_settled` is emitted after the run's `agent_end`. A wake whose only
inputs were cancelled or vetoed still yields an `agent_start` + `agent_end`
pair with no provider request.

### Available commands

`get_available_commands` returns `{ commands }`, and the same array is pushed
in `available_commands_update` frames at startup and after command metadata
changes. Each command has `name`, `source`, and optional `aliases`,
`description`, `input.hint`, and `subcommands`.

Command discovery is intentionally an OMP dialect: Pi's `get_commands` (a
`RpcSlashCommand[]` projection over extensions → prompt templates → skills) is
not served because OMP's richer catalog (builtins/custom/MCP/file commands,
broader `source` enum, no Pi `sourceInfo`) is not wire-compatible with it.

### Pi-compatible history/tree commands with OMP-native entry payloads

The commands and reconciliation semantics below are Pi-compatible, but the
returned `SessionEntry` payload union is OMP-native, not wire-identical to
Pi. Concretely: Pi `model_change` carries `provider` + `modelId` while OMP
carries a combined `model` plus role/fallback metadata; Pi uses a `usage`
entry where OMP uses `model_usage`; and OMP has additional entry types (for
example service-tier, title, mode, credential, and reset records). A
permissive client that consumes the common structural subset
(`id`/`parentId` plus message entries) can share one durable-history
algorithm across both, while a strict Pi `SessionEntry` decoder cannot assume
identical payloads.

`get_entries` reads the canonical append-history (not the active branch only)
and returns `{ entries, leafId }`. Without `since` it returns all entries in
append order; with `since` it returns entries strictly after the matching
durable entry id. An unknown `since` fails explicitly with
`code: "unknown_since"`. `get_tree` returns the raw session tree as
`{ tree, leafId }` straight from `SessionManager`, not a UI projection.

`get_available_thinking_levels` returns `{ levels }`: the selectable levels
for the live model with `"off"` first (it is accepted by
`set_thinking_level` but excluded from the effort-only model helper). OMP-only
`auto`/`inherit` selectors are intentionally omitted from discovery.

Lifecycle stays OMP: `agent_end` carries `isTerminal`, `yielded`, and optional
`awaitingAsyncWork`; `prompt_result` correlates prompt completion and
`session_settled` reports quiescence. There is no Pi `agent_settled` frame.
These, `agentInvoked`, `open_session`, `set_event_filter`, `messageId`, `ready`,
negotiation, chunking, host tools, and subagents are OMP extensions a
Pi-family adapter must dialect around.

### Subagent subscriptions

Subagent forwarding defaults to `"off"`. `set_subagent_subscription` selects:

- `"off"`: no forwarded subagent frames
- `"progress"`: lifecycle and progress frames
- `"events"`: lifecycle, progress, and full subagent event frames

`get_subagents` returns the registry snapshot sorted by subagent index and id.
`get_subagent_messages` selects a transcript by `subagentId` or a registered
`sessionFile` (`subagentId` takes precedence); arbitrary file paths are rejected.
`fromByte` supports incremental reads, defaults to zero, and is clamped to a
non-negative integer. Non-finite values fail. The result contains `sessionFile`,
`fromByte`, `nextByte`, `reset`, raw transcript `entries`, and `messages` from
message entries. Only complete newline-terminated records are consumed; reuse
`nextByte` on the next request. A missing transcript returns empty arrays.
If `fromByte` exceeds the current file size, reading restarts at byte zero and
reports `reset: true`.

### Cancelling subagents

`cancel_subagent` hard-kills one subagent currently listed by `get_subagents`
(foreground or background, at any nesting depth) without aborting the parent
turn. It uses the same path as the Agent Hub kill: the subagent's live turn is
aborted and its registry entry becomes an `aborted` tombstone, so the owning
`task` call settles with an aborted result and the subagent cannot be revived.
When `set_subagent_subscription` is `"progress"` or `"events"`, a
`subagent_lifecycle` frame with `status: "aborted"` follows.

```json
{ "id": "req_1", "type": "cancel_subagent", "subagentId": "OmpWorker" }
{ "id": "req_1", "type": "response", "command": "cancel_subagent", "success": true, "data": { "cancelled": true } }
```

`cancelled` is `false` when the id is not a running subagent of this session:
unknown, another session's same-name agent, finished (including a subagent
whose result the parent already accepted, even before its terminal lifecycle
frame), or already cancelled, so hosts can treat it as idempotent. If the
`aborted` tombstone cannot be persisted, the subagent is still aborted and
disposed, and the command returns an error response with the write failure.

### Steering subagents

`steer_subagent` sends a message to a running subagent as its user, the same
way Agent Hub chat does: a mid-turn subagent is steered at its next step
boundary, and one between turns starts its next turn. The message is recorded
in the subagent's own transcript; it is not attributed to the parent agent,
and the parent sees only the subagent's eventual result. Isolated (worktree)
subagents run in-process and are steered the same way.

```json
{ "id": "req_1", "type": "steer_subagent", "subagentId": "OmpWorker", "message": "Drop the glob, keep the direct path." }
{ "id": "req_1", "type": "response", "command": "steer_subagent", "success": true }
```

The response arrives once the message is accepted: queued into the running
turn, or the subagent's new turn started. It does not wait for the turn to
finish. Like `prompt`, the command starts in queue order but waits for
acceptance in the background, so later commands (including `abort`) are not
held behind it. As in Agent Hub chat (not RPC `steer`), the message goes
through the subagent's `prompt()`: extension, custom and file slash commands
run and prompt templates expand.

Failure responses:

- missing/empty `subagentId` or blank `message` → validation error
- `subagentId` not currently listed as running by `get_subagents` (unknown,
  finished, already cancelled, another session's agent, or one whose result
  the parent already accepted) → `error: "Subagent not running: <id>"`
- the subagent drops or rejects the message before accepting it (for example
  an abort or a usage-limit preflight denial lands first) →
  `error: "Subagent refused the message: <reason>"`

## Prompt/Queue Concurrency and Ordering

Ordinary commands run on a serialized queue. Extension UI responses and host
tool/URI updates/results bypass that queue, so they can complete a request
while its command handler is waiting. `bash` also bypasses the serial queue and
is tracked as background command work; its response may arrive out of order.
`prompt` and `steer_subagent` start in queue order but await admission in the
background, so their responses may also arrive after later commands'.

### Immediate ack vs completion

Ordinary `prompt` requests are **acknowledged without waiting for the agent run**;
`abort_and_prompt` first waits for the abort. Builtin slash-command handlers and
skill-file loading can delay acknowledgement:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- a prompt completes via `data.agentInvoked: false` on its response or via its own `prompt_result`
- a run completes on an `agent_end` frame where `isTerminal !== false`; that frame carries no prompt identity, so correlate prompts through `prompt_result`
- native `input` handlers run once, in submission order, before command, skill, or queue dispatch. Later input waits until the earlier submission is admitted, including an idle skill's vision description, and does not wait for its model turn. An `abort` cancels input received before it that is not yet admitted, even if that input is still in a hook. A successful `new_session`, `switch_session`, `branch` or `open_session` does the same for input received before it; a vetoed one cancels nothing, and input sent after the session change runs in the new session.
- the session is done only at `session_settled`: background jobs can wake the agent after it yields

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

Providers supporting live steering may consume queued steering during the
streaming response; otherwise it is delivered at a turn/tool-batch boundary.
`follow_up` waits until the agent would otherwise stop.

### Queue defaults

From `packages/coding-agent/src/modes/settings.ts` (also the core `Agent` defaults):

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

CLI settings can change these initial values. `set_steering_mode`,
`set_follow_up_mode`, and `set_interrupt_mode` affect the calling session only;
they do not write global `config.yml`. `set_auto_compaction` and
`set_auto_retry` likewise use session-scoped settings overrides.

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one delivery group per queue drain, keeping hidden companions with their user message
  - `"all"`: dequeue the entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: queued steering raises a cooperative signal for foreground tools, allowing auto-backgroundable work to step aside; it does not hard-kill or skip non-interruptible tools
  - `"wait"`: omit that cooperative steering signal and let side-effecting work finish before injecting steering at the tool-batch boundary
  - In both modes, interruptible waits are cancelled or skipped when steering arrives. This setting is not equivalent to `abort`.

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames. `--no-ui` disables the extension runner's UI in both RPC modes: extensions see `ctx.hasUI === false`, dialogs resolve to their defaults without emitting frames, and presentation updates (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are dropped.

`--mode rpc-ui` independently enables the tool UI context, including with `--no-ui`:

- `ask` still sends `select` requests. Free-text answers use `editor` with `promptStyle: true`; `ask` does not send `input` requests. Dialog cancellation can send `cancel`.
- Other callers using the tool UI context retain its supported dialog methods (`select`, `confirm`, `input`, `editor`, and cancellation) and presentation methods (`notify`, `setStatus`, string-array `setWidget`, `set_editor_text`, and opt-in `setTitle`). `--no-ui` is not a transport-level filter on these methods.
- Tool approval prompts use the extension runner, not the tool UI context. Under `--no-ui`, tools requiring approval fail closed with a no-interactive-UI error rather than sending an approval dialog, just as with `--mode rpc --no-ui`.
- MCP authentication challenges do not gain an RPC UI handler in either mode; the interactive-mode MCP auth handler is not installed.
- A host-issued `login` is independent of both UI settings: it can emit `open_url`, progress `notify`, and non-secret `input` requests after the authorization URL. Secret input and prompts before an authorization URL remain unsupported.

Use `--mode rpc --no-ui` for a host without a tool UI surface; use `--mode rpc-ui --no-ui` to answer tool dialogs while keeping extensions headless. Plain `--mode rpc-ui` enables both extension and tool UI.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `ask`, `cancel`
  - `select` keeps labels in `options: string[]` and, when any option has a
    description, emits a positionally aligned
    `optionDetails: Array<{ description?: string }>` array. Hosts that do not
    render descriptions can continue using `options` alone.
  - `ask` is emitted only after `set_ask_dialog` enables it. It carries every
    question of one ask call:
    `questions: Array<{ id: string, question: string, header?: string, options: Array<{ label: string, description?: string, preview?: string }>, multi?: boolean, recommended?: number }>`
    plus `timeout?: number`. `options` never include an "Other" entry; hosts
    always offer free text.
  - A tool-approval `select` (`options: ["Approve", "Deny"]`) also carries
    `approval: { toolCallId, toolName, arguments, reason? }` (capability
    `tool-approval-binding/1`): the native call id and the arguments the
    approval policy evaluated. Eval prelude approvals use the enclosing eval
    call's id; `(toolCallId, toolName)` identifies the decision. An interrupt
    cancels the pending dialog and a late answer never runs the aborted call.
    Under protocol v1, elided arguments are not exact; negotiate v2 to review them.
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows): includes `url`, optional `launchUrl`, and optional `instructions`. When present, `launchUrl` is a short loopback redirect and is the recommended copy target so terminal truncation cannot corrupt OAuth query parameters.

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `PI_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`
- `{ type: "extension_ui_response", id: string, answers: Array<{ id: string, selectedOptions: string[], customInput?: string }> }` (answers an `ask` request)
- With `rich-ask/2` opt-in, each answer may also include `customInputImages?: ImageContent[]`, `note?: string`, `noteImages?: ImageContent[]`; alternatively `{type:"extension_ui_response", id, chat:true}` redirects to chat.

`select` and `input` resolve to `undefined`, and `confirm` to `false`, on
cancellation, timeout, or signal abort. Signal abort emits a `cancel` request
with `targetId`. `editor` supports cancellation and signal abort but has no wire timeout.
Presentation methods and `open_url` are fire-and-forget and require no response.

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires, and emits
`{ method: "cancel", targetId }` so the host closes the dialog; a later answer to it is ignored. For `ask`, a timeout
(omp's timer or a host `cancelled: true, timedOut: true` reply) answers every question with its recommended
option, else its first.

`answers` must list one entry per question in request order, with each `id` equal to that question's `id`.
`selectedOptions` holds exact option labels without duplicates; a multi-select may be empty. A single-select
(`multi` absent or false) takes at most one option and not both an option and `customInput`. `customInput`
is trimmed and ignored when empty. Any other shape fails the `ask` tool call instead of guessing.

```json
{
  "type": "extension_ui_request",
  "id": "ui_9",
  "method": "ask",
  "questions": [
    { "id": "db", "question": "Which database?", "options": [{ "label": "Postgres" }, { "label": "SQLite" }], "recommended": 1 },
    { "id": "features", "question": "Which features?", "options": [{ "label": "Auth" }, { "label": "Billing" }, { "label": "Search" }], "multi": true }
  ]
}
```

```json
{
  "type": "extension_ui_response",
  "id": "ui_9",
  "answers": [
    { "id": "db", "selectedOptions": [], "customInput": "DuckDB" },
    { "id": "features", "selectedOptions": ["Auth", "Search"] }
  ]
}
```

#### Rich ask extension (`rich-ask/2`)

Only `--mode rpc-ui` advertises this capability. Send `{type:"set_ask_dialog", enabled:true, rich:true}`; success returns `data:{enabled:true, rich:true}`. Omitted/false `rich` preserves upstream behaviour; disabling the dialog returns `rich:false` when requested. An engine without this extension ignores `rich` and omits it in the response.

For negotiated rich dialogs only, the upstream `method:"ask"` request also carries `acceptImages:boolean`. When true, answers may attach `customInputImages` and `noteImages`; otherwise any images are malformed. Images must carry base64 non-SVG `image/*` data. `note` is a string. The chat redirect is `{type:"extension_ui_response", id, chat:true}`. Answers retain upstream ordering, offered-label and single-choice rules. Malformed answers or extras throw and fail the tool call rather than guessing or treating the response as cancellation. Timeouts retain upstream recommended/first fallback and cancellation frame.

Terminal-only UI features are unsupported: component factories, custom
headers/footers/editors, raw terminal input, autocomplete composition, theme
switching, and tool expansion. `getEditorText()` returns `""`;
`pasteToEditor()` falls back to `set_editor_text`.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement text.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.
- Send `content` for successful reads; the current bridge treats an omitted
  value as an empty string. `contentType` defaults to `text/plain` and its
  declared values are `"text/plain"`, `"text/markdown"`, or `"application/json"`.
  A result-level `immutable` overrides the registered scheme's value for that read.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses and valid host-tool/host-URI updates/results with unknown `id` are ignored. These side-channel frames do not receive command response frames.
- Normal termination occurs on stdin close, extension-triggered shutdown, or a passed `quiesce_and_exit`. Output/spool failures and unrecovered session-persistence failures are fatal.
- Session-persistence errors emit an unfiltered `{ type: "notice", level: "error", message, source: "session-persistence" }` frame and a stderr mirror. A recovered failure can still shut down normally; a failure still latched during disposal exits with code `1` after draining stdout.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (simplified; message contents omitted):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "messageId": "msg-2", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true, "yielded": true }
{ "type": "prompt_result", "id": "req_1", "agentInvoked": true, "status": "completed", "sessionSettled": true }
{ "type": "session_settled" }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Client libraries

### TypeScript helper

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc` by default (`cliPath` defaults to `dist/cli.js`). A `command` argv prefix receives generated agent arguments; a command builder returns complete argv. A custom `spawn` transport takes precedence.
- Correlates responses by generated `req_<n>` ids, negotiates v2, reassembles chunks, and pages message history
- Dispatches recognized core `AgentEvent` types through `onEvent()` and recognized session events through `onSessionEvent()`; the raw server stream can include additional event types
- Exposes `onPromptResult()`, `onSessionSettled()`, command-availability and subagent listeners, plus extension UI requests
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- `promptAndWait()` waits for that prompt's result (or synchronous local completion); `waitForSettled()` also waits for session quiescence. `waitForIdle()` and `collectEvents()` stop at the next `agent_end`, including a non-terminal one, and are not settle barriers.
- Wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`; use raw protocol frames for unwrapped surfaces such as host-URI registration or delta-only message updates.

### Python package

The bundled [`omp-rpc`](../python/omp-rpc/pyproject.toml) distribution provides the process-backed Python client. Its import package is `omp_rpc`; the package API, typed commands and events, host-tool/host-URI helpers, and orchestration examples are maintained in the [`omp-rpc` README](../python/omp-rpc/README.md).

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default, `RpcClient` starts `omp --mode rpc`; pass `command=[...]` to own the exact child command. It handles request correlation, typed notifications, v2 negotiation and chunk reassembly, message pagination, extension UI, and host-owned tools and URI schemes. The Python package owns that client API and process lifecycle; this document and `rpc-types.ts` remain the canonical wire contract. Use raw protocol frames when a client library does not wrap the surface you need.
