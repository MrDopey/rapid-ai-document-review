<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { PRIMARY_EXPLANATION } from '../../composables/constants.js';
import {
  HOTKEY_BINDINGS,
  matchesBinding,
  isEditingContext,
  type KeyboardShortcut,
} from '../../a11y/keymap-registry.js';

// 005-canvas-conversation-threads: the "active"/"all" filter used to be purely local to this
// panel — now `DocumentCanvas.vue` needs the exact same filter to decide which conversations get
// laid out on the canvas (Phase 4/US2's T023 handoff note: filtering the array that reaches
// `computeConversationLayout` is the entire integration point for reflow-on-hide), so the filter
// itself is lifted to `App.vue` and passed down here as a controlled prop instead of local state.
export type ConversationFilter = 'active' | 'all';

// 011-linear-thread-mode: generalized from a canvas-only, `useConversationsStore()`-reading
// component into a shared parent both canvas mode AND Thread mode instantiate — see this feature's
// own plan notes for the rationale ("the two must share the same parent component" so they stay
// visually/behaviorally identical rather than two separately-maintained look-alikes). This is now
// a pure, prop-driven "sticky strip of selectable rows with an active cursor and an optional
// multi-focus set" shell: it owns none of the item list itself (`items` below is already filtered
// AND ordered by the caller — `App.vue`'s own `orderConversationsByAnchor`-ordered list for canvas
// mode, `threadFocusState.ts`'s DFS/tree-ordered list for Thread mode), so it no longer imports or
// reads any Pinia store directly.
export interface HudItem {
  id: string;
  /** Row label — a conversation's or a Thread's own `name`. */
  name: string;
  /** Left-indent depth (0 = no indent) — canvas mode's `branchDepth`, Thread mode's tree depth. */
  depth?: number;
  /** Renders the same left-accent/star treatment `rowTitle` below explains — canvas-mode-only
   *  today (Thread mode never sets this), but kept generic rather than canvas-specific naming. */
  isPrimary?: boolean;
}

const props = withDefaults(
  defineProps<{
    items: readonly HudItem[];
    activeId: string | null;
    focusedIds: ReadonlySet<string>;
    filter: ConversationFilter;
    focusCap: number;
    /** Heading text — "Conversations" (canvas mode) or "Threads" (Thread mode). */
    label?: string;
    /** `<nav aria-label>` — defaults to `label` when omitted. */
    ariaLabel?: string;
    /** Hides the Active/All filter toggle entirely — Thread mode's `items` are already
     *  pre-filtered to active threads by its own caller, with no "show closed ones" concept. */
    showFilter?: boolean;
    /** Which `HOTKEY_BINDINGS` scope this instance's own Ctrl+Alt+J/K (and, when `showFilter`,
     *  Alt+A) listen on — `'Conversation list'` (canvas mode, default) or `'Thread list'` (Thread
     *  mode). See `a11y/keymap-registry.ts`'s `reachableTogether` for why the two scopes may
     *  safely reuse the same physical key combos. */
    hotkeyScope?: KeyboardShortcut['scope'];
    /** Tooltip suffix for an `isPrimary` row — defaults to the canvas-mode Primary explanation. */
    primaryExplanation?: string;
  }>(),
  {
    label: 'Conversations',
    ariaLabel: undefined,
    showFilter: true,
    hotkeyScope: 'Conversation list',
    primaryExplanation: PRIMARY_EXPLANATION,
  },
);
const emit = defineEmits<{
  (e: 'toggle-focus', id: string): void;
  (e: 'cycle-focus', id: string): void;
  (e: 'update:filter', value: ConversationFilter): void;
}>();

const navLabel = computed(() => props.ariaLabel ?? props.label);

