# Phase 0 Research: Multi-Document Support

## R1: How much of the existing storage/service layer already supports multiple documents?

**Decision**: Extend the existing singleton access points rather than redesigning the schema.

**Rationale**: A backend architecture survey found the SQLite schema is already document-scoped almost everywhere:
- `revision`, `document_snapshot`, `document_change`, `conversation`, `staged_edit`, and `conversation_event` all already carry a `document_id` foreign key (`app/backend/src/storage/sqlite/migrations.ts`).
- The two partial unique indexes that enforce "one Primary conversation" and "one current Main conversation" are already scoped `WHERE ... ON conversation (document_id)` — i.e., already "one per document," not "one globally."
- The event envelope format (`app/shared/src/contracts/events.ts`) already includes `documentId` on every event.

The singleton assumption is concentrated in exactly three places:
1. `StorageAdapter.getDocument()` — a parameterless "get the one row" query (`app/backend/src/storage/sqlite/index.ts:224`).
2. `DocumentService` — holds one `AutomergeStoreHolder` wrapping a single in-memory `AutomergeStore | null`, not keyed by document id (`app/backend/src/document/document-service.ts`, `app/backend/src/document/automerge-store-holder.ts`).
3. HTTP routes and the `/events` WebSocket endpoint — never carry a document id; they all resolve "the" document via the singleton lookup (`app/backend/src/api/http/document.ts`, `app/backend/src/api/ws/index.ts`).

**Alternatives considered**:
- *Full schema redesign*: rejected — the FK structure already anticipates this (per the constitution's existing "schema and service boundaries MUST NOT preclude multiple documents" guarantee); a redesign would be pure churn.
- *Separate SQLite file per document*: rejected — would complicate the existing single-connection storage abstraction and cross-document listing (the dropdown needs a cheap "list all documents" query) for no isolation benefit, since row-level `document_id` scoping already gives full isolation within one file.

## R2: How should the in-memory Automerge store scale from one instance to many?

**Decision**: Replace the single `AutomergeStoreHolder` with a keyed registry (document id → `AutomergeStore`), lazily loaded on first access and evicted on delete. `DocumentService` methods take a `documentId` parameter instead of operating on an implicit singleton.

**Rationale**: Keeps the proven Automerge-per-document load/persist logic (Principle IV) unchanged; only the holder's cardinality changes. Lazy loading avoids paying the CRDT-load cost for documents the user isn't currently viewing, which matters once multiple documents exist. FR-006 (background streaming continues while switched away) requires the *conversation/Pi* side to keep running regardless of which document is "active" in the UI, but the Automerge store for an inactive document does not need to be evicted from memory just because the UI isn't showing it — only on explicit deletion.

**Alternatives considered**:
- *Load all documents' stores eagerly at startup*: rejected — wastes memory/startup time for documents the user may not open in a given session, with no benefit since nothing needs cross-document Automerge access (per spec Assumptions: no cross-document features).
- *Evict a document's store as soon as the UI navigates away from it*: rejected — would break FR-006 (an in-flight agent operation on a backgrounded document must keep running) since the store may still be actively mutated by that document's Primary conversation.

## R3: How should HTTP and WebSocket contracts change to be document-scoped?

**Decision**: Add `:documentId` as a path segment ahead of existing resource paths (e.g. `GET /api/documents`, `GET /api/documents/:documentId`, `GET /api/documents/:documentId/revisions`, `GET /api/documents/:documentId/conversations/...`), and add a `documentId` query parameter to the `/events` WebSocket subscribe message. Add one new document-list endpoint (`GET /api/documents`) returning Document Summaries for the dropdown.

**Rationale**: Every event and DB row is already keyed by `document_id`; making it explicit in the URL/subscription is the minimal change that removes the "there is exactly one document" assumption from the transport layer without altering the shape of existing per-document contracts (conversations, edits, revisions keep their existing sub-paths and semantics unchanged, just nested under a document).

**Alternatives considered**:
- *Keep flat routes and infer the document from the conversation/edit id*: rejected — conversation/edit ids are already globally unique so this would technically work, but it re-introduces an implicit, unstated document-scoping rule instead of making it explicit and consistent with how document/revision routes must change anyway (they have no conversation/edit id to infer from).

## R4: Which keyboard shortcut for next/previous document avoids existing bindings?

**Decision**: `Ctrl+Alt+]` (next document) and `Ctrl+Alt+[` (previous document).

**Rationale**: The existing `app/frontend/src/a11y/keymap-registry.ts` registry uses `Ctrl+Alt+<letter/digit/arrow>` as its global pattern; letters R, H, Y, P, E, J, K, L, N, digits 1-9, and ArrowLeft/ArrowRight are already bound, and `Ctrl+Alt+Shift+H` is also taken. The bracket keys `[` and `]` are unused and read naturally as "previous/next" (a common editor/browser-tab idiom), and the combination follows the constitution's stated preference for `Ctrl+Alt+<key>` over bare `Alt+<letter>` (UI Conventions → Keyboard Shortcuts).

**Alternatives considered**:
- `Ctrl+Alt+Shift+ArrowLeft/ArrowRight`: rejected — free, but overloads the arrow keys with a third modifier tier on top of the existing `Ctrl+Alt+ArrowLeft/ArrowRight` (conversation-panel focus) binding, which is more confusable than a distinct bracket key.
- Reusing `Ctrl+Alt+J/K` (already "next/previous conversation"): rejected — would collide with an existing binding and overload the same keys with a second, unrelated meaning.

## R5: Does `user_settings` need to become per-document?

**Decision**: No. `user_settings` remains a single global row (thinking visibility, debounce interval, concurrency limits, etc.) shared across all documents.

**Rationale**: These are operator/application-level configuration values (per spec 001 and Constitution Principle V), not document content; the feature spec's Assumptions explicitly scope this feature to managing independent documents, not to per-document configuration policy. Splitting it would be scope creep with no requirement driving it.

**Alternatives considered**: Per-document settings override — rejected as speculative; no functional requirement calls for it.
