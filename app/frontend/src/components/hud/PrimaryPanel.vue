<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { ApiError } from '../../transport/http-client.js';
import type { PrimaryWhenBusy } from '@rapid-ai-document-review/shared/contracts/http';
import { useFocusTrap } from '../../a11y/focus-manager.js';

// 006-toolbar-reorg (confirmed layout): split out of HudPanel.vue, which used to render the
// Primary notice/summary (plus this busy-switch dialog) inline above its own filter/conversation
// list. The confirmed toolbar redesign gives Primary its own visually-boxed section in App.vue's
// right-hand column, entirely decoupled from the HUD's filter+list box — this component now owns
// exactly that content (and the busy-switch dialog it can open) and nothing else. `activeId`
// mirrors HudPanel.vue's own prop of the same name (App.vue's `lastInteractedId`): Make/Clear
// Primary still targets whichever conversation is currently "active" system-wide, a concept that
// doesn't belong to the HUD list any more than it belongs here.
const props = defineProps<{ activeId: string | null }>();
// `update:error` mirrors this panel's own `primaryError` state up to App.vue, which renders the
// actual banner as a full-width strip beneath both toolbar columns (per the confirmed layout, the
// error is pulled out of this box entirely) — this component still owns the read/write logic for
// when an error occurs, it just also surfaces the current value for App.vue to render elsewhere,
// the same "controlled value, locally-owned writes" split HudPanel.vue's `update:filter` uses.
const emit = defineEmits<{ (e: 'update:error', value: string | null): void }>();
const store = useConversationsStore();

/** FR-029: the target/current-Primary-busy warning, offering exactly the three `whenBusy`
 *  choices — set only while a designation request is awaiting the user's decision. */
const busyPrompt = ref<{ conversationId: string; currentPrimaryId: string | null; busyConversationId: string } | null>(
  null,
);
const primaryError = ref<string | null>(null);
watch(primaryError, (value) => emit('update:error', value));

const primaryBusyId = ref<string | null>(null);
const busyDialogEl = ref<HTMLElement | null>(null);

const primaryConversation = computed(() => store.conversations.find((c) => c.isPrimary) ?? null);
const hasPrimary = computed(() => primaryConversation.value !== null);
const busyDialogOpen = computed(() => busyPrompt.value !== null);

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
// App.vue's global Ctrl+Alt+P handler calls this directly via a template ref — a one-shot action
// matching the existing "Dismiss" button, not a toggle; a no-op once already dismissed (the
// notice, and its Dismiss button, are simply gone by then).
defineExpose({ dismissNotice: dismissPrimaryNotice });

// FR-043d: opening the busy-switch warning moves focus to its first choice; Escape (or Cancel)
// returns focus to the "Make Primary" button that triggered it.
useFocusTrap(busyDialogEl, busyDialogOpen, { onEscape: () => void resolveBusyPrompt('cancel') });

function conversationName(id: string | null): string {
  if (!id) return 'none';
  return store.conversations.find((c) => c.id === id)?.name ?? id;
}

// Fix (primary-action placement): "Make Primary" targets whichever conversation is currently
// *active* (App.vue's `lastInteractedId`, passed down as `activeId`) so choosing a row and then
// acting on it reads the same way selection drives every other per-conversation action.
const activeConversation = computed(() => store.conversations.find((c) => c.id === props.activeId) ?? null);
const canMakeActivePrimary = computed(() => {
  const conv = activeConversation.value;
  return conv !== null && !conv.isPrimary && conv.status !== 'closed';
});

// Fix (no layout jump): "Make Primary" always renders and is `disabled` instead of `v-if`, so this
// box doesn't reflow as the user browses different conversations — `canMakeActivePrimary` still
// drives eligibility, just repurposed to feed `disabled` rather than `v-if`. A disabled button
// with no explanation is unhelpful, so `makePrimaryTitle` below picks the single most relevant
// reason (unselected > already-primary > closed > errored) to surface as both `title` and
// `aria-label`.
const makePrimaryDisabled = computed(() => {
  if (!canMakeActivePrimary.value) return true;
  const conv = activeConversation.value!;
  return primaryBusyId.value === conv.id || conv.status === 'errored';
});
const makePrimaryTitle = computed(() => {
  const conv = activeConversation.value;
  if (!conv) return 'Select a conversation to make it Primary';
  if (conv.isPrimary) return 'This conversation is already Primary';
  if (conv.status === 'closed') return "Closed conversations can't be made Primary";
  if (conv.status === 'errored') return 'An errored conversation cannot be designated Primary';
  return `Make Primary — ${PRIMARY_EXPLANATION}`;
});

// Fix (redundant text): Primary is indicated on the row itself (HudPanel.vue's accent border/tint
// + ★ icon), so "Clear Primary" carries no visible conversation name — its `title`/`aria-label`
// name which conversation it targets so that context isn't lost.
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
  <div class="primary-panel">
    <div v-if="hasPrimary && !primaryNoticeDismissed" class="primary-notice" role="note">
      <span><strong>Primary</strong>: {{ PRIMARY_EXPLANATION }}</span>
      <button type="button" class="dismiss-notice-button" aria-label="Dismiss Primary notice" @click="dismissPrimaryNotice">
        Dismiss
      </button>
    </div>
    <p class="primary-summary">
      <button v-if="hasPrimary" type="button" class="clear-primary-button" :title="clearPrimaryTitle" :aria-label="clearPrimaryTitle" @click="clearPrimary">
        Clear Primary
      </button>
      <span v-else class="badge no-primary-badge">No Primary — every conversation stages its edits</span>
      <button
        type="button"
        class="make-primary-button"
        :disabled="makePrimaryDisabled"
        :title="makePrimaryTitle"
        :aria-label="makePrimaryTitle"
        @click="activeConversation && makePrimary(activeConversation.id)"
      >
        Make primary
      </button>
    </p>

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
  </div>
</template>

<style scoped>
.primary-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.primary-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.8rem;
  margin: 0;
}
.primary-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  margin: 0;
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
     failing 4.06:1 against the darkened `.selected` row tint (same fix as HudPanel.vue's
     `.stale-badge`). */
  color: var(--neutral-muted-color, #4b5563);
}
.clear-primary-button,
.make-primary-button {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
.primary-busy-dialog-overlay {
  z-index: var(--z-overlay-primary, 60);
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
