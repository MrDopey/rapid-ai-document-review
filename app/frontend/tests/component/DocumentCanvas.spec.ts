import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import DocumentCanvas from '../../src/components/canvas/DocumentCanvas.vue';
import EditorComponent from '../../src/components/editor/EditorComponent.vue';
import { loadEditorSplit, persistEditorSplit } from '../../src/composables/panePersistence.js';

// Bug-fix (editor-vs-canvas scope fix): `App.vue` used to hide the *whole* `DocumentCanvas` pane
// (editor AND the conversation sidebar/`.thread-columns`) via its own `v-show="canvasVisible"` on
// `<DocumentCanvas>` — hiding the editor also made the conversation sidebar unusable, which was
// never the intent (the only reason to hide the editor is to give the sidebar more room). The gate
// moved down into this component as the `editorVisible` prop, applied via `v-show` to just
// `EditorComponent` — `.thread-columns` now has no such gate and always renders. `EditorComponent`
// and `ConversationThreadBox` are stubbed here (this suite only cares about DocumentCanvas's own
// visibility wiring, not either child's internals — same convention MessageBubble.spec.ts's
// "ConversationDetailPanel/ConversationView" suite already uses for its own heavy children).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const STUBS = {
  ConversationThreadBox: true,
};

function mountCanvas(pinia: Pinia, editorVisible?: boolean): VueWrapper {
  return mount(DocumentCanvas, {
    props: {
      modelValue: '# Hello',
      filter: 'all',
      focusedConversationIds: new Set<string>(),
      maxFocusedConversations: 3,
      ...(editorVisible === undefined ? {} : { editorVisible }),
    },
    global: { plugins: [pinia], stubs: STUBS },
  });
}

describe('DocumentCanvas.vue — editorVisible prop (editor-vs-canvas scope fix)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to showing the editor when the prop is omitted', () => {
    const wrapper = mountCanvas(pinia);
    expect(wrapper.findComponent(EditorComponent).isVisible()).toBe(true);
    expect(wrapper.find('.thread-columns').isVisible()).toBe(true);
  });

  it('hides only the editor when editorVisible is false — the conversation sidebar (.thread-columns) stays visible', () => {
    const wrapper = mountCanvas(pinia, false);
    expect(wrapper.findComponent(EditorComponent).isVisible()).toBe(false);
    expect(wrapper.find('.thread-columns').isVisible()).toBe(true);
  });

  it('expands .thread-columns to fill the freed width once the editor is hidden', () => {
    const shown = mountCanvas(pinia, true);
    const hidden = mountCanvas(pinia, false);
    expect((shown.get('.thread-columns').element as HTMLElement).style.width).not.toBe('100%');
    expect((hidden.get('.thread-columns').element as HTMLElement).style.width).toBe('100%');
  });

  it('re-shows the editor (without disturbing the sidebar) when editorVisible flips back to true', async () => {
    const wrapper = mountCanvas(pinia, false);
    expect((wrapper.findComponent(EditorComponent).element as HTMLElement).style.display).toBe('none');
    await wrapper.setProps({ editorVisible: true });
    expect((wrapper.findComponent(EditorComponent).element as HTMLElement).style.display).not.toBe('none');
    expect(wrapper.find('.thread-columns').isVisible()).toBe(true);
  });
});

