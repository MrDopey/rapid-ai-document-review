# Implementation Plan: Multi-Document Support

**Branch**: `010-multi-document-support` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-multi-document-support/spec.md`

## Summary

Extend the application from exactly-one-document to many independent documents for the single local user. The primary requirement is a title-bar dropdown (plus a `Ctrl+Alt+[` / `Ctrl+Alt+]` keyboard shortcut) to create, list, switch, rename, and delete documents, with every document's content, conversations, and revision history fully isolated. The technical approach (Phase 0) confirmed the SQLite schema and event envelope are already document-scoped via a `document_id` column/field almost everywhere; the singleton assumption is concentrated in three places — `StorageAdapter.getDocument()`, the single in-memory `AutomergeStoreHolder`, and document-id-free HTTP/WebSocket routes — so the plan replaces those three access points with document-id-keyed equivalents rather than redesigning the data model.

## Technical Context

**Language/Version**: TypeScript (Node.js >=26.1.0), Vue 3 (frontend)

**Primary Dependencies**: Fastify + `@fastify/websocket` (backend HTTP/WS), `@automerge/automerge` (document CRDT), `@earendil-works/pi-coding-agent` (Pi SDK), `zod`/`typebox` (contracts), Vue 3 + Pinia + CodeMirror 6 (frontend)

**Storage**: SQLite (existing `app/backend/src/storage/sqlite`), behind the existing `StorageAdapter` abstraction (Constitution: Technology & Platform Constraints)

**Testing**: Vitest (`test:unit`, `test:integration`, `test:contract` in `app/backend`; `test:unit`, `test:component` in `app/frontend`), Playwright (`test:e2e`, root `tests/`)

**Target Platform**: Self-hosted, Dockerized, localhost-bound web application (existing deployment model, unchanged)

**Project Type**: Web application — npm workspaces monorepo (`app/backend`, `app/frontend`, `app/shared`)

**Performance Goals**: Document switch fully visible within 1s (SC-002); new document ready to type into within 5s of opening the dropdown (SC-001)

**Constraints**: Zero cross-document leakage of content/conversations/history (SC-003, FR-004); an in-progress agent operation on a backgrounded document must keep running uninterrupted (FR-006); all existing per-document guarantees from spec 001 (autosave, revision history, conflict handling, proposal review, export, accessibility, sanitization, structured logging) must hold independently per document (FR-012)

**Scale/Scope**: Up to ~20 open documents per the single local user (SC-004), each up to ~30 pages / ~15,000 words (spec 001 ceiling, carried per-document)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution amended to v2.3.0 as a prerequisite for this plan (multi-document support removed from the v1 non-goals list; see Sync Impact Report at the top of `.specify/memory/constitution.md`). Checked against the amended constitution:

| Principle / Constraint | Status | Notes |
|---|---|---|
| I. The Application Owns the Document | PASS | Each document still has exactly one backend-owned Automerge/CRDT source of truth; only the holder's cardinality changes (one → many), not who owns it. |
| II. Pi Owns Agent Conversations | PASS | Each document keeps its own `pi_session_dir` (already a `document` column); Pi sessions remain accessed only via the SDK, one set of sessions per document. |
| III. Agent Edits Are Proposals, Not Direct Writes | PASS | Unchanged per document; the staged-edit pipeline is already `document_id`-scoped in the schema. |
| IV. CRDT-Mediated Merging, Revisions Separate | PASS | Unchanged per document; revision numbering is already scoped by `(document_id, revision)`. |
| V. Configurable Limits Are Enforced, Not Advisory | PASS | Existing limits (branching depth, editing depth, concurrent agents, debounce) continue to apply per document; no limit becomes bypassable by adding more documents (each document independently enforces its own limits, per FR-012). |
| VI. Sanitize Before Render | PASS | Unchanged; sanitization is applied per rendered document regardless of how many documents exist. |
| VII. No Pi Extension Without Demonstrated Necessity | PASS | No Pi extension required — multiple documents map to multiple ordinary Pi session directories, not a new Pi integration surface. |
| VIII. Comments Are Durable, Not Historical | PASS | Applies to implementation phase; no plan-level violation. |
| Tech Constraints: SQLite via abstracted storage layer | PASS | No new storage backend; extends the existing `StorageAdapter` interface with document-id parameters. |
| Tech Constraints: v1 non-goals | PASS | "Multiple documents" removed from the non-goal list in this same amendment; multi-user/multi-account remains out of scope and this feature does not touch it. |
| Quality Gate: idempotent retryable operations | PASS | Unaffected; still scoped per staged edit / Pi tool-call id, now additionally namespaced by document id. |
| Quality Gate: conversation not closable with unresolved staged edits | PASS | Unaffected; enforced per conversation regardless of document. |
| UI Conventions: Keyboard Shortcuts registry | PASS | New shortcut added to `keymap-registry.ts` (single source of truth); uses `Ctrl+Alt+[`/`Ctrl+Alt+]`, avoiding bare `Alt+<letter>` per the stated preference (research.md R4). |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/010-multi-document-support/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── http-and-ws.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/backend/src/
├── storage/sqlite/
│   ├── migrations.ts        # add migration: drop implicit-singleton assumption, keep document_id FKs as-is
│   └── index.ts              # StorageAdapter: getDocument(id) / listDocuments() / deleteDocument(id) replace getDocument()
├── document/
│   ├── document-service.ts   # methods take documentId; create() drops "already exists" singleton guard, adds listDocuments/deleteDocument/renameDocument
│   └── automerge-store-holder.ts  # becomes a Map<documentId, AutomergeStore>, lazily populated
├── conversation/
│   └── conversation-service.ts    # call sites pass documentId explicitly instead of relying on the implicit singleton
├── api/
│   ├── http/document.ts      # routes gain :documentId param; add GET /api/documents (list), DELETE /api/documents/:documentId, PATCH rename
│   ├── http/revisions.ts     # nest under /api/documents/:documentId/revisions
│   ├── http/conversations.ts # nest under /api/documents/:documentId/conversations
│   ├── http/edits.ts         # nest under /api/documents/:documentId/edits
│   └── ws/index.ts           # subscribe message gains documentId; EventHub subscription keyed accordingly (already partially keyed)
└── events/event-hub.ts        # confirm/extend per-document subscriber scoping

app/shared/src/contracts/
├── http.ts                   # add DocumentSummaryDto, ListDocumentsResponse, RenameDocumentRequest/Response, DeleteDocumentResponse; add documentId path params to existing request/response types where routes are renested
└── events.ts                  # no shape change (documentId already present on every envelope); update doc comments only if needed

app/frontend/src/
├── a11y/keymap-registry.ts   # register Ctrl+Alt+[ / Ctrl+Alt+] (next/previous document)
├── components/header/        # new: DocumentSwitcherDropdown.vue (title-bar dropdown: list, switch, +New, rename, delete-confirm)
├── stores/                   # Pinia store(s) gain a documentId dimension: which document is active, per-document cached state
├── transport/ws-client.ts    # WS subscribe call passes the active documentId
└── App.vue                   # header renders DocumentSwitcherDropdown in place of the static title

app/backend/tests/{unit,integration,contract}/   # new/updated tests for multi-document isolation, list/create/rename/delete, WS scoping
app/frontend/tests/{unit,component}/             # new/updated tests for DocumentSwitcherDropdown and the keyboard shortcut
tests/ (Playwright e2e)                          # new spec: create second document, verify isolation, switch via dropdown and hotkey
```

**Structure Decision**: Existing web-application monorepo structure (`app/backend`, `app/frontend`, `app/shared`) is reused as-is; no new top-level projects or directories. Every change is either a modification to an existing singleton access point (storage/service/routes) or a new, narrowly-scoped frontend component (the document switcher) and its store wiring.

## Complexity Tracking

*No violations — table intentionally omitted.*