// Conversation-list filter: "active" hides closed conversations, which otherwise stay in
// `store.conversations` forever with no way to get them out of the way. A controlled prop (see the
// `ConversationFilter` export above), since the caller (App.vue) needs the same predicate for its
// own canvas layout. Purely a display toggle now — filtering `items` itself is entirely the
// caller's job (see this file's own top doc comment), this component just reflects/toggles the
// current value.
function toggleFilter(): void {
  emit('update:filter', props.filter === 'active' ? 'all' : 'active');
}

/** Moves `activeId` to the item `offset` positions away from the current one within `items`
 *  (wrapping around). Emits the distinct `cycle-focus` event (not `toggle-focus`) — this is
 *  deliberately a "replace the currently-active selection with this one" cursor move (canvas
 *  mode's `App.vue#replaceFocus`, Thread mode's `threadFocusState.ts#jumpTo`), not an add/remove
 *  toggle: repeatedly pressing Ctrl+Alt+J should keep *browsing* one item at a time, not pile up
 *  new focused panels until some cap is hit. */
function cycleByOffset(offset: number): void {
  const list = props.items;
  if (list.length === 0) return;
  const currentIndex = list.findIndex((item) => item.id === props.activeId);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
  emit('cycle-focus', list[nextIndex]!.id);
}

// Hotkey-consolidation refactor (extended for 011-linear-thread-mode's generalization): every
// binding's own modifiers+code+scope lives once in `a11y/keymap-registry.ts`'s `HOTKEY_BINDINGS`;
// this component only keeps the actual handlers, dispatched by each matched binding's `action`
// (not its `id` — the same three verbs are shared by both the `'Conversation list'` and `'Thread
// list'` scoped binding sets, under different, scope-unique `id`s) so this dispatch table needs no
// per-scope duplication.
const scopedBindings = computed(() => HOTKEY_BINDINGS.filter((b) => b.scope === props.hotkeyScope));
const bindingHandlersByAction: Record<string, () => void> = {
  'toggle-filter': toggleFilter,
  'cycle-next': () => cycleByOffset(1),
  'cycle-prev': () => cycleByOffset(-1),
};

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey) return;
  const binding = scopedBindings.value.find((b) => matchesBinding(event, b));
  if (!binding || !binding.action) return;
  // Bug fix: this used to call `isEditingContext(event)` with no options at all, so a binding's own
  // `composerExempt` flag (`a11y/keymap-registry.ts`) was silently never honored here — invisible
  // until Thread mode's `thread-cycle-next`/`thread-cycle-prev` became the first bindings in either
  // of this component's own scopes to actually set it (App.vue's own `onGlobalKeydown` already
  // threads this through correctly for its own `Global`-scope bindings).
  if (isEditingContext(event, { allowComposer: binding.composerExempt === true })) return;
  event.preventDefault();
  bindingHandlersByAction[binding.action]?.();
}

/** Ctrl+Alt+1..9 (`focus-toggle-<N>` in `a11y/keymap-registry.ts`, dispatched by App.vue's
 *  `onGlobalKeydown` for canvas mode's `orderedVisibleConversations` and
 *  `threadFocusState.ts#jumpToIndex` for Thread mode's `orderedThreadIds`) targets the Nth item of
 *  this exact `items` order, 1-based — both callers build `hudItems` as a plain, unfiltered
 *  `.map()` over that same ordered list (see each caller's own `hudItems` computed), so `items`'
 *  own index here always agrees with the hotkey's target with no separate lookup needed. Only
 *  returns a number for the first 9 rows — there is no `focus-toggle-10`+ binding
 *  (`FOCUS_TOGGLE_BINDINGS` in the keymap registry only generates 1..9) — rather than showing a
 *  number nothing actually binds to. */
function hotkeyNumber(index: number): number | null {
  return index < 9 ? index + 1 : null;
}

/** 005-canvas-conversation-threads (multi-focus overlay): a row's `title` — Primary's existing
 *  explanation stays first-class; a row that would exceed the live focus cap (not already
 *  focused, and the set is already at `focusCap`) also names *why* clicking it won't do anything
 *  right now, exactly like `ConversationThreadBox.vue`'s own Focus button (never a bare disabled
 *  control with no explanation). Clicking it still emits `toggle-focus` regardless — the caller's
 *  own toggle guards the actual no-op, this is purely the affordance. */
