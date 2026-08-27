# Contract: Agent Tools (Pi integration surface)

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Related**: [http-api.md](./http-api.md), [websocket-events.md](./websocket-events.md), [data-model.md](../data-model.md), [research.md](../research.md) R1/R3/R4

This is the contract between the application and the Pi agent. It is the load-bearing boundary for
Constitution Principle III — *agent edits are proposals, not direct writes* — because the tool
surface is the only thing an agent can act through. It is registered via the Pi SDK's
`customTools` option; no Pi extension is involved (Principle VII, research R3).

---

## Tool availability

Every conversation's `AgentSession` is created with **all built-in tools disabled**:

```ts
createAgentSession({
  noTools: "all",                                  // disables read, bash, edit, write
  customTools: [readDocumentTool, proposeDocumentEditTool],
  sessionManager,                                  // per-conversation JSONL file
  resourceLoader,                                  // carries the system prompt
  modelRuntime,
})
```

`noTools: "all"` is not a convenience — it is a requirement. The built-in `edit`/`write` tools mutate
real files, which would be a document mutation outside the proposal pipeline; `bash` would be an
arbitrary-code escape from a localhost service. The agent's entire capability surface is the two
tools below, and v1 adds no others (constitution v1 non-goals).

---

## Tool: `read_document`

Read the document the conversation is scoped to. The agent has no filesystem access, so this is its
only way to see content.

**Parameters**

```ts
Type.Object({
  from_line: Type.Optional(Type.Integer({ minimum: 1,
    description: "1-based first line to return. Omit to read from the beginning." })),
  to_line: Type.Optional(Type.Integer({ minimum: 1,
    description: "1-based last line to return, inclusive. Omit to read to the end." })),
})
```

**Result** — text content with line numbers, plus a header:

```text
Document: Quarterly Strategy
Revision: 17 (conversation context)
Lines 1-240 of 240

   1  # Quarterly Strategy
   2
   3  The introduction is...
```

**Semantics**

- Content is served from the conversation's **context revision**, not the live document. A stale
  conversation reads what it was given (FR-017); it sees the newer document only after an explicit
  refresh (FR-018). This keeps a conversation's view of the world internally consistent — an agent
  never sees text change mid-reasoning.
- Line numbers are for the agent's navigation only. They are never used to locate an edit; that is
  what anchors are for (see below).
- Available to every conversation regardless of depth — reading is not an edit workflow, so
  `max_editing_depth` does not apply (FR-026 restricts *proposal* participation).
- Invalid parameters are handled without throwing: `from_line > to_line` returns an explanatory
  text result ("from_line must be less than or equal to to_line") instead of content; a line number
  beyond the document's length is clamped to the nearest valid bound and the result header notes the
  clamp (e.g. "requested to line 500, clamped to 240").
- The exact text layout of the result (line-numbered content plus header) is an **implementation
  detail**, not a versioned part of this contract — it is model-facing prose the agent parses
  informally, and may be reworded without a contract amendment as long as it remains line-numbered
  and includes the header fields shown above.

---

## Tool: `propose_document_edit`

Propose an atomic change to the document. This does **not** modify the document; it creates one
`staged_edit` row (Principle III, FR-019).

**Parameters**

```ts
Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 200,
    description: "One-line description of this change, shown to the user in the review UI." }),
  operations: Type.Array(
    Type.Object({
      old_string: Type.String({ minLength: 1,
        description: "Exact existing text to replace, copied verbatim from the document, "
          + "including whitespace. Must appear EXACTLY ONCE in the document — include "
          + "surrounding context to disambiguate if the text is repeated." }),
      new_string: Type.String({
        description: "Replacement text. Use an empty string to delete." }),
    }),
    { minItems: 1, maxItems: 50,
      description: "One or more replacements. They may target disjoint parts of the document; "
        + "they are reviewed and accepted or dropped together as a single proposal." },
  ),
})
```

**Result — accepted as a proposal (non-Primary conversation)**

```text
Proposal staged for review (2 operations).
The document is unchanged until the user accepts it.
Proposal id: edit_01H...
```

**Result — auto-applied (Primary conversation, clean reconciliation)**

```text
Applied to the document as revision 22 (2 operations).
```

**Result — conflict (either path)**

