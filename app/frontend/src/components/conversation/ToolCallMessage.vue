<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import type { ConversationMessageState } from '../../stores/conversations.js';
import { useClampToggle } from '../../composables/clampToggle.js';

/**
 * A tool-call-carrier assistant message (`message.isToolCallCarrier` — event-bridge.ts's
 * `message_end` handling), rendered as its own distinct card rather than folded into
 * `MessageBubble.vue`'s generic "Assistant" bubble chrome. This promotes the pre-existing inner
 * `.tool-call` box (contracts/frontend-display.md's color-coding contract: info-blue background,
 * monospace args/result, danger-red on failure) to BE the outer card itself — one card per carrier
 * message, showing every one of that carrier's `toolCalls[]` as its own row.
 *
 * `MessageBubble.vue` still owns the root visibility gate (whether this carrier renders at all —
 * `!message.isToolCallCarrier || settings.thinkingVisible || hasToolCalls`) and delegates to this
 * component once that gate passes.
 *
 * Known pre-existing limitation, out of scope here: tool-call detail only populates after
 * `loadDetail`/a remount, not live via `tool_started`/`tool_completed` WS events
 * (`stores/conversations.ts`/`stores/thread.ts` don't surface those to this store's shape yet).
 */
const props = withDefaults(
  defineProps<{ message: ConversationMessageState; expanded?: boolean }>(),
  {
    expanded: true,
  },
);
const emit = defineEmits<{ (e: 'update:expanded', value: boolean): void }>();
const settings = useSettingsStore();

// This card has no single "primary" clampable region of its own (unlike MessageBubble.vue's
// message text) — every tool call is a "secondary" clampable region, each independently
// toggleable, but all cascading together whenever the `expanded` prop changes (a parent's bulk
// "Expand all"/"Collapse all", FR-009). A dummy id that never gets an element registered under it
// serves as the primary for `useClampToggle`'s bookkeeping.
const PRIMARY_ID = '__tool_call_carrier__';
const clamp = useClampToggle(
  PRIMARY_ID,
  () => props.expanded,
  (value) => emit('update:expanded', value),
);

watch(
  () => props.message.toolCalls,
  () => void nextTick(clamp.recompute),
  { immediate: true, flush: 'post', deep: true },
);

// contracts/frontend-display.md: `args`/`resultText` are stored raw/compact — pretty-printing is
// purely a render-time concern, never done before persistence.
function formatToolArgs(args: unknown): string {
  return JSON.stringify(args, null, 2) ?? String(args);
}
</script>

<template>
  <!-- `data-message-id`: `composables/messageScroll.ts`'s `scrollMessageTopIntoView` depends on
       this selector to find this exact card's DOM node by message id (Thread mode's focus-jump
       hotkeys, Ctrl+Alt+J/K). `data-role="assistant"` matches `MessageBubble.vue`'s own bubbles so
       any role-based selector still finds this card. `data-message-kind="tool-call"` distinguishes
       this card from a plain `.message-bubble` for tests/future styling. -->
  <article
    class="tool-call-message"
    data-role="assistant"
    data-message-kind="tool-call"
    :data-message-id="message.id"
    :aria-busy="message.streaming"
  >
    <p
      v-if="(message.toolCalls?.length ?? 0) === 0 && settings.thinkingVisible"
      class="tool-call-carrier-note"
    >
      Tool call — this segment carries no reply text of its own.
    </p>

    <!-- Tool-call detail (contracts/frontend-display.md): a factual record of what the agent did,
         not gated by "Show reasoning" at all (Research Decision 5) — renders whenever this message
         has any `toolCalls`, regardless of the toggle. Plain text interpolation only (no v-html):
         `args`/`resultText`/`failureReason` may contain untrusted content from a fetched page or
         search snippet (Constitution Principle VI). Expand/collapse per call, same `clamp`
         controller (and CLAMP_HEIGHT_PX) `MessageBubble.vue`'s own message text uses. -->
    <div
      v-for="call in message.toolCalls ?? []"
      :key="call.toolCallId"
      class="tool-call"
      :class="{ 'tool-call-error': call.failureReason }"
    >
      <div class="tool-call-header">
        <div class="tool-call-name">{{ call.name }}</div>
        <button
          v-if="clamp.isOverflowing(call.toolCallId)"
          type="button"
          class="expand-toggle-button"
          :aria-label="`${clamp.label(call.toolCallId)} of this tool call`"
          @click="clamp.toggle(call.toolCallId)"
        >
          {{ clamp.label(call.toolCallId) }}
        </button>
      </div>
      <div
        :ref="(el) => clamp.setEl(call.toolCallId, el as Element | null)"
        class="tool-call-body"
        :style="clamp.clampStyle(call.toolCallId)"
      >
        <pre class="tool-call-args">{{ formatToolArgs(call.args) }}</pre>
        <pre class="tool-call-result">{{ call.failureReason ?? call.resultText }}</pre>
      </div>
    </div>
  </article>
