<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { ApiError } from '../../transport/http-client.js';
import type { PrimaryWhenBusy } from '@rapid-ai-document-review/shared/contracts/http';
import { useFocusTrap } from '../../a11y/focus-manager.js';

const props = defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const store = useConversationsStore();

/** FR-029: the target/current-Primary-busy warning, offering exactly the three `whenBusy`
 *  choices — set only while a designation request is awaiting the user's decision. */
const busyPrompt = ref<{ conversationId: string; currentPrimaryId: string | null; busyConversationId: string } | null>(
  null,
);
const primaryError = ref<string | null>(null);
const primaryBusyId = ref<string | null>(null);
const busyDialogEl = ref<HTMLElement | null>(null);

const primaryConversation = computed(() => store.conversations.find((c) => c.isPrimary) ?? null);
const hasPrimary = computed(() => primaryConversation.value !== null);
const busyDialogOpen = computed(() => busyPrompt.value !== null);

// Conversation-list filter (new): "active" hides closed conversations, which otherwise stay in
// `store.conversations` forever with no way to get them out of the way. Local component state per
// the feature's own steer — nothing else in the app needs to know which mode is in effect.
// Defaults to "all" — identical to this list's previous (unconditional) behavior — so the filter
// is purely opt-in and nothing already relying on closed conversations staying visible/selectable
// (e.g. tests/e2e/us7.spec.ts re-selecting a just-closed conversation from this list) changes
// unless the user actually toggles it.
type ConversationFilter = 'active' | 'all';
const filter = ref<ConversationFilter>('all');
function toggleFilter(): void {
  filter.value = filter.value === 'active' ? 'all' : 'active';
}
const filteredConversations = computed(() =>
  filter.value === 'active' ? store.conversations.filter((c) => c.status !== 'closed') : store.conversations,
);

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
// `contenteditable` document-editor surface) — see `isEditingContext`.
function isEditingContext(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('[aria-modal="true"]')) return true;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.isContentEditable;
}

/** Moves `selectedId` to the conversation `offset` positions away from the current one within
 *  `filteredConversations` (wrapping around), emitting `select` exactly as clicking a row does. */
function selectByOffset(offset: number): void {
  const list = filteredConversations.value;
  if (list.length === 0) return;
  const currentIndex = list.findIndex((c) => c.id === props.selectedId);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
  emit('select', list[nextIndex]!.id);
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
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.shiftKey) return;
  if (isEditingContext(event)) return;
  if (event.code === 'KeyA' && event.altKey && !event.ctrlKey) {
    event.preventDefault();
    toggleFilter();
    return;
  }
  if (event.altKey && event.ctrlKey && event.code === 'KeyJ') {
    event.preventDefault();
    selectByOffset(1);
    return;
  }
  if (event.altKey && event.ctrlKey && event.code === 'KeyK') {
    event.preventDefault();
    selectByOffset(-1);
  }
}

/** Explains what "Primary" means everywhere the word appears in this panel (FR-027/FR-009: Main
 *  stays Primary by default — this is purely explanatory, it changes no behaviour). */
const PRIMARY_EXPLANATION =
  'Edits from this conversation apply to the document automatically, with no review step.';

// FR-007g: a one-time, dismissible inline notice the first time a user sees a Primary badge —
// after that it stays out of the way; the tooltip above remains available on demand.
const PRIMARY_NOTICE_KEY = 'raidr:primaryNoticeDismissed';
const primaryNoticeDismissed = ref(localStorage.getItem(PRIMARY_NOTICE_KEY) === '1');
function dismissPrimaryNotice(): void {
  primaryNoticeDismissed.value = true;
  localStorage.setItem(PRIMARY_NOTICE_KEY, '1');
}

// FR-043d: opening the busy-switch warning moves focus to its first choice; Escape (or Cancel)
// returns focus to the "Make Primary" button that triggered it.
useFocusTrap(busyDialogEl, busyDialogOpen, { onEscape: () => void resolveBusyPrompt('cancel') });

