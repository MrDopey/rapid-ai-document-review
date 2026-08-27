# Contract: WebSocket Event Stream

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Related**: [http-api.md](./http-api.md), [agent-tools.md](./agent-tools.md), [data-model.md](../data-model.md)

Endpoint: `GET /events` (WebSocket upgrade). One socket carries all document and conversation
activity. The backend is the only sender of state; the client sends nothing but the opening
handshake and heartbeats. This is the mechanism behind FR-037 (work survives disconnection) and
SC-006 (fully caught-up within 5 s of reconnect).

Payload shapes are defined once in `packages/shared/src/contracts/events.ts` as a discriminated Zod
union on `type`, so both sides share one definition.

---

## Frame envelope

Every server→client frame:

```json
{
  "type": "staged_edit_created",
  "sequence": 413,
  "documentId": "doc_...",
  "conversationId": "conv_intro",
  "at": "2026-08-25T04:12:09.221Z",
  "data": { }
}
```

`sequence` is monotonic and gapless **per document** across all conversations (see
[data-model.md §7](../data-model.md)). A single ordering is what makes "replay everything after N"
correct — the client never has to reconcile several per-conversation cursors.

**Ephemeral frames** (`text_delta`, `thinking_delta`, `tool_output_delta`) carry `"sequence": null`.
They are broadcast live and never persisted; a reconnecting client receives the *completed* message
instead of a token replay. Clients must therefore treat deltas as presentation-only and the
corresponding `message_completed` frame as the durable truth.

---

## Handshake and replay

**Client → server, first frame after connect:**

```json
{ "type": "subscribe", "sinceSequence": 412 }
```

`sinceSequence` comes from the `eventSequence` field of `GET /api/document`, or from the last
`sequence` the client saw. `null` requests no replay (fresh client that will fetch state over HTTP).

**Server → client, immediately:**

```json
{
  "type": "subscribed",
  "sequence": null,
  "currentSequence": 460,
  "replayCount": 48,
  "snapshot": {
    "document": { "id": "doc_...", "currentRevision": 21, "content": "…" },
    "conversations": [ "…as in GET /api/conversations…" ]
  }
}
```

The server sends a full snapshot **and then** replays events `413..460` in order. A snapshot plus
replay is deliberately redundant: it makes catch-up correct even when the requested
`sinceSequence` is older than retained events, and it means a reconnecting client never has to
reason about which of the two sources is newer — later events simply overwrite earlier snapshot
state. This satisfies FR-037's requirement to see "anything produced while disconnected", including
agent runs that completed during the gap.

If `sinceSequence` is ahead of `currentSequence` (a client that reconnected to a restarted backend
with a fresh database), the server responds with `"replayCount": 0` and the client accepts the
snapshot as authoritative.

**Heartbeat**: client sends `{ "type": "ping" }` every 15 s; server replies `{ "type": "pong" }`.
A missed heartbeat is a *client-side* reconnect trigger only. The backend never interprets a dropped
socket as an agent or tool-call failure (Constitution Quality Gate, FR-037) — sockets closing is
routine and affects nothing but delivery.

---

## Event vocabulary

The `type` values below are the closed vocabulary. The same strings are used as the pino `event`
field (FR-042) and as `conversation_event.event_type`, so logs, the persisted stream and the socket
share one taxonomy rather than three.

### Document events (`conversationId: null`)

| `type` | `data` | Requirement |
| --- | --- | --- |
| `document_created` | `{ documentId, title, revision, content }` | FR-001 |
| `document_content_changed` | `{ changes: [{ from, to, insert }], currentRevision, originConversationId \| null }` | FR-003 — broadcast so every connected view stays in sync; `originConversationId` set when an agent edit caused it |
| `revision_created` | `{ revision, source, origin, conversationId, note, restoredFrom }` | FR-004, FR-005 |
| `revision_restored` | `{ revision, restoredFrom, content }` | FR-006 |
| `settings_changed` | `{ thinkingVisible, revisionDebounceMs, maxConcurrentAgents, maxEditingDepth, maxConversationDepth, maxReplacementAttempts }` | FR-041 |

