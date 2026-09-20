# Phase 1 Data Model: Linear Thread Mode

This feature adds one column to `document`, two columns and two new `kind`/enum values to `conversation`, and introduces no new tables — consistent with FR-015's reuse mandate and research.md R1/R3/R7. Every other existing field on `Document`/`Conversation` (per specs/001, 005, 006, 010) keeps its current meaning.

## Document (existing table, one field added)

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `currentRevision`, `piSessionDir`, `createdAt`, `updatedAt`, `lastActiveAt` | *(unchanged)* | See specs/010/data-model.md. |
| `documentType` | `'canvas' \| 'thread'` (**new**) | Fixed at creation (FR-001, FR-014); `NOT NULL DEFAULT 'canvas'` so every pre-existing document is `'canvas'` after migration (research.md R7). No API or storage method ever changes it post-creation. |

**Validation rules**: `documentType` is set exactly once, at `DocumentService.create()` time, from the create-document request; immutable thereafter.

## Conversation (existing table, reused as "Thread"; two new `kind` values, two new fields)

| Field | Type | Notes |
|---|---|---|
| `id`, `documentId`, `parentId`, `name`, `status`, `errorMessage`, `isPrimary`, `isCurrentMain`, `contextRevision`, `branchDepth`, `createdAt`, `updatedAt`, `closedAt` | *(unchanged)* | See `app/backend/src/storage/storage-adapter.ts`. `isPrimary` is always `false` for thread-kind rows (research.md R6) — no schema change needed to enforce this, just no code path ever sets it `true` for them. |
| `kind` | `ConversationKind` (**extended**: adds `'thread-root'` and `'thread-branch'`) | A threaded-conversation document's single root Thread is `'thread-root'`; every other Thread in that document is `'thread-branch'`. Existing `'main' \| 'branch' \| 'review'` values are untouched and never mixed into a `'thread'`-type document. |
| `piSessionPath` | string (existing) | **Reused with a different cardinality**: every Thread belonging to the same threaded-conversation document shares the identical `piSessionPath` (one file per *document*, not per row — research.md R1), unlike canvas mode where every conversation row has its own distinct path. |
| `piLeafEntryId` | `string \| null` (**new**) | This Thread's own current tip within the shared session file — the entry id `SessionManager.branch()` repositions the leaf to before this Thread accepts its next message (research.md R1). `null` only for a `thread-root` that has not yet received its first message. Not used by `'main' \| 'branch' \| 'review'` rows (always `null` there). |
| `seedSelection` | `SeedSelection \| null` (existing) | **Not used** by thread-kind rows (always `null`) — a thread branch's anchor is message-shaped, not document-offset-shaped (research.md R2); see `anchorMessageId` below instead. |
| `forkedFromMessageId` | string \| null (existing) | **Reused as-is** as the thread branch's anchor: the id of the message (within the parent Thread) whose highlighted passage triggered this branch (FR-005, FR-007). `null` only for `thread-root`. |
| `doneAt` | `string \| null` (**new**) | Non-`null` once a reviewer marks this Thread done (FR-008/FR-009); orthogonal to `status` (research.md R3). `null` = active (shown in the default top-down list); non-`null` = done (hidden from it, still fully readable/branchable/reopenable). |

**New field used only for thread branches**:

