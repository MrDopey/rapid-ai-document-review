import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  addListItemParams,
  listItemsParams,
  removeListItemParams,
  updateListItemParams,
} from '@rapid-ai-document-review/shared/contracts/agent-tools';
import { computeContentHash } from '../../list-items/content-hash.ts';
import {
  EmptyListItemTextError,
  ListItemNotFoundError,
  StaleContentHashError,
  type ListItemService,
} from '../../list-items/list-item-service.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import type { ToolCallMessageIdCache } from '../../events/tool-call-message-id-cache.ts';
import { textResult } from './common.ts';

/** `defineTool`'s TypeBox mirrors of the Zod schemas in `agent-tools.ts` (see `ReadDocumentToolParams`
 *  for why both exist). */
// Bug fix: the SDK's own tool-call param validation (`@earendil-works/pi-ai`'s
// `validateToolArguments`) rejects a bad `list` value BEFORE this tool's own `execute` (and its
// zod `addListItemParams.parse`, etc.) ever runs — its error message is a generic TypeBox one
// ("must be equal to constant", "must match a schema in anyOf") that never names the actual
// accepted literal(s), and this codebase has no way to customize that vendored error text
// (Constitution Principle II: pi-service.ts is the only module allowed to touch the SDK at all).
// The one lever available from here is this `description` — spelling out the exact accepted
// strings up front is what stops the model from ever guessing a plausible-looking variant (e.g.
// `"parking-lot"` hyphenated, or `"Parking Lot"` title-cased) that then fails with no useful clue
// which spelling was actually expected.
const ListNameToolParam = Type.Union([Type.Literal('todo'), Type.Literal('parking_lot')], {
  description:
    "Which list. Must be exactly one of these two literal strings: 'todo' or 'parking_lot' " +
    "(snake_case, lowercase, exactly as spelled here — not 'parking-lot', 'Parking Lot', or any " +
    'other variant).',
});

const ListItemsToolParams = Type.Object({});

const AddListItemToolParams = Type.Object({
  list: ListNameToolParam,
  text: Type.String({
    minLength: 1,
    description: 'The item text. Must not be empty or whitespace-only.',
  }),
});

const UpdateListItemToolParams = Type.Object({
  list: ListNameToolParam,
  id: Type.String({ description: 'The item id.' }),
  expected_content_hash: Type.String({
    description:
      "The hash of the item's CURRENT text, as last told to you by add_list_item, a prior " +
      'update_list_item, or list_items — never a hash of the new text below.',
  }),
  text: Type.String({
    minLength: 1,
    description: 'The new item text. Must not be empty or whitespace-only.',
  }),
});

const RemoveListItemToolParams = Type.Object({
  list: ListNameToolParam,
  id: Type.String({ description: 'The item id.' }),
  expected_content_hash: Type.String({
    description: "The hash of the item's current text, as last told to you.",
  }),
});

export interface ListItemToolDeps {
  storage: StorageAdapter;
  listItemService: ListItemService;
  conversationId: string;
  toolCallMessageIds: ToolCallMessageIdCache;
}

/** Resolves the document this tool call's conversation belongs to, or `null` if either has
 *  vanished (mirrors `read_document`'s own guard). */
function resolveDocumentId(deps: ListItemToolDeps): string | null {
  const conversation = deps.storage.getConversation(deps.conversationId);
  return conversation?.documentId ?? null;
}

/** The rendered `text` is what the model actually reads back as this tool call's result — the
 *  structured `details` object passed alongside `textResult` (below) is for logs/UI only, never
 *  surfaced to the model (see `event-bridge.ts`'s own doc comment on `details`) — so `contentHash`
 *  must appear in this text itself, not just in `details`, for the tool's own documented promise
 *  ("call list_items... to get the exact contentHash to pass") to actually hold. */
function renderListSection(
  title: string,
  items: { id: string; text: string; contentHash: string }[],
): string {
  if (items.length === 0) return `${title}: No items.`;
  const lines = items.map(
    (item) => `  ${item.id} (contentHash: ${item.contentHash}): ${item.text}`,
  );
  return [`${title}:`, ...lines].join('\n');
}

/**
 * `list_items` — read-only, exempt from the "explicit user request" gating below (FR-010); the
 * agent may call it at will, the same way it may call `read_document`.
 */
export function createListItemsTool(deps: ListItemToolDeps) {
  return defineTool({
    name: 'list_items',
    label: 'List Todo/Parking Lot items',
    description:
      'List the current items on the Todo list and the Parking Lot list, each with its identifier ' +
      'and the exact contentHash value to pass as expected_content_hash to update_list_item/' +
      'remove_list_item for that item. Call this before updating or removing an item you did not ' +
      'just add yourself in this conversation.',
    promptSnippet: 'list_items() — list current Todo and Parking Lot items',
    parameters: ListItemsToolParams,
    execute: async (_toolCallId, rawParams) => {
      listItemsParams.parse(rawParams);
      const documentId = resolveDocumentId(deps);
      if (!documentId) {
        return textResult('No document is available.');
      }

      const { todo, parkingLot } = deps.listItemService.listItems(documentId);
      const text = [
        renderListSection('Todo', todo),
        renderListSection('Parking Lot', parkingLot),
      ].join('\n\n');
      return textResult(text, { todo, parkingLot });
    },
  });
}

/**
 * `add_list_item` — ONLY when the user explicitly asks (FR-006). Never use either list as the
 * agent's own task list or memory.
 */
