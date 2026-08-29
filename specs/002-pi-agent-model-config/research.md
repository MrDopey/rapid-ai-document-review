# Phase 0 Research: Configurable Pi Agent Model

No `[NEEDS CLARIFICATION]` markers remain in the spec (see spec.md Assumptions), and the Technical
Context in plan.md has no open unknowns. This research resolves the implementation-level questions
needed to design Phase 1 (data-model/contracts/quickstart) correctly against the actual
`@earendil-works/pi-coding-agent` SDK surface already vendored in this repo.

## R1: How does `createAgentSession` accept an explicit model today?

- **Decision**: Pass a resolved `Model` object as the `model` option to `createAgentSession({ ..., model,
  modelRuntime, ... })`, obtained via `modelRuntime.getModel(provider, id)` (covers both built-in and
  `models.json`-defined custom models) rather than the package-level `getModel` from `@earendil-works/pi-ai`
  (which only sees built-ins, not custom models).
- **Rationale**: `docs/sdk.md` documents both `getModel("anthropic", "claude-opus-4-5")` (built-in only,
  no auth check) and `modelRuntime.getModel("my-provider", "my-model")` ("including custom models from
  models.json"). Since this feature's override must work uniformly whether the operator names a built-in
  or a custom model already defined in `models.json`, `modelRuntime.getModel()` is the only lookup that
  covers both. It also keeps model resolution and auth/credential resolution going through the same
  `ModelRuntime` instance `pi-service.ts` already constructs in `getModelRuntime()`.
- **Alternatives considered**:
  - `getModel()` from `@earendil-works/pi-ai` directly — rejected: misses custom `models.json` models,
    and doesn't naturally sit next to the existing `ModelRuntime` construction in `pi-service.ts`.
  - The SDK's `resolveCliModel({ cliModel, modelRuntime })` helper — designed for parsing a raw CLI-style
    string (`"anthropic/claude-opus-4-5:high"`) including a `--api-key` first-run bootstrap path; heavier
    than needed here since this app already has a discrete `provider` + `model` (+ optional
    `thinkingLevel`) shape after parsing the env var, and its own credential handling
    (`ModelRuntime.create({ authPath, modelsPath })`) is already in place before this call happens. Its
    string-format convention (`provider/model[:thinkingLevel]`) is still reused for `RADR_PI_AGENT_MODEL`'s
    value, for consistency with the SDK's own CLI/user-facing convention documented in `docs/sdk.md` and
    `docs/providers.md`, keeping any error messages and mental model consistent with how operators would
    configure the Pi CLI itself.

## R2: What happens if the named provider/model doesn't exist or has no usable credential?

- **Decision**: Treat "model not found via `modelRuntime.getModel()`" as a fail-fast configuration error,
  thrown the first time a session is created (inside `getOrCreateSession`/`getModelRuntime`), producing a
  message that names the invalid `RADR_PI_AGENT_MODEL` value and the fact that it came from that environment
  variable. Do NOT attempt to fall back to auto-resolution in this case — FR-006 explicitly requires
  failing fast rather than silently ignoring a bad override.
- **Rationale**: `modelRuntime.getModel(provider, id)` returns `undefined`/falsy rather than throwing when
  the model isn't registered (per `docs/sdk.md`'s "Find specific built-in model (doesn't check if API key
  exists)" and "Find any model by provider/id" examples) — the SDK itself does not check credential
  availability at that point (that's what `getAvailable()` / `checkAuth()` are for). A missing credential
  for an otherwise-valid model is left to the SDK's existing request-time failure path (same as today,
  auto-resolved models already surface a credential error when a call is actually attempted) — this
  feature does not need to duplicate `checkAuth()` calls to satisfy FR-006, since an unresolvable
  provider/model name is the one failure mode fully within this feature's control at config-parse time.
- **Alternatives considered**: Eagerly calling `modelRuntime.checkAuth(provider)` at startup for every
  possible override — rejected: `ModelRuntime.create(...)` is already lazy (only constructed on first
  session, in `getModelRuntime()`), and adding an eager credential check would change today's lazy
  startup behavior for a case (FR-006) that's satisfiable by validating the override string alone.

## R3: Where should `RADR_PI_AGENT_MODEL` be parsed, and what shape should it take in `Config`?

