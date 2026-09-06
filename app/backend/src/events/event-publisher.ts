import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from './event-hub.ts';
import type { EventService } from './event-service.ts';

/**
 * The one place `eventService.append` + `eventHub.broadcast` are sequenced together, so every
 * service that emits an application event does so through the same append-then-broadcast
 * mechanics — callers still decide what `type`/`data` (or whole frame) to publish.
 *
 * Two call shapes are supported:
 *  - `publish(documentId, conversationId, type, data)` — the common case, used by services that
 *    build the frame from discrete fields (ConversationService, EditService, ConflictService,
 *    PrimaryService, settings.ts).
 *  - `publishFrame(frame)` — used by callers that already have a near-complete `ApplicationEvent`
 *    (with placeholder `sequence: null`/`at`) and just need `sequence`/`at` overwritten from the
 *    persisted row (DocumentService, RevisionService, ConcurrencyLimiter).
 */
export class EventPublisher {
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;

  constructor(eventService: EventService, eventHub: EventHub) {
    this.eventService = eventService;
    this.eventHub = eventHub;
  }

  publish(documentId: string, conversationId: string | null, type: string, data: unknown): void {
    const persisted = this.eventService.append(documentId, conversationId, type, data);
    this.eventHub.broadcast(documentId, {
      type,
      sequence: persisted.sequence,
      documentId,
      conversationId,
      at: persisted.createdAt,
      data,
    } as unknown as ApplicationEvent);
  }

  publishFrame(frame: ApplicationEvent): void {
    const persisted = this.eventService.append(frame.documentId, frame.conversationId, frame.type, frame.data);
    this.eventHub.broadcast(frame.documentId, { ...frame, sequence: persisted.sequence, at: persisted.createdAt });
  }
}
