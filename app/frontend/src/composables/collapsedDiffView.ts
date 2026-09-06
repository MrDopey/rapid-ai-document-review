import { type Ref, computed, ref, watch } from 'vue';
import type { Change } from 'diff';
import {
  splitIntoLines,
  groupByContext,
  type DiffGroup,
} from '../components/diff/collapseUnchanged.js';

/**
 * Shared "focus on changes" / collapsed-unchanged-hunks state and logic behind both DiffViewer.vue
 * (Full document / Side by side tabs) and RevisionDiffViewer.vue (Unified / Side by side tabs).
 *
 * FR-focused-diff: those views default to a collapsed, context-window view (like a classic unified
 * diff) so a reviewer isn't stuck scrolling past long unchanged stretches; "Show full document"
 * (`focusedView = false`) reveals everything. Manually-expanded collapsed groups are tracked by
 * index and reset whenever `resetExpanded()` is called (a freshly-loaded diff's groups don't line
 * up with the old ones) and whenever `focusedView` is toggled off and back on (so re-focusing
 * returns to the default collapsed state rather than remembering a prior look's expansions).
 *
 * `diffParts` is a ref/computed of the current `Change[]` diff (or `null` while nothing is loaded
 * yet); `contextLines` is how many unchanged lines of context to keep visible around each change.
 */
export function useCollapsedDiffGroups(diffParts: Ref<Change[] | null>, contextLines: number) {
  const focusedView = ref(true);
  const expandedGroupIndexes = ref<Set<number>>(new Set());

  function resetExpanded(): void {
    expandedGroupIndexes.value = new Set();
  }

  function expandGroup(index: number): void {
    expandedGroupIndexes.value = new Set(expandedGroupIndexes.value).add(index);
  }

  function isGroupVisible(group: DiffGroup, index: number): boolean {
    return group.type === 'visible' || expandedGroupIndexes.value.has(index);
  }

  watch(focusedView, () => {
    resetExpanded();
  });

  const groups = computed(() =>
    groupByContext(splitIntoLines(diffParts.value ?? []), contextLines),
  );

  return { focusedView, expandedGroupIndexes, isGroupVisible, expandGroup, resetExpanded, groups };
}
