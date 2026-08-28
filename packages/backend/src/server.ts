import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './logging.js';
import { SqliteStorageAdapter } from './storage/sqlite/index.js';
import { EventService } from './events/event-service.js';
import { EventHub, type DocumentSnapshot } from './events/event-hub.js';
import { AutomergeStoreHolder } from './document/automerge-store-holder.js';
import { RevisionService } from './document/revision-service.js';
import { DocumentService } from './document/document-service.js';
import { toConversationDto } from './conversation/conversation-mapper.js';
import { ConversationService } from './conversation/conversation-service.js';
import { PrimaryService } from './conversation/primary-service.js';
import { ConcurrencyLimiter } from './conversation/concurrency-limiter.js';
import { PiService } from './pi/pi-service.js';
import { PrimaryMutex } from './pi/primary-mutex.js';
import { RunBuffer } from './events/run-buffer.js';
import { ConflictService } from './edit/conflict-service.js';
import { EditService } from './edit/edit-service.js';
import { registerDocumentRoutes } from './api/http/document.js';
import { registerRevisionRoutes } from './api/http/revisions.js';
import { registerConversationRoutes } from './api/http/conversations.js';
import { registerEditRoutes } from './api/http/edits.js';
import { registerSettingsRoutes } from './api/http/settings.js';
import { registerWsRoutes } from './api/ws/index.js';

export function buildApp() {
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const storage = new SqliteStorageAdapter(config.databasePath);

  // Test-only hook: e2e specs need an observably fast debounce. Applied in-process (not via a
  // separate seeding script) to avoid racing this process's own SQLite connection.
  if (process.env.E2E_SEED_REVISION_DEBOUNCE_MS) {
    storage.updateSettings(
      { revisionDebounceMs: Number(process.env.E2E_SEED_REVISION_DEBOUNCE_MS) },
      new Date().toISOString(),
    );
  }

  const eventService = new EventService(storage);

  const getSnapshot = (documentId: string): DocumentSnapshot => {
    const doc = storage.getDocument();
    const content = automergeHolder.isSet() ? automergeHolder.get().getContent() : '';
    const conversations = storage
      .listAllConversations(documentId)
      .map((c) => toConversationDto(storage, c, doc?.currentRevision ?? 0));
    return {
      document: {
        id: doc?.id ?? documentId,
        title: doc?.title ?? '',
        currentRevision: doc?.currentRevision ?? 0,
        createdAt: doc?.createdAt ?? '',
        updatedAt: doc?.updatedAt ?? '',
        content,
      },
      conversations,
    };
  };

  const eventHub = new EventHub(eventService, getSnapshot);
  const automergeHolder = new AutomergeStoreHolder();
  const revisionService = new RevisionService(storage, eventService, eventHub, automergeHolder);
  const documentService = new DocumentService(
    storage,
    eventService,
    eventHub,
    automergeHolder,
    revisionService,
  );

  // Breaks the DocumentService <-> RevisionService construction cycle (see revision-service.ts):
  // RevisionService notifies DocumentService of every revision it creates so staleness (FR-016)
  // can be recomputed, mirroring the PiService.setEditService pattern below.
  revisionService.setDocumentService(documentService);

  // Restart recovery (FR-039/FR-039a): load existing Automerge state now; interrupted "working"
  // conversations are recovered further below, once ConversationService exists.
  documentService.loadIfExists();

  const runBuffer = new RunBuffer();
  const primaryMutex = new PrimaryMutex();
  const piService = new PiService(storage, automergeHolder, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);

  // ConflictService never depends on PiService/ConversationService — a conflict discovered
  // synchronously within an active turn (the Primary path) is reported as that same tool call's
  // own result, never a new send(); EditService requests a fresh turn itself for a conflict
  // discovered later (edits.ts's async apply path), which needs PiService/ConcurrencyLimiter but
  // not ConversationService. This ordering — and PiService.setEditService below — is what breaks
  // what would otherwise be a PiService <-> EditService construction cycle (pi-service.ts).
  const conflictService = new ConflictService(storage, eventService, eventHub, automergeHolder);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automergeHolder,
    revisionService,
    conflictService,
    piService,
    concurrencyLimiter,
    runBuffer,
  );
  piService.setEditService(editService);

  const primaryService = new PrimaryService(storage, eventService, eventHub, primaryMutex);

  const conversationService = new ConversationService(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    automergeHolder,
    primaryService,
  );

  // Defensive idempotency: Main is normally created as part of document creation
  // (DocumentService.create); this only fills a gap if that invariant were ever violated.
  const existingDocument = storage.getDocument();
  if (existingDocument) {
    conversationService.ensureMain(existingDocument.id);

    // Restart recovery (FR-039a): any conversation still `working` when the process last stopped
    // was interrupted mid-run, not gracefully idled — it is never resumed, only marked errored so
    // the user can retry it (FR-038). Run after `documentService.loadIfExists()` above, which is
    // where the document/currentRevision-vs-latest-revision-row consistency check lives.
    conversationService.recoverInterruptedRuns(existingDocument.id);
  }

  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(websocketPlugin);
  app.register(async (instance) => {
    registerDocumentRoutes(instance, { documentService, revisionService });
    registerRevisionRoutes(instance, { storage, revisionService });
    registerConversationRoutes(instance, { conversationService, primaryService, storage });
    registerEditRoutes(instance, { editService });
    registerSettingsRoutes(instance, { storage, eventService, eventHub });
    registerWsRoutes(instance, { eventHub, storage });
  });

  return { app, storage };
}

async function main() {
  const { app } = buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
