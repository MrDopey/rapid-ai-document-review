import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../src/pi/system-prompt.js';

/**
 * 011-linear-thread-mode: `PiService.buildTools()` never registers `read_document`/
 * `propose_document_edit` for a Thread (`kind: 'thread-root' | 'thread-branch'`) — only
 * `web_search`/`web_fetch`. `buildSystemPrompt(isThread)` must therefore hand a Thread's model a
 * prompt with no dangling references to either unavailable tool, while leaving the canvas variant
 * (`isThread: false`) exactly as it always was (contracts/agent-tools.md §System prompt contract).
 */
describe('buildSystemPrompt', () => {
  it('canvas variant (isThread: false) still names read_document/propose_document_edit', () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain('AI reviewer embedded in a document review application');
    expect(prompt).toContain('`read_document`');
    // `propose_document_edit` itself is never named literally in the current canvas prose (it
    // speaks of "propose an edit"/"proposal"), but the anchor/proposal obligations built around it
    // must still be present.
    expect(prompt).toContain('Anchor discipline');
    expect(prompt).toContain('Proposal etiquette');
  });

  it('thread variant (isThread: true) never instructs the model to use read_document/propose_document_edit', () => {
    const prompt = buildSystemPrompt(true);
    // The shortened thread prompt doesn't name either tool at all any more (it used to disclaim
    // them explicitly) — either way, the obligations built around actually using them ("Anchor
    // discipline"/"Proposal etiquette") must be gone entirely.
    expect(prompt).not.toContain('read_document');
    expect(prompt).not.toContain('propose_document_edit');
    expect(prompt).not.toContain('Anchor discipline');
    expect(prompt).not.toContain('Proposal etiquette');
    expect(prompt).not.toMatch(/always read the relevant part/);
    expect(prompt).not.toMatch(/copied verbatim from the most recent/);
  });

  it('thread variant no longer describes the thread tool surface or branch-from-highlight context', () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain('threaded conversation');
    // The shortened prompt dropped its "Tool discipline"/"Branch context" obligations entirely —
    // it no longer names the available tools or describes how a branch's highlighted excerpt fits
    // in (that context is left implicit rather than spelled out in the prompt).
    expect(prompt).not.toContain('web_search');
    expect(prompt).not.toContain('web_fetch');
    expect(prompt).not.toContain('highlights a passage from an earlier');
  });

  it('thread variant frames the role as explaining concepts, not reviewing/editing', () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain('explain, not to review or edit');
    expect(prompt).toContain('Brevity');
    expect(prompt).toContain('Diagnose the gap');
    expect(prompt).toContain('4 ideas or fewer');
    // The canvas-only "AI reviewer" framing must not leak into the thread variant.
    expect(prompt).not.toContain('AI reviewer embedded in a document review application');
  });

  it('the two variants are genuinely different text', () => {
    expect(buildSystemPrompt(false)).not.toEqual(buildSystemPrompt(true));
  });
});
