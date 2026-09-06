<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { orderConversationsByAnchor } from '../canvas/conversationLayout.js';
import { PRIMARY_EXPLANATION } from '../../composables/constants.js';
import { HOTKEY_BINDINGS, matchesBinding, isEditingContext } from '../../a11y/keymap-registry.js';
import { ApiError } from '../../transport/http-client.js';
import type { PrimaryWhenBusy } from '@rapid-ai-document-review/shared/contracts/http';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import ConversationStatusBadges from '../conversation/ConversationStatusBadges.vue';

// 005-canvas-conversation-threads: the "active"/"all" filter used to be purely local to this
// panel — now `DocumentCanvas.vue` needs the exact same filter to decide which conversations get
// laid out on the canvas (Phase 4/US2's T023 handoff note: filtering the array that reaches
// `computeConversationLayout` is the entire integration point for reflow-on-hide), so the filter
// itself is lifted to `App.vue` and passed down here as a controlled prop instead of local state.
export type ConversationFilter = 'active' | 'all';

// 005-canvas-conversation-threads (multi-focus overlay): `selectedId`/`select` (a single scalar,
// "which one conversation's detail view is open") were replaced by App.vue's
// `focusedConversationIds: Set<string>` (which of possibly several conversations currently have an
// open detail panel — row click is now a toggle, see `onRowClick` below) plus a separate
// `activeId` scalar ("last-interacted" — still exactly one at a time, backing this panel's own row
// highlight/`aria-current`, and driving which panel's focus-trap is active in App.vue). Make/Clear
// Primary (006-toolbar-reorg) targets whichever conversation's own row the button lives on, not
// `activeId`. `focusCap` is the live per-viewport cap (App.vue's `useFocusCap`) purely so a row
// that would exceed it can render its own disabled-looking affordance with the right "max N"
// number.

const props = defineProps<{
  activeId: string | null;
  focusedIds: ReadonlySet<string>;
  filter: ConversationFilter;
  focusCap: number;
}>();
const emit = defineEmits<{
  (e: 'toggle-focus', id: string): void;
  (e: 'cycle-focus', id: string): void;
  (e: 'update:filter', value: ConversationFilter): void;
  (e: 'update:error', value: string | null): void;
}>();
const store = useConversationsStore();

// 006-toolbar-reorg (per-row Primary controls): the global "Primary" box (formerly
// `PrimaryPanel.vue`) is gone — each conversation row now carries its own Make/Clear Primary
// button (see the template below), targeting that row's own conversation rather than a separate
// "active" concept. Since the button already lives on the row it targets, and the busy-switch
// dialog it can open has no other natural surface once the global box is gone, that whole
// designation flow (state + the busy-switch confirmation dialog) moves here rather than living on
// as a near-empty dialog-only component of its own.
/** FR-029: the target/current-Primary-busy warning, offering exactly the three `whenBusy`
 *  choices — set only while a designation request is awaiting the user's decision. */
const busyPrompt = ref<{ conversationId: string; currentPrimaryId: string | null; busyConversationId: string } | null>(
  null,
);
const primaryError = ref<string | null>(null);
watch(primaryError, (value) => emit('update:error', value));

const primaryBusyId = ref<string | null>(null);
const busyDialogEl = ref<HTMLElement | null>(null);
const busyDialogOpen = computed(() => busyPrompt.value !== null);

// FR-043d: opening the busy-switch warning moves focus to its first choice; Escape (or Cancel)
// returns focus to the row button that triggered it.
useFocusTrap(busyDialogEl, busyDialogOpen, { onEscape: () => void resolveBusyPrompt('cancel') });

function conversationName(id: string | null): string {
  if (!id) return 'none';
  return store.conversations.find((c) => c.id === id)?.name ?? id;
}

/** Issues (or re-issues, with an explicit choice) a designation request. On `409
 *  PRIMARY_TARGET_BUSY`, opens the three-choice warning instead of surfacing an error. */
