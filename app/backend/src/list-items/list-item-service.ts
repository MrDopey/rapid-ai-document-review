import { newId } from '../ids.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import type { ListItemRow, StorageAdapter } from '../storage/storage-adapter.ts';
import { computeContentHash } from './content-hash.ts';

export type ListName = 'todo' | 'parking_lot';

export interface ListItemDto {
  id: string;
  text: string;
  contentHash: string;
  conversationId: string | null;
  messageId: string | null;
}

export class ListItemNotFoundError extends Error {}

export class EmptyListItemTextError extends Error {}

/** Thrown when a caller's `expectedContentHash` doesn't match the item's actual current text
 *  (FR-008) — carries that actual current state so the caller (`pi/tools/list-items.ts`) can
 *  report it back without a second round trip. */
export class StaleContentHashError extends Error {
  readonly currentText: string;
  readonly currentContentHash: string;

  constructor(message: string, currentText: string, currentContentHash: string) {
    super(message);
    this.currentText = currentText;
    this.currentContentHash = currentContentHash;
  }
}

export interface UpdateOrRemoveOptions {
  /** Scopes the lookup to this list (agent tool-call path, FR-007) — an id belonging to the
   *  other list is treated as not-found rather than resolved across lists. Omitted on the HTTP
   *  path, which has no `list` parameter at all (list-items-http-api.md). */
  list?: ListName;
  /** Checked against the row's current text (FR-008) when present. Omitted on the HTTP path,
   *  which never carries or checks a hash (FR-020) — a user's edit/delete always applies. */
  expectedContentHash?: string;
}

function toDto(row: ListItemRow): ListItemDto {
  return {
    id: row.id,
    text: row.text,
    contentHash: computeContentHash(row.text),
    conversationId: row.conversationId,
    messageId: row.messageId,
  };
}

/**
 * Shared by the agent tool-call path (`pi/tools/list-items.ts`) and the user's HTTP path
 * (`api/http/list-items.ts`) — the one place that mutates `list_item` rows and the one place that
 * publishes `list_item_added`/`list_item_updated`/`list_item_removed` (research.md R3), so a
 * change from either source reaches every open client identically.
 */
export class ListItemService {
  private readonly storage: StorageAdapter;
  private readonly publisher: EventPublisher;

  constructor(storage: StorageAdapter, eventService: EventService, eventHub: EventHub) {
    this.storage = storage;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  listItems(documentId: string): { todo: ListItemDto[]; parkingLot: ListItemDto[] } {
    const rows = this.storage.listListItems(documentId);
    return {
      todo: rows.filter((row) => row.list === 'todo').map(toDto),
      parkingLot: rows.filter((row) => row.list === 'parking_lot').map(toDto),
    };
  }

  addItem(
    documentId: string,
    list: ListName,
    text: string,
    conversationId: string | null,
    messageId: string | null,
  ): ListItemRow {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new EmptyListItemTextError('List item text must not be empty.');
    }
    const now = new Date().toISOString();
    const row = this.storage.createListItem({
      id: newId('li'),
      documentId,
      list,
      text: trimmed,
      createdAt: now,
      updatedAt: now,
      conversationId,
      messageId,
    });
    this.publisher.publish(documentId, conversationId, 'list_item_added', {
      list,
      item: toDto(row),
    });
    return row;
  }

  updateItem(
    documentId: string,
    id: string,
    text: string,
    conversationId: string | null,
    options: UpdateOrRemoveOptions & { messageId?: string | null } = {},
  ): ListItemRow {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new EmptyListItemTextError('List item text must not be empty.');
    }
    const row = this.findScoped(documentId, id, options.list);
    this.checkContentHash(row, options.expectedContentHash);

    // `messageId` omitted (the HTTP path's case) leaves the item's existing link untouched — only
    // the agent path ever supplies an explicit pair, so a human fixing a typo never severs
    // provenance.
    const updated = this.storage.updateListItem(id, {
      text: trimmed,
      updatedAt: new Date().toISOString(),
      ...('messageId' in options ? { conversationId, messageId: options.messageId } : {}),
    });
    this.publisher.publish(documentId, conversationId, 'list_item_updated', {
      list: updated.list,
      item: toDto(updated),
    });
    return updated;
  }

  removeItem(
    documentId: string,
    id: string,
    conversationId: string | null,
    options: UpdateOrRemoveOptions = {},
  ): void {
    const row = this.findScoped(documentId, id, options.list);
    this.checkContentHash(row, options.expectedContentHash);

    this.storage.deleteListItem(id);
    this.publisher.publish(documentId, conversationId, 'list_item_removed', {
      list: row.list,
      itemId: id,
    });
  }

  private findScoped(documentId: string, id: string, list: ListName | undefined): ListItemRow {
    const row = this.storage.getListItem(documentId, id);
    if (!row || (list !== undefined && row.list !== list)) {
      throw new ListItemNotFoundError(`List item not found: ${id}`);
    }
    return row;
  }

  private checkContentHash(row: ListItemRow, expectedContentHash: string | undefined): void {
    if (expectedContentHash === undefined) return;
    const currentContentHash = computeContentHash(row.text);
    if (expectedContentHash !== currentContentHash) {
      throw new StaleContentHashError(
        'The item changed since it was last seen; the requested change was not applied.',
        row.text,
        currentContentHash,
      );
    }
  }
}
