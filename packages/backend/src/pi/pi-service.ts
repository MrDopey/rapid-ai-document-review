import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { logger } from '../logging.js';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.js';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.js';
import type { AgentSessionLike } from './agent-session-port.js';
import { createReadDocumentTool } from './document-tools.js';
import type { EventBridge } from './event-bridge.js';
import { FakeAgentSession } from './fake-agent-session.js';
import { buildSystemPrompt } from './system-prompt.js';

/**
 * The ONLY module in this codebase that imports `@earendil-works/pi-coding-agent`
 * (Constitution Principle II). Owns one live `AgentSession` per conversation — lazily created on
 * first send, cached for this process's lifetime — and pipes its events through an `EventBridge`
 * supplied by the caller. `conversation.piSessionPath` is opaque outside this module.
 */
export class PiService {
  private readonly sessions = new Map<string, AgentSessionLike>();
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly automerge: AutomergeStoreHolder,
  ) {}

  private getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntimePromise) {
      // Explicit authPath/modelsPath (rather than relying on Pi's own env-var-driven defaults)
      // keeps this aligned with our own PI_CODING_AGENT_DIR resolution (config.ts) even when the
      // env var itself is unset and each side would otherwise fall back independently.
      this.modelRuntimePromise = ModelRuntime.create({
        authPath: join(config.piCodingAgentDir, 'auth.json'),
        modelsPath: join(config.piCodingAgentDir, 'models.json'),
      });
    }
    return this.modelRuntimePromise;
  }

  private async getOrCreateSession(conversation: ConversationRow): Promise<AgentSessionLike> {
    const cached = this.sessions.get(conversation.id);
    if (cached) return cached;

    if (config.piFakeSessions) {
      const fake = new FakeAgentSession(conversation.piSessionPath);
      this.sessions.set(conversation.id, fake);
      return fake;
    }

    const modelRuntime = await this.getModelRuntime();
    const cwd = process.cwd();
    const sessionDir = dirname(conversation.piSessionPath);

    const sessionManager = existsSync(conversation.piSessionPath)
      ? SessionManager.open(conversation.piSessionPath, sessionDir, cwd)
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

    const readDocumentTool = createReadDocumentTool({
      storage: this.storage,
      automerge: this.automerge,
      conversationId: conversation.id,
    });

    const { session } = await createAgentSession({
      cwd,
      agentDir: config.piCodingAgentDir,
      modelRuntime,
      noTools: 'all', // disables built-in read/bash/edit/write (Principle III, agent-tools.md)
      customTools: [readDocumentTool],
      resourceLoader,
      sessionManager,
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
   */
  async send(conversation: ConversationRow, message: string, bridge: EventBridge): Promise<void> {
    const session = await this.getOrCreateSession(conversation);
    const unsubscribe = session.subscribe((event) => bridge.handle(event));
    bridge.addCleanup(unsubscribe);
    try {
      await session.prompt(message);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      logger.warn(
        { event: 'pi_send_failed', conversationId: conversation.id, err: messageText },
        'Pi session.prompt() failed',
      );
      bridge.handle({ type: 'agent_error', message: messageText });
      throw err;
    }
  }

  /** Reopens a closed conversation's session file for read-only review (FR-035/036, research R1). */
  openForReview(sessionPath: string): SessionManager {
    return SessionManager.open(sessionPath);
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