async function makePrimary(conversationId: string, whenBusy?: PrimaryWhenBusy): Promise<void> {
  primaryError.value = null;
  primaryBusyId.value = conversationId;
  try {
    const result = await store.designatePrimary(conversationId, whenBusy);
    if (result.applied !== 'cancelled') busyPrompt.value = null;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PRIMARY_TARGET_BUSY') {
      const details = (err.details ?? {}) as { currentPrimaryId?: string | null; busyConversationId?: string };
      busyPrompt.value = {
        conversationId,
        currentPrimaryId: details.currentPrimaryId ?? null,
        busyConversationId: details.busyConversationId ?? conversationId,
      };
    } else {
      primaryError.value = err instanceof Error ? err.message : 'Failed to designate Primary.';
    }
  } finally {
    primaryBusyId.value = null;
  }
}

async function resolveBusyPrompt(whenBusy: PrimaryWhenBusy): Promise<void> {
  if (!busyPrompt.value) return;
  const { conversationId } = busyPrompt.value;
  if (whenBusy === 'cancel') {
    busyPrompt.value = null;
  }
  await makePrimary(conversationId, whenBusy);
}

async function clearPrimary(conversationId: string): Promise<void> {
  primaryError.value = null;
  try {
    await store.clearPrimary(conversationId);
  } catch (err) {
    primaryError.value = err instanceof Error ? err.message : 'Failed to clear Primary.';
  }
}

/** A row's Make/Clear Primary button `title`/`aria-label` — always rendered (never a bare
 *  disabled control with no explanation), same convention `rowTitle` below uses for the row
 *  itself. Clear Primary's own title still names the conversation explicitly (matching the old
 *  global button's convention) since the button's accessible name is otherwise just "Clear
 *  Primary" with no context of its own beyond its position in the row. */
function primaryButtonTitle(conv: { id: string; name: string; isPrimary: boolean; status: string }): string {
  if (conv.isPrimary) return `Clear Primary (${conv.name}) — ${PRIMARY_EXPLANATION}`;
  if (conv.status === 'closed') return "Closed conversations can't be made Primary";
  if (conv.status === 'errored') return 'An errored conversation cannot be designated Primary';
  return `Make Primary — ${PRIMARY_EXPLANATION}`;
}

function primaryButtonDisabled(conv: { id: string; isPrimary: boolean; status: string }): boolean {
  if (primaryBusyId.value === conv.id) return true;
  if (conv.isPrimary) return false;
  return conv.status === 'closed' || conv.status === 'errored';
}

function onPrimaryButtonClick(conv: { id: string; isPrimary: boolean }): void {
  if (conv.isPrimary) {
    void clearPrimary(conv.id);
  } else {
    void makePrimary(conv.id);
  }
}

// Conversation-list filter: "active" hides closed conversations, which otherwise stay in
// `store.conversations` forever with no way to get them out of the way. Now a controlled prop
// (see the `ConversationFilter` export above) rather than local state, since `DocumentCanvas.vue`
// needs the same predicate. Defaults to "all" in `App.vue` — identical to this list's original
// (unconditional) behavior — so the filter is purely opt-in and nothing already relying on closed
// conversations staying visible/selectable (e.g. tests/e2e/us7.spec.ts re-selecting a just-closed
// conversation from this list) changes unless the user actually toggles it.
function toggleFilter(): void {
  emit('update:filter', props.filter === 'active' ? 'all' : 'active');
}
const filteredConversations = computed(() =>
  props.filter === 'active' ? store.conversations.filter((c) => c.status !== 'closed') : store.conversations,
);

// 005-canvas-conversation-threads/US4 (T032, data-model.md's "HUD ordering"): shared with App.vue's
// stack of simultaneously-focused detail panels (multi-focus overlay) via `orderConversationsByAnchor`
// in `conversationLayout.ts` — see that function's own doc comment for the full ordering rules. Kept
// as a single shared implementation rather than reimplemented per-caller so the two can never disagree.
const orderedConversations = computed(() => {
  const byId = new Map(store.conversations.map((c) => [c.id, c]));
  return orderConversationsByAnchor(filteredConversations.value, byId);
});

