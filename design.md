# Rapid AI Document Review — Software Design Document

## 1. Overview

The application is a self-hosted, browser-based workspace for rapidly reviewing and revising a single Markdown document with one or more AI conversations.

The core interaction is:

1. A user opens or pastes a Markdown document.
2. The document is displayed as **raw Markdown + rendered Markdown** side by side.
3. The user can edit the document directly.
4. The user can have a **Primary** AI conversation about the whole document.
5. The user can highlight a section and create a **conversation branch** focused on that section.
6. Branch conversations receive a snapshot of the document rather than automatically following Main.
7. AI edits in non-primary conversations become **staged edits**.
8. The user can preview, accept, drop, or apply staged edits.
9. Primary AI edits are applied immediately.
10. Conversations can themselves branch independently of document-editing branches.
11. Conversations can eventually be closed, with document edits and conversation context merged as **two independent decisions**.
12. Closed conversations remain permanently viewable and can be reviewed by another AI conversation.

The application is designed around three distinct concepts:

```text
Document state
    │
    ├── Main live document
    │
    └── Branch snapshots + staged edits

Conversation state
    │
    └── Pi conversation tree

Document history
    │
    └── Simplified revisions
```

These should not be conflated.

---

# 2. Goals

### Primary goals

* Extremely fast AI-assisted document review.
* Make AI feedback contextual without losing the user's control over document changes.
* Allow multiple independent AI perspectives on the same document.
* Make the difference between **conversation state** and **document state** explicit.
* Allow users to selectively incorporate AI changes.
* Make stale AI context visible.
* Make keyboard interaction a first-class part of the application.
* Preserve conversations and document history.
* Support rich Markdown rendering.
* Provide a foundation for future collaborative editing and additional AI tools.

### Non-goals for v1

* Multiple human users editing simultaneously.
* Git integration.
* Web search.
* Arbitrary filesystem access.
* Pi conversation export UI.
* Reopening closed conversations for interaction.
* Editing closed conversations.
* Fully automatic conflict resolution in every situation.

---

# 3. Terminology

| Term                    | Meaning                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Document**            | A user-owned Markdown document.                                                                                             |
| **Main**                | The canonical live document state.                                                                                          |
| **Conversation**        | An AI conversation associated with a document.                                                                              |
| **Primary**             | The conversation whose AI edits are applied directly to Main.                                                               |
| **Branch**              | A conversation created from another conversation.                                                                           |
| **Conversation branch** | A branch in the Pi conversation tree.                                                                                       |
| **Editing branch**      | A conversation that is permitted to maintain staged document edits.                                                         |
| **Snapshot**            | The Main document version loaded into a conversation's context.                                                             |
| **Staged edit**         | An AI-generated document modification that has not yet been applied to Main.                                                |
| **Applied edit**        | A document modification already incorporated into Main.                                                                     |
| **Dropped edit**        | A staged edit explicitly rejected by the user.                                                                              |
| **Refresh**             | Updating a conversation's document context to the latest Main state while incorporating its queued edits into that context. |
| **Conversation merge**  | Merging a branch's conversational context/summary into its parent.                                                          |
| **Edit merge**          | Applying selected staged edits to Main.                                                                                     |
| **Closed conversation** | A persistent, read-only conversation that can be reviewed but not interacted with through the frontend.                     |

---

# 4. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                         Vue Frontend                        │
│                                                             │
│  ┌─────────────────┐       ┌─────────────────────────────┐  │
│  │ Markdown Editor │       │      Rendered Markdown      │  │
│  │                 │       │                             │  │
│  │ CodeMirror/     │       │ Markdown + Mermaid + SVG   │  │
│  │ Monaco          │       │ + extensions                │  │
│  └────────┬────────┘       └─────────────────────────────┘  │
│           │                                                 │
│           └───────────────┬─────────────────────────────────┤
│                           │                                 │
│                    Conversation HUD                        │
│                    Staged edits                            │
│                    Keyboard system                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
                     WebSocket / HTTP
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                    TypeScript Backend                       │
│                                                             │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐ │
│  │ Document       │  │ Conversation   │  │ Edit / Merge  │ │
│  │ Service        │  │ Service        │  │ Service       │ │
│  └────────────────┘  └────────────────┘  └───────────────┘ │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                       Pi Agent                         │ │
│  │                  AgentSession / Pi SDK                 │ │
│  └────────────────────────────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────┘
                            │
                 ┌──────────┴───────────┐
                 │                      │
          Persistent storage       Workspace/files
