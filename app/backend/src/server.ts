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
import { toConversationDtos } from './conversation/conversation-mapper.ts';
import { ConversationService } from './conversation/conversation-service.ts';
import { ConversationFoldService } from './conversation/conversation-fold-service.ts';
import { ConversationReviewService } from './conversation/conversation-review-service.ts';
import { ThreadService } from './conversation/thread-service.ts';
import { PrimaryService } from './conversation/primary-service.ts';
import { ConcurrencyLimiter } from './conversation/concurrency-limiter.ts';
import { EventPublisher } from './events/event-publisher.ts';
import { PiService } from './pi/pi-service.ts';
import { PrimaryMutex } from './pi/primary-mutex.ts';
import { TurnRunner } from './pi/turn-runner.ts';
import { RunBuffer } from './events/run-buffer.ts';
import { ToolCallMessageIdCache } from './events/tool-call-message-id-cache.ts';
import { ConflictService } from './edit/conflict-service.ts';
import { EditService } from './edit/edit-service.ts';
import { ListItemService } from './list-items/list-item-service.ts';
import { registerDocumentRoutes } from './api/http/document.ts';
import { registerRevisionRoutes } from './api/http/revisions.ts';
import { registerConversationRoutes } from './api/http/conversations.ts';
import { registerThreadRoutes } from './api/http/threads.ts';
import { registerEditRoutes } from './api/http/edits.ts';
import { registerListItemRoutes } from './api/http/list-items.ts';
import { registerSettingsRoutes } from './api/http/settings.ts';
import { registerSystemPromptRoutes } from './api/http/system-prompt.ts';
import { registerStaticRoutes } from './api/http/static.ts';
import { registerWsRoutes } from './api/ws/index.ts';
import { sendError } from './api/http/errors.ts';

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
    const doc = storage.getDocument(documentId);
    const content = automergeHolder.isSet(documentId)
      ? automergeHolder.get(documentId).getContent()
      : '';
    const conversations = toConversationDtos(
      storage,
      storage.listAllConversations(documentId),
      doc?.currentRevision ?? 0,
      content,
    );
    return {
      document: {
        id: doc?.id ?? documentId,
        title: doc?.title ?? '',
        currentRevision: doc?.currentRevision ?? 0,
        documentType: doc?.documentType ?? 'canvas',
        createdAt: doc?.createdAt ?? '',
        updatedAt: doc?.updatedAt ?? '',
        content,
      },
      conversations,
    };
  };

  const eventHub = new EventHub(eventService, getSnapshot);
  const automergeHolder = new AutomergeStoreHolder();
  // Constructed ahead of RevisionService/DocumentService/EditService since all three depend on it
  // as the one per-document write lock every document-mutating path serializes against,
  // `RevisionService.restore` included (see primary-mutex.ts).
  const primaryMutex = new PrimaryMutex();
  const revisionService = new RevisionService(
    storage,
    eventService,
    eventHub,
    automergeHolder,
    primaryMutex,
  );
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
  documentService.loadAllExisting();

  const listItemService = new ListItemService(storage, eventService, eventHub);

  const runBuffer = new RunBuffer();
  const toolCallMessageIds = new ToolCallMessageIdCache();
  const piService = new PiService(
    storage,
    automergeHolder,
    primaryMutex,
    listItemService,
    toolCallMessageIds,
  );
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  // Shared turn-starting wiring (EventBridge + ConcurrencyLimiter admission), depended on by both
  // EditService (requestReplacement) and ConversationService (send) instead of each independently
  // duplicating that construction — see turn-runner.ts's doc comment for why this is a plain
  // collaborator rather than either service depending on the other.
  const turnRunner = new TurnRunner(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    toolCallMessageIds,
  );

  // ConflictService never depends on PiService/ConversationService — a conflict discovered
  // synchronously within an active turn (the Primary path) is reported as that same tool call's
  // own result, never a new send(); EditService requests a fresh turn itself for a conflict
  // discovered later (edits.ts's async apply path), which needs TurnRunner but not
  // ConversationService. This ordering — and PiService.setEditService below — is what breaks what
  // would otherwise be a PiService <-> EditService construction cycle (pi-service.ts).
  const conflictService = new ConflictService(storage, eventService, eventHub, automergeHolder);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automergeHolder,
    revisionService,
    conflictService,
    turnRunner,
    primaryMutex,
  );
  piService.setEditService(editService);

  const primaryService = new PrimaryService(storage, eventService, eventHub, primaryMutex);

  // Fold-summary delivery and closed-conversation review are separate collaborators, sharing the
  // same storage/piService/publisher primitives ConversationService itself gets injected below.
  const conversationEventPublisher = new EventPublisher(eventService, eventHub);
  const conversationFoldService = new ConversationFoldService(
    storage,
    piService,
    conversationEventPublisher,
  );
  const conversationReviewService = new ConversationReviewService(
    storage,
    piService,
    conversationEventPublisher,
    automergeHolder,
  );

  const conversationService = new ConversationService(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    automergeHolder,
    primaryService,
    turnRunner,
    conversationFoldService,
    conversationReviewService,
  );

  // Breaks the DocumentService <-> ConversationService construction cycle (see the comment on
  // `DocumentService.conversationService`): DocumentService.create() seeds a brand-new Main
  // conversation's first message with the document via `conversationService.seedMain`.
  documentService.setConversationService(conversationService);

  // 011-linear-thread-mode: a separate lifecycle service for threaded-conversation documents'
  // Threads (see thread-service.ts's doc comment for why it's not folded into ConversationService).
  // Depends on `conversationService` (reuses its `send()` for seed delivery) — constructed after
  // it, mirroring the same late-bound-setter pattern `documentService.conversationService` uses.
  const threadService = new ThreadService(
    storage,
    piService,
    eventService,
    eventHub,
    conversationService,
  );
  documentService.setThreadService(threadService);

  // Defensive idempotency: Main is normally created as part of document creation
  // (DocumentService.create); this only fills a gap if that invariant were ever violated.
  for (const doc of storage.listDocuments()) {
    conversationService.ensureMain(doc.id);

    // Restart recovery (FR-039a): any conversation still `working` when the process last stopped
    // was interrupted mid-run, not gracefully idled — it is never resumed, only marked errored so
    // the user can retry it (FR-038). Run after `documentService.loadAllExisting()` above, which is
    // where the document/currentRevision-vs-latest-revision-row consistency check lives.
    conversationService.recoverInterruptedRuns(doc.id);
  }

  const app = Fastify({ loggerInstance: logger });

  // Last-resort normalizer: every route that knows how to interpret a specific typed error
  // already catches it itself and maps it to the app's `ErrorEnvelope` shape (e.g. document.ts's
  // PATCH/DELETE handlers) — this only runs for whatever slips past all of those, so the raw
  // error is always logged here server-side even though its details never reach the client.
  app.setErrorHandler((err: Error & { statusCode?: unknown }, request, reply) => {
    logger.error({ err, method: request.method, url: request.url }, 'unhandled request error');

    // A thrown error can still carry its own intended HTTP status (e.g.
    // `DocumentOutOfSyncError.statusCode`, or a Fastify-internal body-parsing/validation error)
    // even though no route-specific `instanceof` clause happened to catch it here — that's treated
    // as a client-side (4xx) problem rather than flattened into a generic 500.
    const knownStatus = typeof err.statusCode === 'number' ? err.statusCode : null;
    if (knownStatus !== null && knownStatus >= 400 && knownStatus < 500) {
      return sendError(reply, knownStatus, 'VALIDATION_FAILED', err.message);
    }

    return sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(websocketPlugin);
  app.register(async (instance) => {
    registerDocumentRoutes(instance, { documentService, revisionService });
    registerRevisionRoutes(instance, { storage, revisionService });
    registerConversationRoutes(instance, { conversationService, primaryService, storage });
    registerThreadRoutes(instance, { threadService, conversationService, storage });
    registerEditRoutes(instance, { editService, storage });
    registerListItemRoutes(instance, { listItemService, storage });
    registerSettingsRoutes(instance, { storage, eventService, eventHub });
    registerSystemPromptRoutes(instance);
    registerWsRoutes(instance, { eventHub, storage });
  });

  // Wrapped like the routes above (rather than passing `app` directly) to dodge a Fastify+TS
  // quirk: `app`'s concrete pino Logger type won't widen back to FastifyInstance's default logger type.
  app.register(async (instance) => {
    registerStaticRoutes(instance, { logger });
  });

  // `piService`/`listItemService` are returned alongside `app`/`storage` solely for black-box
  // contract tests (test-app.ts's `TestApp`) that need to reach into a conversation's underlying
  // (fake, under `RADR_BE_PI_FAKE_SESSIONS=1`) Pi session for introspection — e.g. asserting a
  // branch's seed message actually reached the session's own context, not just the application's
  // event log (branch-continuity.test.ts) — or to drive `list_item` state directly instead of
  // through the HTTP surface. Production code (`main()` below) only ever destructures `app`.
  return { app, storage, piService, listItemService };
}

async function main() {
  // Process-level safety nets, registered once for the real running server (not on every
  // `buildApp()` call, so tests importing this module don't inherit them): an unhandled promise
  // rejection is logged and swallowed rather than left to crash the process outright, while an
  // uncaught synchronous exception has already left the process in a possibly-inconsistent state
  // — it's logged with its full stack and the process exits non-zero, per Node's own documented
  // best practice for `uncaughtException`.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });

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
