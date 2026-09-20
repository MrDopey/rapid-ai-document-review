# Contracts: Linear Thread Mode

Scope: User Stories 1-3 only (FR-001 through FR-012, FR-014, FR-015). User Story 4 / FR-013 (Pi-native export rendering) is out of scope for this plan (research.md R8) and has no contract here.

This feature extends the existing document/conversation contracts (`app/shared/src/contracts/http.ts`) rather than introducing a parallel API surface, per FR-015.

## HTTP

| Method | Path | Notes |
|---|---|---|
| POST | `/api/documents` | **Extended** (not new): `CreateDocumentRequest` gains an optional `documentType: 'canvas' \| 'thread'` field, default `'canvas'` (research.md R7, FR-001). When `'thread'`, the response's document already has its single root Thread created — the frontend does not make a separate call to create it. |
| GET | `/api/documents/:documentId/conversations` | **Unchanged shape**, `ConversationDto` now sometimes carries `kind: 'thread-root' \| 'thread-branch'` and the new fields below; for a `documentType: 'thread'` document this list is exactly that document's Threads (FR-002). A canvas-mode document's list never contains thread-kind rows and vice versa. |
| POST | `/api/documents/:documentId/threads/:id/branch` | **NEW**. Body: `BranchThreadRequest` (below). Replaces `POST .../conversations` (canvas's generic branch endpoint) for thread-kind documents — the anchor shape is different enough (message + highlighted passage, not a document selection, research.md R2) to warrant its own request type rather than overloading `CreateConversationRequest.selection`. Enforces FR-007 (anchor must be strictly earlier than the source thread's current tip) and FR-012 (`maxConversationDepth`), returning the same `MaxConversationDepthExceededError` → `409`/`MAX_CONVERSATION_DEPTH_EXCEEDED` mapping canvas branching already uses. |
| POST | `/api/documents/:documentId/threads/:id/done` | **NEW**. Marks the Thread done (FR-008). `409`/`PENDING_EDITS_BLOCK_DONE` if it has unresolved staged edits (FR-010, reusing the same guard `close()` already applies). Refused (`409`/`CANNOT_MARK_ROOT_DONE`... no — see note below) — **root threads CAN be marked done** (Edge Cases only forbid *deleting* the root, not marking it done); only deletion of a `thread-root` is refused. |
| POST | `/api/documents/:documentId/threads/:id/reopen` | **NEW**. Clears a Thread's done state (symmetric with `.../done`, research.md R3). No-op (`200`) if already active. |
| GET | `/api/documents/:documentId/threads/:id/messages` | **Reuses** `GET .../conversations/:id` (`GetConversationResponse`) verbatim — a Thread's message list is fetched exactly like any conversation's. |
| POST | `/api/documents/:documentId/threads/:id/send` | **Reuses** `POST .../conversations/:id/send` (`SendMessageResponse`) verbatim, routed internally to `PiService.sendOnThread` instead of `PiService.send` based on `conversation.kind` (data-model.md). |

Existing routes deliberately **not** reused for thread-kind conversations: `POST .../:id/refresh-send` (no per-conversation `contextRevision` re-seeding concept defined for this feature — Assumptions/FRs never mention it), `POST .../:id/close` and `.../review` (canvas-specific lifecycle — "done" is not "closed," research.md R3), `POST .../:id/primary` (research.md R6 — no Primary concept in threaded-conversation documents).

### New/changed DTOs (`app/shared/src/contracts/http.ts`)

```ts
CreateDocumentRequest = CreateDocumentRequest.extend({
  documentType: z.enum(['canvas', 'thread']).optional(), // default 'canvas'
});

ConversationKind = z.enum(['main', 'branch', 'review', 'thread-root', 'thread-branch']);

ConversationDto = ConversationDto.extend({
  doneAt: z.string().nullable(),          // null = active; non-null = done (FR-008/FR-009)
  seedExcerptText: z.string().nullable(), // the highlighted passage that seeded this branch (FR-005a); null for thread-root and non-thread kinds
});

BranchThreadRequest = z.object({
  anchorMessageId: z.string(),   // a MessageDto.id belonging to the source thread
  highlightedText: z.string().min(1), // MUST be an exact substring of anchorMessageId's text (400/INVALID_HIGHLIGHT otherwise)
  name: z.string().min(1).optional(),
});

MarkThreadDoneResponse = z.object({ threadId: z.string(), doneAt: z.string() });
ReopenThreadResponse = z.object({ threadId: z.string(), doneAt: z.literal(null) });
```

Add to `ErrorCode`: `INVALID_HIGHLIGHT` (highlighted text not found in the anchor message), `ANCHOR_IS_TIP` (FR-007 — anchor message is the source thread's current tip), `PENDING_EDITS_BLOCK_DONE` (FR-010), `ROOT_THREAD_UNDELETABLE` (Edge Cases — no delete route is ever offered for `thread-root`, but the code is reserved in case a generic conversation-delete path is ever extended to reach it).

## WebSocket (`/events`)

- No new event types. `conversation_started` (branch creation), `conversation_renamed`, `message_completed`, `agent_settled`/`agent_error` already carry everything Threads need; the frontend distinguishes thread-kind envelopes by the `kind` field already on `conversation_started`'s payload (mirrors how `kind: 'main'` vs `'branch'` is already distinguished today).
- **NEW** event: `conversation_done_changed` — `{ documentId, conversationId, sequence, doneAt: string | null }`, published by both the `.../done` and `.../reopen` routes, so every connected client's default top-down list updates live (SC-003/SC-004) without a full re-fetch.

## Frontend routing/view contract

- A `documentType: 'thread'` document renders `ThreadModeView.vue` (new) in place of the existing canvas/App shell's Preview+Canvas+History grid — this is a full alternate top-level view, not a toggle within the existing canvas layout (Clarifications: separate thread sets, fixed at document creation).
- The document-switcher dropdown (spec 010) shows a document-type indicator (e.g. a small icon/badge) next to each entry so the reviewer can tell, before switching, which view they'll land in.
