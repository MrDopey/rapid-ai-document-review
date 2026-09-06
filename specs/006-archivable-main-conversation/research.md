# Research: Archivable Main Conversation

All three spec-level ambiguities were resolved via user clarification before this research phase
(see `spec.md` → Clarifications → Session 2026-09-06); no `NEEDS CLARIFICATION` markers remain in
the Technical Context. This document instead resolves the *implementation-level* unknowns needed
to plan the feature against the actual codebase.

## 1. How does the system currently prevent Main from being closed, and why?

- **Decision**: Remove the `conversation.kind === 'main'` early-throw guard in
  `ConversationService.close()` (`app/backend/src/conversation/conversation-service.ts:407-415`,
  `CannotCloseMainConversationError`) and replace it with a `kind === 'main'` branch that performs
  archive-and-replace instead of a bare close.
- **Rationale**: The guard's own doc comment (lines 45-55) and the thrown message explicitly name
  `specs/006-archivable-main-conversation` as the reason it exists — it is a placeholder for this
  feature, not an independent invariant to preserve. The `CANNOT_CLOSE_MAIN_CONVERSATION` error
  code, its contract test (`app/backend/tests/contract/http.test.ts:865-871`), and the frontend
  gate that hides the "Archive" action for `kind === 'main'`
  (`ConversationView.vue:494`) all exist for the same reason and are removed/changed together.
- **Alternatives considered**: Leaving `close()` untouched and adding a wholly separate code path
  for Main. Rejected — the spec's own Assumptions section says archiving Main "reuses the existing
  archive/close mechanics (and their preconditions)"; branching inside the one existing method
  keeps the pending-edits guard, the Primary-clearing call, and the Pi-session eviction all
  written once.

## 2. How is "the current Main" distinguished from an archived one at the data layer?

- **Decision**: Add a persisted boolean `isCurrentMain` (DB column `is_current_main`) to the
  `conversation` table/type, defaulting to `0`/`false`, set `true` only on the one Main row that is
  current. Enforce "at most one current Main per document" with a partial unique index —
  `CREATE UNIQUE INDEX conversation_one_current_main ON conversation (document_id) WHERE
  is_current_main = 1` — the same pattern already used for `is_primary`
  (`conversation_one_primary`, `migrations.ts:83-84`). `getMainConversation(documentId)` is updated
  from `WHERE kind = 'main'` (assumes exactly one row ever) to `WHERE kind = 'main' AND
  is_current_main = 1`.
- **Rationale**: `kind` alone can no longer identify "the" Main once more than one `kind='main'` row
  can exist per document (FR-006). Reusing `status <> 'closed'` as an implicit "is current" signal
  was considered but rejected: it conflates two independent concepts (open-vs-closed and
  current-vs-archived-Main) and would silently break if a future conversation status other than
  `closed` were added. An explicit column, enforced the same way `is_primary` already is, keeps the
  "exactly one current Main" invariant (FR-002, FR-006, edge case in spec.md) checkable by the
  database itself rather than only by application logic (Constitution Principle V: limits/invariants
  are enforced, not advisory).
- **Migration**: A fresh install gets the column via the `CREATE TABLE` body in `STATEMENTS`
  (`migrations.ts:54-84`). An existing install needs a new versioned migration (`MIGRATIONS`
  array, `migrations.ts:170-183`) that (a) adds the column via `addColumnIfMissing`, (b) backfills
  `is_current_main = 1` on each document's existing single `kind = 'main'` non-closed row, then (c)
  creates the partial unique index — mirroring the existing "additive `ALTER TABLE`, no data loss"
  policy documented at `migrations.ts:148-164`.

## 3. Reusing the archived-conversation read-only guarantees

- **Decision**: Archiving Main sets `status: 'closed'` (the existing terminal status), exactly as
  any other close does. No new `ConversationStatus` value is introduced.
