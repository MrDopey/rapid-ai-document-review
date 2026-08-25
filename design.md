# AI Document Review Application — Design Document

**Status:** Proposed
**Version:** 1.0
**Frontend:** Vue / TypeScript
**Backend:** TypeScript
**Persistence:** SQLite v1, abstracted storage layer
**CRDT:** Automerge
**Agent:** Pi SDK
**Deployment:** Self-hosted, Dockerized
**Users:** Single local user/account in v1

---

# 1. Overview

The application is a rapid-review environment where a user edits a Markdown document while having multiple concurrent conversations with an AI agent.

The central concept is:

> **One document, one Pi session, multiple conversation branches, with application-level control over document edits.**

The user can:

* paste or enter a Markdown document;
* directly edit the document;
* ask the main AI conversation questions about the document;
* highlight content and start a branched conversation;
* continue branching conversations;
* have the agent propose document edits;
* review, accept, or drop those edits;
* designate one conversation as **Primary**;
* have Primary agent edits automatically applied to the document;
* manually apply staged edits during an active conversation;
* refresh a conversation against a newer document version;
* review closed conversations;
* have another agent review conversations and their branches.

The application uses **Automerge as the authoritative backend CRDT**. Pi provides the agent/session infrastructure.

---

# 2. Core architectural principles

## 2.1 The application owns the document

The application owns:

* Markdown document state;
* CRDT state;
* document revisions;
* staged edits;
* edit acceptance/rejection;
* conflict resolution;
* Primary conversation behavior;
* conversation metadata;
* UI state;
* application events.

Pi does not own the authoritative document.

---

## 2.2 Pi owns agent conversations

Pi owns:

* agent sessions;
* conversation history;
* conversation tree;
* Pi branching;
* model interaction;
* compaction;
* tool execution;
* agent events;
* Pi session persistence.

The application interacts with Pi through the Pi SDK rather than directly manipulating Pi's session files.

---

## 2.3 No Pi extension in v1

The initial architecture does **not** require a Pi extension.

```text
Vue
 │
 ▼
Application Backend
 │
 ├── Automerge
 ├── document/review state
 ├── SQLite
 │
 └── Pi SDK
       │
       ▼
     Pi
```

A Pi extension may be introduced later if the SDK proves insufficient.

---

# 3. High-level architecture

```text
┌─────────────────────────────────────────────────────────┐
│                     Vue Frontend                        │
│                                                         │
│  Markdown Editor      Rendered Markdown                 │
│  Conversation HUD     Staged Edit UI                    │
│  Diff Viewer          Keyboard Navigation               │
│  Thinking Stream      Agent Status                      │
└──────────────────────────┬──────────────────────────────┘
                           │
                    WebSocket / HTTP
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  TypeScript Backend                     │
│                                                         │
│  Document Service                                      │
│  ├── Automerge CRDT                                    │
│  ├── document revisions                                │
│  └── history                                            │
│                                                         │
│  Conversation Service                                  │
│  ├── conversation metadata                             │
│  ├── Primary                                            │
│  ├── branching rules                                   │
│  └── lifecycle                                          │
│                                                         │
│  Edit Service                                           │
│  ├── staged edits                                      │
│  ├── apply/drop                                        │
│  ├── CRDT reconciliation                               │
│  └── conflict resolution                               │
│                                                         │
│  Pi Service                                             │
│  └── Pi SDK                                             │
│                                                         │
│  Event Service                                          │
│  └── application event stream                          │
│                                                         │
│  Storage abstraction                                    │
│  └── SQLite                                             │
└───────────────┬──────────────────────────┬──────────────┘
                │                          │
                ▼                          ▼
        ┌──────────────┐          ┌────────────────┐
        │    SQLite    │          │  Pi Sessions   │
        │              │          │                │
        │ App state    │          │ Configurable   │
        │ CRDT state   │          │ storage path   │
        └──────────────┘          └────────────────┘
```

---

# 4. Document model

v1 supports a **single document**.

The architecture must not prevent multiple documents in the future.

Conceptually:

```text
Document
 │
 └── Pi Session
       │
       └── Conversation Tree
```

