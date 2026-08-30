# Implementation Plan: Spatial Canvas for Document and Conversations

**Branch**: `005-canvas-conversation-threads` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-canvas-conversation-threads/spec.md`

**Planning focus (user directive)**: this plan prioritizes the *ergonomics* of the new interactions —
gesture disambiguation, hit targets, keyboard/accessibility parity, and avoiding nested-scroll or
control-placement conflicts — over net-new architecture. The feature reuses existing data (`parentId`,
`branchDepth`, `seedSelection`) almost entirely as-is; the hard problems are interaction design, not
new subsystems.

## Summary

Replace the current Editor + HUD + ConversationView portion of the layout with a single pannable
canvas (native scroll — no zoom in this version), placed to the right of the existing Preview pane
(Preview moves left of the canvas; History remains a separate column further right, unaffected).
The HUD moves into the app's existing top toolbar row — title on one side, HUD conversation list in
the middle (width-aligned with the Preview + canvas columns, not History), existing
undo/redo/shortcuts/help controls on the other side — rather than a new row of its own. Preview's
own rendering/behavior is otherwise untouched (confirmed with the user during planning) — only its
grid position, and the toolbar row now also hosting the HUD, change. Within the canvas: the document
renders as a floating, fully-laid-out page; each conversation renders as a compact box colocated at
its anchor's vertical position (top of document for Main, highlight height for a branch); branches
render one column further from the document per level of `branchDepth`; each message gets a default
max-height with a per-message expand control plus a per-conversation bulk expand/collapse. No
backend data model changes are required beyond one new server-computed field (`anchorOrphaned`)
mirroring the existing `isStale`/`canEdit`/`canBranch` pattern.

## Illustrative Layout *(non-normative)*

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Doc title]   ⛁Main  ⛁ConvA(¶2)  ⛁ConvB(¶5)         [Undo][Redo][History][⌨][?]            │
│  ← title →    ←────── HUD (fixed, always visible) ──────→   ← existing toolbar controls →   │
├───────────────────────────────┬───────────────────────────────┬──────────────────────────────┤
│                                │                                │                              │
│           PREVIEW             │             CANVAS             │   HISTORY (conditional,     │
│  (rendered Markdown,          │  (native scroll — pans doc +   │   unchanged — Fix 1's grid  │
│   unchanged, own scroll)      │   threads together, no zoom)   │   slot)                      │
│                                │                                │                              │
│                                │ ┌────────┐   col-0     col-1  │                              │
│                                │ │DOCUMENT│┄►┌────────┐         │                              │
│                                │ │ (top)  │  │💬 Main  │        │                              │
│                                │ │        │  │[⤢] msg▾│        │                              │
│                                │ │        │  └────────┘         │                              │
│                                │ │▓highl.│┄►┌────────┐         │                              │
│                                │ │        │  │💬 ConvA │        │                              │
│                                │ │        │  │[⤢] msg▾│──►┌────────┐                          │
│                                │ │        │  └────────┘   │💬ConvA.1│                         │
│                                │ │██highl.┄►┌────────┐   │[⤢] msg▾│                          │
│                                │ │        │  │💬 ConvB │   └────────┘                          │
│                                │ │        │  └────────┘         │                              │
│                                │ └────────┘                     │                              │
├───────────────────────────────┴───────────────────────────────┴──────────────────────────────┤
│      ↑ resize handle (Preview↔Canvas, repurposed from old Editor↔Preview handle)   ↑ (Canvas↔History, unchanged) │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Grid order is **Preview | Canvas | History**; the HUD is not a separate row — it lives inside the
existing title/toolbar row, width-aligned with Preview+Canvas only.

## Technical Context

**Language/Version**: TypeScript throughout (frontend: Vue 3.5 SFCs; backend: Node.js/TypeScript on Fastify).

**Primary Dependencies**: Vue 3, Pinia (frontend state), CodeMirror 6 (document editor, unchanged),
existing `panePersistence` composable (precedent for persisted-UI-state patterns this feature
follows). No new runtime dependency is planned — panning is native browser scroll, not a custom
viewport composable or pan/zoom library (research.md §1); zoom itself is out of scope for this
version.

**Storage**: SQLite via the existing abstracted storage layer (unchanged schema — `anchorOrphaned` is
computed at read time from already-stored `seedSelection` + current document content, like `isStale`
is computed from `contextRevision` vs. current revision).

**Testing**: Vitest (unit: `app/backend/tests/unit`, `app/frontend/tests` unit/component) and
Playwright (`tests/e2e`, following the existing `usN.spec.ts` per-user-story convention).

**Target Platform**: Self-hosted Docker deployment, accessed via desktop browsers (existing
constraint; no mobile/touch target for v1).

**Project Type**: Web application (existing `app/frontend` + `app/backend` + `app/shared` structure).

**Performance Goals**: Layout recalculation (column stacking/collision) must stay smooth with the
realistic v1 ceiling of `maxConversationDepth` (default 3) columns, each holding a handful of
stacked conversations — this is a small-N layout problem, not a large-graph rendering problem.
Panning itself is native browser scroll, so it inherits the browser's own scroll performance with no
additional work.

**Constraints**:
- Must not introduce a second, competing scroll container: today `EditorComponent.vue`'s
  `.cm-scroller` has its own `overflow: auto` independent of the outer pane. On the canvas, plain
  wheel-scroll must pan the whole canvas (FR-015), so the document page's own internal scrollbar
  must be removed in favor of the canvas's native scroll (see research.md) to avoid wheel-event
  scroll-chaining conflicts between the page and the canvas.
- Must not violate the constitution's single-primary-action middle-slot rule for conversation
  headers (see Constitution Check) when placing the new bulk expand/collapse control.
- Panning must remain keyboard-operable; a purely mouse/wheel-only interaction would regress the
  app's existing accessibility posture (`axe-core` is part of the test toolchain;
  `a11y/keymap-registry.ts` and `a11y/focus-manager.ts` are established patterns). This falls out
  largely for free from using a native, focusable scroll container (research.md §3) rather than
  custom transform-based panning.

**Scale/Scope**: Single document, single local user (existing v1 constraint). Branch depth bounded
by the existing, enforced `maxConversationDepth` setting (default 3), so the canvas needs to handle
at most ~4 columns in the default configuration — this remains a UI-ergonomics feature, not a
scalability one.

### Shared CSS Utility Reuse (frontend UI changes only)

This feature is almost entirely frontend UI, so `app/frontend/src/style.css` was read before
planning any new styling:

- **Color tokens** (`--panel-bg`, `--panel-bg-alt`, `--border-color`, `--text-color`, `--bg-color`,
  plus their `prefers-color-scheme: dark` overrides) — the canvas background and every new
  conversation-thread-box surface reuse these rather than introducing new hardcoded colors, so
  dark-mode support comes for free instead of needing a parallel canvas-specific palette.
- **`.badge`** — reused as-is for the status badge inside each compact thread box, matching the
  existing `ConversationView`/`HudPanel` pattern; no new pill/tag style is introduced.
- **`--warning-color` / `--warning-bg`** — reused for the orphaned-anchor visual flag (FR-011/SC-006)
  instead of adding a new semantic color for what is, semantically, a warning state.
- **`.pane-eyebrow`** — reused for the HUD's top-bar label and any new canvas section labels,
  matching Editor/Preview/Conversation's existing eyebrow treatment.
- **`.visually-hidden`** — reused for screen-reader-only text on the new per-message/bulk expand
  controls.
- **`.text-wrap-safe` / `.text-wrap-safe-pre`** — reused for message content and conversation titles
  rendered inside compact thread boxes, exactly as `MessageBubble.vue` already does; the new
  per-message max-height clamp is an additional rule layered on top of, not a replacement for, this
  existing wrap handling.
- **`.modal-overlay`** — reused if/when a compact thread box's "focus"/detail view reopens the
  existing `ConversationView.vue` as an overlay above the canvas, instead of a bespoke backdrop.
- **New, feature-specific CSS** (not present in `style.css` today, so authored locally first): the
  per-message max-height clamp and the column/stacking absolute-positioning rules for thread boxes.
  Per the template's hoist rule, the max-height clamp starts scoped to `MessageBubble.vue`; if a
  second consumer needs the same clamp pattern during implementation, it moves into `style.css` at
  that 2nd/3rd use rather than being re-authored per component.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. The Application Owns the Document** — PASS. The canvas is a presentation layer over
  existing document/conversation state; no new source of truth is introduced. The one new
  computed field (`anchorOrphaned`) follows the existing pattern of backend-computed,
  never-persisted fields (`isStale`, `canEdit`, `canBranch`).
- **II. Pi Owns Agent Conversations** — PASS. Branch depth, parentage, and history sharing are
  unchanged (`parentId`/`branchDepth` already model this); the canvas only changes how that
  existing tree is *rendered*, not how it is created or mutated.
- **III. Agent Edits Are Proposals** — PASS. Not touched by this feature.
- **IV. CRDT-Mediated Merging / Revisions** — PASS. Orphan detection reads current document
  content read-only (`content.slice(from, to) !== seedSelection.text`) and never mutates
  revision history.
- **V. Configurable Limits Are Enforced** — PASS. `maxConversationDepth` remains the sole gate on
  how many columns can exist; the canvas must render whatever depth the existing limit allows,
  it does not introduce a second, independent depth cap.
- **VI. Sanitize Before Render** — PASS. Message content continues to go through the existing
  sanitized Markdown pipeline; the canvas only repositions existing rendered output.
- **VII. No Pi Extension Without Demonstrated Necessity** — PASS. No Pi-facing change at all.
- **UI Conventions (3-section conversation row/header layout)** — NEEDS DESIGN CARE, not a
  violation: the existing rule reserves the header's single middle slot for "the one mutating
  action you can currently take" (Close / Request review / Make Primary). The new per-conversation
  bulk expand/collapse control is a display-state toggle, not a mutating action on the
  conversation, so it does not compete for that slot — but it also must not be implemented as a
  second action sitting *beside* that slot in the same row, which the "never more than one
  action" framing would forbid if misread as applying to *all* controls rather than to mutating
  actions specifically. Resolution carried into research.md: place the bulk toggle in the
  compact canvas box's own dedicated affordance area (distinct from the title/action/status header
  it inherits when expanded to full detail view), not inline with the middle slot.
- **Keyboard Shortcuts registry** — panning itself needs no new registry entry (native scroll on a
  focusable container, research.md §3); if implementation ends up introducing any new bound
  shortcut (e.g. a HUD "jump to next conversation" key), it MUST be added to
  `app/frontend/src/a11y/keymap-registry.ts` per existing convention.

No unjustified violations — Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/005-canvas-conversation-threads/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/
│   └── conversation-anchor.md   # Phase 1 output — new computed field contract
└── tasks.md              # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
app/
├── backend/
│   └── src/conversation/
│       ├── conversation-service.ts     # add anchorOrphaned computation (mirrors isStale)
│       └── conversation-mapper.ts      # expose anchorOrphaned on ConversationDto
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── canvas/                  # NEW: canvas surface
│       │   │   └── DocumentCanvas.vue   # plain scrollable container; hosts the floating page + threads
│       │   ├── editor/EditorComponent.vue      # remove internal .cm-scroller overflow; full-height page
│       │   ├── conversation/
│       │   │   ├── ConversationThreadBox.vue   # NEW: compact canvas representation of a conversation
│       │   │   ├── ConversationView.vue        # existing full/detail view, reused when a thread is focused
│       │   │   └── MessageBubble.vue           # add per-message max-height + expand control
│       │   └── hud/HudPanel.vue         # reposition to a full-width bar above Preview+Canvas;
│       │                                # re-sort by anchor distance from top
│       └── App.vue                       # replace the Editor+Sidebar(HUD|ConversationView) grid
│                                          # columns/resize-handles with a single DocumentCanvas host;
│                                          # reorder the grid to Preview | Canvas | History (Preview
│                                          # moves left of the canvas); keep the History column and
│                                          # the Preview|Canvas resize handle (repurposed from the old
│                                          # Editor|Preview handle) exactly as they behave today
└── shared/
    └── src/
        ├── contracts/http.ts             # add anchorOrphaned: z.boolean() to ConversationDto (wire contract)
        └── domain/index.ts               # mirror anchorOrphaned on the Conversation interface's server-computed section

tests/e2e/us8.spec.ts   # NEW: canvas colocation/branching/expand/pan e2e (next available usN slot)
```

