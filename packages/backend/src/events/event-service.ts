import { randomUUID } from 'node:crypto';
import type { ConversationEventRow, StorageAdapter } from '../storage/storage-adapter.ts';
import { logger } from '../logging.ts';

/**
 * Appends and replays the application event stream (conversation_event table). `sequence` is
 * monotonic per document across all conversations (data-model.md §7), which is what lets a
 * reconnecting client say "send me everything after N" with one cursor (FR-037).
 *
 * High-frequency ephemeral deltas (text_delta, thinking_delta, tool_output_delta) are never
 * passed to `append` — they are broadcast live only by EventHub, never persisted.
 */
export class EventService {
  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  append(
    documentId: string,
    conversationId: string | null,
    eventType: string,
    data: unknown,
  ): ConversationEventRow {
    const sequence = this.storage.getNextSequence(documentId);
    const row = this.storage.appendEvent({
      id: randomUUID(),
      documentId,
      conversationId,
      sequence,
      eventType,
      data,
      createdAt: new Date().toISOString(),
    });
    logger.info({ event: eventType, documentId, conversationId, sequence: row.sequence }, eventType);
    return row;
  }

  getEventsSince(documentId: string, sinceSequence: number | null): ConversationEventRow[] {
    return this.storage.listEventsSince(documentId, sinceSequence);
  }

  getLatestSequence(documentId: string): number {
    return this.storage.getLatestSequence(documentId);
  }
}
