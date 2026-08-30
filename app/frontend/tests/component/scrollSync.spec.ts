import { describe, expect, it } from 'vitest';
import { attachScrollSync, scrollRatioOf } from '../../src/composables/scrollSync.js';

// New feature: synchronized scrolling between the Editor pane (DocumentCanvas.vue's own native
// scroll container) and the Preview pane (PreviewComponent.vue's `.preview-pane`). Proportional
// scroll position (scrollTop / (scrollHeight - clientHeight)), not a precise line/offset mapping —
// see composables/scrollSync.ts's own doc comment for why. Tested here as plain DOM elements
// (jsdom doesn't lay out real content, so scrollHeight/clientHeight/scrollTop are stubbed directly
// via Object.defineProperty) rather than mounting either Vue component — this is the composable
// App.vue wires both panes' exposed `scrollEl` into, independent of either component's own
// rendering.

// jsdom (this project's test environment, tests/setup.ts) doesn't implement
// `requestAnimationFrame` — the composable only uses it to clear its feedback-loop guard on the
// next frame, so a `setTimeout`-backed stand-in is equivalent for every test below.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame;
}

function makeScrollableEl(overrides: { scrollTop?: number; scrollHeight: number; clientHeight: number }): HTMLDivElement {
  const el = document.createElement('div');
  let scrollTop = overrides.scrollTop ?? 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, 'scrollHeight', { value: overrides.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: overrides.clientHeight, configurable: true });
  return el;
}

function flushRaf(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('scrollRatioOf', () => {
  it('computes scrollTop / (scrollHeight - clientHeight), clamped to [0, 1]', () => {
    expect(scrollRatioOf({ scrollTop: 50, scrollHeight: 200, clientHeight: 100 })).toBeCloseTo(0.5);
    expect(scrollRatioOf({ scrollTop: 0, scrollHeight: 200, clientHeight: 100 })).toBe(0);
    expect(scrollRatioOf({ scrollTop: 100, scrollHeight: 200, clientHeight: 100 })).toBe(1);
  });

  it('is 0 for a pane with nothing to scroll (scrollHeight <= clientHeight)', () => {
    expect(scrollRatioOf({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0);
    expect(scrollRatioOf({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(0);
  });
});

describe('attachScrollSync', () => {
  it('while enabled, scrolling pane A moves pane B to the same proportional position', async () => {
    const a = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 }); // 800px scrollable
    const b = makeScrollableEl({ scrollHeight: 500, clientHeight: 100 }); // 400px scrollable
    attachScrollSync(a, b, () => true);

    a.scrollTop = 400; // ratio 0.5
    a.dispatchEvent(new Event('scroll'));
    await flushRaf();

    expect(b.scrollTop).toBeCloseTo(200); // 0.5 * 400
  });

  it('while enabled, scrolling pane B moves pane A to the same proportional position', async () => {
    const a = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    const b = makeScrollableEl({ scrollHeight: 500, clientHeight: 100 });
    attachScrollSync(a, b, () => true);

    b.scrollTop = 100; // ratio 0.25
    b.dispatchEvent(new Event('scroll'));
    await flushRaf();

    expect(a.scrollTop).toBeCloseTo(200); // 0.25 * 800
  });

  it('while disabled, scrolling either pane leaves the other untouched', async () => {
    const a = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    const b = makeScrollableEl({ scrollHeight: 500, clientHeight: 100 });
    attachScrollSync(a, b, () => false);

    a.scrollTop = 400;
    a.dispatchEvent(new Event('scroll'));
    await flushRaf();

    expect(b.scrollTop).toBe(0);
  });

  it('guards against feedback loops: the sync-triggered scroll on the target pane is ignored, not re-synced back', async () => {
    const a = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    const b = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    attachScrollSync(a, b, () => true);

    a.scrollTop = 500;
    a.dispatchEvent(new Event('scroll'));
    // A real browser fires a native 'scroll' event on `b` synchronously off the assignment the
    // handler above just made to `b.scrollTop` — jsdom doesn't, so this simulates that echo
    // explicitly. The guard (a `syncing` flag, still set at this point) must swallow it.
    b.dispatchEvent(new Event('scroll'));
    await flushRaf();

    expect(a.scrollTop).toBeCloseTo(500);
    expect(b.scrollTop).toBeCloseTo(500);
  });

  it('removes both listeners once detached, so neither pane is touched afterward', async () => {
    const a = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    const b = makeScrollableEl({ scrollHeight: 1000, clientHeight: 200 });
    const detach = attachScrollSync(a, b, () => true);
    detach();

    a.scrollTop = 500;
    a.dispatchEvent(new Event('scroll'));
    await flushRaf();

    expect(b.scrollTop).toBe(0);
  });
});