Future:

```text
Account
 ├── Document A → Pi Session A
 ├── Document B → Pi Session B
 └── Document C → Pi Session C
```

---

# 5. Document state and CRDT

Automerge is the authoritative document CRDT.

The backend maintains the authoritative Automerge document.

```text
Vue
 │
 │ CRDT changes
 ▼
Backend
 │
 ├── validate/apply
 ├── persist
 └── broadcast
```

The frontend does not independently become the authoritative document.

Automerge provides:

* concurrent changes;
* merging;
* historical states;
* serialized document state;
* incremental changes;
* snapshots.

---

# 6. CRDT conflict resolution

Document edits are first attempted through Automerge.

### Clean merge

```text
Staged Edit
     │
     ▼
Automerge merge
     │
     ▼
Success
     │
     ▼
Edit becomes applicable
```

### Conflict

If Automerge cannot produce an acceptable clean result:

```text
Staged Edit A
     │
     ▼
CRDT merge
     │
     ▼
Conflict
     │
     ▼
Agent receives conflict context
     │
     ▼
Agent proposes Edit B
     │
     ├── Edit A → automatically rejected
     │
     └── Edit B → presented to user
```

The replacement edit remains subject to the normal staged-edit workflow.

The agent does **not** directly resolve Main.

---

# 7. Document revisions

CRDT operations and application revisions are separate concepts.

A CRDT may contain many operations:

```text
CRDT:
a → b → c → d → e → f
```

while the user sees:

```text
v1
v2
v3
```

A **logical revision** represents a meaningful document milestone.

## Revision creation

### Agent edits

Each applied Pi edit tool call creates a logical revision.

```text
v17
Agent
Applied edit from "Introduction Review"
```

### User edits

Manual edits are debounced.

Default:

```text
5 minutes
```

The debounce period is:

* globally configured by the application;
* overrideable by the user;
* measured independently per document.

If the user stops editing for the configured period, the accumulated changes become a logical revision.

---

# 8. Document history

The user can:

* inspect revisions;
* restore a previous revision;
* undo/redo normal editor operations;
* see whether a revision came from the user or agent;
* see a note associated with agent-derived revisions.

Example:

```text
v21  User
     Manual editing

v22  Agent
     Applied edit from "Introduction Review"

v23  Agent
     Applied conflict resolution

v24  User
     Manual editing
```

Restoring a revision is a **new document operation**, not destructive deletion of history.

---

# 9. Conversation model

Every conversation belongs to the document's Pi session.

The application's conversation record stores metadata while Pi owns the actual conversation.

```text
Main
 ├── Branch A
 │    ├── Branch A.1
 │    └── Branch A.2
 │
 └── Branch B
      └── Branch B.1
```

Conversation branching can continue indefinitely, subject to the application-level configurable conversation depth.

Default:

```text
maxConversationDepth = 3
```

The application cap is enforced. Going beyond it is not permitted.

---

# 10. Editing branch depth

Editing has a separate depth restriction.

The maximum editing depth is configurable at the application level.

Default:

```text
maxEditingDepth = 2
```

This is independent from conversation branching.

A deeply branched conversation may exist, while only conversations within the configured editing depth may participate in document-edit workflows.

---

# 11. Conversation context

Every conversation has a document context version.

Example:

```text
Introduction Review
Main v17
```

This tells the user which Main document revision the conversation currently references.

A branch is **stale by default**.

If Main advances:

```text
Conversation → v17

Main → v18 → v19 → v20
```

the conversation continues to operate against its existing context.

---

# 12. Refresh + Send

The user can explicitly refresh a conversation's document context.

Two send modes exist:

### Normal send

Uses the conversation's current snapshot.

```text
Enter

Conversation context:
v17
```

### Refresh + Send

Updates the conversation context to the latest Main document **including queued edits relevant to that conversation**, then sends the prompt.

```text
Ctrl + Enter

Conversation context:
v20 + queued edits
```

The UI visibly displays the currently loaded document version.

---

# 13. Conversation creation

## Main conversation

The main conversation is always the root conversation.

```text
Main
```

