import { logger } from '../logging.ts';
import type { EventPublisher } from '../events/event-publisher.ts';
import type { PiService } from '../pi/pi-service.ts';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';

/**
 * Assembles and delivers a closed conversation's fold summary into its parent (FR-034/FR-034a).
 * `ConversationService.close()` owns the decision of *whether* to fold (and the fire-and-forget/
 * catch wrapping around the call, since that's specific to `close()`'s own HTTP-response timing),
 * delegating only the actual fold-summary work here.
 */
export class ConversationFoldService {
  private readonly storage: StorageAdapter;
  private readonly piService: PiService;
  private readonly publisher: EventPublisher;

  constructor(storage: StorageAdapter, piService: PiService, publisher: EventPublisher) {
    this.storage = storage;
    this.piService = piService;
    this.publisher = publisher;
  }

  /**
   * FR-034/FR-034a: assembles the compact fold summary — a deterministic facts block (name,
   * seeded selection if any, and the proposal list with each one's final status and resulting
   * revision — never the raw transcript) plus a short synopsis of what was discussed/decided,
   * genuinely asked of the closed conversation's own Pi session (research R1) rather than
   * fabricated — and delivers it into the parent conversation's session via
   * `PiService.deliverFoldSummary` (`sendCustomMessage(..., { deliverAs: 'nextTurn' })`). Expected
   * to run entirely after `close()` has already returned its HTTP response; never awaited by that
   * caller. If the synopsis call fails, this logs a warning and returns without touching the
   * parent — the fold is best-effort, not a core review-blocking feature.
   */
  async foldSummaryIntoParent(conversation: ConversationRow, parentId: string): Promise<void> {
    const facts = this.buildFoldFacts(conversation);

    let synopsis: string;
    try {
      synopsis = await this.piService.generateFoldSynopsis(conversation, this.buildFoldSynopsisPrompt());
    } catch (err) {
      // `event: 'agent_error'` — this Pi call failing is exactly what that vocabulary term means
      // (FR-042); no `conversation_summary_folded` frame follows since the fold never completes.
      logger.warn(
        {
          event: 'agent_error',
          documentId: conversation.documentId,
          conversationId: conversation.id,
          parentConversationId: parentId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Pi failed to generate a fold summary synopsis; parent continues without a folded summary',
      );
      return;
    } finally {
      // `generateFoldSynopsis` above is this closed conversation's own last use of
      // `getOrCreateSession` (`deliverFoldSummary` below only ever touches the *parent*'s
      // session) — safe to evict now regardless of whether the synopsis call succeeded.
      this.piService.evictSession(conversation.id);
    }

    const summary = `${synopsis.trim()}\n\n${facts}`;

    // FR-034a: "rejected if the parent has itself since closed" — re-checked here since the
    // synopsis call above may have taken a while, and the parent's status can have moved on.
    const parentNow = this.storage.getConversation(parentId);
    if (!parentNow || parentNow.status === 'closed') {
      // No `event` field: dropping the fold means no `conversation_summary_folded` (or any other
      // vocabulary) frame fires for it — there is nothing in the closed set to name here (FR-042).
      logger.info(
        {
          documentId: conversation.documentId,
          conversationId: conversation.id,
          parentConversationId: parentId,
        },
        'parent conversation closed before the fold summary was ready; dropping silently',
      );
      return;
    }

    await this.piService.deliverFoldSummary(parentNow, conversation.name, summary);

    this.publisher.publish(conversation.documentId, parentId, 'conversation_summary_folded', {
      parentConversationId: parentId,
      summary,
    });
  }

  private buildFoldFacts(conversation: ConversationRow): string {
    const lines: string[] = [`Conversation: "${conversation.name}"`];
    if (conversation.seedSelection) {
      lines.push(`Seeded from: "${conversation.seedSelection.text}"`);
    }
    const edits = this.storage.listStagedEditsByConversation(conversation.id);
    if (edits.length === 0) {
      lines.push('No proposals were made in this conversation.');
    } else {
      lines.push('Proposals:');
      for (const edit of edits) {
        const revisionNote = edit.appliedRevision ? ` (revision ${edit.appliedRevision})` : '';
        lines.push(`- ${edit.summary} — ${edit.status}${revisionNote}`);
      }
    }
    return lines.join('\n');
  }

  private buildFoldSynopsisPrompt(): string {
    return (
      'This conversation is closing. In 2-3 sentences, write a compact synopsis of what was ' +
      'discussed and decided in it, for another conversation to read as context. Summarize only ' +
      '— do not restate the full message transcript.'
    );
  }
}