- **Decision**: Parse in `config.ts` next to the other `PI_*` env vars, storing the *raw* validated string
  (or `undefined`) on `Config` (e.g. `piAgentModel: string | undefined`) rather than eagerly splitting into
  provider/model there. Actual `provider`/`id`/`thinkingLevel` parsing and the `modelRuntime.getModel(...)`
  lookup happen in `pi-service.ts`, where `ModelRuntime` already lives — `config.ts` has no `ModelRuntime`
  and should stay a plain env-var reader (consistent with its current `readEnv`-only shape).
- **Rationale**: Mirrors the existing division of responsibility: `config.ts` only reads/validates
  environment shape (strings, numbers, booleans); `pi-service.ts` is where anything SDK-typed
  (`ModelRuntime`, `Model`) is constructed and validated (Constitution Principle II — it's the only module
  importing the SDK). Splitting `"provider/model[:thinkingLevel]"` in `pi-service.ts`, right before the
  `modelRuntime.getModel()` call, keeps the parsing and the lookup that can fail together in one place for
  a single clear error message (FR-006).
- **Alternatives considered**: Three separate env vars (`PI_AGENT_PROVIDER`, `RADR_PI_AGENT_MODEL_ID`,
  `PI_AGENT_THINKING_LEVEL`) — rejected: more surface area for the "one set, one not" partial-configuration
  edge case (spec User Story 1, Acceptance Scenario 2) than a single `provider/model[:thinkingLevel]`
  string, and diverges from the SDK's own established single-string convention
  (`resolveCliModel`'s `cliModel` format) that operators configuring Pi elsewhere would already recognize.

## R4: Precedence between `RADR_PI_AGENT_MODEL` and the existing `models.json`/session-restore behavior

- **Decision**: `RADR_PI_AGENT_MODEL`, when set and valid, always wins for every *newly created* session
  (`getOrCreateSession`'s "no cached session, no existing session file, or existing session file with no
  restorable model" paths all pass the same resolved `model` into `createAgentSession`). `models.json`
  remains exactly as important as it is today for two things this feature does not change: (a) defining
  *what* a custom `provider/model` name resolves to (so `RADR_PI_AGENT_MODEL=my-provider/my-model` still needs
  that model registered in `models.json` to resolve), and (b) governing auto-resolution when
  `RADR_PI_AGENT_MODEL` is unset (FR-003).
- **Rationale**: This matches spec FR-008's requirement for a documented, single precedence order:
  env override → `models.json`-defined custom models (as a *lookup source*, not a competing override) →
  SDK default/last-used-model auto-resolution. It also matches how `createAgentSession`'s own
  `modelFallbackMessage` return value already communicates "couldn't restore the session's previous model"
  — passing an explicit `model` short-circuits that restoration path entirely and deterministically,
  which is the intended "pin it" behavior from User Story 1.
- **Alternatives considered**: Only applying `RADR_PI_AGENT_MODEL` when a session has no prior model
  history (i.e., letting a restored session's own remembered model take precedence over the env override)
  — rejected: contradicts User Story 1 Acceptance Scenario 1's plain reading ("every new agent
  conversation" uses the configured model), and would make the override's effect depend on
  per-conversation history, which is exactly the unpredictability FR-001 exists to remove. (FR-007 already
  scopes this correctly: only *already open/in-progress* conversations — i.e. sessions already cached
  in-process — are unaffected until restart; a conversation's Pi session *file* existing on disk from a
  previous process is not the same as an in-progress conversation, and does not exempt it from the
  override on the next `getOrCreateSession` call for it in a new process.)

## R5: Fake-session mode interaction

- **Decision**: `FakeAgentSession`/`config.piFakeSessions` path is untouched — `RADR_PI_AGENT_MODEL` parsing
  and resolution only happens on the real-SDK branch of `getOrCreateSession` (after the
  `config.piFakeSessions` early return), so it has no effect at all when fake sessions are enabled,
  satisfying FR-004 by construction rather than by an explicit extra check.
- **Rationale**: Simplest way to guarantee FR-004; no behavior branch needs to "know about" the override
  to ignore it correctly.
- **Alternatives considered**: Parsing/validating `RADR_PI_AGENT_MODEL` unconditionally at config-load time
  (even under fake sessions) so a misconfiguration is caught in CI regardless of mode — rejected: would
  make `PI_FAKE_SESSIONS=1` test runs (which set no real credentials) newly fail on an override meant only
  for live-model configurations, which is itself a backward-compatibility risk for the many existing
  fake-session tests (SC-002).
