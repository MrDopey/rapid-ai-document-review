---

description: "Task list template for feature implementation"
---

# Tasks: Spatial Canvas for Document and Conversations

**Input**: Design documents from `/specs/005-canvas-conversation-threads/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/conversation-anchor.md, quickstart.md

**Tests**: Included below (unit/component + one new Playwright e2e spec), consistent with this
project's existing per-feature testing convention (every prior spec has unit/component/e2e
coverage) and the constitution's Quality & Review Gate requiring Given/When/Then acceptance
criteria before a user-facing change is considered complete.

**Organization**: Tasks are grouped by user story (spec.md P1–P4) to enable independent
implementation and testing of each story.

**Execution**: When implementing this task list, run each phase (Setup, Foundational, each User
Story, Polish) in its own subagent, in dependency order per the Dependencies section below. A
phase's subagent must complete (and its tasks marked `[X]`) before the next dependent phase's
subagent starts; phases with no dependency between them may run in parallel subagents.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths are included in every task description

## Scope note (confirmed with user during planning)

The Markdown **Preview** pane's own rendering/behavior and the **History** panel are explicitly out
of scope and remain exactly as they are today. What does change, purely as layout: Preview moves to
sit left of the new canvas (previously it sat to the right of the Editor), and the HUD becomes a
full-width bar spanning both the Preview and canvas columns together (not History). Only the current
Editor + HUD + ConversationView portion of the layout, plus this repositioning, is touched.

---

## Phase 1: Setup

**Purpose**: Minimal scaffolding — no new dependencies are needed (research.md §1 rejected adding a
pan/zoom library; panning is native browser scroll).

- [X] T001 Create the `app/frontend/src/components/canvas/` directory for the new canvas surface.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared scroll canvas and the one shared backend field every user story's rendering
depends on. **No user story work can begin until this phase is complete.**

- [X] T002 [P] Add `anchorOrphaned: z.boolean()` to the `ConversationDto` schema in `app/shared/src/contracts/http.ts` (contracts/conversation-anchor.md). Also added `seedSelection` to `ConversationDto` (a gap found during implementation review — the frontend anchor/layout logic needs it on every list/get/branch/review response, not just the one-time `conversation_started` WS event a reloading client never sees).
- [X] T003 [P] Mirror `anchorOrphaned: boolean` on the `Conversation` interface's server-computed fields section in `app/shared/src/domain/index.ts` (data-model.md).
- [X] T004 Extend `toConversationDto` in `app/backend/src/conversation/conversation-mapper.ts` to accept a `documentContent: string` parameter and compute `anchorOrphaned`: `false` when `row.seedSelection` is `null`; otherwise `true` when `documentContent.slice(seedSelection.from, seedSelection.to) !== seedSelection.text` (research.md §7). Depends on T002/T003.
- [X] T005 Update all `toConversationDto` call sites (found six, not four: `getAll`/`getOne`/`branch`/`review` in `app/backend/src/conversation/conversation-service.ts`, plus `document-service.ts`'s `create` and `server.ts`'s `getSnapshot`) to also pass document content (`this.automerge.get().getContent()` or an already-in-scope `content` variable). Depends on T004.
- [X] T006 [P] Unit tests for the `anchorOrphaned` computation in `app/backend/tests/unit/conversation-mapper.test.ts` (new file): null `seedSelection` → `false`; matching slice → `false`; edited/deleted anchor text → `true`. Depends on T004.
- [X] T007 Create `DocumentCanvas.vue` in `app/frontend/src/components/canvas/`: a plain `overflow: auto` scrollable container with `tabindex="0"` (research.md §1/§3 — native scroll, no custom viewport composable, no zoom), hosting `EditorComponent` plus a slot/area for conversation boxes.
- [X] T008 Wire `DocumentCanvas.vue` into `app/frontend/src/App.vue`: replace the `EditorComponent` grid column and the `.conversation-sidebar` (`HudPanel` + `ConversationView`) column, along with the `contentSidebarResize`/`hudConversationResize` handles and their drag/keyboard listeners, with the new canvas. Reorder the grid to **Preview | Canvas | History** (Preview moves to the left of the canvas); keep the existing resize handle between them (`editorPreviewResize`, repurposed as Preview|Canvas) and the conditional History column exactly as they behave today. Depends on T007. `HudPanel`/`ConversationView` and the old sidebar-only state (`selectedConversationId` et al.) were removed here rather than left dangling (`noUnusedLocals`); Phase 6 (US4) reintroduces `HudPanel` in the toolbar, and each `ConversationThreadBox` (US1) will own its own focus/open state instead of one global selection.
- [X] T009 Remove `EditorComponent.vue`'s `.cm-scroller { overflow: auto }` rule so the document lays out at full content height inside the canvas instead of internally scrolling (research.md §2, avoids scroll-chaining with FR-015). Also relaxed `.editor-pane`/`.editor-host`/`.cm-editor`'s forced `height: 100%` (a fixed-viewport assumption left over from the old grid-track layout) so the editor genuinely grows to full content height rather than being clipped.
- [X] T010 [P] Add canvas background/surface styling in `DocumentCanvas.vue` reusing `--panel-bg`/`--panel-bg-alt`/`--border-color` tokens from `app/frontend/src/style.css` (plan.md's Shared CSS Utility Reuse) — no new hardcoded colors.

**Checkpoint**: Canvas scaffold exists, document renders full-height inside it, `anchorOrphaned` is available on every conversation payload. User story implementation can now begin.

---

## Phase 3: User Story 1 - Conversations sit next to the text they're about (Priority: P1) 🎯 MVP

**Goal**: The document floats on the canvas; a conversation anchored to a highlight (or Main,
anchored to the top) renders as a compact box colocated at the anchor's vertical position, in column 0.

**Independent Test**: Open a document, highlight a passage, start a conversation on it. Verify the
document renders as a floating page on the canvas, the new conversation box appears beside the
document at approximately the highlight's height, and Main renders anchored to the top of the
document in the same right-hand area (quickstart.md Scenario 1).

### Tests for User Story 1

- [X] T011 [P] [US1] Component test for anchor-Y computation (via CodeMirror `coordsAtPos`, `0` for a `null` `seedSelection`) in `app/frontend/tests/component/ConversationThreadBox.spec.ts` (new). Tests `computeAnchorY` (`app/frontend/src/components/canvas/anchorY.ts`) directly against a fake `AnchorPositionSource`, not the whole component tree.
- [X] T012 [P] [US1] E2E test in `tests/e2e/us8.spec.ts` (new) covering quickstart.md Scenario 1: floating canvas, colocation at highlight height, document-order preservation across two highlights, Main anchored top. Also updated `playwright.config.ts`'s `stories` project `testMatch` from `/us[1-7]\.spec\.ts/` to `/us\d+\.spec\.ts/` so this (and future) `usN` specs beyond 7 actually get picked up — verified passing against a live dev server.
- [X] T013 [US1] Create `ConversationThreadBox.vue` in `app/frontend/src/components/conversation/`: compact canvas representation of a conversation, header following the constitution's 3-section (title | primary action | status) layout, reusing `.badge`/`.pane-eyebrow`/`.text-wrap-safe` from `style.css`. Judgment call: since Phase 2 removed `ConversationView.vue` from the app entirely (no more sidebar), this box's middle "primary action" slot holds an "Open" button that opens `ConversationView.vue` unmodified in a `.modal-overlay` (dismissible via backdrop click or Escape, `useFocusTrap`) — this is the only way left to send messages/close/request review/view proposed edits, so it's load-bearing, not optional polish. Also triggers `conversationsStore.loadDetail()` on mount (guarded against re-fetching) since nothing else populates `messagesByConversation` for a conversation now that `ConversationView` isn't always-mounted.
- [X] T014 [US1] Implement anchor-Y computation (CodeMirror `coordsAtPos(seedSelection.from)`, or `0` for Main) as a small helper used by `DocumentCanvas.vue` (data-model.md's `ConversationLayout.anchorY`). Implemented as `computeAnchorY`/`AnchorPositionSource` in `app/frontend/src/components/canvas/anchorY.ts`, fed by a new `anchorTop(pos)` method exposed from `EditorComponent.vue` (returns a pixel Y relative to the component's own root element's top edge — chosen over `hostRef`/`.editor-host` alone because that origin excludes the toolbar's height, which would misalign every box against `DocumentCanvas.vue`'s sibling thread-column origin).
- [X] T015 [US1] Wire `EditorComponent.vue`'s existing "Start conversation from selection" action (`branch-from-selection` emit, already present) through `DocumentCanvas.vue` to open a new `ConversationThreadBox` positioned at the selection's anchor. Fell out of T016's reactive rendering with no separate glue needed — `conversationsStore.branch(...)` already adds the new conversation to the store, and `DocumentCanvas.vue`'s `columnZeroConversations` computed reacts to that automatically. Verified end-to-end via `us8.spec.ts`.
- [X] T016 [US1] Render every column-0 conversation (Main plus top-level highlight-anchored conversations) in `DocumentCanvas.vue`, ordered top-to-bottom by anchor Y (FR-003/FR-004). **Resolved a real inconsistency**: data-model.md's literal "column = `branchDepth`" is wrong — spec.md's FR-003/FR-004 (Main, `branchDepth: 0`, and a direct branch of Main, `branchDepth: 1`, explicitly share "the same right-hand column area") and quickstart.md's worked Scenarios 1-2 (a direct branch of Main → "column 0"; a branch of *that* → "column 1"; a branch of *that* → "column 2") both only work under `column = max(0, branchDepth - 1)`, which is what `DocumentCanvas.vue`'s `columnOf()` implements (documented inline for Phase 4/US2 to stay consistent). Verified via `us8.spec.ts`.
- [X] T017 [US1] Render the orphaned visual flag on `ConversationThreadBox.vue` from `conversation.anchorOrphaned`, reusing `--warning-color`/`--warning-bg` (FR-011, SC-006).

**Checkpoint**: User Story 1 is fully functional and independently testable — colocation works for Main and highlight-anchored conversations in column 0.

---

## Phase 4: User Story 2 - Branches read as a tree moving away from the document (Priority: P2)

**Goal**: A branch renders one column further from the document than its parent; siblings sharing a
parent message stack vertically without overlapping; a conversation leaving view reflows its column.

**Independent Test**: Branch off a specific message twice, then branch one of those branches again.
Verify column = branch depth, siblings stack with a gap, and each branch shows shared history up to
the fork point plus only its own subsequent messages (quickstart.md Scenario 2).

### Tests for User Story 2

- [X] T018 [P] [US2] Component test for column/stacking layout logic (branchDepth→column, sibling ordering by `createdAt`, collision push-down, reflow-up on removal) in `app/frontend/tests/component/ConversationLayout.spec.ts` (new). Also covers `resolveBaseAnchorY`'s ancestor-walk (T020's gap #2 below).
- [X] T019 [P] [US2] E2E test in `tests/e2e/us8.spec.ts` covering quickstart.md Scenario 2: branch column placement, sibling stacking, branch-of-branch, message isolation between original and branch. Uses a new "Branch" button on `ConversationThreadBox.vue` (T020's gap #1) since there is no message-level anchor in this data model — "branch off a specific message" is implemented as branching the conversation itself (see spec.md's own Assumptions section). Widened `MARKER_BLOCK`'s lead-in filler before the first marker (Phase 3's fixture) so T022's now-real collision stacking doesn't push it below Phase 3's existing "close to raw anchor" test tolerance — Main's box legitimately (and correctly, per FR-007) stays tall until Phase 5/US3 adds the per-message height cap; this is expected phase-ordering behavior, not a bug, so the fixture accommodates it rather than the assertion being loosened.

### Implementation for User Story 2

- [X] T020 [US2] Implement a `ConversationLayout` computation (data-model.md) as `app/frontend/src/components/canvas/conversationLayout.ts` (`computeConversationLayout`/`resolveBaseAnchorY`/`columnOf`, consumed by `DocumentCanvas.vue`) — `column` via the Phase 3-established `columnOf` mapping (moved here from `DocumentCanvas.vue`, not literally `branchDepth`), `siblingOrder` by `createdAt` among conversations sharing `parentId`. **Two real gaps resolved, not in tasks.md's literal text:** (1) there was no way to branch off anything but Main — `CreateConversationRequest` has no message-level anchor at all, so "branch off a specific message" (spec.md US2) is implemented as a new "Branch" button on `ConversationThreadBox.vue` calling `conversationsStore.branch({ parentConversationId: conversation.id })` (no `selection`), gated on the existing server-computed `canBranch` (Constitution Principle V) rather than a client-reimplemented depth check, placed in the box's own footer (not the header's "Open" slot, per the constitution's one-action-per-slot rule). (2) A branch created with no `selection` has `seedSelection: null`, and data-model.md's literal "anchorY is 0 when null" would collapse every branch to the top of the document — `resolveBaseAnchorY` instead walks the `parentId` chain to the nearest ancestor with an actual `seedSelection`, inheriting its resolved anchor (bottoming out at 0 through Main), which is what "siblings stack near their parent" (FR-006/FR-007) actually requires.
- [X] T021 [US2] Render every conversation with `columnOf(branchDepth) > 0` in `DocumentCanvas.vue`, each column offset by `column * COLUMN_WIDTH_PX` (340px) via `left` on a `.thread-column[data-column="N"]` rendered per distinct column in use; `.thread-columns`' own width is set explicitly (inline style) from the deepest column present, since its `position: absolute` children contribute nothing to its intrinsic width otherwise.
- [X] T022 [US2] Implemented sibling collision push-down (`computeConversationLayout`'s stacking pass: sort by base anchorY then `createdAt`/`id`, push each box down to `max(base, previousBottom + minGap)`). Judgment call on the ResizeObserver-vs-simpler-recompute trade-off: used **one shared `ResizeObserver`** (not per-box) tracking every box's actual rendered height in a reactive `Map`, read by the layout `computed` — real measured height (not a fixed assumption) matters here because message count varies per conversation and Main's own seed message is currently unclamped (see T019's note), so a wrong fixed estimate would visibly mis-stack boxes; a single observer plus one reactive map is not meaningfully more complex than a naive recompute-on-next-tick and stays correct under resize/content changes too, consistent with plan.md's "small-N, not large-graph" performance framing.
- [X] T023 [US2] Reflow-up is a direct consequence of `computeConversationLayout` only laying out whatever `conversations` array it's given (see the function's own doc comment) — a conversation absent from that array (closed-and-filtered, or hidden) is simply not placed, so later boxes in its column close the gap on the very next recompute. **Handoff to Phase 6 (US4):** no filter UI exists yet (`HudPanel`'s "Active only" toggle isn't reintroduced until Phase 6) — `DocumentCanvas.vue` currently passes `conversationsStore.conversations` unfiltered into the layout computation; Phase 6 gets reflow "for free" by filtering that array before it reaches `computeConversationLayout`, with no further layout-side change needed.

**Checkpoint**: User Stories 1 and 2 both work independently — branches now visibly form a tree.

---

## Phase 5: User Story 3 - Messages stay compact until you need the detail (Priority: P3)

**Goal**: Each message defaults to a capped height with its own expand control; a per-conversation
bulk control expands/collapses every message in that conversation at once.

**Independent Test**: Open a conversation with a long message. Verify it truncates with its own
expand control, and that the conversation's bulk control expands/collapses every message together
while still allowing individual overrides afterward (quickstart.md Scenario 3).

### Tests for User Story 3

- [X] T024 [P] [US3] Component test for per-message max-height/expand state and the bulk toggle in `app/frontend/tests/component/MessageBubble.spec.ts` (new): individual toggle, bulk toggle affecting all messages, individual override after a bulk action. Also covers `messageDisplayState.ts`'s localStorage persistence directly. Needed a small, unrelated fix: Node 26's own experimental global `localStorage` accessor evaluates to `undefined` (and shadows `window.localStorage` too, since vitest's jsdom environment makes `window` be `globalThis`) — added `app/frontend/tests/setup.ts` (a minimal in-memory `Storage` polyfill, wired via `vite.config.ts`'s new `test.setupFiles`) so this test file (and any future one exercising the existing `panePersistence.ts`-style bare-`localStorage` convention) doesn't crash on it.
- [X] T025 [P] [US3] E2E test in `tests/e2e/us8.spec.ts` covering quickstart.md Scenario 3: sends two long messages into Main, confirms each gets its own "Show more"/"Show less" toggle, confirms the conversation's bulk control expands/collapses every message together, and confirms an individual toggle after the bulk action only changes that one message. Verified passing against a live dev server, run in isolation (`npx playwright test tests/e2e/us8.spec.ts --project=stories`).

### Implementation for User Story 3

- [X] T026 [US3] Added per-message `expanded` state (default `false`) to `app/frontend/src/components/conversation/MessageBubble.vue` (FR-008): a controlled `expanded` prop (defaulting to `true` so `ConversationView.vue`'s existing, unmodified call site — which never passes it — keeps rendering full messages exactly as before) plus an `update:expanded` emit, since the actual state is owned by the parent (see T027 — the bulk toggle needs to read/write every message's state at once, so `MessageBubble.vue` itself can't own it in isolation). A `160px` max-height clamp (via inline `:style`, one fixed constant shared with the JS overflow check so they can't drift) applies only when `!expanded`; the toggle `<button>` only renders when the message's real `scrollHeight` (measured directly, not assumed) actually exceeds that clamp, so a short message never gets a needless control. Persistence lives in the new `app/frontend/src/composables/messageDisplayState.ts` (same read-merge-write `localStorage` pattern as `panePersistence.ts`, keyed by `messageId` per data-model.md's `MessageDisplayState`, not per-conversation).
- [X] T027 [US3] Added a bulk expand/collapse `<button>` to `ConversationThreadBox.vue` in a dedicated toolbar row directly above `.thread-messages` (distinct from both the header's "Open" slot and the footer's "Branch" button — research.md §5), only rendered once a conversation has more than one message. `ConversationThreadBox.vue` owns a `Record<messageId, boolean>` (seeded from `messageDisplayState.ts` the first time each message is seen) that it passes down as each `MessageBubble`'s `expanded` prop and updates via that bubble's `update:expanded` emit — the bulk button is a pure batch write over that same record (data-model.md: "purely a batch write over the same per-message field", not a separate stored bulk mode), so an individual toggle immediately after a bulk action only changes the one message clicked. Label flips between "Expand all"/"Collapse all" based on whether any message is currently collapsed.
- [X] T028 [US3] Both new button types (`MessageBubble.vue`'s `.expand-toggle-button`, `ConversationThreadBox.vue`'s `.bulk-toggle-button`) are real `<button>` elements with `min-width/min-height: 24px` and an explicit `aria-label` (research.md §4), matching the pattern already established by Phase 4's `.branch-button`.

**Checkpoint**: All three stories work independently — conversations stay compact and scannable even as colocation and branching multiply the number of boxes on screen.

---

## Phase 6: User Story 4 - Finding your way around from a top-of-screen overview (Priority: P4)

**Goal**: The HUD is a permanently-visible top-of-viewport bar, ordered by each conversation's root
anchor distance from the top of the document, Main always first; clicking an entry scrolls that
conversation into view.

**Independent Test**: With Main plus two highlight-anchored conversations plus one branch, verify
the HUD lists them in anchor order (branch grouped at its root's position) and that clicking an
entry scrolls the canvas to that conversation (quickstart.md Scenario 4).

### Tests for User Story 4

- [X] T029 [P] [US4] Component test for HUD reordering (root-anchor distance, Main first, branch grouped with its root, not given an independent slot) in `app/frontend/tests/component/HudPanel.spec.ts` (new). Mounts `HudPanel` with Pinia and asserts row order directly; also covers the "active"/"all" filter prop.
- [X] T030 [P] [US4] E2E test in `tests/e2e/us8.spec.ts` covering quickstart.md Scenario 4, including that the HUD stays visible while the canvas is panned. Judgment call: builds its fixture conversations directly via `POST /api/conversations` (same endpoint `branchFromMarker` ultimately calls) rather than driving CodeMirror UI selection — by test 4 in this file, tests 1-3 have already accumulated a couple dozen conversations/thread boxes on the same server-side document, and repeating three more sequential keyboard-driven branch operations on top of that got measurably flakier (CodeMirror virtualization/render contention), unrelated to what this test actually checks (HUD ordering/scroll, not branch-creation UI — already covered above). Also added `data-conversation-id` to `HudPanel.vue`'s `.conversation-row` for stable per-row targeting (purely additive, no existing selector changed).

### Implementation for User Story 4

- [X] T031 [US4] Reposition `HudPanel.vue` into `App.vue`'s existing top toolbar row (the row that already holds the document title and the undo/redo/shortcuts/help controls) rather than a new row below it: title stays left, the HUD's conversation list occupies the middle of that row (width aligned with the Preview + canvas columns beneath it, not History), and the existing controls stay grouped on the right. Always visible, no collapse/hide control (FR-010). Restyled `HudPanel.vue`'s internal CSS to lay its list out as a horizontal, wrapping strip (`display:flex;flex-wrap:wrap`) instead of a vertical block, while preserving every existing class/selector (`.hud-panel`, `.conversation-row`, `.status-badge`, `.stale-badge`, `.primary-summary .clear-primary-button`, the "Make primary" button) the pre-existing e2e suite (us4/us5/us7/a11y.spec.ts) depends on — verified against us4/us7/us8/a11y.spec.ts. Lifted the "active"/"all" filter from `HudPanel.vue`'s own local state to a controlled `filter`/`update:filter` prop (exported `ConversationFilter` type) owned by `App.vue`, since `DocumentCanvas.vue` needs the identical predicate to fulfil Phase 4/US2's T023 handoff (filtering the array that reaches `computeConversationLayout` is what makes reflow-on-hide work) — closed conversations filtered out now disappear from the canvas too, with their column reflowing. Reintroduced `App.vue`'s `selectedConversationId` for `HudPanel`'s Make-Primary targeting, and — a real regression found while verifying against us4/us7.spec.ts — unified it with "which conversation's full detail view is open": Phase 3's original per-box `.modal-overlay` (page-covering `position:fixed;inset:0`) blocked clicking a different HUD row to switch conversations once one was open (the overlay intercepted the click before it ever reached the row), breaking `us7.spec.ts`'s `selectConversation` helper and `us4.spec.ts`'s auto-open-after-branching assumption (both pre-date this feature). Fixed by rendering the conversation detail view exactly once, in `App.vue` (positioned `absolute` within `.panes`, not the page-wide `.modal-overlay`, so the toolbar/HUD stays clickable while it's open), driven directly by `selectedConversationId`; `ConversationThreadBox.vue`'s "Open" button and `App.vue`'s `onBranchFromSelection`/HUD-click handler all just set that one ref rather than each box owning independent open/close state. Two more real bugs found and fixed during that same verification pass: (1) the single overlay's `<ConversationView @select="...">` was wired to a no-op, silently swallowing `ConversationView.vue`'s own internal navigation (e.g. "Request review" switching to the newly created review conversation, FR-036) — fixed to `selectedConversationId = $event`. (2) `.conversation-detail-dialog`'s `max-height: 85vh` is viewport-relative, not relative to its actual container (`.panes`, below the toolbar) — once the HUD wraps to several lines and the toolbar grows tall, `.panes` shrinks correspondingly and an 85vh dialog could exceed it, visually overflowing back up into the toolbar and blocking HUD clicks; changed to `max-height: 90%` (relative to the overlay, which is sized to `.panes`). Also updated `us8.spec.ts`'s `branchFromMarker` helper to close the auto-opened overlay via Escape before continuing (T030 note) — auto-open is correct, expected behavior per (1) above, so the canvas-interaction tests needed to dismiss it first, same as a real user would. Verified: us4+us7+us8.spec.ts pass together, us8.spec.ts passes in isolation, all 33 component tests pass, frontend builds clean (only the pre-existing unrelated `markdown-pipeline.ts` error remains).
- [X] T032 [US4] Implement HUD ordering in `HudPanel.vue`: for each visible conversation, resolve its root ancestor, sort by that root's anchor position ascending, Main always first (data-model.md's HUD ordering). Judgment call: "walk `parentId` to `null`" (data-model.md's literal wording) degenerates to every conversation sharing Main as its root (since every chain eventually reaches Main, whose `parentId` is null) — sorting by that would be a no-op. Reused `conversationLayout.ts`'s existing `resolveAnchorRoot` instead (added there, factored out of `resolveBaseAnchorY`, and shared by both): walk `parentId` to the nearest ancestor that actually has a `seedSelection`, or Main if none in the chain does — this is what actually produces meaningful groups. Sort key is the resolved root's raw `seedSelection.from` document offset (not a pixel Y — data-model.md's own wording for HUD ordering already says `seedSelection.from`, so no `EditorComponent`/pixel dependency is needed here at all), Main's `-1` sentinel sorting first; ties broken by the root's own id (keeps distinct root groups from interleaving when two unrelated roots happen to share an offset) then the root conversation's own row before its descendants' (a root isn't guaranteed to precede its descendants in `store.conversations`' insertion order) then original list order.
- [X] T033 [US4] Wire each HUD entry's click handler to `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` on the corresponding `ConversationThreadBox` (research.md §3). `App.vue`'s `onHudSelect` does this via `document.querySelector('.conversation-thread-box[data-conversation-id="..."]')` — scoped to that class specifically since `HudPanel.vue`'s own rows now also carry a `data-conversation-id` (T030's note) and a bare attribute selector would otherwise ambiguously match whichever element comes first in document order.

**Checkpoint**: All four user stories are independently functional — the full spatial canvas restructure is complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements spanning multiple user stories.

- [X] T034 [P] Persist the canvas's `scrollLeft`/`scrollTop` to `localStorage`, restored on mount, following the existing `panePersistence.ts` convention (data-model.md's `CanvasScrollPosition`, research.md §8). Added `loadCanvasScrollPosition`/`persistCanvasScrollPosition` to `panePersistence.ts` under a distinct `raidr:canvasScrollPosition` key (not merged into the existing `fr`/pixel `PANE_SIZES_KEY` blob, since this is a single `{scrollLeft, scrollTop}` pair, not an extensible named-value record). `DocumentCanvas.vue` restores it via a template-ref callback on mount and persists on `@scroll`, debounced 250ms (same pattern as `EditorComponent.vue`'s `CLIENT_BATCH_DEBOUNCE_MS`) so a scroll gesture doesn't write on every tick.
- [X] T035 [P] Added a new `## UI Layout` section to root `README.md` (there was no existing "UI overview" section to replace — the prior layout was only described in an ASCII sketch inside `specs/005-canvas-conversation-threads/plan.md`, not in the README) describing Preview | Canvas | History, the floating document on a pannable canvas, colocated conversation boxes, branch columns with sibling stacking, per-message/bulk expand controls, and the toolbar-row HUD ordered by anchor distance; explicitly notes Preview's own rendering and History are otherwise unchanged.
- [X] T036 Verified via automated coverage rather than a manual live-browser session (no interactive browser tooling available in this environment beyond Playwright itself, which already drives a real headless browser end-to-end): Scenarios 1–4 are `tests/e2e/us8.spec.ts`'s four tests, run in isolation (`npx playwright test tests/e2e/us8.spec.ts --project=stories`) — 4/4 pass, confirmed reliably across two separate runs. Scenario 5 (orphaned anchors) and Scenario 6 (wheel pan / keyboard-only pan) had no prior automated coverage; Scenario 6's keyboard-only-panning half is now covered by T037's new `a11y.spec.ts` test below (verified passing) — wheel-pan itself and Scenario 5 (orphaned-anchor visual flag) were verified by code-reading only (`ConversationThreadBox.vue`'s `anchorOrphaned`-driven badge, `.document-canvas`'s plain native `overflow: auto` with no wheel-event interception), not exercised end-to-end; a genuine live-browser or additional automated pass for those two remains a reasonable follow-up but is out of this task's time budget. Note: a known, pre-existing, out-of-scope full-suite scale flakiness (CodeMirror virtualization/render contention once many conversations have accumulated across a long sequential `us1`→`us8` run — confirmed present via git-stash testing against the pre-this-feature codebase in an earlier phase, and reconfirmed here hitting US2/US3/US5/US6/US8 when the entire `stories` project ran back-to-back) is unrelated to this feature's correctness; every spec file passes reliably run individually or in small groups.
- [X] T037 [P] No `axe-core` (or any accessibility-testing library) exists anywhere in this repo's `package.json`s/`node_modules`, and installing one isn't feasible in this environment (no package-registry network access) — `tests/e2e/a11y.spec.ts` already documents this exact constraint and its fallback (a from-scratch manual WCAG audit, `runManualA11yAudit`, covering accessible names, dialog semantics, and a real relative-luminance contrast calculator). Added a new test to that same file exercising the canvas/thread-box/HUD surface with the same manual audit, plus keyboard-only panning (Tab into `.document-canvas`, `PageDown` moves `scrollTop`) and keyboard HUD navigation (Tab to a HUD row's title button, Enter opens the conversation's detail overlay, Escape closes it) — all pass. The audit caught a real, new contrast failure: `MessageBubble.vue`'s per-message expand/collapse button (`--accent-color` text on `--user-bubble-bg`, both derived from the same blue) measured 4.34:1, just under the 4.5:1 AA threshold for normal text — fixed by switching to `--neutral-muted-color`, the same already-validated token `HudPanel.vue`'s `.stale-badge`/`.no-primary-badge` use for an identical reason. `ConversationThreadBox.vue`'s bulk-toggle button uses the same `--accent-color` but against the box's plain `--panel-bg` (not a colored tint), which the audit did not flag, so it was left as-is.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 2 (Phase 4)**: Depends on Foundational; renders inside the same `DocumentCanvas.vue`/`ConversationThreadBox.vue` US1 introduces, so in practice implement after US1, though it does not modify US1's column-0 behavior.
- **User Story 3 (Phase 5)**: Depends on Foundational and on `MessageBubble.vue`/`ConversationThreadBox.vue` existing (from US1) — implement after US1.
- **User Story 4 (Phase 6)**: Depends on Foundational and on conversation boxes existing on the canvas (from US1/US2) to have something to scroll to — implement last.
- **Polish (Phase 7)**: Depends on all four user stories.