```

---

# 5. Technology

## Frontend

* Vue
* TypeScript
* Markdown editor
* CRDT implementation
* WebSocket/AG-UI transport
* Sanitized Markdown renderer
* Mermaid renderer
* SVG renderer
* Application keyboard command system

The exact editor library can be selected during implementation. CodeMirror is a strong candidate for a Markdown-centric editor.

## Backend

* TypeScript
* Node.js
* Pi SDK
* Docker
* Persistent storage
* WebSocket support

**Fastify** is a reasonable initial backend framework because the application primarily needs APIs, WebSockets, persistence, and long-lived agent interactions without requiring a large framework abstraction.

## Agent protocol

Use **AG-UI where it fits the agent interaction layer**:

```text
AG-UI
├── text streaming
├── tool calls
├── tool results
├── agent state
├── reasoning events
└── lifecycle events
```

Application-specific protocol/state remains responsible for:

```text
Document
Branches
CRDT
Staged edits
Merging
Versions
Keyboard/UI state
```

AG-UI should not be treated as the application's document synchronization protocol.

## Agent

Pi is the agent runtime.

Each document has **one Pi session**.

Conversation branches are represented within that session's conversation tree rather than creating an independent Pi session for every frontend conversation.

---

# 6. Document Model

Each document has:

```text
Document
├── id
├── name
├── content
├── currentVersion
├── createdAt
├── updatedAt
└── history[]
```

The document is Markdown.

The document is the canonical **Main** state.

---

# 7. CRDT

The application uses a CRDT for the live document.

The CRDT provides:

* consistent document state between frontend and backend
* safe concurrent mutations
* granular document updates
* a foundation for future multi-user collaboration
* efficient synchronization of editor changes

The CRDT is **not responsible for conversation branching or branch merging**.

### Main CRDT

```text
                Main CRDT
                   │
           current document
                   │
        ┌──────────┴──────────┐
        │                     │
   Browser editor         Backend
```

Manual frontend edits are written to the Main CRDT.

The backend observes those changes and maintains the authoritative persisted document state.

---

# 8. Document Versions

Each meaningful document state receives a monotonically increasing application-level version:

```text
v1
v2
v3
...
v27
```

Version metadata contains:

```text
version
timestamp
source
author
note
```

Examples:

```text
v24
10:31:42
User
Manual edit

v25
10:34:11
Agent
Applied from "Rewrite introduction"

v26
10:36:02
User
Manual edit

v27
10:39:15
Agent
Applied from Primary conversation
```

This is intentionally a **simplified history**, not Git.

Git-style implementation is deferred.

---

# 9. Conversation Context

Every conversation maintains a reference to a Main document version.

Example:

```text
Main
current version: v27

Conversation A
document context: v27

Conversation B
document context: v23

Conversation C
document context: v19
```

The conversation HUD displays this state.

Example:

```text
● Main
  v27 · Primary · Working

○ Rewrite introduction
  v23 · 3 queued edits · Waiting

○ Alternative approach
  v19 · 1 queued edit · Working
```

This is essential because branches are **stale by default**.

---

# 10. Snapshot Semantics

Creating a conversation branch creates a snapshot reference.

Suppose Main is:

```text
v15
```

A branch is created.

```text
Branch A
context = v15
```

Main then changes:

```text
v16
v17
v18
```

Branch A still operates against:

```text
v15
```

unless explicitly refreshed.

The UI must make this visible.

---

# 11. Send vs Refresh + Send

There are two send modes.

## Send

Uses the conversation's current document context.

```text
Branch context: v15
Main: v18

Send
  ↓
Agent receives v15
```

It does not silently update the branch.

## Refresh + Send

Refreshes the conversation to the latest applicable Main document state.

Importantly, this includes the conversation's queued edits.

Example:

```text
Main: v18

Branch:
  context: v15

  staged:
    Edit A
    Edit B
```

Refresh + Send produces an effective agent document:

```text
Main v18
+
Branch Edit A
+
Branch Edit B
```

Those edits **remain staged** and are not applied to Main.

The refreshed conversation context becomes the new branch context.

---

# 12. Refresh/Rebase

Refreshing a stale branch is not simply replacing its snapshot.

The system must reconcile:

```text
Branch base
    +
Branch staged edits
    +
Current Main
```

This is a three-way merge/rebase operation.

CRDTs help with concurrent document changes but do not completely solve semantic branch reconciliation.

If reconciliation succeeds:

```text
Main v27
+
branch edits
=
branch context v27'
```

If reconciliation cannot safely determine the resulting document, the application must present a conflict state rather than silently losing edits.

Conflict-resolution behavior can be expanded in a later iteration.

---

# 13. Agent Editing

Pi has:

* read
* edit

available in v1.

When Pi invokes `edit`, the result is classified based on the conversation.

### Primary

```text
Pi edit
   ↓
