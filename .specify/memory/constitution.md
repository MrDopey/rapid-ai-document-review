<!--
Sync Impact Report
Version change: 2.4.0 → 2.5.0
Rationale: MINOR — further extends the "Pi export viewing" carve-out established in v2.4.0
(Technology & Platform Constraints) so it also permits rendering the ENTIRE shared Pi session tree
for a threaded-conversation document — every thread/branch together, not just one thread's own
root-to-leaf path — in the browser. This whole-tree view MUST be obtained exclusively via the Pi
SDK's own whole-tree export primitive (`AgentSession.exportToHtml()`); the boundary the v2.4.0
carve-out already drew is otherwise unchanged and continues to apply in full: the application still
MUST NOT read or write Pi's underlying session storage format directly (Principle II is unaffected),
and this still does not license fabricating, reformatting, or otherwise reconstructing a substitute
for Pi's own export by any other means. This is a further loosening of the same existing scope
boundary, not a new principle and not a redefinition of one, and does not make any previously-
compliant plan non-compliant, so it is versioned as MINOR (materially expanded guidance), consistent
with the prior 2.2.0 → 2.3.0 and 2.3.0 → 2.4.0 amendments to this same non-goals list.
Modified principles: n/a (no existing Core Principle redefined)
Modified sections: Technology & Platform Constraints → v1 non-goals bullet ("Pi export viewing"
rationale extended to also cover a document-wide, whole-session-tree export via
`AgentSession.exportToHtml()`, alongside the existing single-thread export carve-out)
Added sections: none
Removed sections: none
Deferred items: none
-->

# AI Document Review Application Constitution

## Core Principles

### I. The Application Owns the Document
The application backend is the sole authority over document state: Markdown content, Automerge
CRDT state, document revisions, staged edits, edit acceptance/rejection, conflict resolution,
Primary-conversation behavior, conversation metadata, UI state, and the application event stream.
No other component — including Pi, the frontend, or an agent — may become an independent source
of truth for the document.
**Rationale**: A rapid-review workflow depends on the user being able to trust a single,
consistent document state at all times; splitting authority across the frontend, Pi, and the
backend would make conflicts and recovery unreliable.

### II. Pi Owns Agent Conversations
Pi is the sole authority over agent sessions, conversation history, the conversation tree,
Pi-level branching, model interaction, compaction, tool execution, and agent events. The
application interacts with these exclusively through the Pi SDK. The application MUST NOT read or
write Pi's underlying session storage format directly.
**Rationale**: Treating Pi as an opaque, SDK-mediated subsystem keeps the application resilient to
changes in Pi's internal storage/session format and keeps the ownership boundary with Principle I
unambiguous.

### III. Agent Edits Are Proposals, Not Direct Writes
An agent tool call that modifies the document produces one atomic staged edit, associated with its
Pi tool-call ID; a single tool call may span multiple disjoint ranges, but partial acceptance of
those ranges is out of scope until a future version. For the Primary conversation only, the
proposal is automatically applied and a logical revision is recorded — it is still a proposal that
passed through the application's edit pipeline, never a direct mutation. The agent MUST NOT bypass
this pipeline, and MUST NOT resolve conflicts against the document directly; on conflict, the
application asks the agent to produce a new proposal, and the user or Primary policy decides its
fate.
**Rationale**: This is the load-bearing invariant of the design — "Pi proposes agent activity; the
application controls document state" — and it is what keeps agent behavior reviewable and
reversible for both Primary and non-Primary conversations.

### IV. CRDT-Mediated Merging, With Revisions as a Separate Concept
All document edits are first attempted through Automerge merge. A logical revision (what the user
sees, e.g. v17) is a meaningful, explicitly created milestone — via an applied agent edit or a
debounced batch of manual edits — and is distinct from the underlying CRDT operation log. Restoring
a past revision MUST be implemented as a new forward operation, never as destructive deletion of
CRDT or revision history.
**Rationale**: Separating "what Automerge merged" from "what the user perceives as a version"
lets the system give users a small, meaningful history while Automerge handles the underlying
concurrency correctness.

### V. Configurable Limits Are Enforced, Not Advisory
Application-level limits — including maximum conversation branching depth, maximum editing depth,
maximum concurrent agents, and the manual-edit revision debounce period — are configurable, but
once configured they MUST be enforced by the application. Code paths MUST NOT allow these limits to
be silently exceeded.
**Rationale**: These limits exist to bound cost, complexity, and review burden; a limit that can be
bypassed provides no actual guarantee to the user or the operator.

### VI. Sanitize Before Render
Any content that reaches the DOM through the Markdown rendering pipeline — standard Markdown,
Mermaid diagrams, SVG, or any future rendering extension — MUST pass through an abstracted
sanitization layer first. The sanitizer abstraction MUST allow new rendering formats to be added
without changes to the document model.
**Rationale**: Markdown authored or influenced by an LLM agent is untrusted content by default;
rendering it without sanitization is a direct XSS exposure.

