import type { FastifyInstance } from 'fastify';
import type { SystemPromptDto } from '@rapid-ai-document-review/shared/contracts/http';
import { SystemPromptQuery } from '@rapid-ai-document-review/shared/contracts/http';
import { buildSystemPrompt } from '../../pi/system-prompt.ts';
import { parseOrFail } from './errors.ts';

/** Read-only: exposes the pi agent's system prompt for display, never for editing.
 *  `?mode=thread` returns the Thread-mode variant (011-linear-thread-mode); anything else,
 *  including an omitted query, returns the canvas variant — the dialog that calls this
 *  (`SystemPromptDialog.vue`) is mounted once per app mode and passes its own mode through. */
export function registerSystemPromptRoutes(app: FastifyInstance): void {
  app.get('/api/system-prompt', async (request, reply) => {
    const query = parseOrFail(reply, SystemPromptQuery, request.query);
    if (!query) return;
    const dto: SystemPromptDto = { systemPrompt: buildSystemPrompt(query.mode === 'thread') };
    return reply.send(dto);
  });
}
