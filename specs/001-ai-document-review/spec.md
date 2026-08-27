# Feature Specification: AI Document Review Application

**Feature Branch**: `001-ai-document-review`

**Created**: 2026-08-25

**Status**: Draft

**Input**: User description: "@design.md" — a rapid-review environment where a user edits a Markdown document while holding multiple concurrent, branching conversations with an AI agent, reviewing agent-proposed edits before they change the document (full technical design in `design.md`).

## Clarifications

### Session 2026-08-25

- Q: What should happen when the Primary conversation's agent produces an edit that can't be automatically merged into the current document? → A: Treat it like a staged-edit conflict — mark the edit superseded, ask the agent for a replacement informed by the conflict, and present that replacement to the user as a pending proposal for review; auto-apply resumes for the Primary conversation once resolved.
- Q: Once a document has been created, can the user discard it and start over with a brand-new document in v1? → A: No — the document persists for the life of the installation; replacing it requires the future multi-document capability.
- Q: What document size should the review workflows be designed to comfortably handle in v1? → A: Long-form document: up to ~30 pages / ~15,000 words.
- Q: Can the user export or download the document's Markdown content in v1? → A: Yes — the user can copy/download the current document's Markdown content at any time, and can also export any specific past revision, not just the live current state.
- Q: Is this application expected to be reachable only from the same machine it runs on (localhost), or could it be exposed to other devices on a network in v1? → A: Localhost-only — the application is designed and scoped for access only from the machine it runs on; no authentication is required, and exposing it further is an unsupported configuration.
- Q: What is the observability/logging approach for v1? → A: Key operational events (errors, conversation lifecycle, edit application) must be logged in a structured, consistent way; in v1 those logs are written to the console/standard output only — no persisted or queryable log store is required.
- Q: What accessibility and localization standard should v1 meet? → A: The interface must meet a high accessibility standard (keyboard navigable, screen-reader compatible, sufficient contrast, etc.); localization/translation is out of scope — English only in v1.

### Session 2026-08-25 (release-gate review)

- Q: What exactly makes a proposed edit unable to be automatically merged? → A: A conflict occurs when the document has been changed on the same lines the proposal was written against. Concretely, a proposal reconciles cleanly only if every part of it still matches exactly one unambiguous location in the current document and no two of those locations overlap; anything else — the anchored text gone, matching in more than one place, or two parts landing on overlapping regions — is a conflict, and the system never guesses at the intended location.
- Q: Must a Primary conversation always be designated? → A: No — Primary is optional. At most one conversation is Primary at any time, the Main conversation starts as Primary when the document is created, and the user may deselect Primary entirely. With no Primary set, every conversation stages its proposals for review.
- Q: On reconnecting mid-response, must the user see the partial response already produced, or only the finished message? → A: The partial response. The system keeps, for each active agent run, the output produced so far and replays it to a reconnecting client, so reconnection mid-response shows the response as it stands rather than an empty conversation until it completes.
- Q: What happens to an agent operation that was in flight when the application itself restarted? → A: It is not resumed automatically. The conversation is marked errored with the interruption visible, and the user can retry. Automatic resumption is excluded deliberately: it would spend model capacity the user did not ask for and could produce a duplicate proposal that the existing no-double-application guarantee does not cover.
- Q: Which accessibility conformance level must v1 meet? → A: WCAG 2.2 Level AA, as an externally verifiable gate, rather than a qualitative description.
- Q: Does the sanitization requirement cover agent conversation output as well as document content? → A: Yes — all agent-authored content displayed anywhere in the interface, including conversation messages and streamed reasoning, is untrusted and passes through the same sanitization as the document.
- Q: What bounds the propose → conflict → replacement → conflict cycle? → A: A configurable retry cap, defaulting to 2 replacement attempts. After the cap is exhausted the system stops requesting replacements automatically, leaves the last proposal superseded, and tells the user the agent could not produce an applicable edit — the user may then ask again in the conversation, which starts a fresh proposal with its own budget.
- Q: Is the localhost-only posture a requirement or an assumption? → A: A requirement. The application binds to the local loopback interface only; it is the feature's entire access-control model and must be enforced, not merely assumed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and edit a document with tracked history (Priority: P1)

A user pastes or types a Markdown document into the application, edits it directly, and can always see a rendered preview alongside the raw source. Every meaningful change — their own edits or ones made later by an agent — becomes a traceable point in the document's history that they can inspect or restore.

**Why this priority**: This is the foundation everything else depends on. Without a reliably persisted, versioned document, no conversation or review workflow has anything to operate on. It is also independently useful as a Markdown editor with history.

**Independent Test**: Paste a document, make several edits over time, stop editing, and verify a new history entry appears; then restore an earlier entry and confirm the document reflects it without deleting the entries in between.

**Acceptance Scenarios**:

1. **Given** no document exists yet, **When** the user pastes Markdown content, **Then** the document is created and rendered, and a first conversation is available for questions about it.
2. **Given** the user is editing the document, **When** they make changes, **Then** the changes are saved automatically and reflected for anyone else viewing the document.
3. **Given** the user has stopped editing, **When** the configured inactivity period elapses, **Then** the accumulated changes become one new named revision.
4. **Given** a past revision exists, **When** the user restores it, **Then** the document's content matches that revision and a new revision is recorded (no history is deleted).
5. **Given** the document exists, **When** the user chooses to export it, **Then** they can copy or download the current Markdown content, or the Markdown content of any specific past revision.
6. **Given** the application restarts, **When** it comes back up, **Then** the document, its revisions, and current content are exactly as before the restart (FR-039).

