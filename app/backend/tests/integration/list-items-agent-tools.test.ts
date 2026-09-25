import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentResponse,
  GetConversationResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, waitFor } from '../contract/test-app.ts';
import { LIST_ITEM_TOOL_DIRECTIVE } from '../../src/pi/fake-agent-session.ts';
import { computeContentHash } from '../../src/list-items/content-hash.ts';
import type { StorageAdapter } from '../../src/storage/storage-adapter.ts';

/**
 * Integration coverage for User Story 1 (Todo list) and User Story 2 (Parking Lot list),
 * specs/012-todo-parking-lists. Both stories exercise the exact same generic tool implementation
 * (`pi/tools/list-items.ts`) against the two different `list` values — see tasks.md T013's note
 * that US2 adds no new production code, only this second-list validation.
 *
 * Drives the four real tool objects deterministically via `FakeAgentSession`'s
 * `LIST_ITEM_TOOL_DIRECTIVE` (fake-agent-session.ts) — a message of the form
 * `LIST_ITEM_TOOL_DIRECTIVE + JSON.stringify({ tool, params })` causes the fake session to invoke
 * that real tool with `params`, exactly as `PROPOSE_EDIT_DIRECTIVE` does for `propose_document_edit`
 * elsewhere in this test suite.
 */

interface Ctx {
  app: FastifyInstance;
  storage: StorageAdapter;
  documentId: string;
  conversationId: string;
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method, url, payload: payload as never });
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json };
}

function directiveMessage(tool: string, params: Record<string, unknown>): string {
  return LIST_ITEM_TOOL_DIRECTIVE + JSON.stringify({ tool, params });
}

async function setupDoc(): Promise<Ctx> {
  const { app, storage } = await createTestApp();
  const res = await call(app, 'POST', '/api/documents', { content: 'Doc content.' });
  expect(res.status).toBe(201);
  const parsed = CreateDocumentResponse.parse(res.json);
  const documentId = parsed.document.id;
  const conversationId = parsed.mainConversation.id;
  await waitFor(() => storage.getConversation(conversationId)?.status === 'idle');
  return { app, storage, documentId, conversationId };
}

/** Sends one scripted tool-call directive on `ctx.conversationId` and waits for the turn to settle. */
async function callTool(
  ctx: Ctx,
  tool: 'list_items' | 'add_list_item' | 'update_list_item' | 'remove_list_item',
  params: Record<string, unknown>,
): Promise<void> {
  await waitFor(() => ctx.storage.getConversation(ctx.conversationId)?.status === 'idle');
  await call(
    ctx.app,
    'POST',
    `/api/documents/${ctx.documentId}/conversations/${ctx.conversationId}/send`,
    { message: directiveMessage(tool, params) },
  );
  await waitFor(() => ctx.storage.getConversation(ctx.conversationId)?.status === 'idle');
}

/** The most recent tool call named `toolName` across every message in the conversation, per the
 *  `GET .../conversations/:id` endpoint's own `toolCalls[].resultText` (event-bridge.ts's
 *  `ToolCompletedEvent`) — used to assert on rejection/error text. */
async function lastToolCallResult(ctx: Ctx, toolName: string): Promise<string | null> {
  const res = await call(
    ctx.app,
    'GET',
    `/api/documents/${ctx.documentId}/conversations/${ctx.conversationId}`,
  );
  const parsed = GetConversationResponse.parse(res.json);
  const toolCalls = parsed.messages.flatMap((m) => m.toolCalls ?? []);
  const matches = toolCalls.filter((tc) => tc.name === toolName);
  return matches.at(-1)?.resultText ?? null;
}

/** The `id` of the assistant message whose `toolCalls[]` most recently carried a call named
 *  `toolName` — the "message that requested it" provenance link (`add_list_item`/`update_list_item`)
 *  is expected to record onto the resulting item. */