export function createAddListItemTool(deps: ListItemToolDeps) {
  return defineTool({
    name: 'add_list_item',
    label: 'Add Todo/Parking Lot item',
    description:
      'Add an item to the Todo list or the Parking Lot list — ONLY when the user explicitly asks ' +
      'you to add something to one of these lists. Never use this as your own task list or memory.',
    promptSnippet: 'add_list_item(list, text) — add an item, only when the user explicitly asks',
    parameters: AddListItemToolParams,
    execute: async (toolCallId, rawParams) => {
      const params = addListItemParams.parse(rawParams);
      const documentId = resolveDocumentId(deps);
      if (!documentId) {
        return textResult('No document is available.');
      }

      try {
        const row = deps.listItemService.addItem(
          documentId,
          params.list,
          params.text,
          deps.conversationId,
          deps.toolCallMessageIds.take(toolCallId),
        );
        const contentHash = computeContentHash(row.text);
        return textResult(
          `Added to the ${params.list === 'todo' ? 'Todo' : 'Parking Lot'} list (id: ${row.id}, ` +
            `contentHash: ${contentHash}): "${row.text}"`,
          { id: row.id, list: row.list, contentHash },
        );
      } catch (err) {
        if (err instanceof EmptyListItemTextError) {
          return textResult('Item text must not be empty or whitespace-only. Nothing was added.');
        }
        throw err;
      }
    },
  });
}

function staleHashMessage(err: StaleContentHashError): string {
  return [
    'This item changed since it was last seen — the requested change was not applied.',
    `Current text: "${err.currentText}"`,
    `Current contentHash: ${err.currentContentHash}`,
  ].join('\n');
}

/**
 * `update_list_item` — ONLY when the user explicitly asks (FR-006). `expected_content_hash` names
 * a precondition (the item's believed-current text's hash), not the new content — rejected,
 * leaving the item unchanged, when it doesn't match (FR-008).
 */
export function createUpdateListItemTool(deps: ListItemToolDeps) {
  return defineTool({
    name: 'update_list_item',
    label: 'Update Todo/Parking Lot item',
    description:
      'Update the text of an existing Todo or Parking Lot item, ONLY when the user explicitly ' +
      'asks you to. expected_content_hash must be the exact hash value you were most recently ' +
      "given for this item's CURRENT text (from add_list_item, a prior update_list_item, or " +
      'list_items) — never invent or compute one yourself, and never the hash of the new text ' +
      "you're sending.",
    promptSnippet:
      'update_list_item(list, id, expected_content_hash, text) — update an item, only when asked',
    parameters: UpdateListItemToolParams,
    execute: async (toolCallId, rawParams) => {
      const params = updateListItemParams.parse(rawParams);
      const documentId = resolveDocumentId(deps);
      if (!documentId) {
        return textResult('No document is available.');
      }

      try {
        const row = deps.listItemService.updateItem(
          documentId,
          params.id,
          params.text,
          deps.conversationId,
          {
            list: params.list,
            expectedContentHash: params.expected_content_hash,
            messageId: deps.toolCallMessageIds.take(toolCallId),
          },
        );
        const contentHash = computeContentHash(row.text);
        // The item's NEW contentHash must appear in the text itself — the tool's own description
        // promises a further update_list_item/remove_list_item call may use "a prior
        // update_list_item" as its hash source, which only holds if this result actually says it.
        return textResult(`Updated (new contentHash: ${contentHash}). New text: "${row.text}"`, {
          id: row.id,
          list: row.list,
          contentHash,
        });
      } catch (err) {
        if (err instanceof EmptyListItemTextError) {
          return textResult(
            'Item text must not be empty or whitespace-only. The item was not changed.',
          );
        }
        if (err instanceof ListItemNotFoundError) {
          return textResult(
            `No item with id ${params.id} was found on the ${params.list === 'todo' ? 'Todo' : 'Parking Lot'} list. Neither list was changed.`,
          );
        }
        if (err instanceof StaleContentHashError) {
          return textResult(staleHashMessage(err));
        }
        throw err;
      }
    },
  });
}

/**
 * `remove_list_item` — ONLY when the user explicitly asks (FR-006). Same stale-hash rejection
 * contract as `update_list_item`.
 */
export function createRemoveListItemTool(deps: ListItemToolDeps) {
  return defineTool({
    name: 'remove_list_item',
    label: 'Remove Todo/Parking Lot item',
    description:
      'Remove an item from the Todo or Parking Lot list, ONLY when the user explicitly asks you ' +
      'to. expected_content_hash must be the exact hash value you were most recently given for ' +
      "this item's current text — never invent or compute one yourself.",
    promptSnippet:
      'remove_list_item(list, id, expected_content_hash) — remove an item, only when asked',
    parameters: RemoveListItemToolParams,
    execute: async (_toolCallId, rawParams) => {
      const params = removeListItemParams.parse(rawParams);
      const documentId = resolveDocumentId(deps);
      if (!documentId) {
        return textResult('No document is available.');
      }

      try {
        deps.listItemService.removeItem(documentId, params.id, deps.conversationId, {
          list: params.list,
          expectedContentHash: params.expected_content_hash,
        });
        return textResult('Removed.', { id: params.id, list: params.list });
      } catch (err) {
        if (err instanceof ListItemNotFoundError) {
          return textResult(
            `No item with id ${params.id} was found on the ${params.list === 'todo' ? 'Todo' : 'Parking Lot'} list. Neither list was changed.`,
          );
        }
        if (err instanceof StaleContentHashError) {
          return textResult(staleHashMessage(err));
        }
        throw err;
      }
    },
  });
}
