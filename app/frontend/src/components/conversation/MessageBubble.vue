<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { render } from '../../render/markdown-pipeline.js';
import { domPurifySanitizer } from '../../render/sanitizer.js';
import type { ConversationMessageState } from '../../stores/conversations.js';

// FR-008/data-model.md's MessageDisplayState: `expanded` defaults to `true` (no clamp) purely as a
// safe default for any caller that omits the prop entirely (e.g. `ConversationThreadBox.vue`'s own
// read-only `continuity-context` messages, which are always shown in full). Every caller that
// renders a real, ongoing transcript — `ConversationThreadBox.vue`'s own messages and
// `ConversationView.vue`'s full/focused transcript alike — passes `expanded` explicitly and owns
// the per-message state itself (data-model.md scopes `MessageDisplayState` by `messageId`, not per-
// conversation, so the parent — not this component — is the natural owner of "all my messages'"
// combined state, which `ConversationThreadBox.vue`'s bulk toggle, FR-009, needs).
const props = withDefaults(
  defineProps<{ message: ConversationMessageState; seed?: boolean; expanded?: boolean }>(),
  {
    expanded: true,
  },
);
const emit = defineEmits<{ (e: 'update:expanded', value: boolean): void }>();
const settings = useSettingsStore();

/** research.md: "comfortably show a few lines of text" — a fixed pixel value (not an ideal-lines
 *  count) so the JS overflow check below and the CSS clamp applied in the template agree on
 *  exactly the same number, with a single source of truth. Shared by every clampable block in this
 *  bubble (the message text and each tool call) via `useClampToggle` below, so they all clamp/
 *  expand identically. */
const CLAMP_HEIGHT_PX = 160;

/**
 * One clamp/expand/collapse controller, shared by the message text (the "primary" id) and every
 * tool-call block in this bubble (each a "secondary" id, keyed by `toolCallId`) — every clampable
 * region registers its element under its own id rather than getting its own separate set of
 * refs/computeds, so "is this block tall enough to need a toggle" and "clamp to CLAMP_HEIGHT_PX
 * until expanded" are implemented exactly once.
 *
 * The primary id's expanded flag is owned by the caller (here, the message text defers to the
 * `expanded` prop/`update:expanded` emit, since that's owned by the parent per data-model.md); every
 * secondary id gets its own independently-toggleable, local/unpersisted flag instead — EXCEPT that
 * whenever the primary's expanded value actually changes, for *any* reason (its own toggle here, or
 * a parent's bulk "Expand all"/"Collapse all", FR-009, changing the `expanded` prop directly), every
 * currently-registered secondary id snaps to match it. This cascade rule lives here, in the shared
 * controller, rather than as separate wiring in the component, so any future secondary clampable
 * block gets it automatically just by registering under this same controller — a bulk collapse can
 * never leave one individually-expanded block stuck open.
 */
function useClampToggle(
  primaryId: string,
  getPrimaryExpanded: () => boolean,
  setPrimaryExpanded: (value: boolean) => void,
) {
  const els = new Map<string, HTMLElement>();
  // Whether a given id's content is actually taller than the clamp — the expand/collapse button
  // only appears when there's something to expand/collapse. `scrollHeight` reports the true,
  // unclipped content height regardless of whether `overflow: hidden`/`max-height` happens to be
  // applied at the time it's read, so this is accurate whether currently expanded or collapsed.
  const overflowing = ref<Record<string, boolean>>({});
  const secondaryExpanded = ref<Record<string, boolean>>({});

  watch(getPrimaryExpanded, (value) => {
    for (const id of els.keys()) {
      if (id !== primaryId) secondaryExpanded.value[id] = value;
    }
  });

  function isExpanded(id: string): boolean {
    return id === primaryId ? getPrimaryExpanded() : (secondaryExpanded.value[id] ?? false);
  }

  function setExpanded(id: string, value: boolean): void {
    if (id === primaryId) {
      setPrimaryExpanded(value);
    } else {
      secondaryExpanded.value[id] = value;
    }
  }

  function setEl(id: string, el: Element | null): void {
    if (el instanceof HTMLElement) {
      els.set(id, el);
    } else {
      els.delete(id);
    }
  }

  function recompute(): void {
    for (const [id, el] of els) {
      overflowing.value[id] = el.scrollHeight > CLAMP_HEIGHT_PX;
    }
  }

  function isOverflowing(id: string): boolean {
    return overflowing.value[id] ?? false;
  }

  function clampStyle(id: string): { maxHeight: string; overflow: string } | undefined {
    return !isExpanded(id) && isOverflowing(id)
      ? { maxHeight: `${CLAMP_HEIGHT_PX}px`, overflow: 'hidden' }
      : undefined;
  }

  function label(id: string): string {
    return isExpanded(id) ? 'Show less' : 'Show more';
  }

  function toggle(id: string): void {
    setExpanded(id, !isExpanded(id));
  }

  return { setEl, recompute, isOverflowing, isExpanded, toggle, clampStyle, label };
}

