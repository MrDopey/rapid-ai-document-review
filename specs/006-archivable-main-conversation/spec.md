# Feature Specification: Archivable Main Conversation

**Feature Branch**: `[006-archivable-main-conversation]`

**Created**: 2026-08-31

**Status**: Draft

**Input**: User description: "the main conversation needs to be archiveable, this causes the old main to be archived and the new one spawns 'in place' creating a fresh context for another round of changes"

## Clarifications

### Session 2026-09-06

- Q: When the reviewer archives a Main that currently holds the Primary designation, what happens to Primary? → A: Primary clears with no auto-transfer, matching the existing rule that closing the Primary conversation clears the designation without transferring it. The new Main does not automatically become Primary.
- Q: Should the new Main be re-seeded with a fresh excerpt/summary of the document's current state? → A: Yes — the new Main is re-seeded the same way Main is seeded when a document is first created, using a fresh excerpt/summary reflecting the document's current state.
- Q: Should the new Main carry a visible "continued from" link back to the Main it replaced? → A: No — the archived Main appears as an ordinary entry in conversation history with no special forward/backward linkage to the new Main.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retire an overgrown Main and start a fresh round (Priority: P1)

A reviewer has been working the document through the Main conversation for a long time. Main's history has grown large and the reviewer wants to start a new round of changes without that accumulated context weighing on the agent's responses, but without losing the record of what was discussed and changed so far. They archive Main. The document immediately has a new, empty Main occupying the same slot it always has (same position in the document header/HUD, same "Main" identity), ready to receive the next round of instructions. The old Main becomes a read-only historical record.

**Why this priority**: This is the entire feature — without the ability to retire Main and get a replacement in its place, no other part of this capability exists.

**Independent Test**: Open a document with an active Main conversation that has message history, archive it, and verify a new Main conversation is immediately available in the same slot with no messages, while the archived Main's full history remains viewable elsewhere.

**Acceptance Scenarios**:

1. **Given** a document with an active Main conversation containing messages, **When** the reviewer archives Main, **Then** the document has a new Main conversation with no message history, occupying the same top-anchored slot Main has always occupied.
2. **Given** Main has just been archived, **When** the reviewer looks at the document, **Then** at no point is the document left without a Main conversation available to receive new questions or instructions.
3. **Given** the reviewer archives Main, **When** they inspect the archived conversation, **Then** its full prior message history, proposed edits, and document context remain exactly as they were before archiving.
4. **Given** the reviewer archives Main, **When** they try to send a message, branch from, or re-designate the archived Main, **Then** the system prevents it, consistent with how any other closed conversation behaves.

---

### User Story 2 - Branches survive their parent Main's archival (Priority: P2)

A reviewer had branched off Main into a side conversation to explore a question, then later archives the now-history-heavy Main. The side conversation they branched off keeps working normally — they can keep chatting in it and it still shows where it came from — even though the conversation it branched from is now archived.

**Why this priority**: Archiving Main should not be destructive to unrelated, still-active work; without this guarantee, reviewers would be discouraged from ever archiving Main once they'd used it to start branches.

**Independent Test**: Branch a conversation off Main, archive Main, then verify the branch is still open, still usable, and still shows its historical link to the now-archived parent.

**Acceptance Scenarios**:

1. **Given** a conversation branched from Main, **When** Main is later archived, **Then** the branch remains open, can still receive messages, and can still be branched from further (subject to normal branch-depth limits).
2. **Given** a conversation branched from Main, **When** Main is later archived, **Then** the branch continues to show its historical link to that now-archived Main.

---

### User Story 3 - Review what happened in a past round via the archived Main (Priority: P3)

Weeks into a long review, a reviewer wants to understand why a particular change was made in an earlier round of work. They find the archived Main from that round in the document's conversation history and read through it exactly as it was left, including which edits it applied automatically at the time.

**Why this priority**: This is the payoff for archiving instead of deleting — it preserves an auditable trail of past rounds. Without it, archiving would offer no advantage over discarding history.

**Independent Test**: Archive a Main conversation that has previously auto-applied at least one edit, then confirm that edit's attribution to that specific archived Main is still visible when browsing the document's revision history.

**Acceptance Scenarios**:

1. **Given** an archived Main that had auto-applied edits while it was current, **When** the reviewer looks at the document's revision history, **Then** those edits are still attributed to that specific archived Main conversation.
2. **Given** multiple archived Mains from successive rounds, **When** the reviewer opens the conversation list, **Then** each archived Main is distinguishable from the others and from the current Main.

