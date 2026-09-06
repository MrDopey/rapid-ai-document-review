# Research: Proposed-Edit Diff Highlighting & Side-by-Side View

## R1: Diffing library and granularity

**Decision**: Reuse the existing `diff` npm package (`diffWords`), already a dependency and already used
by `DiffViewer.vue`'s hunk view (`diffWords(hunk.removed, hunk.added)`) and by
`RevisionDiffViewer.vue` (`diffLines`). Use `diffWords` for both the "Full document" view and the
"Side by side" view, matching the granularity reviewers already see in the hunk view.

**Rationale**: FR-001 asks for "the same kind of added/removed highlighting already available in
the compact hunk view" — that is word-level, not line-level. No new library evaluation is needed;
`diff@^9.0.0` already covers this.

**Alternatives considered**:
- `diffLines` (as used by `RevisionDiffViewer.vue`): rejected for this feature because it would
  produce coarser (whole-line) highlighting than the hunk view, inconsistent with FR-001's "same
  kind of highlighting" requirement and with User Story 1's intent.
- A different diff/patch library (e.g. `diff-match-patch`): rejected — no evidence of a gap the
  existing `diff` package can't cover, and introducing a second diff library would violate the
  "don't add abstractions beyond what's needed" default.

## R2: Source of the "original" full document text

**Decision**: `DiffViewer.vue` reads `useDocumentStore().content` and takes a one-time snapshot into
a local ref at the same point it fetches the preview (inside `load()`), pairing it with
`preview.fullPreview` for the lifetime of that open dialog.

**Rationale**: `PreviewEditResponse` only carries `fullPreview` (the proposed/reconciled text); the
original text is not part of that contract and doesn't need to become part of it — the document
store already holds the current full document client-side (Assumption in spec.md, line 102).
Snapshotting at load time (rather than reading `store.content` reactively on every render) keeps the
two sides of the diff — original snapshot and `fullPreview` — mutually consistent for as long as the
reviewer has the dialog open, even if the live document changes underneath via a websocket/SSE frame
while the preview is being reviewed. This avoids the diff view jumping or re-highlighting content the
reviewer didn't ask to re-review, mid-session.

**Alternatives considered**:
- Reactively re-diffing against live `store.content` on every store mutation: rejected — could cause
  the "original" side of the comparison to change while the reviewer is mid-review, producing a
  confusing moving target unrelated to the specific proposal being reviewed.
- Adding an `original` field to the `PreviewEditResponse` backend contract: rejected — FR-006 and the
  spec's Assumptions explicitly call for reusing already-available client-side data with no new
  backend field; the document store already has this text with no additional network request.

## R3: Rendering and HTML escaping

**Decision**: Continue rendering every diff span via Vue text interpolation (`{{ part.value }}`)
inside semantic `<del>`/`<ins>`/`<span>` elements — never `v-html` — for all three view modes.

**Rationale**: This is the existing, proven pattern in both `DiffViewer.vue`'s hunk view and
`RevisionDiffViewer.vue`; Vue's text-node interpolation escapes HTML-significant characters by
construction, satisfying FR-005/SC-002 without introducing a sanitizer into the diff-rendering path.
DOMPurify is already in the codebase but scoped to the unrelated Markdown/Mermaid `v-html` pipeline
(`render/sanitizer.ts`) — mixing that pipeline's concerns into diff rendering would be a new,
unnecessary code path for content that is already safe as plain interpolated text.

**Alternatives considered**:
- Building an HTML diff string server- or client-side and rendering via `v-html` + DOMPurify:
  rejected — strictly more moving parts than interpolation for the same visible result, and a
  deviation from Principle VI's spirit of keeping sanitization boundaries minimal and well
  understood, not introduced ad hoc per feature.

## R4: Shared diff-rendering markup — now shared across both diff features