It is always Primary.

---

## Branched conversation

The user can highlight Markdown and start a conversation.

The branch is seeded with:

* the relevant document snapshot;
* highlighted content;
* context necessary to understand the document;
* a preconfigured note indicating that the conversation is branched.

Example:

```text
Main
 │
 └── Review: Introduction
```

The conversation can subsequently branch again.

---

# 14. Primary conversation

There is always exactly one Primary conversation.

The Main conversation is always Primary.

A user can designate another conversation as Primary.

Primary is an **application-level behavior**, not a Pi concept.

### Primary behavior

Agent-generated edits:

```text
Primary
  ↓
Agent edit
  ↓
Document automatically changes
  ↓
Edit is NOT staged
```

The edit therefore does not appear in the conversation-close staged-edit workflow.

The user may also manually apply staged edits while a conversation is active.

---

# 15. Switching Primary

Changing Primary is an immediate application behavior change.

The agent does not need to finish its current cycle.

If the selected conversation is active, the user is warned before switching.

The user can choose:

```text
Switch now
Don't switch
Switch when agent finishes
```

If switched immediately:

```text
Old Primary
    │
    └── continues operating normally

New Primary
    │
    └── becomes automatic-apply conversation
```

The old Primary does not lose or cancel its agent operation.

---

# 16. Concurrent agents

Multiple conversations can run concurrently.

Default maximum:

```text
maxConcurrentAgents = 3
```

This is application configurable.

Additional prompts may be submitted while another agent is running.

Where Pi supports queuing, queued prompts are allowed to follow Pi's normal queue behavior.

---

# 17. Agent edits

The agent is allowed to edit the Markdown document.

The agent uses the appropriate Pi editing mechanism/tool.

A single tool call may modify multiple disjoint ranges.

Example:

```text
Tool call
 ├── replace lines 10–15
 ├── replace line 27
 └── insert after line 43
```

The entire tool call is **one atomic staged edit**.

Users cannot partially accept individual operations within a tool call in v1.

Partial acceptance is future scope.

---

# 18. Staged edits

Non-Primary agent edits are staged.

Example:

```text
Review Introduction

3 queued edits

[Edit 1]  pending
[Edit 2]  pending
[Edit 3]  pending
```

Each edit can be:

* previewed;
* accepted;
* dropped.

The preview supports:

* full document preview;
* Git-diff-style removed/added visualization.

Actual Git history is **not part of v1**.

Git integration is future scope.

---

# 19. Accepting staged edits

The default state is:

```text
All edits: unselected
```

The user explicitly chooses individual edits.

The UI also provides:

```text
Accept remaining
Drop remaining
```

These are convenience operations.

The conversation cannot be closed while there are unresolved staged edits.

---

# 20. Applying edits during an active conversation

The user does not need to wait for conversation closure.

They can apply an individual staged edit while the conversation is active.

```text
Conversation active

Edit 1
[Apply]

Edit 2
[Drop]

Edit 3
[pending]
```

Applying the edit changes Main immediately and creates a logical document revision.

---

# 21. Closing a conversation

Closing a conversation is independent from merging the conversation itself.

Before closure, staged edits must receive a verdict.

The user must resolve all remaining staged edits through:

```text
Apply
Drop
```

or:

```text
Accept remaining
Drop remaining
```

Once all staged edits are resolved, the conversation can close.

---

# 22. Conversation merge vs edit merge

These are explicitly separate concepts.

## Document edit merging

Deals with:

> Should this proposed change modify the document?

Possible actions:

```text
Apply
Drop
```

## Conversation merging

Deals with:

> What should the parent conversation learn from this child conversation?

When a conversation closes, the user is separately offered the conversation merge workflow.

The conversation merge produces:

* generated compact summary;
* relevant structured metadata.

The parent conversation receives that summary/metadata.

The conversation's individual raw message history is not copied into the parent as ordinary application content.

---

# 23. Conversation review

Closed conversations remain visible.

The user can:

* inspect them;
* read their history;
* inspect their edits;
* inspect their document context;
* ask another agent to review them.

A closed conversation cannot be reopened or branched from the frontend.