```text
This proposal could not be applied: the text it targets has changed.

Operation 1: the `old_string` was not found in the current document.
Operation 2: applied cleanly (no action needed in isolation).

Current text of the affected region:
   87  This introduction now reads differently...
   88  ...

Propose a replacement edit against the current document text shown above.
```

**Semantics**

- **Atomicity** (FR-020): one tool call → one proposal, accepted or dropped as a whole. Multiple
  `operations` may touch disjoint regions; partial acceptance is out of scope for v1.
- **Idempotency** (FR-040): the proposal is keyed on `(conversation_id, pi_tool_call_id)`, and the
  tool-call id is the first argument Pi passes to `execute`. A redelivered tool call — after a
  reconnect or a retry — returns the *existing* proposal's result instead of creating or applying a
  second one.
- **Primary vs. staged** (FR-021, FR-027): identical tool, identical validation, identical
  reconciliation. Primary differs only in that the application applies the proposal immediately
  instead of waiting for a user verdict. Even on the Primary path a `staged_edit` row and a
  `staged_edit_created` event exist first, which is what makes SC-004's "0% applied silently" claim
  auditable.
- **Depth limit** (FR-026): a conversation deeper than `max_editing_depth` has this tool rejected at
  execution time with an explanatory error result, and the tool is omitted from its registered tool
  list so the model is not invited to try. These two mechanisms are sequential defense layers, not
  redundant: omission from the tool list is the primary prevention, decided when the `AgentSession`
  is created; the execution-time check is a backstop for the edge case where `max_editing_depth` is
  lowered (FR-041, takes effect immediately) *after* a session already has the tool registered — the
  session's tool list is fixed at creation, so only the execution-time check catches that case. The
  conversation continues to chat and read normally either way.
- **Anchors, not offsets** (research R4): the application locates each `old_string` in the *current*
  document at apply time. Exactly one occurrence and no overlap between resolved ranges → clean
  apply. Zero occurrences, multiple occurrences, or overlapping ranges → conflict. Offsets from the
  proposal's source revision are never trusted, which is precisely what prevents the silent
  overwrite SC-005 forbids.
- **Conflict recovery** (FR-032): a conflict marks the original `superseded` and returns the conflict
  detail *to the agent* as the tool result, together with the current text of the affected regions.
  The agent's next `propose_document_edit` call is a normal proposal — the agent does **not** supply
  `supersedes_id`; the server sets it automatically by recognising that the conversation is in a
  replacement flow (it just delivered conflict detail) and linking the new `staged_edit` row to the
  superseded original via `supersedes_id`. The agent never resolves the conflict against the document
  itself (Principle III), and a replacement that goes stale in turn re-enters this same path.
  The plain-text conflict message shown above is a human-readable rendering of the canonical
  `ConflictDetail` object (`http-api.md` §Shared types) — the same structured `operations` data the
  HTTP preview/apply responses and the `staged_edit_superseded` event carry, never an independently
  defined shape.

---

## System prompt contract

Supplied through `new DefaultResourceLoader({ …, systemPrompt })` (research R3). It must establish:

1. **Role** — the agent reviews and improves one Markdown document, discussing it with the user.
2. **Tool discipline** — `read_document` before proposing; there is no filesystem and no shell.
3. **Anchor discipline** — the single highest-value instruction: `old_string` must be copied verbatim
   from `read_document` output (never retyped, never reflowed), and must be extended with surrounding
   context until it is unique. Anchor quality is what determines whether the clean path or the
   conflict path is taken.
4. **Proposal etiquette** — one logical change per proposal with a specific `summary`; do not restate
   the whole document; do not re-propose an unchanged region.
5. **Review authority** — edits are proposals the user reviews and may drop, and that is normal.
6. **Branch context** — for a branched conversation, the seeded excerpt is the focus, but the
   surrounding document is context; proposals may extend beyond the excerpt when justified.

Per-conversation seed context (FR-012) is delivered as the branch's first message, not as system
prompt, so it appears in the transcript the user reads and in the parent-fold summary (FR-034).

The six numbered obligations above are the versioned, contractual part of the system prompt: a
change to any of them is a contract amendment (update this document's date and note it in
`research.md`). The exact prose wording used to express them is an implementation detail, free to be
refined without a contract change, as long as all six obligations remain conveyed.