**Decision**: Introduce one small internal presentational component, `DiffText.vue`
(`app/frontend/src/components/diff/DiffText.vue`), that takes a `Change[]` (from the `diff` package)
and a `side: 'unified' | 'left' | 'right'` prop and renders the `<del>/<ins>/<span>` +
visually-hidden-label markup once. Both `DiffViewer.vue` (hunks, full-document, and both
side-by-side columns) **and** `RevisionDiffViewer.vue` (its unified view and both new side-by-side
columns) use this same component (FR-011).

**Rationale**: The hunk view's existing markup (marker glyph + `.visually-hidden` label + `<del>/<ins>`)
would otherwise be copy-pasted several more times across two files (full-document, side-by-side
left/right in `DiffViewer.vue`, plus the unified and side-by-side columns in
`RevisionDiffViewer.vue`). Extracting it once keeps FR-010 (hunk view behavior unchanged) safe by
construction — the hunk view is refactored to call the same component it already produces today,
not reimplemented — and gives both diff experiences in the app identical accessibility treatment
(marker glyphs, screen-reader labels) by sharing one implementation, per User Story 4 / FR-011 and
the explicit user direction that both features should have visual/accessibility parity, not just
`DiffViewer.vue` internally.

**Consequence for `RevisionDiffViewer.vue`**: its current, simpler `<del class="removed">{{ part.value }}</del>` /
`<ins class="added">{{ part.value }}</ins>` / `<span>{{ part.value }}</span>` markup (no marker glyph,
no visually-hidden label) is replaced by `<DiffText :parts="..." side="unified" />`. Its existing
component test (`RevisionDiffViewer.spec.ts`) asserts on `.added`/`.removed`/`ins`/`del` presence and
text content, which continues to hold true through `DiffText.vue` (same elements, same classes,
same interpolated text) — only the additional marker-glyph/visually-hidden-label nodes are new
DOM children, so that test's existing assertions on element/class/text should still pass unchanged;
any assertion on `ins`/`del`'s exact `innerHTML` (rather than `.text()`/`textContent`) would need to
be loosened to account for the new marker/label children, which is a like-for-like change to make
alongside the `DiffText.vue` migration, not a design change of its own.

**Alternatives considered**:
- Migrating `RevisionDiffViewer.vue` to `DiffText.vue` for rendering only, without adding
  side-by-side there (R9 below): considered and superseded by explicit direction to bring
  `RevisionDiffViewer.vue` to full parity, including the side-by-side view mode.
- A composable (`useTextDiff`) instead of a component: rejected — the duplication that matters here
  is presentational markup (the `<del>/<ins>/<span>` + accessibility labels), not diff computation
  (which is already a one-line `diffWords`/`diffLines(...)` call); a component is the right unit for
  duplicated markup.

## R9: Side-by-side view for the revision-history comparison view (FR-012, FR-013, FR-014)

**Decision**: `RevisionDiffViewer.vue` gains the same `view = ref<'unified' | 'side-by-side'>('unified')`
pattern as `DiffViewer.vue` (a two-tab `role="tablist"`, both panels mounted, toggled via `hidden`),
defaulting to its existing unified display (FR-013). The side-by-side panel reuses the same
`Change[]` already computed for the unified view (`diffLines(previousText, currentText)` — see R1
below on keeping `diffLines`, not `diffWords`, for this view) and renders it through
`<DiffText side="left">` / `<DiffText side="right">` in a two-column grid, matching `DiffViewer.vue`'s
Side-by-side layout and CSS approach (R6).

**No new network request (FR-014)**: `RevisionDiffViewer.vue` already fetches both `previousText`
and `currentText` up front (via `store.exportRevision(revision)`) to render its current unified
view; both are already resident in memory before either view mode is shown, so adding a second view
mode that reads the same two strings requires no additional fetch — mirroring FR-006/R2's reasoning
for `DiffViewer.vue`.

**Diff granularity stays `diffLines`, not `diffWords`**: unlike R1's choice of `diffWords` for
`DiffViewer.vue`'s full-document/side-by-side views (to match its hunk view's word-level
granularity), `RevisionDiffViewer.vue` keeps its existing `diffLines` granularity for both its
unified and new side-by-side views. FR-011's parity requirement is about shared *rendering markup*
(marker glyphs, labels, escaping) via `DiffText.vue`, not about forcing identical diff granularity
onto a view that compares whole revisions rather than small hunks; changing an already-shipped
view's diff granularity is a behavior change with no FR/SC requiring it and risks regressing
`004-history-diff-view`'s existing expectations for what counts as one changed span.