const TEXT_ID = '__text__';
const clamp = useClampToggle(
  TEXT_ID,
  () => props.expanded,
  (value) => emit('update:expanded', value),
);

watch(
  () => props.message.text,
  () => void nextTick(clamp.recompute),
  { immediate: true, flush: 'post' },
);
watch(
  () => props.message.toolCalls,
  () => void nextTick(clamp.recompute),
  { immediate: true, flush: 'post', deep: true },
);

// All agent-produced (and, defensively, user-authored) content passes the sanitizer before
// touching the DOM (FR-008a, Constitution Principle VI) — same pipeline as document Markdown.
// html:false here: conversation messages never author raw HTML, and a literal `<tag>` (e.g. a
// seed message's `<document-revision-N>`) should show as visible text, not be parsed as markup
// and silently swallowed by the sanitizer as an unknown element.
const safeText = computed(() =>
  domPurifySanitizer.sanitize(render(props.message.text ?? '', { html: false })),
);
const safeReasoning = computed(() =>
  props.message.reasoning
    ? domPurifySanitizer.sanitize(render(props.message.reasoning, { html: false }))
    : '',
);

// contracts/frontend-display.md: `args`/`resultText` are stored raw/compact — pretty-printing is
// purely a render-time concern, never done before persistence.
function formatToolArgs(args: unknown): string {
  return JSON.stringify(args, null, 2) ?? String(args);
}
</script>