Another agent may review closed conversations, including their branches.

The reviewing agent does not interact with the closed conversation itself.

---

# 24. Conversation events

The application maintains a lightweight application-level event stream.

Examples:

```text
conversation_started
agent_started
thinking_started
tool_started
tool_completed
staged_edit_created
staged_edit_applied
staged_edit_dropped
staged_edit_superseded
document_refreshed
primary_changed
conversation_closed
agent_error
```

Pi remains the source of truth for Pi messages and agent history.

The application event stream exists for:

* frontend state;
* WebSocket recovery;
* application-specific state transitions.

---

# 25. Streaming

Agent output is streamed to the relevant conversation.

```text
Pi
 ↓
Backend
 ↓
WebSocket
 ↓
Conversation UI
```

Streaming includes Pi reasoning/thinking events.

The application supports a user-configurable:

```text
Show thinking
Hide thinking
```

Thinking is sanitized before rendering.

---

# 26. Streaming recovery

The browser connection is not authoritative.

If the browser disconnects:

```text
Browser X
    │
Backend
    │
Pi continues
```

The agent continues running.

When the browser reconnects, the backend provides the missing application events and current state.

An agent/tool operation therefore cannot be considered failed merely because the WebSocket disconnected.

---

# 27. Agent failure recovery

Recommended behavior:

### Pi/model failure

Conversation becomes:

```text
Error
```

The failure is persisted.

The user can retry.

### Backend restart

On startup:

1. load application state;
2. load Automerge document;
3. restore application conversations;
4. restore Pi sessions through the Pi SDK;
5. recover/reconcile active operations;
6. resume frontend synchronization.

### Browser disconnect

Agent continues.

### Duplicate tool result

Application operations must be idempotent where possible.

Pi tool-call IDs should be used to prevent an edit from being applied twice.

---

# 28. Conflict handling

When a staged edit is applied against a newer Main revision:

```text
Staged edit
source = v17

Main = v22
```

the backend attempts an Automerge merge.

### Successful merge

```text
v22
 ↓
merge
 ↓
v23
```

### Conflict

```text
v22
 ↓
merge fails
 ↓
Agent receives:
  original edit
  source document
  current document
  relevant conflict
 ↓
Agent proposes new edit
```

The original edit is automatically marked:

```text
superseded
```

The new edit becomes:

```text
pending
```

The user sees the replacement diff and decides whether to apply or drop it.

---

# 29. Markdown

The editor accepts Markdown.

Rendering supports:

* standard Markdown;
* Mermaid diagrams;
* SVG.

The rendering pipeline has an abstract sanitization layer.

Conceptually:

```text
Markdown
   ↓
Parser
   ↓
Extension renderer
   ├── Mermaid
   └── SVG
   ↓
Sanitizer
   ↓
Rendered output
```

Additional Markdown/rendering extensions are future scope.

---

# 30. Editor

The primary document UI is split:

```text
┌──────────────────────┬────────────────────────┐
│                      │                        │
│   Raw Markdown       │    Rendered Markdown   │
│                      │                        │
│   # Introduction     │    Introduction        │
│                      │                        │
│   Some text...       │    Some text...        │
│                      │                        │
└──────────────────────┴────────────────────────┘
```

The user can:

* paste initial contents;
* edit Markdown directly;
* select/highlight text;
* start a branch from selection;
* undo;
* redo;
* restore document versions.

---

# 31. Conversation HUD

All conversations are visible in a HUD-style interface.

Example:

```text
┌─────────────────────────────────────────────────────────────┐
│ [MAIN] ● Working          0 edits                          │
│ [INTRO] ○ Waiting         3 edits   Main v17               │
│ [ARGUMENT] ● Working      1 edit    Main v21               │
│ [SUMMARY] ● Waiting       0 edits   Main v21               │
└─────────────────────────────────────────────────────────────┘
```

Each conversation displays:

* name;
* status;
* Primary indicator;
* current document context version;
* queued edit count;
* branch relationship;
* active/waiting state.

---

# 32. Keyboard-first interaction

Keyboard shortcuts are a first-class feature.

Examples:

