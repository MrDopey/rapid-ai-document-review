# Quickstart: Validating Proposed-Edit Diff Highlighting & Side-by-Side View

## Prerequisites

- Frontend and backend dev servers running (see repo root README / docker-compose for the current
  ports-split setup).
- At least one document open with a proposed (staged) edit from an agent conversation, reconcilable
  (no conflict).

## Automated checks

```bash
cd app/frontend
npx vitest run tests/component/DiffViewer.spec.ts
npx vitest run tests/component/RevisionDiffViewer.spec.ts
npx vitest run tests/component   # full component suite, ensure no regression elsewhere
```

Expected: all pass, including assertions for literal `<`, `>`, `&` rendering, `.added`/`.removed`
presence per view, the FR-007 "no differences" message, a single `httpClient.previewEdit` call
across repeated view-mode switches (FR-006), and — for `RevisionDiffViewer.spec.ts` — the same
marker-glyph/visually-hidden-label markup as `DiffViewer.vue` plus no new fetch when toggling its
new side-by-side view (FR-011/FR-014).

## Manual validation

1. **User Story 1 — Full document highlighting**
   - Open a reconcilable proposed edit's preview.
   - Select the "Full document" tab.
   - Verify added text and removed text are visually distinct (background/color + strikethrough on
     removed), unchanged text is plain. → validates FR-001, SC-001.
   - If the underlying document contains characters like `<script>`, `<b>`, `&amp;`, confirm they
     render as literal visible text in this view. → validates FR-005, SC-002.
   - Open a proposed edit whose reconciled result is identical to the original (a no-op edit);
     confirm "Full document" shows a "No differences found" message, not an unmarked wall of text.
     → validates FR-007, Acceptance Scenario 3.

2. **User Story 2 — Side by side**
   - From the same preview, select "Side by side".
   - Verify two columns appear: original on the left, proposed on the right, both scoped to the
     same viewing area, each highlighting only its own removed/added portions. → validates
     FR-002, FR-003, SC-003 (single click to reach it from the default view).
   - Narrow the browser/preview pane to this app's narrowest supported width; confirm both columns
     stay readable via internal scrolling/wrapping and the page itself does not scroll
     horizontally. → validates FR-008, SC-005.

3. **User Story 3 — Default view**
   - Close the preview and reopen it (same or a different proposed edit); confirm it opens on
     "Added / removed" (inline), not "Side by side", even after previously selecting "Side by side"
     for a prior proposal. → validates FR-004, Acceptance Scenarios 1–2.

4. **Edge cases**
   - Open a non-reconcilable (conflicting) proposed edit; confirm the existing conflict banner
     appears and no view mode (inline/full/side-by-side) renders. → validates FR-009.
   - Open a proposed edit that replaces the entire document; confirm "Full document"/"Side by side"
     show the original entirely removed and the proposed entirely added, not a silent failure.
   - Rapidly switch view modes (inline → side-by-side → full document) while the preview is still
     loading; confirm no crash and no stale/mismatched content.

5. **Performance**
   - With a typical-size review document, confirm each view mode renders within ~2 seconds of
     selecting its tab. → validates SC-004.

6. **User Story 4 — Revision-history parity**
   - Open the revision-history comparison view (unrelated to the proposed-edit preview) for two
     revisions with actual differences.
   - Confirm added/removed text uses the same marker-glyph + visually-hidden-label treatment as the
     proposed-edit diff views. → validates FR-011, SC-006.
   - Select "Side by side"; confirm the earlier revision appears in one column, the later revision
     in the adjacent column, each highlighting only its own differing portions. → validates FR-012,
     SC-007.
   - Confirm "Side by side" is reachable in one selection from the default unified view, and that
     reopening the comparison for a different pair of revisions defaults back to unified. →
     validates FR-013.
   - Confirm switching between unified and side-by-side here triggers no new network request. →
     validates FR-014.
   - Narrow the pane to this app's narrowest supported width; confirm both columns stay readable
     without page-level horizontal scroll, matching the proposed-edit preview's side-by-side
     behavior.

## Reference

- Functional requirements: `spec.md` FR-001..FR-014.
- Success criteria: `spec.md` SC-001..SC-007.
- Design decisions behind the above: `research.md`.
- Entity/data shapes exercised above: `data-model.md`.
- Internal component contract: `contracts/diff-text-component.md`.
