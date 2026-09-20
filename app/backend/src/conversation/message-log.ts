import type { MessageDto } from '@rapid-ai-document-review/shared/contracts/http';
import { computeIsToolCallCarrier } from '@rapid-ai-document-review/shared/domain';
import type { StorageAdapter } from '../storage/storage-adapter.ts';

interface UserMessageEventData {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string | null;
  isSeed?: boolean;
}

interface ToolStartedEventData {
  toolCallId: string;
  toolName: string;
  messageId: string;
  args: unknown;
}

interface ToolCompletedEventData {
  toolCallId: string;
  toolName: string;
  messageId: string;
  isError: boolean;
  resultText: string | null;
  failureReason: string | null;
  stagedEditId: string | null;
}

/**
 * Replays a conversation's raw `conversation_event` log into the ordered `MessageDto[]` the HTTP/WS
 * surface exposes — shared by `ConversationService` (canvas mode) and `ThreadService`
 * (011-linear-thread-mode), since both operate on the identical `conversation`/`conversation_event`
 * storage shape (FR-015's reuse mandate) and must classify tool-call-carrier segments identically.
 */
export function buildConversationMessages(
  storage: StorageAdapter,
  conversationId: string,
): MessageDto[] {
  const rows = storage.listEventsByConversation(conversationId);

  const toolStartedByCallId = new Map<string, ToolStartedEventData>();
  for (const row of rows) {
    if (row.eventType !== 'tool_started') continue;
    const data = row.data as ToolStartedEventData;
    toolStartedByCallId.set(data.toolCallId, data);
  }
  const toolCallsByMessageId = new Map<string, MessageDto['toolCalls']>();
  for (const row of rows) {
    if (row.eventType !== 'tool_completed') continue;
    const data = row.data as ToolCompletedEventData;
    const started = toolStartedByCallId.get(data.toolCallId);
    const entry = {
      toolCallId: data.toolCallId,
      name: data.toolName,
      args: started?.args,
      resultText: data.resultText,
      failureReason: data.failureReason,
      stagedEditId: data.stagedEditId,
    };
    const existing = toolCallsByMessageId.get(data.messageId) ?? [];
    existing.push(entry);
    toolCallsByMessageId.set(data.messageId, existing);
  }

  return rows
    .filter((row) => row.eventType === 'message_completed')
    .map((row) => {
      const data = row.data as UserMessageEventData;
      return {
        id: data.messageId,
        role: data.role,
        text: data.text,
        reasoning: data.reasoning,
        isToolCallCarrier: computeIsToolCallCarrier(data),
        toolCalls: toolCallsByMessageId.get(data.messageId) ?? [],
        createdAt: row.createdAt,
      };
    })
    .filter(
      (message) => Boolean(message.id) && Boolean(message.role) && typeof message.text === 'string',
    );
}