Apply immediately
   ↓
Main CRDT
   ↓
New document version
```

The edit is **not staged**.

### Non-primary editing conversation

```text
Pi edit
   ↓
Staged edit
   ↓
Conversation queue
```

The Main document is unchanged.

---

# 14. Staged Edit Model

A staged edit contains:

```text
StagedEdit
├── id
├── conversationId
├── documentBaseVersion
├── patch
├── preview
├── createdAt
├── source
├── status
└── metadata
```

Status:

```text
UNRESOLVED
ACCEPTED
DROPPED
APPLIED
```

The normal lifecycle is:

```text
UNRESOLVED
    │
    ├── Accept ──► ACCEPTED
    │
    └── Drop ────► DROPPED

ACCEPTED
    │
    ▼
APPLIED
```

Accepted and dropped decisions can be changed while the conversation remains active.

---

# 15. Applying Edits During an Active Conversation

A non-primary conversation can apply individual staged edits without closing.

Example:

```text
Edit 1
[Preview] [Apply] [Drop]

Edit 2
[Preview] [Apply] [Drop]
```

Applying an edit:

1. validates its base state
2. merges it into Main
3. creates a new document version
4. removes it from the staged queue
5. broadcasts the document change
6. records history

The conversation remains open.

The conversation's agent context does **not automatically refresh**.

The user can use **Refresh + Send** to explicitly bring those changes into the agent's context.

---

# 16. Staged Edit Preview

Each edit can be previewed.

The preview should support:

### Full preview

Rendered resulting Markdown.

### Diff preview

Git-style visual representation:

```diff
- The original paragraph.
+ The revised paragraph with additional detail.
```

No actual Git repository is required.

---

# 17. Primary Conversation

Exactly one conversation is Primary per document.

Primary is special:

```text
Agent edit
   ↓
Immediately applied to Main
```

Primary edits:

* are not staged
* are not shown in the closing edit-resolution workflow
* immediately update Main
* create document history entries

Changing Primary requires confirmation because the outgoing Primary may have relevant active state.

Example:

```text
Change Primary?

"Rewrite introduction" currently has:

- 2 unresolved staged edits
- document context v21
- agent is working

[Keep as Primary] [Change Primary]
```

Conversation state is never silently discarded.

---

# 18. Conversation Branching

Conversation branching is independent of document-editing depth.

The Pi conversation tree may look like:

```text
Main
├── Review introduction
│   ├── More concise
│   │   ├── Alternative 1
│   │   └── Alternative 2
│   └── More persuasive
│
└── Review conclusion
    └── Alternative framing
```

The application has a configurable conversation-depth cap.

Default:

```text
maxConversationBranchDepth = 3
```

This is an **application-level enforced cap**.

No warning is presented.

---

# 19. Editing Branch Depth

Document-editing depth is separately configurable.

Default:

```text
maxEditingBranchDepth = 2
```

The editing branch depth is measured independently from conversational depth.

For example:

```text
Main
└── A                    editing allowed
    └── B                editing allowed
        └── C            conversation allowed
            └── D        conversation allowed
```

If B reaches the configured editing depth, C can continue talking with the agent, but cannot create another document-editing branch.

This prevents document state from becoming deeply nested while allowing conversations to remain exploratory.

---

# 20. Highlighted Conversation Creation

The user can select/highlight a section of Markdown and create a conversation.

The new conversation receives:

1. the document snapshot
2. the selected range
3. the selected content
4. surrounding document context as appropriate
5. a predefined system/context note indicating that this is a branch
6. its parent conversation reference

Example conceptual context:

```text
This is a review branch of the parent conversation.

The user selected the following section:

> ...

Review this section in the context of the document snapshot provided.
```

The highlighted section is context, not necessarily a restriction on what the agent can edit.

---

# 21. Conversation Merging

Conversation merging is independent from document editing.

When a conversation closes, the application handles two sequential processes.

## Phase 1 — document edits

Resolve every staged edit.

Every staged edit starts unresolved.

The user can:

```text
[Accept]
[Drop]
```

for each.

Convenience actions:

```text
[Accept remaining]
[Drop remaining]
```

These operate only on unresolved edits.

A conversation **cannot proceed until every staged edit has a verdict**.

Importantly:

> Accept/Drop decisions do not immediately modify Main.

They remain reversible while the conversation is open.

Once all edits have a verdict, the user confirms the edit resolution.

Then:

* Accepted edits are applied to Main.
* Dropped edits are discarded.
* Document versions/history are created.

If an edit was already applied during the active conversation, it is no longer part of the staged queue.

---

# 22. Conversation Merge

After document-edit resolution, the application independently asks whether the conversation itself should be merged into its parent.

```text
Merge conversation?

