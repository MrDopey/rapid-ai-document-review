import type { ConversationDto, ConversationSeedSelectionDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';

/**
 * Resolves a stored anchor against the CURRENT document (review finding #1). A naive
 * `documentContent.slice(from, to) !== text` check is a false-positive machine: any edit applied
 * anywhere EARLIER in the document shifts every later raw offset, so an anchor whose text is still
 * present, byte-for-byte, just at a new offset, would otherwise get flagged `anchorOrphaned: true`.
 *
 * Fix: only trust the raw offset as a fast path when it still matches verbatim. Otherwise search
 * the whole document for the anchor text (same "anchored find" idea `text-anchor.ts`'s `reconcile`
 * already uses for staged edits) and, if found, treat the closest occurrence to the original offset
 * as the anchor's true current position — a true orphan is only text that no longer appears
 * anywhere in the document at all.
 */
function resolveSeedSelection(
  documentContent: string,
  seedSelection: ConversationSeedSelectionDto | null,
): { seedSelection: ConversationSeedSelectionDto | null; anchorOrphaned: boolean } {
  if (seedSelection === null) return { seedSelection: null, anchorOrphaned: false };

  if (documentContent.slice(seedSelection.from, seedSelection.to) === seedSelection.text) {
    // Fast path: untouched (or only touched after this anchor), raw offset still exact.
    return { seedSelection, anchorOrphaned: false };
  }

  const foundAt = findClosestOccurrence(documentContent, seedSelection.text, seedSelection.from);
  if (foundAt === null) {
    // The anchor text genuinely no longer exists anywhere in the document.
    return { seedSelection, anchorOrphaned: true };
  }

  return {
    seedSelection: { ...seedSelection, from: foundAt, to: foundAt + seedSelection.text.length },
    anchorOrphaned: false,
  };
}

/** Every offset in `haystack` at which `needle` occurs; returns whichever is closest to
 *  `originalFrom`, or `null` when `needle` never occurs. */
function findClosestOccurrence(haystack: string, needle: string, originalFrom: number): number | null {
  if (needle.length === 0) return null;
  let best: number | null = null;
  let bestDistance = Infinity;
  let searchFrom = 0;
  for (;;) {
    const at = haystack.indexOf(needle, searchFrom);
    if (at === -1) break;
    const distance = Math.abs(at - originalFrom);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
    searchFrom = at + 1; // keep scanning for a possibly-closer later occurrence
  }
  return best;
}

/** Server-computed fields (Principle V: enforcement lives here, never inferred by the UI). */
export function toConversationDto(
  storage: StorageAdapter,
  row: ConversationRow,
  currentRevision: number,
  documentContent: string,
): ConversationDto {
  const settings = storage.getSettings();
  const pendingEditCount = storage
    .listStagedEditsByConversation(row.id)
    .filter((e) => e.status === 'pending').length;
  const { seedSelection, anchorOrphaned } = resolveSeedSelection(documentContent, row.seedSelection);

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    branchDepth: row.branchDepth,
    status: row.status,
    isPrimary: row.isPrimary,
    contextRevision: row.contextRevision,
    isStale: row.contextRevision < currentRevision,
    pendingEditCount,
    canEdit: row.status !== 'closed' && row.branchDepth <= settings.maxEditingDepth,
    canBranch: row.status !== 'closed' && row.branchDepth < settings.maxConversationDepth,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    readOnly: row.status === 'closed',
    seedSelection,
    forkedFromMessageId: row.forkedFromMessageId,
    anchorOrphaned,
  };
}