---

### Edge Cases

- What happens if the reviewer tries to archive Main while it has unresolved pending proposals? The system blocks the archive with the same "resolve pending proposals first" behavior already used when closing any other conversation.
- What happens if the reviewer tries to archive Main while the agent is actively responding (Main is "working")? The system applies the same guard used elsewhere for closing a busy conversation.
- What happens if Main is archived when it has zero messages (never used)? The archive still succeeds and a new empty Main replaces it, since "never used" is not a reason to block a user-initiated action.
- What happens to a document's Primary designation when the reviewer archives the Main conversation that currently holds it? See FR-007.
- Can a document ever end up with more than one "current" Main, or with none, at any point during the archive-and-replace operation? No — the transition from old Main to new Main MUST be atomic from the user's perspective (FR-002).
- Is there a limit to how many times Main can be archived over a document's lifetime? No limit is imposed by this feature; each archival simply produces one more read-only, historical Main alongside the current one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to archive the current Main conversation, using the same archive action already available for other conversation kinds.
- **FR-002**: Archiving the current Main MUST atomically replace it with a new, empty Main conversation occupying the same slot (top-anchored position, HUD/list identity as "Main") — the document MUST NOT be observably left without a current Main at any point during or after the operation.
- **FR-003**: Once archived, a former Main MUST become read-only with the same guarantees closed conversations already have: full history, document context, and proposed-edit outcomes remain visible; it cannot receive new messages, be branched from, be reopened, or be re-designated Primary.
- **FR-004**: Archiving the current Main MUST be subject to the same preconditions already enforced when closing any other conversation (e.g., no unresolved pending proposals, not currently mid-response).
- **FR-005**: A conversation previously branched from a Main that is later archived MUST remain open and fully usable, and MUST retain its visible historical link to that now-archived Main, unaffected by the archival itself.
- **FR-006**: The system MUST support a document having more than one Main conversation over its lifetime (one current, any number of archived predecessors), while continuing to guarantee exactly one of them is the current Main at all times.
- **FR-007**: When the reviewer archives a Main conversation that currently holds the Primary designation, the Primary designation MUST clear with no automatic transfer to the new Main — consistent with the existing rule that closing the Primary conversation clears the designation without transferring it. The reviewer may subsequently designate the new Main (or any other conversation) as Primary.
- **FR-008**: The new Main produced by an archive MUST start with no message history from its predecessor, but MUST be re-seeded with a fresh excerpt/summary of the document's current state, using the same seeding mechanism used when Main is first created for a document.
- **FR-009**: When a Main conversation is archived, the new Main MUST NOT carry any visible "continued from" reference back to the Main it replaced; the archived Main appears as an ordinary entry in the document's conversation history with no special forward/backward linkage to the new Main.
- **FR-010**: Archived Main conversations MUST be distinguishable from each other and from the current Main when browsing the document's conversation history.
- **FR-011**: Edits that were auto-applied by a Main conversation before it was archived MUST remain attributed to that specific (now-archived) conversation in the document's revision history.

### Key Entities

- **Main Conversation**: The document's persistent, always-available conversation. Previously exactly one existed for a document's entire lifetime; this feature introduces a lineage where exactly one Main is "current" at any time, and any number of prior Mains exist in read-only, archived form.
- **Archived Main**: A former current Main, now closed and read-only, retaining its full message history, document-context anchoring, and attribution of any edits it auto-applied while current.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can go from "Main has grown too long" to "actively sending a message in a fresh Main" in a single archive action, with no intermediate state where the document has no usable Main.
- **SC-002**: 100% of conversations branched from a Main survive that Main's archival with no loss of function or historical linkage.
- **SC-003**: 100% of edits auto-applied by a Main conversation remain correctly attributed to that specific conversation after it is archived, indefinitely.
- **SC-004**: Reviewers can identify, without opening any conversation, which Main in the document's history is the current one versus an archived predecessor.

## Assumptions

- Archiving Main reuses the existing archive/close mechanics (and their preconditions, such as blocking on unresolved pending proposals) rather than introducing a parallel close pathway.
- There is no cap on how many times a document's Main can be archived and replaced over its lifetime.
- The visual/UI distinction between the current Main and archived Mains (e.g., naming, ordering) is a design-phase decision, not fixed by this specification.