"Rewrite introduction" produced:

- 14 messages
- 2 review findings
- 1 unresolved discussion
- summary available

[Merge conversation] [Close without merging]
```

Conversation merge does not imply document merge.

Likewise, document merge does not imply conversation merge.

The user can therefore choose:

```text
Document:
  edits → accepted/dropped

Conversation:
  merge / don't merge
```

independently.

---

# 23. Conversation Merge Semantics

Merging a conversation is conceptually similar to Pi's branch/compaction behavior.

The child conversation is summarized into context suitable for its parent.

The parent receives:

* key findings
* decisions
* relevant discussion
* unresolved questions
* useful context
* potentially relevant references to document changes

The entire child conversation remains persisted.

After closing:

```text
Parent
  │
  └── child summary
```

The child is marked closed.

---

# 24. Closed Conversations

Closed conversations are:

* persistent
* visible in history
* read-only
* searchable/navigation-accessible
* reviewable by another agent

They cannot:

* receive user messages
* receive new edits
* be branched from through the frontend
* become Primary

A new agent conversation can be created to review one or more closed conversations.

Example:

```text
Main
│
├── Review A [CLOSED]
├── Review B [CLOSED]
│
└── Review summary
       │
       └── Agent reviews A + B
```

---

# 25. Agent Review of Closed Conversations

A new conversation can receive closed conversation data as context.

It can ask:

> What were the important criticisms raised by the previous reviewers?

The closed sessions remain immutable.

This creates a distinction between:

```text
Review conversation
```

and:

```text
Review-of-reviews conversation
```

---

# 26. Conversation HUD

All conversations are visible in a persistent HUD.

Example:

```text
┌──────────────────────────────────────────────────────────────┐
│ ● Main            PRIMARY    v27    WORKING       0 edits   │
│ ○ Intro review              v24    WAITING       3 edits   │
│ ○ Conclusion review         v21    WORKING       1 edit    │
│ ✓ Old review               CLOSED  v18                       │
└──────────────────────────────────────────────────────────────┘
```

Each conversation should expose:

* name
* branch relationship
* Main document context version
* current agent status
* queued edit count
* Primary indicator
* open/closed state
* keyboard shortcut
* unread/new output indicator

Conversation names are user-editable.

Default names can be generated from the selected text or initial prompt.

---

# 27. Agent Status

Each conversation has a visible status:

```text
IDLE
WORKING
WAITING_FOR_INPUT
ERROR
CLOSED
```

The status should be visually distinct from the document-context version.

Example:

```text
○ Introduction review
  v23 · 2 edits · WAITING

● Main
  v27 · 0 edits · WORKING
```

---

# 28. Streaming

AI output is streamed to the relevant conversation.

The frontend must never have to infer which conversation an event belongs to.

Every event contains:

```text
documentId
conversationId
messageId
eventId
```

Conceptually:

```text
AG-UI event
    │
    ├── conversationId
    ├── messageId
    ├── event type
    └── payload
```

This allows multiple agents to stream simultaneously:

```text
Main              → streaming
Intro review      → streaming
Conclusion review → waiting
```

without mixing output.

---

# 29. Thinking / Reasoning Visibility

The application provides a global/user-configurable toggle:

```text
Show thinking: ON / OFF
```

When enabled, supported reasoning/thinking events are displayed in the relevant conversation.

When disabled, reasoning events remain suppressed from the user-facing UI while normal assistant output and tool activity remain available.

The implementation should not assume that arbitrary private model chain-of-thought can or should be exposed. Only reasoning events intentionally provided for application display should be rendered.

---

# 30. Markdown Rendering

The document supports Markdown plus extensible renderers.

Initial extensions:

* Mermaid
* SVG
* other safe embedded document components

Pipeline:

```text
Markdown
   ↓
Markdown parser
   ↓
Extension processing
   ↓
Sanitization
   ↓
