# Implementation Plan: AI Document Review Application

**Branch**: `001-ai-document-review` | **Date**: 2026-08-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ai-document-review/spec.md`

## Summary

A localhost-only, self-hosted web application in which a single user edits one Markdown document
while holding multiple concurrent, branching conversations with an AI agent. Agent-authored changes
never mutate the document directly: each edit tool call becomes one atomic *proposal* that the user
previews and accepts or drops, except in the conversation optionally designated **Primary**, where
the same proposal is auto-applied through the identical pipeline. Primary is optional — at most one
conversation holds it, and the user may clear it entirely, in which case every conversation stages.

Technical approach: a Vue 3 frontend over a Fastify backend that is the sole authority for document
state. The document lives in an Automerge CRDT owned by the backend and persisted to SQLite behind a
storage abstraction; logical revisions are a separate, user-facing concept layered above the CRDT
operation log. Agent conversations are delegated entirely to the Pi Coding Agent SDK — one
`AgentSession` per conversation, each in its own JSONL session file forked from its parent — and the
agent reaches the document only through two custom tools (`read_document`, `propose_document_edit`)
with all built-in filesystem tools disabled. Because Automerge text merges never fail, "conflict" is
defined at the application layer by deterministic anchored find/replace reconciliation: an anchor
that no longer resolves uniquely produces a conflict, which supersedes the proposal and asks the
originating agent for a replacement.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`), Node 26.1.0 (pinned by devcontainer and runtime image)

