<script setup lang="ts">
import type { Change } from 'diff';

const props = defineProps<{
  parts: Change[];
  side: 'unified' | 'left' | 'right';
}>();

const included = (part: Change): boolean => {
  if (props.side === 'left') return !part.added;
  if (props.side === 'right') return !part.removed;
  return true;
};
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <del v-if="part.removed && included(part)" class="removed">
      <span class="marker" aria-hidden="true">−</span>
      <span class="visually-hidden">removed:</span>{{ part.value }}
    </del>
    <ins v-else-if="part.added && included(part)" class="added">
      <span class="marker" aria-hidden="true">+</span>
      <span class="visually-hidden">added:</span>{{ part.value }}
    </ins>
    <span v-else-if="included(part)">{{ part.value }}</span>
  </template>
</template>

<style scoped>
.removed {
  color: var(--danger-color, #991b1b);
  background: var(--danger-bg, #fee2e2);
  text-decoration: line-through;
}
.added {
  color: var(--success-color, #065f46);
  background: var(--success-bg, #d1fae5);
  text-decoration: none;
}
.marker {
  font-weight: 700;
  margin-right: 0.15rem;
}
</style>
