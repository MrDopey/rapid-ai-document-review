import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { config } from './config.ts';
import { logger, warnIfHostOverridden } from './logging.ts';
import { SqliteStorageAdapter } from './storage/sqlite/index.ts';
import { EventService } from './events/event-service.ts';
import { EventHub, type DocumentSnapshot } from './events/event-hub.ts';
import { AutomergeStoreHolder } from './document/automerge-store-holder.ts';
import { RevisionService } from './document/revision-service.ts';
import { DocumentService } from './document/document-service.ts';
import { toConversationDto } from './conversation/conversation-mapper.ts';
import { ConversationService } from './conversation/conversation-service.ts';
import { PrimaryService } from './conversation/primary-service.ts';
import { ConcurrencyLimiter } from './conversation/concurrency-limiter.ts';
import { PiService } from './pi/pi-service.ts';
import { PrimaryMutex } from './pi/primary-mutex.ts';
import { RunBuffer } from './events/run-buffer.ts';
import { ConflictService } from './edit/conflict-service.ts';
import { EditService } from './edit/edit-service.ts';
import { registerDocumentRoutes } from './api/http/document.ts';
import { registerRevisionRoutes } from './api/http/revisions.ts';
import { registerConversationRoutes } from './api/http/conversations.ts';
import { registerEditRoutes } from './api/http/edits.ts';
import { registerSettingsRoutes } from './api/http/settings.ts';
import { registerWsRoutes } from './api/ws/index.ts';

export function buildApp() {
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const storage = new SqliteStorageAdapter(config.databasePath);

  // Test-only hook: e2e specs need an observably fast debounce. Applied in-process (not via a
  // separate seeding script) to avoid racing this process's own SQLite connection.
  if (process.env.RADR_BE_E2E_SEED_REVISION_DEBOUNCE_MS) {
    storage.updateSettings(
      { revisionDebounceMs: Number(process.env.RADR_BE_E2E_SEED_REVISION_DEBOUNCE_MS) },
      new Date().toISOString(),
    );
  }

  const eventService = new EventService(storage);

  const getSnapshot = (documentId: string): DocumentSnapshot => {
    const doc = storage.getDocument();
    const content = automergeHolder.isSet() ? automergeHolder.get().getContent() : '';
    const conversations = storage
      .listAllConversations(documentId)
      .map((c) => toConversationDto(storage, c, doc?.currentRevision ?? 0, content));
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
  // Constructed ahead of RevisionService/DocumentService/EditService (moved up from further below)
  // since all three now depend on it too (FIX 4/FIX 1): PrimaryMutex has generalized from just
  // guarding `propose_document_edit`/Primary-designation switches into the one per-document write
  // lock every document-mutating path serializes against, `RevisionService.restore` included (see
  // primary-mutex.ts).
  const primaryMutex = new PrimaryMutex();
  const revisionService = new RevisionService(storage, eventService, eventHub, automergeHolder, primaryMutex);
  const documentService = new DocumentService(
    storage,
    eventService,
    eventHub,
    automergeHolder,
    revisionService,
    primaryMutex,
  );

  // Breaks the DocumentService <-> RevisionService construction cycle (see revision-service.ts):
  // RevisionService notifies DocumentService of every revision it creates so staleness (FR-016)
  // can be recomputed, mirroring the PiService.setEditService pattern below.
  revisionService.setDocumentService(documentService);

  // Restart recovery (FR-039/FR-039a): load existing Automerge state now; interrupted "working"
  // conversations are recovered further below, once ConversationService exists.
  documentService.loadIfExists();

  const runBuffer = new RunBuffer();
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
    primaryMutex,
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

  // Breaks the DocumentService <-> ConversationService construction cycle (see the comment on
  // `DocumentService.conversationService`): DocumentService.create() seeds a brand-new Main
  // conversation's first message with the document via `conversationService.seedMain`.
  documentService.setConversationService(conversationService);

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

  // `piService` is returned alongside `app`/`storage` solely for black-box contract tests
  // (test-app.ts's `TestApp`) that need to reach into a conversation's underlying (fake, under
  // `RADR_BE_PI_FAKE_SESSIONS=1`) Pi session for introspection — e.g. asserting a branch's seed
  // message actually reached the session's own context, not just the application's event log
  // (branch-continuity.test.ts). Production code (`main()` below) only ever destructures `app`.
  return { app, storage, piService };
}

async function main() {
  const { app } = buildApp();
  warnIfHostOverridden();
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
