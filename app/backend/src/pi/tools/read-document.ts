import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readDocumentParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import type { AutomergeStoreHolder } from '../../document/automerge-store-holder.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import { clampWithNote, textResult } from './common.ts';

/**
 * `defineTool`'s `parameters` field is a TypeBox `TSchema` (the Pi SDK's tool parameter format),
 * not the Zod schema shared with the rest of the app. This mirrors `readDocumentParams`
 * (app/shared/src/contracts/agent-tools.ts) field-for-field; the Zod schema is still used
 * below as a defense-in-depth runtime check on the params the SDK hands to `execute`.
 */
const ReadDocumentToolParams = Type.Object({
  from_line: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: '1-based first line to return. Omit to read from the beginning.',
    }),
  ),
  to_line: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: '1-based last line to return, inclusive. Omit to read to the end.',
    }),
  ),
});

export interface ReadDocumentToolDeps {
  storage: StorageAdapter;
  automerge: AutomergeStoreHolder;
  conversationId: string;
}

/**
 * Renders the line-numbered text block described in contracts/agent-tools.md §read_document.
 * The exact layout is model-facing prose, not a versioned contract — only the clamp/ordering
 * behavior below is load-bearing.
 */
function renderReadResult(
  title: string,
  contextRevision: number,
  content: string,
  fromLine: number | undefined,
  toLine: number | undefined,
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (fromLine !== undefined && toLine !== undefined && fromLine > toLine) {
    return `from_line (${fromLine}) must be less than or equal to to_line (${toLine}).`;
  }

  const notes: string[] = [];
  const fromClamp = clampWithNote(fromLine ?? 1, 1, Math.max(totalLines, 1), 'from line');
  const toClamp = clampWithNote(toLine ?? totalLines, 1, totalLines, 'to line');
  const from = fromClamp.value;
  const to = toClamp.value;
  if (fromClamp.note) notes.push(fromClamp.note);
  if (toClamp.note) notes.push(toClamp.note);

  const selected = lines.slice(from - 1, to);
  const width = String(to).length;
  const body = selected
    .map((line, i) => `${String(from + i).padStart(width, ' ')}  ${line}`)
    .join('\n');
  const noteSuffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  return [
    `Document: ${title}`,
    `Revision: ${contextRevision} (conversation context)`,
    `Lines ${from}-${to} of ${totalLines}${noteSuffix}`,
    '',
    body,
  ].join('\n');
}

/**
 * `read_document` — the agent's only way to see the document (contracts/agent-tools.md).
 * Serves content from the conversation's `context_revision`, not the live document (FR-017), and
 * is available regardless of branch depth: reading is not gated by `max_editing_depth` (FR-026).
 */
export function createReadDocumentTool(deps: ReadDocumentToolDeps) {
  return defineTool({
    name: 'read_document',
    label: 'Read document',
    description:
      "Read the document under review, as it stood at this conversation's context revision. " +
      'Returns line-numbered text. Omit from_line/to_line to read the whole document.',
    promptSnippet: 'read_document(from_line?, to_line?) — read the document under review',
    parameters: ReadDocumentToolParams,
    execute: async (_toolCallId, rawParams) => {
      const params = readDocumentParams.parse(rawParams);
      const conversation = deps.storage.getConversation(deps.conversationId);
      const document = conversation ? deps.storage.getDocument(conversation.documentId) : null;
      if (!document || !conversation) {
        return textResult('No document is available to read.');
      }

      const revisionRow = deps.storage.getRevision(document.id, conversation.contextRevision);
      const content = revisionRow
        ? deps.automerge.get(document.id).view(JSON.parse(revisionRow.heads) as string[])
        : deps.automerge.get(document.id).getContent();

      const text = renderReadResult(
        document.title,
        conversation.contextRevision,
        content,
        params.from_line,
        params.to_line,
      );

      return textResult(text);
    },
  });
}
