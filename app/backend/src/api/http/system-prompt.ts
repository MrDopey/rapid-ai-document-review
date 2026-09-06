import type { FastifyInstance } from 'fastify';
import type { SystemPromptDto } from '@rapid-ai-document-review/shared/contracts/http';
import { buildSystemPrompt } from '../../pi/system-prompt.ts';

/** Read-only: exposes the pi agent's system prompt for display, never for editing. */
export function registerSystemPromptRoutes(app: FastifyInstance): void {
  app.get('/api/system-prompt', async (_request, reply) => {
    const dto: SystemPromptDto = { systemPrompt: buildSystemPrompt() };
    return reply.send(dto);
  });
}