```text
Enter
    Send using current snapshot

Ctrl + Enter
    Refresh + Send

Conversation navigation
    Configurable hotkeys

Focus conversation
    Configurable hotkeys

Apply/drop edit
    Configurable hotkeys

Undo/redo
    Standard editor shortcuts
```

The complete hotkey map should be configurable in the application.

---

# 33. Database schema

```text
document
    │
    ├── revision
    │
    ├── document_snapshot
    │
    └── conversation
            │
            ├── conversation
            │     └── parent_id
            │
            ├── staged_edit
            │
            └── conversation_event

user_settings
```

### `document`

```sql
CREATE TABLE document (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    current_revision  INTEGER NOT NULL DEFAULT 0
);
```

### `revision`

```sql
CREATE TABLE revision (
    id               INTEGER PRIMARY KEY,
    document_id      TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    source           TEXT NOT NULL,
    conversation_id  TEXT,
    note             TEXT,
    created_at       TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id),

    UNIQUE(document_id, revision)
);
```

### `document_snapshot`

```sql
CREATE TABLE document_snapshot (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
);
```

### `conversation`

```sql
CREATE TABLE conversation (
    id                 TEXT PRIMARY KEY,
    document_id        TEXT NOT NULL,
    pi_session_id      TEXT NOT NULL,
    parent_id          TEXT,
    name               TEXT,

    status             TEXT NOT NULL,
    is_primary         INTEGER NOT NULL DEFAULT 0,

    document_revision  INTEGER NOT NULL,
    branch_depth       INTEGER NOT NULL DEFAULT 0,

    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    closed_at          TEXT,

    FOREIGN KEY (document_id) REFERENCES document(id),
    FOREIGN KEY (parent_id) REFERENCES conversation(id)
);
```

### `staged_edit`

```sql
CREATE TABLE staged_edit (
    id                 TEXT PRIMARY KEY,
    conversation_id    TEXT NOT NULL,
    source_revision    INTEGER NOT NULL,
    pi_tool_call_id    TEXT NOT NULL,

    status             TEXT NOT NULL,

    edit_data          BLOB NOT NULL,

    created_at         TEXT NOT NULL,
    resolved_at        TEXT,

    FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
```

### `conversation_event`

```sql
CREATE TABLE conversation_event (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL,
    sequence          INTEGER NOT NULL,
    event_type        TEXT NOT NULL,
    data              TEXT NOT NULL,
    created_at        TEXT NOT NULL,

    FOREIGN KEY (conversation_id) REFERENCES conversation(id),

    UNIQUE(conversation_id, sequence)
);
```

### `user_settings`

```sql
CREATE TABLE user_settings (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),

    thinking_visible         INTEGER NOT NULL DEFAULT 0,

    revision_debounce_ms     INTEGER NOT NULL DEFAULT 300000,

    max_concurrent_agents    INTEGER NOT NULL DEFAULT 3,

    max_editing_depth        INTEGER NOT NULL DEFAULT 2,

    max_conversation_depth   INTEGER NOT NULL DEFAULT 3
);
```

---

# 34. Pi session persistence

Pi session storage is external to the application database.

The location is application-configurable:

```text
PI_SESSION_STORAGE_PATH=/data/pi-sessions
```

The application uses the Pi SDK to access sessions.

It does not directly manipulate the underlying Pi JSONL format.

---

# 35. API model

The backend exposes application-level APIs rather than exposing SQLite or Pi directly.

Conceptually:

```text
POST   /document
GET    /document
PATCH  /document

GET    /revisions
POST   /revisions/:id/restore

GET    /conversations
POST   /conversations
POST   /conversations/:id/branch
POST   /conversations/:id/send
POST   /conversations/:id/refresh-send

POST   /conversations/:id/primary
POST   /conversations/:id/close

GET    /conversations/:id/edits
POST   /edits/:id/apply
POST   /edits/:id/drop

WebSocket /events
```

The exact HTTP framework remains to be selected.

---

# 36. BDD requirements

## Document creation

**Given** the application has no document
**When** the user pastes Markdown content
**Then** the application creates the document
**And** initializes its Automerge state
**And** creates the Main Pi conversation.

