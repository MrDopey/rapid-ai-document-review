import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ListRevisionsResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, waitFor } from '../contract/test-app.js';

/** Proves SC-003's "100% isolation" for revision history specifically (US2, T030): distinct edits
 *  applied to two documents must never cross into each other's `GET
 *  /api/documents/:documentId/revisions` results. */

const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
function proposeDirective(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return PROPOSE_EDIT_DIRECTIVE + JSON.stringify({ summary, operations });
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

async function createDoc(app: FastifyInstance, content: string) {
  const res = await call(app, 'POST', '/api/documents', { content });
  expect(res.status).toBe(201);
  return res.json as {
    document: { id: string; currentRevision: number };
    mainConversation: { id: string };
  };
}

describe('Multi-document revision-history isolation (US2, T030)', () => {
  it('each document’s revisions endpoint returns only its own agent-applied edits', async () => {
    const { app, storage } = await createTestApp();

    const docA = await createDoc(
      app,
      'Alpha opening paragraph about the roadmap.\n\nAlpha closing paragraph about next steps.',
    );
    const docB = await createDoc(
      app,
      'Bravo opening paragraph about the budget.\n\nBravo closing paragraph about timelines.',
    );

    // Main is Primary by default, so each proposal auto-applies immediately and records a revision
    // attributed to the Main conversation (mirrors http.test.ts's revision-attribution pattern).
    async function applyEdit(
      doc: { document: { id: string; currentRevision: number } },
      mainConversationId: string,
      oldString: string,
      newString: string,
      summary: string,
    ): Promise<number> {
      await waitFor(() => storage.getConversation(mainConversationId)?.status === 'idle');
      const before = storage.getDocument(doc.document.id)!.currentRevision;
      await call(
        app,
        'POST',
        `/api/documents/${doc.document.id}/conversations/${mainConversationId}/send`,
        {
          message: proposeDirective(summary, [{ old_string: oldString, new_string: newString }]),
        },
      );
      const expected = before + 1;
      await waitFor(() => storage.getDocument(doc.document.id)?.currentRevision === expected);
      return expected;
    }

    await applyEdit(
      docA,
      docA.mainConversation.id,
      'Alpha opening paragraph about the roadmap.',
      'Alpha edit one.',
      'alpha edit one',
    );
    await applyEdit(
      docB,
      docB.mainConversation.id,
      'Bravo opening paragraph about the budget.',
      'Bravo edit one.',
      'bravo edit one',
    );
    await applyEdit(
      docA,
      docA.mainConversation.id,
      'Alpha closing paragraph about next steps.',
      'Alpha edit two.',
      'alpha edit two',
    );
    await applyEdit(
      docB,
      docB.mainConversation.id,
      'Bravo closing paragraph about timelines.',
      'Bravo edit two.',
      'bravo edit two',
    );

    const resA = await call(app, 'GET', `/api/documents/${docA.document.id}/revisions`);
    expect(resA.status).toBe(200);
    const revisionsA = ListRevisionsResponse.parse(resA.json);

    const resB = await call(app, 'GET', `/api/documents/${docB.document.id}/revisions`);
    expect(resB.status).toBe(200);
    const revisionsB = ListRevisionsResponse.parse(resB.json);

    // 1 (creation) + 2 agent-applied edits, each, and never each other's conversationId.
    expect(revisionsA.revisions).toHaveLength(3);
    expect(revisionsB.revisions).toHaveLength(3);
    for (const r of revisionsA.revisions) {
      if (r.conversationId !== null) expect(r.conversationId).toBe(docA.mainConversation.id);
    }
    for (const r of revisionsB.revisions) {
      if (r.conversationId !== null) expect(r.conversationId).toBe(docB.mainConversation.id);
    }

    const exportA = await app.inject({
      method: 'GET',
      url: `/api/documents/${docA.document.id}/export`,
    });
    expect(exportA.statusCode).toBe(200);
    expect(exportA.body).not.toMatch(/Bravo/);
    expect(exportA.body).toMatch(/Alpha/);

    const exportB = await app.inject({
      method: 'GET',
      url: `/api/documents/${docB.document.id}/export`,
    });
    expect(exportB.statusCode).toBe(200);
    expect(exportB.body).not.toMatch(/Alpha/);
    expect(exportB.body).toMatch(/Bravo/);
  });
});
