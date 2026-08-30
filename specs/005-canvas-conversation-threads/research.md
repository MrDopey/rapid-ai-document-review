# Phase 0 Research: Spatial Canvas for Document and Conversations

Scope note: almost nothing here is a technology unknown — the codebase already has every data
field this feature needs (`parentId`, `branchDepth`, `seedSelection`). Per the planning directive,
research instead focuses on the *interaction ergonomics* that determine whether the restructure
actually feels good to use. Zoom is explicitly out of scope for this version (decided during
planning discussion — see §1); the canvas only needs to pan.

## 1. Canvas navigation: native scroll, not a hand-rolled viewport

**Decision**: The canvas is a plain scrollable container (`overflow: auto`, native browser
scrolling) hosting the document page and every conversation column, each positioned with ordinary
CSS (the document flows normally; conversation boxes are positioned per column via `position:
absolute`/CSS Grid against the scrollable content area — see §6). There is no custom
`useCanvasViewport` composable, no CSS `transform: translate/scale`, and no wheel-event
interception at all for panning; a plain mouse-wheel scroll just scrolls the container the way
every scrollable `div` on the web already does.

**Rationale**: This was an open design question raised mid-planning: could regular HTML document
flow handle this out of the box? The answer splits in two:
- **Positioning a conversation box level with an arbitrary text offset** is never a flow concept —
  CodeMirror's `coordsAtPos` still has to supply a pixel Y for that offset, and the box is placed
  there directly (§6). This is true with or without zoom, and is the same technique Google
  Docs/Notion/HackMD margin comments use.
- **Panning**, on the other hand, only needed custom transform math to stay in the same coordinate
  space as zoom (so "zoom stays centered under the cursor" didn't require converting between a
  scroll offset and a transform offset). With zoom removed from scope, that reason disappears, and
  native `overflow: auto` scrolling is strictly better: it gets scrollbars, trackpad momentum,
  click-drag-to-scroll (via native scrollbar thumb or a plain `cursor: grab` drag that just sets
  `scrollLeft`/`scrollTop`), and keyboard arrow-key scrolling (§3) for free, with no bespoke code to
  write or test.

**Alternatives considered**: The originally-planned hand-rolled `useCanvasViewport` composable
using CSS transforms (rejected now that there's no zoom to keep in sync with it — it would only add
cost with no remaining benefit). `d3-zoom`/a panzoom library (rejected for the same YAGNI reasoning
as before, even more so now that the feature needs only native scroll).

## 2. Document page scroll model

**Decision**: Remove `EditorComponent.vue`'s current `.cm-scroller { overflow: auto }` so the
document page lays out at its full content height (like a real floating page) instead of being an
internally-scrolling box; the canvas's own native scroll (§1) is the only way to move through it
vertically.

**Rationale**: This nested-scroll problem is independent of the zoom-vs-pan question above and
still applies: leaving the inner `overflow: auto` in place would mean a wheel-scroll over the
document scrolls *within* the page first (native scroll-chaining) and only reaches the outer canvas
scroll once the inner one bottoms out — inconsistent with the "floating page, like Word" mental
model (User Story 1) and with FR-015 feeling the same regardless of cursor position.

**Alternatives considered**: Keep the inner scroller with `overscroll-behavior: contain` plus
manual event forwarding to the canvas (rejected — more code than simply not having a second scroll
container, and still produces a seam in scroll feel at the page boundary).

## 3. Keyboard-accessible panning

**Decision**: The canvas scroll container gets `tabindex="0"` so, once focused, native browser
arrow-key/Page Up/Page Down/Home/End scrolling works with zero custom code. Selecting a HUD entry
calls the standard DOM `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` on that
conversation's box, so keyboard users reach any specific conversation directly rather than having
to arrow-key their way across the canvas. New keymap-registry entries (per
`a11y/keymap-registry.ts`) document these as "documented native behavior," not custom bindings.

**Rationale**: Native scrollable regions are keyboard-operable by the browser automatically once
focusable — this is a second, smaller instance of the same "flow gives you this for free" pattern
as §1. The only genuinely custom piece is HUD-entry-to-scroll, which is a single standard DOM call,
not a coordinate-system reimplementation.

**Alternatives considered**: Custom keydown handlers reimplementing arrow-key panning (rejected —
redundant with, and more fragile than, what the browser already does for a focusable scroll
container).

## 4. Hit targets and keyboard operability for expand controls

**Decision**: Per-message expand/collapse control and the per-conversation bulk control are both
real `<button>` elements (native focus + Enter/Space activation for free), each with a minimum
24×24px hit area regardless of the compact box's overall density.

