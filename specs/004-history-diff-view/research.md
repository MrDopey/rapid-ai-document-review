# Phase 0 Research: History Revision Diff View

No `NEEDS CLARIFICATION` markers remained in the Technical Context, so this phase confirms the
decisions already surfaced during codebase investigation rather than resolving open unknowns.

## Decision: Reuse the existing export endpoint for revision content

**Decision**: Fetch both revisions' plain-text content via the existing
`GET /api/document/export?revision=N` endpoint (already wrapped by
`useDocumentStore().exportRevision()` in `app/frontend/src/stores/document.ts:107-109`), calling it
twice — once for the selected revision, once for `revision - 1`.

**Rationale**: The endpoint already returns exactly what's needed (full Markdown text of a given
revision, materialized from that revision's stored Automerge `heads`), is already used by
`HistoryPanel.vue` for the "Copy" action, and requires zero backend changes. Building a new
"diff pair" backend endpoint would duplicate this logic for no benefit, since diffing two strings
is cheap enough to do client-side for review-sized documents (SC-004: <2s).

**Alternatives considered**:
- *New backend endpoint returning both revisions (or a pre-computed diff) in one call* — rejected:
  adds a new contract surface, a new shared type, and backend test coverage for something the
  existing endpoint already supports with two lightweight requests; no evidence document sizes in
  this v1 (single local user, single document) make two sequential text fetches a real latency
  concern.
- *Server-side diff computation* — rejected: would still need a new endpoint, moves work to the
  server for no correctness or performance reason, and the frontend already has a diffing library
  and pattern in place.

## Decision: Reuse the `diff` (jsdiff) package already in `app/frontend`

**Decision**: Use the already-installed `diff` package (`app/frontend/package.json`) — specifically
a line-oriented diff (`diffLines`) for the new whole-document comparison, rather than the
word-level `diffWords` used by the existing `DiffViewer.vue`.

**Rationale**: `DiffViewer.vue` diffs small hunks of proposed-edit text word-by-word, which reads
well for a few sentences. This feature diffs two *entire document revisions*, which are typically
many paragraphs; a line-level diff keeps unchanged paragraphs collapsed to context and highlights
changed lines the way reviewers expect from a document version-history diff, without producing an
unreadable wall of word-level `<ins>`/`<del>` spans across the whole document. `diffLines` is part
of the same already-installed `diff` package, so no new dependency is introduced either way.

**Alternatives considered**:
- *Reuse `diffWords` directly on full documents* — rejected: acceptable for short hunks (existing
  use case) but degrades readability at whole-document scale and doesn't match the "line added /
  line removed" mental model reviewers already get from `HistoryPanel.vue`'s per-revision list.
- *A dedicated diff npm package with unified/side-by-side rendering built in* — rejected: would add
  a new dependency where the existing one already provides the primitive (`diffLines`) needed to
  build a simple added/removed rendering, matching the constitution's general preference (implicit
  in the "No Pi Extension Without Demonstrated Necessity" spirit applied here by analogy) against
  adding new infrastructure before the existing one is shown insufficient.

## Decision: New sibling component, not extending `DiffViewer.vue`

**Decision**: Add a new `RevisionDiffViewer.vue` in `app/frontend/src/components/diff/`, rather
than overloading the existing `DiffViewer.vue` (which is purpose-built around
`PreviewEditResponse`'s hunk shape from `httpClient.previewEdit()`).

**Rationale**: `DiffViewer.vue`'s data model (`preview.hunks`, `contextBefore`/`contextAfter`,
`reconcilable`/`conflictDetail`) is specific to previewing a single staged edit proposal against
the live document. A revision-vs-revision diff has a different, simpler shape (two full-text
strings in, one diff out) and different failure modes (a revision's content failing to load, not a
proposal becoming unreconcilable). Keeping them separate avoids threading proposal-specific
concepts through a component that has nothing to do with proposals, and vice versa.

**Alternatives considered**:
- *Generalize `DiffViewer.vue` to accept either a proposal preview or a revision pair* — rejected:
  would couple two independently-evolving concerns (edit-proposal review vs. revision history) and
  complicate the component's props/state for both call sites' sake.

## Decision: No new shared contract type

**Decision**: No changes to `app/shared/src/contracts/http.ts` or any backend route.

**Rationale**: The feature performs two reads through an endpoint and contract that already exist
(`ExportDocumentQuery`, `GET /api/document/export`). Revision numbering is already guaranteed
contiguous with no gaps (`revisionNumber = document.currentRevision + 1` on every new revision,
including restores — confirmed in `app/backend/src/document/revision-service.ts`), so the frontend
can safely compute "previous revision" as `revision - 1` without a new lookup, and can determine
diff-eligibility (FR-001/FR-002) purely from the revision number already present on each
`RevisionDto` in the already-loaded `store.revisions` list.
