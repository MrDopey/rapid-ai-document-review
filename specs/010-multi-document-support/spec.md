# Feature Specification: Multi-Document Support

**Feature Branch**: `010-multi-document-support`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "support multiple documents to edit"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and switch between multiple documents (Priority: P1)

A user working on one document wants to start a second, unrelated document without losing or overwriting the first. They open a title-bar dropdown next to the current document's name, choose "+ New document", and get a fresh empty document with its own editor, preview, and Main conversation. They can reopen the dropdown at any time to jump back to the previous document, or to any other document they've created.

**Why this priority**: This is the entire feature — without the ability to create and switch, there is no multi-document support. It directly closes the gap left by the v1 single-document design (spec 001), which explicitly deferred this capability.

**Independent Test**: From an existing document, create a new document via the dropdown, type distinct content into it, then use the dropdown to switch back to the original document and confirm its content is exactly as left; switch forward again and confirm the new document's content persisted.

**Acceptance Scenarios**:

1. **Given** a document is open, **When** the user opens the title-bar dropdown and selects "+ New document", **Then** a new, empty document is created, becomes the active document, and appears in the dropdown list.
2. **Given** two or more documents exist, **When** the user opens the dropdown, **Then** every document is listed by title with the currently active one visibly marked.
3. **Given** the dropdown is open, **When** the user selects a document other than the active one, **Then** the workspace (preview, editor, conversation sidebar, and header) replaces its contents with that document's state and the dropdown closes.
4. **Given** the user is mid-edit on Document A with unsaved keystrokes, **When** they switch to Document B and later switch back to Document A, **Then** Document A reflects the edits exactly as they were left, with no loss or mixing of content between documents.
5. **Given** two or more documents exist, **When** the user presses the switch-document keyboard shortcut, **Then** the active document cycles to the next (or, with its reverse variant, the previous) document in the list without requiring the mouse or the dropdown to be open.

---

### User Story 2 - Each document keeps its own independent conversations and history (Priority: P1)

A user has separate conversations and revision history running on Document A. They switch to Document B, have a completely separate set of conversations there, then switch back to Document A and find its conversations, in-flight agent responses, and revision history untouched and unaffected by anything that happened in Document B.

**Why this priority**: Multi-document support is only safe and useful if documents are fully isolated from one another; without this, the feature would silently corrupt or leak state across unrelated documents, which is worse than not having the feature at all.

**Independent Test**: Start a conversation and let an agent begin streaming a response in Document A, immediately switch to Document B, confirm Document B shows no trace of Document A's conversation, then switch back to Document A and confirm the streamed response completed and is fully visible, and that Document A's revision history contains only its own changes.

**Acceptance Scenarios**:

1. **Given** Document A has one or more open conversations, **When** the user switches to Document B, **Then** Document B shows only its own conversations (starting with just its own Main conversation if newly created), never Document A's.
2. **Given** an agent is actively streaming a response in a conversation belonging to the document the user just navigated away from, **When** the user is viewing a different document, **Then** the response continues generating in the background and is fully present, uninterrupted, when the user switches back.
3. **Given** Document A and Document B each have their own revision history, **When** the user inspects either document's history, **Then** it contains only edits and revisions made to that document.

---

### User Story 3 - Rename or remove a document (Priority: P2)

A user wants to give a document a meaningful title so it's recognizable in the dropdown, and wants to get rid of documents they no longer need so the list doesn't accumulate clutter indefinitely.

**Why this priority**: Useful for keeping a growing document list manageable, but the feature is already viable without it (User Stories 1-2 deliver the core value); this is a quality-of-life addition.

**Independent Test**: Rename a document from the dropdown/header and confirm the new title appears everywhere it's referenced; delete a non-active document from the dropdown and confirm it no longer appears in the list and its content is no longer reachable.

**Acceptance Scenarios**:

1. **Given** a document is active, **When** the user renames it, **Then** the new title is reflected immediately in the header and in the dropdown list.
2. **Given** more than one document exists, **When** the user deletes a document that is not the active one, **Then** it is removed from the dropdown and can no longer be opened.
3. **Given** exactly one document exists, **When** the user attempts to delete it, **Then** the system prevents the deletion so at least one document always remains.
4. **Given** the user chooses to delete a document, **When** they confirm the action, **Then** the system requires an explicit confirmation step before permanently removing the document and its history.

---

### Edge Cases

