# Implementation Plan: Linear Thread Mode

**Branch**: `011-linear-thread-mode` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-linear-thread-mode/spec.md`

**Scope note**: This plan covers User Stories 1-3 (FR-001 through FR-012, FR-014, FR-015) only. User Story 4 / FR-013 (genuine Pi-native session export rendered in the browser) remains blocked on a constitution amendment removing the "Pi export viewing" v1 non-goal (spec Clarifications/Assumptions); no research, data model, contract, or task is produced for it here (research.md R8). A follow-up `/speckit-plan` run extends this plan once that amendment lands.

## Summary

Add a second document type — "threaded conversation" — chosen once at document-creation time (extending spec 010's create-document flow) alongside the existing canvas-mode document. A threaded-conversation document renders its conversations ("Threads") top-down with exactly one auto-created root Thread and no way to create a second, independent top-level Thread; every other Thread is created by highlighting a passage in an earlier, non-tip message and branching from it, seeding the new Thread's first message with that passage wrapped in a `<branch-seed-excerpt>` XML tag (the constitution's existing seed-tagging convention). Branches are genuine Pi-level branches of one shared, per-document Pi session (`SessionManager.branch()` leaf-repositioning), not independently forked sessions — this is the one place this feature's backend approach diverges from canvas mode's existing per-conversation-session-file model (research.md R1), because it is the only way to satisfy FR-006. A Thread can be marked "done" (a new, reversible, orthogonal visibility flag distinct from the existing `closed` status) to declutter the default view without losing anything. Almost every other piece of machinery — storage schema shape, event streaming, edit-proposal pipeline, sanitized Markdown rendering — is reused unchanged from specs 001/005/006/010.

## Technical Context

**Language/Version**: TypeScript (Node.js, existing engines range), Vue 3 (frontend)

**Primary Dependencies**: Fastify + `@fastify/websocket` (backend HTTP/WS), `@automerge/automerge` (document CRDT, untouched by this feature), `@earendil-works/pi-coding-agent` (Pi SDK — `SessionManager.branch()`/`getEntries()`/`getTree()` are the new surface this feature exercises, all still only from `app/backend/src/pi/pi-service.ts`), `zod` (contracts), Vue 3 + Pinia (frontend state)

**Storage**: SQLite via the existing `StorageAdapter` abstraction; one new `document.document_type` column and four new `conversation` columns (`piLeafEntryId`, `doneAt`, `seedExcerptText`, plus two new `kind` enum values) — see data-model.md. No new tables.

**Testing**: Vitest (`app/backend/tests/{unit,integration,contract}`, `app/frontend/tests/{unit,component}`), Playwright (`tests/e2e`, following the existing `usN.spec.ts` convention)

**Target Platform**: Self-hosted, Dockerized, localhost-bound web application (existing deployment model, unchanged)

**Project Type**: Web application — existing npm workspaces monorepo (`app/backend`, `app/frontend`, `app/shared`)

**Performance Goals**: No new performance target beyond existing per-document/per-conversation send/render latency; thread-segment splitting (FR-005b) is a small-N, render-pass-local computation (bounded by `maxConversationDepth`), not a scalability concern, matching specs/005's precedent.

**Constraints**: A branch MUST be a genuine leaf-repositioned branch of the source thread's own Pi session, never an independently forked session (FR-006); only a thread's current tip segment may accept a new composed message (FR-005c); marking done MUST NOT be possible while staged edits are unresolved (FR-010); a document's type is immutable after creation (FR-014).

**Scale/Scope**: Same single-local-user, per-document scale envelope as specs 001/010; branch depth bounded by the existing, enforced `maxConversationDepth` (Constitution Principle V, FR-012) — this remains a UI/interaction feature, not a scalability one.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / Constraint | Status | Notes |
|---|---|---|
| I. The Application Owns the Document | PASS | Threads are conversations, not document content; no new source of truth for document state is introduced. |
| II. Pi Owns Agent Conversations | PASS | All new Pi surface (`SessionManager.branch()`, shared per-document session file, leaf-entry tracking) is added inside `PiService` only (`PiService.sendOnThread`, data-model.md) — still the sole module importing the Pi SDK. The application never reads/writes the session file directly; it only calls SDK methods. |
| III. Agent Edits Are Proposals, Not Direct Writes | PASS | Unchanged pipeline; no thread is ever `isPrimary`, so no thread's proposals are ever auto-applied (research.md R6) — every proposal in this mode goes through ordinary manual review, a strictly *more* conservative posture than canvas mode's, not a weaker one. |
| IV. CRDT-Mediated Merging, Revisions Separate | PASS | Not touched — this feature is entirely about conversation structure, not document content/revisions. |
| V. Configurable Limits Are Enforced, Not Advisory | PASS | `maxConversationDepth` applies unchanged to Thread branching (FR-012); no second, competing depth limit is introduced. |
| VI. Sanitize Before Render | PASS | Thread messages render through the same sanitized Markdown pipeline as any other conversation message; the `<branch-seed-excerpt>` tag is seed *input* to the LLM (constitution's Quality & Review Gates rule), not raw HTML ever rendered unsanitized in the browser. |
| VII. No Pi Extension Without Demonstrated Necessity | PASS | No Pi extension — `SessionManager.branch()`/`getEntries()`/`getTree()` are ordinary public SDK methods, already exported. |
| VIII. Comments Are Durable, Not Historical | PASS | Applies at implementation time; no plan-level concern. |
| Tech Constraints: SQLite via abstracted storage layer | PASS | New columns only, same `StorageAdapter` interface, no new backing store. |
| Tech Constraints: v1 non-goals | PASS for US1-3 / **BLOCKED for US4** | "Pi export viewing" remains an explicit non-goal until amended (spec Assumptions). This plan excludes User Story 4/FR-013 entirely rather than violating the non-goal (research.md R8) — not a violation requiring Complexity Tracking, since the corresponding work simply isn't part of this plan. |
| Quality Gate: idempotent retryable operations | PASS | `ThreadService.markDone`/`.reopen` are simple, idempotent state flips (already-done → done is a no-op 200, per contracts/thread-mode.md). |
| Quality Gate: conversation not closable with unresolved staged edits | PASS (adapted) | The same guard is reused for "cannot mark done with unresolved staged edits" (FR-010), extracted into a shared check rather than duplicated (research.md R3). |
| UI Conventions: 3-section conversation row/header layout | PASS | `ThreadModeView` is a new, distinct view (not the existing `HudPanel`/`ConversationView` header layout), so this convention doesn't directly apply; where a Thread's row does show title/action/status (e.g. the done/history list), it follows the same 3-section convention rather than inventing a new one. |
| UI Conventions: Keyboard Shortcuts registry | PASS | If implementation introduces any new bound shortcut (e.g. jump-to-next-thread), it MUST be added to `app/frontend/src/a11y/keymap-registry.ts` per existing convention; no shortcut is mandated by the spec itself. |

No unjustified violations for the in-scope User Stories 1-3 — Complexity Tracking table is not needed for them. User Story 4/FR-013 is excluded from scope rather than planned non-compliantly.

## Project Structure

### Documentation (this feature)

```text
specs/011-linear-thread-mode/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/
│   └── thread-mode.md   # Phase 1 output (/speckit-plan command) — US1-3 only
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/backend/src/
├── storage/sqlite/
│   ├── migrations.ts          # add: document.document_type column (DEFAULT 'canvas');
│   │                           #      conversation.pi_leaf_entry_id, .done_at, .seed_excerpt_text columns;
│   │                           #      extend conversation.kind CHECK constraint with 'thread-root'/'thread-branch'
│   └── index.ts                # StorageAdapter: createDocument(documentType), getThreadRoot(documentId),
│                                 #      createConversation/updateConversation accept the new fields
├── document/
│   └── document-service.ts     # create() takes documentType; 'thread' path calls ThreadService.createRoot
│                                 #      instead of ConversationService.ensureMain
├── conversation/
│   ├── thread-service.ts       # NEW: createRoot, branchFromHighlight, markDone, reopen — separate from
│   │                             #      ConversationService per data-model.md's storage-layer-changes note
│   └── seed-excerpt.ts         # add buildThreadBranchSeedMessage() wrapping highlightedText in
│                                 #      <branch-seed-excerpt> (research.md R4)
├── pi/
│   └── pi-service.ts           # add sendOnThread(thread, message, bridge): opens the thread's shared
│                                 #      session, SessionManager.branch(thread.piLeafEntryId), appends,
│                                 #      records the new leaf entry id (research.md R1) — still the only
│                                 #      module importing the Pi SDK
├── api/http/
│   ├── document.ts             # POST /api/documents accepts documentType
│   └── threads.ts              # NEW: POST .../threads/:id/{branch,done,reopen}; GET/send delegate to
│                                 #      existing conversation routes' handlers (contracts/thread-mode.md)
└── events/event-publisher.ts    # add conversation_done_changed event