### VII. No Pi Extension Without Demonstrated Necessity
The architecture MUST NOT require a Pi extension in the initial implementation. A Pi extension MAY
be introduced later, but only once the Pi SDK has been demonstrated to be insufficient for a
specific, stated requirement.
**Rationale**: Avoids speculative infrastructure; keeps the integration surface with Pi as small as
possible until a concrete need proves otherwise (YAGNI applied to the Pi integration boundary).

### VIII. Comments Are Durable, Not Historical
Code comments MUST be used sparingly, and only where they survive a refactor or rewrite without
becoming stale or misleading. A comment MUST NOT describe the current change, reference a task,
ticket, or prior implementation, or otherwise narrate history — that content belongs in commit
messages and PR descriptions, not in the codebase. A comment that exists primarily to describe what
a specific change did, rather than a durable fact about the code as it now stands, MUST NOT be
written. Where a comment is warranted, it MUST be clear and concise, and MUST call out a gotcha that
cannot be discovered by reading the surrounding code — a non-obvious invariant, a hidden constraint,
or a behavior that would otherwise surprise a future reader. A comment written to justify an
exception to a rule or convention is a signal that the exception is masking a poor design decision;
in that case the design MUST be fixed rather than documented around.
**Rationale**: Comments that narrate a change's history rot the moment the surrounding code moves
on, and comments that over-explain drown out the rare comment that actually earns its place;
keeping comments sparse, durable, and focused on non-obvious gotchas keeps them trustworthy.

## Technology & Platform Constraints

* Frontend: Vue / TypeScript. Backend: TypeScript. Persistence: SQLite in v1, behind an abstracted
  storage layer so a future backing store (e.g. PostgreSQL) can be substituted without changing
  callers.
* Document CRDT: Automerge is the only authoritative document CRDT. Agent/session infrastructure:
  Pi, accessed only via the Pi SDK (Principle II).
* Deployment: self-hosted, Dockerized. Users: v1 supports a single local user/account; the schema
  and service boundaries MUST NOT preclude multiple accounts in a later version. Multiple documents
  per the single local user/account are supported per specs/010-multi-document-support.
* Explicit v1 non-goals (tracked as future scope, not to be implemented speculatively): storage
  backends beyond SQLite, additional agent tools beyond document read/edit/web-search/web-fetch,
  additional Markdown rendering extensions beyond Mermaid/SVG, real Git history/repository
  integration, partial tool-call acceptance, a Pi extension (Principle VII), importable contextual
  reference material, and multi-user/multi-account support.
  **Rationale**: `web_search` and `web_fetch` are carved out of the "no additional agent tools"
  non-goal because both are read-only, information-gathering tools registered as ordinary
  `customTools` — the same mechanism as `read_document` — so they neither require a Pi extension
  (Principle VII stays satisfied) nor touch the edit-proposal pipeline (Principle III stays
  satisfied: they cannot modify the document). Any other new agent tool remains out of scope until
  it earns its own carve-out the same way. "Multiple documents" is removed from this list entirely,
  rather than merely narrowed, because specs/010-multi-document-support implements it for the
  single local user; multi-user/multi-account support remains a distinct, still-excluded non-goal.
  "Pi export viewing" is likewise removed from this list entirely, rather than merely narrowed,
  because rendering a thread's own genuine, native Pi session export in the browser
  (specs/011-linear-thread-mode, User Story 4 / FR-013) is read-only viewing of an export that Pi
  itself produces via the Pi SDK; Principle II is unaffected by this carve-out — the application
  still MUST NOT read or write Pi's underlying session storage format directly, and MUST continue
  to obtain any such export exclusively through the Pi SDK, never by reading Pi's storage directly.
  This carve-out does not license the application to fabricate, reformat, or otherwise reconstruct
  a substitute for Pi's own export by any other means; only rendering Pi's genuine export, unaltered
  in substance, is in scope. The carve-out extends to rendering the ENTIRE shared Pi session tree for
  a threaded-conversation document — every thread/branch together, not only one thread's own
  root-to-leaf path — obtained exclusively via the Pi SDK's own whole-tree export primitive
  (`AgentSession.exportToHtml()`); the same boundary applies unchanged — no direct reading/writing of
  Pi's underlying session storage format, and no fabricated/reconstructed substitute for what that
  SDK primitive itself produces.
