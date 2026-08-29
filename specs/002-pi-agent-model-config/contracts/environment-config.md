# Contract: `RADR_PI_AGENT_MODEL` Environment Configuration

This feature's only external interface is a process environment variable (this backend has no HTTP/WS
surface change — see spec.md; existing contracts in `specs/001-ai-document-review/contracts/` are
unaffected). This document is the contract an operator or CI pipeline can rely on.

## Variable

| Name | Required | Format | Default |
|---|---|---|---|
| `RADR_PI_AGENT_MODEL` | No | `provider/model` or `provider/model:thinkingLevel` | unset (current SDK auto-resolution behavior) |

Examples: `anthropic/claude-opus-4-5`, `anthropic/claude-opus-4-5:high`.

## Behavior contract

1. **Unset, empty, or whitespace-only** → identical to today's behavior: the Pi Coding Agent SDK
   auto-resolves the model per conversation (restores a session's previously-used model if present, else
   the SDK/provider default). No error, no warning. (FR-003, FR-005)
2. **Set to a valid `provider/model[:thinkingLevel]`** naming a model resolvable via the configured
   `ModelRuntime` (built-in, or custom via the existing `models.json` in `PI_CODING_AGENT_DIR`) → every
   newly created agent session in this process uses that exact model, regardless of what a session's own
   history would otherwise have restored. (FR-001, FR-002, User Story 1)
3. **Set to a value that does not parse as `provider/model[:thinkingLevel]`, or names a
   provider/model that `ModelRuntime` does not resolve** → the first attempt to create a real agent
   session in the process throws/fails with an error message that:
   - Identifies the literal invalid value.
   - Identifies `RADR_PI_AGENT_MODEL` as the source of the problem.
   - Does not silently fall back to auto-resolution. (FR-006)
4. **`PI_FAKE_SESSIONS=1`** → `RADR_PI_AGENT_MODEL` is never read/applied in this mode; fake sessions behave
   identically whether or not it is set. (FR-004)
5. **Changed at runtime** (env var edited without restarting the process) → has no effect until the
   process restarts; already-cached in-process sessions are unaffected either way. (FR-007)

## Precedence (documented for operators — FR-008)

```
RADR_PI_AGENT_MODEL (env override, this feature)
  > models.json custom model definitions (existing, PI_CODING_AGENT_DIR)   — as a name→model lookup
    source only, consulted whether or not RADR_PI_AGENT_MODEL is set
      > SDK default-per-provider / last-used-model auto-resolution (existing, unchanged)
```

`models.json` is not "overridden" by `RADR_PI_AGENT_MODEL` — it is the same lookup table `RADR_PI_AGENT_MODEL`'s
`provider/model` value is resolved against when naming a custom model. The two are complementary, not
competing, mechanisms.

## Non-goals (out of scope for this contract)

- No new HTTP endpoint or WebSocket event to read/change the active model at runtime — this is a
  deployment-time (process-start) configuration only.
- No validation of the named provider's credential validity at config-parse time (research.md R2) — a
  syntactically/registry-valid model name with no usable credential fails the same way an
  auto-resolved model with no credential already fails today, unchanged by this feature.
