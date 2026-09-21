// Shared rAF scheduling helper — extracted from `DocumentCanvas.vue`'s and `ThreadCard.vue`'s own
// identical pair of functions. jsdom (both components' own test environment) has no
// `requestAnimationFrame`/`cancelAnimationFrame` at all, unlike a real browser, so both fall back
// to `setTimeout`/`clearTimeout` when either is unavailable.
export const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0) as unknown as number;

export const cancelScheduledFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);
