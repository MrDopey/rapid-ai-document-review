/** The `{content: [...], details}` shape every tool's `execute` returns (contracts/agent-tools.md). */
export function textResult(text: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text }], details };
}

/**
 * Clamps `value` into `[min, max]`, returning an explanatory note (naming `label`) when clamping
 * actually changed the value, or no note when it did not.
 */
export function clampWithNote(
  value: number,
  min: number,
  max: number,
  label: string,
): { value: number; note?: string } {
  if (value > max) {
    return { value: max, note: `requested ${label} ${value}, clamped to ${max}` };
  }
  if (value < min) {
    return { value: min, note: `requested ${label} ${value}, clamped to ${min}` };
  }
  return { value };
}

/** Bound on how long a `web_search`/`web_fetch` outbound HTTP call may run before it fails as a
 *  timeout, mirroring `pi-service.ts`'s `resolveAgentTurnTimeoutMs` pattern. Overridable via
 *  `RADR_BE_TEST_WEB_TOOL_TIMEOUT_MS` — a test/tuning knob, not application-facing configuration
 *  (research.md R6). */
const DEFAULT_WEB_TOOL_TIMEOUT_MS = 8000;

export function resolveWebToolTimeoutMs(): number {
  const override = Number(process.env.RADR_BE_TEST_WEB_TOOL_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_WEB_TOOL_TIMEOUT_MS;
}