- **Rationale**: `toConversationDto`'s `readOnly: row.status === 'closed'` and `canEdit`/`canBranch`
  (`status !== 'closed'`) in `conversation-mapper.ts:86-87,91` already give every closed
  conversation — Main included, once the guard is removed — the exact "cannot receive messages, be
  branched from, or be reopened" guarantee FR-003 asks for, with zero new derived-field logic.
  "Cannot be re-designated Primary" is likewise already true: `PrimaryService` only ever targets a
  conversation via an explicit designate call, and closed conversations are excluded from that flow
  today (`PrimaryConversationClosedError`) independent of `kind`.
- **Alternatives considered**: A dedicated `'archived'` status distinct from `'closed'`. Rejected —
  the spec explicitly frames archiving as "the same archive action already available for other
  conversation kinds" (FR-001) producing "the same guarantees closed conversations already have"
  (FR-003); introducing a parallel status would duplicate every `status === 'closed'` check across
  the codebase for no behavioral difference.

## 4. The mid-response ("working") close guard FR-004 requires

- **Decision**: Add a server-side guard in `ConversationService.close()` — throw a new
  `ConversationBusyError` (mapped to a new `CONVERSATION_BUSY` / 409 error code) when
  `conversation.status === 'working'`. This applies uniformly to every `kind`, so archiving Main
  reuses it exactly like every other close does.