**Rationale**: These controls are new, small, and dense (potentially several per compact
conversation box) — exactly the shape of control most likely to regress to an unlabeled `<span
@click>` under time pressure. Stating the button-element + minimum-hit-area bar here up front keeps
it from being an afterthought during implementation, consistent with the rest of the app's pattern
of real interactive elements with explicit `aria-label`s (see `EditorComponent.vue`'s branch button,
`ConversationView.vue`'s dismiss/close buttons).

**Alternatives considered**: Clickable non-button elements sized to content (rejected — fails
keyboard operability and touch-target guidance for no benefit).

## 5. Placement of the bulk expand/collapse control

**Decision**: The bulk control lives in a small dedicated affordance area on the compact canvas box
itself (e.g., top-right corner of the box, adjacent to but visually distinct from the existing
title/status header), not inside the constitution's reserved single middle "primary action" slot.

**Rationale**: The constitution's middle-slot rule ("never more than one action" in that slot) is
scoped to *mutating* actions on the conversation (Close, Request review, Make Primary) — the bulk
toggle is a local display-state control with no server effect, so it isn't a candidate for that slot
in the first place, and placing it there would be a category error (mixing a rendering preference
with a lifecycle action) as well as a literal collision with whichever mutating action already
occupies that slot for the conversation's current state.

**Alternatives considered**: Overloading the middle slot when it's otherwise empty (rejected — the
slot is empty only for closed Main-kind conversations in the existing rule's own logic, so the
control would appear/disappear depending on conversation state, which is confusing for a control
that should always be available).

## 6. Column positioning and sibling-branch stacking / collision layout

**Decision**: Each conversation box is positioned via CSS relative to the scrollable canvas content
area: horizontal position is a fixed per-column offset (`column * COLUMN_WIDTH`, where `column =
branchDepth`); vertical position starts at the anchor's pixel Y (from CodeMirror's `coordsAtPos`, or
`0` for Main). Within a column, conversations are laid out top-to-bottom by creation order (for
siblings sharing a parent message) with a fixed minimum gap; if any box's current (compact or
expanded) height would make it overlap the next box down, the whole column below that point shifts
down by the overlap amount. Recomputed on: any box's expand/collapse state changing, container
resize, new conversation creation, and a conversation leaving view (closed and filtered out, or
hidden via the existing show/hide filter) — in that last case the column shifts *up* to close the
gap, the mirror image of the push-down case.

**Rationale**: Directly implements FR-003/FR-006/FR-007/FR-012/Edge Cases. Creation order is the
simplest total order available (matches "the order they were created" already assumed in the spec's
Assumptions section) and requires no new sequencing data — `createdAt` already exists on
`Conversation`. Closing the gap on removal (rather than leaving a hole) keeps columns compact over a
long session, which matters more here than positional stability of a box the user isn't currently
looking at — the user confirmed this trade-off explicitly when the question came up. None of this
layout math depends on how the canvas is panned (§1) — it operates purely in the scrollable content
area's own coordinate space, which is exactly the ordinary CSS positioning space browsers already
give a scrollable `div`'s children.

**Alternatives considered**: A force-directed / physics-based layout (rejected — large complexity
increase for a small-N problem that a simple top-to-bottom stack already solves deterministically
and predictably, which matters more than smoothness here). Leaving a permanent gap where a
conversation closed/was hidden (rejected — columns would grow sparse and misleading over a long
review session, since the vertical position no longer means "distance from top of document" once
enough gaps accumulate). Deferring the reflow until the column is out of view (rejected as
unnecessary added complexity — a closed/hidden conversation is, by definition, an action the user
themselves just took, so an immediate shift is expected rather than surprising).

## 7. Orphaned-anchor detection

**Decision**: Compute `anchorOrphaned` server-side, alongside the existing `isStale`/`canEdit`/
`canBranch` computed fields: `false` when `seedSelection` is `null` (Main/top-anchored); otherwise
`documentContent.slice(seedSelection.from, seedSelection.to) !== seedSelection.text` against the
current document content.

**Rationale**: `seedSelection` is already documented as "a point-in-time copy — never live-linked to
the document" (`seed-excerpt.ts`), so the underlying text at those offsets is already knowably
stale-or-not today; this feature just surfaces that existing fact as a boolean, exactly mirroring
how `isStale` already surfaces `contextRevision < currentRevision`. Keeping the computation
server-side (not reimplemented client-side against a locally-cached document string) keeps the
application as the sole authority over document state (Constitution Principle I).

**Alternatives considered**: Track live CRDT position anchors that follow edits automatically
(rejected — much larger scope, contradicts the spec's own assumption that "orphaned" is the intended
behavior rather than continuous re-anchoring, and reopens a design question the user has already
explicitly settled in the spec's Assumptions section).

## 8. Persisting scroll position and per-message expand state

**Decision**: The canvas's scroll position (`scrollLeft`, `scrollTop`) and per-message
expanded/collapsed overrides persist to `localStorage`, following the exact precedent already set by
`panePersistence.ts` (pane sizes) and `ConversationView.vue`'s `directEditHintDismissed` key — both
are per-viewer UI convenience state, not document or conversation truth.

**Rationale**: Consistent with existing project precedent for this class of state, and avoids
growing the backend API surface for what is purely a local rendering convenience with no
cross-session or cross-user significance. Now that panning is native scroll rather than a custom
transform (§1), this is literally just "remember `scrollLeft`/`scrollTop` and restore them on
mount" — no coordinate conversion required.

**Alternatives considered**: Persisting via the backend's `UserSettings` (rejected — that store is
for behavior-affecting settings shared with agent policy, e.g. `maxConversationDepth`, not per-viewer
scroll/expand convenience state).
