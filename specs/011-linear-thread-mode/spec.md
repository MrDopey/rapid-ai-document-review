# Feature Specification: Linear Thread Mode

**Feature Branch**: `[011-linear-thread-mode]`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "i want a 'second mode' to the application, it should reuse a lot of code already existing in this codebase, it's design is heavily inspired by this, but instead of branching logic just on the RHS of the page, the conversation is top down, there is no 'main' thread, branching happens at N-1, so the user can continue a chat and keep the context lean on this branched conversation. a user can be done with the conversation so the visual clutter disappears. remember that these are Pi branched sessions. it will need to use SessionManager.branch method and support Pi export rendering in the browser"

## Clarifications

### Session 2026-09-15

- Q: Does linear thread mode show the same conversations as the existing canvas mode (a view toggle over shared data), or a separate, non-interoperating set of threads? → A: Separate — linear thread mode's threads are their own set, scoped to this mode only, distinct from the canvas mode's conversations for the same document.
- Q: What does "branching at N-1" mean — automatic per-message branching, or a manual branch action, and anchored relative to what? → A: A manual branch action triggered by highlighting a passage of text within an earlier message: the reviewer picks any earlier message in the thread as the anchor point (any position strictly before the thread's current tip — N-1, N-2, or any earlier message are all valid) by selecting text inside it. Anchoring at the tip itself (N) is never allowed, since that would be indistinguishable from just continuing the thread forward. The new branch is seeded with the highlighted passage, wrapped in a matching pair of XML-style tags (e.g. `<branch-seed-excerpt>...</branch-seed-excerpt>`), as the start of its first message — consistent with the constitution's existing seed-content tagging rule (Quality & Review Gates), not a Markdown blockquote.
- Q: Should "Pi export rendering in browser" reuse existing in-app transcript rendering, or be a genuine Pi-native export/viewer requiring a constitution change? → A: Genuine Pi-native export/viewer. The project is now past v1, so the existing "Pi export viewing" non-goal (Technology & Platform Constraints) is superseded for this feature; a constitution amendment removing that non-goal is a prerequisite for `/speckit-plan` on this feature.

### Session 2026-09-20

- Q: How does a user get into linear thread mode for a document — a runtime mode toggle per document, or a choice made once at document creation? → A: Chosen once, at document-creation time, extending spec 010's document-creation flow: the user picks whether the new document is a canvas-mode document or a threaded-conversation (linear thread mode) document. A threaded-conversation document starts with exactly one root thread, auto-created the same way a canvas-mode document gets its initial Main conversation (spec 010 FR-010). No additional independent top-level thread may be created afterward — every other thread in that document must be created by branching from the root thread or one of its descendants. This supersedes the 2026-09-15 session's framing of linear thread mode as a per-document runtime toggle (old FR-001/FR-014 and the related Assumptions bullet) and the earlier "start a new top-level thread at any time" capability (old FR-004).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start from a single root thread and read/converse top-down (Priority: P1)

A reviewer creates a new document (per spec 010's document-creation flow) and chooses "threaded conversation" as its type, instead of a canvas-mode document. That document starts with exactly one root thread — automatically created, the same way a canvas-mode document starts with its initial Main conversation — rendered at the top of a top-down list. Unlike canvas mode's Main conversation, this root thread carries no pinned position or special ongoing privileges beyond being the tree's single starting point: every other thread in the document is created by branching from the root or one of its descendants, rendered top-to-bottom in the order created or last active. There is no way to start a second, independent top-level thread alongside the root — a threaded-conversation document has exactly one root, always.

**Why this priority**: This is the structural core of the second mode — without a single-rooted, top-down list of threads (in place of the Main/RHS-column canvas layout), none of the other capabilities in this feature have a home.

**Independent Test**: Create a document as a threaded conversation. Verify exactly one root thread exists and renders at the top of a top-down list, and that there is no action available to create a second, independent top-level thread — only branch actions are offered.

**Acceptance Scenarios**:

1. **Given** a user creates a new document and chooses "threaded conversation" as its type, **When** the document is created, **Then** exactly one root thread is created automatically and rendered at the top of the top-down list.
2. **Given** a threaded-conversation document already has its root thread, **When** the reviewer looks for a way to start another independent top-level thread, **Then** no such action exists — every new thread must be created by branching from an existing message in the root thread or one of its descendants.
3. **Given** the root thread, **When** the reviewer views or acts on it, **Then** it behaves like any other thread (branchable, markable done) except that it can never be deleted or leave the document without a root, mirroring the guarantee that a document always has at least one starting conversation (spec 010, FR-010).
4. **Given** a document was created as a canvas-mode document (not a threaded conversation), **When** the reviewer looks for linear thread mode's view for that document, **Then** it is not available — a document's type (canvas or threaded conversation) is fixed at creation time.

---

### User Story 2 - Highlight a passage in an earlier message to branch, with the excerpt seeded into the new branch (Priority: P2)

While in a thread, a reviewer wants to explore a different follow-up from something said earlier without losing their current line of questioning and without carrying everything said since that point into the new branch. They highlight a passage of text within an earlier message — any message other than the thread's current tip, since branching there would be indistinguishable from just continuing forward — and branch from it. The new branch shares everything up to and including the message that passage came from; anything said after that point in the source thread is left behind, keeping the new branch's inherited context leaner than the full source thread. The new branch opens with the highlighted passage already quoted as its seed, wrapped in a matching pair of XML-style tags (per the constitution's seed-content tagging rule), so the reviewer can immediately continue typing their own follow-up after it instead of re-finding or re-typing what they were reacting to. The branch and its source remain genuinely linked Pi-level branches of the same underlying session — not independent copies — so the relationship is real, not just a UI grouping.

**Why this priority**: Branching is the second pillar of this mode (after the top-down, no-Main layout) and is what makes "keep exploring without losing your place" possible; it depends on User Story 1's structure existing first.

**Independent Test**: From a thread with at least three prior turns, highlight a passage within an earlier message (not the tip) and branch from it. Verify the new branch is created as a genuine Pi-level branch of the source thread's session (not a fresh, unrelated session), that it shares history only up to and including the message the highlight came from, that the new branch's seed is the highlighted passage wrapped in a matching XML-style tag pair, and that the reviewer can continue typing their own message immediately.

**Acceptance Scenarios**:

1. **Given** a thread with several prior turns, **When** the reviewer highlights a passage within an earlier message (not the tip) and branches from it, **Then** a new thread is created that shares the source thread's history up to and including that message, and messages sent afterward in either thread are visible only in the thread they were sent to.
2. **Given** the reviewer has just branched from a highlighted passage, **When** they view the new branch, **Then** its first message is seeded with the highlighted text wrapped in a matching pair of XML-style tags (e.g. `<branch-seed-excerpt>...</branch-seed-excerpt>`), and the reviewer can continue writing their own text as part of that same message, after the closing tag.
3. **Given** a branch has just been created, **When** the reviewer sends their message (quoted excerpt plus their own follow-up text), **Then** the branch continues the conversation without requiring the reviewer to re-establish context manually.
4. **Given** a thread has been branched more than once, **When** the reviewer views the resulting threads, **Then** each branch is distinguishable as its own thread while still showing which thread it came from.
5. **Given** a reviewer attempts to highlight text in a thread's current tip (its latest message) and branch from it, **When** they do so, **Then** the system disallows anchoring there — the branch anchor must be strictly earlier than the tip — since that would be indistinguishable from simply continuing the source thread forward.
6. **Given** a thread is branched from an anchor point partway through its history, **When** the reviewer views the top-down list afterward, **Then** the source thread's rendering visually splits at that anchor point: the history strictly before the anchor stays on the original segment, the history from the anchor onward renders as a new continuation segment beneath it, and the new branch appears as a sibling fork alongside that continuation segment — with no change to the thread's stored history or its identity as one continuous branch of the underlying Pi session tree.
7. **Given** a continuation segment produced by a prior split is itself later branched from a further anchor point within it, **When** the reviewer views the list, **Then** that segment splits again the same way, producing another sibling fork and a further continuation segment beneath it — so a thread with multiple branch points along its own history renders as multiple stacked segments.
8. **Given** a thread has been split into two or more segments, **When** the reviewer looks for a way to compose a new message directly on a non-tip segment (any segment other than the final one, which reflects the thread's actual current tip), **Then** no compose action is offered there — only the highlight-to-branch action is available on a non-tip segment; sending a new message is only possible from the thread's current tip.
9. **Given** two or more passages are highlighted within the same message and each is branched separately, **When** the reviewer views the result, **Then** all of the resulting branches are rendered as sibling forks at the same split point (the message they were all anchored in), each seeded with its own distinct highlighted excerpt, and the source thread's own continuation (if it has one) appears as a further sibling at that same point.

---

### User Story 3 - Mark a thread done to declutter the view (Priority: P3)

A reviewer has finished what they needed from a thread — the question is answered, the exploration is over — and doesn't want it competing for visual attention with active threads. They mark the thread done. It stops appearing in the default top-down list, so only threads still in progress clutter the view. The reviewer can still find and reopen a done thread later if they need to revisit it; marking done does not delete anything.

**Why this priority**: This keeps the mode usable once User Stories 1-2 make many threads possible on the same document; it is a refinement of visual ergonomics rather than the structural change itself, so it can ship after the core layout and branching exist.

**Independent Test**: In linear thread mode, mark an active thread done. Verify it disappears from the default top-down list immediately, while remaining retrievable (e.g., via a "done"/history view) with its full history intact.

**Acceptance Scenarios**:

1. **Given** an active thread in the top-down list, **When** the reviewer marks it done, **Then** it no longer appears in the default top-down list.
2. **Given** a thread has been marked done, **When** the reviewer looks for it outside the default list, **Then** they can still find it and view its full history unchanged.
3. **Given** a done thread, **When** the reviewer marks it done, **Then** doing so does not delete the thread, its messages, or any branch relationship it has to other threads.
4. **Given** a thread with un-done branches still descending from it, **When** the reviewer marks the parent thread done, **Then** the still-active branches remain visible in the default top-down list, unaffected by their parent's done state.

---

### User Story 4 - Render a genuine Pi-native session export in the browser (Priority: P4)

A reviewer wants to view a thread's full, native Pi session export, rendered in the browser, in a form suitable for sharing or archival — not just the application's own transcript view, but the underlying Pi session export itself. They export the thread and see that export rendered on screen.

**Why this priority**: This is a convenience/archival capability layered on top of threads that already exist and already render; it is not required for the mode's core value (Stories 1-3), so it is sequenced last. It also depends on a constitution amendment (removing the existing "Pi export viewing" non-goal, per Clarifications) landing before this story can be planned.

**Independent Test**: From a thread with message history, trigger the export action and verify the native Pi session export renders in the browser, matching the thread's actual message history.

A reviewer may also want the whole document's conversation tree at once — every thread and branch together, not just one thread's own path — for sharing or archival as a single artifact. They trigger a document-wide export and see the entire shared Pi session tree rendered as one interactive, self-contained view, distinct from (and in addition to) a single thread's own export.

**Acceptance Scenarios**:

1. **Given** a thread with message history, **When** the reviewer exports it, **Then** a rendered view of that thread's native Pi session export displays in the browser.
2. **Given** an exported, rendered session, **When** the reviewer compares it to the live thread, **Then** the content matches the thread's actual history at the time of export.
3. **Given** the constitution's current "Pi export viewing" non-goal has not yet been amended, **When** planning for this story begins, **Then** planning is blocked until that amendment lands (see Clarifications and Assumptions).
4. **Given** a threaded-conversation document with more than one thread (a root plus at least one branch), **When** the reviewer triggers the document-wide export action, **Then** a single rendered artifact displays in the browser containing every thread's content, with the ability to navigate between threads/branches within that one artifact.
5. **Given** a threaded-conversation document with no messages in any of its threads, **When** the reviewer triggers the document-wide export action, **Then** the export is refused with a message explaining there is nothing to export yet.

---

### Edge Cases

- What happens when a reviewer tries to branch from a thread that has already been marked done? The branch succeeds — a done thread's own history remains a valid branch point — and the new branch is active (not done) regardless of its done parent, consistent with User Story 3's scenario 4.
- What happens when two threads are branched from the same point in the same source thread? Both branches are created independently, each with its own subsequent messages private to itself, consistent with the existing project-wide branching semantics (see specs/005-canvas-conversation-threads).
- What happens when the configured maximum conversation branching depth (Constitution Principle V) is reached in linear thread mode? Branching is refused with the same enforced-limit behavior already used elsewhere in the application; this feature does not introduce a second, competing limit.
- What happens to a thread's pending, unresolved edit proposals when the reviewer tries to mark it done? Marking done is blocked until proposals are resolved, consistent with the existing rule that a conversation cannot be closed while it has staged edits without a verdict.
- What happens if the reviewer switches (per spec 010's document switcher) away from a threaded-conversation document and later switches back? Its root thread, all branches, and their done/active state persist exactly as left; switching to or from a different document (of either type) does not reset or discard anything.
- What happens if the reviewer tries to delete or otherwise remove a threaded-conversation document's root thread? It is refused — a threaded-conversation document must always retain its root thread, mirroring the rule that a document must always exist with a starting conversation (spec 010, FR-010).
- What happens if the reviewer wants a document to change type after creation (e.g., from canvas-mode to threaded conversation, or vice versa)? Not supported — a document's type is fixed at creation time (see Clarifications, 2026-09-20); a reviewer who wants the other mode creates a new document of that type.
- What happens when a thread accumulates multiple branch points along its own history over time? Its rendering splits into as many stacked segments as there are branch points, each ending where the next branch's anchor begins, with the branches themselves rendered as sibling forks alongside the corresponding continuation segment; the underlying thread and its stored history are unaffected — this is purely a rendering view of one continuous message history (FR-005b).
- What happens if a reviewer tries to compose a new message directly on a non-tip segment of a split thread? Not possible — no compose action is offered there; only the highlight-to-branch action is available on a non-tip segment, since new messages can only extend a thread's actual current tip (FR-005c).
- What happens when two or more branches are created from highlighted passages within the very same message? All resulting branches render as sibling forks at that same split point, each with its own distinct seeded excerpt, alongside the source thread's own continuation if it has one — consistent with User Story 2, scenario 9.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST let a user choose, when creating a document (spec 010's document-creation flow), whether it is a canvas-mode document (specs/005-canvas-conversation-threads) or a threaded-conversation (linear thread mode) document; this choice is fixed for the document's lifetime.
- **FR-002**: In a threaded-conversation document, all threads MUST render in a single top-down (vertically ordered) list rather than in spatially colocated side columns.
- **FR-003**: A threaded-conversation document MUST have exactly one root thread, and MUST NOT permit creating a second, independent top-level thread; every thread other than the root MUST be created by branching from the root or one of its descendants.
- **FR-004**: The application MUST automatically create a threaded-conversation document's single root thread at the moment the document is created, the same way a canvas-mode document is created with its initial Main conversation (spec 010, FR-010).
- **FR-005**: Users MUST be able to highlight a passage of text within any message in a thread's history and branch from it, producing a new thread that shares the source thread's history up to and including the message the highlighted passage came from. Messages added afterward MUST be visible only within the thread they were added to.
- **FR-005a**: Branching from a highlighted passage MUST seed the new branch's first message with that passage wrapped in a matching pair of XML-style tags (e.g. `<branch-seed-excerpt>...</branch-seed-excerpt>`), consistent with the constitution's existing rule that document/seed content embedded in a message MUST be tag-delimited from surrounding prose (Quality & Review Gates); the reviewer can then continue by adding their own text to the same message, after the closing tag.
- **FR-005b**: When a branch is created from an anchor point partway through a thread's history, the source thread's rendering MUST visually split at that anchor point: the portion of history strictly before the anchor remains part of the original segment, and the portion from the anchor onward MUST render as a new continuation segment beneath it, with the new branch appearing as a sibling fork alongside that continuation segment. This split MUST be a rendering behavior only — it MUST NOT alter the thread's stored message history, its identity as a single continuous branch of the underlying Pi session tree, or any data other than presentation. The continuation segment MUST remain left-aligned with the segment it continues, so the source thread reads as one straight vertical line down the page; each branch MUST render indented to the right of the segment it forks from, so branches are visually distinguishable from the source thread's own continuation at a glance. If a continuation segment is itself later branched from a further anchor point within it, it MUST split again the same way, recursively. Multiple branches anchored within the same message MUST render as sibling forks at that same split point, alongside the source thread's own continuation if it has one.
- **FR-005c**: Only a thread's current tip segment (the final segment, ending at the thread's actual current tip) MAY accept a new message composed directly in that thread. Every earlier segment, once split off by a later branch point, MUST be read-only history: the only action available on it is highlighting a passage to create a further branch — never composing a message that appends to it directly.
- **FR-006**: A branch created in linear thread mode MUST be a genuine branch of the same underlying Pi conversation session as its source thread (not an independently forked or copied session), consistent with Constitution Principle II (Pi owns agent sessions and conversation branching; the application interacts with this exclusively through the Pi SDK, and only through the module already designated as the sole integration point).
- **FR-007**: Branching MUST NOT allow anchoring the new branch at the source thread's current tip (its latest message); the picked anchor MUST always be strictly earlier than the tip (N-1, N-2, or any earlier message), since anchoring at the tip would be indistinguishable from simply continuing the source thread forward.
- **FR-008**: Users MUST be able to mark an active thread as done; once done, the thread MUST NOT appear in the default top-down list.
- **FR-009**: Marking a thread done MUST be non-destructive: the thread, its message history, and its branch relationships MUST remain intact and retrievable outside the default list.
- **FR-010**: A thread MUST NOT be markable as done while it has staged edits without a verdict (applied or dropped), consistent with the existing project-wide rule for closing conversations.
- **FR-011**: Marking a parent thread done MUST NOT affect the visibility, active state, or availability of any of its still-active branch threads.
- **FR-012**: Linear thread mode MUST enforce the same configured maximum conversation branching depth already enforced elsewhere in the application (Constitution Principle V), rather than introducing a separate limit.
- **FR-013**: Users MUST be able to export a thread's genuine, native Pi session export and have it render in the browser, matching that thread's actual message history at export time. This requires the constitution's existing "Pi export viewing" non-goal (Technology & Platform Constraints) to be amended before this requirement can be planned or implemented (see Clarifications, Assumptions).
- **FR-013b**: Users MUST also be able to export an entire threaded-conversation document's shared Pi session tree — every thread and branch together, not just one thread's own path — and have it render in the browser as a single, self-contained interactive artifact, obtained exclusively via the Pi SDK's own whole-tree export primitive. This is additional to, not a replacement for, FR-013's per-thread export, and depends on the same constitution amendment being further extended to cover a document-wide, whole-tree export (see Assumptions). Exporting a document with no message history in any of its threads MUST be refused.
- **FR-014**: A document's type (canvas-mode or threaded-conversation) MUST be fixed at creation time and MUST NOT be changeable afterward; switching the active document (per spec 010's document switcher) between documents of either type MUST preserve each document's thread state (including any done/active status) without resetting or discarding it.
- **FR-015**: Linear thread mode MUST reuse the application's existing conversation, document, and edit-proposal machinery (storage, event streaming, edit pipeline) rather than introducing a parallel implementation of capabilities that already exist for the canvas mode, except where this feature's requirements above (top-down layout, single root thread, done/declutter) explicitly call for different behavior.

### Key Entities

- **Thread**: A conversation in a threaded-conversation document — equivalent in underlying nature to an existing application conversation, but rendered in the top-down list rather than spatially. Holds an ordered message history, a reference to its parent thread and branch-anchor point (if it is a branch — every thread except the root is a branch), and a done/active state. Exactly one Thread per threaded-conversation document has no parent: the root thread, auto-created with the document (FR-004).
- **Branch anchor point**: The specific message within a source thread's history — identified by the reviewer highlighting a passage inside it — that a new branch shares up to and including; any message strictly earlier than the source thread's current tip, never the tip itself (FR-005, FR-007).
- **Seed excerpt**: The highlighted passage that triggered a branch, carried into the new branch's first message wrapped in a matching pair of XML-style tags (e.g. `<branch-seed-excerpt>...</branch-seed-excerpt>`), ahead of whatever the reviewer types next (FR-005a).
- **Thread segment**: The visually rendered slice of a Thread's message history between two consecutive branch points (or between the thread's start/a branch point and its current tip). A purely presentational subdivision, not a separate stored entity — a Thread with no branches off its own history renders as a single segment; each additional branch point along a Thread's history produces one more stacked segment (FR-005b). Only the final segment (ending at the thread's current tip) accepts new messages composed directly in the thread; every earlier segment is read-only history, actionable only via highlight-to-branch (FR-005c).
- **Done state**: A non-destructive, reversible-by-retrieval visibility state on a thread; a done thread is excluded from the default top-down list but remains fully intact.
- **Exported session**: A browser-rendered view of a thread's genuine, native Pi session export, produced on demand (FR-013).
- **Exported document session**: A browser-rendered view of an entire threaded-conversation document's shared Pi session tree — every thread/branch together — produced on demand via the Pi SDK's whole-tree export primitive (FR-013b), distinct from a single thread's own Exported session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create a document as a threaded conversation and, within one action, see its single root thread rendered at the top of a top-down list, with no action available anywhere in that document to create a second, independent top-level thread.
- **SC-002**: A user can branch any thread and send their next message in the resulting branch without performing any additional setup or context-re-entry step.
- **SC-003**: Marking a thread done removes it from the default view in exactly one user action, and a user can retrieve its full, unchanged history afterward in a bounded number of additional actions (e.g., opening a "done" list).
- **SC-004**: In a document with multiple active and multiple done threads, a user can identify, from the default top-down list alone, that every visible thread is still active — no done thread appears there.
- **SC-005**: A user can export any thread and view its rendered transcript in the browser, with the rendered content matching the thread's message history at the time of export.
- **SC-006**: A user can export an entire threaded-conversation document and view one rendered artifact in the browser containing every thread's content, without needing to export each thread individually.