</template>

<style scoped>
.tool-call-message {
  margin-bottom: 0.5rem;
}
/* Debug-visible note for a tool-call-carrier segment shown while "Show reasoning" is on (see
   MessageBubble.vue's root `v-if`) — same muted, small-print treatment as `.reasoning` there, so it
   reads as internal/diagnostic content rather than a genuine reply. */
.tool-call-carrier-note {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  font-style: italic;
  opacity: 0.7;
}
/* contracts/frontend-display.md: informational/read-only agent activity gets its own dedicated
   token pair (`--info-*`), distinct from `--status-active-*`/`--queue-*`; a failed call reuses the
   existing `--danger-*` pair rather than introducing a second error color. This box is now the
   outer card itself (promoted from MessageBubble.vue's old inner block) rather than nested inside
   a generic gray/blue "Assistant" bubble. */
.tool-call {
  margin: 0 0 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  background: var(--info-bg, #eff6ff);
  border: 1px solid var(--info-border, #bfdbfe);
  color: var(--info-color, #1e3a8a);
}
.tool-call:last-child {
  margin-bottom: 0;
}
.tool-call.tool-call-error {
  background: var(--danger-bg, #fee2e2);
  border-color: var(--danger-color, #b3261e);
  color: var(--danger-color, #b3261e);
}
.tool-call-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}
.tool-call-name {
  font-weight: 600;
}
.tool-call-args,
.tool-call-result {
  margin: 0 0 0.25rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: monospace;
}
.tool-call-result:last-child,
.tool-call-args:last-child {
  margin-bottom: 0;
}
/* Expand/collapse (`clamp.clampStyle` above, script) toggles `max-height` between the clamp and
   this element's own measured height — animating that reflow, rather than snapping it instantly,
   is what keeps Thread mode's tree layout (`ThreadCard.vue`'s `.thread-branch-fork::before`/
   `::after` connector line+arrowhead) sliding smoothly to its new position alongside a toggled
   message instead of jumping there in one frame. Those connectors have no coordinates of their own
   to update on toggle — they're `position: absolute` at a fixed offset purely relative to their
   own (unrelated) `.thread-branch-fork` box, so they already ride along with whatever this
   transition animates for free, with no separate recalculation step. `220ms ease` matches this
   codebase's other layout-affecting transitions (`App.vue`'s `grid-template-columns`,
   `DocumentCanvas.vue`'s pane `width`), not `ThreadCard.vue`'s own shorter `box-shadow 0.15s`
   (a color change, not a reflow, so it reads fine faster). */
.tool-call-body {
  transition: max-height 220ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .tool-call-body {
    transition: none !important;
  }
}
/* research.md §4: real <button>, minimum 24x24px hit area regardless of the bubble's density.
   `--neutral-muted-color` is the same already-validated 4.5:1+ token `MessageBubble.vue`'s own
   `.expand-toggle-button` uses (see that file's doc comment for the full contrast rationale) —
   duplicated here rather than shared via `:deep()` since this is now a separate component with its
   own scoped `<style>`. */
.expand-toggle-button {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  min-width: 24px;
  min-height: 24px;
  padding: 0.1rem 0.45rem;
  font-size: 0.7rem;
  font-weight: 400;
  color: var(--neutral-muted-color, #4b5563);
  background: var(--panel-bg, #f7f7f8);
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 4px;
  cursor: pointer;
}
.expand-toggle-button:hover,
.expand-toggle-button:focus-visible {
  color: var(--text-color, #111);
  border-color: var(--accent-color, #2563eb);
}
.expand-toggle-button:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: 1px;
}
</style>
