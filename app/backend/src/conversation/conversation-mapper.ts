import type {
  ConversationDto,
  ConversationSeedSelectionDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import type {
  ConversationRow,
  StorageAdapter,
  UserSettingsRow,
} from '../storage/storage-adapter.ts';

/**
 * Resolves a stored anchor against the CURRENT document. A naive
 * `documentContent.slice(from, to) !== text` check is a false-positive machine: any edit applied
 * anywhere EARLIER in the document shifts every later raw offset, so an anchor whose text is still
 * present, byte-for-byte, just at a new offset, would otherwise get flagged `anchorOrphaned: true`.
 *
 * The raw offset is trusted as a fast path only when it still matches verbatim. Otherwise the
 * whole document is searched for the anchor text (same "anchored find" idea `text-anchor.ts`'s
 * `reconcile` already uses for staged edits) and, if found, the closest occurrence to the original
 * offset is treated as the anchor's true current position — a true orphan is only text that no
 * longer appears anywhere in the document at all.
 */
// Every `GET /conversations` (REST poll, WS subscribe snapshot, or resync) rebuilds every
// conversation's DTO, and `findClosestOccurrence` below is an unbounded scan over the whole
// document once the fast path misses — repeating that on every poll between actual document
// edits is pure waste, and under enough concurrent polling (e.g. a11y.spec.ts's 200ms-interval
// status poll) it's synchronous CPU work competing with this single-threaded server for time on
// the same event loop that delivers WS status updates, delaying them. Cached per conversation id,
// invalidated only when `currentRevision` actually advances (the one thing that can change where
// an anchor's text now lives).
const seedSelectionCache = new Map<
  string,
  {
    revision: number;
    // Belt-and-suspenders alongside `revision`: in real operation `currentRevision` always
    // advances in lockstep with `documentContent` (both come from the same document read), so
    // this is redundant there — but it's what makes the cache safe to key on `revision` alone
    // without also requiring every caller to guarantee that lockstep (e.g. a unit test directly
    // exercising several different fixture contents under one fixed revision number).
    contentLength: number;
    result: { seedSelection: ConversationSeedSelectionDto | null; anchorOrphaned: boolean };
  }
>();

function resolveSeedSelection(
  conversationId: string,
  currentRevision: number,
  documentContent: string,
  seedSelection: ConversationSeedSelectionDto | null,
): { seedSelection: ConversationSeedSelectionDto | null; anchorOrphaned: boolean } {
  if (seedSelection === null) return { seedSelection: null, anchorOrphaned: false };

  const cached = seedSelectionCache.get(conversationId);
  if (
    cached &&
    cached.revision === currentRevision &&
    cached.contentLength === documentContent.length
  ) {
    return cached.result;
  }

  let result: { seedSelection: ConversationSeedSelectionDto | null; anchorOrphaned: boolean };
  if (documentContent.slice(seedSelection.from, seedSelection.to) === seedSelection.text) {
    // Fast path: untouched (or only touched after this anchor), raw offset still exact.
    result = { seedSelection, anchorOrphaned: false };
  } else {
    const foundAt = findClosestOccurrence(documentContent, seedSelection.text, seedSelection.from);
    result =
      foundAt === null
        ? // The anchor text genuinely no longer exists anywhere in the document.
          { seedSelection, anchorOrphaned: true }
        : {
            seedSelection: {
              ...seedSelection,
              from: foundAt,
              to: foundAt + seedSelection.text.length,
            },
            anchorOrphaned: false,
          };
  }

  seedSelectionCache.set(conversationId, {
    revision: currentRevision,
    contentLength: documentContent.length,
    result,
  });
  return result;
}

/** Every offset in `haystack` at which `needle` occurs; returns whichever is closest to
 *  `originalFrom`, or `null` when `needle` never occurs. */
function findClosestOccurrence(
  haystack: string,
  needle: string,
  originalFrom: number,
): number | null {
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

interface DtoContext {
  settings: UserSettingsRow;
  /** Pending staged-edit counts, pre-grouped by conversation id — see `toConversationDtos`. */
  pendingEditCountByConversationId: Map<string, number>;
}

function buildConversationDto(
  row: ConversationRow,
  currentRevision: number,
  documentContent: string,
  ctx: DtoContext,
): ConversationDto {
  const { settings } = ctx;
  const pendingEditCount = ctx.pendingEditCountByConversationId.get(row.id) ?? 0;
  const { seedSelection, anchorOrphaned } = resolveSeedSelection(
    row.id,
    currentRevision,
    documentContent,
    row.seedSelection,
  );

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    branchDepth: row.branchDepth,
    status: row.status,
    isPrimary: row.isPrimary,
    isCurrentMain: row.isCurrentMain,
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
    doneAt: row.doneAt,
    seedExcerptText: row.seedExcerptText,
  };
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

  return buildConversationDto(row, currentRevision, documentContent, {
    settings,
    pendingEditCountByConversationId: new Map([[row.id, pendingEditCount]]),
  });
}

/**
 * Batch counterpart of `toConversationDto`. `toConversationDto` costs one `getSettings()` call
 * plus one `listStagedEditsByConversation()` call EVERY time it's invoked, so any
 * `rows.map(row => toConversationDto(...))` loop turns into 2N storage round trips for N rows in
 * one request.
 *
 * This fetches `getSettings()` once and pending staged edits once per distinct `documentId` among
 * `rows` (normally exactly one query, since a request's rows are almost always all for the same
 * document) via the already-batch-shaped `listPendingStagedEdits(documentId)`, groups them by
 * conversation id in memory, and reuses both across every row — collapsing the per-row loop to a
 * constant number of storage calls regardless of row count. Used by both `server.ts`'s WS-subscribe
 * snapshot builder and `ConversationService.getAll`. `toConversationDto` itself is kept as-is for
 * single-row call sites (branch/rename/review/etc.) where there's no N+1 to begin with.
 */
export function toConversationDtos(
  storage: StorageAdapter,
  rows: ConversationRow[],
  currentRevision: number,
  documentContent: string,
): ConversationDto[] {
  if (rows.length === 0) return [];

  const settings = storage.getSettings();
  const pendingEditCountByConversationId = new Map<string, number>();
  const documentIds = new Set(rows.map((row) => row.documentId));
  for (const documentId of documentIds) {
    for (const edit of storage.listPendingStagedEdits(documentId)) {
      pendingEditCountByConversationId.set(
        edit.conversationId,
        (pendingEditCountByConversationId.get(edit.conversationId) ?? 0) + 1,
      );
    }
  }

  const ctx: DtoContext = { settings, pendingEditCountByConversationId };
  return rows.map((row) => buildConversationDto(row, currentRevision, documentContent, ctx));
}
