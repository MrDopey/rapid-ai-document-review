<script setup lang="ts">
import { ref } from 'vue';
import { useEditsStore } from '../../stores/edits.js';

const props = defineProps<{ conversationId: string; disabled?: boolean }>();
const store = useEditsStore();
const busy = ref(false);

async function onClick(): Promise<void> {
  busy.value = true;
  try {
    await store.dropRemaining(props.conversationId);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button type="button" class="drop-all-button" :disabled="disabled || busy" @click="onClick">
    {{ busy ? 'Dropping…' : 'Drop remaining' }}
  </button>
</template>
