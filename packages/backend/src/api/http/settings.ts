import type { FastifyInstance } from 'fastify';
import { UserSettingsDto, UserSettingsPatch } from '@rapid-ai-document-review/shared/contracts/http';
import type { EventHub } from '../../events/event-hub.ts';
import type { EventService } from '../../events/event-service.ts';
import type { StorageAdapter, UserSettingsRow } from '../../storage/storage-adapter.ts';
import { sendError } from './errors.ts';

function toDto(row: UserSettingsRow): UserSettingsDto {
  return {
    thinkingVisible: row.thinkingVisible,
    revisionDebounceMs: row.revisionDebounceMs,
    maxConcurrentAgents: row.maxConcurrentAgents,
    maxEditingDepth: row.maxEditingDepth,
    maxConversationDepth: row.maxConversationDepth,
    maxReplacementAttempts: row.maxReplacementAttempts,
    softWordCountThreshold: row.softWordCountThreshold,
  };
}

/**
 * `user_settings` singleton (data-model.md §8). Ranges are enforced by the shared Zod schema
 * (`UserSettingsDto`'s per-field `.min()/.max()`) — an out-of-range value is rejected with
 * `400 VALIDATION_FAILED`, never clamped (FR-041). A changed limit applies only prospectively.
 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { storage: StorageAdapter; eventService: EventService; eventHub: EventHub },
): void {
  const { storage, eventService, eventHub } = deps;

  app.get('/api/settings', async (_request, reply) => {
    return reply.send(toDto(storage.getSettings()));
  });

  app.patch('/api/settings', async (request, reply) => {
    const parsed = UserSettingsPatch.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    const updated = storage.updateSettings(parsed.data, new Date().toISOString());
    const dto = toDto(updated);

    const doc = storage.getDocument();
    if (doc) {
      const row = eventService.append(doc.id, null, 'settings_changed', dto);
      eventHub.broadcast(doc.id, {
        type: 'settings_changed',
        sequence: row.sequence,
        documentId: doc.id,
        conversationId: null,
        at: row.createdAt,
        data: dto,
      });
    }

    return reply.send(dto);
  });
}
