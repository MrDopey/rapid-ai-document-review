# Contract: HTTP API

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Related**: [websocket-events.md](./websocket-events.md), [agent-tools.md](./agent-tools.md), [data-model.md](../data-model.md)

Application-level operations only — no endpoint exposes SQLite rows or Pi internals
(Constitution Principles I and II). Base path `/api`. All bodies are JSON. Request and response
shapes are defined once as Zod schemas in `packages/shared/src/contracts/http.ts` and used both for
Fastify route validation and for the typed frontend client.

No authentication: the service binds to `127.0.0.1` only and a single local user is assumed
(spec Assumptions). Binding to another interface is an unsupported configuration.

---

## Shared types

### `ConflictDetail`

The `conflictDetail` object is defined once in `packages/shared/src/contracts/http.ts` and is the
**canonical definition** for all three contracts (HTTP, WebSocket, agent tools). Any location in
this document or in `websocket-events.md` or `agent-tools.md` that references `conflictDetail` uses
this type — it is never independently defined per-contract.

```ts
// packages/shared/src/contracts/http.ts
ConflictDetail = z.object({
  operations: z.array(z.object({
    index: z.number().int(),
    reason: z.enum(["not_found", "ambiguous", "overlapping"]),
    occurrences: z.number().int(),
  }))
})
```

---

## Conventions

**Error envelope** — every non-2xx response:

```json
{
  "error": {
    "code": "MAX_CONVERSATION_DEPTH_EXCEEDED",
    "message": "Cannot branch beyond conversation depth 3.",
    "details": { "limit": 3, "attemptedDepth": 4 }
  }
}
```

Errors are explanatory rather than silent, as the spec's edge cases require. Codes:

| Code | Status | Raised by |
| --- | --- | --- |
| `DOCUMENT_NOT_FOUND` | 404 | any document-scoped call before creation |
| `DOCUMENT_ALREADY_EXISTS` | 409 | `POST /document` when one exists (FR-001) |
| `CONVERSATION_NOT_FOUND` | 404 | unknown conversation id |
| `MAX_CONVERSATION_DEPTH_EXCEEDED` | 409 | `POST /conversations` (FR-013) |
| `MAX_EDITING_DEPTH_EXCEEDED` | 409 | apply / refresh-send from too deep a conversation (FR-026) |
| `CONVERSATION_CLOSED` | 409 | send / branch / primary on a closed conversation (FR-035) |
| `PENDING_EDITS_BLOCK_CLOSE` | 409 | `POST /conversations/:id/close` (FR-033) |
| `PRIMARY_TARGET_BUSY` | 409 | `POST /conversations/:id/primary` without a `whenBusy` choice (FR-029) |
| `EDIT_NOT_PENDING` | 409 | verdict on an already-resolved proposal |
| `EDIT_CONFLICT` | 200 | *not an error* — see `POST /edits/:id/apply` |
| `VALIDATION_FAILED` | 400 | Zod rejection |
| `AGENT_UNAVAILABLE` | 502 | Pi/model call failed (FR-038) |

**Long-running operations**: `send`, `refresh-send`, `apply` (conflict path) and `close` (with a
merge summary) return as soon as the operation is *accepted*. All progress and completion arrive over
the WebSocket event stream — the HTTP response never blocks on an agent (FR-037: a dropped HTTP
connection must not affect agent work).

**Pagination**: `GET /api/conversations` and `GET /api/revisions` are cursor-paginated, since both
collections are never deleted and grow without bound (FR-005, FR-006). Both accept
`?cursor=<opaque>&limit=<1-100, default 50>` and return a top-level `"nextCursor": string | null`
alongside their array. `GET /api/revisions` orders newest-first; `GET /api/conversations` orders by
`createdAt` ascending (stable creation order, so a client paging through never sees a conversation
move between pages). Omitting `cursor` starts from the first page.

**Error `message` strings**: plain UI-safe text, no markup, capped at 500 characters. They are
authored by the backend (not agent output) but are still passed through the same sanitizer as any
other displayed text before rendering, as a defensive measure (FR-008a).

---

## Document

### `POST /api/document`

