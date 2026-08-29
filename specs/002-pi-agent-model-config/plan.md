# Implementation Plan: Configurable Pi Agent Model

**Branch**: `002-pi-agent-model-config` | **Date**: 2026-08-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-pi-agent-model-config/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Today `PiService.getModelRuntime()` (`app/backend/src/pi/pi-service.ts`) constructs a `ModelRuntime`
and `createAgentSession(...)` is called with no `model` option, so the Pi Coding Agent SDK always
auto-resolves the model (prior session model, else provider default) — there is no deployment-level way
to pin it. This feature adds an optional `RADR_PI_AGENT_MODEL` (`provider/model[:thinkingLevel]`) environment
variable, read in `config.ts` alongside the existing Pi-related env vars, resolved once via
`ModelRuntime.getModel()`/`resolveCliModel()`-style lookup and passed as `model` into
`createAgentSession(...)`. When unset (or blank), behavior is unchanged. Resolution failures (unknown
provider/model, no credential) fail fast with a clear error at first-session-creation time rather than
silently falling back. `models.json`/`auth.json` continue to work unchanged underneath; documentation is
updated to state precedence: `RADR_PI_AGENT_MODEL` env override > per-agent-directory `models.json` custom
model definitions > SDK default/last-used-model auto-resolution.

## Technical Context

**Language/Version**: TypeScript (Node.js, `--experimental-strip-types`, no build step in dev)

**Primary Dependencies**: `@earendil-works/pi-coding-agent` (already the sole SDK dependency for Pi
integration, per Constitution Principle II); its `ModelRuntime`/`getModel`/model-resolution helpers.

**Storage**: N/A — configuration is process environment variables plus the existing
`PI_CODING_AGENT_DIR/{auth.json,models.json}` files; no new persistent storage.

**Testing**: Vitest (`app/backend/tests/unit`, `tests/contract` — contract tests run with
`PI_FAKE_SESSIONS=1`/`FakeAgentSession`, so they exercise config parsing and error paths, not real model
resolution; `tests/contract/live-pi.test.ts` is the only suite that talks to a real model/credential).

**Target Platform**: Linux server, self-hosted Docker deployment (existing `docker/docker-compose.yml`).

**Project Type**: Web application backend (single Node/TypeScript backend package within the existing
frontend+backend monorepo) — this feature only touches `app/backend`.

**Performance Goals**: N/A — one-time config parse and model lookup at session-creation time; no
measurable throughput/latency requirement beyond "does not add a perceptible delay to first agent message."

**Constraints**: MUST NOT change behavior for any deployment/test run that sets no override (spec
FR-003, SC-002); MUST NOT affect `PI_FAKE_SESSIONS` mode (FR-004); MUST fail fast with an actionable error
rather than silently falling back on an invalid override (FR-006).

**Scale/Scope**: Small, additive change confined to `app/backend/src/config.ts` and
`app/backend/src/pi/pi-service.ts`, plus README documentation. No new endpoints, no schema/storage
changes, no frontend changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle II (Pi Owns Agent Conversations)**: This feature only selects *which* SDK-supported `model`
  value is handed to `createAgentSession(...)` — it uses the SDK's own public `ModelRuntime`/`getModel`
  resolution API, never reads/writes Pi's session storage format, and does not reimplement any model
  interaction itself. **PASS.**
- **Principle V (Configurable Limits Are Enforced, Not Advisory)**: Not a "limit" in the sense this
  principle addresses (branching depth, editing depth, concurrent agents, debounce), but the same spirit
  applies to FR-006/FR-002: once `RADR_PI_AGENT_MODEL` is set, it MUST actually govern every new session, not
  be silently bypassed. Design honors this by resolving and validating the override inside
  `getModelRuntime()`/session creation, the single chokepoint all sessions already go through. **PASS.**
- **Principle VII (No Pi Extension Without Demonstrated Necessity)**: No Pi extension is introduced; the
  feature uses only public SDK/env configuration. **PASS.**
- No other principle (I, III, IV, VI) is implicated — this feature does not touch document state, edit
  proposals, CRDT/revisions, or rendering.

No violations. Complexity Tracking section is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-pi-agent-model-config/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/backend/
├── src/
│   ├── config.ts               # add RADR_PI_AGENT_MODEL parsing (Config.piAgentModel)
│   └── pi/
│       └── pi-service.ts       # resolve + pass `model` into createAgentSession(...)
└── tests/
    ├── unit/                   # config parsing tests for RADR_PI_AGENT_MODEL (new/updated)
    └── contract/                # PiService session-creation behavior with/without override

README.md                        # document RADR_PI_AGENT_MODEL and precedence vs. models.json
```

**Structure Decision**: No new packages, directories, or services. This feature is a small, additive
change to the existing `app/backend` config-loading and `PiService` session-creation path, following
the same module boundaries already established (Constitution: `pi-service.ts` remains the only module
importing the Pi SDK).

## Complexity Tracking

*(No Constitution Check violations — section not needed.)*
