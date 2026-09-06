import { defineStore } from 'pinia';
import type { DocumentDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { RevisionDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { RestoreRevisionResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient, ApiError } from '../transport/http-client.js';
import type { ServerFrame, WsClient } from '../transport/ws-client.js';

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DocumentState {
  document: DocumentDto | null;
  content: string;
  revisions: RevisionDto[];
  revisionsNextCursor: string | null;
  eventSequence: number;
  loaded: boolean;
  pendingPatchCount: number;
  // Set when the server rejected a manual edit because this tab's `baseRevision` was stale (the
  // document changed elsewhere — another tab, or a Primary-conversation agent edit — while this
  // edit was in flight). The rejected edit is never retried with its now-stale offsets; `content`
  // is instead resynced from the server and this message is left for a UI surface to show the
  // user their edit wasn't saved and needs to be redone. Cleared via `clearConflictMessage`.
  conflictMessage: string | null;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useDocumentStore = defineStore('document', {
  state: (): DocumentState => ({
    document: null,
    content: '',
    revisions: [],
    revisionsNextCursor: null,
    eventSequence: 0,
    loaded: false,
    pendingPatchCount: 0,
    conflictMessage: null,
  }),

  actions: {
    async load(): Promise<void> {
      const result = await httpClient.getDocument();
      this.loaded = true;
      if (!result) {
        this.document = null;
        this.content = '';
        return;
      }
      this.document = result.document;
      this.content = result.content;
      this.eventSequence = result.eventSequence;
    },

    async create(content: string, title?: string): Promise<void> {
      const result = await httpClient.createDocument({ content, title });
      this.document = result.document;
      this.content = result.content;
      this.loaded = true;
    },

    // Retries indefinitely on network/server failure (e.g. a disconnected backend) rather than
    // dropping the edit — a manual edit that never left the browser is otherwise silently lost,
    // since the backend (the sole document authority) never saw it.
    //
    // The one failure this does NOT retry is a 409 (DocumentOutOfSyncError): that means the
    // backend rejected `changes` because `baseRevision` no longer matches — the document changed
    // shape elsewhere (another tab, or a Primary-conversation agent edit) while these offsets were
    // computed against this tab's local text. Unlike every other failure here, resubmitting the
    // same offsets can never be correct once that's happened — Automerge's CRDT convergence
    // guarantees don't make a stale numeric offset keep naming the same logical span — so instead
    // of retrying, this resyncs `content`/`document` from the server and leaves `conflictMessage`
    // set for the UI to tell the user their edit wasn't saved and needs to be redone.
    async patchContent(baseRevision: number, changes: { from: number; to: number; insert: string }[]): Promise<void> {
      this.pendingPatchCount += 1;
      try {
        let attempt = 0;
        for (;;) {
          try {
            await httpClient.patchDocument({ baseRevision, changes });
            return;
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              await this.load();
              this.conflictMessage =
                'This document changed elsewhere while you were editing. Your last edit was not saved — please redo it.';
              return;
            }
            const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
            attempt += 1;
            await delay(wait);
          }
        }
      } finally {
        this.pendingPatchCount -= 1;
      }
    },

    clearConflictMessage(): void {
      this.conflictMessage = null;
    },

    // Shared resync primitive for passive (event-driven) staleness detection — the content-hash
    // divergence check and the event-sequence gap check in `handleServerFrame` below. Guarded on
    // `pendingPatchCount` because a patch may still be in flight (this tab's own unsent edit):
    // refetching now would silently discard it under a snapshot that predates it. That guard does
    // NOT apply to `patchContent`'s own 409 handling above, which calls `load()` directly — there,
    // the in-flight patch IS the one just rejected, so resyncing immediately is correct.
    async resyncDocument(): Promise<void> {
      if (this.pendingPatchCount > 0) return;
      await this.load();
    },

    async loadRevisions(): Promise<void> {
      const page = await httpClient.listRevisions({ cursor: this.revisionsNextCursor ?? undefined });
      this.revisions = this.revisionsNextCursor ? [...this.revisions, ...page.revisions] : page.revisions;
      this.revisionsNextCursor = page.nextCursor;
    },

    // Returns the full response (rather than void) so callers — HistoryPanel.vue — can surface
    // `pendingProposalReconciliation` (http-api.md §POST /revisions/:revision/restore): a
    // read-only dry-run that never changes any proposal's status, so there is nothing else here
    // for this action itself to act on beyond passing it through.
    async restore(revision: number): Promise<RestoreRevisionResponse> {
      const result = await httpClient.restoreRevision(revision);
      this.content = result.content;
      if (this.document) {
        this.document = { ...this.document, currentRevision: result.currentRevision };
      }
      this.revisionsNextCursor = null;
      await this.loadRevisions();
      return result;
    },

    async exportRevision(revision?: number, download = false): Promise<string> {
      return httpClient.exportDocument({ revision, download });
    },

    async handleServerFrame(frame: ServerFrame): Promise<void> {
      if (frame.kind === 'subscribed') {
        const { content, ...document } = frame.frame.snapshot.document;
        this.document = document;
        this.eventSequence = frame.frame.currentSequence;
        // A patch is still in flight (retrying after a disconnect, most likely) — the snapshot
        // predates it, so applying it now would silently discard the not-yet-resent local edit.
        // The retry loop's eventual success (or the document_content_changed it produces) is
        // what reconciles content once caught up.
        if (this.pendingPatchCount === 0) {
          this.content = content;
        }
        return;
      }
      if (frame.kind !== 'event') return;
      const event = frame.frame;
      if (event.sequence !== null) {
        // A gap (this event's sequence isn't exactly one past what we last saw) means one or more
        // intervening events — of any type, not just `document_content_changed` — may have been
        // missed (e.g. a dropped WS frame). Resync rather than risk this tab silently operating on
        // a stale view; shares the same guarded resync primitive as the content-hash divergence
        // check below and `patchContent`'s 409 handling. Only meaningful once a real baseline is
        // established (`loaded`) — before that, `eventSequence` is just its `0` initial value, not
        // a prior server-confirmed position.
        if (this.loaded && event.sequence !== this.eventSequence + 1) {
          const hadPendingPatch = this.pendingPatchCount > 0;
          await this.resyncDocument();
          // `resyncDocument` already set `eventSequence` from the server's authoritative current
          // value when it ran `load()`; only need to manually catch up here when it no-op'd
          // (a patch was in flight) — and never move it backward past what `load()` reported.
          if (hadPendingPatch) {
            this.eventSequence = event.sequence;
          }
          return;
        }
        this.eventSequence = event.sequence;
      }

      switch (event.type) {
        case 'document_content_changed': {
          if (this.document) {
            this.document = { ...this.document, currentRevision: event.data.currentRevision };
          }
          const localHash = await sha256Hex(this.content);
          if (localHash !== event.data.contentHash) {
            // Divergence detected — the backend is authoritative; always safe to refetch
            // (Principle I). `resyncDocument` itself no-ops while a patch is in flight (see its
            // own comment) — refetching now would otherwise overwrite this tab's own unsent edit
            // with a snapshot that predates it; it self-resolves once the retry succeeds (whichever
            // document_content_changed comes after that will match).
            await this.resyncDocument();
          }
          break;
        }
        case 'revision_created':
          if (this.document) {
            this.document = { ...this.document, currentRevision: event.data.revision };
          }
          break;
        case 'revision_restored':
          this.content = event.data.content;
          if (this.document) {
            this.document = { ...this.document, currentRevision: event.data.revision };
          }
          break;
        default:
          break;
      }
    },

    // Registered by App.vue's connectWs — see there for why every store owns this.
    // `handleServerFrame` above is async; this fires it off without awaiting.
    subscribeToFrames(wsClient: WsClient): () => void {
      return wsClient.onFrame((frame) => {
        void this.handleServerFrame(frame);
      });
    },
  },
});
