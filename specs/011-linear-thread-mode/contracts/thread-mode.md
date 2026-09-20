# Contracts: Linear Thread Mode

Scope: User Stories 1-4 (FR-001 through FR-015). User Story 4 / FR-013 (Pi-native export rendering) was added in a follow-up planning pass (research.md R8/R9) once the constitution amendment removing the "Pi export viewing" non-goal landed (v2.4.0).

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
| GET | `/api/documents/:documentId/threads/:id/export` | **NEW** (User Story 4/FR-013). Produces a fresh, on-demand `ExportThreadSessionResponse` (below) from the Thread's genuine Pi session history (research.md R9 — `SessionManager.createBranchedSession()` on a throwaway instance, never the cached shared one). `409`/`EMPTY_THREAD_EXPORT` if the Thread has no message history yet. Nothing is persisted server-side; a second call produces a new `exportedAt`. |
| GET | `/api/documents/:documentId/threads/export` | **NEW** (User Story 4/FR-013b). Whole-document export: renders the document's ENTIRE shared Pi session tree (every Thread/branch together) as one self-contained HTML artifact via `AgentSession.exportToHtml()` (research.md R10), returned as `Content-Type: text/html` (not JSON — this is a rendered artifact, matching `GET /api/documents/:documentId/export`'s own raw-body convention, not the JSON-DTO convention every other route on this table uses). Accepts `?download=1` for `Content-Disposition: attachment`, same convention as that same document-export route. `409`/`EMPTY_DOCUMENT_EXPORT` if no Thread in the document has any message history yet. A distinct, non-colliding path from the per-thread `.../threads/:id/export` above (different segment count — no routing ambiguity). Nothing is persisted server-side; a second call produces a fresh export. |

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

// User Story 4 / FR-013 (research.md R9, data-model.md's Exported session)
ExportThreadSessionResponse = z.object({
  threadId: z.string(),
  exportedAt: z.string(),
  jsonl: z.string(),        // the literal bytes Pi's own SessionManager.createBranchedSession() wrote
  messages: z.array(MessageDto), // friendly parse of the same export, for MessageBubble.vue reuse
});
```

Add to `ErrorCode`: `INVALID_HIGHLIGHT` (highlighted text not found in the anchor message), `ANCHOR_IS_TIP` (FR-007 — anchor message is the source thread's current tip), `PENDING_EDITS_BLOCK_DONE` (FR-010), `ROOT_THREAD_UNDELETABLE` (Edge Cases — no delete route is ever offered for `thread-root`, but the code is reserved in case a generic conversation-delete path is ever extended to reach it), `EMPTY_THREAD_EXPORT` (User Story 4/FR-013 — exporting a Thread with no message history yet), `EMPTY_DOCUMENT_EXPORT` (User Story 4/FR-013b — exporting a document with no message history in any of its Threads yet).

```ts
// User Story 4/FR-013b (research.md R10, data-model.md's "Exported document session"). The HTTP
// response body for `GET .../threads/export` is the raw HTML text itself (`Content-Type: text/html`),
// not this shape — this schema exists only for the query string, matching
// `ExportDocumentQuery`'s own precedent for `GET /api/documents/:documentId/export`.
ExportDocumentSessionQuery = z.object({
  download: z.coerce.boolean().optional(),
});
```

## WebSocket (`/events`)

- No new event types. `conversation_started` (branch creation), `conversation_renamed`, `message_completed`, `agent_settled`/`agent_error` already carry everything Threads need; the frontend distinguishes thread-kind envelopes by the `kind` field already on `conversation_started`'s payload (mirrors how `kind: 'main'` vs `'branch'` is already distinguished today).
- **NEW** event: `conversation_done_changed` — `{ documentId, conversationId, sequence, doneAt: string | null }`, published by both the `.../done` and `.../reopen` routes, so every connected client's default top-down list updates live (SC-003/SC-004) without a full re-fetch.

## Frontend routing/view contract

- A `documentType: 'thread'` document renders `ThreadModeView.vue` (new) in place of the existing canvas/App shell's Preview+Canvas+History grid — this is a full alternate top-level view, not a toggle within the existing canvas layout (Clarifications: separate thread sets, fixed at document creation).
- The document-switcher dropdown (spec 010) shows a document-type indicator (e.g. a small icon/badge) next to each entry so the reviewer can tell, before switching, which view they'll land in.
- User Story 4/FR-013: each Thread's header offers an "Export" action (a small, always-available utility action — not mutually exclusive with, and rendered alongside, the Mark done/Reopen primary action per plan.md's Post-Design Constitution Check note that `ThreadCard.vue`'s header is a new view not strictly bound to the existing single-primary-slot convention) opening a read-only modal (`ThreadExportViewer.vue`) that fetches and renders `GET .../export`'s response: the parsed transcript through `MessageBubble.vue`, plus the raw `jsonl` in a collapsible plain-text block.
- User Story 4/FR-013b: `ThreadModeView.vue`'s toolbar (alongside its existing "Expand all"/"Done (N)" controls) offers an "Export all" action that fetches `GET .../threads/export` and opens the returned self-contained HTML in a new browser tab (`Blob` + `URL.createObjectURL` + `window.open` — the SDK designs this artifact as a standalone document with its own interactive navigation JS, not something meant to be embedded inline in a Vue component). This is a distinct trigger from FR-013's per-thread "Export," not a replacement for it.
