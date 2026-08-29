# Phase 1 Data Model: Configurable Pi Agent Model

This feature adds no persistent storage, no database schema, and no document/domain entities. It adds
one piece of process configuration and the derived, in-memory value resolved from it.

## Model Override (configuration value)

Represents the operator's optional choice of a specific model/provider for all newly created agent
sessions in this process.

| Field | Type | Source | Notes |
|---|---|---|---|
| `piAgentModel` | `string \| undefined` | `Config` (`app/backend/src/config.ts`), from env var `RADR_PI_AGENT_MODEL` | Raw, unparsed. `undefined` (or blank/whitespace-only, per FR-005) means "no override" — current auto-resolution behavior applies. |

**Format** (when set): `provider/model[:thinkingLevel]`, e.g. `anthropic/claude-opus-4-5` or
`anthropic/claude-opus-4-5:high`. Matches the SDK's own CLI-model string convention (research.md R1/R3) so
operators already familiar with configuring Pi elsewhere recognize the shape.

**Validation rules** (FR-002, FR-005, FR-006):
- Blank/whitespace-only → treated identically to unset (no error, falls back to auto-resolution).
- Missing `/` separator, or a `provider`/`model` segment that resolves to no registered model via
  `modelRuntime.getModel(provider, id)` → a fail-fast, actionable error identifying the offending
  `RADR_PI_AGENT_MODEL` value and that it came from that environment variable. Raised the first time a real
  (non-fake) session is created in the process, not at module-load time (`ModelRuntime` itself is
  constructed lazily today — see `pi-service.ts` `getModelRuntime()`).
- An unrecognized `thinkingLevel` segment (if present) is validated the same way — same fail-fast error
  behavior, not a silent ignore.

## Resolved Model (derived, in-memory only)

Represents the actual `Model` (as defined by the SDK, `@earendil-works/pi-ai`'s `Model` type) that gets
passed into `createAgentSession({ model, ... })` for a new session.

| Field | Type | Derivation |
|---|---|---|
| `model` | SDK `Model` object, or `undefined` | `undefined` when `piAgentModel` is unset/blank (SDK auto-resolves, unchanged); otherwise `modelRuntime.getModel(provider, id)` result for the parsed override, with `thinkingLevel` applied per the SDK's existing per-call convention (research.md R1). |

This value is never persisted by this feature — it is recomputed each time `getModelRuntime()`'s resolved
`ModelRuntime` is used to create a new session in the process's lifetime, and lives only as long as the
process (consistent with FR-007: changing `RADR_PI_AGENT_MODEL` requires a restart, since `Config` and
`ModelRuntime` are constructed once at process start).

## Relationships

- **Model Override → `ModelRuntime`** (existing, `pi-service.ts`): the override is resolved *through* the
  same `ModelRuntime` instance already responsible for `auth.json`/`models.json`-based credential and
  custom-model resolution (research.md R1, R4) — it is not a parallel/independent resolution path.
- **Model Override → Conversation session** (existing `ConversationRow`/`AgentSessionLike`, unchanged
  shape): the resolved `Model` is passed into `createAgentSession(...)` per new session
  (`getOrCreateSession` in `pi-service.ts`); no field is added to `ConversationRow` or any stored
  conversation record — which model a past session used remains something only Pi's own session file
  records (Constitution Principle II: the application does not duplicate Pi's session-owned state).

No state transitions, no new stored entity, no schema/migration changes.