- **Rationale**: Research found the "don't close while working" behavior enforced only
  client-side today (`ConversationView.vue`'s send button disables while `status === 'working'`;
  no such check exists inside `close()` itself). The spec's edge case explicitly requires this
  guard for Main archival ("applies the same guard used elsewhere for closing a busy
  conversation") and FR-004 requires it be the *same* precondition as any other close. The
  precedent for this exact kind of guard already exists one module over —
  `PrimaryService`'s `PrimaryTargetBusyError` (`primary-service.ts:18,92-102`) checks
  `status === 'working'` before allowing a Primary-designation change — so the new error follows
  that established naming/shape convention.
- **Alternatives considered**: Enforcing this only inside the new Main-archive branch, leaving
  ordinary `close()` unguarded. Rejected — FR-004 requires the *same* precondition set as ordinary
  close, and leaving the gap unfixed for non-Main conversations would mean Main archival is
  actually *more* strictly guarded than the "existing" mechanics it's supposed to reuse, which
  contradicts the reuse assumption in spec.md's Assumptions section.

## 5. Where the archive-and-replace operation is implemented and how it stays atomic

- **Decision**: A new `ConversationService.archiveMain(documentId)` method, invoked from `close()`
  when `conversation.kind === 'main'` (so the one public `POST /api/conversations/:id/close` route
  keeps working for Main, per the "same archive action already available for other conversation
  kinds" requirement — FR-001). The existing already-closed idempotent early-return
  (`close()`, lines 416-423) is checked **before** the `kind === 'main'` archive branch, so a
  retried/duplicated close call against an already-archived Main is a no-op exactly like retrying
  close on any other already-closed conversation — it never spawns a second replacement Main
  (Quality & Review Gates: retryable operations MUST be idempotent). It:
  1. Loads the current Main via `getConversationOrThrow`, re-checks the pending-edits and
     `working`-status guards (shared with regular `close()`).
  2. Wraps the two writes in `this.storage.transaction(() => { ... })`
     (`storage-adapter.ts:214-221`, already used by other multi-write flows per
     `sqlite/index.ts:717-724`'s doc comment) so old-Main-closed and new-Main-created commit or
     roll back together — this is what makes FR-002's "document MUST NOT be observably left
     without a current Main at any point" true at the storage layer, not just in application
     sequencing:
     - Update the old Main row: `status: 'closed'`, `closedAt`, `isCurrentMain: false`.
     - Insert the new Main row: `kind: 'main'`, `isCurrentMain: true`, `isPrimary: false`
       (FR-007), `parentId: null`, fresh `piSessionPath`, `contextRevision:
       document.currentRevision`.
  3. Outside the transaction (mirroring `close()`'s existing ordering of DB-write-then-publish):
     if the old Main was Primary, call `primaryService.closeClears` (FR-007, reused verbatim);
     publish `conversation_closed` for the old Main and `conversation_started` for the new one
     (reusing both existing event names — no new WS event type); evict the old Main's Pi session
     (reusing the existing eviction call already in `close()`); call `this.seedMain(...)` for the
     new conversation (FR-008, reusing the exact function `ensureMain` already calls at document
     creation, `conversation-service.ts:191-211`).
- **Rationale**: Every sub-step reuses an existing, already-tested primitive
  (`primaryService.closeClears`, `seedMain`, `publish`, Pi-session eviction, `transaction`); the
  only genuinely new logic is "close old + create new inside one transaction," which is a thin
  wrapper. This keeps the change small and auditable, consistent with the constitution's YAGNI
  framing (Principle VII) even though that principle is stated about Pi extensions specifically —
  the same minimal-new-surface reasoning applies here.
- **Alternatives considered**: A separate `POST /api/conversations/:id/archive-main` endpoint
  distinct from `close`. Rejected — FR-001 requires the *same* archive action UI/API surface as
  every other conversation kind, and `ConversationView.vue`'s existing `archiveOrReviewAction`
  computed already calls the generic close/archive dialog; special-casing the route would force
  the frontend to branch on `kind` at the call site instead of at the one place
  (`close()`) that already knows how to special-case Main internally.
- A dedicated `MainArchiveService` (mirroring `ReviewService`'s separation from
  `ConversationService`) was considered for the archive-and-replace logic. Deferred as an
  implementation-detail choice for the tasks phase, not a planning blocker — `ensureMain`/`seedMain`
  already live directly on `ConversationService`, and `archiveMain` is tightly coupled to both, so
  keeping it alongside them avoids a cross-service dependency for no isolation benefit today.

## 6. Frontend surface: where the "Archive" action and an archived-Main badge belong

- **Decision**: In `ConversationView.vue`'s `archiveOrReviewAction` computed
  (lines 489-498), drop the `conversation.value.kind !== 'main'` condition so the branch at line
  494 applies to Main too — the label stays "Archive" (already the wording used for every other
  kind; the constitution's own UI-conventions text is stale on this point, still saying "Close",
  per research §2 in the prior investigation). No new component is needed for the action itself.
- For distinguishing an archived Main from the current Main and from each other (FR-010, SC-004),
  extend `useConversationStatusBadges` (`conversationStatusBadges.ts:51-99`), the single composable
  already shared by `HudPanel.vue`, `ConversationThreadBox.vue`, and `ConversationView.vue`, with a
  badge keyed off `kind === 'main' && status === 'closed'` (i.e., an archived Main specifically, not
  every closed conversation) — e.g. an "Archived Main" badge — rather than inventing a
  per-component rendering path. This automatically reaches every surface that already renders that
  composable's badges.
- **Rationale**: Both changes are additive to existing, already-shared code paths (one computed,
  one composable) rather than new components, matching the constitution's UI Conventions section
  (single middle-slot action; shared badge rendering).

## 7. Test placement

- **Decision**: Follow the existing per-user-story convention exactly:
  - Backend: `app/backend/tests/unit/` (new pure-logic cases, e.g. the `isCurrentMain` migration
    backfill, `ConversationBusyError` triggering), `app/backend/tests/integration/` (the
    transactional archive-and-replace against a real SQLite file), `app/backend/tests/contract/`
    (HTTP route behavior — replacing the now-obsolete `CANNOT_CLOSE_MAIN_CONVERSATION` test at
    `http.test.ts:865-871` with an assertion that closing Main now succeeds and archives instead).
  - Frontend: `app/frontend/tests/component/` (badge rendering, Archive action visibility for
    Main), `app/frontend/tests/unit/` (store handling of the archive response).
  - E2E: a new `tests/e2e/us9.spec.ts` (continuing this repo's `us<N>.spec.ts` numbering; the next
    unused number after the existing `us1`–`us8`), covering the archive → new-Main-in-place →
    branch-survives → attribution-preserved flow across US1–US3.
- **Rationale**: Matches the codebase's own established test taxonomy exactly (per the earlier
  codebase research), so no new test infrastructure or conventions are introduced by this feature.