`document_content_changed` is persisted; the client applies `changes` to its editor. A client whose
local state has diverged (detected by a content hash mismatch in the frame) refetches
`GET /api/document` rather than attempting a repair — the backend is authoritative and resync is
always safe (Principle I). The hash is SHA-256 over the full post-change document content string,
included as `data.contentHash`; the client compares it to a hash of its own current content and
refetches on any mismatch rather than attempting to diagnose the divergence.

### Conversation lifecycle

| `type` | `data` | Requirement |
| --- | --- | --- |
| `conversation_started` | `{ conversationId, name, kind, parentId, branchDepth, contextRevision, seedSelection }` | FR-011, FR-012, FR-013 |
| `conversation_status_changed` | `{ status, previousStatus }` | FR-014 |
| `conversation_context_refreshed` | `{ contextRevision, previousContextRevision, includedStagedEditIds }` | FR-018 |
| `conversation_stale` | `{ contextRevision, currentRevision }` | FR-016 — emitted when the document advances past a conversation's context |
| `conversation_closed` | `{ closedAt, summaryFoldedIntoParent, parentConversationId }` | FR-033, FR-034 |
| `conversation_summary_folded` | `{ parentConversationId, summary }` | FR-034 |
| `primary_changed` | `{ primaryConversationId, previousPrimaryId, applied, previousPrimaryStillWorking }` | FR-027, FR-027a, FR-028, FR-029, FR-030 — `primaryConversationId` is `null` when the user deselected Primary or closed the conversation holding it; clients must render "no Primary" rather than retaining the previous one |
| `agent_error` | `{ message, retryable }` | FR-038 |

`conversation_stale` is a convenience signal — staleness is derivable from
`contextRevision < currentRevision`, but emitting it explicitly means the HUD updates without
recomputing across every conversation on each document change.

### Agent run and streaming

| `type` | `data` | Persisted | Requirement |
| --- | --- | --- | --- |
| `agent_started` | `{ turnId }` | yes | FR-010 |
| `agent_queued` | `{ queuePosition, runningCount, limit }` | yes | FR-015 — a prompt beyond the concurrency limit is queued, never rejected; re-emitted with an updated `queuePosition` whenever it changes before the prompt starts (FR-015a) |
| `agent_dequeued` | `{ turnId }` | yes | FR-015 |
| `message_started` | `{ messageId, role }` | yes | FR-010 |
| `text_delta` | `{ messageId, delta }` | **no** | FR-010 |
| `thinking_delta` | `{ messageId, delta }` | **no** | FR-010, FR-041 |
| `message_completed` | `{ messageId, role, text, reasoning }` | yes | FR-010 |
| `tool_started` | `{ toolCallId, toolName }` | yes | design §24 |
| `tool_output_delta` | `{ toolCallId, delta }` | **no** | design §24 |
| `tool_completed` | `{ toolCallId, toolName, isError, stagedEditId }` | yes | design §24, FR-019 |
| `agent_completed` | `{ turnId }` | yes | FR-010 |

`thinking_delta` and the `reasoning` field of `message_completed` are emitted only while
`thinkingVisible` is enabled (FR-010, FR-041). Toggling the setting affects subsequent streaming, not
already-delivered frames. Reasoning content passes the sanitizer before rendering, exactly like
document Markdown (Principle VI, design §25).

The live-response buffer (FR-037a) records exactly what was emitted at generation time: if
`thinkingVisible` was `true` when a `thinking_delta` was produced, it is buffered and replayed to a
reconnecting client regardless of the setting's value at reconnect time; if it was `false` at
emission, no thinking content exists to buffer. Toggling the setting mid-stream affects only deltas
emitted after the toggle, not what a reconnect replays for deltas already produced.

`tool_completed` carries `stagedEditId` when the tool was `propose_document_edit`, letting the client
correlate a tool call with the proposal it produced without a second fetch.

### Proposed edits

