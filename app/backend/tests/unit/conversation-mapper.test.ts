import { describe, expect, it } from 'vitest';
import { toConversationDto } from '../../src/conversation/conversation-mapper.ts';
import type { ConversationRow, StorageAdapter, UserSettingsRow } from '../../src/storage/storage-adapter.ts';

const SETTINGS: UserSettingsRow = {
  thinkingVisible: false,
  revisionDebounceMs: 300_000,
  maxConcurrentAgents: 3,
  maxEditingDepth: 2,
  maxConversationDepth: 3,
  maxReplacementAttempts: 2,
  softWordCountThreshold: 20_000,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Minimal fake — `toConversationDto` only ever calls `getSettings` and
 *  `listStagedEditsByConversation`. */
function fakeStorage(): StorageAdapter {
  return {
    getSettings: () => SETTINGS,
    listStagedEditsByConversation: () => [],
  } as unknown as StorageAdapter;
}

function baseRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'conv_1',
    documentId: 'doc_1',
    parentId: null,
    name: 'Main',
    kind: 'main',
    piSessionPath: '/tmp/main.jsonl',
    status: 'idle',
    errorMessage: null,
    isPrimary: true,
    contextRevision: 1,
    branchDepth: 0,
    seedSelection: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('toConversationDto anchorOrphaned', () => {
  it('is false when seedSelection is null (Main/top-anchored)', () => {
    const dto = toConversationDto(fakeStorage(), baseRow(), 1, 'Some document content.');
    expect(dto.anchorOrphaned).toBe(false);
    expect(dto.seedSelection).toBeNull();
  });

  it('is false when the current content still matches the recorded seed selection slice', () => {
    const content = 'The quick brown fox jumps over the lazy dog.';
    const from = content.indexOf('brown fox');
    const to = from + 'brown fox'.length;
    const row = baseRow({ seedSelection: { from, to, text: 'brown fox' } });

    const dto = toConversationDto(fakeStorage(), row, 1, content);
    expect(dto.anchorOrphaned).toBe(false);
  });

  it('is true once the document content at the recorded offsets no longer matches (edited or deleted)', () => {
    const original = 'The quick brown fox jumps over the lazy dog.';
    const from = original.indexOf('brown fox');
    const to = from + 'brown fox'.length;
    const row = baseRow({ seedSelection: { from, to, text: 'brown fox' } });

    const editedContent = 'The quick silver fox jumps over the lazy dog.';
    const dto = toConversationDto(fakeStorage(), row, 1, editedContent);
    expect(dto.anchorOrphaned).toBe(true);
  });

  // Bug fix (823de25): an edit applied EARLIER in the document shifts every later raw offset, so
  // an anchor whose text is still present, byte-for-byte, just at a new offset used to be a
  // false-positive `anchorOrphaned: true`. `resolveSeedSelection` now re-searches the whole
  // document for the anchor text and, if found, treats the closest occurrence to the original
  // offset as the anchor's true current position instead of flagging it orphaned.
  it('is false, with the reconciled offset, when an earlier edit shifts the anchor text rather than touching it', () => {
    const original = 'The quick brown fox jumps over the lazy dog.';
    const from = original.indexOf('brown fox');
    const to = from + 'brown fox'.length;
    const row = baseRow({ seedSelection: { from, to, text: 'brown fox' } });

    // An edit inserted well BEFORE the anchor's original offset range shifts "brown fox" later in
    // the document without touching it at all.
    const prefixInsert = 'A brand new opening sentence has been inserted before everything else. ';
    const shiftedContent = prefixInsert + original;
    const expectedFrom = shiftedContent.indexOf('brown fox');
    expect(expectedFrom).not.toBe(from); // sanity check: the offset genuinely moved

    const dto = toConversationDto(fakeStorage(), row, 1, shiftedContent);
    expect(dto.anchorOrphaned).toBe(false);
    expect(dto.seedSelection).toEqual({ from: expectedFrom, to: expectedFrom + 'brown fox'.length, text: 'brown fox' });
  });
});

// specs/005-canvas-conversation-threads — NEW desired behavior, not yet implemented: the data
// model gains a field naming which specific parent-conversation message a branch forked from
// (today the only anchor a branch carries at all is `seedSelection`, a document character-range
// excerpt — see conversation-service.ts's `branch()` doc comment and
// ConversationThreadBox.vue's `parentConversation` doc comment, both of which currently state
// plainly that no message-level anchor exists anywhere in the domain model). Named
// `forkedFromMessageId` here to match this codebase's existing naming style for a nullable
// identifier field (`parentId`, `stagedEditId`, `restoredFrom` in RevisionRow/RevisionDto).
//
// Neither `ConversationRow` (storage-adapter.ts) nor `ConversationDto` (contracts/http.ts) has
// this field yet — this test file is test-authoring only, so it does NOT add the field to those
// production types. Instead it widens the row/dto shapes locally with an intersection type, purely
// so these tests can express the field they expect `toConversationDto` to pass through once a
// separate implementation pass adds it for real. Until then, `row.forkedFromMessageId` is simply
// not read by `toConversationDto`, so `dto.forkedFromMessageId` comes back `undefined` — these
// tests fail on that missing passthrough, not on a typo.
type ConversationRowWithFork = ConversationRow & { forkedFromMessageId: string | null };
type ConversationDtoWithFork = { forkedFromMessageId?: string | null };

describe('toConversationDto forkedFromMessageId (message-level fork anchor — NEW field)', () => {
  it('passes the row value through unchanged when the branch was created from within a conversation (populated with the id of the last message shown at the point of branching)', () => {
    const row: ConversationRowWithFork = {
      ...baseRow({ kind: 'branch', parentId: 'conv_parent' }),
      forkedFromMessageId: 'msg_42',
    };
    const dto = toConversationDto(fakeStorage(), row, 1, 'content') as unknown as ConversationDtoWithFork;
    expect(dto.forkedFromMessageId).toBe('msg_42');
  });

  it('is null for Main, and for a branch created from a document selection with no message context', () => {
    const row: ConversationRowWithFork = { ...baseRow(), forkedFromMessageId: null };
    const dto = toConversationDto(fakeStorage(), row, 1, 'content') as unknown as ConversationDtoWithFork;
    expect(dto.forkedFromMessageId).toBeNull();
  });
});