- What happens if the user creates a new document while an unnamed/empty document they already created is still empty? The system still creates a distinct new document; empty documents are not deduplicated or reused automatically.
- What happens when a document is deleted while one of its conversations has an agent response actively streaming? The in-flight operation is stopped and discarded along with the rest of the document's state; there is nothing to resume since the document no longer exists.
- What happens when the number of open documents grows large (e.g., dozens)? The dropdown remains scrollable and usable, listed by most-recently-active order, without a hard limit on count in v1.
- How does the system distinguish two documents with the same (or no) title? Documents are identified internally by a stable identifier regardless of title; duplicate or blank titles are permitted and disambiguated in the dropdown by recency and, if needed, a short content preview.
- What happens on application restart with multiple documents open? All documents persist and reappear in the dropdown; the document that was active at shutdown becomes active again on restart.
- What happens when the switch-document keyboard shortcut is pressed while only one document exists? Nothing changes; the shortcut is a no-op since there is no other document to switch to.
- What happens when the switch-document keyboard shortcut is pressed while the dropdown is already open? The shortcut still moves the active document and updates which item the dropdown shows as active, without requiring the dropdown to be closed first.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow the user to create a new, empty document at any time via a "+ New document" action in the title-bar dropdown.
- **FR-002**: System MUST display a title-bar dropdown, anchored to the active document's title, that lists every existing document by title and visibly indicates which one is currently active.
- **FR-003**: System MUST allow the user to switch the active document by selecting any other document from the dropdown, replacing the entire workspace (editor, preview, conversation sidebar, conversation HUD, and history panel) with that document's state.
- **FR-003a**: System MUST provide a keyboard shortcut (and its reverse-direction counterpart) that cycles the active document to the next/previous document, without opening the dropdown or using the mouse, consistent with the application's existing keyboard-accessibility standard (spec 001, FR-043a).
- **FR-004**: System MUST keep each document's content, revision history, and conversations fully isolated from every other document — no content, message, or history entry from one document is ever shown, merged into, or mutated by actions taken on another document.
- **FR-005**: System MUST preserve the complete state of a document (including unsaved in-progress edits and open conversation state) when the user navigates away from it, and restore that exact state when the user navigates back.
- **FR-006**: System MUST continue any in-progress agent operation (e.g., a streaming response) for a document the user is not currently viewing, and present the completed result when the user returns to that document.
- **FR-007**: System MUST allow the user to rename a document, with the new title reflected in both the header and the dropdown.
- **FR-008**: System MUST allow the user to delete a document that is not the currently active one, after an explicit confirmation step, removing it and its history permanently.
- **FR-009**: System MUST prevent deletion of the last remaining document, ensuring at least one document always exists.
- **FR-010**: System MUST create every new document with its own initial Main conversation, consistent with the single-document creation behavior defined in the existing document-review feature (spec 001).
- **FR-011**: System MUST persist all documents and which one was active across application restarts, so the full multi-document state survives a restart exactly as it was.
- **FR-012**: System MUST apply all existing per-document guarantees from spec 001 (autosave, revision history, conflict handling, proposal review, export, accessibility, sanitization, structured logging) independently and identically to every document, not just the first one created.

### Key Entities

- **Document**: A distinct Markdown document with its own identifier, title, content, revision history, and set of conversations. Multiple Documents can exist simultaneously and are fully independent of one another.
- **Document Summary**: The lightweight representation of a Document shown in the title-bar dropdown (identifier, title, active/inactive indicator, recency) used for listing and switching without loading full document state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create a new document and begin typing into it in under 5 seconds from opening the dropdown.
- **SC-002**: Switching the active document via the dropdown completes, with the new document's content and conversations fully visible, within 1 second.
- **SC-003**: Across repeated switching between at least 5 documents, 100% of each document's content, conversation history, and revision history remain correctly isolated and unchanged by activity in any other document.
- **SC-004**: A user managing up to 20 open documents can locate and switch to any specific one via the dropdown on their first attempt, without confusion about which document is currently active.
- **SC-005**: After an application restart, 100% of previously open documents reappear with their content, history, and conversations intact, and the document active before restart is active again afterward.

## Assumptions

- The title-bar dropdown (rather than a persistent tab strip or sidebar list) is the chosen UI pattern for creating and switching documents, per the design confirmed with the user before this spec was written.
- All documents belong to the single local user of this localhost-only application (per spec 001's single-user assumption); there is no per-document sharing, permissions, or multi-user access in v1.
- There is no v1 requirement for a search/filter box within the dropdown; a scrollable, most-recently-active-ordered list is sufficient at the assumed usage scale (tens, not hundreds, of documents).
- Deleting a document is a hard, immediate delete (after confirmation) rather than a soft-delete/archive/trash mechanism; recovery of a deleted document's history is out of scope for v1.
- Each document independently follows the same size ceiling already assumed for the single document in spec 001 (~30 pages / ~15,000 words each).
- Cross-document features (copying content between documents, an agent referencing more than one document at once, merging documents) are explicitly out of scope for v1 — this feature is about managing several independent documents side by side, not about relating them to each other.
- The document-switch shortcut cycles through documents in the same most-recently-active order shown in the dropdown; the exact key combination is chosen during planning to avoid colliding with the application's existing global shortcuts (all of which currently use the Ctrl+Alt modifier combination, per the existing keymap registry), rather than fixed here.
