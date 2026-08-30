# Feature Specification: History Revision Diff View

**Feature Branch**: `[004-history-diff-view]`

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "the history tab should include a button to show a diff with the previous document"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compare a revision against the one before it (Priority: P1)

A reviewer browsing the History tab wants to see exactly what changed in a specific revision without leaving the history view or manually comparing exported copies. They click a "Diff" action on a revision entry and see the differences between that revision and the immediately preceding revision.

**Why this priority**: This is the entire feature — without it there is nothing to ship. It directly replaces the current manual workaround of exporting/copying two revisions and comparing them externally.

**Independent Test**: From the History tab, click "Diff" on any revision that has a predecessor. Verify a diff view opens showing additions and removals between the previous revision's content and the selected revision's content.

**Acceptance Scenarios**:

1. **Given** the History tab is open and showing at least two revisions, **When** the reviewer clicks the "Diff" button on a revision, **Then** a diff view appears showing text added and removed relative to the immediately preceding revision.
2. **Given** the diff view is open, **When** the reviewer inspects it, **Then** unchanged text, added text, and removed text are each visually distinguishable.
3. **Given** the diff view is open, **When** the reviewer closes it, **Then** they return to the History tab in its prior state (same loaded revisions, same scroll position expectation).

---

### User Story 2 - Understand there's nothing to compare for the oldest revision (Priority: P2)

A reviewer looks at the oldest (first) revision of a document, which has no predecessor. The system should not offer a diff that cannot be computed.

**Why this priority**: Prevents user confusion and broken states; small in scope but necessary for correctness.

**Independent Test**: Scroll the History tab to the earliest revision (revision 1 / the initial document creation). Verify the "Diff" action is absent or disabled for that entry.

**Acceptance Scenarios**:

1. **Given** the History tab shows the first revision of the document, **When** the reviewer looks at that entry's actions, **Then** no functioning "Diff" action is offered for it.

---

### Edge Cases

- What happens when the previous revision's content is unavailable (e.g., failed to load)? The diff view should show a clear error state rather than a blank or broken comparison.
- What happens when the two revisions are identical (no textual change, e.g., a metadata-only revision)? The diff view should indicate no differences were found rather than appearing empty/broken.
- What happens with very large documents? The diff view should still render usefully; extreme cases may require the user to scroll within the diff view rather than the whole page becoming unresponsive.
- What happens if the reviewer requests a diff for a revision, then more revisions load (pagination "Load more") before the diff finishes loading? The diff already requested should complete normally and remain correct for the revision pair that was requested.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The History tab MUST display a "Diff" action on each revision entry that has an immediately preceding revision.
- **FR-002**: The History tab MUST NOT offer a working "Diff" action on the earliest revision of the document (it has no predecessor to compare against).
- **FR-003**: Activating the "Diff" action for a revision MUST retrieve the full content of that revision and of the immediately preceding revision.
- **FR-004**: The system MUST present the comparison as a line-or-text-level diff, clearly distinguishing added content, removed content, and unchanged content.
- **FR-005**: The reviewer MUST be able to close the diff view and return to the History tab without side effects (no change to revisions, proposals, or the current document).
- **FR-006**: If either revision's content fails to load, the system MUST show an error message in place of the diff rather than a blank or partial comparison.
- **FR-007**: If the compared revisions have identical content, the system MUST indicate that no differences were found.
- **FR-008**: Viewing a diff MUST NOT alter document state, revision history, or any proposal/edit status (read-only operation).

### Key Entities

- **Revision**: An existing entity (already in the system) representing a saved snapshot of the document at a point in time, identified by a revision number, with associated content retrievable on demand. This feature adds a read-only comparison capability between two adjacent Revisions; no new persisted entity is introduced.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can view the difference between any revision and its predecessor within 2 clicks from the History tab.
- **SC-002**: 100% of revisions with a predecessor offer a working diff action; 0% of first/root revisions offer a non-functional one.
- **SC-003**: Reviewers can visually identify what changed between two consecutive revisions without leaving the application or exporting files manually.
- **SC-004**: Diff results render within 2 seconds for documents of typical review size.

## Assumptions

- "Previous document" means the revision immediately preceding the selected one in the document's own revision sequence (by revision number), not the previous revision viewed by the user or a specific arbitrary comparison target.
- The diff compares plain text content of the two revisions (the same textual content already surfaced via existing export/copy functionality), not rich formatting or structural/semantic changes.
- The diff view is presented within the existing application (e.g., an overlay or panel), not as a separate exported file — consistent with how History currently keeps actions (Restore, Download, Copy) in-context.
- Only revision content already accessible to the current user via existing history/export permissions is used; no new access control model is introduced.
- Comparing two revisions is read-only and does not require network round-trips beyond fetching the two revisions' content already supported by the system.
