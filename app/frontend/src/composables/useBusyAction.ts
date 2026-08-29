import { ref, type Ref } from 'vue';

/**
 * The busy-flag try/finally pattern repeated across AcceptAllButton.vue, DropAllButton.vue, and
 * EditsList.vue's per-row accept/drop handlers: set a flag before an async action starts, clear
 * it once the action settles (success or failure) so a disabled/label state never gets stuck on.
 *
 * `run` re-throws whatever `fn` throws (callers that need to surface an error, e.g. via a banner,
 * still can) — it only guarantees `busy` is reset afterwards.
 */
export function useBusyAction<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): { busy: Ref<boolean>; run: (...args: Args) => Promise<void> } {
  const busy = ref(false);

  async function run(...args: Args): Promise<void> {
    busy.value = true;
    try {
      await fn(...args);
    } finally {
      busy.value = false;
    }
  }

  return { busy, run };
}

/**
 * Same try/finally guarantee as `useBusyAction`, but for the "one busy item among many" shape
 * (EditsList.vue's per-row accept/drop: only the row being acted on should disable, not every
 * row) instead of a single boolean — `busyId` holds whichever id is currently in flight, or
 * `null`.
 */
export function useBusyId<Id = string>(): {
  busyId: Ref<Id | null>;
  run: (id: Id, fn: () => Promise<void>) => Promise<void>;
} {
  const busyId = ref<Id | null>(null) as Ref<Id | null>;

  async function run(id: Id, fn: () => Promise<void>): Promise<void> {
    busyId.value = id;
    try {
      await fn();
    } finally {
      busyId.value = null;
    }
  }

  return { busyId, run };
}