* Environment variable naming: every application-defined environment variable (backend or frontend)
  MUST be prefixed with `RADR_` (the project's acronym, AI Document Review). Exempt: variables that
  are not application-defined, namely third-party SDK/provider credential variables (e.g.
  `ANTHROPIC_API_KEY`) and platform-standard variables (e.g. `NODE_ENV`), which keep their standard,
  unprefixed names.
  **Rationale**: A consistent prefix makes it unambiguous, at a glance, which configuration surface
  belongs to this project versus a third-party credential or a platform convention — see
  `specs/003-radr-env-var-prefix/` for the rename this rule formalizes.

## Quality & Review Gates

* Every user-facing behavior change MUST be expressible as Given/When/Then acceptance criteria
  before implementation is considered complete, consistent with the BDD requirements already
  captured for this feature.
* Application operations that can be retried or duplicated (notably applying a staged edit tied to
  a Pi tool-call ID) MUST be idempotent.
* A browser disconnecting MUST NOT be treated as an agent or tool-call failure; the backend and Pi
  remain the source of truth, and reconnection MUST reconcile from the application event stream
  rather than assuming lost work.
* A conversation MUST NOT be closable while it has staged edits without a verdict (applied or
  dropped).
* Document content embedded in any seed/context message sent to the LLM (e.g. a Main
  conversation's seed message, a branch's seed excerpt) MUST be wrapped in a matching pair of
  XML-style tags (e.g. `<document-revision-N>...</document-revision-N>`) that clearly delimit it
  from the surrounding prose; the opening and closing tag names MUST match.
  **Rationale**: A matching-tag delimiter lets the model tell literal document content apart from
  surrounding instructional prose, rather than relying on prose phrasing alone.

## UI Conventions

* Conversation rows and headers throughout the application follow a consistent 3-section layout:
  title | primary action | status. The left section identifies the conversation; the middle
  section is a single slot holding whichever one action currently applies to that conversation in
  that context (never more than one); the right section groups the status badge together with
  every other applicable badge for that conversation.
* In the HUD conversation list (`HudPanel.vue`), each row's middle slot shows "Make Primary" when
  the conversation is not already Primary and is not closed (shown disabled, rather than hidden,
  while errored); otherwise the slot is empty.
* In the conversation detail header (`ConversationView.vue`), the middle slot shows "Request
  review" once the conversation is closed, or "Close" while the conversation is still open and its
  kind is not `main`; otherwise the slot is empty. Neither action is duplicated elsewhere in the
  view.
* A future action that applies to "the one thing you can currently do to this conversation" MUST
  be surfaced in this same middle slot rather than as a separate control elsewhere in the same
  row or view.
  **Rationale**: A single, predictable location for the current primary action keeps
  conversation-list rows and the conversation detail header legible as the same kind of object at
  two different levels of detail, and avoids the same action (e.g. Close, Request review)
  reappearing in more than one place as the surrounding layout evolves.

### Keyboard Shortcuts

* `app/frontend/src/a11y/keymap-registry.ts`'s `KEYBOARD_SHORTCUTS` array is the single source of
  truth for every keyboard shortcut in the application. The registry is documentation only — it
  does not rebind or implement any shortcut itself; each entry documents a binding actually
  implemented in its own component. Entries are grouped by a `scope` field and rendered in a
  "Keyboard shortcuts" help dialog (`KeyboardShortcutsDialog.vue` / `ShortcutGroup.vue`), reachable
  via an icon button in the main toolbar.
* Each entry's `description` MUST be short, direct, present-tense, user-facing text describing what
  the shortcut does now. It MUST NOT use hedging language, and MUST NOT carry historical or
  narrative framing — no explanation of why the shortcut was added, what it used to do, or
  references to internal FR-ID/spec ticket numbers. That context belongs in commit messages and
  PRs, not in-app documentation.
* New global shortcuts SHOULD avoid bare `Alt+<letter>` combinations where an alternative exists,
  since these are commonly intercepted by window managers or browser extensions before they reach
  the page; prefer a combination such as `Ctrl+Alt+<letter>` instead.

## Governance

This constitution supersedes conflicting statements in other project documents (including
`design.md`) for governance purposes; where `design.md` and this constitution diverge on a
non-negotiable rule, this constitution controls until both are reconciled in the same amendment.

**Amendment procedure**: Amendments are made by editing this file via the constitution workflow,
which regenerates the Sync Impact Report, bumps the version per the policy below, and flags any
dependent templates (plan/spec/tasks/checklist) that may need alignment. Amendments should record,
in the commit or PR description, which principle(s) changed and why.

**Versioning policy** (semantic versioning applied to governance):
* MAJOR — backward-incompatible removal or redefinition of a principle or governance rule.
* MINOR — a new principle or materially expanded guidance added.
* PATCH — wording, typo, or clarification changes with no semantic effect.

**Compliance review**: Any plan or task list produced by the Spec Kit workflow MUST be checked
against these principles before implementation begins; a violation MUST either be justified in the
plan's complexity-tracking section or the plan MUST be revised to comply.

**Version**: 2.5.0 | **Ratified**: 2026-08-25 | **Last Amended**: 2026-09-20