<template>
  <!-- FR-007c: `data-role` stays the real message role even for a seed card (e.g. tests select
       `.message-bubble[data-role="user"]`); `seed` only changes how it's presented.
       `data-message-id`: lets both call sites' `scrollMessageTopIntoView` (composables/
       messageScroll.ts) find this exact bubble's DOM node by message id, the same way
       `App.vue`'s own `scrollBoxIntoView` already locates a `ConversationThreadBox` by
       `data-conversation-id`.
       Root `v-if`: a real-SDK tool-call-carrier segment (`message.isToolCallCarrier` —
       event-bridge.ts's `message_end` handling) has no visible text/reasoning of its own — it's an
       internal artifact of the model calling a tool, not a reply. Gated on the same "Show
       reasoning" toggle reasoning content already uses (`settings.thinkingVisible`): hidden by
       default so it never renders as a blank "Assistant" bubble, shown (as a small note, below)
       when the toggle is on so the underlying event is still inspectable — UNLESS this carrier
       segment actually has tool-call detail to show, in which case it renders regardless of the
       toggle (Research Decision 5: tool-call detail is a factual record, not gated by "Show
       reasoning"). -->
  <article
    v-if="
      !message.isToolCallCarrier || settings.thinkingVisible || (message.toolCalls?.length ?? 0) > 0
    "
    class="message-bubble"
    :class="{ 'seed-card': seed, 'tool-call-carrier': message.isToolCallCarrier }"
    :data-role="message.role"
    :data-message-id="message.id"
    :aria-busy="message.streaming"
  >
    <header class="message-role">
      <span class="message-role-label">
        {{
          seed ? 'Context — discussing this excerpt' : message.role === 'user' ? 'You' : 'Assistant'
        }}
      </span>

      <!-- FR-008/research.md §4: a real <button>, minimum 24x24px hit area, only rendered when
           there's actually more to show/hide. Placed next to the role label — not after the
           message content — so it's reachable without scrolling past a long, still-collapsed
           message to find it. -->
      <button
        v-if="clamp.isOverflowing(TEXT_ID)"
        type="button"
        class="expand-toggle-button"
        :aria-label="`${clamp.label(TEXT_ID)} of this message`"
        @click="clamp.toggle(TEXT_ID)"
      >
        {{ clamp.label(TEXT_ID) }}
      </button>
    </header>

    <details v-if="message.reasoning" class="reasoning" :open="settings.thinkingVisible">
      <summary>Reasoning</summary>
      <!-- eslint-disable-next-line vue/no-v-html -- safeReasoning is DOMPurify-sanitized, see render/sanitizer.ts -->
      <div class="reasoning-content" v-html="safeReasoning" />
    </details>

    <p v-if="message.isToolCallCarrier && settings.thinkingVisible" class="tool-call-carrier-note">
      Tool call — this segment carries no reply text of its own.
    </p>

    <!-- Tool-call detail (contracts/frontend-display.md): a factual record of what the agent did,
         not gated by "Show reasoning" at all (Research Decision 5) — renders whenever this message
         has any `toolCalls`, regardless of the toggle. Plain text interpolation only (no v-html):
         `args`/`resultText`/`failureReason` may contain untrusted content from a fetched page or
         search snippet (Constitution Principle VI). Expand/collapse per call, same `clamp`
         controller (and CLAMP_HEIGHT_PX) the message text below uses. -->
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

    <!-- eslint-disable vue/no-v-html -- safeText is DOMPurify-sanitized, see render/sanitizer.ts -->
    <div
      :ref="(el) => clamp.setEl(TEXT_ID, el as Element | null)"
      class="message-text text-wrap-safe"
      :style="clamp.clampStyle(TEXT_ID)"
      v-html="safeText"
    />
    <!-- eslint-enable vue/no-v-html -->
  </article>
</template>

<style scoped>
.message-bubble {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  text-align: left;
}
.message-bubble[data-role='user'] {
  background: var(--user-bubble-bg, rgba(37, 99, 235, 0.08));
}
.message-bubble[data-role='assistant'] {
  background: var(--assistant-bubble-bg, rgba(0, 0, 0, 0.04));
}
/* FR-007c: the branch-seed message is still technically `data-role="user"` (see the template
   comment above) but is presented as a distinct system/context card, not a user chat bubble. */
.message-bubble.seed-card {
  background: var(--seed-bg, #f3f4f6);
  border: 1px dashed var(--seed-border, #9ca3af);
}
.message-role {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  /* A flat opacity reduction on inherited text color is background-dependent and can measure
     under 4.5:1 in dark mode. `--neutral-muted-color` is a real token already validated to clear
     4.5:1 against panel/bubble backgrounds in both schemes (see style.css) — use it directly
     instead of opacity, same approach as the seed-card variant. */
  color: var(--neutral-muted-color, #4b5563);
  margin-bottom: 0.25rem;
}
/* `.message-role-label` sits on this bubble's own tint
   (`--user-bubble-bg`/`--assistant-bubble-bg`, both translucent), not a flat panel surface, so it
   needs style.css's tinted-surface token, `--neutral-muted-color-on-tint`, rather than the
   flat-surface `--neutral-muted-color` its `.message-role` parent uses above. In dark mode that
   tint composites on top of the panel surface and lightens the effective background further —
   e.g. to ~rgb(47,62,83) inside the canvas thread box — where `--neutral-muted-color` alone
   measures only ~4.27:1. `--neutral-muted-color-on-tint` is identical to `--neutral-muted-color`
   in light mode (dark text on a light/tinted-light bubble already has a huge margin), so this only
   actually changes anything in dark mode. */
.message-role-label {
  color: var(--neutral-muted-color-on-tint, #c3cad3);
}
/* `.text-wrap-safe`'s shared overflow-wrap/pre/code handling now lives in style.css —
   `.message-bubble`/`.message-list` are plain block boxes here (not flex/grid items), so no
   `min-width: 0` is needed to let anything shrink; `overflow-wrap` alone was what was missing. */
/* Embedded Markdown headings (e.g. a branch-seed excerpt's own section heading) must not render at
   full document size inside a ~350px-wide chat bubble — that crowds out the message. */
.message-text :deep(h1) {
  font-size: 1.1rem;
}
.message-text :deep(h2) {
  font-size: 1rem;
}
.message-text :deep(h3),
.message-text :deep(h4),
.message-text :deep(h5),
.message-text :deep(h6) {
  font-size: 0.95rem;
}
.reasoning {
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  opacity: 0.85;
}
.reasoning summary {
  cursor: pointer;
}
/* Debug-visible note for a tool-call-carrier segment shown while "Show reasoning" is on (see the
   root `v-if` above) — same muted, small-print treatment as `.reasoning`, so it reads as internal/
   diagnostic content rather than a genuine reply. */
.tool-call-carrier-note {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  font-style: italic;
  opacity: 0.7;
}
/* contracts/frontend-display.md: informational/read-only agent activity gets its own dedicated
   token pair (`--info-*`), distinct from `--status-active-*`/`--queue-*`; a failed call reuses the
   existing `--danger-*` pair rather than introducing a second error color. */
.tool-call {
  margin: 0 0 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  background: var(--info-bg, #eff6ff);
  border: 1px solid var(--info-border, #bfdbfe);
  color: var(--info-color, #1e3a8a);
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
.message-text :deep(p:first-child) {
  margin-top: 0;
}
.message-text :deep(p:last-child) {
  margin-bottom: 0;
}
/* research.md §4: real <button>, minimum 24x24px hit area regardless of the bubble's density.
   `--accent-color` measures a thin 4.34:1 against `--user-bubble-bg` (both derive from the same
   blue, so text-on-tint here is a worse case than most other uses of `--accent-color`) —
   `--neutral-muted-color` is the same already-validated 4.5:1+ token `.stale-badge`/
   `.no-primary-badge` use for exactly this reason.
   A visible border/background (not just underline-on-hover) makes this read as a clickable
   control at a glance, distinct from the plain-text `.message-role-label` next to it — matching
   `ConversationThreadBox.vue`'s `.thread-action-button` treatment.
   This button's own background is the same `--panel-bg` token as its ancestor
   `.conversation-thread-box`, and `--border-color` measures only ~1.4-1.6:1 against that
   background in dark mode — under WCAG 1.4.11's 3:1 non-text-contrast minimum, so the button's
   boundary would be effectively invisible against the box (same root cause as
   `.thread-action-button` above). `--neutral-muted-color` clears 3:1 (in fact 4.5:1+) against
   `--panel-bg` in both color schemes. */
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
