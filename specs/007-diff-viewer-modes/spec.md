# Feature Specification: Proposed-Edit Diff Highlighting & Side-by-Side View

**Feature Branch**: `[007-diff-viewer-modes]`

**Created**: 2026-08-31

**Status**: Draft

**Input**: User description: "render proposed-edit diffs as HTML with inline add/remove highlighting (GitHub-style), plus an optional side-by-side (before | after) view as a toggle alongside the existing view modes in DiffViewer.vue — defaulting to the unified/inline view, with sanitization of arbitrary document text as a hard requirement"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See highlighted changes across the whole document (Priority: P1)

A reviewer previewing a proposed edit switches to the "Full document" view to see the change in the context of the entire document (not just the immediate surrounding text shown in a hunk). Today this view shows the entire proposed document as an undifferentiated block of plain text, so the reviewer has to re-read the whole document to spot what changed. Instead, the reviewer should see the same kind of added/removed highlighting already available in the compact hunk view, applied across the full document.

**Why this priority**: This is the most direct gap today — the "Full document" mode currently provides zero diff signal, which defeats the purpose of previewing an edit in whole-document context. Fixing it delivers value on its own regardless of whether side-by-side ships.

**Independent Test**: Open a proposed edit's preview, switch to "Full document," and verify added and removed text are visually distinguished (not one plain block), while unchanged text is not marked up.

**Acceptance Scenarios**:

1. **Given** a reconcilable proposed edit is open in preview, **When** the reviewer selects the "Full document" view, **Then** text present only in the proposed version is visually marked as added and text present only in the original is visually marked as removed, with unchanged text shown plainly.
2. **Given** the "Full document" view is showing a highlighted comparison, **When** the reviewer inspects text that contains characters such as `<`, `>`, or `&`, **Then** those characters render as literal visible text and are never interpreted as HTML markup.
3. **Given** a proposed edit whose reconciled result is identical to the original document (e.g., a no-op edit), **When** the reviewer selects "Full document," **Then** the view indicates no differences were found rather than showing an unmarked wall of text that looks broken or unhighlighted by mistake.

---

### User Story 2 - Compare before and after side by side (Priority: P2)

A reviewer looking at a proposed edit wants to see the original and proposed document next to each other in two columns, rather than reading inline markers, because for some edits (e.g., reordered or heavily restructured passages) a side-by-side comparison is easier to follow than inline highlighting. They select a "Side by side" view alongside the existing "Added / removed" and "Full document" options.

**Why this priority**: Valuable for a subset of edits but not essential for every review — the inline views already convey what changed for most edits. This ships as an additional option once inline highlighting (User Story 1) is solid.

**Independent Test**: Open a proposed edit's preview, select "Side by side," and verify two columns appear — original content on one side, proposed content on the other — with added/removed portions highlighted within each column.

**Acceptance Scenarios**:

1. **Given** a reconcilable proposed edit is open in preview, **When** the reviewer selects "Side by side," **Then** the original document appears in one column and the proposed document appears in an adjacent column, both scoped to the same viewing area.
2. **Given** the "Side by side" view is active, **When** the reviewer inspects either column, **Then** the portions of that column's text that differ from the other column are visually highlighted (removed in the original column, added in the proposed column), not just two unrelated-looking blobs of text.
3. **Given** the preview dialog is at a narrow width (consistent with this app's constrained Preview/Editor/Sidebar layout), **When** the reviewer views "Side by side," **Then** both columns remain readable — via internal scrolling or wrapping — without the dialog itself overflowing the page horizontally.

---

### User Story 3 - Default view stays compact and inline (Priority: P3)

A reviewer opens a proposed edit's preview for the first time. Given this app's limited horizontal space (Preview, Editor, and Sidebar panes already compete for width), the preview should open in the existing compact, inline view rather than the wider side-by-side view, so the common case doesn't force extra scrolling or a wider pane by default.

**Why this priority**: A defaulting/ordering detail rather than new capability — it shapes how Users Story 1 and 2 are presented but has no independent value of its own.

**Independent Test**: Open any proposed edit's preview and verify it opens on the "Added / removed" (inline) view, with "Side by side" reachable only via an explicit selection.

**Acceptance Scenarios**:

1. **Given** a reviewer opens a proposed edit's preview for the first time, **When** the preview finishes loading, **Then** the "Added / removed" inline view is shown, not "Side by side."
2. **Given** the reviewer has manually switched to "Side by side" for one proposal, **When** they close that preview and open a preview for a different proposed edit, **Then** the newly opened preview again defaults to the inline view.

---

### Edge Cases

- What happens when the proposed edit is not reconcilable (conflict)? All view modes continue to be superseded by the existing conflict banner; no diff view (inline, full document, or side-by-side) is rendered in that state.
- What happens with a very large document in "Full document" or "Side by side" view? The view must still render and remain scrollable rather than the page becoming unresponsive; extremely large added/removed spans may render as one large highlighted region, which is acceptable.
- What happens when the entire document is replaced (no shared text between original and proposed)? The comparison should show the original entirely as removed and the proposed entirely as added, not silently fail.
- What happens when document text contains sequences that look like markup (`<script>`, `<b>`, unescaped quotes, etc.)? These must always render as literal text in every view mode — never be interpreted as HTML or executed.
- What happens if the reviewer switches view modes rapidly (e.g., inline → side-by-side → full document) while the preview data is still loading? The view must not crash or show stale/mismatched content; it should reflect the loading/error state already handled by the preview dialog.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The "Full document" view MUST visually distinguish added text, removed text, and unchanged text (rather than rendering the proposed document as an undifferentiated block of plain text, as it does today).
- **FR-002**: The system MUST provide a "Side by side" comparison view, selectable alongside the existing "Added / removed" and "Full document" views, showing the original document in one column and the proposed document in an adjacent column.
- **FR-003**: In the "Side by side" view, each column MUST visually highlight the portions of its own content that differ from the other column (removed content in the original column, added content in the proposed column), not just present two independent blocks of plain text.
- **FR-004**: When a proposed edit's preview is first opened, the system MUST default to the existing "Added / removed" inline view; "Side by side" MUST only be shown after the reviewer explicitly selects it.
- **FR-005**: Every view mode that renders document-derived text (inline hunks, full document, side-by-side) MUST escape/neutralize HTML-significant characters in that text so that no content authored in the document can be interpreted as markup or executed as script, regardless of which view is active.
- **FR-006**: Switching between view modes for an already-loaded proposal preview MUST NOT require a new network request; the same previously fetched preview data MUST be reused across all view modes.
- **FR-007**: If the content being compared in a given view (full document, or side-by-side) is identical between original and proposed, that view MUST indicate no differences were found rather than rendering plain, unmarked content that could be mistaken for a broken highlight.
- **FR-008**: The "Side by side" view MUST remain usable (readable and scrollable) at the narrow pane widths this application's layout already constrains other panels to, without causing the page itself to scroll horizontally.
- **FR-009**: The existing conflict banner for non-reconcilable proposals MUST continue to take the place of all diff views (inline, full document, side-by-side) — none of the new or changed views apply when a proposal no longer reconciles cleanly.
- **FR-010**: The existing "Added / removed" inline hunk view's current word-level highlighting behavior MUST be preserved unchanged by this feature (this feature extends highlighting to the other views; it does not regress the hunk view).

### Key Entities

- **Proposed Edit Preview**: The existing read-only preview data for a staged edit (original document content, the fully reconciled proposed document, and per-operation hunks with surrounding context). This feature does not add new persisted fields to this entity — it changes how the already-available original and proposed text are rendered.
- **Diff Segment**: A conceptual, render-time-only span of text tagged as added, removed, or unchanged, produced by comparing two pieces of text (original vs. proposed, or a hunk's before vs. after). Not persisted; recomputed whenever a preview is displayed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the "Full document" and "Side by side" views, a reviewer can identify what changed without manually re-reading and comparing the entire document by eye.
- **SC-002**: 100% of HTML-significant characters (e.g., `<`, `>`, `&`, quotes) present in diffed document content render as literal visible text across all view modes, in a spot-check of documents containing such characters — none are ever interpreted as markup or executed as script.
- **SC-003**: A reviewer can reach the side-by-side comparison from the default preview view in a single selection (one click/tap).
- **SC-004**: Diff rendering in any view mode completes within 2 seconds for documents of typical review size.
- **SC-005**: The side-by-side view remains fully readable, with no broken or horizontally-overflowing page layout, at the narrowest pane width this application's layout supports.

## Assumptions

- The existing "Added / removed" hunk view already renders word-level add/remove highlighting for each hunk (shipped prior to this feature); this feature's net-new scope is (a) extending equivalent highlighting to the "Full document" view and (b) introducing the new "Side by side" view — it does not re-implement hunk-level highlighting.
- Diff computation continues to be performed on the client, matching this codebase's existing pattern (both the proposed-edit preview and the unrelated revision-history comparison view already compute diffs client-side over plain text supplied by the backend). The backend is not required to return a pre-computed diff or HTML structure for this feature; it continues to supply plain original/proposed text.
- The original ("before") full document text needed for "Full document" and "Side by side" comparisons is already available on the client (via the document currently loaded in the editor/canvas), so no new backend response field is required beyond what the existing preview data already provides.
- "GitHub-style" highlighting means added text shown with a distinct background/color and removed text shown with a distinct background/color plus strikethrough, consistent with the color treatment already used for the existing hunk view's added/removed markup.
- Rendering added/removed markup continues to rely on the same escaping mechanism already used elsewhere in this component family (document text is interpolated as text, never inserted as raw HTML), so no new sanitization library or allowlist is introduced — the requirement is to preserve this property in every view, not to add HTML rendering of document content.
- Accessibility treatment already established for the hunk view (screen-reader-only "added"/"removed" labels, ARIA roles/labelling) is extended to the new "Full document" highlighting and to the "Side by side" view.
- The selected view mode is a per-preview-session choice: it is not persisted between closing one proposal's preview and opening another's, and it resets to the inline default each time a preview is freshly opened.
- "Side by side" compares the original and proposed documents as a whole (mirroring "Full document"), not a separate per-hunk two-column layout — the existing compact hunk view already serves the narrow, per-change comparison case.
