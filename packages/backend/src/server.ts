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
import { ConcurrencyLimiter } from './conversation/concurrency-limiter.js';
import { PiService } from './pi/pi-service.js';
import { RunBuffer } from './events/run-buffer.js';
import { registerDocumentRoutes } from './api/http/document.js';
import { registerRevisionRoutes } from './api/http/revisions.js';
import { registerConversationRoutes } from './api/http/conversations.js';
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

  // Restart recovery (FR-039/FR-039a): load existing Automerge state; interrupted "working"
  // conversations are recovered once ConversationService exists (Phase 4).
  documentService.loadIfExists();

  const runBuffer = new RunBuffer();
  const piService = new PiService(storage, automergeHolder);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const conversationService = new ConversationService(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
  );

  // Defensive idempotency: Main is normally created as part of document creation
  // (DocumentService.create); this only fills a gap if that invariant were ever violated.
  const existingDocument = storage.getDocument();
  if (existingDocument) {
    conversationService.ensureMain(existingDocument.id);
  }

  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(websocketPlugin);
  app.register(async (instance) => {
    registerDocumentRoutes(instance, { documentService, revisionService });
    registerRevisionRoutes(instance, { storage, revisionService });
    registerConversationRoutes(instance, { conversationService, storage });
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
