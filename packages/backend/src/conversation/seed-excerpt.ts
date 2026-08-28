const HEADING_RE = /^#{1,6}\s+\S/;
const SEED_WORD_CAP = 2000;

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Trims `text` to at most `maxWords` words, from the edges inward, marking the cut with an ellipsis. */
function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  const truncated = words.slice(0, maxWords).join(' ');
  return `${truncated}\n\n[…seed excerpt truncated to ${maxWords} words…]`;
}

/**
 * Finds the paragraph (a run of non-blank lines) immediately preceding `beforeOffset`, if any.
 * Paragraphs are separated by one or more blank lines.
 */
/** A bridging paragraph is prose, not a bare heading line — excluding heading-only "paragraphs"
 * also keeps `deriveBranchName`'s first-heading search below from picking up an outer/ancestor
 * heading (e.g. the document's H1) that only appears here as filler context, instead of the
 * selection's own enclosing section heading. */
function isProseParagraph(p: string): boolean {
  const trimmed = p.trim();
  return trimmed.length > 0 && !HEADING_RE.test(trimmed);
}

function paragraphBefore(content: string, beforeOffset: number): string {
  const prefix = content.slice(0, beforeOffset);
  const paragraphs = prefix.split(/\n\s*\n/).filter(isProseParagraph);
  return paragraphs.at(-1)?.trim() ?? '';
}

function paragraphAfter(content: string, afterOffset: number): string {
  const suffix = content.slice(afterOffset);
  const paragraphs = suffix.split(/\n\s*\n/).filter(isProseParagraph);
  return paragraphs.at(0)?.trim() ?? '';
}

/**
 * FR-012: seed a branch with the nearest enclosing section (heading + content) containing the
 * selection, plus one paragraph immediately before and after the selection, capped at a combined
 * 2,000 words. This is a point-in-time copy — never live-linked to the document.
 */
export function extractSeedExcerpt(content: string, from: number, to: number): string {
  const starts = lineStarts(content);
  const lines = content.split('\n');

  // Find the line index containing `from`, then walk backward for the nearest heading line.
  let fromLineIndex = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i]! <= from) fromLineIndex = i;
    else break;
  }

  let sectionStart = 0;
  for (let i = fromLineIndex; i >= 0; i -= 1) {
    if (HEADING_RE.test(lines[i] ?? '')) {
      sectionStart = starts[i]!;
      break;
    }
  }

  // Find the line index containing `to`, then walk forward for the next heading line (start of
  // the following section) — that bounds the enclosing section's end.
  let toLineIndex = starts.length - 1;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i]! <= to) toLineIndex = i;
    else break;
  }

  let sectionEnd = content.length;
  for (let i = toLineIndex + 1; i < lines.length; i += 1) {
    if (HEADING_RE.test(lines[i] ?? '')) {
      sectionEnd = starts[i]!;
      break;
    }
  }

  const sectionText = content.slice(sectionStart, sectionEnd).trim();
  const before = paragraphBefore(content, sectionStart);
  const after = paragraphAfter(content, sectionEnd);

  const parts = [before, sectionText, after].filter((p) => p.length > 0);
  let combined = parts.join('\n\n');

  if (wordCount(combined) > SEED_WORD_CAP) {
    // Drop the bridging paragraphs first; only fall back to truncating the section itself if
    // that alone still exceeds the cap (rare — sections up to ~15,000 words total per spec scope).
    combined = sectionText;
    if (wordCount(combined) > SEED_WORD_CAP) {
      combined = capWords(combined, SEED_WORD_CAP);
    }
  }

  return combined;
}

/** Generates a conversation name from the selection's first heading or leading words (FR-014). */
export function deriveBranchName(seedExcerpt: string, selectionText: string): string {
  const headingLine = seedExcerpt.split('\n').find((l) => HEADING_RE.test(l.trim()));
  if (headingLine) {
    return headingLine.trim().replace(/^#{1,6}\s+/, '').slice(0, 80);
  }
  const words = selectionText.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return words.length > 0 ? words.slice(0, 80) : 'Branch';
}
