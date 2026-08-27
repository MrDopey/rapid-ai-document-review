import { defineStore } from 'pinia';
import type { DocumentDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { RevisionDto } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame } from '../transport/ws-client.js';

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
    // since the backend (the sole document authority) never saw it. Safe to retry with the
    // original offsets even after other edits land in between: Automerge merges splices as
    // CRDT operations, not raw offsets, so intent is preserved regardless of arrival order.
    async patchContent(baseRevision: number, changes: { from: number; to: number; insert: string }[]): Promise<void> {
      this.pendingPatchCount += 1;
      try {
        let attempt = 0;
        for (;;) {
          try {
            await httpClient.patchDocument({ baseRevision, changes });
            return;
          } catch {
            const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
            attempt += 1;
            await delay(wait);
          }
        }
      } finally {
        this.pendingPatchCount -= 1;
      }
    },

    async loadRevisions(): Promise<void> {
      const page = await httpClient.listRevisions({ cursor: this.revisionsNextCursor ?? undefined });
      this.revisions = this.revisionsNextCursor ? [...this.revisions, ...page.revisions] : page.revisions;
      this.revisionsNextCursor = page.nextCursor;
    },

    async restore(revision: number): Promise<void> {
      const result = await httpClient.restoreRevision(revision);
      this.content = result.content;
      if (this.document) {
        this.document = { ...this.document, currentRevision: result.currentRevision };
      }
      this.revisionsNextCursor = null;
      await this.loadRevisions();
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
        this.eventSequence = event.sequence;
      }

      switch (event.type) {
        case 'document_content_changed': {
          if (this.document) {
            this.document = { ...this.document, currentRevision: event.data.currentRevision };
          }
          const localHash = await sha256Hex(this.content);
          // A pending patch means this tab has its own unsent edit in flight — refetching now
          // would overwrite it with a snapshot that predates that edit. It self-resolves once
          // the retry succeeds (whichever document_content_changed comes after that will match).
          if (localHash !== event.data.contentHash && this.pendingPatchCount === 0) {
            // Divergence detected — the backend is authoritative; always safe to refetch (Principle I).
            await this.load();
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
  },
});