// New: Alt+A/J/K conversation-list hotkeys (toggle filter, next/prev selection), operating on
// whichever list `filteredConversations` currently is. Kept local to HudPanel — rather than a
// listener owned by App.vue — since this is the component that already holds both the filter
// state and the list being navigated; it's mounted for the document's whole lifetime alongside
// App.vue's editor/composer, so a plain `document`-level listener here is exactly as "global" as
// one mounted in App.vue would be.
//
// Guarded against hijacking normal typing/existing shortcuts: bails out whenever the event
// target is inside an open dialog (every dialog in this app — KeyboardShortcutsDialog,
// DiffViewer, the close-confirmation and busy-switch dialogs below — is marked `aria-modal="true"`)
// or is itself an editable control (an <input>/<textarea>/<select>, or CodeMirror's
// `contenteditable` document-editor surface) — see the shared `isEditingContext` (a11y/
// keymap-registry.ts), also used by App.vue's own `onGlobalKeydown` for the identical guard.

/** Moves `activeId` to the conversation `offset` positions away from the current one within
 *  `orderedConversations` (wrapping around). Emits the distinct `cycle-focus` event (not
 *  `toggle-focus`) — this is deliberately a "replace the currently-active panel with this one"
 *  cursor move (App.vue's `replaceFocus`), not an add/remove toggle: repeatedly pressing
 *  Ctrl+Alt+J should keep *browsing* one conversation at a time exactly as before this feature,
 *  not pile up new focused panels until the cap is hit. */
function cycleByOffset(offset: number): void {
  const list = orderedConversations.value;
  if (list.length === 0) return;
  const currentIndex = list.findIndex((c) => c.id === props.activeId);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
  emit('cycle-focus', list[nextIndex]!.id);
}

/** Alt+A: toggle active-only/all — unchanged, and confirmed still fine (see below).
 *
 *  Alt+J/Alt+K (bare, single-modifier) turned out to be unreliable in practice: a bare
 *  `Alt+<letter>` is a classic collision point — vim-style window managers (e.g. i3/sway's
 *  default `$mod+j`/`$mod+k` "focus in direction" bindings, where `$mod` is commonly Alt) and
 *  vim-motion browser extensions (Vimium & friends bind bare/near-bare `j`/`k` for
 *  scroll/navigate) can both intercept the physical keypress before it ever reaches this page's
 *  `keydown` listener — the browser/OS swallows it, so no amount of fixing this handler's logic
 *  would help. This was confirmed with a real (non-synthetic) X11 keypress dispatched via
 *  `xdotool` into a real, focused Chromium window against the live dev server: the bare-Alt
 *  bindings themselves *did* arrive at this listener in that plain test environment (no WM
 *  hotkey / extension competing for them there) — i.e. this handler's own logic was never the
 *  bug — but the combination remains exactly the class of binding that gets stolen in common
 *  real-world setups (tiling WMs, vim-key extensions), which is what the user hit. Ctrl+Alt+J /
 *  Ctrl+Alt+K adds a second modifier that neither of those interceptor classes binds by default
 *  (they use a single modifier, or none), while keeping the vim-style J/K-for-down/up mnemonic
 *  and the existing Alt-based convention (Alt+Shift+C branch-from-selection, Alt+A above). */
// Hotkey-consolidation refactor: modifiers+code+scope for these three now live once in
// `a11y/keymap-registry.ts`'s `HOTKEY_BINDINGS` (`'Conversation list'` scope) — this table only
// keeps the actual handlers, looked up by the matched binding's `id`.
const CONVERSATION_LIST_BINDINGS = HOTKEY_BINDINGS.filter((b) => b.scope === 'Conversation list');
const conversationListBindingHandlers: Record<string, () => void> = {
  'toggle-filter': toggleFilter,
  'cycle-next': () => cycleByOffset(1),
  'cycle-prev': () => cycleByOffset(-1),
};

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey) return;
  const binding = CONVERSATION_LIST_BINDINGS.find((b) => matchesBinding(event, b));
  if (!binding) return;
  if (isEditingContext(event)) return;
  event.preventDefault();
  conversationListBindingHandlers[binding.id]?.();
}

/** 005-canvas-conversation-threads (multi-focus overlay): a row's `title` — Primary's existing
 *  explanation stays first-class; a row that would exceed the live focus cap (not already
 *  focused, and the set is already at `focusCap`) also names *why* clicking it won't do anything
 *  right now, exactly like `ConversationThreadBox.vue`'s own Focus button (never a bare disabled
 *  control with no explanation). Clicking it still emits `toggle-focus` regardless — App.vue's own
 *  toggle guards the actual no-op, this is purely the affordance. */