async function messageIdForToolCall(ctx: Ctx, toolName: string): Promise<string | null> {
  const res = await call(
    ctx.app,
    'GET',
    `/api/documents/${ctx.documentId}/conversations/${ctx.conversationId}`,
  );
  const parsed = GetConversationResponse.parse(res.json);
  const matches = parsed.messages.filter((m) =>
    (m.toolCalls ?? []).some((tc) => tc.name === toolName),
  );
  return matches.at(-1)?.id ?? null;
}

async function countToolCalls(ctx: Ctx, toolNames: string[]): Promise<number> {
  const res = await call(
    ctx.app,
    'GET',
    `/api/documents/${ctx.documentId}/conversations/${ctx.conversationId}`,
  );
  const parsed = GetConversationResponse.parse(res.json);
  const toolCalls = parsed.messages.flatMap((m) => m.toolCalls ?? []);
  return toolCalls.filter((tc) => toolNames.includes(tc.name)).length;
}

const LIST_ITEM_TOOL_NAMES = [
  'add_list_item',
  'update_list_item',
  'remove_list_item',
  'list_items',
];

describe.each([
  { list: 'todo' as const, label: 'Todo (US1)' },
  { list: 'parking_lot' as const, label: 'Parking Lot (US2)' },
])('$label list — agent tool calls', ({ list }) => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setupDoc();
  });

  it('supports add -> update -> remove round trip via tool calls', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'fix the intro paragraph' });
    const afterAdd = ctx.storage.listListItems(ctx.documentId);
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0]?.text).toBe('fix the intro paragraph');
    expect(afterAdd[0]?.list).toBe(list);
    const id = afterAdd[0]!.id;

    await callTool(ctx, 'update_list_item', {
      list,
      id,
      expected_content_hash: computeContentHash('fix the intro paragraph'),
      text: 'fix the intro',
    });
    const afterUpdate = ctx.storage.listListItems(ctx.documentId);
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]?.text).toBe('fix the intro');

    await callTool(ctx, 'remove_list_item', {
      list,
      id,
      expected_content_hash: computeContentHash('fix the intro'),
    });
    expect(ctx.storage.listListItems(ctx.documentId)).toHaveLength(0);
  });

  // Bug fix: `contentHash` must appear in the tool's own rendered `text` (what the model actually
  // reads back), never just in the `details` object alongside it — `details` is a
  // logs/UI-rendering-only slot the model never sees (event-bridge.ts's own doc comment on
  // `AgentToolResult.details`). Without this, the model has no way to learn the hash it must pass
  // to a later update_list_item/remove_list_item call, despite every tool's own description
  // promising add_list_item/update_list_item/list_items as valid hash sources.
  it('returns contentHash in the tool result text itself, from add_list_item, list_items, and update_list_item', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'fix the intro paragraph' });
    const addResult = await lastToolCallResult(ctx, 'add_list_item');
    const addHash = computeContentHash('fix the intro paragraph');
    expect(addResult).toContain(addHash);
    const id = ctx.storage.listListItems(ctx.documentId)[0]!.id;

    await callTool(ctx, 'list_items', {});
    const listResult = await lastToolCallResult(ctx, 'list_items');
    expect(listResult).toContain(addHash);
    expect(listResult).toContain(id);

    await callTool(ctx, 'update_list_item', {
      list,
      id,
      expected_content_hash: addHash,
      text: 'fix the intro',
    });
    const updateResult = await lastToolCallResult(ctx, 'update_list_item');
    expect(updateResult).toContain(computeContentHash('fix the intro'));
  });

  it('returns a not-found error for an unknown id, leaving both lists unchanged (FR-007)', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'existing item' });
    const before = ctx.storage.listListItems(ctx.documentId);

    await callTool(ctx, 'update_list_item', {
      list,
      id: 'li_does_not_exist',
      expected_content_hash: 'deadbeef00',
      text: 'new text',
    });
    const updateResult = await lastToolCallResult(ctx, 'update_list_item');
    expect(updateResult).toMatch(/no item.*found/i);

    await callTool(ctx, 'remove_list_item', {
      list,
      id: 'li_does_not_exist',
      expected_content_hash: 'deadbeef00',
    });
    const removeResult = await lastToolCallResult(ctx, 'remove_list_item');
    expect(removeResult).toMatch(/no item.*found/i);

    expect(ctx.storage.listListItems(ctx.documentId)).toEqual(before);
  });

  it("rejects update_list_item/remove_list_item against the OTHER list's id — never resolves across lists (FR-007)", async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'scoped item' });
    const [row] = ctx.storage.listListItems(ctx.documentId);
    const otherList = list === 'todo' ? 'parking_lot' : 'todo';

    await callTool(ctx, 'update_list_item', {
      list: otherList,
      id: row!.id,
      expected_content_hash: computeContentHash(row!.text),
      text: 'should not apply',
    });
    expect(await lastToolCallResult(ctx, 'update_list_item')).toMatch(/no item.*found/i);
    expect(ctx.storage.listListItems(ctx.documentId)[0]?.text).toBe('scoped item');
  });

  it('rejects a stale expected_content_hash when the item changed since the agent last saw it (FR-008)', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'original text' });
    const [row] = ctx.storage.listListItems(ctx.documentId);
    const staleHash = computeContentHash(row!.text);

    // Simulates a panel edit (User Story 4's HTTP path) landing between the agent's add and its
    // later update/remove call — the agent's held hash is now stale.
    await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}/list-items/${row!.id}`, {
      text: 'edited via the panel',
    });

    await callTool(ctx, 'update_list_item', {
      list,
      id: row!.id,
      expected_content_hash: staleHash,
      text: 'agent proposed text',
    });
    const rejection = await lastToolCallResult(ctx, 'update_list_item');
    expect(rejection).toMatch(/changed since/i);
    expect(rejection).toContain('edited via the panel');
    expect(ctx.storage.listListItems(ctx.documentId)[0]?.text).toBe('edited via the panel');
  });

  it('records the (conversation, message) that requested add_list_item as the item provenance link', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'from the agent' });
    const [row] = ctx.storage.listListItems(ctx.documentId);
    const messageId = await messageIdForToolCall(ctx, 'add_list_item');

    expect(row?.conversationId).toBe(ctx.conversationId);
    expect(row?.messageId).toBe(messageId);
    expect(messageId).toBeTruthy();
  });

  it('overwrites the provenance link to the later turn on update_list_item, never accumulating it', async () => {
    await callTool(ctx, 'add_list_item', { list, text: 'original' });
    const [added] = ctx.storage.listListItems(ctx.documentId);
    const addMessageId = await messageIdForToolCall(ctx, 'add_list_item');

    await callTool(ctx, 'update_list_item', {
      list,
      id: added!.id,
      expected_content_hash: computeContentHash('original'),
      text: 'updated by a later turn',
    });
    const updateMessageId = await messageIdForToolCall(ctx, 'update_list_item');
    const [updated] = ctx.storage.listListItems(ctx.documentId);

    expect(updateMessageId).toBeTruthy();
    expect(updateMessageId).not.toBe(addMessageId);
    expect(updated?.conversationId).toBe(ctx.conversationId);
    expect(updated?.messageId).toBe(updateMessageId);
  });

  it('makes zero list-item tool calls when the user never mentions the lists (FR-006, SC-006)', async () => {
    await waitFor(() => ctx.storage.getConversation(ctx.conversationId)?.status === 'idle');
    await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations/${ctx.conversationId}/send`,
      { message: 'What do you think of this document?' },
    );
    await waitFor(() => ctx.storage.getConversation(ctx.conversationId)?.status === 'idle');

    expect(await countToolCalls(ctx, LIST_ITEM_TOOL_NAMES)).toBe(0);
  });
});
