import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for `RADR_BE_PI_AGENT_MODEL` (specs/002-pi-agent-model-config), covering tasks.md
 * T005/T006/T008/T009/T010. Purely from the feature's spec/contract/quickstart — `config.ts` and
 * `pi-service.ts` have no override support yet at the time this file is authored, so every test
 * below is expected to be RED until that implementation lands.
 *
 * Driven through the light-weight `PiService.generateFoldSynopsis()` path (not `send()` +
 * `EventBridge`) — it calls the same private `getOrCreateSession()` every send path uses, but only
 * needs `session.subscribe()`/`session.prompt()` to observe the outcome.
 *
 * `@earendil-works/pi-coding-agent` is the ONLY module `pi-service.ts` (and, transitively,
 * `document-tools.ts`) imports from the real SDK, so it is mocked wholesale here. `defineTool` is
 * included (as a structural passthrough) even though the task-provided mock sketch omitted it,
 * because `PiService.buildTools()` — called unconditionally by `getOrCreateSession`, even on the
 * fake-session branch — constructs `read_document` via `document-tools.ts`'s
 * `createReadDocumentTool`, which calls `defineTool(...)` at invocation time; leaving it
 * unmocked (`undefined`) would make every test in this file fail for a harness reason
 * ("defineTool is not a function") rather than for the feature behavior under test.
 */
vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: vi.fn() },
  createAgentSession: vi.fn(),
  SessionManager: { create: vi.fn(), open: vi.fn(), forkFrom: vi.fn() },
  DefaultResourceLoader: vi.fn(),
  // Structural passthrough: `RegisteredToolLike` (pi-service.ts) only cares about `.name` and
  // `.execute`, both already present on the plain object `document-tools.ts` hands to `defineTool`.
  defineTool: vi.fn((def: unknown) => def),
}));

const ORIGINAL_ENV = { ...process.env };

/** A stand-in `Model` value — never inspected structurally, only for identity (`toBe`) checks
 *  against whatever `modelRuntime.getModel(...)` was stubbed to return. */
const FAKE_RESOLVED_MODEL = {
  provider: 'anthropic',
  id: 'claude-opus-4-5',
  kind: 'fake-resolved-model',
};

/** Builds a minimal `AgentSessionLike`-shaped stub (agent-session-port.ts) sufficient for
 *  `PiService.generateFoldSynopsis`: `subscribe()` captures the listener, and `prompt()`
 *  asynchronously delivers `agent_settled` so the returned promise actually resolves instead of
 *  hanging forever in the test. */