onMounted(() => {
  if (!store.loaded) void store.load();
  document.addEventListener('keydown', onGlobalKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});

function conversationName(id: string | null): string {
  if (!id) return 'none';
  return store.conversations.find((c) => c.id === id)?.name ?? id;
}

// Fix (primary-action placement): "Make Primary" used to be a per-row button next to every
// conversation's title. Per feedback it shouldn't compete for attention on every single row — it
// now lives colocated with "Clear Primary" in the summary/header area instead, contextually
// targeting whichever conversation is currently *selected* (so choosing a row and then acting on
// it reads the same way selection drives every other per-conversation action in this panel).
const selectedConversation = computed(() => store.conversations.find((c) => c.id === props.selectedId) ?? null);
const canMakeSelectedPrimary = computed(() => {
  const conv = selectedConversation.value;
  return conv !== null && !conv.isPrimary && conv.status !== 'closed';
});

// Fix (no layout jump): the "Make Primary" button used to pop in/out (`v-if="canMakeSelectedPrimary"`)
// as the user browsed different conversations, reflowing `.primary-summary`. It now always renders
// and is `disabled` instead — `canMakeSelectedPrimary` still drives eligibility, just repurposed to
// feed `disabled` rather than `v-if`. A disabled button with no explanation is unhelpful, so
// `makePrimaryTitle` below picks the single most relevant reason (unselected > already-primary >
// closed > errored) to surface as both `title` and `aria-label`.
const makePrimaryDisabled = computed(() => {
  if (!canMakeSelectedPrimary.value) return true;
  const conv = selectedConversation.value!;
  return primaryBusyId.value === conv.id || conv.status === 'errored';
});
const makePrimaryTitle = computed(() => {
  const conv = selectedConversation.value;
  if (!conv) return 'Select a conversation to make it Primary';
  if (conv.isPrimary) return 'This conversation is already Primary';
  if (conv.status === 'closed') return "Closed conversations can't be made Primary";
  if (conv.status === 'errored') return 'An errored conversation cannot be designated Primary';
  return `Make Primary — ${PRIMARY_EXPLANATION}`;
});

// Fix (redundant text): the "Primary: {{ name }}" text line was removed from `.primary-summary` —
// Primary is now indicated on the row itself (accent border/tint + ★ icon). "Clear Primary" stays
// (there's genuinely nothing to clear when there's no Primary, unlike Make-primary's per-selection
// reflow issue above — this only changes on the rarer event of Primary itself changing), but with
// the conversation's name gone from the visible text, its `title`/`aria-label` now name which
// conversation it targets so that context isn't lost.
const clearPrimaryTitle = computed(() => {
  const conv = primaryConversation.value;
  return conv ? `Clear Primary (${conv.name}) — ${PRIMARY_EXPLANATION}` : undefined;
});

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

async function clearPrimary(): Promise<void> {
  const current = store.conversations.find((c) => c.isPrimary);
  if (!current) return;
  primaryError.value = null;
  try {
    await store.clearPrimary(current.id);
  } catch (err) {
    primaryError.value = err instanceof Error ? err.message : 'Failed to clear Primary.';
  }
}
</script>

<template>
  <nav class="hud-panel" aria-label="Conversations">
    <div class="hud-header">
      <h2>Conversations</h2>
      <!-- Fix (filter label): the toggle's own text ("Active only"/"All") changes with its state,
           but nothing said what the control *was* to a first-time user — a visible "Show:" prefix
           makes it read as a filter rather than an ambiguous standalone button. -->
      <div class="filter-control">
        <span class="filter-label">Show:</span>
        <button
          type="button"
          class="filter-toggle-button"
          :aria-pressed="filter === 'all'"
          :title="`Show ${filter === 'active' ? 'all conversations, including closed ones' : 'active conversations only'} (Alt+A)`"
          @click="toggleFilter"
        >
          {{ filter === 'active' ? 'Active only' : 'All' }}
        </button>
      </div>
    </div>
    <div v-if="hasPrimary && !primaryNoticeDismissed" class="primary-notice" role="note">
      <span><strong>Primary</strong>: {{ PRIMARY_EXPLANATION }}</span>
      <button type="button" class="dismiss-notice-button" aria-label="Dismiss Primary notice" @click="dismissPrimaryNotice">
        Dismiss
      </button>
    </div>
    <p class="primary-summary">
      <!-- Fix (redundant text): "Primary: {{ name }}" used to duplicate what the row itself now
           shows (accent border/tint + ★ icon) — dropped. "Clear Primary" stays, contextual to
           whichever conversation currently holds it, so `clearPrimaryTitle` above now carries
           that name that's no longer in the visible text. -->
      <button v-if="hasPrimary" type="button" class="clear-primary-button" :title="clearPrimaryTitle" :aria-label="clearPrimaryTitle" @click="clearPrimary">
        Clear Primary
      </button>
      <span v-else class="badge no-primary-badge">No Primary — every conversation stages its edits</span>
      <!-- Fix (primary-action placement): colocated with Clear Primary above, rather than a
           button on every row — contextual to the currently *selected* conversation.
           Fix (no layout jump): always rendered (no `v-if`) so `.primary-summary` doesn't
           reflow as the user browses conversations — `disabled` + a reason-specific
           title/aria-label communicate eligibility instead. -->
      <button
        type="button"
        class="make-primary-button"
        :disabled="makePrimaryDisabled"
        :title="makePrimaryTitle"
        :aria-label="makePrimaryTitle"
        @click="selectedConversation && makePrimary(selectedConversation.id)"
      >
        Make primary
      </button>
    </p>
    <div v-if="primaryError" class="error-banner" role="alert">{{ primaryError }}</div>

    <ul>
      <!-- UI convention: every conversation row is a 2-section layout — title | status (see
           .specify/memory/constitution.md "UI Conventions"). Previously a 3rd, middle section
           held a per-row "Make Primary" button; per feedback that action shouldn't sit next to
           every row's title, so it moved to the panel's summary/header area (see
           `.primary-summary` above, always rendered there and gated on `canMakeSelectedPrimary`
           via `disabled` rather than `v-if`) and this middle slot was removed outright.
           `.conversation-row` is the flex/grid container (not a button, so the
           title can still be a true nested control); its own @click reproduces the previous
           click-anywhere-in-the-row selection behavior via ordinary event bubbling from its
           descendants. The title itself stays a real, natively keyboard-operable <button> (Tab to
           focus, Enter/Space activates — its click bubbles up and is caught by the same handler,
           so keyboard selection is unchanged); the status badge plus every other existing badge
           (stale/pending/queue) are grouped on the right. The Primary conversation no longer gets
           a text "Primary" badge here either — see `.conversation-row.is-primary` below, which
           indicates it via a left accent + subtle background tint (never color alone: a
           `title` on the row plus a `.visually-hidden` label on the title button keep it
           identifiable for screen-reader users, and the small icon is a non-color-dependent visual
           cue too). A separate "Read-only" badge used to sit next to the status badge here too,
           but a closed conversation's `data-status` badge already says "closed" — read-only is
           implied, not new information — so it was removed (see ConversationView.vue's
           `.readonly-banner` for the one spot that still earns its keep, since it explains *why*
           editing is disabled rather than just re-labelling the status). -->
      <li v-for="conv in filteredConversations" :key="conv.id" :style="{ paddingLeft: `${conv.branchDepth * 0.75}rem` }">
        <div
          class="conversation-row"
          :class="{ selected: conv.id === props.selectedId, 'is-primary': conv.isPrimary }"
          :title="conv.isPrimary ? `Primary conversation — ${PRIMARY_EXPLANATION}` : undefined"
          @click="emit('select', conv.id)"
        >
          <button
            type="button"
            class="conversation-title"
            :aria-current="conv.id === props.selectedId ? 'true' : undefined"
          >
            <span v-if="conv.isPrimary" class="primary-icon" aria-hidden="true">★</span>
            <span v-if="conv.isPrimary" class="visually-hidden">Primary conversation. </span>
            <span class="name">{{ conv.name }}</span>
          </button>
          <span class="conversation-status-cell">
            <span class="badge status-badge" :data-status="conv.status">{{ conv.status }}</span>
            <span
              v-if="conv.isStale"
              class="badge stale-badge"
              title="Stale: the document has changed since this conversation last saw it. Use &quot;Refresh + Send&quot; to update its context before sending."
              >Stale</span
            >
            <span v-if="conv.pendingEditCount > 0" class="badge pending-badge">{{ conv.pendingEditCount }}</span>
            <span v-if="store.queueInfo[conv.id]" class="badge queue-badge">
              Queued #{{ store.queueInfo[conv.id]!.queuePosition }}
            </span>
          </span>
        </div>
      </li>
    </ul>

    <div v-if="busyPrompt" class="modal-overlay primary-busy-dialog-overlay">
      <div
        ref="busyDialogEl"
        class="primary-busy-dialog"
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
  </nav>
</template>

<style scoped>
.hud-panel {
  overflow-y: auto;
  height: 100%;
  padding: 0.5rem;
  text-align: left;
  border-right: 1px solid var(--border-color, #ddd);
  /* Fix 2: a physically distinct surface (not just the page background) so this HUD zone reads
     as a separate region from the transcript below it in the conversation sidebar. */
  background: var(--panel-bg, #f7f7f8);
  border-bottom: 2px solid var(--border-color, #ccc);
}
.hud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.filter-control {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex: 0 0 auto;
}
.filter-label {
  font-size: 0.7rem;
  color: var(--neutral-muted-color, #4b5563);
}
.filter-toggle-button {
  flex: 0 0 auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
.hud-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hud-panel li {
  padding-bottom: 0.3rem;
  margin-bottom: 0.3rem;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.hud-panel li:last-child {
  border-bottom: none;
}
/* UI convention: title | status, laid out as 2 side-by-side sections in one row (see
   .specify/memory/constitution.md "UI Conventions"). A <div>, not a <button>, so the title can
   still be a true nested control; clicking anywhere in the row (including over the status badges,
   exactly as before) still selects the conversation — see the template comment above for how. */
.conversation-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.conversation-row.selected {
  border-color: var(--border-color, #999);
  background: var(--row-selected-bg, rgba(0, 0, 0, 0.05));
}
/* Fix (Primary indicator): the text "Primary" badge that used to sit in the status cell was
   removed in favor of styling the row itself — a left accent bar plus a subtle background tint
   (both via `box-shadow` so they layer independently of `.selected`'s own `border`/`background`,
   letting the two states combine instead of fighting over the same properties). Never color
   alone: the row also carries a `title` (see template) and the title button carries a
   `.visually-hidden` "Primary conversation" label plus a small `★` icon, so screen-reader and
   colorblind users can still tell which conversation is Primary. */
.conversation-row.is-primary {
  box-shadow:
    inset 3px 0 0 0 var(--accent-color, #2563eb),
    inset 0 0 0 999px var(--user-bubble-bg, rgba(37, 99, 235, 0.08));
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
.stale-badge {
  /* Fix: #b45309 fell to 4.22:1 against this row's darkened `.selected` tint — below 4.5:1. */
  color: var(--warning-color, #92400e);
}
.pending-badge {
  color: var(--status-active-color, #1d4ed8);
}
.queue-badge {
  color: var(--queue-color, #6b21a8);
}
/* Fix 4: color-code conversation status, layered on top of the (unchanged) text label — never
   relying on color alone (FR-043c). */
.status-badge[data-status='idle'] {
  color: var(--neutral-muted-color, #4b5563);
}
.status-badge[data-status='working'] {
  color: var(--status-active-color, #1d4ed8);
}
.status-badge[data-status='errored'] {
  color: var(--danger-color, #b91c1c);
}
.status-badge[data-status='closed'] {
  color: var(--status-closed-color, #374151);
}
.primary-summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  margin: 0 0 0.5rem;
}
.primary-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  margin-bottom: 0.5rem;
  background: var(--info-bg, #eff6ff);
  color: var(--info-color, #1e3a8a);
  border: 1px solid var(--info-border, #bfdbfe);
  border-radius: 4px;
  font-size: 0.75rem;
}
.dismiss-notice-button {
  flex: 0 0 auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
.no-primary-badge {
  /* Fix: #6b7280 was a razor-thin 4.52:1 against the plain panel background and an outright
     failing 4.06:1 against the darkened `.selected` row tint (same fix as `.stale-badge` above). */
  color: var(--neutral-muted-color, #4b5563);
}
.clear-primary-button,
.make-primary-button {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  margin-left: 0.35rem;
}
.error-banner {
  padding: 0.4rem 0.5rem;
  margin-bottom: 0.5rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
  font-size: 0.8rem;
}
.primary-busy-dialog-overlay {
  z-index: 60;
}
.primary-busy-dialog {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  max-width: 22rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.primary-busy-choices {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
</style>
