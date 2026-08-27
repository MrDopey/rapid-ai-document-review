import { join } from 'node:path';
import type {
  GetConversationResponse,
  ListConversationsResponse,
  MessageDto,
  SendMessageResponse,
  StagedEditDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import { DocumentNotFoundError } from '../document/document-service.js';
import { logger } from '../logging.js';
import { newId } from '../ids.js';
import type { EventHub } from '../events/event-hub.js';
import type { EventService } from '../events/event-service.js';
import type { RunBuffer } from '../events/run-buffer.js';
import { EventBridge } from '../pi/event-bridge.js';
import type { PiService } from '../pi/pi-service.js';
import type { ConversationRow, StagedEditRow, StorageAdapter } from '../storage/storage-adapter.js';
import { toConversationDto } from './conversation-mapper.js';
import type { ConcurrencyLimiter } from './concurrency-limiter.js';

export class ConversationNotFoundError extends Error {}
export class ConversationClosedError extends Error {}
export class ConversationNotErroredError extends Error {}
export class AgentUnavailableError extends Error {}

export interface PaginationOptions {
  cursor?: string;
  limit: number;
}

function toStagedEditDto(row: StagedEditRow): StagedEditDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    piToolCallId: row.piToolCallId,
    summary: row.summary,
    sourceRevision: row.sourceRevision,
    status: row.status,
    autoApplied: row.autoApplied,
    operationCount: row.operations.length,
    supersedesId: row.supersedesId,
    conflictDetail: row.conflictDetail,
    appliedRevision: row.appliedRevision,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

interface UserMessageEventData {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string | null;
}

/**
 * Conversation lifecycle for US2: ensuring Main exists, sending messages through the
 * concurrency limiter and PiService, retrying a failed turn, and reading conversation lists/
 * detail. Branching, Primary and edit workflows (US3+) extend this without rewriting it —
 * `getAll`'s `isStale`/`canEdit`/`canBranch`/`pendingEditCount` are already server-computed via
 * `toConversationDto`, which US3+ deepens rather than replaces.
 */
export class ConversationService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly eventService: EventService,
    private readonly eventHub: EventHub,
    private readonly runBuffer: RunBuffer,
    private readonly piService: PiService,
    private readonly concurrencyLimiter: ConcurrencyLimiter,
  ) {}

  /** Idempotent: creates the Main conversation for `documentId` only if one doesn't exist yet. */
  ensureMain(documentId: string): ConversationRow {
    const existing = this.storage.getMainConversation(documentId);
    if (existing) return existing;

    const document = this.storage.getDocument();
    if (!document || document.id !== documentId) {
      throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    }
    const now = new Date().toISOString();
    return this.storage.createConversation({
      id: newId('conv'),
      documentId,
      parentId: null,
      name: 'Main',
      kind: 'main',
      piSessionPath: join(document.piSessionDir, 'main.jsonl'),
      status: 'idle',
      errorMessage: null,
      isPrimary: true,
      contextRevision: document.currentRevision,
      branchDepth: 0,
      seedSelection: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });
  }

  getAll(documentId: string, options: PaginationOptions): ListConversationsResponse {
    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    const page = this.storage.listConversations(documentId, options);
    return {
      currentRevision: document.currentRevision,
      conversations: page.items.map((row) => toConversationDto(this.storage, row, document.currentRevision)),
      nextCursor: page.nextCursor,
    };
  }

  getOne(conversationId: string): GetConversationResponse {
    const conversation = this.getConversationOrThrow(conversationId);
    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');
    return {
      conversation: toConversationDto(this.storage, conversation, document.currentRevision),
      messages: this.buildMessages(conversationId),
      stagedEdits: this.storage.listStagedEditsByConversation(conversationId).map(toStagedEditDto),
    };
  }

  async send(conversationId: string, message: string): Promise<SendMessageResponse> {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status === 'closed') {
      throw new ConversationClosedError('Conversation is closed');
    }

    // Recorded directly (rather than relying on Pi to report the user's own message back
    // through its event stream) so message history and retry are well-defined regardless of
    // exactly which lifecycle events a given Pi SDK version emits for the prompt it was given.
    this.publishUserMessage(conversation.documentId, conversationId, message);

    const turnId = newId('turn');
    const bridge = new EventBridge(
      this.storage,
      this.eventService,
      this.eventHub,
      this.runBuffer,
      { documentId: conversation.documentId, conversationId, turnId },
      () => this.concurrencyLimiter.release(conversation.documentId, conversationId),
    );

    const run = () => this.piService.send(conversation, message, bridge);

    const { queued, immediateRun } = this.concurrencyLimiter.acquire(
      conversation.documentId,
      conversationId,
      turnId,
      conversation.contextRevision,
      run,
    );

    if (!queued && immediateRun) {
      try {
        await immediateRun;
      } catch (err) {
        // Bridge already recorded agent_error + errored status; this rejection additionally
        // fails the HTTP call itself since the failure happened before the run was even queued
        // (http-api.md: "AGENT_UNAVAILABLE (502) if the model call fails immediately").
        throw new AgentUnavailableError(err instanceof Error ? err.message : String(err));
      }
    }

    return { accepted: true, queued, contextRevision: conversation.contextRevision };
  }

  /**
   * Re-sends the message that produced a failed turn, against the conversation's preserved
   * history (FR-038). Idempotency on redelivered tool calls (FR-040) is what prevents this from
   * double-applying anything a pre-failure tool call had already done.
   */
  async retry(conversationId: string): Promise<{ accepted: boolean; status: 'working' }> {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status !== 'errored') {
      throw new ConversationNotErroredError('Conversation is not in an errored state');
    }
    const lastUserMessage = this.getLastUserMessageText(conversationId);
    await this.send(conversationId, lastUserMessage);
    return { accepted: true, status: 'working' };
  }

  private getConversationOrThrow(conversationId: string): ConversationRow {
    const conversation = this.storage.getConversation(conversationId);
    if (!conversation) {
      throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  private buildMessages(conversationId: string): MessageDto[] {
    return this.storage
      .listEventsByConversation(conversationId)
      .filter((row) => row.eventType === 'message_completed')
      .map((row) => {
        const data = row.data as UserMessageEventData;
        return {
          id: data.messageId,
          role: data.role,
          text: data.text,
          reasoning: data.reasoning,
          toolCalls: [],
          createdAt: row.createdAt,
        };
      });
  }

  private getLastUserMessageText(conversationId: string): string {
    const events = this.storage.listEventsByConversation(conversationId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const row = events[i]!;
      if (row.eventType !== 'message_completed') continue;
      const data = row.data as UserMessageEventData;
      if (data.role === 'user') return data.text;
    }
    throw new Error(`No prior user message found to retry for conversation ${conversationId}`);
  }

  private publishUserMessage(documentId: string, conversationId: string, text: string): void {
    const data: UserMessageEventData = { messageId: newId('msg'), role: 'user', text, reasoning: null };
    const row = this.eventService.append(documentId, conversationId, 'message_completed', data);
    this.eventHub.broadcast(documentId, {
      type: 'message_completed',
      sequence: row.sequence,
      documentId,
      conversationId,
      at: row.createdAt,
      data,
    });
    logger.info({ event: 'user_message_recorded', documentId, conversationId }, 'user message recorded');
  }
}