**Alternatives considered**:
- Switching `RevisionDiffViewer.vue` to `diffWords` for consistency with `DiffViewer.vue`: rejected
  — no requirement calls for it, and it would change existing, already-tested behavior of a
  different, already-shipped feature beyond what parity (FR-011/FR-012) requires.

## R5: "No differences found" indicator (FR-007)

**Decision**: When the computed `Change[]` for a given view (full-document or side-by-side) reduces
to a single unchanged part (i.e., `parts.length === 1 && !parts[0].added && !parts[0].removed`),
render a short status message (e.g. "No differences found.") in that view's panel instead of the
plain-text passthrough, using the same panel container so keyboard/tab structure is unaffected.

**Rationale**: Directly satisfies FR-007 and Acceptance Scenario 3 of User Story 1 ("the view
indicates no differences were found rather than showing an unmarked wall of text that looks broken").

**Alternatives considered**: Rendering the identical text with no visual distinction and relying on
the reviewer to notice nothing is highlighted — rejected; this is exactly the confusing "looks broken"
state FR-007 rules out.

## R6: Side-by-side layout at narrow widths

**Decision**: A two-column CSS grid (`grid-template-columns: 1fr 1fr`) scoped inside `DiffViewer.vue`'s
own `<style scoped>` block, with each column independently scrollable (`overflow: auto`) and reusing
the existing shared `.text-wrap-safe-pre` utility class (`style.css`) for wrapping long lines within
a column, matching what the hunk/full-document views already use.

**Rationale**: `style.css` has no existing two-column/grid utility class to reuse (confirmed by
inspection), and per this project's existing CSS convention (only hoist a pattern into `style.css`
on its 2nd/3rd use elsewhere), a single-consumer column layout stays local to the component that
needs it. `.text-wrap-safe-pre` and `.visually-hidden` are already shared, cross-component utilities
and are reused as-is — no new shared utility is introduced by this feature.

**Alternatives considered**: A flex-based two-column layout — equivalent for this fixed 2-column
case; grid was chosen only because it makes the "two equal, independently-scrollable columns" intent
more explicit at the CSS level, not because flex was insufficient.

## R7: View-mode toggle extension

**Decision**: Extend the existing hand-rolled `role="tablist"` toggle (not a new tab/toggle
component) with a third tab (`diff-tab-side-by-side` / `diff-panel-side-by-side`), and extend
`view = ref<'full' | 'hunks'>('hunks')` to `ref<'full' | 'hunks' | 'side-by-side'>('hunks')`
(default unchanged — satisfies FR-004/User Story 3). All three panels stay mounted and are
toggled via the native `hidden` attribute, following the exact pattern already documented in the
component's own comment about `aria-controls` needing the referenced element to exist in the DOM.

**Rationale**: Minimal, consistent extension of a working, already-accessible pattern; no new
dependency (e.g. a headless-UI tabs library) is justified for one additional tab.

## R8: Testing approach

**Decision**: Add `app/frontend/tests/component/DiffViewer.spec.ts` (new file — no dedicated
DiffViewer test file exists today), mirroring the structure of the existing
`RevisionDiffViewer.spec.ts`: mount with a real Pinia instance, stub `useDocumentStore()`'s
`content` and `httpClient.previewEdit`, and assert per acceptance scenario / FR, including:
literal rendering of `<`, `>`, `&` (via `wrapper.html()`/`wrapper.text()` assertions, never
matching raw unescaped markup), presence/absence of `.added`/`.removed` nodes per view, the
FR-007 "no differences" message, and — for FR-006 — that `httpClient.previewEdit` is called
exactly once regardless of how many times the view mode is switched.

**Rationale**: Matches this codebase's established component-test conventions and directly
exercises the spec's Independent Test criteria for all three user stories.