Rendered DOM
```

Sanitization occurs **before rendering into the application DOM**.

Raw HTML, SVG, links, embedded content, and extension output must be treated as untrusted input.

---

# 31. Editor Interaction

The editor supports:

* raw Markdown editing
* text selection
* highlighting
* branch creation from selection
* normal editing
* undo/redo
* keyboard navigation
* document version awareness

The rendered pane updates from the same CRDT-backed document state.

---

# 32. Keyboard-First Design

Keyboard shortcuts are a first-class application subsystem rather than individual component shortcuts.

A proposed initial mapping:

| Shortcut                   | Action                       |
| -------------------------- | ---------------------------- |
| `Ctrl/Cmd + Enter`         | Refresh + Send               |
| `Enter`                    | Send                         |
| `Ctrl/Cmd + Shift + Enter` | Send without refreshing      |
| `Ctrl/Cmd + K`             | Open conversation navigator  |
| `Ctrl/Cmd + 1..9`          | Focus conversation           |
| `Ctrl/Cmd + Shift + 1..9`  | Focus conversation input     |
| `Esc`                      | Return focus to document     |
| `Ctrl/Cmd + B`             | Create branch from selection |
| `Ctrl/Cmd + Shift + B`     | Open branch navigator        |
| `Ctrl/Cmd + Shift + A`     | Accept remaining edits       |
| `Ctrl/Cmd + Shift + D`     | Drop remaining edits         |

The exact mappings should remain configurable.

The application should expose a keyboard shortcut help overlay.

---

# 33. Backend Services

A reasonable initial decomposition:

```text
Backend
├── DocumentService
├── CRDTService
├── ConversationService
├── PiAgentService
├── EditService
├── MergeService
├── HistoryService
├── EventService
└── PersistenceService
```

### DocumentService

Responsible for:

* document creation
* current state
* versions
* persistence

### CRDTService

Responsible for:

* synchronization
* document updates
* conflict-safe concurrent mutations

### ConversationService

Responsible for:

* conversation tree
* branch creation
* depth enforcement
* lifecycle
* Primary state

### PiAgentService

Responsible for:

* Pi sessions
* prompts
* streaming
* tool execution
* Pi event translation

### EditService

Responsible for:

* staged edits
* previews
* acceptance
* dropping
* active application

### MergeService

Responsible for:

* branch refresh/reconciliation
* edit application
* conversation summarization/merge
* conflict handling

### HistoryService

Responsible for:

* simplified document revisions
* timestamps
* source
* notes

---

# 34. Persistence

The application requires persistent storage for:

```text
Document
Conversation
Conversation tree
Pi session data
Staged edits
Document versions
Conversation metadata
User preferences
Application configuration
```

The exact database is implementation-dependent.

The filesystem/workspace and application metadata should be persisted separately from ephemeral WebSocket connections.

---

# 35. Docker

The entire application should be self-hostable.

Initial deployment:

```text
docker compose
│
├── frontend
├── backend
├── database
└── persistent volumes
```

Pi should run inside the backend/agent container or an appropriately isolated Pi worker container.

Persistent volumes must survive container restarts.

---

# 36. Security

The application must assume Markdown and AI-generated content are untrusted.

Requirements include:

* sanitize rendered Markdown
* sanitize SVG
* prevent script injection
* isolate Mermaid rendering where appropriate
* validate file/document IDs
* authorize all document/conversation operations
* never expose Pi filesystem access directly to the browser
* validate agent-generated file paths
* constrain Pi to the document workspace
* authenticate WebSocket connections
* validate event ownership

---

# 37. Future Extensibility

The architecture should allow future Pi tools without changing the conversation model.

Future tools:

```text
read
edit
web_search
web_fetch
...
```

The agent tool layer should be extensible.

---

# 38. Future Scope

### Additional review context

Allow users to import:

* other documents
* URLs
* notes
* reference material
* supporting files

These become agent context without necessarily becoming part of Main.

### SearXNG

Provide:

```text
Pi
 ├── search → SearXNG
 └── fetch  → web content
```

### Pi exports

Allow users to view/export the underlying Pi conversation/session representation.

### Git

Potential future Git integration:

* commits
* branches
* repository history
* actual Git diffs
* rollback

Git is explicitly **not part of v1**.

### Multiple human collaborators

The CRDT architecture provides a path toward multiple human users without requiring the document model to be replaced.

---

# 39. Core State Model

A simplified model:

```text
Document
│
├── Main CRDT
│     └── v27
│
├── History
│     ├── v25
│     ├── v26
│     └── v27
│
└── Pi Session
      │
      ├── Main [Primary]
      │
      ├── Review A
      │     ├── Review A.1
      │     └── Review A.2
      │
      └── Review B
            └── Review B.1