---

### User Story 2 - Ask the main conversation about the document (Priority: P1)

A user asks questions about the document in a persistent "Main" conversation and receives streamed, contextual answers grounded in the current document content.

**Why this priority**: This is the simplest form of the core value proposition — talking to an AI about a document — and can be demonstrated with no branching or editing workflow at all.

**Independent Test**: With a document loaded, ask the Main conversation a question about its content and confirm a relevant, streamed answer appears referencing the current document.

**Acceptance Scenarios**:

1. **Given** a document exists, **When** the user sends a message to Main, **Then** the message is answered using the current document as context, with the response streamed as it is produced.
2. **Given** the user has enabled or disabled visibility of the agent's reasoning, **When** a response streams in, **Then** reasoning content is shown or hidden accordingly.
3. **Given** a model or agent call fails while answering Main, **When** the failure occurs, **Then** Main is marked errored with the failure visible and the user can retry (FR-038).

---

### User Story 3 - Branch a focused conversation from a selection and review proposed edits (Priority: P2)

A user highlights part of the document, starts a new conversation scoped to that selection, and asks the agent to improve it. The agent proposes edits, which the user previews as a diff and individually accepts or drops — nothing changes in the document until the user says so.

**Why this priority**: This is the central "review" workflow of the product: focused, scoped conversations that produce reviewable, optional changes. It depends on User Stories 1 and 2 existing but is the first point where the application's control over document edits becomes visible.

**Independent Test**: Highlight a passage, start a branch, have the agent propose a change, preview the diff, and accept or drop it — confirming the document only changes on explicit acceptance.

**Acceptance Scenarios**:

1. **Given** the user highlights content and starts a conversation, **Then** the new conversation is seeded with the highlighted content and enough surrounding context to be understood on its own.
2. **Given** an active branched conversation, **When** its agent proposes an edit touching one or more parts of the document, **Then** the edit is held as a single pending proposal and the document is not changed.
3. **Given** a pending proposed edit, **When** the user previews it, **Then** they can see both a full-document preview and an added/removed changes view.
4. **Given** a pending proposed edit, **When** the user accepts it, **Then** the document is updated and a new revision is recorded; **When** they drop it instead, **Then** the document is unaffected and the proposal is discarded.
5. **Given** several pending proposed edits, **When** the user chooses "accept remaining" or "drop remaining", **Then** all unresolved edits are resolved accordingly.
6. **Given** a conversation has unresolved proposed edits, **When** the user tries to close it, **Then** the application prevents closure until every edit has a verdict.

---

### User Story 4 - Keep a conversation in sync with a changing document (Priority: P2)

While a branched conversation is open, the main document may keep advancing. The user can see when their conversation is working from an out-of-date view of the document and can explicitly bring it up to date before sending their next message.

**Why this priority**: Without this, users lose trust in what a conversation "knows" once the document has moved on. It directly supports User Story 3's workflow once more than one conversation is active.

**Independent Test**: Start a branch, advance the main document through another conversation, confirm the first branch is marked out of date, then refresh it and confirm it now reflects the latest document.

**Acceptance Scenarios**:

1. **Given** a conversation was started against an earlier document version, **When** the document advances, **Then** the interface marks that conversation as out of date without changing its behavior automatically.
2. **Given** an out-of-date conversation, **When** the user sends a message normally, **Then** the message is answered using the conversation's existing (older) context.
3. **Given** an out-of-date conversation, **When** the user chooses to refresh and send, **Then** the conversation's context is updated to the latest document version, including any proposed edits relevant to it, before the message is sent.

---

### User Story 5 - Designate a Primary conversation for automatic edits (Priority: P3)

A user marks one conversation as "Primary" so that edits it proposes are applied to the document automatically, without a manual review step, while all other conversations continue to stage their proposals for review. Primary is optional — the user can also deselect it, returning every conversation to staged review.

**Why this priority**: This is a productivity mode layered on top of the review workflow — valuable, but only after staged review (User Story 3) exists and is trustworthy.

**Independent Test**: Mark a conversation Primary, have its agent propose an edit, and confirm the document updates immediately with no pending proposal left behind; confirm other conversations still stage their edits.

**Acceptance Scenarios**:

1. **Given** a document exists, **Then** the Main conversation starts as Primary, and at most one conversation is Primary at any time.
2. **Given** a conversation is Primary, **When** the user deselects it without choosing a replacement, **Then** no conversation is Primary and every conversation — including Main — stages its proposed edits for review.
3. **Given** the Primary conversation is closed, **Then** the document is left with no Primary conversation rather than the designation passing to another conversation automatically.
4. **Given** a conversation is Primary, **When** its agent proposes an edit, **Then** the edit is applied to the document automatically and a new revision is recorded, with no staged proposal remaining.
5. **Given** the user selects a different conversation to become Primary, **When** the currently Primary conversation (or the target) is actively working, **Then** the user is warned and offered to switch immediately, not switch, or switch once the active work finishes.
6. **Given** the user switches Primary immediately, **When** the previous Primary conversation was mid-operation, **Then** that operation continues uninterrupted, it just no longer auto-applies future edits.
7. **Given** the Primary conversation's agent produces an edit that cannot be automatically merged into the current document, **Then** the edit is not silently applied or discarded: it is marked superseded, the agent is asked for a replacement informed by the conflict, and the replacement is presented to the user as a pending proposal for review, following the same conflict-resolution flow as any other proposed edit (see User Story 6).

