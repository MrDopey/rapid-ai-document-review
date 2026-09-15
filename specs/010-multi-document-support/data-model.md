# Phase 1 Data Model: Multi-Document Support

This feature does not introduce new persisted entity *types* — every content table already carries a `document_id` foreign key (see research.md R1). It changes cardinality (one `document` row → many) and adds one read-optimized view for the dropdown. Existing entities from spec 001 (`Revision`, `Conversation`, `StagedEdit`, `ConversationEvent`) are unchanged in shape; only their access patterns become explicitly document-id-scoped instead of implicitly singleton-scoped.

## Document

The root entity. One row per document; previously constrained to at most one row by application logic only (`DocumentService.create()`), never by schema.

| Field | Type | Notes |
|---|---|---|
| `id` | string (existing) | Stable identifier; already the FK target for every other table. |
| `title` | string (existing) | User-facing name shown in the header and dropdown. Renamable (FR-007). Not required to be unique (spec Edge Cases: duplicate/blank titles permitted). |
| `currentRevision` | integer (existing) | Unchanged meaning, now one independent counter per document row instead of the only counter in the system. |
| `piSessionDir` | string (existing column, `document.pi_session_dir`) | Already per-document; no change needed — this is what keeps each document's Pi sessions isolated (Principle II). |
| `createdAt` / `updatedAt` | timestamp (existing) | Unchanged. |
| `lastActiveAt` | timestamp (**new**) | When this document was last the active document for the user. Drives the dropdown's most-recently-active ordering (spec Edge Cases) and "restore the document active at shutdown" behavior (FR-011). |

**Validation rules**:
- A document always exists once created; there is no "no documents" state (FR-009 — deletion of the last remaining document is rejected).
- `title` has no uniqueness constraint (duplicates/blank permitted per spec).

**State transitions**: created → active/inactive (toggled by user navigation, tracked via `lastActiveAt`, not a stored enum) → renamed (title update, no state change) → deleted (terminal; row and all FK-cascaded content removed per FR-008, blocked entirely if it is the last row per FR-009).

**Relationships**: One `Document` has many `Revision`, `Conversation`, `StagedEdit`, `ConversationEvent`, `DocumentSnapshot`, `DocumentChange` rows (all already FK'd to `document_id`; unchanged).

## Document Summary (derived / read view, not a new table)

The lightweight projection returned by the document-list endpoint and rendered in the dropdown, so switching documents doesn't require loading each one's full Automerge state just to list them.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as `Document.id`. |
| `title` | string | Same as `Document.title`. |
| `isActive` | boolean | True for exactly one Document Summary per request — the one currently active for this session. |
| `lastActiveAt` | timestamp | Drives dropdown ordering (most-recently-active first, per spec Edge Cases). |

**Derivation**: `SELECT id, title, last_active_at FROM document ORDER BY last_active_at DESC` (replaces the current parameterless `getDocument()` singleton query); `isActive` is computed against whichever document id the requesting session currently has active, not stored per row.

## Application-Global Settings (unchanged, explicitly not document-scoped)

`user_settings` (existing singleton row: thinking visibility, manual-edit debounce interval, concurrency limits, etc.) remains global across all documents — see research.md R5. No schema or contract change.

## Storage-layer interface changes (summary; full signatures are an implementation detail for tasks.md)

- `StorageAdapter.getDocument()` → `getDocument(documentId)` + new `listDocuments()` + new `deleteDocument(documentId)` + new `renameDocument(documentId, title)` + `touchLastActive(documentId)`.
- `DocumentService.create()` drops its `DocumentAlreadyExistsError` guard (that guard *was* the singleton enforcement; FR-009's "can't delete the last document" replaces it as the only remaining cardinality floor).
- `AutomergeStoreHolder` → keyed by `documentId`, lazily populated on first access, entry removed on `deleteDocument`.
