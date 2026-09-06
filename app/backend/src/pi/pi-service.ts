import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { config } from '../config.ts';
import { logger } from '../logging.ts';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.ts';
import type { EditService } from '../edit/edit-service.ts';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';
import type { AgentSessionLike } from './agent-session-port.ts';
import { createProposeDocumentEditTool, createReadDocumentTool } from './document-tools.ts';
import type { EventBridge } from './event-bridge.ts';
import { FakeAgentSession } from './fake-agent-session.ts';
import type { PrimaryMutex } from './primary-mutex.ts';
import { buildSystemPrompt } from './system-prompt.ts';

/**
 * Best-effort extraction of readable text from a raw Pi `AgentMessage` entry (`session-manager.ts`
 * `SessionMessageEntry.message`), for seeding a review conversation's transcript (FR-036). Only
 * `user`/`assistant` roles are surfaced — tool calls, custom messages and other internal entry
 * kinds are skipped, since this is a human-readable digest, not a faithful replay.
 */
function extractPlainMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== 'user' && m.role !== 'assistant') return null;

  let text: string | null = null;
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    text = m.content
      .map((part) =>
        part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          ? ((part as { text?: unknown }).text ?? null)
          : null,
      )
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
  }
  if (!text || !text.trim()) return null;
  return `${m.role}: ${text}`;
}

/** The minimal shape `PiService` needs from a registered custom tool, satisfied structurally by
 * whatever `defineTool()` returns — used to hand the same tool objects to `FakeAgentSession` so it
 * can actually invoke `propose_document_edit` when a test scripts it (fake-agent-session.ts).
 * Deliberately loose (`...args: any[]`) since the real `ToolDefinition['execute']` type carries SDK
 * types (`ExtensionContext` etc.) this module has no other reason to import. */
export interface RegisteredToolLike {
  name: string;
  execute(...args: unknown[]): Promise<unknown>;
}

/** Bound on how long one agent turn may run without settling (`agent_settled`/`agent_error`)
 *  before `PiService` force-completes it as `agent_error` itself. This is a backstop for
 *  the real-session path: `FakeAgentSession` has its own, much shorter, internal timeout and
 *  ordinarily self-heals well before this one would ever fire. Overridable via
 *  `PI_AGENT_TURN_TIMEOUT_MS` for tests. */
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