function createFakeSessionStub() {
  let listener: ((event: { type: string; [k: string]: unknown }) => void) | null = null;
  return {
    sessionFile: '/tmp/stub-session.jsonl',
    sessionId: 'stub-session-id',
    isStreaming: false,
    isIdle: true,
    subscribe(l: (event: { type: string; [k: string]: unknown }) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    async prompt(_text: string) {
      queueMicrotask(() => listener?.({ type: 'agent_settled' }));
    },
    async sendCustomMessage() {},
    getActiveToolNames(): string[] {
      return [];
    },
    async waitForIdle() {},
    dispose() {},
  };
}

/** Fresh-imports everything this suite needs (config/pi-service must be re-imported per test so
 *  each case's `process.env` mutation + `vi.resetModules()` actually takes effect — same idiom as
 *  `tests/unit/config.test.ts`'s `RADR_BE_HOST` env-reload block), plus the freshly re-mocked SDK module. */
async function loadFresh() {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { PiService } = await import('../../src/pi/pi-service.js');
  const { SqliteStorageAdapter } = await import('../../src/storage/sqlite/index.js');
  const { AutomergeStoreHolder } = await import('../../src/document/automerge-store-holder.js');
  const { PrimaryMutex } = await import('../../src/pi/primary-mutex.js');
  const { newId } = await import('../../src/ids.js');
  return { sdk, PiService, SqliteStorageAdapter, AutomergeStoreHolder, PrimaryMutex, newId };
}

/** Builds a fresh in-memory storage/document/conversation fixture and a `PiService` over it,
 *  mirroring the row shapes `live-pi.test.ts`'s `createConversationRow`/`documentService.create()`
 *  use, but via `StorageAdapter.createDocument`/`createConversation` directly (no
 *  `DocumentService`/`RevisionService`/`EventService` needed for this file's scope). */
function buildHarness(mods: Awaited<ReturnType<typeof loadFresh>>) {
  const { PiService, SqliteStorageAdapter, AutomergeStoreHolder, PrimaryMutex, newId } = mods;
  const storage = new SqliteStorageAdapter(':memory:');
  const automerge = new AutomergeStoreHolder();
  const primaryMutex = new PrimaryMutex();
  const piService = new PiService(storage, automerge, primaryMutex);

  const now = new Date().toISOString();
  const docId = newId('doc');
  const doc = storage.createDocument({
    id: docId,
    title: 'pi-model-config fixture',
    piSessionDir: `/tmp/${docId}`,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  });

  const convId = newId('conv');
  const conversation = storage.createConversation({
    id: convId,
    documentId: doc.id,
    parentId: null,
    name: 'pi-model-config',
    kind: 'branch',
    piSessionPath: `/tmp/${convId}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: false,
    contextRevision: 1,
    branchDepth: 1,
    seedSelection: null,
    forkedFromMessageId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });

  return { storage, automerge, primaryMutex, piService, conversation };
}

function resetEnvBase() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.RADR_BE_PI_AGENT_MODEL;
  delete process.env.RADR_BE_PI_FAKE_SESSIONS;
  process.env.RADR_BE_DATABASE_PATH ??= ':memory:';
  process.env.RADR_BE_LOG_LEVEL ??= 'silent';
}

describe('Contract: RADR_BE_PI_AGENT_MODEL (pi-service.ts session creation)', () => {
  beforeEach(() => {
    vi.resetModules();
    // `vi.resetModules()` alone does not give a fresh mock-fn instance for a `vi.mock`-hoisted
    // module (its factory is not re-invoked on each dynamic re-import in this Vitest setup) — the
    // SAME `sdk.createAgentSession`/`sdk.ModelRuntime.create` mock functions persist across tests,
    // accumulating call history. `vi.resetAllMocks()` clears both call history and any
    // implementation configured by a previous test (mockResolvedValue/mockReturnValue), so each
    // test starts from a clean, unconfigured mock exactly as the per-test setup below expects.
    vi.resetAllMocks();
    resetEnvBase();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // T005 (US1) — a valid, resolvable override is passed into createAgentSession as `model`.
  it('T005: a valid override resolves via ModelRuntime.getModel and is passed as createAgentSession({ model })', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = 'anthropic/claude-opus-4-5';
    const mods = await loadFresh();
    const { sdk } = mods;

    sdk.ModelRuntime.create.mockResolvedValue({
      getModel: vi.fn().mockReturnValue(FAKE_RESOLVED_MODEL),
    });
    sdk.SessionManager.create.mockReturnValue({ id: 'stub-session-manager' });
    const sessionStub = createFakeSessionStub();
    sdk.createAgentSession.mockResolvedValue({ session: sessionStub });

    const { piService, conversation } = buildHarness(mods);

    await expect(piService.generateFoldSynopsis(conversation, 'hello')).resolves.toEqual(
      expect.any(String),
    );

    expect(sdk.createAgentSession).toHaveBeenCalledTimes(1);
    const callArg = sdk.createAgentSession.mock.calls[0]?.[0];
    expect(callArg.model).toBe(FAKE_RESOLVED_MODEL);
  });

  // T006 (US1) — an override that fails to parse, or that ModelRuntime.getModel resolves falsy,
  // must reject naming both the bad value and RADR_BE_PI_AGENT_MODEL, and never call createAgentSession.
  it('T006: an override that does not parse as provider/model rejects naming the value and RADR_BE_PI_AGENT_MODEL, without ever calling createAgentSession', async () => {
    const badValue = 'not-a-valid-model-string';
    process.env.RADR_BE_PI_AGENT_MODEL = badValue;
    const mods = await loadFresh();
    const { sdk } = mods;

    sdk.ModelRuntime.create.mockResolvedValue({
      // Even if the (malformed) value were somehow split and looked up, nothing should resolve.
      getModel: vi.fn().mockReturnValue(undefined),
    });
    sdk.SessionManager.create.mockReturnValue({ id: 'stub-session-manager' });
    sdk.createAgentSession.mockResolvedValue({ session: createFakeSessionStub() });

    const { piService, conversation } = buildHarness(mods);

    await expect(piService.generateFoldSynopsis(conversation, 'hello')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(
            `${badValue}.*RADR_BE_PI_AGENT_MODEL|RADR_BE_PI_AGENT_MODEL.*${badValue}`,
            's',
          ),
        ),
      }),
    );
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });

  it('T006: an override naming a provider/model that ModelRuntime.getModel does not resolve rejects naming the value and RADR_BE_PI_AGENT_MODEL, without ever calling createAgentSession', async () => {
    const badValue = 'anthropic/not-a-real-model';
    process.env.RADR_BE_PI_AGENT_MODEL = badValue;
    const mods = await loadFresh();
    const { sdk } = mods;

    sdk.ModelRuntime.create.mockResolvedValue({
      getModel: vi.fn().mockReturnValue(undefined), // falsy — "does not resolve"
    });
    sdk.SessionManager.create.mockReturnValue({ id: 'stub-session-manager' });
    sdk.createAgentSession.mockResolvedValue({ session: createFakeSessionStub() });

    const { piService, conversation } = buildHarness(mods);

    await expect(piService.generateFoldSynopsis(conversation, 'hello')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(
            `${badValue}.*RADR_BE_PI_AGENT_MODEL|RADR_BE_PI_AGENT_MODEL.*${badValue}`,
            's',
          ),
        ),
      }),
    );
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });

  // T008 (US2, revised: RADR_BE_PI_AGENT_MODEL is now mandatory) — unset must fail fast at config
  // load time, not silently fall back to SDK auto-resolution.
  it('T008: with RADR_BE_PI_AGENT_MODEL unset, the backend fails to start', async () => {
    delete process.env.RADR_BE_PI_AGENT_MODEL;

    await expect(loadFresh()).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });

  // T009 (US2) — RADR_BE_PI_FAKE_SESSIONS=1 with an override set: the real-SDK path is never touched at all.
  it('T009: RADR_BE_PI_FAKE_SESSIONS=1 with an override set never calls ModelRuntime.create or createAgentSession', async () => {
    process.env.RADR_BE_PI_FAKE_SESSIONS = '1';
    process.env.RADR_BE_PI_AGENT_MODEL = 'anthropic/claude-opus-4-5';
    const mods = await loadFresh();
    const { sdk } = mods;

    // Deliberately left unconfigured (would reject/return undefined if ever called) so an
    // accidental real-SDK call surfaces loudly rather than silently "working".
    const { piService, conversation } = buildHarness(mods);

    await expect(piService.generateFoldSynopsis(conversation, 'hello')).resolves.toEqual(
      expect.any(String),
    );

    expect(sdk.ModelRuntime.create).not.toHaveBeenCalled();
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });

  // T010 (US2, revised: mandatory field) — empty-string and whitespace-only values are not valid
  // stand-ins for "unset" here; both must fail fast at config load time, same as fully unset.
  it('T010: an empty-string override fails to start the backend (mandatory)', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = '';

    await expect(loadFresh()).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });

  it('T010: a whitespace-only override fails to start the backend (mandatory)', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = '   ';

    await expect(loadFresh()).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });
});
