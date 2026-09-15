# Contracts: Multi-Document Support

Scope: how the existing HTTP and WebSocket contracts (`app/shared/src/contracts/http.ts`, `app/shared/src/contracts/events.ts`) change to remove the implicit single-document assumption. Every route below that already existed keeps its existing request/response DTO shapes (`DocumentDto`, `ConversationDto`, `RevisionDto`, `StagedEditDto`, etc., all unchanged) — only the URL and the addition of a `documentId` path segment change, plus the new endpoints marked **NEW**.

## HTTP

| Method | Path (before) | Path (after) | Notes |
|---|---|---|---|
| GET | — | **`/api/documents`** | **NEW**. Returns `ListDocumentsResponse` (array of Document Summary: `id`, `title`, `isActive`, `lastActiveAt`), ordered most-recently-active first. Powers the dropdown (FR-002). |
| POST | `/api/document` | **`/api/documents`** | Creates a new document; no longer rejects with `DocumentAlreadyExistsError` (FR-001). Response includes the new document's `id`, which the frontend immediately makes active. |
| GET | `/api/document` | `/api/documents/:documentId` | Fetch one document's `DocumentDto`. |
| PATCH | `/api/document` | `/api/documents/:documentId` | Existing content-patch semantics unchanged; also the target for **rename** (`title` field, FR-007). |
| DELETE | — | **`/api/documents/:documentId`** | **NEW**. Deletes a document and its FK-cascaded content (revisions, conversations, staged edits, events) after frontend-side confirmation (FR-008). Returns `409 Conflict` with `ErrorCode` `last_document` if it is the only remaining document (FR-009). |
| GET | `/api/document/export` | `/api/documents/:documentId/export` | Unchanged export semantics, now per document. |
| GET | `/api/revisions` | `/api/documents/:documentId/revisions` | Unchanged `ListRevisionsResponse` shape. |
| POST | `/api/revisions/:revision/restore` | `/api/documents/:documentId/revisions/:revision/restore` | Unchanged restore semantics. |
| GET/POST | `/api/conversations` | `/api/documents/:documentId/conversations` | Unchanged `ConversationDto`/`CreateConversationRequest` shapes. |
| GET/PATCH/DELETE | `/api/conversations/:id` | `/api/documents/:documentId/conversations/:id` | Unchanged; `:id` remains globally unique but is now additionally namespaced for routing clarity and authorization symmetry with the rest of the tree. |
| POST | `/api/conversations/:id/{send,retry,close,review,primary,...}` | `/api/documents/:documentId/conversations/:id/{send,retry,close,review,primary,...}` | Unchanged action semantics. |
| GET | `/api/conversations/:id/edits` | `/api/documents/:documentId/conversations/:id/edits` | Unchanged. |
| POST | `/api/edits/:id/{preview,apply,drop,...}` | `/api/documents/:documentId/edits/:id/{preview,apply,drop,...}` | Unchanged. |
| GET/PATCH | `/api/settings` | `/api/settings` | **Unchanged path** — settings remain global, not document-scoped (research.md R5). |
| GET | `/api/system-prompt` | `/api/system-prompt` | **Unchanged path** — not document content. |

### New/changed DTOs (`app/shared/src/contracts/http.ts`)

```ts
DocumentSummaryDto = z.object({
  id: z.string(),
  title: z.string(),
  isActive: z.boolean(),
  lastActiveAt: z.string(),
});

ListDocumentsResponse = z.object({
  documents: z.array(DocumentSummaryDto),
});

RenameDocumentRequest = z.object({ title: z.string().min(1) });
// Reuses PatchDocumentResponse shape for the response.

DeleteDocumentResponse = z.object({ id: z.string() });
```

Add `last_document` to the existing `ErrorCode` enum (returned by `DELETE /api/documents/:documentId` when it is the only remaining document, FR-009).

## WebSocket (`/events`)

- The `subscribe` client message gains a required `documentId` field. The server resolves and validates that document exists before subscribing (reusing `StorageAdapter.getDocument(documentId)`); an unknown id yields the existing not-found error envelope shape.
- Event envelopes are unchanged — `documentId` and `conversationId` are already present on every event per `app/shared/src/contracts/events.ts`. `EventHub` subscriber bookkeeping, already keyed by document id internally, now has that key populated from the explicit subscribe parameter instead of the singleton lookup.
- Switching the active document in the UI re-subscribes the existing WebSocket connection to the newly active `documentId` rather than opening a second connection (keeps FR-006's "backgrounded document keeps streaming" true at the transport level too — the previous subscription's in-flight event delivery is not required once the frontend has switched, since the backend keeps producing/persisting events regardless of any active subscription; on switching back, the frontend re-subscribes and catches up from the persisted `conversation_event` log, consistent with spec 001's existing reconnect-and-catch-up behavior).

## Frontend keyboard contract (`app/frontend/src/a11y/keymap-registry.ts`)

New `KEYBOARD_SHORTCUTS` entries (scope: `global`):

| Combo | Description |
|---|---|
| `Ctrl+Alt+]` | Switch to the next document |
| `Ctrl+Alt+[` | Switch to the previous document |