Create the document from pasted or typed Markdown, initialise its Automerge state, and create the
Main conversation (FR-001, FR-009). Idempotent-by-refusal: 409 if a document already exists, since v1
has no replace workflow.

**Request**
```json
{ "title": "Quarterly Strategy", "content": "# Quarterly Strategy\n\n..." }
```
`title` optional (defaults to first heading, else `"Untitled"`). `content` required, non-empty.

**Response `201`**
```json
{
  "document": { "id": "doc_...", "title": "Quarterly Strategy", "currentRevision": 1,
                "createdAt": "...", "updatedAt": "..." },
  "content": "# Quarterly Strategy\n\n...",
  "mainConversation": { "id": "conv_...", "name": "Main", "kind": "main", "status": "idle",
                        "isPrimary": true, "contextRevision": 1, "branchDepth": 0,
                        "pendingEditCount": 0 }
}
```

### `GET /api/document`

Current document plus live Markdown content. `404` before creation — the frontend uses this to decide
whether to show the paste screen.

**Response `200`**
```json
{
  "document": { "id": "doc_...", "title": "...", "currentRevision": 17,
                "createdAt": "...", "updatedAt": "..." },
  "content": "…current Markdown…",
  "eventSequence": 412
}
```
`eventSequence` is the latest event sequence at read time, so a client can open the socket and
request replay from exactly there without a gap (FR-037).

### `PATCH /api/document`

Apply manual edits as CodeMirror-shaped change specs (FR-002, FR-003). The backend replays them as
`Automerge.splice` calls against the authoritative document and broadcasts the result. This is the
only client→document write path, and it accepts *intent* (offset ranges), never document text — the
frontend never becomes authoritative (Principle I).

**Request**
```json
{
  "baseRevision": 17,
  "changes": [ { "from": 120, "to": 135, "insert": "restructured opening" } ]
}
```
`baseRevision` is advisory: it is logged and used to detect a badly out-of-sync client, but it does
not gate the write — Automerge merges concurrent manual edits by design. "Badly out-of-sync" is
`currentRevision - baseRevision > 50`; crossing that threshold only emits a `warn`-level log line
(FR-042) — the write still proceeds normally.

**Response `200`**
```json
{ "currentRevision": 17, "revisionCreated": false }
```
`revisionCreated` is `true` only when this call happened to flush a pending debounce window;
ordinarily manual edits do not create a revision until `revision_debounce_ms` of inactivity (FR-004).

### `GET /api/document/export`

Export Markdown for copy or download (FR-007a).

| Query | Meaning |
| --- | --- |
| *(none)* | current live content |
| `?revision=12` | the Markdown of revision 12, materialised from its stored Automerge `heads` |
| `&download=1` | adds `Content-Disposition: attachment` |

**Response `200`**: `text/markdown` body. `404 DOCUMENT_NOT_FOUND` if no document has been created
yet — this endpoint follows the same before-creation convention as every other document-scoped call.
`404` if a requested `?revision=` does not exist.

---

## Revisions

### `GET /api/revisions`

Revision history, newest first, with attribution (FR-005, SC-008).

**Response `200`**
```json
{
  "revisions": [
    { "revision": 23, "source": "agent", "origin": "agent_edit",
      "conversationId": "conv_intro", "conversationName": "Review: Introduction",
      "stagedEditId": "edit_...", "note": "Applied edit from \"Review: Introduction\"",
      "createdAt": "..." },
    { "revision": 22, "source": "user", "origin": "manual_debounce",
      "conversationId": null, "note": null, "createdAt": "..." },
    { "revision": 21, "source": "user", "origin": "restore",
      "restoredFrom": 18, "note": "Restored v18", "createdAt": "..." }
  ]
}
```
Every entry answers "user or which agent?" without inference — `source` plus `conversationName` is
always sufficient. Each entry also carries `"autoApplied": boolean` (`true` only for a Primary
auto-applied edit), so a user inspecting history can confirm the Primary path (SC-004, SC-008)
without consulting the event stream.

### `POST /api/revisions/:revision/restore`

Restore an earlier revision as a **new** forward revision; nothing in between is deleted
(FR-006, Principle IV).

