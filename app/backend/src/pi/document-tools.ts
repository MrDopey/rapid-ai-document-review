import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { proposeDocumentEditParams, readDocumentParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.ts';
import type { EditService } from '../edit/edit-service.ts';
import type { PrimaryMutex } from './primary-mutex.ts';
import type { StorageAdapter } from '../storage/storage-adapter.ts';

/**
 * `defineTool`'s `parameters` field is a TypeBox `TSchema` (the Pi SDK's tool parameter format),
 * not the Zod schema shared with the rest of the app. This mirrors `readDocumentParams`
 * (app/shared/src/contracts/agent-tools.ts) field-for-field; the Zod schema is still used
 * below as a defense-in-depth runtime check on the params the SDK hands to `execute`.
 */
const ReadDocumentToolParams = Type.Object({
  from_line: Type.Optional(
    Type.Integer({ minimum: 1, description: '1-based first line to return. Omit to read from the beginning.' }),
  ),
  to_line: Type.Optional(
    Type.Integer({ minimum: 1, description: '1-based last line to return, inclusive. Omit to read to the end.' }),
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
  let from = fromLine ?? 1;
  let to = toLine ?? totalLines;

  if (from > totalLines) {
    notes.push(`requested from line ${from}, clamped to ${Math.max(totalLines, 1)}`);
    from = Math.max(totalLines, 1);
  }
  if (to > totalLines) {
    notes.push(`requested to line ${to}, clamped to ${totalLines}`);
    to = totalLines;
  }
  if (from < 1) from = 1;

  const selected = lines.slice(from - 1, to);
  const width = String(to).length;
  const body = selected.map((line, i) => `${String(from + i).padStart(width, ' ')}  ${line}`).join('\n');
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
      const document = deps.storage.getDocument();
      const conversation = deps.storage.getConversation(deps.conversationId);
      if (!document || !conversation) {
        return {
          content: [{ type: 'text' as const, text: 'No document is available to read.' }],
          details: undefined,
        };
      }

      const revisionRow = deps.storage.getRevision(document.id, conversation.contextRevision);
      const content = revisionRow
        ? deps.automerge.get().view(JSON.parse(revisionRow.heads) as string[])
        : deps.automerge.get().getContent();

      const text = renderReadResult(
        document.title,
        conversation.contextRevision,
        content,
        params.from_line,
        params.to_line,
      );

      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  });
}

/**
 * `defineTool`'s TypeBox mirror of `proposeDocumentEditParams` (app/shared/src/contracts/
 * agent-tools.ts) — see the comment on `ReadDocumentToolParams` above for why both exist.
 */
const EditOperationToolParams = Type.Object({
  old_string: Type.String({
    minLength: 1,
    description:
      'Exact existing text to replace, copied verbatim from the document, including whitespace. ' +
      'Must appear EXACTLY ONCE in the document — include surrounding context to disambiguate if ' +
      'the text is repeated.',
  }),
  new_string: Type.String({ description: 'Replacement text. Use an empty string to delete.' }),
});

const ProposeDocumentEditToolParams = Type.Object({
  summary: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'One-line description of this change, shown to the user in the review UI.',
  }),
  operations: Type.Array(EditOperationToolParams, {
    minItems: 1,
    maxItems: 50,
    description:
      'One or more replacements. They may target disjoint parts of the document; they are ' +
      'reviewed and accepted or dropped together as a single proposal.',
  }),
});

export interface ProposeDocumentEditToolDeps {
  storage: StorageAdapter;
  editService: EditService;
  primaryMutex: PrimaryMutex;
  conversationId: string;
}

/**
 * `propose_document_edit` — the agent's only way to change the document (contracts/agent-tools.md).
 * Never mutates the document itself: it always produces one `staged_edit` row, applied immediately
 * only when the conversation is Primary (FR-021/FR-027). Holds the per-document `PrimaryMutex` for
 * the duration of `execute` so a future Primary-designation switch (US5) can serialize against an
 * in-flight proposal (http-api.md §POST /primary "mutually exclusive").
 *
 * FR-026's depth limit is enforced two ways: this execution-time check (a backstop for a limit
 * lowered after the session's tool list was already fixed) and, primarily, by the caller
 * (pi-service.ts) omitting this tool from the registered list entirely for a too-deep conversation.
 */
export function createProposeDocumentEditTool(deps: ProposeDocumentEditToolDeps) {
  return defineTool({
    name: 'propose_document_edit',
    label: 'Propose document edit',
    description:
      'Propose one or more exact find/replace changes to the document. This does not modify the ' +
      'document — it creates a proposal the user reviews and accepts or drops (or, in the Primary ' +
      'conversation, applies immediately through the same review-audited pipeline). Call ' +
      'read_document first so every old_string is copied verbatim and unique.',
    promptSnippet: 'propose_document_edit(summary, operations[]) — propose a reviewable document change',
    parameters: ProposeDocumentEditToolParams,
    execute: async (toolCallId, rawParams) => {
      const params = proposeDocumentEditParams.parse(rawParams);
      const conversation = deps.storage.getConversation(deps.conversationId);
      const document = deps.storage.getDocument();
      if (!conversation || !document) {
        return {
          content: [{ type: 'text' as const, text: 'No document is available to propose an edit against.' }],
          details: undefined,
        };
      }

      const settings = deps.storage.getSettings();
      if (conversation.branchDepth > settings.maxEditingDepth) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `This conversation is at branch depth ${conversation.branchDepth}, beyond the configured ` +
                `maximum editing depth of ${settings.maxEditingDepth}. Proposals are not accepted here, ` +
                'though you can continue to read the document and discuss it normally.',
            },
          ],
          details: undefined,
        };
      }

      return deps.primaryMutex.withLock(document.id, async () => {
        const current = deps.storage.getConversation(deps.conversationId) ?? conversation;

        if (current.isPrimary) {
          const result = await deps.editService.stageAndApplyPrimary(
            deps.conversationId,
            toolCallId,
            params.summary,
            params.operations,
            current.contextRevision,
          );
          const text =
            result.outcome === 'applied'
              ? `Applied to the document as revision ${result.revision} (${params.operations.length} operations).`
              : (result.message ?? 'This proposal could not be applied.');
          return {
            content: [{ type: 'text' as const, text }],
            details: { stagedEditId: result.edit.id },
          };
        }

        const staged = deps.editService.stage(
          deps.conversationId,
          toolCallId,
          params.summary,
          params.operations,
          current.contextRevision,
        );
        const text = [
          `Proposal staged for review (${params.operations.length} operations).`,
          'The document is unchanged until the user accepts it.',
          `Proposal id: ${staged.id}`,
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text }],
          details: { stagedEditId: staged.id },
        };
      });
    },
  });
}