app/shared/src/
├── contracts/http.ts           # CreateDocumentRequest.documentType; ConversationKind adds thread-root/
│                                 #      thread-branch; ConversationDto adds doneAt/seedExcerptText;
│                                 #      BranchThreadRequest, MarkThreadDoneResponse, ReopenThreadResponse;
│                                 #      new ErrorCode values (contracts/thread-mode.md)
├── contracts/events.ts         # conversation_done_changed envelope
└── domain/index.ts             # mirror the above on the Conversation/Document interfaces

app/frontend/src/
├── components/thread/           # NEW: ThreadModeView.vue (top-level view for documentType: 'thread'),
│   ├── ThreadModeView.vue       #      ThreadCard.vue (one segment's worth of rendering), ThreadComposer.vue
│   ├── ThreadCard.vue           #      (compose box, only mounted on a tip segment per FR-005c),
│   ├── ThreadComposer.vue       #      HighlightBranchMenu.vue (selection popover -> branch action),
│   ├── HighlightBranchMenu.vue  #      DoneThreadsPanel.vue (the done/history list, User Story 3)
│   └── DoneThreadsPanel.vue
├── composables/
│   └── useThreadSegments.ts     # NEW: derives Thread segments from a document's Thread list + messages
│                                 #      (research.md R5/data-model.md's frontend-only ThreadSegment)
├── stores/                      # new/extended store slice for the active threaded-conversation document's
│                                 #      Threads, mirroring the existing conversation store's shape
└── App.vue                      # routes to ThreadModeView instead of the canvas grid when the active
                                  #      document's documentType is 'thread'

