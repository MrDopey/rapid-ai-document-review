# Implementation Plan: Archivable Main Conversation

**Branch**: `006-archivable-main-conversation` | **Date**: 2026-09-06 | **Spec**: `specs/006-archivable-main-conversation/spec.md`

**Input**: Feature specification from `/specs/006-archivable-main-conversation/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Let a reviewer archive the current Main conversation and get a brand-new, empty Main in the exact
same slot, atomically, without ever leaving the document without a usable Main. Implemented almost
entirely by reuse: removing the placeholder `kind === 'main'` guard that today makes
`ConversationService.close()` refuse Main, adding a `kind === 'main'` branch to that same method
that (inside one storage transaction) closes the old Main and creates+seeds a new one using the
existing seeding mechanism, and adding one persisted `isCurrentMain` flag (enforced unique per
document, mirroring the existing `isPrimary` pattern) so "the current Main" is well-defined once a
document can have more than one `kind: 'main'` row. Branch-to-archived-parent linkage and
revision-to-archived-conversation attribution already survive archival unchanged, since neither
mechanism is deleted or rewritten by a close.

## Technical Context

**Language/Version**: TypeScript 5.9 (Node.js ≥26.1), both backend and frontend.

**Primary Dependencies**: Backend — Fastify 5 (HTTP/WS), `node:sqlite` (no ORM, hand-written SQL),
Pi SDK (agent sessions), Automerge (document CRDT). Frontend — Vue 3.5, Pinia-style stores, Vitest +
Vue Test Utils, Playwright for e2e.

**Storage**: SQLite (existing `document`/`conversation`/`staged_edit`/`revision` tables), via the
existing `StorageAdapter` interface and its one SQLite implementation
(`app/backend/src/storage/sqlite/index.ts`). This feature adds one column and one partial unique
index to the existing `conversation` table — no new tables.

**Testing**: Backend — Vitest, three tiers already in place (`tests/unit`, `tests/integration`,
`tests/contract`, the last against a real Fastify app + fake Pi session). Frontend — Vitest +
Vue Test Utils (`tests/unit`, `tests/component`). E2E — Playwright (`tests/e2e/us<N>.spec.ts`).

**Target Platform**: Self-hosted, single-user, Dockerized (per constitution's Technology &
Platform Constraints); no platform change from this feature.

**Project Type**: Web application (existing `app/backend` + `app/frontend` + `app/shared`
workspace layout) — this feature is additive within that existing structure.

**Performance Goals**: No new performance goal beyond the existing implicit one (archive-and-replace
must feel instantaneous to the reviewer, i.e. complete within a single request/transaction, not a
background job) — not a measured SC in this feature; N/A beyond that.

**Constraints**: The archive-and-replace transition MUST be atomic from the user's perspective
(FR-002) — addressed via the storage layer's existing synchronous `transaction()` helper. No new
environment variables (all `RADR_`-prefixed config is untouched).

**Scale/Scope**: Single document, v1 scope (per constitution's Technology & Platform Constraints)
— unbounded number of archived Mains per document over its lifetime (spec explicitly imposes no
cap).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. The Application Owns the Document** — PASS. No new source of document truth; archiving only
  touches `conversation` rows.
- **II. Pi Owns Agent Conversations** — PASS. The new Main is created/seeded through the same
  Pi-SDK-mediated calls (`seedMain` → `send`, and Pi-session eviction for the old Main) already
  used elsewhere; no direct Pi session-storage access is introduced.
- **III. Agent Edits Are Proposals, Not Direct Writes** — PASS. Unaffected — archiving is a
  conversation-lifecycle operation, not an edit-pipeline change. Auto-apply behavior for the *new*
  Main is unaffected (auto-apply already keys off `isPrimary`, and the new Main starts
  non-Primary per FR-007).
- **IV. CRDT-Mediated Merging, With Revisions as a Separate Concept** — PASS. No revision is
  restored or deleted by archiving; past revisions keep their existing `conversationId` pointing at
  the now-archived row, satisfying FR-011 with zero changes to revision logic.
- **V. Configurable Limits Are Enforced, Not Advisory** — PASS, and reinforced: "exactly one
  current Main per document" (FR-002/FR-006) is enforced by a database-level partial unique index
  (`conversation_one_current_main`), the same enforcement mechanism already used for
  "exactly one Primary."
- **VI. Sanitize Before Render** — PASS. No new rendering path; the new Main's seed message goes
  through the existing seed-message → Markdown rendering pipeline unchanged.
- **VII. No Pi Extension Without Demonstrated Necessity** — PASS. No Pi extension introduced;
  entirely SDK-mediated.
- **Quality & Review Gates** — PASS. Given/When/Then acceptance scenarios already exist in
  spec.md. The archive-and-replace transaction is idempotent under retry (see research.md §5 —
  the existing already-closed early-return in `close()` is checked before the new archive branch).
  A conversation still cannot be closed with unresolved staged edits (guard reused, unchanged).
  No new seed/context message is introduced that lacks the required matching-tag wrapping — the new
  Main's seed message reuses `buildMainSeedMessage`/`wrapDocumentRevision` verbatim.

No violations — Complexity Tracking is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/006-archivable-main-conversation/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/
│   └── main-archive.md   # Phase 1 output — HTTP/WS contract delta
└── tasks.md              # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

Existing web-application layout (workspace: `app/backend`, `app/frontend`, `app/shared`); this
feature touches the following existing files/directories and adds no new top-level directories:

```text
app/shared/src/
├── domain/index.ts                  # Conversation.isCurrentMain (new field)
└── contracts/http.ts                # ConversationDto.isCurrentMain; ErrorCode.CONVERSATION_BUSY
                                      # (add); ErrorCode.CANNOT_CLOSE_MAIN_CONVERSATION (remove)