## Assumptions

- Linear thread mode is an additional document type alongside the existing canvas-mode document (specs/005-canvas-conversation-threads), selected once at document-creation time via spec 010's document-creation flow; it replaces neither canvas mode nor its underlying conversation data model, and a document never holds both types of thread set at once. This feature reuses the existing conversation/document/edit-proposal backend *machinery* (storage, event streaming, edit pipeline), not the canvas mode's existing conversation *rows/data* themselves.
- This feature depends on spec 010's document-creation flow being extended with a document-type choice (canvas vs. threaded conversation); until that choice exists, a threaded-conversation document cannot be created.
- "Done" in this feature is a mode-specific visibility state analogous to, but distinct from, the existing conversation "closed" status; a done thread is still expected to behave like a closed conversation for guardrails that already apply to closing (e.g., the staged-edits-must-be-resolved rule), while final terminology and exact behavioral overlap with "closed" is a plan-phase decision.
- The maximum conversation branching depth and other existing configurable, enforced limits (Constitution Principle V) apply unchanged to threads and branches created in this mode.
- All Pi SDK access required by this feature continues to go exclusively through the application's existing, sole Pi-integration module, consistent with Constitution Principle II; this feature does not introduce a second code path that talks to Pi directly.
- Sanitization of any rendered thread content (including the native Pi session export view) continues to go through the application's existing abstracted sanitization layer (Constitution Principle VI); this feature does not introduce a second, unsanitized rendering path.
- Zooming, spatial positioning, and highlight-anchoring from the canvas mode (specs/005) are explicitly out of scope for linear thread mode's top-down list — its ordering is purely chronological/activity-based, not spatial.
- **Blocking prerequisite**: the constitution's Technology & Platform Constraints currently list "Pi export viewing" as an explicit v1 non-goal. Per Clarifications, the project is now past v1 and this feature requires that non-goal removed via a constitution amendment (`/speckit-constitution`) before FR-013/User Story 4 can be planned; Stories 1-3 (FR-001 through FR-012) do not depend on this amendment and can be planned independently of it.
- FR-013b's document-wide export similarly depended on the same carve-out being further extended (constitution v2.5.0) to explicitly cover a whole-tree export via `AgentSession.exportToHtml()`, alongside the single-thread export the v2.4.0 amendment already covered; that extension has landed, so FR-013b was planned in the same follow-up pass as FR-013.
