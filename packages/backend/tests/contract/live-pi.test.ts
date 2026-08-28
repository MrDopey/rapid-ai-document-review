import { describe, expect, it } from 'vitest';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { config } from '../../src/config.js';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { DocumentService } from '../../src/document/document-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { createProposeDocumentEditTool, createReadDocumentTool } from '../../src/pi/document-tools.js';
import { buildSystemPrompt } from '../../src/pi/system-prompt.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow } from '../../src/storage/storage-adapter.js';
import type { AgentSessionEventLike } from '../../src/pi/agent-session-port.js';

/**
 * T087 / agent-tools.md §Contract test expectations item 10 — the one contract test that talks to
 * the REAL `@earendil-works/pi-coding-agent` SDK instead of `FakePiSession`/`FakeAgentSession`.
 * This requires a real model credential (`PI_CODING_AGENT_DIR/auth.json`, or whatever
 * `ModelRuntime.create` resolves) that is NOT available in the sandbox this was written in — it is
 * gated on `PI_LIVE_TEST=1` and skipped entirely otherwise, and is excluded from every default
 * `npm run test:*` script (`package.json`'s `test:contract` runs `vitest run tests/contract
 * --exclude '**\/live-pi.test.ts'`; only `npm run test:contract:live` — `vitest run
 * tests/contract/live-pi.test.ts` — runs this file, and per agent-tools.md that job is advisory,
 * not a required check, since it depends on external model availability and incurs real usage
 * cost).
 *
 * Deliberately bypasses `PiService`/`ConversationService`/HTTP entirely and constructs a real
 * `AgentSession` inline, mirroring `pi-service.ts`'s own construction code path exactly (same
 * `ModelRuntime.create`, `SessionManager.create`, `DefaultResourceLoader`, `createAgentSession`
 * call with `noTools: 'all'` and the two custom tools) — so this test observes the SDK's raw event
 * stream directly, independent of `EventBridge`'s translation/filtering (e.g. `thinkingVisible`
 * gating, ephemeral-vs-persisted routing), which is exactly what "the double cannot drift silently"
 * requires: this test must fail on its own if the real SDK stops emitting an event type the bridge
 * table depends on, not merely if the bridge mishandles one it already knows about.
 */
const LIVE = process.env.PI_LIVE_TEST === '1';

interface LiveHarness {
  storage: SqliteStorageAdapter;
  automerge: AutomergeStoreHolder;
  editService: EditService;
  piService: PiService;
}

function buildLiveHarness(): LiveHarness {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const eventHub = new EventHub(eventService, () => emptySnapshot);
  const automerge = new AutomergeStoreHolder();
  const revisionService = new RevisionService(storage, eventService, eventHub, automerge);
  const documentService = new DocumentService(storage, eventService, eventHub, automerge, revisionService);
  revisionService.setDocumentService(documentService);

  const runBuffer = new RunBuffer();
  const primaryMutex = new PrimaryMutex();
  const piService = new PiService(storage, automerge, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const conflictService = new ConflictService(storage, eventService, eventHub, automerge);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    conflictService,
    piService,
    concurrencyLimiter,
    runBuffer,
  );
  piService.setEditService(editService);

  documentService.create(
    ['# Live Pi Contract Fixture', '', 'The quick fox jumps over the lazy dog.', ''].join('\n'),
    'Live Pi Contract Fixture',
  );

  return { storage, automerge, editService, piService };
}

