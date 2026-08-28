<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

const hasPrimary = computed(() => store.conversations.some((c) => c.isPrimary));
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

// FR-043d: opening the busy-switch warning moves focus to its first choice; Escape (or Cancel)
// returns focus to the "Make Primary" button that triggered it.
useFocusTrap(busyDialogEl, busyDialogOpen, { onEscape: () => void resolveBusyPrompt('cancel') });

onMounted(() => {
  if (!store.loaded) void store.load();
});

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
    <h2>Conversations</h2>
    <div v-if="hasPrimary && !primaryNoticeDismissed" class="primary-notice" role="note">
      <span><strong>Primary</strong>: {{ PRIMARY_EXPLANATION }}</span>
      <button type="button" class="dismiss-notice-button" aria-label="Dismiss Primary notice" @click="dismissPrimaryNotice">
        Dismiss
      </button>
    </div>
    <p class="primary-summary">
      <span v-if="hasPrimary">
        Primary:
        <strong :title="PRIMARY_EXPLANATION">{{
          conversationName(store.conversations.find((c) => c.isPrimary)?.id ?? null)
        }}</strong>
        <button type="button" class="clear-primary-button" :title="`Clear Primary — ${PRIMARY_EXPLANATION}`" @click="clearPrimary">
          Clear Primary
        </button>
      </span>
      <span v-else class="badge no-primary-badge">No Primary — every conversation stages its edits</span>
    </p>
    <div v-if="primaryError" class="error-banner" role="alert">{{ primaryError }}</div>

    <ul>
      <li v-for="conv in store.conversations" :key="conv.id" :style="{ paddingLeft: `${conv.branchDepth * 0.75}rem` }">
        <button
          type="button"
          class="conversation-row"
          :class="{ selected: conv.id === props.selectedId }"
          :aria-current="conv.id === props.selectedId ? 'true' : undefined"
          @click="emit('select', conv.id)"
        >
          <span class="name">{{ conv.name }}</span>
          <span class="badge status-badge" :data-status="conv.status">{{ conv.status }}</span>
          <span v-if="conv.status === 'closed'" class="badge readonly-badge">Read-only</span>
          <span v-if="conv.isPrimary" class="badge primary-badge" :title="PRIMARY_EXPLANATION">Primary</span>
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
        </button>
        <button
          v-if="!conv.isPrimary && conv.status !== 'closed'"
          type="button"
          class="make-primary-button"
          :disabled="primaryBusyId === conv.id || conv.status === 'errored'"
          :title="
            conv.status === 'errored'
              ? 'An errored conversation cannot be designated Primary'
              : `Make Primary — ${PRIMARY_EXPLANATION}`
          "
          @click.stop="makePrimary(conv.id)"
        >
          Make Primary
        </button>
      </li>
    </ul>

    <div v-if="busyPrompt" class="primary-busy-dialog-overlay">
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
.hud-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hud-panel li {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.15rem;
}
.make-primary-button {
  align-self: flex-start;
}
.conversation-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid transparent;
  background: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.conversation-row.selected {
  border-color: var(--border-color, #999);
  background: rgba(0, 0, 0, 0.05);
}
.conversation-row .name {
  font-weight: 600;
  margin-right: auto;
}
.badge {
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  border: 1px solid currentColor;
}
.stale-badge {
  color: #b45309;
}
.pending-badge {
  color: #1d4ed8;
}
.readonly-badge {
  color: #6b7280;
}
.queue-badge {
  color: #6b21a8;
}
/* Fix 4: color-code conversation status, layered on top of the (unchanged) text label — never
   relying on color alone (FR-043c). */
.status-badge[data-status='idle'] {
  color: #4b5563;
}
.status-badge[data-status='working'] {
  color: #1d4ed8;
}
.status-badge[data-status='errored'] {
  color: #b91c1c;
}
.status-badge[data-status='closed'] {
  color: #374151;
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
  background: #eff6ff;
  color: #1e3a8a;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  font-size: 0.75rem;
}
.dismiss-notice-button {
  flex: 0 0 auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
.no-primary-badge {
  color: #6b7280;
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
  background: #fee2e2;
  color: #991b1b;
  font-size: 0.8rem;
}
.primary-busy-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
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