function resolveAgentTurnTimeoutMs(): number {
  const override = Number(process.env.PI_AGENT_TURN_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_AGENT_TURN_TIMEOUT_MS;
}

/**
 * The ONLY module in this codebase that imports `@earendil-works/pi-coding-agent`
 * (Constitution Principle II). Owns one live `AgentSession` per conversation — lazily created on
 * first send, cached for this process's lifetime — and pipes its events through an `EventBridge`
 * supplied by the caller. `conversation.piSessionPath` is opaque outside this module.
 */
export class PiService {
  private readonly sessions = new Map<string, AgentSessionLike>();
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  /** Late-bound (server.ts, right after EditService is constructed): PiService needs EditService
   * to build the `propose_document_edit` tool, and EditService needs PiService to request
   * replacements on an async conflict (edit-service.ts) — a genuine construction cycle broken by
   * deferring this one edge until after both exist. Only read lazily, in `getOrCreateSession`,
   * which never runs before server.ts finishes wiring (it fires on a session's first message). */
  private editService: EditService | null = null;

  private readonly storage: StorageAdapter;
  private readonly automerge: AutomergeStoreHolder;
  private readonly primaryMutex: PrimaryMutex;

  constructor(
    storage: StorageAdapter,
    automerge: AutomergeStoreHolder,
    primaryMutex: PrimaryMutex,
  ) {
    this.storage = storage;
    this.automerge = automerge;
    this.primaryMutex = primaryMutex;
  }

  setEditService(editService: EditService): void {
    this.editService = editService;
  }

  /**
   * Parses `config.piAgentModel` (`provider/model[:thinkingLevel]`, specs/002-pi-agent-model-config —
   * `config.ts` guarantees this is a non-empty, trimmed string, since `RADR_BE_PI_AGENT_MODEL` is a
   * required variable) and resolves it via `modelRuntime.getModel(provider, id)` — deliberately NOT
   * the package-level `getModel` from `@earendil-works/pi-ai`, so `models.json`-defined custom models
   * resolve too (research.md R1). Throws a fail-fast `Error` naming both the literal invalid value and
   * `RADR_BE_PI_AGENT_MODEL` (FR-006) when the string doesn't parse as `provider/model[:thinkingLevel]`,
   * names an unrecognized thinking level, or `modelRuntime.getModel(...)` resolves nothing.
   */
  private resolveConfiguredModel(modelRuntime: ModelRuntime): ReturnType<ModelRuntime['getModel']> {
    const raw = config.piAgentModel;
    if (!raw) return undefined;

    const invalid = (): never => {
      throw new Error(
        `Invalid RADR_BE_PI_AGENT_MODEL value "${raw}": expected "provider/model[:thinkingLevel]" ` +
          `naming a model resolvable via ModelRuntime.getModel() (source: RADR_BE_PI_AGENT_MODEL).`,
      );
    };

    const slashIndex = raw.indexOf('/');
    if (slashIndex <= 0 || slashIndex === raw.length - 1) invalid();

    const provider = raw.slice(0, slashIndex);
    let id = raw.slice(slashIndex + 1);

    const colonIndex = id.lastIndexOf(':');
    if (colonIndex !== -1) {
      const thinkingLevel = id.slice(colonIndex + 1);
      const validThinkingLevels = new Set([
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      if (!validThinkingLevels.has(thinkingLevel)) invalid();
      id = id.slice(0, colonIndex);
    }
    if (!id) invalid();

    const model = modelRuntime.getModel(provider, id);
    if (!model) invalid();
    return model;
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntimePromise) {
      // Explicit authPath/modelsPath (rather than relying on Pi's own env-var-driven defaults)
      // keeps this aligned with our own RADR_BE_PI_CODING_AGENT_DIR resolution (config.ts) even when the
      // env var itself is unset and each side would otherwise fall back independently.
      this.modelRuntimePromise = ModelRuntime.create({
        authPath: join(config.piCodingAgentDir, 'auth.json'),
        modelsPath: join(config.piCodingAgentDir, 'models.json'),
      });
    }
    return this.modelRuntimePromise;
  }

  /** Builds this conversation's registered tool list. `propose_document_edit` is omitted entirely
   * for a too-deep conversation (FR-026's primary defense layer — see document-tools.ts for the
   * execution-time backstop). Shared by both the real SDK path and `FakeAgentSession`, which
   * invokes these same tool objects directly instead of a real model deciding to call them. */
  private buildTools(conversation: ConversationRow): RegisteredToolLike[] {
    const tools: RegisteredToolLike[] = [
      createReadDocumentTool({
        storage: this.storage,
        automerge: this.automerge,
        conversationId: conversation.id,
      }),
    ];

    const settings = this.storage.getSettings();
    if (conversation.branchDepth <= settings.maxEditingDepth && this.editService) {
      tools.push(
        createProposeDocumentEditTool({
          storage: this.storage,
          editService: this.editService,
          primaryMutex: this.primaryMutex,
          conversationId: conversation.id,
        }),
      );
    }
    return tools;
  }

  private async getOrCreateSession(conversation: ConversationRow): Promise<AgentSessionLike> {
    const cached = this.sessions.get(conversation.id);
    if (cached) return cached;

    const tools = this.buildTools(conversation);

    if (config.piFakeSessions) {
      const fake = new FakeAgentSession(conversation.piSessionPath, tools);
      this.sessions.set(conversation.id, fake);
      return fake;
    }

    const modelRuntime = await this.getModelRuntime();
    // specs/002-pi-agent-model-config: only ever resolved on this real-session branch (after the
    // fake-session early return above), so FR-004 holds by construction — fake sessions never
    // touch RADR_BE_PI_AGENT_MODEL at all (research.md R5).
    const model = this.resolveConfiguredModel(modelRuntime);
    const cwd = process.cwd();
    const sessionDir = dirname(conversation.piSessionPath);

    const parent = conversation.parentId
      ? this.storage.getConversation(conversation.parentId)
      : null;

    const sessionManager = existsSync(conversation.piSessionPath)
      ? SessionManager.open(conversation.piSessionPath, sessionDir, cwd)
      : parent && existsSync(parent.piSessionPath)
        ? // Branches fork from the parent's own Pi session file (design.md §21 deviation, plan.md) so
          // the conversation tree lives in one per-document session directory; the seeded excerpt
          // itself still arrives as an ordinary first message (FR-012), never via this fork alone.
          SessionManager.forkFrom(parent.piSessionPath, cwd, sessionDir, { id: conversation.id })
        : SessionManager.create(cwd, sessionDir, { id: conversation.id });

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
      noTools: 'builtin', // disables built-in read/bash/edit/write while keeping customTools active (Principle III, agent-tools.md)
      customTools: tools as unknown as ToolDefinition[],
      resourceLoader,
      sessionManager,
      // Omitted entirely (not `model: undefined`) when no override is configured, so today's SDK
      // auto-resolution is unchanged (FR-003).
      ...(model ? { model } : {}),
    });

    const agentSession = session as unknown as AgentSessionLike;

    const actualPath = agentSession.sessionFile;
    if (actualPath && actualPath !== conversation.piSessionPath) {
      // Pi names session files itself (timestamp + id, session-manager.ts), so the placeholder
      // path recorded at conversation creation is corrected to whatever Pi actually created
      // (research R1) — this is the one place that path is ever written outside DocumentService.
      this.storage.updateConversation(conversation.id, { piSessionPath: actualPath });
    }

    this.sessions.set(conversation.id, agentSession);
    return agentSession;
  }

  /**
   * Sends a message on `conversation`'s session, subscribing `bridge` to its events until the
   * run settles. Throws (after routing a synthetic `agent_error` through the bridge) if the
   * model call fails immediately — the caller translates that into `AGENT_UNAVAILABLE`.
   *
   * A turn that never settles (a stuck tool call, or any other hang) does not leave this
   * conversation's session permanently unusable. A watchdog timer force-completes the turn as
   * `agent_error` if neither `agent_settled` nor `agent_error` arrives within
   * `PI_AGENT_TURN_TIMEOUT_MS`, and — on ANY `agent_error` (immediate `prompt()` rejection, a
   * scripted/real failure during the run, or this watchdog itself) — the cached session for this
   * conversation is evicted so the *next* send/retry builds a fresh one instead of reusing a
   * session that may be wedged.
   */
  async send(conversation: ConversationRow, message: string, bridge: EventBridge): Promise<void> {
    const session = await this.getOrCreateSession(conversation);
    const unsubscribe = session.subscribe((event) => {
      bridge.handle(event);
      // `bridge.hasErrored` (not `event.type === 'agent_error'`): the real Pi SDK has no such
      // event type at all — a model/provider failure surfaces as an ordinary `message_end` that
      // `EventBridge.normalizeRealEvent` recognizes and translates into the bridge's error state.
      if (bridge.hasErrored) {
        this.evictSession(conversation.id);
      }
    });
    bridge.addCleanup(unsubscribe);
    this.armTurnWatchdog(conversation.id, bridge);

    try {
      await session.prompt(message);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      // `event: 'agent_error'` — matches the frame `bridge.handle` below is about to publish for
      // this same failure (contracts/websocket-events.md's closed vocabulary, FR-042); this warn
      // exists only to capture the raw `session.prompt()` exception ahead of that.
      logger.warn(
        { event: 'agent_error', conversationId: conversation.id, err: messageText },
        'Pi session.prompt() failed',
      );
      bridge.handle({ type: 'agent_error', message: messageText });
      this.evictSession(conversation.id);
      throw err;
    }
  }

  /**
   * Delivers a branch's auto-seed message (the document/selection excerpt built by
   * `seed-excerpt.ts`, sent by `ConversationService.sendBranchSeedMessage`) into the underlying Pi
   * session's OWN history at branch-creation time, without ever triggering a turn.
   * `ConversationService.send()` returns early for `isSeed: true` before ever calling
   * `PiService.send()`/`session.prompt()`, since branches must stay transient/inert until the
   * user's own first real message — so without this method, the branch's real Pi session would
   * never even be created at seed time, let alone shown the seed content, and the model would have
   * no idea the excerpt the UI displays ever existed until forking lazily off the parent on the
   * user's first genuine message.
   *
   * `getOrCreateSession` here creates/forks the session exactly as a real `send()` eventually
   * would (so the *same* cached session is reused for the user's first real message afterward —
   * no double session-creation). The content is then handed to `sendCustomMessage()` with neither
   * `triggerTurn` nor `deliverAs` set: the vendor SDK's own non-streaming/no-trigger branch
   * (`agent-session.js`'s `sendCustomMessage`) appends the message directly to the session's
   * in-memory `state.messages` AND persists it to the on-disk session file
   * (`appendCustomMessageEntry`) immediately — `session.prompt()` is never called anywhere in this
   * path, so no completion is requested and no `agent_*` event is ever produced for it. The stored
   * `role: "custom"` entry is translated to an ordinary `role: "user"` turn by the SDK's own
   * `convertToLlm` the next time this session's `prompt()` actually runs (the user's first real
   * message), so the model sees the seed content as normal prior context at that point.
   *
   * Deliberately NOT `sendCustomMessage(..., { deliverAs: 'nextTurn' })` — the mechanism
   * `deliverFoldSummary` below uses for the same "no turn, but in context next time" requirement.
   * That mode only holds the message in an in-memory queue (`_pendingNextTurnMessages`), spliced
   * into the messages array at the moment `prompt()` is next called; it is never persisted to the
   * session file on its own, so it would silently vanish if the process restarted before the
   * branch's first real message ever arrived. A branch can sit untouched far longer than a
   * fold-summary delivery ever would, so the seed needs to survive that.
   */
  async seedSession(conversation: ConversationRow, seedMessage: string): Promise<void> {
    const session = await this.getOrCreateSession(conversation);
    await session.sendCustomMessage({
      customType: 'branch_seed',
      content: seedMessage,
      display: true,
    });
  }

  /** Test-only accessor: the cached session for `conversationId`, if one has been created —
   *  lets contract tests reach into `FakeAgentSession`'s own test-only introspection methods
   *  (e.g. `getSeededHistory()`) to assert that seed content actually reached the underlying Pi
   *  session's context, not just the application's own event log, without exposing the whole
   *  `sessions` map. */
  getSessionForTesting(conversationId: string): AgentSessionLike | undefined {
    return this.sessions.get(conversationId);
  }

  /**
   * Arms a one-shot watchdog for the turn `bridge` is tracking: if the bridge has not settled
   * (`agent_settled`/`agent_error`) within the turn timeout, this synthesizes an `agent_error`
   * through the bridge itself and evicts the conversation's cached session, so a hang that a
   * session's own internal machinery never recovers from still resolves into a retryable
   * `errored` conversation instead of hanging forever. Cleared automatically once the
   * bridge settles by any other means, via `bridge.addCleanup` (fires immediately if the bridge
   * has already settled by the time this runs).
   */
  private armTurnWatchdog(conversationId: string, bridge: EventBridge): void {
    const timeoutMs = resolveAgentTurnTimeoutMs();
    const timer = setTimeout(() => {
      if (bridge.isSettled) return;
      logger.warn(
        { conversationId, timeoutMs },
        'agent turn exceeded its timeout without settling; forcing agent_error',
      );
      bridge.handle({
        type: 'agent_error',
        message: `Agent turn timed out after ${timeoutMs}ms without completing.`,
      });
      this.evictSession(conversationId);
    }, timeoutMs);
    timer.unref?.();
    bridge.addCleanup(() => clearTimeout(timer));
  }

  /**
   * Drops `conversationId`'s cached session (disposing it first, best-effort) so the next
   * `getOrCreateSession` call builds a fresh one instead of reusing a session that just errored or
   * hung — without this, `PiService.sessions` would keep serving the same broken session to every
   * subsequent send/retry for the conversation's whole process lifetime. Also used by
   * `ConversationService.close()` once a closed conversation's session is no longer needed at all.
   * Safe to call on a conversation with no cached session (no-op).
   */
  evictSession(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.sessions.delete(conversationId);
    try {
      session.dispose();
    } catch (err) {
      logger.warn(
        { conversationId, err: err instanceof Error ? err.message : String(err) },
        'error disposing evicted Pi session',
      );
    }
  }

  /** Reopens a closed conversation's session file for read-only review (FR-035/036, research R1). */
  openForReview(sessionPath: string): SessionManager {
    return SessionManager.open(sessionPath);
  }

  /**
   * Asks a closed conversation's own Pi session for the synopsis half of its FR-034/FR-034a fold
   * summary — "what was discussed and decided", which only the conversation's own history can
   * answer well. Deliberately bypasses `EventBridge`: this exchange must not persist to the
   * application event stream or flip `conversation.status` away from `closed` (it is an internal,
   * best-effort operation for the fold feature, not user-facing chat history that
   * `ConversationService.getOne` would surface). The factual parts of the summary (name, seed
   * selection, proposal outcomes/revisions) are assembled deterministically by the caller
   * (conversation-service.ts) rather than trusted to model recall — this call supplies only the
   * synopsis prose.
   */
  async generateFoldSynopsis(conversation: ConversationRow, promptText: string): Promise<string> {
    const session = await this.getOrCreateSession(conversation);
    return new Promise<string>((resolve, reject) => {
      let text = '';
      let settled = false;
      const unsubscribe = session.subscribe((event) => {
        if (settled) return;
        if (event.type === 'message_end' && event.role === 'assistant') {
          text = event.text;
        } else if (event.type === 'agent_settled') {
          settled = true;
          unsubscribe();
          resolve(text);
        } else if (event.type === 'agent_error') {
          settled = true;
          unsubscribe();
          reject(new Error(event.message));
        }
      });
      session.prompt(promptText).catch((err) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Delivers a fold summary into a parent conversation's own Pi session without triggering a new
   * turn itself (research R1: `sendCustomMessage(..., { deliverAs: 'nextTurn' })`) — the parent
   * picks the content up as context whenever it next actually runs, fully decoupled from the
   * `close()` HTTP response that kicked off summary generation (FR-034).
   */
  async deliverFoldSummary(
    parent: ConversationRow,
    sourceConversationName: string,
    summary: string,
  ): Promise<void> {
    const session = await this.getOrCreateSession(parent);
    await session.sendCustomMessage(
      {
        customType: 'conversation_summary_fold',
        content: `Summary from closed conversation "${sourceConversationName}":\n\n${summary}`,
        display: true,
      },
      { deliverAs: 'nextTurn' },
    );
  }

  /**
   * Reads a closed conversation's transcript for seeding a `kind: 'review'` conversation
   * (FR-036, research R1: `SessionManager.open(path)` → `getEntries()`). Strictly read-only —
   * never calls `prompt()` on the reopened session, so the reviewed conversation is left
   * byte-identical (quickstart.md US7 scenario 3). Returns `null` when no session file exists on
   * disk (always true under `RADR_BE_PI_FAKE_SESSIONS=1`, since `FakeAgentSession` never persists to
   * disk, and also if the file is unreadable for any reason) so the caller can fall back to its
   * own stored event log instead.
   */
  readClosedTranscript(sessionPath: string): string[] | null {
    if (!existsSync(sessionPath)) return null;
    try {
      const sm = SessionManager.open(sessionPath);
      const lines: string[] = [];
      for (const entry of sm.getEntries()) {
        if (entry.type !== 'message') continue;
        const text = extractPlainMessageText(entry.message);
        if (text) lines.push(text);
      }
      return lines;
    } catch (err) {
      // No `event` field: this is a filesystem-level failure with no counterpart in the closed
      // WebSocket event vocabulary (FR-042) — the caller's fallback means no domain event is
      // affected by it either.
      logger.warn(
        { sessionPath, err: err instanceof Error ? err.message : String(err) },
        'failed to read closed session transcript; falling back to stored event log',
      );
      return null;
    }
  }

  /** Test/shutdown hook only: drops cached sessions without deleting their files. */
  reset(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.modelRuntimePromise = null;
  }
}