```

Each conversation:

```text
Conversation
├── id
├── parentId
├── piEntryId
├── name
├── status
├── isPrimary
├── branchDepth
├── documentContextVersion
├── editingBranchDepth
├── stagedEdits[]
└── createdAt
```

---

# 40. Important Invariants

The implementation should enforce these invariants:

1. A document has exactly one Main state.
2. A document has at most one Primary conversation.
3. Primary agent edits are immediately applied.
4. Non-primary agent edits are staged.
5. Applying a staged edit removes it from the staged queue.
6. Dropping a staged edit removes it from the staged queue.
7. Staged edits do not modify Main.
8. Accept/Drop decisions are reversible while the conversation remains open.
9. A conversation cannot close with unresolved staged edits.
10. Conversation merging does not imply document merging.
11. Document merging does not imply conversation merging.
12. Closed conversations are immutable from the frontend.
13. Branches retain their document context until explicitly refreshed.
14. Refresh includes the branch's currently queued edits in its effective agent context.
15. Conversation branch depth and editing branch depth are independent.
16. Both depth limits are application configuration.
17. Main document versions are monotonically increasing.
18. Every streamed agent event identifies its conversation.
19. Primary changes are absent from the closing staged-edit workflow.
20. A document has exactly one Pi session.

---

# 41. BDD Requirements

## Feature: Create a document

### Scenario: User creates a document by pasting Markdown

**Given** the user has no document
**When** the user pastes Markdown into the editor
**Then** the application creates a document
**And** the Markdown becomes the Main document
**And** the document receives an initial version
**And** the rendered Markdown view displays the document.

---

## Feature: Edit the document manually

### Scenario: User manually edits Main

**Given** a document is open
**When** the user modifies the raw Markdown editor
**Then** the Main CRDT is updated
**And** the rendered view reflects the change
**And** the document receives a new version
**And** document history records the user edit.

---

# Feature: Primary conversation

### Scenario: User creates the Primary conversation

**Given** a document has no Primary conversation
**When** the user creates a conversation
**Then** the conversation becomes Primary
**And** the conversation loads the current Main document version
**And** the HUD identifies it as Primary.

### Scenario: Primary agent edits the document

**Given** a conversation is Primary
**And** the agent has read the document
**When** the agent executes an edit tool call
**Then** the edit is immediately applied to Main
**And** Main receives a new version
**And** the edit is not added to the staged-edit queue
**And** the edit is not shown during conversation closure.

### Scenario: User changes Primary

**Given** conversation A is Primary
**And** conversation B exists
**When** the user selects B as Primary
**Then** the application displays A's current state
**And** the user must confirm the change
**And** B becomes Primary only after confirmation.

---

# Feature: Create a conversation from a selection

### Scenario: User branches from highlighted text

**Given** the user has selected a section of Markdown
**When** the user creates a review conversation
**Then** a child conversation is created
**And** the conversation receives a snapshot of Main
**And** the selected text is included as contextual information
**And** the conversation receives the configured branch-context note
**And** the conversation displays its document context version.

---

# Feature: Conversation snapshot

### Scenario: Main changes after a branch is created

**Given** conversation B has document context version v10
**And** Main advances to v12
**When** the user sends a normal prompt in B
**Then** the agent receives document context v10
**And** B remains associated with v10.

### Scenario: User refreshes a conversation

**Given** conversation B has document context v10
**And** Main is v12
**When** the user selects Refresh + Send
**Then** B reconciles its queued edits against the latest Main
**And** B receives the latest applicable document state
**And** B's queued edits remain staged
**And** the conversation's document context indicator updates.

### Scenario: Refresh includes queued edits

**Given** B is based on v10
**And** Main is v12
**And** B has staged edits E1 and E2
**When** the user selects Refresh + Send
**Then** the agent receives Main v12 with E1 and E2 incorporated into its effective context
**And** E1 and E2 remain un-applied to Main.

---

# Feature: Staged edits

### Scenario: Non-primary agent edits a document

**Given** a conversation is not Primary
**When** the agent executes an edit tool call
**Then** the edit is added to the conversation's staged-edit queue
**And** Main is unchanged
**And** the staged edit is visible in the HUD.

### Scenario: Multiple tool calls produce multiple edits

**Given** an agent produces three edit tool calls
**When** all three complete
**Then** three independently reviewable staged edits exist
**And** each can be previewed independently.

### Scenario: User previews an edit

**Given** an edit is staged
**When** the user selects Preview
**Then** the application displays the resulting document/content
**And** the application provides a diff-style representation of the change.

---

# Feature: Apply edits during an active conversation

### Scenario: User applies a staged edit

**Given** an edit is staged
**And** the conversation is active
**When** the user selects Apply
**Then** the edit is applied to Main
**And** a new document version is created
**And** the edit is removed from the staged queue
**And** the conversation remains active.

### Scenario: Applying an edit does not automatically refresh the conversation

**Given** conversation B has context version v10
**And** the user applies one of B's staged edits to Main
**When** Main becomes v11
**Then** B's document context remains v10
**And** the user can explicitly use Refresh + Send to update B.

---

# Feature: Edit verdicts

### Scenario: New staged edits are unresolved

**Given** an agent creates a staged edit
**When** the edit appears in the UI
**Then** its verdict is unresolved
**And** neither Accept nor Drop is selected.

### Scenario: User accepts an edit

**Given** a staged edit is unresolved
**When** the user selects Accept
**Then** the edit becomes Accepted
**And** Main remains unchanged
**And** the user can later change the verdict.

### Scenario: User drops an edit

**Given** a staged edit is unresolved
**When** the user selects Drop
**Then** the edit becomes Dropped
**And** Main remains unchanged
**And** the user can later change the verdict.

### Scenario: User changes an accepted edit to dropped

**Given** an edit is Accepted
**When** the user changes its verdict to Drop
**Then** the edit becomes Dropped
**And** Main remains unchanged.

### Scenario: User changes a dropped edit to accepted

**Given** an edit is Dropped
**When** the user changes its verdict to Accept
**Then** the edit becomes Accepted
**And** Main remains unchanged.

### Scenario: Accept remaining

**Given** three staged edits are unresolved
**And** one edit is already Accepted
**And** one edit is already Dropped
**When** the user selects Accept remaining
**Then** all unresolved edits become Accepted
**And** the already Accepted edit remains Accepted
**And** the already Dropped edit remains Dropped.

### Scenario: Drop remaining

**Given** three staged edits are unresolved
**And** one edit is already Accepted
**And** one edit is already Dropped
**When** the user selects Drop remaining
**Then** all unresolved edits become Dropped
**And** the already Accepted edit remains Accepted
**And** the already Dropped edit remains Dropped.

---

# Feature: Closing a conversation

### Scenario: Conversation has unresolved edits

**Given** a conversation has at least one unresolved staged edit
**When** the user attempts to close the conversation
**Then** the conversation remains open
**And** the user is taken to the staged-edit resolution UI
**And** the conversation cannot proceed to conversation merging.

### Scenario: User confirms resolved edits

**Given** every staged edit has an Accept or Drop verdict
**When** the user confirms the edit resolution
**Then** Accepted edits are applied to Main
**And** Dropped edits are discarded
**And** document history records the applied changes
**And** the staged-edit queue is empty.

### Scenario: Conversation merge is offered separately

**Given** all staged edits have been resolved
**When** the edit resolution step completes
**Then** the application presents the conversation merge decision
**And** the user can merge the conversation
**Or** close it without merging the conversation.

### Scenario: Conversation has no staged edits

**Given** a conversation has no staged edits
**When** the user closes it
**Then** the application proceeds directly to the conversation merge decision.

---

# Feature: Conversation merge

### Scenario: User merges a conversation

**Given** a conversation has a parent
**When** the user selects Merge conversation
**Then** the conversation is summarized
**And** the summary is incorporated into the parent conversation
**And** the original conversation remains persisted
**And** the original conversation becomes closed.

### Scenario: User does not merge conversation

**Given** a conversation has a parent
**When** the user selects Close without merging
**Then** the conversation remains persisted
**And** its context is not merged into the parent
**And** the conversation becomes closed.

---

# Feature: Closed conversations

### Scenario: User reviews a closed conversation

**Given** a conversation is closed
**When** the user opens it from history
**Then** the conversation is displayed read-only
**And** its messages are visible
**And** its document context is visible.

### Scenario: User attempts to interact with a closed conversation

**Given** a conversation is closed
**When** the user attempts to send a message
**Then** the application prevents the interaction.

### Scenario: Agent reviews a closed conversation

**Given** a closed conversation exists
**When** the user creates a new review conversation
**Then** the new agent conversation can receive the closed conversation as context
**And** the closed conversation itself remains immutable.

---

# Feature: Conversation branching

### Scenario: Conversation branches

**Given** an active conversation exists
**When** the user branches the conversation
**Then** a child conversation is created
**And** the child receives the appropriate parent conversational context
**And** the child has its own document context state.

### Scenario: Conversation branch depth reaches the application limit

**Given** the configured conversation depth is 3
**And** a conversation is already at the maximum allowed depth
**When** the user attempts to create another conversation branch
**Then** the application prevents creation of that branch.

---

# Feature: Editing branch depth

### Scenario: Editing branch reaches its configured limit

**Given** the configured editing depth is 2
**And** an editing branch exists at depth 2
**When** the user creates another conversation below that branch
**Then** the conversation may be created
**And** it may continue interacting with the agent
**But** it cannot create another document-editing branch.

---

# Feature: Conversation HUD

### Scenario: HUD displays conversation state

**Given** multiple conversations exist
**When** the user views the application
**Then** every conversation is visible in the HUD
**And** each conversation displays its name
**And** its document context version
**And** its agent status
**And** its staged edit count
**And** whether it is Primary.

### Scenario: Agent is working

**Given** an agent is processing a prompt
**When** the agent is working
**Then** the conversation displays a working indicator.

### Scenario: Agent is waiting

**Given** an agent has completed its response
**When** it is awaiting user input
**Then** the conversation displays a waiting indicator.

---

# Feature: Streaming

### Scenario: Agent streams output

**Given** a conversation has sent a prompt
**When** Pi emits streaming output
**Then** the backend streams the output to the frontend
**And** the frontend displays it in the originating conversation.

### Scenario: Multiple conversations stream simultaneously

**Given** two conversations are active
**When** both agents produce output
**Then** each output stream remains associated with its correct conversation
**And** output is never displayed in another conversation.

---

# Feature: Thinking visibility

### Scenario: Thinking is enabled

**Given** thinking display is enabled
**When** Pi emits supported reasoning events
**Then** the frontend displays them in the relevant conversation.

### Scenario: Thinking is disabled

**Given** thinking display is disabled
**When** Pi emits reasoning events
**Then** reasoning content is not displayed to the user
**And** normal agent output continues to stream.

---

# Feature: Markdown extensions

### Scenario: Mermaid is included

**Given** the Markdown contains Mermaid syntax
**When** the rendered view is generated
**Then** Mermaid is rendered as a diagram
**And** the output is sanitized according to application security rules.

### Scenario: Unsafe content is included

**Given** a document contains potentially executable HTML/SVG content
**When** the rendered view is generated
**Then** the content is sanitized
**And** executable unsafe content is prevented from running.

---

# Feature: Keyboard-first interaction

### Scenario: User sends normally

**Given** the conversation input is focused
**When** the user presses Enter
**Then** the prompt is sent using the conversation's current document context.

### Scenario: User refreshes and sends

**Given** the conversation input is focused
**When** the user presses Ctrl/Cmd + Enter
**Then** the conversation refreshes its document context
**And** incorporates its queued edits into that context
**And** sends the prompt.

### Scenario: User navigates conversations

**Given** multiple conversations exist
**When** the user uses a configured conversation hotkey
**Then** the corresponding conversation receives focus.

---

# 42. Recommended Implementation Phases

## Phase 1 — Core document

* Vue editor
* Markdown rendering
* CRDT
* document persistence
* document versions
* manual editing
* split view

## Phase 2 — Pi integration

* one Pi session per document
* Main conversation
* prompt streaming
* tool events
* read/edit tools
* thinking toggle

## Phase 3 — Conversation branches

* conversation tree
* highlighted-section branches
* snapshot versions
* document-context HUD
* conversation depth configuration

## Phase 4 — Staged edits

* edit queue
* previews
* diff rendering
* Accept/Drop
* Accept remaining
* Drop remaining
* active Apply

## Phase 5 — Refresh and merging

* stale branch detection
* Refresh + Send
* queued-edit context
* three-way/rebase logic
* edit-resolution workflow
* conversation merge workflow
* closed conversations

## Phase 6 — HUD and keyboard system

* persistent conversation HUD
* keyboard command registry
* navigation
* focus management
* status indicators

## Phase 7 — Security and self-hosting

* sanitization
* authentication
* authorization
* Docker deployment
* persistence
* operational logging

---

# 43. Architectural Principle

The central design principle should be:

> **Conversation state, document state, and document history are separate systems that intersect through explicit operations.**

In particular:

```text
                  ┌────────────────────┐
                  │   Pi Conversation  │
                  │       Tree         │
                  └─────────┬──────────┘
                            │
                       explicit context
                            │
                            ▼
┌───────────────┐      ┌───────────────┐
│ Branch staged │─────►│ Main Document │
│ edits         │ apply│    CRDT       │
└───────────────┘      └───────┬───────┘
                               │
                               ▼
                         Version History
```

Nothing should implicitly cross those boundaries.

**AI conversation does not automatically change Main.**

**Main does not automatically update a branch.**

**Accepting an edit does not automatically merge a conversation.**

**Merging a conversation does not automatically apply its edits.**

**Refreshing a conversation explicitly changes what the agent sees.**

That separation is what gives the user rapid AI iteration without losing control of the document.