function createConversationRow(storage: SqliteStorageAdapter, documentId: string): ConversationRow {
  const now = new Date().toISOString();
  const id = newId('conv');
  return storage.createConversation({
    id,
    documentId,
    parentId: null,
    name: 'Live',
    kind: 'branch',
    piSessionPath: `/tmp/${id}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: false,
    contextRevision: 1,
    branchDepth: 1,
    seedSelection: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

/** Builds a real `AgentSession` exactly as `pi-service.ts`'s `getOrCreateSession` does for a
 *  non-fake conversation — duplicated here (rather than reaching into `PiService`'s private
 *  method) so this test observes the SDK's own raw event stream directly, with nothing from
 *  `EventBridge` in between. */
async function createRealSession(h: LiveHarness, conversation: ConversationRow) {
  const modelRuntime = await ModelRuntime.create({
    authPath: `${config.piCodingAgentDir}/auth.json`,
    modelsPath: `${config.piCodingAgentDir}/models.json`,
  });
  const cwd = process.cwd();
  const sessionManager = SessionManager.create(cwd, '/tmp', { id: conversation.id });

  const tools: ToolDefinition[] = [
    createReadDocumentTool({ storage: h.storage, automerge: h.automerge, conversationId: conversation.id }) as unknown as ToolDefinition,
    createProposeDocumentEditTool({
      storage: h.storage,
      editService: h.editService,
      primaryMutex: new PrimaryMutex(),
      conversationId: conversation.id,
    }) as unknown as ToolDefinition,
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: config.piCodingAgentDir,
    systemPrompt: buildSystemPrompt(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  const { session } = await createAgentSession({
    cwd,
    agentDir: config.piCodingAgentDir,
    modelRuntime,
    noTools: 'all', // Principle III, agent-tools.md — the load-bearing assertion this test makes.
    customTools: tools,
    resourceLoader,
    sessionManager,
  });

  return session;
}

describe.skipIf(!LIVE)('Contract: live Pi SDK (agent-tools.md §Event bridge contract, opt-in)', () => {
  it(
    'noTools: "all" leaves session.getActiveToolNames() empty of every Pi built-in tool',
    async () => {
      const h = buildLiveHarness();
      const doc = h.storage.getDocument()!;
      const conversation = createConversationRow(h.storage, doc.id);
      const session = await createRealSession(h, conversation);
      try {
        const active = session.getActiveToolNames();
        for (const builtin of ['read', 'bash', 'edit', 'write']) {
          expect(active).not.toContain(builtin);
        }
        // Only the two custom tools registered above should be present.
        expect(active).toEqual(expect.arrayContaining(['read_document', 'propose_document_edit']));
        expect(active).toHaveLength(2);
      } finally {
        session.dispose();
      }
    },
    60_000,
  );

  it(
    'a real turn emits every Pi event type the event-bridge mapping table depends on',
    async () => {
      const h = buildLiveHarness();
      const doc = h.storage.getDocument()!;
      const conversation = createConversationRow(h.storage, doc.id);
      const session = await createRealSession(h, conversation);
      const observed = new Set<string>();
      const observedUpdateKinds = new Set<string>();

      const unsubscribe = session.subscribe((event: AgentSessionEventLike) => {
        observed.add(event.type);
        if (event.type === 'message_update') {
          observedUpdateKinds.add(event.update.type);
        }
      });

      try {
        // A direct instruction so the model reliably exercises both tools: read the document,
        // then propose a small, unambiguous edit — driving tool_execution_start/update/end in
        // addition to the base message lifecycle.
        await session.prompt(
          'Call read_document to see the whole document, then call propose_document_edit once to ' +
            'replace the exact text "The quick fox jumps over the lazy dog." with "The quick fox ' +
            'leaps over the lazy dog." Do not explain first — call the tools.',
        );
        await session.waitForIdle();

        // Base turn lifecycle (agent-tools.md §Event bridge contract): every one of these maps to
        // an application event and must be present in any real turn.
        for (const required of ['agent_start', 'message_start', 'message_end', 'agent_end', 'agent_settled']) {
          expect(observed.has(required), `expected the real Pi SDK to emit "${required}"`).toBe(true);
        }
        expect(observedUpdateKinds.has('text_delta'), 'expected at least one message_update/text_delta').toBe(true);

        // Tool events: the prompt above explicitly instructs the model to call both registered
        // tools, so a compliant model run should exercise the full tool lifecycle too.
        for (const required of ['tool_execution_start', 'tool_execution_end']) {
          expect(observed.has(required), `expected the real Pi SDK to emit "${required}" for a tool-using turn`).toBe(true);
        }

        // Not asserted: `thinking_delta` (model-dependent — only reasoning-capable models/configs
        // produce it) and `compaction_start`/`compaction_end`/`queue_update` (agent-tools.md marks
        // these "not surfaced" into application events at all, and reliably forcing a compaction
        // or an in-conversation queue event from a single live turn is impractical here). These
        // are exactly the rows of the event-bridge table this test does not need to force, per its
        // own "not surfaced" carve-out.
      } finally {
        unsubscribe();
        session.dispose();
      }
    },
    120_000,
  );
});

if (!LIVE) {
  // Vitest requires at least one test per file to avoid an empty-suite failure when every `it` in
  // a `describe.skipIf` block is skipped; this one is a plain, always-on sanity check that the
  // gating itself is wired correctly (never touches the network or the real SDK).
  describe('live-pi.test.ts gating', () => {
    it('is skipped by default (PI_LIVE_TEST is not "1")', () => {
      expect(process.env.PI_LIVE_TEST).not.toBe('1');
    });
  });
}