function rowTitle(conv: { id: string; isPrimary: boolean }): string | undefined {
  const atCap = !props.focusedIds.has(conv.id) && props.focusedIds.size >= props.focusCap;
  const capReason = atCap ? `Un-focus another conversation first (max ${props.focusCap})` : null;
  const primaryReason = conv.isPrimary ? `Primary conversation — ${PRIMARY_EXPLANATION}` : null;
  if (capReason && primaryReason) return `${capReason}. ${primaryReason}`;
  return capReason ?? primaryReason ?? undefined;
}

onMounted(() => {
  if (!store.loaded) void store.load();
  document.addEventListener('keydown', onGlobalKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <nav class="hud-panel" aria-label="Conversations">
    <div class="hud-header">
      <h2>Conversations</h2>
      <!-- 006-toolbar-reorg (confirmed layout): compacted per the confirmed design — the separate
           "Show:" label is dropped (the small funnel icon now signals "this is a filter" instead),
           and the button's own text is shortened to "Active"/"All" (was "Active only"/"All").
           Purely visual/text trim: same single button, same click-to-toggle `toggleFilter()`
           handler, same `aria-pressed`, and the full explanatory meaning (plus the Alt+A hotkey)
           still lives in `title`/`aria-label` — just no longer spelled out in the visible label. -->
      <div class="filter-control">
        <button
          type="button"
          class="filter-toggle-button"
          :aria-pressed="props.filter === 'all'"
          :title="`Show ${props.filter === 'active' ? 'all conversations, including closed ones' : 'active conversations only'} (Alt+A)`"
          :aria-label="`Show ${props.filter === 'active' ? 'all conversations, including closed ones' : 'active conversations only'} (Alt+A)`"
          @click="toggleFilter"
        >
          <svg class="filter-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
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

    <ul>
      <!-- UI convention: every conversation row is a 2-section layout — title | status (see
           .specify/memory/constitution.md "UI Conventions"), with a second line beneath it for the
           per-row Make/Clear Primary button (006-toolbar-reorg: the old global "Primary" box —
           `PrimaryPanel.vue` — is gone; each row now targets its own conversation directly).
           `.conversation-row` is the flex/grid container (not a button, so the title can still be a
           true nested control); its own @click reproduces click-anywhere-in-the-row selection via
           ordinary event bubbling from its descendants. The title itself is a real, natively
           keyboard-operable <button> (Tab to focus, Enter/Space activates — its click bubbles up
           and is caught by the same handler, so keyboard selection works); the status badge plus
           every other existing badge (stale/pending/queue) are grouped on the right. The Primary
           conversation is indicated by `.conversation-row.is-primary` below (a left accent +
           subtle background tint) rather than a text badge here — never color alone: a `title` on
           the row plus a `.visually-hidden` label on the title button keep it identifiable for
           screen-reader users, and the small icon is a non-color-dependent visual cue too. There is
           no separate "Read-only" badge next to the status badge: a closed conversation's
           `data-status` badge already says "closed", so read-only is implied, not new information —
           see ConversationView.vue's `.readonly-banner` for the one spot that still earns its keep,
           since it explains *why* editing is disabled rather than just re-labelling the status.
           The Make/Clear Primary button is its own sibling row beneath, outside `.conversation-row`,
           so clicking it never also bubbles into the row's own toggle-focus click handler. -->
      <li v-for="conv in orderedConversations" :key="conv.id" :style="{ paddingLeft: `${conv.branchDepth * 0.3}rem` }">
        <div
          class="conversation-row"
          :class="{
            selected: conv.id === props.activeId,
            'is-primary': conv.isPrimary,
            'is-focused': props.focusedIds.has(conv.id),
            'focus-disabled': !props.focusedIds.has(conv.id) && props.focusedIds.size >= props.focusCap,
          }"
          :data-conversation-id="conv.id"
          :aria-disabled="!props.focusedIds.has(conv.id) && props.focusedIds.size >= props.focusCap"
          :title="rowTitle(conv)"
          @click="emit('toggle-focus', conv.id)"
        >
          <button
            type="button"
            class="conversation-title"
            :aria-current="conv.id === props.activeId ? 'true' : undefined"
            :aria-pressed="props.focusedIds.has(conv.id)"
          >
            <span v-if="conv.isPrimary" class="primary-icon" aria-hidden="true">★</span>
            <span v-if="conv.isPrimary" class="visually-hidden">Primary conversation. </span>
            <span class="name">{{ conv.name }}</span>
          </button>
          <span class="conversation-status-cell">
            <!-- Pending-proposal-count/queue-position badges come from `ConversationStatusBadges.vue`
                 itself, via the shared `conversationStatusBadges.ts` composable — see that
                 composable's own doc comment. -->
            <ConversationStatusBadges :conversation-id="conv.id" />
          </span>
        </div>
        <div class="conversation-primary-row">
          <button
            type="button"
            class="primary-button"
            :class="conv.isPrimary ? 'clear-primary-button' : 'make-primary-button'"
            :disabled="primaryButtonDisabled(conv)"
            :title="primaryButtonTitle(conv)"
            :aria-label="primaryButtonTitle(conv)"
            @click="onPrimaryButtonClick(conv)"
          >
            {{ conv.isPrimary ? 'Clear Primary' : 'Make Primary' }}
          </button>
        </div>
      </li>
    </ul>

    <Transition name="modal">
      <div v-if="busyPrompt" class="modal-overlay primary-busy-dialog-overlay">
        <div
          ref="busyDialogEl"
          class="primary-busy-dialog dialog-box"
          role="alertdialog"
          aria-modal="true"
          aria-label="Primary conversation is busy"
        >
          <p>
            {{ conversationName(busyPrompt.busyConversationId) }} is still working. What should happen to the Primary
            designation?
          </p>
          <div class="primary-busy-choices">
            <button type="button" @click="resolveBusyPrompt('switch_now')">Switch now</button>
            <button type="button" @click="resolveBusyPrompt('switch_when_idle')">Switch when idle</button>
            <button type="button" @click="resolveBusyPrompt('cancel')">Cancel</button>
          </div>
        </div>
      </div>
    </Transition>
  </nav>
</template>

<style scoped>
/* 005-canvas-conversation-threads/US4 (T031), reflowed again by 006-toolbar-reorg: this panel used
   to be a full-height vertical sidebar, then moved inline into `App.vue`'s toolbar row; it now
   lives in the toolbar's left column (title above it, both sharing the same left edge/width) as
   its own "Conversations (HUD)" box. The old global "Primary" box (`PrimaryPanel.vue`) is gone —
   its Make/Clear Primary controls and busy-switch dialog moved here, onto each row (see
   `.conversation-primary-row` below); its designation-error state still surfaces in App.vue via
   `update:error`. Every class/element the existing e2e suite selects on (`.hud-panel`,
   `.conversation-row`, `.status-badge`, `.stale-badge`, `.hud-panel li`) is unchanged, only how
   they're arranged is. */
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
.hud-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
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
   exactly as before) still selects the conversation — see the template comment above for how. */
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
   conversation that currently has an open detail panel — there can be several at once now, unlike
   the single always-exclusive `.selected` state. */
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
   rest) lives in `ConversationStatusBadges.vue`, shared with `ConversationThreadBox.vue`/
   `ConversationView.vue` — see that component's own doc comment. */
/* 006-toolbar-reorg: the primary-error banner still moves up to App.vue as a full-width strip
   beneath both toolbar columns (via `update:error`) — only the notice/summary chrome and the
   busy-switch dialog itself moved back down here, onto the per-row button that now triggers them
   (see the doc comment above `busyPrompt` in <script> for why). */
.conversation-primary-row {
  display: flex;
  justify-content: flex-start;
  padding: 0 0.45rem;
}
.primary-button {
  font-size: 0.65rem;
  padding: 0.05rem 0.35rem;
}
.primary-busy-dialog-overlay {
  z-index: var(--z-overlay-primary, 60);
}
/* Background/color/border-radius/box-shadow live in style.css's shared `.dialog-box` class
   (applied via the template class above); only this dialog's own width/padding stay here. */
.primary-busy-dialog {
  padding: 1rem;
  max-width: 22rem;
}
.primary-busy-choices {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
</style>