| `type` | `data` | Requirement |
| --- | --- | --- |
| `staged_edit_created` | `{ stagedEditId, piToolCallId, summary, sourceRevision, operationCount, supersedesId }` | FR-019, FR-021 |
| `staged_edit_applied` | `{ stagedEditId, revision, autoApplied }` | FR-025, FR-027 |
| `staged_edit_dropped` | `{ stagedEditId }` | FR-023 |
| `staged_edit_superseded` | `{ stagedEditId, conflictDetail, replacementRequested, replacementAttempt, attemptsRemaining }` | FR-032, FR-032a |
| `staged_edit_replacement_created` | `{ stagedEditId, supersedesId, summary, replacementAttempt }` | FR-032, FR-032a |
| `staged_edit_replacement_exhausted` | `{ stagedEditId, originalStagedEditId, attempts, conflictDetail }` | FR-032b — the chain's replacement budget is spent; no further replacement is requested and the document is unchanged |

`staged_edit_superseded` carries `replacementRequested: false` exactly when
`staged_edit_replacement_exhausted` follows for the same chain — the two together are the terminal
state a client renders as "the agent could not produce an applicable edit" (FR-032b). Because
`maxReplacementAttempts` may be `0`, that pairing can occur on the very first conflict.

`staged_edit_applied` with `autoApplied: true` is the Primary path (FR-027): the client sees the
document change and a new revision with no pending proposal left behind. With `autoApplied: false` it
is a user-accepted proposal (FR-025). The distinction matters to the UI and to SC-004's audit claim
that nothing is applied silently — even the Primary path emits a `staged_edit_created` frame first.

---

## Ordering guarantees

1. Frames for one document arrive in strictly increasing `sequence` order on a single socket.
2. A `staged_edit_created` frame always precedes any `staged_edit_applied` / `_dropped` /
   `_superseded` frame for the same `stagedEditId` — including on the Primary auto-apply path, so a
   client never sees a verdict for a proposal it has not seen created.
3. `document_content_changed` precedes the `revision_created` frame it belongs to.
4. `staged_edit_applied` precedes the `document_content_changed` and `revision_created` frames it
   causes, so a client can attribute the change before it observes it.
5. `message_started` … deltas … `message_completed` are ordered per `messageId`, but messages from
   different conversations interleave freely — that is the intended concurrency (FR-015).
6. Ephemeral deltas may be dropped under backpressure; persisted frames never are. Backpressure is
   defined as the socket's underlying write buffer (`bufferedAmount`) exceeding 1MB; while above that
   threshold, only ephemeral frame types are dropped, until the buffer drains back below it.
7. `staged_edit_superseded` always precedes the `staged_edit_replacement_created` frame for the
   replacement it produces, and precedes `staged_edit_replacement_exhausted` when no replacement
   follows (FR-032).
8. `agent_started` always precedes any `staged_edit_created` frame produced by a tool call within
   that same run — a proposal can never appear before the run that created it is announced as
   started.

---

## Contract test expectations

1. Every `type` validates against the shared Zod union; an unknown `type` is rejected, not ignored.
2. Reconnect with `sinceSequence` set replays exactly the missing persisted frames, in order, with no
   gap and no duplicate (FR-037).
3. Reconnect with a `sinceSequence` older than retained events still converges via the snapshot.
4. An agent run started while the socket is closed is fully represented after reconnect — proving the
   run continued and its results are recoverable (FR-037, SC-006).
4a. Reconnecting *mid-run* replays the partial response text produced so far from the live run buffer,
   before any subsequent delta — so a client that connects halfway through a response is not left
   blank until `message_completed` (FR-037a, SC-006). The buffer is per active run and in-memory only;
   it is not a `conversation_event` row and does not survive a restart, which is the FR-039a case.
5. Ephemeral delta frames never appear in `conversation_event` rows.
6. `thinking_delta` is absent when `thinkingVisible` is `false` and present when `true` (FR-041).
7. Ordering guarantees 2–4 and 7–8 asserted explicitly, including the Primary auto-apply path.
8. Two simultaneously connected clients both receive `document_content_changed` for a manual edit made
   by the other (FR-003).