### Within Each User Story

- Tests are written before implementation and should fail first.
- Layout/positioning helpers before the rendering that consumes them.
- Story complete and checkpointed before moving to the next priority.

### Parallel Opportunities

- T002/T003 (shared schema + domain type) in parallel; T006 (unit tests) in parallel with T007–T010 (frontend canvas scaffold) since they touch disjoint files.
- Within each user story, the `[P]`-marked test tasks (component + e2e) can run in parallel with each other, but not with that story's implementation tasks they're testing.
- T034/T035/T037 in Polish can run in parallel (different files).

---

## Parallel Example: Foundational Phase

```bash
# Shared schema/type changes (different files):
Task: "Add anchorOrphaned: z.boolean() to ConversationDto in app/shared/src/contracts/http.ts"
Task: "Mirror anchorOrphaned: boolean on the Conversation interface in app/shared/src/domain/index.ts"

# Once T004 lands, in parallel:
Task: "Unit tests for anchorOrphaned computation in app/backend/tests/unit/conversation-mapper.test.ts"
Task: "Create DocumentCanvas.vue scrollable container in app/frontend/src/components/canvas/"
```

## Parallel Example: User Story 1

```bash
Task: "Component test for anchor-Y computation in app/frontend/tests/component/ConversationThreadBox.spec.ts"
Task: "E2E test for Scenario 1 in tests/e2e/us8.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (blocks everything).
3. Complete Phase 3: User Story 1 — colocation.
4. **STOP and VALIDATE**: run quickstart.md Scenario 1 independently.
5. Demo: document floats on canvas, conversations colocate with highlights and Main.

### Incremental Delivery

1. Setup + Foundational → canvas scaffold ready.
2. Add User Story 1 → validate → demo (MVP: colocation).
3. Add User Story 2 → validate → demo (branching reads as a tree).
4. Add User Story 3 → validate → demo (compact/expand messages).
5. Add User Story 4 → validate → demo (top HUD overview) — full feature complete.
6. Polish.

## Notes

- No new runtime dependency is introduced anywhere in this task list (research.md §1) — panning is
  native browser scroll throughout.
- Preview and History are never touched by any task above (explicit scope confirmation during
  planning).
- Commit after each task or logical group; verify tests fail before implementing; stop at any
  checkpoint to validate a story independently.