Before applying the restore, the server performs a **dry-run reconciliation** of all pending
proposals against the would-be restored content. The response includes per-proposal reconciliation
results so the client can present the user with a confirmation step before the restore commits.
The restore itself does not alter proposal status — proposals remain `pending` after the restore
and the user decides individually whether to keep, apply, or drop each one based on the dry-run
results. If there are no pending proposals, no confirmation step is required.

**Response `200`**
```json
{
  "currentRevision": 24,
  "restoredFrom": 18,
  "content": "…",
  "pendingProposalReconciliation": [
    { "stagedEditId": "edit_1", "reconcilable": true },
    { "stagedEditId": "edit_2", "reconcilable": false,
      "conflictDetail": { "operations": [ { "index": 0, "reason": "not_found", "occurrences": 0 } ] } }
  ]
}
```
`pendingProposalReconciliation` is omitted when there are no pending proposals. `reconcilable:
false` means the proposal's anchors no longer resolve against the restored content; the user should
drop it or wait for a replacement. The dry-run does not apply or supersede any proposal — it is
read-only preview only.

---

## Conversations

### `GET /api/conversations`

Everything the conversation HUD needs (FR-014, design §31), including closed conversations
(FR-035).

**Response `200`**
```json
{
  "currentRevision": 21,
  "conversations": [
    { "id": "conv_main", "name": "Main", "kind": "main", "parentId": null, "branchDepth": 0,
      "status": "working", "isPrimary": true, "contextRevision": 21, "isStale": false,
      "pendingEditCount": 0, "canEdit": true, "canBranch": true, "errorMessage": null,
      "createdAt": "...", "closedAt": null },
    { "id": "conv_intro", "name": "Review: Introduction", "kind": "branch",
      "parentId": "conv_main", "branchDepth": 1,
      "status": "idle", "isPrimary": false, "contextRevision": 17, "isStale": true,
      "pendingEditCount": 3, "canEdit": true, "canBranch": true, "errorMessage": null,
      "createdAt": "...", "closedAt": null }
  ]
}
```
`isStale` (`contextRevision < currentRevision`, FR-016), `canEdit` (within `max_editing_depth`,
FR-026) and `canBranch` (within `max_conversation_depth` and not closed, FR-013) are computed
server-side so the UI cannot disagree with the enforcement (Principle V).

### `POST /api/conversations`

Start a conversation branched from a document selection (FR-011) or from another conversation
(FR-013). The child is seeded from the parent's Pi session and given the selected text plus
surrounding context (FR-012).