---

### User Story 6 - Resolve conflicts when applying an out-of-date proposed edit (Priority: P3)

When a user tries to apply a staged proposal whose starting point is no longer the current document, the application first tries to reconcile it automatically; if that isn't possible, it asks the originating agent for a revised proposal instead of silently failing or corrupting the document.

**Why this priority**: This protects the integrity of the document once multiple conversations and manual edits interleave — a natural consequence of User Stories 3-5 running concurrently.

**Independent Test**: Create a staged proposal, advance the document through another path so the proposal's starting point is stale, then apply it and confirm either a clean automatic merge or a clearly presented replacement proposal.

**Acceptance Scenarios**:

1. **Given** a staged proposal whose source version is now behind the current document, **When** the user applies it, **Then** the application attempts to reconcile it automatically first.
2. **Given** automatic reconciliation succeeds, **Then** the edit is applied and a new revision is recorded.
3. **Given** automatic reconciliation fails, **Then** the original proposal is marked superseded, the originating agent is asked to propose a replacement informed by the conflict, and the replacement appears as a new pending proposal for the user to review.
4. **Given** a proposal whose replacement attempts have reached the configured limit, **When** the latest replacement also fails to reconcile, **Then** no further replacement is requested, the document is unchanged, and the user is told the agent could not produce an edit that applies to the current document.

---

### User Story 7 - Review closed conversations (Priority: P4)

After a conversation is closed, the user can still open it to read its history, see what it proposed, and understand what document version it was working from — and can ask a separate agent to review it and its branches without disturbing the closed conversation.

**Why this priority**: This is a trust and accountability feature that rounds out the review workflow but is not required for the core edit/review loop to function.

**Independent Test**: Close a conversation, reopen it in a read-only view, confirm its history and proposals are visible and it cannot be branched from, then request a review of it and confirm the review does not alter it.

**Acceptance Scenarios**:

1. **Given** a conversation with all proposed edits resolved, **When** the user closes it, **Then** it becomes closed and the user is separately offered a way to carry a compact summary of it into its parent conversation.
2. **Given** a closed conversation, **When** the user views it, **Then** its history, proposed edits, and document context remain visible, but it cannot be reopened or branched from.
3. **Given** a closed conversation, **When** the user requests a review of it, **Then** a review is produced without modifying the closed conversation itself.

---

### Edge Cases

Every blocked action below MUST surface the specific reason and, where applicable, the configured
limit value to the user — never a generic refusal.

- What happens when the user tries to branch a conversation beyond the configured maximum conversation depth? The application must block the action and explain the limit rather than silently ignoring it. (FR-013)
- What happens when the user tries to apply or refresh an edit workflow for a conversation deeper than the configured maximum editing depth? The action must be blocked even though the conversation itself may still exist and continue chatting. (FR-026)
- What happens when the configured maximum number of concurrent agents is already running and the user submits another prompt? The new request is queued rather than rejected or silently dropped. (FR-015, FR-015a)
- What happens when the user's browser disconnects while an agent is actively working? The agent keeps working; on reconnection the user sees the fully caught-up state, including anything produced while disconnected. (FR-037)
- What happens when an agent or underlying model call fails outright? The conversation is marked as failed/errored with the failure visible, and the user can retry. (FR-038)
- What happens if a replacement edit produced after a conflict is itself based on a document version that has since moved on again? It goes through the same reconciliation-then-replacement process as any other proposed edit, drawing on the same replacement budget as the original proposal it descends from. (FR-032, FR-032a)
- What happens when a proposal's replacement attempts are exhausted without producing an applicable edit? The system stops asking, leaves the last proposal superseded, and tells the user the agent could not produce an edit that applies to the current document. The document is unchanged and the conversation stays usable. (FR-032b)
- What happens when the user tries to make a closed conversation Primary or branch from it? The application must prevent it, since closed conversations are read-only for review purposes. (FR-027, FR-035)
- What happens when the user closes the conversation that is currently Primary? The document is left with no Primary conversation; the designation is not transferred to another conversation implicitly, and every conversation stages its edits until the user designates a new Primary. (FR-027a)
- What happens when no conversation is Primary and an agent proposes an edit? It is staged as a pending proposal like any other, with no automatic application path available. (FR-021, FR-027a)
- What happens when the user's browser reconnects while an agent response is only partly produced? The user sees the response as it stands at that moment, then continues receiving it live — not an empty conversation that fills in only once the response finishes. (FR-037a)
- What happens to an agent run that was in flight when the application itself restarted? It is not resumed. The conversation is marked errored with the interruption visible, and the user can retry it. (FR-039a)
- What happens when the same agent-proposed edit is reported more than once (e.g., after a reconnect)? It must not be applied to the document twice. (FR-040)
- What happens when the document has no content yet? Conversations cannot be started until a document exists. (FR-001, FR-009)

## Requirements *(mandatory)*

### Functional Requirements

Traceability rule: every user-facing behavioral requirement below traces to at least one acceptance
scenario in the story that names it (or to an edge case, each of which now cites its governing
requirement). Operational/non-functional requirements that have no natural Given/When/Then form
(FR-042 logging, FR-043 accessibility, FR-044 network binding) are instead verified structurally, by
audit or automated check, rather than through a scenario.

