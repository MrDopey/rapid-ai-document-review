import { describe, expect, it } from 'vitest';
import {
  buildMainSeedMessage,
  deriveBranchName,
  extractSeedExcerpt,
  wrapDocumentRevision,
} from '../../src/conversation/seed-excerpt.js';

/** Builds `count` blank-line-separated paragraphs, each `wordsPerParagraph` words long. */
function buildParagraphs(count: number, wordsPerParagraph: number): string[] {
  const paragraphs: string[] = [];
  for (let p = 0; p < count; p += 1) {
    const words = Array.from({ length: wordsPerParagraph }, (_, w) => `p${p}w${w}`);
    paragraphs.push(words.join(' ') + '.');
  }
  return paragraphs;
}

describe('extractSeedExcerpt', () => {
  it('bounds a small selection in headless prose to nearby paragraphs, not the whole document (FR-012)', () => {
    // ~15,000 words of headless prose (300 paragraphs x 50 words), matching the reported regression.
    const paragraphs = buildParagraphs(300, 50);
    const content = paragraphs.join('\n\n');

    // Select a few words in the middle paragraph.
    const middleIndex = 150;
    const middleParagraphStart = content.indexOf(paragraphs[middleIndex]!);
    const from = middleParagraphStart;
    const to = from + 20; // a short selection, well within the one paragraph

    const excerpt = extractSeedExcerpt(content, from, to);
    const excerptWordCount = excerpt.trim().split(/\s+/).length;

    // Old behavior (no heading bound found on either side) fell through to the full 2,000-word
    // cap. The fix should bound this to roughly the selection's own paragraph plus one paragraph
    // of bridging context on each side (~150 words here), nowhere near the 2,000-word cap.
    expect(excerptWordCount).toBeLessThan(300);
    expect(excerpt).toContain(`p${middleIndex}w0`);
    // Paragraphs far from the selection must not be pulled in.
    expect(excerpt).not.toContain('p0w0');
    expect(excerpt).not.toContain('p299w0');
  });

  it('still returns the full enclosing section when headings bound both sides (regression)', () => {
    const content = [
      '# Section One',
      '',
      'Filler paragraph before the target section.',
      '',
      '# Section Two',
      '',
      'First paragraph of section two.',
      '',
      'Second paragraph of section two, which contains the target selection text.',
      '',
      '# Section Three',
      '',
      'Filler paragraph after the target section.',
    ].join('\n');

    const targetIndex = content.indexOf('target selection text');
    const excerpt = extractSeedExcerpt(content, targetIndex, targetIndex + 6);

    expect(excerpt).toContain('Section Two');
    expect(excerpt).toContain('First paragraph of section two.');
    expect(excerpt).toContain('Second paragraph of section two');
    // One bridging paragraph before/after the section is still included.
    expect(excerpt).toContain('Filler paragraph before the target section.');
    expect(excerpt).toContain('Filler paragraph after the target section.');
    // But not the sections beyond those bridging paragraphs.
    expect(excerpt).not.toContain('Section One');
    expect(excerpt).not.toContain('Section Three');
  });

  it('falls back to the local paragraph (not the document start) when there is no heading before the selection', () => {
    const paragraphs = buildParagraphs(50, 40);
    // No heading anywhere before the target paragraph; one heading appears only after it.
    const targetIndex = 40;
    const content = `${paragraphs.slice(0, targetIndex + 1).join('\n\n')}\n\n# Later Section\n\n${paragraphs
      .slice(targetIndex + 1)
      .join('\n\n')}`;

    const targetOffset = content.indexOf(paragraphs[targetIndex]!);
    const excerpt = extractSeedExcerpt(content, targetOffset, targetOffset + 10);
    const excerptWordCount = excerpt.trim().split(/\s+/).length;

    expect(excerptWordCount).toBeLessThan(200);
    expect(excerpt).toContain(`p${targetIndex}w0`);
    expect(excerpt).not.toContain('p0w0');
  });

  it('still reaches the 2,000-word cap when the local paragraph itself is legitimately that large', () => {
    const hugeParagraph = Array.from({ length: 2500 }, (_, i) => `word${i}`).join(' ') + '.';
    const content = `Short lead-in.\n\n${hugeParagraph}\n\nShort trailing paragraph.`;
    const from = content.indexOf(hugeParagraph);
    const to = from + 10;

    const excerpt = extractSeedExcerpt(content, from, to);
    const excerptWordCount = excerpt.trim().split(/\s+/).length;

    // Capped at ~2,000 words (a few extra tokens tolerated for the truncation marker text).
    expect(excerptWordCount).toBeLessThanOrEqual(2010);
    expect(excerptWordCount).toBeGreaterThan(1900);
    expect(excerpt).toContain('truncated to 2000 words');
  });
});

describe('deriveBranchName', () => {
  it('uses the seed excerpt heading when present', () => {
    const name = deriveBranchName('# My Section\n\nSome text.', 'Some text.');
    expect(name).toBe('My Section');
  });

  it('falls back to leading selection words when there is no heading', () => {
    const name = deriveBranchName('Just prose, no heading here.', 'Just prose, no heading here.');
    expect(name).toBe('Just prose, no heading here.');
  });
});

describe('buildMainSeedMessage', () => {
  it('leads with the title/revision and includes the full document content, uncapped, wrapped in a matching <document-revision-N> tag', () => {
    const content = 'A'.repeat(3000); // well beyond extractSeedExcerpt's 2,000-word cap
    const message = buildMainSeedMessage('Quarterly Strategy', 3, content);

    expect(message).toContain('Quarterly Strategy');
    expect(message).toContain('revision 3');
    expect(message).toContain('<document-revision-3>');
    expect(message).toContain('</document-revision-3>');
    expect(message).toContain(content);
    // Content itself is nested inside the tag, not merely present somewhere in the message.
    expect(message).toContain(`<document-revision-3>\n${content}\n</document-revision-3>`);
  });
});

describe('wrapDocumentRevision', () => {
  it('wraps content in matching opening/closing tags naming the revision', () => {
    const wrapped = wrapDocumentRevision(7, 'Some document content.');
    expect(wrapped).toBe('<document-revision-7>\nSome document content.\n</document-revision-7>');
  });
});