// Second, independent drag-to-resize splitter (Editor | Conversation sidebar) — one level down
// from App.vue's own Preview|Canvas splitter, but entirely local to this component (its own ref,
// its own `raidr:editorSplit` localStorage key, its own `useResizeHandle` instance/container).
// Same jsdom-quirk workarounds App.spec.ts's own Preview|Canvas resize suite already documents:
// `.getBoundingClientRect()` is stubbed directly (jsdom gives every element a zero-size rect by
// default), and drag gestures are simulated with `MouseEvent`s carrying a `pointermove`/`pointerup`
// `type` (jsdom has no global `PointerEvent` constructor, but `useResizeHandle`'s window-level
// listeners are registered by event `type` string, so this reaches the same code path).
describe('DocumentCanvas.vue — Editor|Conversation-sidebar resize handle', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
  });

  /** Stubs `.document-canvas`'s own `getBoundingClientRect()` — the element `editorThreadResize`'s
   *  `containerEl` (this component's `canvasEl`) reads from mid-gesture — to a fixed, known width. */
  function stubCanvasWidth(wrapper: VueWrapper, width: number): void {
    const el = wrapper.get('.document-canvas').element as HTMLDivElement;
    el.getBoundingClientRect = () =>
      ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }

  /** Reads the editor pane's own rendered `width` percentage straight off `EditorComponent`'s root
   *  element (`.editor-pane`) — a direct, black-box read of what the drag gesture just computed
   *  into `editorFraction`. */
  function readEditorWidthPercent(wrapper: VueWrapper): number {
    const style = (wrapper.findComponent(EditorComponent).element as HTMLElement).style.width;
    const match = style.match(/^([\d.]+)%$/);
    if (!match) throw new Error(`Could not parse an editor pane width percentage from: "${style}"`);
    return Number(match[1]);
  }

  function readThreadColumnsWidthPercent(wrapper: VueWrapper): number {
    const style = (wrapper.get('.thread-columns').element as HTMLElement).style.width;
    const match = style.match(/^([\d.]+)%$/);
    if (!match) throw new Error(`Could not parse a .thread-columns width percentage from: "${style}"`);
    return Number(match[1]);
  }

  async function drag(wrapper: VueWrapper, fromClientX: number, toClientX: number): Promise<void> {
    await wrapper.get('.editor-thread-handle').trigger('pointerdown', { clientX: fromClientX });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: toClientX }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    await wrapper.vm.$nextTick();
  }

  it('is not rendered when editorVisible is false — nothing to resize against', () => {
    const wrapper = mountCanvas(pinia, false);
    expect(wrapper.find('.editor-thread-handle').exists()).toBe(false);
    // `.thread-columns` still correctly expands to 100% on its own, unaffected by this splitter.
    expect((wrapper.get('.thread-columns').element as HTMLElement).style.width).toBe('100%');
  });

  it('is rendered (and draggable) whenever editorVisible is true', () => {
    const wrapper = mountCanvas(pinia, true);
    expect(wrapper.find('.editor-thread-handle').exists()).toBe(true);
  });

  it('clamps the editor pane to exactly 30% of the total width when dragged far past that minimum', async () => {
    const wrapper = mountCanvas(pinia, true);
    stubCanvasWidth(wrapper, 1000);

    await drag(wrapper, 500, -1000);

    expect(readEditorWidthPercent(wrapper)).toBeCloseTo(30, 0);
    expect(readThreadColumnsWidthPercent(wrapper)).toBeCloseTo(70, 0);
  });

  it('clamps the conversation sidebar to exactly 30% of the total width when dragged far past that minimum', async () => {
    const wrapper = mountCanvas(pinia, true);
    stubCanvasWidth(wrapper, 1000);

    await drag(wrapper, 500, 2000);

    expect(readEditorWidthPercent(wrapper)).toBeCloseTo(70, 0);
    expect(readThreadColumnsWidthPercent(wrapper)).toBeCloseTo(30, 0);
  });

  it('scales the 30% floor with the container width rather than using a fixed pixel minimum', async () => {
    const wrapper = mountCanvas(pinia, true);
    stubCanvasWidth(wrapper, 2000);

    await drag(wrapper, 500, -3000);

    // 30% of a 2000px container (600px) = 30% either way — re-expressed here as a fraction check
    // rather than a raw px one, since this splitter's math is fraction-of-container throughout.
    expect(readEditorWidthPercent(wrapper)).toBeCloseTo(30, 0);
  });

  it('restores a previously persisted split fraction on mount', () => {
    persistEditorSplit(0.42);
    const wrapper = mountCanvas(pinia, true);
    expect(readEditorWidthPercent(wrapper)).toBeCloseTo(42, 0);
  });

  it('persists the fraction reached by a drag, independently of App.vue-level paneSizes/visibility keys', async () => {
    const wrapper = mountCanvas(pinia, true);
    stubCanvasWidth(wrapper, 1000);

    await drag(wrapper, 500, 700); // +200px right

    expect(loadEditorSplit(-1)).toBeCloseTo(0.7, 1);
    expect(localStorage.getItem('raidr:paneSizes')).toBeNull();
    expect(localStorage.getItem('raidr:previewVisible')).toBeNull();
  });

  it('never lets .thread-columns shrink below its existing branch-column min-width, even under an extreme drag', async () => {
    const wrapper = mountCanvas(pinia, true);
    stubCanvasWidth(wrapper, 1000);
    const threadColumnsEl = wrapper.get('.thread-columns').element as HTMLElement;
    const minWidthPx = Number(threadColumnsEl.style.minWidth.replace('px', ''));

    await drag(wrapper, 500, 2000); // drag as far right (editor-growing) as possible

    // `min-width` is left untouched by this splitter (see `threadColumnsWidth` in the component) —
    // still present and still the same value after the most aggressive possible drag.
    expect(Number(threadColumnsEl.style.minWidth.replace('px', ''))).toBe(minWidthPx);
  });
});
