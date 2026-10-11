import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ThreadComposer from '../../src/components/thread/ThreadComposer.vue';
import { useThreadStore } from '../../src/stores/thread.js';
import { useDocumentStore } from '../../src/stores/document.js';
import { httpClient } from '../../src/transport/http-client.js';

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    sendThreadMessage: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status = 0;
    code = 'UNKNOWN';
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

// Bug report: "in the threaded conversation view, when I type a message and hit Enter, the agent
// returns a message to the conversation, but then I lost my focus on the conversation." The send
// request stays in flight for the agent's ENTIRE turn (backend `conversationService.send` awaits
// the turn's own run before the POST resolves), so the composer's in-flight state lasts exactly as
// long as the reviewer is watching the reply stream in. During that whole window the composer must
// never lose the reviewer's cursor: the textarea stays enabled (disabling a focused textarea makes
// the browser blur it, and nothing would ever re-focus it) and keeps DOM focus after the send
// resolves, so the reviewer can type the follow-up message immediately without clicking back in.
describe('ThreadComposer — composer focus across a send', () => {
  let pinia: Pinia;
  let wrapper: VueWrapper<InstanceType<typeof ThreadComposer>>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.sendThreadMessage).mockReset();
    useDocumentStore().activeDocumentId = 'doc-1';
  });

  afterEach(() => {
    wrapper?.unmount();
  });

  function mountComposer(
    props: { threadId: string; disabled?: boolean } = { threadId: 'thread-1' },
  ) {
    // `attachTo: document.body` (same as App.spec.ts / ThreadModeView.spec.ts) so `.focus()`
    // actually moves `document.activeElement` — jsdom only tracks focus for attached elements.
    return mount(ThreadComposer, {
      props,
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
  }

  /** Defers the send request so the test can observe the in-flight window explicitly, mirroring
   *  the backend's one-request-per-whole-agent-turn behavior. */
  function startDeferredSend(): (value: { accepted: boolean }) => void {
    let resolveSend: (value: { accepted: boolean }) => void = () => {};
    vi.mocked(httpClient.sendThreadMessage).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    return resolveSend;
  }

  it('keeps the textarea enabled and focused while a send is in flight, and still focused after it resolves', async () => {
    const resolveSend = startDeferredSend();

    const store = useThreadStore();
    store.setThreadDraft('thread-1', 'please look at this');
    wrapper = mountComposer();

    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();

    const button = wrapper.get('button[type="submit"]').element as HTMLButtonElement;
    // The in-flight state is expressed on the SEND BUTTON (and `onSend`'s own guard) — not on the
    // textarea itself.
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Sending…');
    expect(textarea.disabled).toBe(false);
    // The reviewer's cursor is still in the composer while the agent's reply is streaming in.
    expect(document.activeElement).toBe(textarea);

    // The agent's reply arrives: the send request resolves and the composer is usable again.
    resolveSend({ accepted: true });
    await flushPromises();

    expect(textarea.disabled).toBe(false);
    // Draft cleared on success, ready for the follow-up message.
    expect(store.draftByThread['thread-1']).toBe('');
    // The button is disabled at this point only because the draft is empty — type the follow-up
    // (the reviewer's cursor is already in the textarea, so this is a pure keystroke) and the
    // composer must be fully usable again.
    await wrapper.get('textarea').setValue('thanks, looks good');
    expect(button.disabled).toBe(false);
    // Regression assertion: no click-back needed — focus survived the whole round trip.
    expect(document.activeElement).toBe(textarea);
  });

  it('does not send a second message when Enter is pressed again while the first send is in flight', async () => {
    const resolveSend = startDeferredSend();

    const store = useThreadStore();
    store.setThreadDraft('thread-1', 'first message');
    wrapper = mountComposer();

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    // The draft is only cleared on success, so a second Enter still sees text — the in-flight
    // guard, not the empty draft, is what must block the duplicate send.
    expect(store.draftByThread['thread-1']).toBe('first message');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(httpClient.sendThreadMessage).toHaveBeenCalledTimes(1);

    resolveSend({ accepted: true });
    await flushPromises();
    expect(httpClient.sendThreadMessage).toHaveBeenCalledTimes(1);
    expect(httpClient.sendThreadMessage).toHaveBeenCalledWith('doc-1', 'thread-1', 'first message');
  });

  it('keeps the textarea disabled for a done thread (disabled prop), even with no send in flight', () => {
    wrapper = mountComposer({ threadId: 'thread-1', disabled: true });
    expect(wrapper.get('textarea').element.disabled).toBe(true);
    expect(wrapper.get('button[type="submit"]').element.disabled).toBe(true);
  });
});
