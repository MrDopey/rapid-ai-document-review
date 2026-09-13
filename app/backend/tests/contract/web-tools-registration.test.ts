import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { TurnRunner } from '../../src/pi/turn-runner.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow } from '../../src/storage/storage-adapter.js';
import { createWebSearchTool } from '../../src/pi/tools/web-search.js';
import { createWebFetchTool } from '../../src/pi/tools/web-fetch.js';

/**
 * Contract tests for specs/008-searxng-web-search (contracts/web-tools.md expectations #9-#10).
 * `pi/tools/web-search.ts`/`pi/tools/web-fetch.ts` don't exist yet at the time this file is
 * authored, and `PiService.buildTools()` does not construct them either — every test below is
 * expected to be RED until that implementation lands, mirroring
 * `tests/contract/pi-model-config.test.ts`'s top comment.
 *
 * Tool-list assertions (#9) go through `PiService` on the `RADR_BE_PI_FAKE_SESSIONS=1` branch
 * (`FakeAgentSession.getActiveToolNames()` reflects exactly what `buildTools()` constructed) —
 * reached via `piService.seedSession(...)`, the lowest-friction public method that calls the
 * private `getOrCreateSession()` without needing a full `EventBridge`. The staged-edit assertion
 * (#10) calls `.execute(...)` directly on the tool objects, since neither tool has any access to
 * `EditService`/`EventService` by construction — the meaningful assertion is at the storage layer.
 */

const ORIGINAL_ENV = { ...process.env };

function buildHarness() {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const eventHub = new EventHub(eventService, () => emptySnapshot);
  const automerge = new AutomergeStoreHolder();
  const primaryMutex = new PrimaryMutex();
  const revisionService = new RevisionService(
    storage,
    eventService,
    eventHub,
    automerge,
    primaryMutex,
  );
  const runBuffer = new RunBuffer();
  const piService = new PiService(storage, automerge, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const turnRunner = new TurnRunner(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
  );
  const conflictService = new ConflictService(storage, eventService, eventHub, automerge);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    conflictService,
    turnRunner,
    primaryMutex,
  );
  piService.setEditService(editService);

  const now = new Date().toISOString();
  const docId = newId('doc');
  const document = storage.createDocument({
    id: docId,
    title: 'web-tools-registration fixture',
    piSessionDir: `/tmp/${docId}`,
    createdAt: now,
    updatedAt: now,
  });

  function createConversationAtDepth(branchDepth: number): ConversationRow {
    const convId = newId('conv');
    return storage.createConversation({
      id: convId,
      documentId: document.id,
      parentId: null,
      name: `depth-${branchDepth}`,
      kind: 'branch',
      piSessionPath: `/tmp/${convId}.jsonl`,
      status: 'idle',
      errorMessage: null,
      isPrimary: false,
      contextRevision: 1,
      branchDepth,
      seedSelection: null,
      forkedFromMessageId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });
  }

  return { storage, piService, createConversationAtDepth };
}

function resetEnvBase() {
  process.env = { ...ORIGINAL_ENV };
  process.env.RADR_BE_PI_FAKE_SESSIONS = '1';
}

describe('Contract: web_search/web_fetch tool registration and side effects (web-tools.md #9-#10)', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('#9: both tools are present at a branch depth within maxEditingDepth, alongside propose_document_edit', async () => {
    resetEnvBase();
    const { storage, piService, createConversationAtDepth } = buildHarness();
    const settings = storage.getSettings();
    const conversation = createConversationAtDepth(settings.maxEditingDepth);

    await piService.seedSession(conversation, 'seed');
    const names = piService.getSessionForTesting(conversation.id)!.getActiveToolNames();

    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('propose_document_edit');
  });

  it('#9: both tools remain present beyond maxEditingDepth, where propose_document_edit is omitted', async () => {
    resetEnvBase();
    const { storage, piService, createConversationAtDepth } = buildHarness();
    const settings = storage.getSettings();
    const conversation = createConversationAtDepth(settings.maxEditingDepth + 5);

    await piService.seedSession(conversation, 'seed');
    const names = piService.getSessionForTesting(conversation.id)!.getActiveToolNames();

    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).not.toContain('propose_document_edit');
  });

  describe('#10: neither tool creates a staged_edit row when executed directly', () => {
    let server: Server | undefined;

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });

    it('web_search execution leaves listStagedEditsByConversation empty', async () => {
      resetEnvBase();
      const { storage, createConversationAtDepth } = buildHarness();
      const conversation = createConversationAtDepth(1);

      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ query: 'q', results: [] }));
      });
      const url = await new Promise<string>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          const address = server!.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          resolve(`http://127.0.0.1:${port}`);
        });
      });

      const tool = createWebSearchTool({ searxngUrl: url });
      await tool.execute('test-tool-call-1', { query: 'anything' });

      expect(storage.listStagedEditsByConversation(conversation.id)).toHaveLength(0);
    });

    it('web_fetch execution leaves listStagedEditsByConversation empty', async () => {
      resetEnvBase();
      const { storage, createConversationAtDepth } = buildHarness();
      const conversation = createConversationAtDepth(1);

      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><p>Some page content.</p></body></html>');
      });
      const url = await new Promise<string>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          const address = server!.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          resolve(`http://127.0.0.1:${port}`);
        });
      });

      const tool = createWebFetchTool({});
      await tool.execute('test-tool-call-1', { url: `${url}/page` });

      expect(storage.listStagedEditsByConversation(conversation.id)).toHaveLength(0);
    });
  });
});
