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
 * Start offset of the paragraph (blank-line-delimited block) containing `offset` — the nearest
 * `\n\s*\n` boundary at or before `offset`, or 0 if none. Used as the local fallback bound when no
 * enclosing heading exists on a side, so headless (or edge-of-document) prose doesn't expand all
 * the way to the document's edge.
 */
function paragraphBlockStart(content: string, offset: number): number {
  const prefix = content.slice(0, offset);
  const seps = [...prefix.matchAll(/\n\s*\n/g)];
  const last = seps.at(-1);
  return last ? last.index! + last[0].length : 0;
}

/** Symmetric to `paragraphBlockStart`: end offset of the paragraph containing `offset`. */
function paragraphBlockEnd(content: string, offset: number): number {
  const suffix = content.slice(offset);
  const m = /\n\s*\n/.exec(suffix);
  return m ? offset + m.index! : content.length;
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
  let headingBefore = false;
  for (let i = fromLineIndex; i >= 0; i -= 1) {
    if (HEADING_RE.test(lines[i] ?? '')) {
      sectionStart = starts[i]!;
      headingBefore = true;
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
  let headingAfter = false;
  for (let i = toLineIndex + 1; i < lines.length; i += 1) {
    if (HEADING_RE.test(lines[i] ?? '')) {
      sectionEnd = starts[i]!;
      headingAfter = true;
      break;
    }
  }

  // No enclosing heading on one (or both) sides — e.g. headless prose, or a selection in the
  // document's first/last section — so don't fall through to the document edge. Bound that side
  // to the local paragraph containing the selection instead; the bridging paragraphBefore/After
  // below still adds one paragraph of context beyond it, matching the within-section behavior.
  if (!headingBefore) {
    sectionStart = paragraphBlockStart(content, from);
  }
  if (!headingAfter) {
    sectionEnd = paragraphBlockEnd(content, to);
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

/**
 * Wraps literal document content (a full document, or an excerpt/selection of one) in an
 * XML-style `<document-revision-N>...</document-revision-N>` tag naming the revision it came
 * from, so the model can clearly delimit document content from the surrounding instructional
 * prose in a seed/context message (project convention — see constitution). The opening and
 * closing tags always name the same revision.
 */
export function wrapDocumentRevision(revision: number, content: string): string {
  const tag = `document-revision-${revision}`;
  // Blank line (not just a single '\n') on both sides of `content`: this string is rendered
  // through a markdown renderer downstream, which collapses a single newline inside a paragraph
  // into a plain space — without a full blank line here, the closing tag would visually run onto
  // the same line as the content's last line instead of starting its own.
  return [`<${tag}>`, '', content, '', `</${tag}>`].join('\n');
}

/**
 * Wraps the highlighted selection text in its own matching-tag pair, `<highlighted-selection>` —
 * distinct from `wrapDocumentRevision`'s `<document-revision-N>` tag used for the full document —
 * so the model can't confuse "the whole document" with "the specific passage the user selected",
 * even though both are literal document content per the constitution's tagging convention.
 */
export function wrapHighlightedSelection(content: string): string {
  const tag = 'highlighted-selection';
  // Same blank-line-on-both-sides reasoning as `wrapDocumentRevision` above.
  return [`<${tag}>`, '', content, '', `</${tag}>`].join('\n');
}

/**
 * Shared underlying builder for both `buildMainSeedMessage` and `buildBranchSeedMessage`: always
 * leads with the caller-supplied lead-in line followed by the full document content wrapped in its
 * `<document-revision-N>` tag pair (`wrapDocumentRevision`, constitution's tagging convention).
 * When `selectionText` is given (branch-only — Main has no selection to reference), it's appended
 * in its own distinctly-named `<highlighted-selection>` tag pair (`wrapHighlightedSelection`), so
 * the model can't mistake the highlighted passage for the document as a whole, followed by closing
 * prose priming the agent that the *next* user message will concern that passage specifically —
 * there is no edit instruction yet at seed time, only that context-setting for the turn to come.
 * Main has no such closing prose: with no selection, there is nothing turn-specific to prime.
 */
function buildSeedMessage(
  leadIn: string,
  revision: number,
  documentContent: string,
  selectionText?: string,
): string {
  const lines = [leadIn, '', wrapDocumentRevision(revision, documentContent)];

  if (selectionText !== undefined) {
    lines.push('', ...buildSelectionBlock(selectionText));
  }

  return lines.join('\n');
}

/**
 * Shared block naming the highlighted passage and priming the agent that the *next* user message
 * will concern it specifically — factored out of `buildSeedMessage` so `buildSelectionOnlySeedMessage`
 * below (Branch (Main): selection only, no document) can reuse the exact same wording/tagging
 * convention without a document section in front of it.
 */
function buildSelectionBlock(selectionText: string): string[] {
  return [
    'The user highlighted the following passage to start this conversation:',
    '',
    wrapHighlightedSelection(selectionText),
    '',
    "The next message you receive will be the user's request — an edit, or a clarification or " +
      'discussion — about that highlighted passage specifically, not the document as a whole. ' +
      'Wait for that message before proposing or making any changes.',
  ];
}

/**
 * Seeds a newly created Main conversation with the document under review (feature: "inject the
 * document as the first message"), via the shared `buildSeedMessage` builder above — same
 * document-embedding/tagging convention a branch's seed message uses, just without a selection.
 * Unlike a branch excerpt, this is never capped/trimmed — Main's seed is meant to give the agent
 * the whole document up front, the same content `read_document` (document-tools.ts) would
 * otherwise serve on demand.
 *
 * The lead-in's second sentence primes the agent for the turns to come — Main has no
 * selection-specific closing prose the way `buildSelectionBlock` gives a branch, so this is the
 * only place to set that expectation: the user's messages here will ask it to revise or edit the
 * document (via `propose_document_edit`) as well as to clarify or discuss it, not just to
 * passively acknowledge receipt of the content above.
 */
export function buildMainSeedMessage(title: string, revision: number, content: string): string {
  return buildSeedMessage(
    `Here is the document under review, "${title}" (revision ${revision}):\n\n` +
      "Expect the user's messages in this conversation to ask you to revise or edit the document — " +
      'propose changes with `propose_document_edit` — as well as to ask clarifying questions or ' +
      'discuss it; both are ordinary, expected parts of this conversation.',
    revision,
    content,
  );
}

/**
 * Seeds a newly-branched conversation (FR-011/FR-012) with the *full* document content — via the
 * shared `buildSeedMessage` builder above, so the branch's agent has the same whole-document
 * context a Main conversation gets — plus the highlighted selection the user branched from.
 */
export function buildBranchSeedMessage(
  revision: number,
  documentContent: string,
  selectionText: string,
): string {
  return buildSeedMessage(
    `Here is the full document under review (revision ${revision}), for context:`,
    revision,
    documentContent,
    selectionText,
  );
}

/**
 * Seeds a "Branch (Main)" branch (selection-anchored, `includeSeedMessage: true`) with *only* the
 * highlighted selection — no full document. Unlike "Branch (New)" (`buildBranchSeedMessage`
 * above), this path also populates `forkedFromMessageId`, so the continuity snippet
 * (`ConversationThreadBox.vue`) already gives the agent's session the parent conversation's prior
 * context; re-sending the whole document here would just be redundant with that.
 */
export function buildSelectionOnlySeedMessage(selectionText: string): string {
  return buildSelectionBlock(selectionText).join('\n');
}

/** Generates a conversation name from the selection's first heading or leading words (FR-014). */
export function deriveBranchName(seedExcerpt: string, selectionText: string): string {
  const headingLine = seedExcerpt.split('\n').find((l) => HEADING_RE.test(l.trim()));
  if (headingLine) {
    return headingLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .slice(0, 80);
  }
  const words = selectionText.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return words.length > 0 ? words.slice(0, 80) : 'Branch';
}