app/backend/tests/{unit,integration,contract}/   # new/updated: thread branching (shared-session leaf
                                                  #   repositioning), done/reopen + pending-edits guard,
                                                  #   document-type-fixed-at-creation
app/frontend/tests/{unit,component}/             # new/updated: ThreadModeView, segment splitting,
                                                  #   highlight-to-branch, done declutter
tests/e2e/                                       # NEW: usN.spec.ts covering quickstart.md's 4 scenarios
```

**Structure Decision**: Existing web-application monorepo structure (`app/backend`, `app/frontend`, `app/shared`) is reused as-is. The backend addition is concentrated in one new service (`thread-service.ts`) and one new `PiService` method, plus additive schema/contract fields — no existing canvas-mode code path is modified beyond `document-service.ts`'s creation branch. The frontend addition is an entirely new, parallel top-level view (`components/thread/`), not a modification of the existing canvas/HUD components, consistent with the two modes being separate, non-interoperating thread sets (Clarifications).

## Post-Design Constitution Check

*Re-evaluated after Phase 1 (data-model.md, contracts/, quickstart.md).*

No new concerns emerged during design. The one item flagged as needing a considered decision going in — how "done" relates to the existing "closed" status — was resolved in research.md R3 (a new, orthogonal `doneAt` field, not a reuse of `status: 'closed'`) precisely because reusing `closed` would have silently pulled in canvas-specific behavior (branch-from-closed refusal, fold-summary, review flows) that this feature's Edge Cases explicitly rule out. The Pi-session strategy (research.md R1 — one shared session file per threaded-conversation document, `SessionManager.branch()` leaf-repositioning per Thread) is a genuine, deliberate divergence from canvas mode's per-conversation-session-file model; it stays fully inside `PiService`, so Principle II remains satisfied without exception. No Complexity Tracking entry is needed because this divergence isn't a violation of any principle — it's the specific mechanism FR-006 requires, isolated behind the same single Pi-integration module the constitution already mandates.

## Complexity Tracking

*No Constitution Check violations requiring justification for the in-scope User Stories 1-3 — table intentionally omitted. User Story 4/FR-013 is excluded from this plan's scope entirely (see Scope note above) rather than justified as a violation.*
