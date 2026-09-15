import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { proposeDocumentEditParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import type { EditService } from '../../edit/edit-service.ts';
import type { PrimaryMutex } from '../primary-mutex.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import { textResult } from './common.ts';

/**
 * `defineTool`'s TypeBox mirror of `proposeDocumentEditParams` (app/shared/src/contracts/
 * agent-tools.ts) — see the comment on `ReadDocumentToolParams` (read-document.ts) for why both
 * exist.
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
    promptSnippet:
      'propose_document_edit(summary, operations[]) — propose a reviewable document change',
    parameters: ProposeDocumentEditToolParams,
    execute: async (toolCallId, rawParams) => {
      const params = proposeDocumentEditParams.parse(rawParams);
      const conversation = deps.storage.getConversation(deps.conversationId);
      const document = conversation ? deps.storage.getDocument(conversation.documentId) : null;
      if (!conversation || !document) {
        return textResult('No document is available to propose an edit against.');
      }

      const settings = deps.storage.getSettings();
      if (conversation.branchDepth > settings.maxEditingDepth) {
        return textResult(
          `This conversation is at branch depth ${conversation.branchDepth}, beyond the configured ` +
            `maximum editing depth of ${settings.maxEditingDepth}. Proposals are not accepted here, ` +
            'though you can continue to read the document and discuss it normally.',
        );
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
          return textResult(text, { stagedEditId: result.edit.id });
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
        return textResult(text, { stagedEditId: staged.id });
      });
    },
  });
}