function rowTitle(item: HudItem): string | undefined {
  const atCap = !props.focusedIds.has(item.id) && props.focusedIds.size >= props.focusCap;
  const capReason = atCap ? `Un-focus another item first (max ${props.focusCap})` : null;
  const primaryReason = item.isPrimary
    ? `Primary conversation — ${props.primaryExplanation}`
    : null;
  if (capReason && primaryReason) return `${capReason}. ${primaryReason}`;
  return capReason ?? primaryReason ?? undefined;
}

onMounted(() => {
  document.addEventListener('keydown', onGlobalKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <nav class="hud-panel" :aria-label="navLabel">
    <div class="hud-header">
      <h2>{{ props.label }}</h2>
      <div class="hud-header-end">
        <slot name="actions" />
        <!-- 006-toolbar-reorg (confirmed layout): compacted per the confirmed design — the separate
             "Show:" label is dropped (the small funnel icon now signals "this is a filter" instead),
             and the button's own text is shortened to "Active"/"All" (was "Active only"/"All").
             Purely visual/text trim: same single button, same click-to-toggle `toggleFilter()`
             handler, same `aria-pressed`, and the full explanatory meaning (plus the Alt+A hotkey)
             still lives in `title`/`aria-label` — just no longer spelled out in the visible label. -->
        <div v-if="props.showFilter" class="filter-control">
          <button
            type="button"
            class="filter-toggle-button"
            :aria-pressed="props.filter === 'all'"
            :title="`Show ${props.filter === 'active' ? 'all conversations, including closed ones' : 'active conversations only'} (Alt+A)`"
            :aria-label="`Show ${props.filter === 'active' ? 'all conversations, including closed ones' : 'active conversations only'} (Alt+A)`"
            @click="toggleFilter"
          >
            <svg
              class="filter-icon"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M3.5 5h17L14 12.5V19l-4 2v-8.5L3.5 5z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
            {{ props.filter === 'active' ? 'Active' : 'All' }}
          </button>
        </div>
      </div>
    </div>

    <ul>
      <!-- UI convention: every row is a 2-section layout — title | status (see
           .specify/memory/constitution.md "UI Conventions"). `.conversation-row` is the flex/grid
           container (not a button, so the title can still be a true nested control); its own
           @click reproduces click-anywhere-in-the-row selection via ordinary event bubbling from
           its descendants. The title itself is a real, natively keyboard-operable <button> (Tab to
           focus, Enter/Space activates — its click bubbles up and is caught by the same handler, so
           keyboard selection works); the status badge slot (see `#badge` below) is grouped on the
           right. The Primary conversation is indicated by `.conversation-row.is-primary` below (a
           left accent + subtle background tint) rather than a text badge here — never color alone:
           a `title` on the row plus a `.visually-hidden` label on the title button keep it
           identifiable for screen-reader users, and the small icon is a non-color-dependent visual
           cue too.

           011-linear-thread-mode: class/attribute names here (`.conversation-row`,
           `data-conversation-id`, etc.) stay exactly as they were pre-generalization, even though
           this component is no longer conversation-specific — renaming them would touch a much
           larger surface (existing e2e/component test selectors, `style.css`) for no behavioral
           benefit; the generalization here is about the data source (`items` prop vs. a hardcoded
           store), not a cosmetic rename. -->
      <li
        v-for="(item, index) in props.items"
        :key="item.id"
        :style="{ paddingLeft: `${(item.depth ?? 0) * 0.3}rem` }"
      >
        <div
          class="conversation-row"
          :class="{
            selected: item.id === props.activeId,
            'is-primary': item.isPrimary,
            'is-focused': props.focusedIds.has(item.id),
            'focus-disabled':
              !props.focusedIds.has(item.id) && props.focusedIds.size >= props.focusCap,
          }"
          :data-conversation-id="item.id"
          :aria-disabled="!props.focusedIds.has(item.id) && props.focusedIds.size >= props.focusCap"
          :title="rowTitle(item)"
          @click="emit('toggle-focus', item.id)"
        >
          <button
            type="button"
            class="conversation-title"
            :aria-current="item.id === props.activeId ? 'true' : undefined"
            :aria-pressed="props.focusedIds.has(item.id)"
          >
            <!-- Ctrl+Alt+<N> hotkey chip — only for the first 9 rows (see `hotkeyNumber` above),
                 styled off the same shared `.badge` shape/border/font every other row chip
                 (`ConversationStatusBadges.vue`'s status/stale/pending badges in the `#badge` slot
                 below) already uses, so it reads as one more badge rather than a one-off style.
                 Bug fix: this used to wrap the number in literal `[`/`]` characters on top of
                 `.badge`'s own real `border: 1px solid currentColor` — the bracket glyphs sit right
                 against the chip's padded edges and read as a second, doubled outline. `.badge`'s
                 border already IS the chip framing, so the bracket text was purely redundant. -->
            <span
              v-if="hotkeyNumber(index) !== null"
              class="badge hotkey-badge"
              aria-hidden="true"
              >{{ hotkeyNumber(index) }}</span
            >
            <span v-if="hotkeyNumber(index) !== null" class="visually-hidden"
              >Hotkey Ctrl+Alt+{{ hotkeyNumber(index) }}.
            </span>
            <span v-if="item.isPrimary" class="primary-icon" aria-hidden="true">★</span>
            <span v-if="item.isPrimary" class="visually-hidden">Primary conversation. </span>
            <span class="name">{{ item.name }}</span>
          </button>
          <span class="conversation-status-cell">
            <slot name="badge" :item="item" />
          </span>
        </div>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
/* 005-canvas-conversation-threads/US4 (T031), reflowed again by 006-toolbar-reorg: this panel used
   to be a full-height vertical sidebar, then moved inline into `App.vue`'s toolbar row; it now
   lives in the toolbar's left column (title above it, both sharing the same left edge/width) as
   its own "Conversations (HUD)" box. The old global "Primary" box (`PrimaryPanel.vue`) is gone, and
   a later refactor removed its brief per-row Make/Clear Primary button too — this list is purely
   informational now (title, badges, status; see `usePrimaryAction` in `composables/
   primaryAction.ts` for where that control lives instead). Every class/element the existing e2e
   suite selects on (`.hud-panel`, `.conversation-row`, `.status-badge`, `.stale-badge`, `.hud-panel
   li`) is unchanged, only how they're arranged is. */
.hud-panel {
  overflow: visible;
  padding: 0;
  text-align: left;
  border: none;
  background: none;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.hud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.hud-header h2 {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--neutral-muted-color, #4b5563);
}
/* 011-linear-thread-mode: wraps the `#actions` slot (Thread mode's Expand-all/Export-all/Done
   buttons, formerly `.thread-mode-toolbar-actions`) alongside the filter toggle, so a caller with
   extra header-level actions has one obvious place to put them rather than inventing its own
   adjacent toolbar strip. Empty (and so visually inert) for any caller that doesn't fill it. */
.hud-header-end {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 0 0 auto;
}
.filter-control {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex: 0 0 auto;
}
.filter-toggle-button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
.filter-icon {
  flex: 0 0 auto;
}
/* Bug fix: rows used to be `align-items: center`, which vertically centers each `<li>` within its
   own wrapped flex line rather than aligning it to that line's actual bottom edge. A row whose
   status badges wrap onto a second line (`.conversation-status-cell` below is itself
   `flex-wrap: wrap`) grows taller than its line-mates — with centering, every shorter row on that
   same line ends up with unequal empty space above/below it, so its own `.is-focused` bottom border
   (a real `border-bottom` on `.conversation-row`, already correctly attached to that row's own box)
   lands at a different vertical position than the taller row's. `align-items: flex-end` instead
   bottom-aligns every row on a line to that line's own bottom edge regardless of its individual
   height, so every row's bottom border reads flush with its neighbors' even when one has wrapped to
   two lines of badges. */
.hud-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.3rem;
  max-height: 4.5rem;
  overflow-y: auto;
}
.hud-panel li {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
}
/* UI convention: title | status, laid out as 2 side-by-side sections in one row (see
   .specify/memory/constitution.md "UI Conventions"). A <div>, not a <button>, so the title can
   still be a true nested control; clicking anywhere in the row (including over the status badges,
   exactly as before) still selects the item — see the template comment above for how. */
.conversation-row {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, auto);
  align-items: center;
  gap: 0.3rem;
  max-width: 15rem;
  padding: 0.25rem 0.45rem;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.conversation-row.selected {
  border-color: var(--border-color, #999);
  background: var(--row-selected-bg, rgba(0, 0, 0, 0.05));
}
/* The Primary conversation is indicated on the row itself — a left accent bar plus a subtle
   background tint, both via `box-shadow` so they layer independently of `.selected`'s own
   `border`/`background`, letting the two states combine instead of fighting over the same
   properties. Never color alone: the row also carries a `title` (see template) and the title
   button carries a `.visually-hidden` "Primary conversation" label plus a small `★` icon, so
   screen-reader and colorblind users can still tell which conversation is Primary. */
.conversation-row.is-primary {
  box-shadow: var(--primary-indicator-shadow);
}
/* 005-canvas-conversation-threads (multi-focus overlay): a small, non-color-alone cue (a bottom
   border, distinct from `.selected`'s full border and `.is-primary`'s box-shadow) marking every
   item that currently has an open detail panel (canvas mode) — there can be several at once,
   unlike the single always-exclusive `.selected` state. Thread mode never sets any id into
   `focusedIds`, so this never applies there. */
.conversation-row.is-focused {
  border-bottom: 2px solid var(--accent-color, #2563eb);
}
/* Dim (never hide) a row that would exceed the live focus cap if clicked — `rowTitle()` above
   supplies the reason as both the row's `title` and (via the title button's own accessible name)
   effectively its explanation; `aria-disabled` (not the native `disabled` attribute) keeps it
   keyboard-reachable so that explanation is actually discoverable, since clicking it is a real,
   if inert, no-op rather than truly unclickable. */
.conversation-row.focus-disabled {
  opacity: 0.55;
}
/* Reset the title's native button chrome — visually it's just the row's left-hand label, styled
   identically to how `.name` looked when it lived inside the old single-button row. */
.conversation-title {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  justify-self: start;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
.conversation-row .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 8rem;
}
.primary-icon {
  flex: 0 0 auto;
  color: var(--accent-color, #2563eb);
  font-size: 0.75rem;
  line-height: 1;
}
/* Ctrl+Alt+<N> hotkey chip: same shared `.badge` pill (style.css) every status badge in
   `ConversationStatusBadges.vue` already uses for shape/border/padding/font-size — only the color
   is set here, `--accent-color` (already this row's "interactive affordance" color: `.is-focused`'s
   border, `.primary-icon`'s star) so the chip visually pops against the row's own muted default
   text instead of blending into it. */
.hotkey-badge {
  flex: 0 0 auto;
  color: var(--accent-color, #2563eb);
  font-weight: 700;
  line-height: 1;
}
.conversation-status-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  justify-self: end;
  min-width: 0;
  gap: 0.35rem;
}
/* Every conversation status/badge color (`.pending-badge`/`.queue-badge`/`.stale-badge` and the
   rest) lives in `ConversationStatusBadges.vue`, rendered into the `#badge` slot above by canvas
   mode's own caller — shared with `ConversationThreadBox.vue`/`ConversationView.vue`. */
</style>