**Request**
```json
{
  "parentConversationId": "conv_main",
  "name": "Review: Introduction",
  "selection": { "from": 42, "to": 318 }
}
```
`selection` omitted → a plain branch from the parent with no seeded excerpt. `name` optional
(server generates one from the selection's first heading or leading words).

**Response `201`**: the same conversation object shape as `GET /api/conversations`.

**Errors**: `MAX_CONVERSATION_DEPTH_EXCEEDED` (409) when `parent.branchDepth + 1` exceeds the limit;
`CONVERSATION_CLOSED` (409) when branching from a closed conversation.

### `GET /api/conversations/:id`

Full detail for one conversation: metadata, message history (rendered from Pi via the SDK), and its
proposals. Works for closed conversations, which return `"readOnly": true` (FR-035).

**Response `200`**
```json
{
  "conversation": { "…as in list…": null, "readOnly": false },
  "messages": [
    { "id": "msg_1", "role": "user", "text": "Tighten the introduction.", "createdAt": "..." },
    { "id": "msg_2", "role": "assistant", "text": "I'd suggest…",
      "reasoning": "…", "toolCalls": [ { "toolCallId": "toolu_...", "name": "propose_document_edit",
                                         "stagedEditId": "edit_..." } ], "createdAt": "..." }
  ],
  "stagedEdits": [ "…as in GET /conversations/:id/edits…" ]
}
```
`reasoning` is present only when `thinking_visible` is enabled (FR-010, FR-041).

### `POST /api/conversations/:id/send`

Send a message using the conversation's existing context as-is, even when stale (FR-017).

**Request**: `{ "message": "Tighten the introduction." }`

**Response `202`**: `{ "accepted": true, "queued": false, "contextRevision": 17 }`

`queued: true` means `max_concurrent_agents` was already reached and the prompt was queued rather
than rejected (FR-015, edge case). `queued: true` guarantees exactly one `agent_queued` event follows
for this request; `queued: false` guarantees no `agent_queued` event follows and `agent_started`
comes directly. Queue position and start are reported as events; if the prompt's position changes
before it starts (an earlier entry is dequeued out of order), `agent_queued` is re-emitted with the
updated `queuePosition` (FR-015a).

**Errors**: `CONVERSATION_CLOSED` (409); `AGENT_UNAVAILABLE` (502) if the model call fails
immediately — the conversation is also marked `errored` and the failure is retryable (FR-038).

### `POST /api/conversations/:id/refresh-send`

Refresh the conversation's context to the current document revision — including proposals relevant to
that conversation — then send (FR-018).

**Request**: `{ "message": "Now check the conclusion." }`

**Response `202`**
```json
{ "accepted": true, "queued": false,
  "contextRevision": 21, "previousContextRevision": 17, "includedStagedEditIds": ["edit_..."] }
```

**Errors**: `MAX_EDITING_DEPTH_EXCEEDED` (409) — refresh participates in the edit workflow, so it is
blocked beyond the editing depth even though the conversation may still chat normally (FR-026, edge
case).

### `POST /api/conversations/:id/retry`

Retry after a failure, clearing `errored` status (FR-038). Re-sends the run that failed against the
conversation's preserved history up to that point; it does not restart the conversation from scratch,
and cannot double-apply an edit the failed run had already proposed (FR-040).

**Response `202`**: `{ "accepted": true, "status": "working" }`

**Errors**: `409 CONVERSATION_NOT_ERRORED` if called on a conversation that is not currently
`errored` — retry is only meaningful as recovery from a failure.

### `POST /api/conversations/:id/primary`

Designate this conversation Primary (FR-028). If the current Primary or the target is actively
working, the caller must state its choice (FR-029).

Primary is optional (FR-027a). `DELETE /api/conversations/:id/primary` clears the designation
without nominating a replacement, responding `200` with
`{ "primaryConversationId": null, "previousPrimaryId": "conv_intro" }`. While no conversation is
Primary, every conversation stages its proposals — the auto-apply path is simply unavailable, not
reassigned. Closing the current Primary has the same effect implicitly (see `/close`).

**Request**
```json
{ "whenBusy": "switch_now" }
```
`whenBusy` ∈ `switch_now` | `cancel` | `switch_when_idle`. Omit it for a first attempt: if nothing
is busy the switch proceeds; if something is busy the call returns `409 PRIMARY_TARGET_BUSY` with
`details` naming what is working, and the client re-calls with an explicit choice. "Busy" means
`status: "working"` at the instant of the request (FR-029) — a conversation with only a queued,
not-yet-started prompt does not count as busy.

Calling this on the conversation that is **already** Primary is a no-op success:
`{ "primaryConversationId": "conv_intro", "applied": "already_primary", "previousPrimaryId":
"conv_intro", "previousPrimaryStillWorking": false }`.

**Response `200`**
```json
{ "primaryConversationId": "conv_intro", "applied": "immediately",
  "previousPrimaryId": "conv_main", "previousPrimaryStillWorking": true }
```
`applied` ∈ `immediately` | `deferred_until_idle` | `already_primary`. Switching never interrupts or
cancels in-flight agent work (FR-030) — a previous Primary that was mid-operation simply stops
auto-applying future edits.

**Deferred switch termination**: a `deferred_until_idle` switch is cancelled without effect, and the
current Primary designation is left unchanged, if before it takes effect: the target conversation
closes; the target conversation becomes `errored`; or the user issues a new `POST /primary` request,
which replaces the pending deferred switch (only one may be pending at a time). Cancellation is not
reported as an error — the client learns of it only by observing that `primary_changed` never
arrives for that request, or by re-querying `GET /api/conversations`.

**Primary switch and tool execution are mutually exclusive.** A Primary designation change
(`switch_now` or the deferred switch becoming effective) waits for any in-flight
`propose_document_edit` execution to complete before the designation atomically changes. Conversely,
a tool execution that begins captures the Primary designation at that instant and holds it for the
life of the call — a concurrent switch request waits. This serialisation ensures that every proposal
routes unambiguously as either auto-apply or stage; no proposal can be mid-flight across a
designation boundary.

**Errors**: `CONVERSATION_CLOSED` (409) — a closed conversation cannot become Primary (FR-035, edge
case).

### `POST /api/conversations/:id/close`

Close a conversation. Refused while any proposal is still `pending` (FR-033). Closing is separate
from the conversation-merge offer (FR-034, design §22).

**Request**: `{ "foldSummaryIntoParent": true }` (optional, default `false`)

**Response `200`**
```json
{ "conversationId": "conv_intro", "status": "closed",
  "summaryFoldedIntoParent": true, "parentConversationId": "conv_main" }
```
When `foldSummaryIntoParent` is `true`, a compact summary and structured metadata are generated and
delivered to the parent conversation; the child's raw message history is not copied.

**Errors**: `PENDING_EDITS_BLOCK_CLOSE` (409) with `details.pendingEditIds`.

### `POST /api/conversations/:id/review`

Request an independent agent review of a closed conversation and its branches, without altering it
(FR-036). Creates a new `kind: "review"` conversation seeded with the closed transcript. A review
conversation counts against `maxConcurrentAgents` like any other agent run, but is exempt from
`maxConversationDepth` and `maxEditingDepth` — it sits outside the branching/editing workflow.

**Response `201`**: the new review conversation object, plus
`{ "reviewedConversationIds": ["conv_intro", "conv_intro_a"] }`.

**Errors**: `409` if the target is not closed.

---

## Proposed edits

### `GET /api/conversations/:id/edits`

All proposals for a conversation, pending and resolved (FR-014, and readable after close).

**Response `200`**
```json
{
  "stagedEdits": [
    { "id": "edit_1", "conversationId": "conv_intro", "piToolCallId": "toolu_...",
      "summary": "Tighten the opening paragraph", "sourceRevision": 17,
      "status": "pending", "autoApplied": false, "operationCount": 2,
      "supersedesId": null, "conflictDetail": null,
      "appliedRevision": null, "createdAt": "...", "resolvedAt": null }
  ]
}
```
Ordered newest-first (`createdAt` descending), matching `GET /api/revisions`.

### `GET /api/edits/:id/preview`

Both views FR-022 requires: the full document as it would read, and the added/removed changes.

**Response `200`**
```json
{
  "stagedEditId": "edit_1",
  "reconcilable": true,
  "fullPreview": "…complete document text with the proposal applied…",
  "hunks": [
    { "operationIndex": 0, "contextBefore": "…", "removed": "The introduction is…",
      "added": "This introduction…", "contextAfter": "…" }
  ],
  "conflictDetail": null
}
```
When `reconcilable` is `false`, `fullPreview` is `null` and `conflictDetail` explains which anchors
failed — the user learns the proposal is stale *before* attempting to apply it.

### `POST /api/edits/:id/apply`

Accept one proposal (FR-023). Reconciles against the current document first (FR-031). A conflict is
a normal outcome, not an HTTP error — it returns `200` describing what happened next (FR-032).

**Response `200` — clean**
```json
{ "outcome": "applied", "stagedEditId": "edit_1", "revision": 22, "content": "…" }
```

**Response `200` — conflict**
```json
{
  "outcome": "conflict",
  "stagedEditId": "edit_1",
  "supersededEditId": "edit_1",
  "conflictDetail": { "operations": [ { "index": 0, "reason": "not_found", "occurrences": 0 } ] },
  "replacementRequested": true,
  "replacementAttempt": 1,
  "attemptsRemaining": 1
}
```
The original is marked `superseded` and the originating agent is asked for a replacement; the
replacement arrives as a new `pending` proposal via the event stream. If that replacement is itself
stale later, it goes through this same path (spec edge case) and draws on the same budget.

**Response `200` — conflict, replacement budget exhausted**
```json
{
  "outcome": "conflict_exhausted",
  "stagedEditId": "edit_1c",
  "supersededEditId": "edit_1c",
  "originalStagedEditId": "edit_1",
  "conflictDetail": { "operations": [ { "index": 0, "reason": "ambiguous", "occurrences": 3 } ] },
  "replacementRequested": false,
  "attempts": 2
}
```
No further replacement is requested (FR-032a). The document is unchanged, the proposal stays
`superseded`, and the client renders this as "the agent could not produce an edit that applies to the
current document" (FR-032b). The conversation remains usable — a fresh user request starts a new
proposal with a full budget. With `maxReplacementAttempts: 0` this is the response to a first
conflict.

Applying an already-`applied` proposal returns `200` with the original result rather than applying
twice (FR-040). Applying a `dropped` or `superseded` one returns `409 EDIT_NOT_PENDING`.

**Errors**: `MAX_EDITING_DEPTH_EXCEEDED` (409).

### `POST /api/edits/:id/drop`

Discard a proposal; the document is unaffected (FR-023).

**Response `200`**: `{ "outcome": "dropped", "stagedEditId": "edit_1" }`

### `POST /api/conversations/:id/edits/accept-remaining`

Apply every unresolved proposal in order (FR-023). Per-proposal outcomes are reported individually —
a conflict on one does not abort the rest.

**Response `200`**
```json
{
  "results": [
    { "stagedEditId": "edit_2", "outcome": "applied", "revision": 23 },
    { "stagedEditId": "edit_3", "outcome": "conflict", "replacementRequested": true }
  ],
  "currentRevision": 23
}
```

### `POST /api/conversations/:id/edits/drop-remaining`

Drop every unresolved proposal (FR-023).

**Response `200`**: `{ "droppedEditIds": ["edit_2", "edit_3"] }`

---

## Settings

### `GET /api/settings`

**Response `200`**
```json
{ "thinkingVisible": false, "revisionDebounceMs": 300000, "maxConcurrentAgents": 3,
  "maxEditingDepth": 2, "maxConversationDepth": 3, "maxReplacementAttempts": 2 }
```

### `PATCH /api/settings`

Update any subset (FR-041). New limits apply to subsequent operations immediately; they never
retroactively invalidate existing conversations — lowering `maxConversationDepth` leaves deeper
conversations alive but no longer branchable. `maxReplacementAttempts` is evaluated when a
replacement is about to be requested, so lowering it can end an in-flight supersession chain at its
next conflict; `0` disables automatic replacement entirely (FR-032a).

**Request**: `{ "thinkingVisible": true, "revisionDebounceMs": 120000 }`

**Valid ranges** (FR-041) — a value outside its range is rejected with `400 VALIDATION_FAILED`,
never clamped:

| Setting | Range |
| --- | --- |
| `revisionDebounceMs` | 10,000 – 3,600,000 (10s – 1h) |
| `maxConcurrentAgents` | 1 – 10 |
| `maxEditingDepth` | 0 – 10 (may legitimately be above or below `maxConversationDepth`) |
| `maxConversationDepth` | 1 – 10 |
| `maxReplacementAttempts` | 0 – 10 |
| `thinkingVisible` | boolean |

**Response `200`**: the full settings object.

---

## Contract test expectations

Every endpoint needs, at minimum:

1. A success case asserting the response validates against its shared Zod schema.
2. The documented error codes, each with the correct status and populated `details`.
3. `GET` endpoints returning server-computed fields (`isStale`, `canEdit`, `canBranch`,
   `pendingEditCount`) verified against a state where each differs from its default.
4. `POST /api/edits/:id/apply` covering all five outcomes: clean, conflict, conflict-with-budget-
   exhausted (including the `maxReplacementAttempts: 0` first-conflict case), already-applied
   (idempotent replay), and not-pending.
5. Every limit-guarded endpoint asserted to reject at the boundary — proving enforcement lives in the
   backend, not the UI (Principle V).
6. `DELETE /api/conversations/:id/primary` while a Primary is set returns `primaryConversationId:
   null`, and a subsequent `GET /api/conversations` shows `isPrimary: false` for every conversation
   including Main — confirming no implicit reassignment (FR-027a).
