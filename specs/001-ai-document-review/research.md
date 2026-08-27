# Phase 0 Research: AI Document Review Application

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Inputs**: [spec.md](./spec.md), [design.md](../../design.md), [constitution.md](../../.specify/memory/constitution.md)

All `NEEDS CLARIFICATION` items raised in the plan's Technical Context are resolved below. Versions
were verified against the npm registry and, for Pi, against the published type declarations of
`@earendil-works/pi-coding-agent@0.84.3` (not documentation alone).

---

## R1. What is "Pi", and what does its SDK actually expose?

**Decision**: Pi is the **Pi Coding Agent** (`@earendil-works/pi-coding-agent`, `^0.84.3`, docs at
`pi.dev`). The application depends on its embeddable SDK surface only:
`createAgentSession`, `AgentSession`, `SessionManager`, `DefaultResourceLoader`, `ModelRuntime`,
`defineTool`.

**Rationale**: `design.md` names "Pi SDK" without identifying the package. The published
`.d.ts` files confirm every capability the design assumes is reachable from the SDK:

| Design need | Verified SDK surface |
| --- | --- |
| Send a prompt, stream a response | `session.prompt(text, opts)`, `session.subscribe(listener)` |
| Streamed text | event `message_update` → `assistantMessageEvent.type === "text_delta"` |
| Streamed reasoning (FR-010) | event `message_update` → `assistantMessageEvent.type === "thinking_delta"` |
| Tool lifecycle | events `tool_execution_start` / `_update` / `_end` |
| Agent lifecycle | events `agent_start`, `turn_start`, `turn_end`, `agent_end`, `agent_settled` |
| Tool-call id for idempotency (FR-040) | `defineTool({ execute: async (toolCallId, params) => … })` — the id is the first argument |
| Custom document tools | `createAgentSession({ noTools: "all", customTools: [...] })` |
| Configurable session storage (design §34) | `SessionManager.create(cwd, sessionDir)`, `SessionManager.open(path, sessionDir)` |
| Branch a conversation | `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir)`, `sm.createBranchedSession(leafId)` |
| Read a closed conversation (FR-035/036) | `SessionManager.open(path)` → `getEntries()`, `getTree()`, `buildContextEntries()` |
| Inject a child summary into a parent (FR-034) | `session.sendCustomMessage({ customType, content, … }, { deliverAs: "nextTurn" })` |
| In-conversation prompt queuing (FR-015) | `session.steer(text)`, `session.followUp(text)`, `prompt(text, { streamingBehavior })` |
| Busy/idle state for Primary switching (FR-029) | `session.isStreaming`, `session.isIdle`, `session.waitForIdle()` |
| Restart recovery (FR-039) | `SessionManager.open(storedPath)` re-materialises a conversation from its JSONL |

**Alternatives considered**: A Pi *extension* (rejected — Constitution Principle VII forbids it
absent demonstrated necessity, and nothing above requires one; see R3). Pi's RPC / JSON-streaming
modes (rejected — they add a subprocess boundary and lose typed event objects for no gain, since
the backend is already Node).

**Environment/config surface** (design §34): `PI_CODING_AGENT_DIR` (config dir, default
`~/.pi/agent`), `PI_CODING_AGENT_SESSION_DIR` (session storage). The application will not rely on
process-level env vars — it passes `agentDir` and `sessionDir` explicitly per session so the
`PI_SESSION_STORAGE_PATH` setting from design §34 maps to an SDK argument.

---

## R2. "One Pi session with multiple branches" is not achievable as literally written

**Decision**: Model **one `AgentSession` (and therefore one Pi JSONL session file) per application
conversation**, all located in one per-document session directory. A branched conversation is
created with `SessionManager.forkFrom(parentSessionPath, …)` (equivalently
`parentSm.createBranchedSession(leafId)`), which extracts the parent's path-to-leaf into a **new**
file whose header records the parent session.

**Rationale**: This is the single most consequential research finding. `design.md` §21 states
"One document, one Pi session, multiple conversation branches". The verified API shows a Pi session
tree is a *navigational* structure, not a set of concurrently live threads:

- `sm.branch(entryId)` / `session.navigateTree(targetId)` **move the leaf** within one file. They
  relocate a single cursor; they do not yield two independently runnable conversations.
- `AgentSession` is explicitly single-threaded: `prompt()` throws while streaming unless given
  `streamingBehavior`, and `isStreaming` / `waitForIdle()` guard one run at a time.

FR-015 requires ≥3 conversations running **concurrently**, and FR-013 requires branches that stay
independently alive. One `AgentSession` cannot satisfy either. One session file per conversation
satisfies both, and `forkFrom` preserves exactly the semantics FR-012 asks for (the child inherits
the parent's context).

**Consequence for the constitution**: none. Principle II ("Pi owns agent conversations, accessed
only via the SDK") is fully preserved — the application stores only the session *file path* in its
own `conversation` row and never parses JSONL itself. What changes is a factual detail of
`design.md`, which the plan records as a deviation to reconcile.

**Alternatives considered**:
- One session file, serialise all conversations through it (rejected — violates FR-015, and
  interleaving unrelated branches in one leaf-cursor destroys per-conversation context).
- One session file per conversation *without* `forkFrom`, re-seeding context manually (rejected —
  loses parent context fidelity FR-012 requires, and duplicates work Pi already does correctly).

---

## R3. Can the agent be confined to the document without a Pi extension?

**Decision**: Yes. Create every session with `noTools: "all"` plus exactly two `customTools`:
`read_document` and `propose_document_edit`. Supply agent instructions through
`new DefaultResourceLoader({ …, systemPrompt })`.

**Rationale**: Two independent confirmations from the type declarations:
`CreateAgentSessionOptions.noTools?: "all" | "builtin"` disables the built-in `read`/`bash`/`edit`/
`write` tools (which would otherwise let an agent touch the real filesystem and bypass the edit
pipeline, violating Principle III), and `DefaultResourceLoaderOptions` accepts `systemPrompt` and
`appendSystemPrompt`. Together these give full control of tools and instructions through the SDK,
so Principle VII's "no Pi extension without demonstrated necessity" is satisfied — necessity is
**not** demonstrated, and the plan introduces no extension.

**Alternatives considered**: Keeping the built-in `edit`/`write` tools pointed at a scratch file and
diffing it (rejected — an agent writing to a file is a direct mutation outside the edit pipeline,
and the tool-call→proposal mapping Principle III mandates would become inferential rather than
exact). An extension-registered tool (rejected — `customTools` is sufficient, per Principle VII).

---

## R4. Automerge text merges never fail — so what is a "conflict"? (FR-031/FR-032)

**Decision**: Define reconciliation at the **application** layer with a deterministic anchored
find/replace algorithm. Automerge is used to *apply* the resolved edit, never to *detect* the
conflict.

A proposed edit is a list of operations `{ old_string, new_string }` (Pi's own `edit` tool uses the
same shape, so the model is already well-calibrated to produce it). Reconciling a proposal against
the current document text:

1. For each operation, count exact occurrences of `old_string` in the current text.
2. Exactly **1** occurrence → the anchor resolves to that offset.
3. **0** occurrences (the anchored text is gone) or **>1** occurrences (ambiguous) → **conflict**.
4. If any two resolved ranges overlap → **conflict**.
5. If every operation resolved and no ranges overlap → **clean**: apply all operations in one
   Automerge change via `Automerge.splice(doc, ["content"], offset, delLen, insert)`, processed in
   descending offset order so earlier offsets stay valid.

**Rationale**: The Automerge documentation is explicit that concurrent text edits always merge and
never produce a failed or conflicting state. Design §28's "merge fails" branch therefore has no
Automerge-level trigger; taken literally, the conflict path would be dead code and FR-032 would be
untestable. Anchoring gives a definition that is deterministic, unit-testable, and semantically
correct: a conflict is precisely "the text this edit was written against no longer exists uniquely".

This also collapses two requirements into one code path — an edit whose `source_revision` equals the
current revision is just the case where every anchor happens to resolve — so FR-031 and FR-025 share
implementation and the conflict path (FR-032) is exercised by ordinary tests. It satisfies SC-005
directly: an anchor that no longer matches can never silently overwrite a user's change, because
step 3 refuses to guess.

**Alternatives considered**:
- Line/offset-based edits from the proposal's source revision, rebased onto current (rejected —
  offsets from a stale revision are exactly the silent-corruption vector SC-005 forbids).
- Materialise a fork of the Automerge doc at `source_revision`, apply the edit there, then `merge()`
  (rejected — `merge()` always succeeds, so this produces plausible-looking interleaved garbage with
  no conflict signal; it is the failure mode SC-005 names).
- Fuzzy/whitespace-tolerant anchor matching (rejected for v1 — trades a clear conflict for a
  possibly-wrong application; the conflict path already recovers gracefully by asking the agent).

---

## R5. Automerge integration: core library or `automerge-repo`?

**Decision**: Core `@automerge/automerge@^3.4.1` only. The application implements its own
persistence (via the storage abstraction) and its own WebSocket sync frames.

**Rationale**: `@automerge/automerge-repo` has no stable release — its `latest` dist-tag points at
`2.6.0-alpha.3`, with the remaining published versions being `-alpha`/`-subduction`/`-authors`
pre-releases. Depending on a pre-release for the load-bearing document layer is unjustifiable.
Beyond stability, `automerge-repo` supplies its own storage adapters and sync protocol, which would
sit *beside* the abstracted storage layer the constitution's Technology Constraints require rather
than behind it — the repo would become a second persistence authority.

The core API covers everything needed: `from`, `load`, `save`, `saveIncremental`, `loadIncremental`,
`change`, `splice`, `getHeads`, `view`, `merge`, `getLastLocalChange`, `applyChanges`.

**Rationale for text mutation strategy**: manual editing sends CodeMirror change specs
(`{from, to, insert}`) to the backend, which replays them as `Automerge.splice` calls. This captures
user intent at keystroke granularity, which the Automerge docs identify as merging better than
`updateText`. `updateText` is reserved for one case: revision restore (FR-006), where only the
target text is known and it is correctly expressed as a diff against current.

**Alternatives considered**: `automerge-repo` with a custom `StorageAdapter` (rejected — pre-release
only, plus the dual-authority concern above). `@automerge/automerge-codemirror@0.2.0` (rejected —
pre-1.0, and it assumes a frontend-authoritative document, contradicting Principle I).

---

## R6. Backend HTTP/WebSocket framework

**Decision**: Fastify `^5.12.1` with `@fastify/websocket`.

**Rationale**: design §35 explicitly leaves this open. Fastify is TypeScript-first, has a
first-party WebSocket plugin (the design's `/events` channel is central, not incidental), and its
plugin encapsulation maps cleanly onto the service boundaries the constitution requires
(Document / Conversation / Edit / Pi / Event / Storage). Its JSON-schema route validation pairs
with the shared Zod contracts without a second validation layer.

**Alternatives considered**: Hono (rejected — leaner, but its WebSocket support is runtime-adapter
specific and the Node adapter is the least-exercised path). Express 5 (rejected — needs a separate
`ws` integration and has weaker TS ergonomics). Raw `node:http` (rejected — reimplements routing and
validation for no benefit).

---

## R7. Persistence layer

**Decision**: Node's built-in `node:sqlite` (`DatabaseSync`), behind a `StorageAdapter` interface.

**Rationale**: Verified available in the devcontainer's pinned Node 26.1.0
(`require('node:sqlite')` exports `DatabaseSync`, `StatementSync`, `Session`, `backup`). Using it
means **zero native compilation** in the Docker image — no `better-sqlite3` build toolchain, no
prebuilt-binary mismatch across architectures. The synchronous API is appropriate here: this is a
single-local-user application (spec Assumptions), and Automerge snapshot writes are small.

The constitution requires the abstraction regardless of engine, so all SQL lives behind
`StorageAdapter`; substituting PostgreSQL later touches only the adapter.

**Alternatives considered**: `better-sqlite3@13` (rejected — native build step in Docker for a
capability now in the runtime). `node-sqlite3-wasm` (rejected — WASM overhead with no portability
benefit over the built-in). An ORM such as Drizzle/Prisma (rejected — design §33 already specifies
concrete DDL; an ORM would add a schema-authority layer on top of the required abstraction).

---

## R8. Frontend editor component

**Decision**: CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`)
in a Vue 3.5 SFC wrapper.

**Rationale**: Three requirements decide this. FR-043 demands a high accessibility standard —
CodeMirror 6 was designed for screen-reader compatibility and keyboard operability, whereas Monaco's
accessibility story is weaker and requires an explicit accessibility mode. FR-011 needs precise
selection ranges to seed a branch — CM6's `EditorSelection` gives exact offsets that map directly
onto Automerge text offsets. FR-003/FR-007 need a change stream and undo history — CM6's
`ChangeSet`/`transaction` model is exactly the `{from, to, insert}` shape R5 sends to the backend,
and `@codemirror/commands` provides `history()`.

**Alternatives considered**: Monaco (rejected — heavier, weaker accessibility, editor model tuned for
code intelligence the feature does not need). A plain `<textarea>` (rejected — no reliable change
granularity, no extensible selection/decoration model for stale/diff affordances). A WYSIWYG
Markdown editor such as Milkdown/TipTap (rejected — the spec requires editing *raw Markdown source*
beside a rendered preview, FR-002).

---

## R9. Markdown rendering and sanitization (FR-008, Principle VI)

**Decision**: `markdown-it@^15` → pluggable renderer extensions (`mermaid@^11` for diagrams, inline
SVG passthrough) → `dompurify@^3.4` as the final gate, all behind one `SanitizerPort` interface.

**Rationale**: Principle VI requires that *everything* reaching the DOM passes an abstracted
sanitizer, and that new formats can be added without touching the document model. markdown-it's
plugin/renderer-rule architecture provides the extension seam; DOMPurify is the de-facto sanitizer
and — importantly — handles the SVG/MathML profiles this feature needs, since raw SVG (FR-008) is a
prime XSS vector.

The pipeline runs sanitization **last**, after Mermaid produces its SVG output, because Mermaid
generates SVG from untrusted diagram source — sanitizing only the Markdown would let Mermaid output
straight through. Streamed agent reasoning (design §25) goes through the same port.

**Alternatives considered**: `unified`/`remark`/`rehype` with `rehype-sanitize` (rejected — a
capable pipeline, but heavier and its schema-based sanitizer is more awkward to extend for SVG than
DOMPurify's profiles). Trusting Mermaid's own `securityLevel: "strict"` as the sole defence
(rejected — a single library's internal setting is not the abstracted layer Principle VI requires).
`isomorphic-dompurify` (rejected — rendering is client-side only; the extra JSDOM dependency is
unnecessary).

---

## R10. Diff presentation (FR-022)

**Decision**: `diff@^9` (jsdiff) `diffWordsWithSpace` / `diffLines`, rendered as a custom Vue
component.

**Rationale**: FR-022 requires *both* a full rendered preview and an added/removed view of the same
proposal. Producing the "after" text is trivial once a proposal reconciles (R4 yields the resolved
text without committing it), so the diff library only needs to compute presentation-level hunks.
jsdiff is dependency-free, and Pi itself already depends on `diff@8`, so the ecosystem alignment is
good.

**Alternatives considered**: `diff2html` (rejected — renders unified-diff strings into fixed markup;
FR-043 accessibility and the app's theming need component-level control). Rendering Automerge
history as the diff (rejected — CRDT ops are not the user-facing unit; design §7 separates them
explicitly).

---

## R11. Testing strategy

**Decision**: Vitest `^4.1` for unit + integration (backend services, reconciliation, sanitizer,
frontend components via `@vue/test-utils`); Playwright `^1.62` for end-to-end acceptance scenarios;
a `FakePiSession` test double implementing the subscribed subset of `AgentSession`.

**Rationale**: The constitution's Quality Gates require every user-facing behaviour to be
expressible as Given/When/Then, and the spec supplies ~40 such scenarios — they need a runner that
covers backend logic *and* real browser behaviour (streaming, reconnect, keyboard operability).
Vitest shares Vite config with the frontend, so one toolchain covers both packages.

The `FakePiSession` double is load-bearing, not incidental: the scenarios that matter most — staged
vs. auto-applied edits, conflict then replacement, disconnect while an agent works, duplicate
tool-call delivery — must be driven deterministically. Emitting synthetic `tool_execution_*` and
`message_update` events with chosen tool-call ids makes FR-032, FR-037 and FR-040 testable without a
live model. A small suite of contract tests runs against real Pi to confirm the double stays honest.

**Alternatives considered**: Jest (rejected — separate toolchain from Vite). Cypress (rejected —
Playwright's multi-context support is needed to test two connected clients syncing, FR-003).
Testing only through real Pi (rejected — non-deterministic and slow; cannot force a conflict).

---

## R12. Structured logging (FR-042)

**Decision**: `pino@^10` writing JSON lines to stdout, with a fixed field set
(`event`, `documentId`, `conversationId`, `revision`, `stagedEditId`, `piToolCallId`).

**Rationale**: FR-042 requires structured, consistent records on stdout with no persisted store.
pino is JSON-first and writes to stdout by default, which is exactly the stated scope — a queryable
store is explicitly out of scope, so nothing more is warranted. The application event stream
(design §24) supplies the vocabulary, so log `event` values reuse the same names as the persisted
`conversation_event.event_type` values, keeping one taxonomy rather than two.

**Alternatives considered**: `console.log` with a hand-rolled formatter (rejected — "structured and
consistent" invites drift without a library enforcing shape). Winston (rejected — heavier, and its
transport machinery targets the persisted destinations that are out of scope). OpenTelemetry
(rejected — v1 needs no traces or metrics backend).

---

## R13. Language and runtime versions

**Decision**: Node `26.1.0` (pinned by `.devcontainer/Dockerfile`, and the Docker runtime image),
TypeScript `^7.0` in `strict` mode, Vue `^3.5.41`, Vite for the frontend build. npm workspaces for
the monorepo.

**Rationale**: The devcontainer already pins `node:26.1.0-trixie`; matching it in the deployment
image removes a class of environment drift, and Node 26 is what makes `node:sqlite` (R7) available.
npm workspaces keep the shared contract types in one place without adding a separate monorepo tool,
since the constitution's boundaries only need three packages.

**Alternatives considered**: pnpm/Turborepo (rejected — extra tooling for three packages).
Deno/Bun (rejected — Pi and Automerge are Node-targeted, and the devcontainer is Node).

---

## Open risks carried into implementation

| Risk | Mitigation |
| --- | --- |
| Pi is pre-1.0 (`0.84.x`); SDK surface may shift between minors | Pin an exact version; confine all Pi calls to `PiService` so a breaking change is one file |
| TypeScript 7 is a recent major; some plugin ecosystems may lag | `strict` TS with no exotic features; fall back to TS 5.9 if a dependency blocks the build |
| Anchored reconciliation (R4) depends on the agent quoting `old_string` exactly | System prompt (R3) states the requirement; a non-matching anchor degrades to the conflict path, which is safe by construction |
| Mermaid is a large client bundle | Lazy-load the Mermaid renderer only when a diagram block is present |

---

## Sources

- [Pi Coding Agent SDK](https://pi.dev/docs/latest/sdk)
- [Pi session format](https://pi.dev/docs/latest/session-format)
- [Pi environment variables](https://pi.dev/docs/latest/environment-variables)
- [`@earendil-works/pi-coding-agent` on npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (type declarations of `0.84.3` inspected directly)
- [Automerge — Text](https://automerge.org/docs/reference/documents/text/)
- [Automerge JS API docs](https://automerge.org/automerge/api-docs/js/)
- [Migrating from Automerge 2 to Automerge 3](https://automerge.org/docs/guides/migrating-from-automerge-2-to-automerge-3/)
