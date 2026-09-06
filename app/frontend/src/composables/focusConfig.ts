import { computed, type Ref } from 'vue';
import { resolveEnvInt } from './envConfig.ts';

/**
 * 005-canvas-conversation-threads (multi-focus overlay): how many conversations may be
 * simultaneously "focused" (each rendering its own full-detail overlay panel in App.vue).
 *
 * Configurable via `VITE_RADR_MAX_FOCUSED_CONVERSATIONS` — this is the first `VITE_`-prefixed
 * (i.e. client-readable) env var anywhere in this repo; Vite only ever inlines `import.meta.env`
 * values at build time, so it's read once here at module scope rather than re-read reactively
 * (mirrors how App.vue already reads other module-level constants like `DEFAULT_PREVIEW_FR`).
 */
export const DEFAULT_MAX_FOCUSED_CONVERSATIONS = 3;

/** Pure so it's directly unit-testable without touching `import.meta.env` — parses `raw` the same
 *  way for every caller: unset/empty/non-positive-integer all fall back to the default. */
export function resolveMaxFocusedConversations(raw: string | undefined): number {
  return resolveEnvInt(raw, DEFAULT_MAX_FOCUSED_CONVERSATIONS, { min: 1 });
}

/** Read once at module load (see doc comment above) — every `useFocusCap` call shares this same
 *  resolved value rather than re-parsing `import.meta.env` on every use. */
export const maxFocusedConversationsFromEnv = resolveMaxFocusedConversations(
  import.meta.env.VITE_RADR_MAX_FOCUSED_CONVERSATIONS,
);

/**
 * Live cap = clamp(envMax, [1, viewportFitCount]) — never less than 1 (there's always room for at
 * least the panel the user is actively interacting with), never more than however many panels
 * actually fit side-by-side in the available width (`viewportFitCount`, derived by the caller from
 * its own container's measured width — see App.vue's `.panes` `ResizeObserver`).
 */
export function useFocusCap(viewportFitCount: Ref<number>) {
  return computed(() =>
    Math.max(1, Math.min(maxFocusedConversationsFromEnv, viewportFitCount.value)),
  );
}

/**
 * Shared disabled-reason tooltip for every "branch (and auto-focus the result)" entry point —
 * toolbar "Branch (New)"/"Branch (Main)" (EditorComponent.vue), the sidebar "Branch this
 * conversation" (ConversationThreadBox.vue), and the focus-view "Branch" (ConversationView.vue) —
 * once the live focus cap is reached with no free slot to auto-focus the new branch into. Wording
 * adapted from ConversationThreadBox.vue's own pre-existing Focus-button cap tooltip ("Un-focus
 * another conversation first (max N)") so the two related messages read as one system.
 */
export function focusCapBranchTooltip(maxFocused: number): string {
  return `Un-focus another conversation first (max ${maxFocused}) to branch`;
}