- **FR-001**: System MUST allow the user to create a document by pasting or typing Markdown content, and MUST create a default Main conversation for that document once it exists. In v1, this document creation happens once per installation; there is no workflow to discard the document and create a replacement.
- **FR-001a**: System MUST let the user view and rename the document's title independently of its content. The title defaults to the first level-1 Markdown heading found in the pasted content, or "Untitled" if none is present. Renaming the title MUST NOT itself create a new revision.
- **FR-002**: System MUST allow direct manual editing of the document's Markdown source with a live rendered preview shown alongside it.
- **FR-003**: System MUST persist manual edits automatically, without requiring an explicit save action, and keep all connected views of the document in sync.
- **FR-004**: System MUST create a new logical document revision each time an agent-proposed edit is applied, and after a configurable period of user inactivity (default 5 minutes) following manual edits. An agent-applied revision is independent of the manual-edit debounce timer: it neither resets nor is delayed by a pending debounce window, and the two may produce two consecutive revisions in close succession without coalescing.
- **FR-005**: System MUST let the user view the document's revision history, including whether each revision came from the user or an agent, and any note attached to agent-originated revisions.
- **FR-006**: System MUST let the user restore an earlier revision; restoring MUST be recorded as a new revision rather than deleting the revisions in between.
- **FR-007**: System MUST support standard undo/redo of manual editing operations. Undo/redo applies only to the user's own manual editing operations; it MUST NOT undo a revision applied by an agent (whether via Primary auto-apply or an accepted proposal) — reverting an agent-applied change requires restoring an earlier revision (FR-006), not editor undo.
- **FR-007a**: System MUST let the user copy or download the document's Markdown content at any time, either the current live content or the content of any specific past revision. The exported content is always the raw Markdown source, never rendered HTML/preview output; a past revision is identified and requested by its revision number.
- **FR-008**: System MUST render Markdown — including embedded diagrams and vector graphics — and sanitize all rendered output before display, in a way that can accommodate additional content types later without changing how the document itself is modeled. This is satisfied structurally: every content-type renderer (Markdown, Mermaid, SVG, and any added later) produces HTML that passes through one single terminal sanitizer call — adding a content type means adding an upstream renderer, never a new sanitization path.
- **FR-008a**: All agent-authored content displayed anywhere in the interface MUST pass through the same sanitization before display — including conversation message text and streamed reasoning, not only document content. Agent output is untrusted regardless of which surface renders it.
- **FR-008b**: The sanitization policy MUST be allowlist-based: standard Markdown-rendered elements (headings, lists, tables, links, `http(s)` images, code blocks, blockquotes) plus sanitized inline SVG and Mermaid-rendered SVG output are permitted; `<script>`, inline event-handler attributes, `javascript:`/non-image `data:` URIs, iframes, forms, and embed/object elements MUST always be stripped.
- **FR-008c**: Content that fails to render — a malformed diagram, an invalid vector graphic, or a rendering step that does not complete, including one that exceeds a configured complexity ceiling (e.g. an oversized diagram) — MUST be replaced with a visible inline notice plus the raw source in a fallback code block, and MUST NOT blank the region or interrupt rendering of the rest of the document.
- **FR-009**: Once the document is created, System MUST maintain exactly one persistent Main conversation for its entire lifetime, always available for questions; before the document is created, no conversation of any kind exists (see Edge Cases). Main is designated Primary at document creation, but that designation is not permanent — it may be moved to another conversation (FR-028) or removed entirely (FR-027a).
- **FR-010**: System MUST let the user send a message to any conversation and receive a streamed response, including the agent's intermediate reasoning when the user has chosen to show it. Reasoning visibility is a single global preference (FR-041), not configured per conversation; it governs whether reasoning is streamed and displayed for every conversation's subsequent responses.
- **FR-011**: System MUST let the user highlight a portion of the document and start a new conversation scoped to that selection.
- **FR-012**: A newly branched conversation MUST be seeded with the highlighted content plus enough surrounding document context to be understood independently of its parent. The surrounding context is the nearest enclosing section (the heading and its content) containing the selection, plus one paragraph immediately before and after the selection, up to a combined cap of 2,000 words. This seed excerpt is a point-in-time copy delivered as the branch's first message; it is not live-linked to the document, so later edits to or deletion of the original passage do not alter the already-delivered seed — the branched conversation can only learn of such changes the same way any conversation does, by becoming stale (FR-016) and refreshing (FR-018).
- **FR-013**: System MUST allow conversations to branch from other conversations, up to a configurable maximum conversation depth (default 3), and MUST block attempts to exceed it.
- **FR-014**: System MUST display, for every conversation, its name, current status, Primary indicator, current document-context version, number of pending proposed edits, and its branch relationship to other conversations. Status is one of exactly four values: `idle`, `working`, `errored`, or `closed`. A conversation's name is supplied by the user at branch creation or, if omitted, generated automatically from the seeded selection's heading or leading words; Main's name is always "Main".
- **FR-015**: System MUST allow multiple conversations to run concurrently up to a configurable limit (default 3), queuing additional prompts submitted beyond that limit rather than rejecting them.
- **FR-015a**: The concurrency limit counts only conversations with an actively running agent turn; a queued prompt does not count against it while waiting, and no conversation — including Primary and review conversations — is exempt from the limit. Queued prompts are served strictly in the order submitted (FIFO); the user MAY see a queued prompt's position but MAY NOT cancel it once submitted in v1. A queued prompt is answered using the document context captured at the moment it was submitted, not the context at the moment it is dequeued — consistent with the as-is semantics of FR-017.
- **FR-016**: System MUST track which document revision each conversation's context currently reflects, and MUST visibly indicate when a conversation's context is behind the current document ("stale"). A conversation is never marked stale by a revision it caused itself — applying or auto-applying its own proposed edit updates its own context revision immediately to match; staleness reflects only document advancement from other sources (the user's manual edits or another conversation's applied edit).
- **FR-017**: System MUST let the user send a message using a conversation's existing context as-is. The agent is not proactively informed that the document has advanced; it continues to read and reason over its stored context revision exactly as if no newer revision existed, unless the user's own message mentions the change.
- **FR-018**: System MUST let the user explicitly refresh a conversation's context to the latest document version — including edits relevant to that conversation — immediately before sending a message. "Edits relevant to that conversation" means that conversation's own pending proposed edits (proposals it authored); a refresh does not surface other conversations' pending proposals.
- **FR-019**: System MUST allow an agent to propose edits to the document during any conversation.
- **FR-020**: An agent-proposed edit that touches multiple, disjoint parts of the document MUST be treated as a single atomic proposal that is accepted or dropped as a whole; partial acceptance of one proposal is out of scope.
- **FR-021**: For any conversation that is not Primary, agent-proposed edits MUST be held as pending proposals that do not alter the document until the user acts on them.
- **FR-022**: System MUST let the user preview a pending proposed edit both as a full rendered document and as an added/removed changes view before deciding on it. A proposal spanning multiple disjoint parts of the document MUST be presented as a single reviewable unit with one accept/drop action: the full-document preview highlights all of its changes simultaneously, and the added/removed view lists each part as a separate hunk grouped under that one proposal.
- **FR-023**: System MUST let the user accept or drop each pending proposed edit individually, and MUST also provide "accept remaining" and "drop remaining" bulk actions. "Accept remaining" processes proposals in the order they were created (oldest first); a conflict on one proposal does not halt or skip the rest — each proposal's outcome (applied, conflict, or conflict-with-replacement) is determined and reported individually.
- **FR-024**: System MUST let the user act on a pending proposed edit while its conversation is still active, without requiring the conversation to be closed first. The document may change under an in-flight agent run this way; this is not a special case — the run continues to reason over its already-fixed context revision (FR-017) and is unaffected until it next reads the document, which is bounded by the same staleness/refresh mechanism as any other change.
- **FR-025**: Accepting a pending proposed edit MUST update the document and create a new logical revision.
- **FR-026**: System MUST restrict participation in edit proposal/review workflows to conversations within a configurable maximum editing depth (default 2), independently of the conversation branching depth limit. The two limits are deliberately independent: editing depth may be configured higher than conversation depth (in which case it has no additional restricting effect, since no conversation can exceed the conversation-depth ceiling) or lower (restricting a subset of otherwise-branchable conversations from participating in edit workflows while they continue to branch and chat normally).
- **FR-027**: At most one conversation MUST be designated Primary at any time. Edits proposed within the Primary conversation MUST be applied to the document automatically, without staging, creating a new revision each time. If a Primary conversation's edit cannot be automatically merged into the current document, it MUST follow the same conflict-resolution flow as a staged edit (FR-032) rather than being silently applied, dropped, or left to block the conversation: the edit is marked superseded, the agent is asked for a replacement, and the replacement is presented to the user as a pending proposal.
- **FR-027a**: A Primary designation MUST NOT be mandatory. System MUST let the user deselect the Primary conversation without nominating a replacement, and MUST support a state in which no conversation is Primary. While no conversation is Primary, every conversation — including Main — MUST stage its proposed edits for review under FR-021. Closing the Primary conversation MUST leave the document with no Primary rather than transferring the designation implicitly.
- **FR-028**: System MUST let the user designate a different conversation as Primary at any time, and MUST make the current Primary designation — including its absence — visible to the user.
- **FR-029**: When changing Primary would affect a conversation that is actively working, System MUST warn the user and offer to switch immediately, not switch, or switch once the active work finishes. "Actively working" means the conversation's status is `working` (an agent turn in progress) at the moment of the switch request; a conversation with a merely queued prompt that has not yet started is not considered actively working.
- **FR-029a**: A deferred Primary switch ("switch once idle") MUST be cancelled without effect if, before it takes effect, the target conversation closes or becomes errored, or the user issues a new Primary-designation request that supersedes it. At most one deferred switch may be pending at a time; a new request replaces any existing pending one. Cancellation MUST NOT itself produce an error to the user — the current Primary designation simply remains unchanged.
- **FR-030**: Switching Primary MUST NOT interrupt, cancel, or otherwise affect any agent operation already in progress.
- **FR-031**: When the user applies a pending proposed edit whose starting document version is no longer current, System MUST first attempt to reconcile it automatically against the current document.
- **FR-031a**: Reconciliation MUST succeed only when every part of a proposal still matches exactly one unambiguous location in the current document and no two of those resolved locations overlap. A proposal MUST be treated as conflicting when any part of it no longer matches the document, matches in more than one place, or resolves to a location overlapping another part of the same proposal — which is the case that arises when the document has been changed on the same lines the proposal was written against. System MUST NOT infer or guess the intended location of a part that does not resolve uniquely.
- **FR-031b**: A proposal MUST reconcile as a whole. If any single part of a multi-part proposal conflicts under FR-031a, the entire proposal MUST be treated as conflicting and none of its parts applied, consistent with the atomicity required by FR-020.
- **FR-032**: If automatic reconciliation succeeds, the edit MUST be applied and a new revision created; if it fails, the original proposal MUST be marked superseded, the originating agent MUST be asked to propose a replacement informed by the conflict, and the replacement MUST be presented to the user as a new pending proposal.
- **FR-032a**: The replacement cycle MUST be bounded by a configurable maximum number of replacement attempts per originating proposal (default 2). Each replacement requested under FR-032 MUST count against that budget, and the budget MUST NOT reset when a replacement is itself superseded — the whole chain descending from one original proposal shares it.
- **FR-032b**: When the replacement budget is exhausted, System MUST stop requesting replacements automatically, leave the final proposal superseded, and inform the user that the agent could not produce an edit applicable to the current document, including the reason the last attempt conflicted. The document MUST be left unchanged, and the conversation MUST remain usable: a fresh request from the user starts a new proposal with its own budget.
- **FR-032c**: A superseded proposal MUST remain visible in its conversation's proposal list (attributed and distinguishable by status) but MUST NOT count toward the "pending proposed edits" count in FR-014, since it no longer awaits a verdict. The interface MUST show a replacement proposal's link to the predecessor(s) it supersedes, so the user can follow an entire conflict-replacement chain from its origin to the current pending proposal.
- **FR-032d**: If the request for a replacement proposal itself fails due to an agent or model error (rather than producing a proposal that then conflicts), the conversation MUST be marked errored per FR-038 with the interruption visible, and the original proposal MUST remain superseded rather than reverting to pending. A subsequent retry (FR-038) re-issues the replacement request against the same recorded conflict detail and draws on the same replacement budget (FR-032a) — it does not start a fresh budget.
- **FR-033**: System MUST prevent a conversation from being closed while it has any pending proposed edit without a verdict.
- **FR-034**: When a conversation is closed, System MUST separately offer the user a way to fold a compact summary and relevant details of it into its parent conversation.
- **FR-034a**: The compact summary offered under FR-034 MUST include the closed conversation's name and seeded selection (if any), a synopsis of what was discussed or decided, and the list of proposals it produced together with each one's final status (applied, dropped, or superseded) and any resulting revision number; it MUST NOT include the full raw message transcript. Folding a summary into a parent conversation is only available while that parent is itself still open; if the parent has since closed, the option MUST NOT be offered or accepted.
- **FR-035**: Closed conversations MUST remain viewable — including history, proposed edits, and document context used — but MUST NOT be reopened or branched from.
- **FR-035a**: Closing a parent conversation MUST NOT close or otherwise affect its still-open child conversations; they remain open and fully usable, retaining their historical branch link to the now-closed, read-only parent. A child cannot branch further from that parent once it is closed (FR-035), but the child's own ability to branch, chat, and propose edits is unaffected by its parent's closure.
- **FR-036**: System MUST let the user request an independent review of a closed conversation and its branches by an agent, without that review altering the closed conversation itself. The review is produced as a new, separate conversation (kind `review`) containing the reviewing agent's findings; it is never injected into the closed conversation or any other existing conversation. A review conversation counts against `maxConcurrentAgents` (FR-015) like any other agent run, but is exempt from `maxConversationDepth` (FR-013) and `maxEditingDepth` (FR-026), since it is outside the branching/editing workflow.
- **FR-037**: An agent operation in progress MUST continue even if the user's connection to the application drops while the application itself keeps running, and the user MUST see the fully caught-up state upon reconnecting, including anything produced while disconnected. "Fully caught-up" is bounded to what the application actually retains: persisted conversation events, the live per-run response buffer (FR-037a), and current document/conversation state — not transient, already-superseded streaming deltas or purely local UI state (e.g. scroll position).
- **FR-037a**: System MUST retain, for each agent run currently in progress, the response output produced so far, and MUST replay it to a reconnecting client. A user who reconnects while a response is still being produced MUST see that response as it stands at that moment, rather than an empty or unchanged conversation until the response completes.
- **FR-037b**: While a reconnection is in progress (the socket handshake has not yet completed), the interface MUST show a non-blocking "reconnecting" indicator without clearing or blanking previously loaded content; the indicator MUST clear once the caught-up state (FR-037) has been applied.
- **FR-038**: If an agent or underlying model call fails, the affected conversation MUST be marked as errored with the failure visible to the user, and the user MUST be able to retry. Retry re-sends the same run that failed (the conversation's existing message history up to the failed turn is preserved; nothing is restarted from scratch). Retry MUST NOT double-apply an edit: if the failed run had already produced a tool call before failing, the existing idempotency guarantee (FR-040) covers it; if it failed before any tool call, retry simply starts a fresh model turn with nothing yet to duplicate.
- **FR-038a**: An errored conversation MAY still be closed (subject to FR-033) and MAY still be branched from (subject to FR-013); it MUST NOT be designated Primary while errored. Proposals already staged by a conversation before it errored remain pending and fully actionable (preview, accept, drop) by the user regardless of the conversation's error state.
- **FR-039**: System MUST recover document state, conversation state, proposed edits with their statuses intact, and revision history after an application restart, and resume keeping connected clients in sync.
- **FR-039a**: An agent operation that was in flight when the application stopped MUST NOT be resumed automatically. Its conversation MUST be marked errored with the interruption visible to the user, and the user MUST be able to retry it (FR-038). Manual edits persisted but not yet gathered into a revision MUST survive the restart and remain eligible to become one. This restart-triggered errored state (a process-level event) is distinct from — and MUST NOT be confused with — the disconnect case in FR-037 (a client-level event), where the application keeps running and no conversation is marked errored merely because a browser disconnected.
- **FR-040**: System MUST avoid applying the same agent-proposed edit more than once, even if it is reported or retried multiple times.
- **FR-041**: The following behaviors MUST be configurable, with the stated defaults: manual-edit revision debounce period (5 minutes), maximum concurrent agents (3), maximum editing depth (2), maximum conversation depth (3), maximum edit replacement attempts (2), and default visibility of agent reasoning (hidden). Valid ranges: revision debounce period 10 seconds–1 hour; maximum concurrent agents 1–10; maximum editing depth 0–10 (and MAY legitimately exceed or fall below maximum conversation depth, FR-026); maximum conversation depth 1–10; maximum edit replacement attempts 0–10; reasoning visibility is a boolean. A value outside its range MUST be rejected rather than clamped. A changed limit MUST take effect immediately for subsequent operations — it is never deferred to a restart — and MUST NOT retroactively close, error, or evict conversations or proposals that already exceed the new value; only *further* depth-increasing or replacement-requesting actions are newly blocked (FR-013, FR-026, FR-032a). Each of these settings is read by exactly the requirement that depends on it: debounce by FR-004, concurrent agents by FR-015/FR-015a, editing depth by FR-026, conversation depth by FR-013, replacement attempts by FR-032a, reasoning visibility by FR-010.
- **FR-042**: System MUST emit structured, consistent log records for key operational events (e.g., errors, conversation lifecycle changes, edit applications). In v1, these logs are written to the console/standard output only; a persisted or queryable log store is out of scope. The set of loggable events is closed and identical to the event `type` vocabulary defined for the WebSocket event stream (see `contracts/websocket-events.md`), plus HTTP-level request errors — nothing outside that vocabulary requires its own log record. Every structured record MUST include at minimum: level, timestamp, event type, document id, and conversation id (when applicable). Logs MUST NOT include full document content, full conversation message or reasoning text, or Pi session file contents at any log level; only ids, counts, revision numbers, event types, and short (≤200 character) diagnostic excerpts are permitted, and only at a verbosity level disabled by default.
- **FR-043**: The interface MUST conform to WCAG 2.2 Level AA across the editor, conversation HUD, diff viewer, revision history, and all interactive controls, including their loading, streaming, and errored states. The interface is English-only in v1; localization/translation is out of scope.
- **FR-043a**: Every action reachable by pointer MUST have a keyboard-operable equivalent. This includes selecting a passage and branching a conversation from it (FR-011), which MUST NOT require a pointer-driven text selection. Concretely: the document editor's native text selection MUST be fully operable via the keyboard (e.g. Shift+Arrow / Shift+Ctrl+Arrow extension of the caret, as any standard text editor supports), and the "branch conversation from selection" command MUST be reachable via a keyboard shortcut or a focus-reachable control (toolbar button or context menu item) — never only via a pointer-triggered context menu.
- **FR-043b**: Asynchronous agent activity — a response beginning or completing, a proposed edit arriving, a conversation becoming stale or errored — MUST be conveyed to assistive technology as it happens, without moving the user's focus. This MUST be implemented with ARIA live regions: `aria-live="polite"` for response start/completion, proposal arrival, and staleness notices; `aria-live="assertive"` reserved for errors.
- **FR-043c**: The added/removed changes view MUST convey what changed by means other than color alone. Concretely, each changed span MUST carry a textual or iconographic marker (e.g. a leading "+"/"−" symbol and an "added"/"removed" label) in addition to any color coding.
- **FR-043d**: Opening a diff preview or any blocking dialog MUST move focus to its first interactive element; dismissing it (via accept, drop, cancel, or Escape) MUST return focus to the control that opened it.
- **FR-044**: System MUST listen only on the local loopback interface by default, and MUST NOT require or provide user authentication in v1. Loopback binding is the feature's entire access-control model; exposing the application beyond the machine it runs on is an unsupported configuration.

### Key Entities

- **Document**: The Markdown content under review. Has a title, a current revision number, and creation/update timestamps. Single document in v1, but the concept anticipates supporting more than one later.
- **Revision**: A named, logical milestone in a document's history. Records its source (user or agent), an optional note, and — for agent-originated revisions — the conversation that produced it. Revisions are never deleted; restoring an old one creates a new one.
- **Conversation**: A single thread of interaction with an AI agent, scoped to a document. Has a name, status, a Primary flag, the document-context version it currently reflects, its branch depth, and a reference to its parent conversation if it was branched.
- **Proposed Edit ("staged edit")**: An atomic, agent-produced candidate change to the document, created within a non-Primary conversation. Has a status (pending, applied, dropped, or superseded) and the document version it was proposed against. Permitted transitions: `pending` → `applied` (FR-025/FR-027) or `dropped` (FR-023) or `superseded` (FR-032); a `superseded` proposal's replacement is a new row in `pending`, chain-linked via `supersedes_id`; `applied`, `dropped`, and a superseded proposal whose replacement budget is exhausted (FR-032b) are terminal.
- **Conversation Event**: A timestamped record of a notable state change within a conversation (e.g., started, proposal created, proposal applied), used to keep the interface — and reconnecting clients — in sync with what actually happened.
- **User Settings**: The single local user's configurable preferences and limits: revision debounce period, concurrency limit, editing-depth limit, conversation-depth limit, replacement-attempt limit, and reasoning visibility.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from pasting a new document to receiving the Main conversation's first answer about it in under 15 seconds (measured on the reference containerized deployment in quickstart.md, with a warm connection already established to the model service — not counting first-time TLS/connection setup).
- **SC-002**: A user can start a conversation from a highlighted selection and see the agent's first response within 10 seconds, for documents up to ~30 pages / ~15,000 words (same measurement conditions as SC-001, at that size ceiling).
- **SC-003**: A user can review a proposed edit (open its diff and decide) in under 15 seconds per edit, thanks to clear before/after presentation: a side-by-side or unified diff showing full surrounding context, with removed text struck-through/labeled and added text labeled, per FR-022/FR-043c.
- **SC-004**: 100% of edits proposed in non-Primary conversations — which is every conversation when no Primary is designated — are visible to the user for explicit accept/drop before they affect the document; 0% are applied silently. Edits auto-applied by a Primary conversation are identifiable as such in the document's history rather than being indistinguishable from user-accepted ones.
- **SC-005**: By construction of the reconciliation algorithm (FR-031a), a manual edit and an agent proposal overlapping always resolves to either both changes preserved or a clearly presented conflict — never a silent loss of either change. This is verified by exhaustive test coverage of the conflict/clean outcome matrix (contract test expectations), not by production sampling.
- **SC-006**: A user reconnecting after a temporary disconnection sees a fully caught-up view of the document and all active conversations within 5 seconds of reconnecting, including the partial text of any response still being produced.
- **SC-007**: Users can run at least 3 conversations at once without noticeable slowdown in typing, editing, or switching between conversations. Concretely: editor keystroke-to-render round trip stays under 100ms p95, and switching the active conversation completes its UI transition within 200ms.
- **SC-008**: For any document revision, a user can identify — without guesswork — whether it came from their own editing or a specific conversation's agent, 100% of the time.
- **SC-009**: A user can close a conversation, later reopen it for reading, and find its full history, proposals, and document context intact and unchanged.

## Assumptions

- There is a single local user/account in v1; no multi-user authentication, authorization, or sharing is required. Localhost-only access is not merely an assumption but an enforced requirement (FR-044) — the application is not designed to be safely exposed to other devices on a network or the internet.
- Only one document exists at a time in v1; the data model anticipates multiple documents later, but the workflows described here assume one. Once created, that document persists for the life of the installation — there is no v1 workflow to discard it and start a new one; that requires the future multi-document capability.
- Documents are Markdown-scale text content, up to roughly 30 pages / 15,000 words, not large binary files or book-length manuscripts.
- Short-lived connectivity interruptions (seconds to a few minutes) are the recovery target; extended offline use is out of scope.
- The AI agent's underlying model/service is assumed reachable in normal operation; outages surface as a visible conversation error rather than being hidden from the user.
- Partial acceptance of an individual multi-part proposed edit (accepting some parts, dropping others within the same proposal) is out of scope for v1.
- Full version-control-style history/branching of the document (beyond the application's own revision list) is out of scope for v1.
- Additional context sources for the agent beyond the document itself (e.g., imported reference material, web search) are out of scope for v1.
- Multiple browser tabs or windows viewing the same document from the same local machine are an explicitly supported case of "keeping all connected views in sync" (FR-003) — the single-local-user assumption concerns authentication/accounts, not the number of simultaneously open views.
- The recovery target of "seconds to a few minutes" (above) is a UX/testing expectation, not an enforced cutoff: the application places no hard time limit on reconnection — the same snapshot-plus-replay mechanism (FR-037) applies however long a client has been disconnected, bounded only by how much event history the server has retained, which is never deleted.
- Beyond the ~30-page/15,000-word design target, no hard size limit is enforced in v1; the stated performance criteria (SC-001, SC-002, SC-007) are not guaranteed past that size, and the interface shows a non-blocking advisory notice past a configurable soft threshold (default 20,000 words).
- Revision and conversation-event history is retained without limit or automatic pruning in v1, consistent with the "never deleted" requirement (FR-006); operators needing retention limits must handle it operationally, outside this application.
- The localhost-only, no-authentication posture is not merely assumed but enforced in code as the feature's entire access-control model (FR-044).
- Credentials for the underlying model/agent service are supplied to the deployed container via environment variable at deploy time; the application never displays, logs, or persists them.
- The timing success criteria (SC-001, SC-002) are measured end-to-end, including the external model service's response latency, since that is what the user experiences; they assume the model service is reachable and responsive under normal conditions, not a guarantee independent of the model provider.
- The three assumptions carrying the most material risk if they do not hold — model-service reachability, single local user, and document scale — are each paired with a defined behavior: model unreachability surfaces as a retryable conversation error (FR-038); the single-user/localhost posture is enforced, not merely assumed (FR-044); and exceeding the document-scale target degrades only performance guarantees, with an advisory notice, rather than failing outright (above).