**Primary Dependencies**:
- Backend: `fastify@^5.12` + `@fastify/websocket`, `@automerge/automerge@^3.4`, `node:sqlite` (built-in), `@earendil-works/pi-coding-agent@0.84.3` (exact pin), `pino@^10`, `zod@^4`
- Frontend: `vue@^3.5`, Vite, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`, `@codemirror/commands`), `markdown-it@^15`, `dompurify@^3.4`, `mermaid@^11`, `diff@^9`

**Storage**: SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), behind a `StorageAdapter`
interface so PostgreSQL can be substituted without changing callers. Automerge state persisted as
incremental binary blobs plus periodic snapshots. Pi session JSONL files live outside the database in
a configurable directory (`PI_SESSION_STORAGE_PATH` → SDK `sessionDir` argument).

**Testing**: Vitest ^4.1 (unit + integration, backend and frontend), Playwright ^1.62 (end-to-end
acceptance scenarios), plus a `FakePiSession` test double for deterministic agent behaviour and a
thin contract-test suite against real Pi.

**Target Platform**: Self-hosted Docker container on Linux, served to a modern desktop browser.
Localhost-only by design — no authentication; network exposure is an unsupported configuration.

**Project Type**: Web application (Vue frontend + TypeScript backend + shared contract package)

**Performance Goals**: First Main answer within 15 s of document paste (SC-001); first branch
response within 10 s on a ~15,000-word document (SC-002); ≥3 concurrent conversations with no
perceptible editor latency (SC-007); full reconnect catch-up within 5 s (SC-006). Editor keystroke
→ CRDT apply → broadcast target under 50 ms p95 locally.

**Constraints**: Backend is the only document authority — the frontend must never diverge into a
second source of truth. Agent edits must pass through the proposal pipeline without exception.
Applying a staged edit must be idempotent on `pi_tool_call_id`. All rendered output must pass the
sanitizer. A browser disconnect must never be interpreted as an agent failure. Configurable limits
must be enforced in code, not merely surfaced in the UI.

**Scale/Scope**: One document per installation, up to ~30 pages / ~15,000 words; one local user;
3 concurrent agents by default; conversation depth 3, editing depth 2 by default. Roughly 54
functional requirements across 7 user stories, ~41 Given/When/Then acceptance scenarios.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against [constitution.md](../../.specify/memory/constitution.md) v1.0.0.

### Initial evaluation (pre-Phase 0)

| Principle | Status | Basis |
| --- | --- | --- |
| I. The Application Owns the Document | PASS | Backend holds the authoritative Automerge doc, revisions, staged edits, conflict resolution; frontend sends change intents and renders broadcast state. |
| II. Pi Owns Agent Conversations | PASS | All Pi access via SDK (`createAgentSession`, `SessionManager`); the application stores only a session *file path* and never parses JSONL. |
| III. Agent Edits Are Proposals, Not Direct Writes | PASS | One `propose_document_edit` tool call → one atomic staged edit keyed by `pi_tool_call_id`. Primary auto-applies through the same pipeline. No agent filesystem tools. |
| IV. CRDT-Mediated Merging, Revisions Separate | PASS | Automerge applies all edits; `revision` is a distinct table/concept; restore is a forward `updateText` operation, never a deletion. |
| V. Configurable Limits Are Enforced | PASS | Depth, concurrency and debounce checks live in backend services (the only path to the mutation), not in the UI. |
| VI. Sanitize Before Render | PASS | Single `SanitizerPort`; sanitization runs last, after Mermaid/SVG generation; streamed reasoning uses the same port. |
| VII. No Pi Extension Without Necessity | **NEEDS CLARIFICATION → resolved in R3** | Initially unverified whether tool restriction and system-prompt control were reachable without an extension. |

**Technology & Platform Constraints**: PASS — Vue/TS frontend, TS backend, SQLite behind an
abstraction, Automerge as the only document CRDT, Pi via SDK only, Dockerized self-hosted, single
local user with `document_id`/settings shaped so multi-document and multi-account are not precluded.
No v1 non-goal is implemented (no multiple documents, no non-SQLite backend, no agent tools beyond
document read/edit, no rendering extensions beyond Mermaid/SVG, no real Git, no partial acceptance,
no Pi extension, no Pi export viewing, no imported reference material).

**Quality & Review Gates**: PASS — spec supplies Given/When/Then for every behaviour; idempotency
keyed on `pi_tool_call_id` (FR-040); disconnect handling separated from failure handling (FR-037);
close blocked while any staged edit lacks a verdict (FR-033).

Gate result: **proceed to Phase 0**, with Principle VII to be settled by research.

### Re-evaluation (post-Phase 1 design)

| Principle | Status | Basis after design |
| --- | --- | --- |
| I | PASS | `contracts/http-api.md` exposes only application-level operations; `contracts/websocket-events.md` is broadcast-from-backend. No endpoint lets a client write CRDT or Pi state directly. |
| II | PASS | `PiService` is the only module importing the Pi SDK. `conversation.pi_session_path` is opaque to the rest of the system. Closed-conversation review reads through `SessionManager.open()`. |
| III | PASS | `propose_document_edit` returns a proposal id, never a document mutation. `EditService.reconcileAndApply` is the sole write path; Primary differs only by who triggers it. Conflict yields a *replacement proposal*, never an agent-side resolution. |
| IV | PASS | `data-model.md` keeps `revision` and `document_snapshot` distinct; restore inserts a new revision. Automerge history is never truncated. |
| V | PASS | Limits are columns on `user_settings`, read by `ConversationService` (depths, concurrency) and `RevisionService` (debounce) on the server side of every guarded operation. |
| VI | PASS | Sanitizer is the terminal stage of the render pipeline for Markdown, Mermaid output, SVG, and agent reasoning alike. |
| VII | **PASS (resolved)** | R3 verified `noTools: "all"` + `customTools` + `DefaultResourceLoader({ systemPrompt })` are all SDK-level. No Pi extension is introduced; necessity is not demonstrated. |

One factual deviation from `design.md` (not from the constitution) is recorded below and in R2.

**Deviation from `design.md` §21 — "one Pi session, multiple conversation branches"**: the verified
Pi SDK exposes a session tree as a single navigational leaf cursor, and one `AgentSession` refuses
concurrent runs. Realising FR-013/FR-015 therefore requires one `AgentSession` (one JSONL file) per
conversation, created with `SessionManager.forkFrom(parent…)` and grouped in one per-document session
directory. Constitution Principle II is unaffected — Pi still owns conversations and is reached only
through the SDK. Recommend reconciling this sentence in `design.md`; it needs no constitution
amendment.

Gate result: **PASS — no violations. Complexity Tracking is empty.**

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-document-review/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── http-api.md
│   ├── websocket-events.md
│   └── agent-tools.md
├── checklists/
│   └── requirements.md  # Existing spec-quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
package.json                        # npm workspaces root
tsconfig.base.json
docker/
├── Dockerfile                      # node:26.1.0-trixie runtime, builds frontend + backend
└── docker-compose.yml              # single service, volumes for SQLite + Pi sessions

packages/shared/
└── src/
    ├── contracts/                  # Zod schemas + inferred types shared by both sides
    │   ├── http.ts                 # request/response shapes for contracts/http-api.md
    │   ├── events.ts               # application event union for websocket-events.md
    │   └── agent-tools.ts          # propose_document_edit / read_document schemas
    └── domain/                     # Document, Revision, Conversation, StagedEdit, UserSettings types

packages/backend/
├── src/
│   ├── server.ts                   # Fastify bootstrap, loopback-only bind (FR-044), startup recovery (FR-039/FR-039a)
│   ├── config.ts                   # env + user_settings resolution, defaults from FR-041
│   ├── logging.ts                  # pino instance, shared event vocabulary (FR-042)
│   ├── storage/
│   │   ├── storage-adapter.ts      # StorageAdapter interface (the abstraction boundary)
│   │   ├── sqlite/                 # node:sqlite implementation + migrations + repositories
│   │   └── index.ts
│   ├── document/
│   │   ├── document-service.ts     # create, read, apply manual change specs, broadcast
│   │   ├── automerge-store.ts      # Automerge load/save/splice/snapshot lifecycle
│   │   ├── revision-service.ts     # logical revisions, debounce timer, restore, export
│   │   └── text-anchor.ts          # anchored reconciliation algorithm (research R4)
│   ├── conversation/
│   │   ├── conversation-service.ts # lifecycle, branching, depth limits, primary, close
│   │   ├── primary-service.ts      # single-Primary invariant, switch modes (FR-029/030)
│   │   └── concurrency-limiter.ts  # maxConcurrentAgents queue (FR-015)
│   ├── edit/
│   │   ├── edit-service.ts         # stage, apply, drop, bulk verdicts, idempotency
│   │   └── conflict-service.ts     # supersede + request replacement proposal (FR-032)
│   ├── pi/
│   │   ├── pi-service.ts           # ONLY module importing the Pi SDK
│   │   ├── document-tools.ts       # read_document + propose_document_edit custom tools
│   │   ├── system-prompt.ts        # agent instructions via DefaultResourceLoader
│   │   └── event-bridge.ts         # Pi AgentSessionEvent -> application event stream
│   ├── events/
│   │   ├── event-service.ts        # append + sequence conversation_event rows
│   │   ├── event-hub.ts            # fan-out to sockets, replay-since-sequence (FR-037)
│   │   └── run-buffer.ts           # per-active-run partial response text, replayed on mid-run reconnect (FR-037a)
│   └── api/
│       ├── http/                   # route modules mirroring contracts/http-api.md
│       └── ws/                      # /events socket, subscribe/replay handshake
└── tests/
    ├── unit/                       # text-anchor, revision debounce, depth limits, sanitizer port
    ├── integration/                # service-level Given/When/Then over a temp DB + FakePiSession
    ├── contract/                   # HTTP/WS shape tests; live-Pi contract tests (tagged, opt-in)
    └── fakes/                      # FakePiSession and fixtures

packages/frontend/
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── components/
│   │   ├── editor/                 # CodeMirror 6 host, selection -> branch action
│   │   ├── preview/                # rendered Markdown pane
│   │   ├── hud/                    # conversation HUD (design §31), stale + edit-count badges
│   │   ├── conversation/           # message list, streaming text, reasoning toggle
│   │   ├── edits/                  # proposal list, accept/drop, bulk actions
│   │   ├── diff/                   # added/removed view + full preview (FR-022)
│   │   └── history/                # revision list, restore, export
│   ├── render/
│   │   ├── markdown-pipeline.ts    # markdown-it + extension renderers
│   │   ├── sanitizer.ts            # SanitizerPort implementation (DOMPurify)
│   │   └── extensions/             # mermaid.ts, svg.ts
│   ├── stores/                     # document, conversations, edits, settings (Pinia)
│   ├── transport/                  # HTTP client + WebSocket client with resubscribe/replay
│   └── a11y/                       # focus management, live regions, keymap registry (FR-043)
└── tests/
    ├── unit/
    └── component/

tests/e2e/                          # Playwright specs, one file per user story (US1..US7)
```

**Structure Decision**: Web application layout with three npm workspaces —
`packages/backend`, `packages/frontend`, and `packages/shared`. The split is driven directly by the
constitution: Principle I requires the document authority to live wholly in the backend, so the
frontend gets no CRDT write path; `packages/shared` exists so the HTTP/WebSocket/tool contracts are
defined once as Zod schemas and consumed by both sides, preventing the frontend from drifting into a
second definition of application state. Within the backend, directories mirror the service
boundaries named in `design.md` §3 (document, conversation, edit, pi, events, storage), with
`storage/storage-adapter.ts` and `pi/pi-service.ts` as the two enforced choke points required by the
Technology Constraints and Principle II respectively. `tests/e2e` sits at the repository root because
Playwright specs exercise the built container rather than any single package.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. The post-design Constitution Check passes on all seven principles, the Technology &
Platform Constraints, and the Quality & Review Gates. No v1 non-goal is implemented, and no Pi
extension is introduced.