| Field | Type | Notes |
|---|---|---|
| `seedExcerptText` | `string \| null` (**new**) | The exact highlighted substring (FR-005a's `<branch-seed-excerpt>`-wrapped seed content), stored alongside `forkedFromMessageId` so the frontend can render the seed banner without re-deriving it from the raw Pi session. `null` for `thread-root` and for every non-thread `kind`. |

**Validation rules**:
- `kind: 'thread-root'` MUST have `parentId: null`, `forkedFromMessageId: null`, `seedExcerptText: null`; exactly one such row exists per `documentType: 'thread'` Document (FR-003, FR-004).
- `kind: 'thread-branch'` MUST have non-null `parentId`, `forkedFromMessageId`, and `seedExcerptText`.
- `forkedFromMessageId` for a `thread-branch` MUST reference a message belonging to a segment strictly earlier than its parent Thread's current tip at the moment of branching (FR-007) — enforced at branch-creation time, not as an ongoing constraint (the parent's tip moves forward afterward; the branch's anchor never does).
- `branchDepth` and the existing `maxConversationDepth` setting apply unchanged (FR-012).

**State transitions**: `thread-root` created with the document (never deleted, FR-003/Edge Cases) → active (`doneAt: null`) ⇄ done (`doneAt: <timestamp>`, reversible via "reopen," Edge Cases/FR-009) — no `closed`/`errored`-style terminal state distinct from ordinary `status` handling; `status` continues to track turn-execution (`idle`/`working`/`errored`) exactly as for any other conversation.

**Relationships**: A `documentType: 'thread'` Document has exactly one `kind: 'thread-root'` Thread and zero or more `kind: 'thread-branch'` Threads, each with `parentId` pointing at the Thread (root or branch) it forked from — the same adjacency shape `parentId`/`branchDepth` already give canvas-mode conversations, just with different `kind` values and no side-column/HUD anchor semantics.

## Thread segment (frontend-only, derived, not persisted)

Computed per render pass from a Thread's own message list plus every sibling Thread's `forkedFromMessageId` in the same document (research.md R5) — never sent to or stored by the backend, exactly mirroring specs/005's `ConversationLayout` precedent.

| Field | Type | Derivation |
|---|---|---|
| `threadId` | `string` | The Thread this segment belongs to. |
| `startIndex` / `endIndex` | `number` | Message-array indices (inclusive) this segment spans within the Thread's own message list. |
| `isTipSegment` | `boolean` | `true` only for the last segment of a Thread (the one ending at its actual current tip) — only this segment accepts a compose action (FR-005c). |
| `childBranchIds` | `string[]` | Other Threads whose `forkedFromMessageId` equals this segment's last message — rendered as sibling forks immediately after this segment (FR-005b, User Story 2 scenario 9). |

## Exported session (User Story 4, FR-013 — not persisted, no schema change)

Produced entirely on demand by `PiService.exportThreadSession`/`ThreadService.exportSession` (research.md R9) — never stored in the `conversation` table or any new table, consistent with FR-015's reuse mandate and the constitution amendment's "read-only rendering" framing (nothing about FR-013 requires durable storage of a past export).

| Field | Type | Notes |
|---|---|---|
| `threadId` | `string` | The Thread this export was produced from. |
| `exportedAt` | `string` (ISO timestamp) | When this on-demand export was generated — not a stored/reusable identifier; a second export of the same Thread produces a new one. |
| `jsonl` | `string` | The literal byte contents Pi's own `SessionManager.createBranchedSession()` wrote for this Thread's root-to-leaf path, read back and returned verbatim (research.md R9) — this is "the underlying Pi session export itself" (spec's User Story 4 framing), not a re-derived approximation. |
| `messages` | `MessageDto[]` (existing shared type, reused as-is) | A friendly `{ role, text, ... }` parse of the same exported entries, for rendering through the existing `MessageBubble.vue` pipeline (FR-015 reuse) — built with the same entry-to-text extraction `PiService.readClosedTranscript` already uses, not a new extraction algorithm. |

**Validation rules**: Exporting a Thread with no message history yet (`piLeafEntryId === null`) is refused (`EmptyThreadExportError` → `409`/`EMPTY_THREAD_EXPORT`) — there is nothing to export (Independent Test: "From a thread with message history").

**Relationships**: Derived transiently from a Thread's own root-to-leaf path within the shared per-document Pi session file (research.md R1) — the same `piSessionPath`/`piLeafEntryId` pair every other Thread operation already uses; introduces no new relationship or foreign key.

## Exported document session (User Story 4, FR-013b — not persisted, no schema change)

Produced entirely on demand by `PiService.exportDocumentSession`/`ThreadService.exportDocumentSession` (research.md R10) — the whole-tree counterpart of "Exported session" above, covering every Thread in a threaded-conversation document at once rather than one Thread's own path. Never stored in any table.

| Field | Type | Notes |
|---|---|---|
| `documentId` | `string` | The threaded-conversation document this export was produced from. |
| `exportedAt` | `string` (ISO timestamp) | When this on-demand export was generated — a second export produces a new one, same convention as the per-thread export. |
| `html` | `string` | The literal, self-contained HTML bytes Pi's own `AgentSession.exportToHtml()` wrote for the document's entire shared session tree, read back and returned verbatim (research.md R10) — genuinely "the whole tree, Pi's own export," not an application-fabricated multi-branch view. |

**Validation rules**: Exporting a document with no message history in any of its Threads is refused (`EmptyDocumentExportError` → `409`/`EMPTY_DOCUMENT_EXPORT`) — determined by whether any Thread row in the document has a non-null `piLeafEntryId` (every `thread-branch` gets one at creation time from its resolved anchor, so its mere existence already implies the document is non-empty; only an untouched `thread-root` with no branches yet has every Thread's `piLeafEntryId` null).

**Relationships**: Derived transiently from the document's single shared Pi session file (research.md R1) — the same file every Thread in the document already points at via `piSessionPath`; introduces no new relationship or foreign key.

## Done state (conceptual, backed by `doneAt` above)

A non-destructive, reversible visibility flag on a Thread (`doneAt !== null`); excluded from the default top-down list (FR-008) but otherwise fully intact and actionable (branchable, per Edge Cases) — see research.md R3 for why this is not a repurposed `status: 'closed'`.

## Storage-layer interface changes (summary; full signatures are an implementation detail for tasks.md)

- `StorageAdapter`: `createDocument` gains `documentType`; `createConversation`/`updateConversation` accept the two new `kind` values and the new `piLeafEntryId`/`doneAt`/`seedExcerptText` fields (all already covered by the existing `Partial<ConversationRow>` patch shape).
- New `StorageAdapter.getThreadRoot(documentId): ConversationRow | null` (mirrors `getMainConversation`, filtered to `kind: 'thread-root'`).
- New `ConversationService`-adjacent `ThreadService` (backend/src/conversation/thread-service.ts, new file) — `createRoot(documentId)`, `branchFromHighlight({ parentThreadId, anchorMessageId, highlightedText })`, `markDone(threadId)`, `reopen(threadId)` — deliberately a separate class from `ConversationService` rather than more `if (kind === 'thread-root')` branches sprinkled through it, since the Pi-session strategy (R1: shared file + leaf repositioning) and the anchor resolution (R2: message-shaped, not document-offset-shaped) are both genuinely different from every existing `ConversationService` code path, not a small variant of them.
- `PiService` gains the one new method this requires: `sendOnThread(thread: ConversationRow, message: string, bridge: EventBridge)` — opens `thread.piSessionPath`'s `SessionManager`, calls `branch(thread.piLeafEntryId)` if non-null (no-op position for a fresh root), appends the message, updates `thread.piLeafEntryId` via `ThreadService`. Still the only new code touching the Pi SDK outside the existing `PiService` (Principle II unchanged).