app/backend/src/
├── storage/
│   ├── storage-adapter.ts           # ConversationRow.isCurrentMain; getMainConversation query
│   └── sqlite/
│       ├── migrations.ts            # +column, +partial unique index, +versioned migration
│       └── index.ts                 # createConversation/updateConversation/getMainConversation SQL
├── conversation/
│   ├── conversation-service.ts      # close(): remove kind==='main' guard, add archive branch +
│   │                                 # ConversationBusyError; new archiveMain(documentId)
│   ├── conversation-mapper.ts       # buildConversationDto: isCurrentMain passthrough
│   └── primary-service.ts           # unchanged — closeClears() reused as-is
└── api/http/conversations.ts        # handleConversationError: +CONVERSATION_BUSY,
                                      # -CANNOT_CLOSE_MAIN_CONVERSATION

app/frontend/src/
├── components/conversation/ConversationView.vue   # archiveOrReviewAction: drop kind!=='main' gate
└── composables/conversationStatusBadges.ts        # + archived-Main badge

tests/
├── (backend) app/backend/tests/unit/…             # migration backfill, ConversationBusyError
├── (backend) app/backend/tests/integration/…       # transactional archive-and-replace
├── (backend) app/backend/tests/contract/…          # http.test.ts: replace the now-obsolete
│                                                    # CANNOT_CLOSE_MAIN_CONVERSATION case
├── (frontend) app/frontend/tests/component/…       # Archive action visible for Main; badge
└── (e2e) tests/e2e/us9.spec.ts                     # new — US1–US3 end-to-end
```

**Structure Decision**: No new project/package — this feature is entirely additive within the
existing `app/backend` + `app/frontend` + `app/shared` workspace, following the existing
conversation-lifecycle code paths (`close()`, `ensureMain()`/`seedMain()`, `PrimaryService`) rather
than introducing a parallel subsystem.

## Post-Design Constitution Check

Re-checked after Phase 1 (data-model.md, contracts/main-archive.md, quickstart.md): no new
violations introduced by the concrete design. The one new error class (`ConversationBusyError`)
and one new persisted field (`isCurrentMain`) are both minimal, single-purpose additions that
directly implement an already-stated FR (FR-004, FR-002/FR-006 respectively) rather than
speculative infrastructure — consistent with Principle VII's YAGNI framing. Gate: PASS.

## Complexity Tracking

*No violations to justify — table intentionally omitted.*