---

## Event bridge contract

`PiService` translates Pi's `AgentSessionEvent` stream into the application event stream. This
mapping is the only place Pi types cross into the rest of the backend (Principle II).

| Pi event | Application event |
| --- | --- |
| `agent_start` | `agent_started`, `conversation_status_changed` → `working` |
| `message_start` | `message_started` |
| `message_update` / `text_delta` | `text_delta` (ephemeral) |
| `message_update` / `thinking_delta` | `thinking_delta` (ephemeral, only when `thinkingVisible`) |
| `message_end` | `message_completed` |
| `tool_execution_start` | `tool_started` |
| `tool_execution_update` | `tool_output_delta` (ephemeral) |
| `tool_execution_end` | `tool_completed` (with `stagedEditId` when applicable) |
| `agent_end` / `agent_settled` | `agent_completed`, `conversation_status_changed` → `idle` |
| error surfaced from `prompt()`/stream | `agent_error`, `conversation_status_changed` → `errored` |
| `compaction_start` / `compaction_end` | not surfaced — Pi's internal context management is not application state (Principle II) |
| `queue_update` | not surfaced — Pi's in-conversation steer/follow-up queue is distinct from the application's `max_concurrent_agents` queue |

This table is exhaustive over the Pi SDK's `AgentSessionEvent` union as of the pinned SDK version
(`@earendil-works/pi-coding-agent@0.84.3`, `plan.md`); a future SDK upgrade that adds a new event
type does not surface it until this contract is amended to add a mapping row.

Concurrency (FR-015) is enforced by the application's own limiter around `session.prompt()`, not by
Pi: the limiter counts conversations with an in-flight run and emits `agent_queued` /
`agent_dequeued`. Pi's `steer`/`followUp` handles queuing *within* one conversation, which is a
different concern.

**Late and orphaned events**: a Pi event that arrives for a run whose `agent_completed`/
`agent_settled` frame has already been emitted (e.g. a delayed `tool_execution_end`) is logged at
`warn` level and discarded, not translated into an application event — the run is closed and cannot
retroactively gain a proposal or a status change. Likewise, an event for a session id the application
no longer considers active (notably after a restart, since FR-039a does not resume in-flight runs) is
logged at `warn` and discarded: the application never reconstructs or re-attaches to an orphaned Pi
session after restart.

---

## Contract test expectations

Driven by the `FakePiSession` double (research R11), which emits synthetic Pi events with chosen
tool-call ids.

1. A `propose_document_edit` call in a non-Primary conversation creates a `pending` proposal and
   leaves the document byte-identical (FR-021, SC-004).
2. The same call in the Primary conversation applies the document, creates a revision, and leaves no
   pending proposal — but still emits `staged_edit_created` first (FR-027).
3. Redelivering an identical tool-call id yields one proposal and one application, not two (FR-040).
4. Anchor resolution: unique match → clean; zero matches → `not_found`; two matches → `ambiguous`;
   overlapping resolved ranges → `overlapping`.
5. A conflict marks the original `superseded`, returns conflict detail to the agent, and the
   agent's next proposal carries `supersedes_id` (FR-032).
6. A conflict on the **Primary** path also supersedes and stages a replacement for review, rather
   than auto-applying it (FR-027 second half, spec US5 scenario 5).
7. A conversation at `branch_depth > max_editing_depth` is not offered `propose_document_edit`, and a
   forced call returns an explanatory error while ordinary chat still works (FR-026).
8. `read_document` returns the conversation's context revision, not the live document, for a stale
   conversation (FR-017); after `refresh-send` it returns the current one (FR-018).
9. No built-in Pi tool (`read`, `bash`, `edit`, `write`) is present in `session.getActiveToolNames()`
   for any conversation (Principle III).
10. A live-Pi contract test (opt-in, tagged) asserts the real SDK still emits every event type the
    bridge table depends on, so the double cannot drift silently. Opt-in mechanism: tagged with a
    dedicated Vitest project/tag (e.g. `test.live-pi`) excluded from the default `npm run test:*`
    scripts, run only in a separate CI job (`test:contract:live`) gated on a `PI_LIVE_TEST=1`
    environment variable and real model credentials. That job's failures are advisory (reported, not
    a required check) since they depend on external model availability and incur real usage cost.