---

## Manual editing

**Given** the user is editing the document
**When** the user changes the Markdown
**Then** the change is applied to the backend-authoritative CRDT
**And** synchronized to connected clients.

**Given** the user stops editing
**When** the configured debounce period expires
**Then** the application creates a logical document revision.

---

## Main conversation

**Given** the Main conversation exists
**When** the user submits a prompt
**Then** the prompt is sent to Pi
**And** the current Main context is used.

---

## Branched conversation

**Given** the user highlights Markdown
**When** the user starts a conversation
**Then** a child conversation is created
**And** it receives the selected content and document context
**And** it is associated with the appropriate Pi branch.

---

## Stale branch

**Given** a branch references document revision 17
**When** Main advances to revision 20
**Then** the branch remains associated with revision 17
**And** the UI indicates that the branch is stale.

---

## Refresh + Send

**Given** a branch references revision 17
**And** Main is revision 20
**When** the user selects Refresh + Send
**Then** the branch context is refreshed
**And** queued edits applicable to that conversation are incorporated
**And** the prompt is sent to Pi
**And** the UI displays revision 20 as the conversation context.

---

## Staged agent edit

**Given** a non-Primary conversation is active
**When** the agent makes an edit
**Then** the edit becomes one atomic staged edit
**And** the edit is associated with the Pi tool call
**And** Main is not modified.

---

## Primary edit

**Given** a conversation is Primary
**When** its agent makes an edit
**Then** the edit is automatically applied to the document
**And** no staged edit remains for that tool call
**And** a logical revision is created.

---

## Manual application

**Given** a conversation contains a pending staged edit
**When** the user applies the edit
**Then** the backend attempts to merge it with the current CRDT state.

---

## Clean merge

**Given** a staged edit can be merged cleanly
**When** the user applies it
**Then** the edit is applied
**And** a new logical revision is created
**And** the staged edit is marked accepted.

---

## Conflict

**Given** a staged edit cannot be cleanly merged
**When** the user applies it
**Then** the backend asks the agent to propose a replacement edit
**And** the original edit is automatically superseded
**And** the replacement edit becomes pending
**And** the user can preview and accept or drop it.

---

## Accept remaining

**Given** multiple pending edits exist
**And** the user has already resolved some of them
**When** the user selects Accept remaining
**Then** all unresolved applicable edits are processed as if individually accepted.

---

## Drop remaining

**Given** multiple pending edits exist
**When** the user selects Drop remaining
**Then** all unresolved edits are dropped.

---

## Closing

**Given** a conversation has unresolved staged edits
**When** the user attempts to close it
**Then** the application prevents closure
**And** requires every staged edit to receive a verdict.

---

## Primary switching

**Given** conversation A is Primary
**And** conversation B is active
**When** the user attempts to make B Primary
**Then** the application explains the state of A
**And** offers:

* switch now;
* don't switch;
* switch when A finishes.

**When** the user selects switch now
**Then** B immediately becomes Primary
**And** A continues running if it was active.

---

## Agent concurrency

**Given** the application concurrency limit is 3
**When** three agents are running
**And** the user submits another prompt
**Then** the prompt is queued according to the application's/Pi's queue behavior.

---

## Browser disconnect

**Given** an agent is running
**When** the browser disconnects
**Then** the backend continues the agent operation.

**When** the browser reconnects
**Then** the application restores the current state
**And** replays missing application events.

---

## Conversation closure

**Given** all staged edits have received a verdict
**When** the user closes a conversation
**Then** the conversation becomes closed
**And** the user is separately offered the conversation merge workflow.

---

## Conversation merge

**Given** a child conversation is being merged into its parent
**When** the merge is requested
**Then** the application generates a compact summary
**And** includes relevant structured metadata
**And** makes that information available to the parent conversation.

---

## Closed conversations

**Given** a conversation is closed
**When** the user views conversations
**Then** the conversation remains available for review
**And** it cannot be reopened or branched from the frontend.

---

# 37. Security

The rendering pipeline must sanitize generated content.

At minimum:

```text
Markdown
 ├── Mermaid
 └── SVG
      ↓
Sanitization layer
      ↓
DOM
```

The sanitization implementation should be abstracted so additional rendering formats can be added without changing the document model.

---

# 38. Future scope

The following are deliberately excluded from v1.

### Multiple documents

```text
Account
 ├── Document A
 ├── Document B
 └── Document C
```

The current schema already includes `document_id` relationships to make this expansion possible.

### Additional databases

Current:

```text
Storage → SQLite
```

Future:

```text
Storage → PostgreSQL
Storage → ...
```

### Additional agent tools

Initial agent capabilities focus on reading/editing the document.

Future:

* web search;
* web fetch;
* SearXNG;
* additional tools.

### Additional Markdown extensions

Future rendering support beyond Mermaid and SVG.

### Git integration

Git-style diffs exist in the UI, but Git history/repositories are not part of v1.

### Partial tool-call acceptance

Currently:

```text
Pi tool call
   ↓
atomic edit
```

Future:

```text
Pi tool call
 ├── range A → accept
 ├── range B → drop
 └── range C → accept
```

### Pi extension

Only introduce a Pi extension if the SDK proves insufficient for the application's requirements.

### Pi export viewing

Support for viewing Pi's exported conversation formats.

### Additional contextual material

Users will eventually be able to import additional material for the agent to reference.

---

# 39. Recommended implementation order

### Phase 1 — Core document

1. Vue Markdown editor
2. Markdown renderer
3. Automerge integration
4. Backend-authoritative synchronization
5. SQLite storage
6. logical revisions
7. undo/redo
8. revision restoration

### Phase 2 — Pi

1. Pi SDK integration
2. Main conversation
3. streaming
4. thinking events
5. Pi session persistence
6. agent read/edit tools

### Phase 3 — Review workflow

1. conversation branching
2. conversation HUD
3. stale context indicators
4. staged edits
5. diff viewer
6. apply/drop
7. Primary
8. Primary switching
9. close workflow

### Phase 4 — Reconciliation

1. Automerge edit merging
2. conflict detection
3. agent conflict-resolution proposals
4. replacement staged edits
5. revision creation

### Phase 5 — Reliability

1. application event stream
2. WebSocket recovery
3. Pi failure recovery
4. idempotent tool processing
5. Docker deployment
6. persistence/restart testing

### Phase 6 — Polish

1. comprehensive hotkeys
2. conversation naming
3. closed conversation review
4. conversation summaries
5. accessibility
6. performance optimization

---

# 40. Final architectural model

The fundamental separation is:

```text
                         ┌───────────────────────┐
                         │          PI           │
                         │                       │
                         │ Agent intelligence    │
                         │ Sessions              │
                         │ Conversation tree     │
                         │ Compaction            │
                         │ Tools                 │
                         │ Message history       │
                         └───────────┬───────────┘
                                     │
                                  Pi SDK
                                     │
┌────────────────────────────────────▼────────────────────┐
│                    REVIEW APPLICATION                   │
│                                                         │
│  Document                                               │
│      │                                                  │
│      └── Automerge CRDT ← authoritative                 │
│                                                         │
│  Revisions                                              │
│                                                         │
│  Conversations                                         │
│      ├── Primary                                       │
│      ├── context version                               │
│      ├── staged edits                                  │
│      └── application events                            │
│                                                         │
│  Merge / conflict resolution                            │
│                                                         │
│  User interaction / review workflow                    │
└──────────────────────────┬──────────────────────────────┘
                           │
                        WebSocket
                           │
┌──────────────────────────▼──────────────────────────────┐
│                         VUE                             │
│                                                         │
│ Editor │ Renderer │ HUD │ Diff │ Thinking │ Hotkeys    │
└─────────────────────────────────────────────────────────┘
```

The most important invariant throughout the design is:

> **Pi proposes agent activity; the application controls document state.**

For non-Primary conversations, an agent edit becomes a staged proposal. For Primary, the same proposal is automatically applied. Conflicts are resolved by asking the agent to produce another proposal, never by allowing the agent to bypass the application's document workflow.