**Structure Decision**: Existing web-app structure (`app/frontend` + `app/backend` + `app/shared`)
is reused as-is. This is almost entirely a frontend restructure (new `components/canvas/` directory
plus edits to existing conversation/HUD/editor components); the only backend touch is exposing one
new server-computed boolean alongside the existing `isStale`/`canEdit`/`canBranch` fields.

## Post-Design Constitution Check

*Re-evaluated after Phase 1 (data-model.md, contracts/, quickstart.md).*

No new concerns emerged during design. The one open item from the initial pass — where the bulk
expand/collapse control lives relative to the middle "primary action" slot — was resolved in
research.md §5 (dedicated affordance area on the compact box, not the reserved slot) and carried
into data-model.md's `MessageDisplayState` design without needing a new UI-convention exception.
The single backend change (`anchorOrphaned`, contracts/conversation-anchor.md) follows an existing
computed-field pattern exactly, so it required no new gate beyond the ones already checked above.
Zoom being dropped from scope (a mid-planning decision — research.md §1) removed the one piece of
this feature that would have needed genuinely new client-side viewport/coordinate logic; panning is
now native browser scroll, which requires no gate of its own. All gates remain PASS.

## Complexity Tracking

*No Constitution Check violations requiring justification — table intentionally omitted.*
