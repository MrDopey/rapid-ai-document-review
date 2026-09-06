import { domPurifySanitizer } from '../sanitizer.js';

// Mermaid pulls in katex and cytoscape (~200KB gzip combined), so it's dynamically imported
// here rather than at module scope — that keeps those out of the main bundle for documents
// that never render a mermaid fence.
let mermaidPromise: ReturnType<typeof loadMermaid> | undefined;

async function loadMermaid() {
  const { default: mermaid } = await import('mermaid');
  // htmlLabels: false makes Mermaid emit plain SVG <text> labels instead of
  // <foreignObject><div>…</div></foreignObject> — DOMPurify's mXSS hardening strips HTML
  // elements nested inside foreignObject regardless of the allowlist, which silently blanked
  // every diagram label. Plain SVG text sidesteps that without weakening the sanitizer.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
  return mermaid;
}

function ensureInitialized() {
  if (!mermaidPromise) {
    // If the dynamic import itself fails (e.g. a transient chunk-load network error), don't
    // cache the rejection — let the next call retry loading mermaid from scratch.
    mermaidPromise = loadMermaid().catch((err: unknown) => {
      mermaidPromise = undefined;
      throw err;
    });
  }
  return mermaidPromise;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackBlock(source: string, reason: string): string {
  return (
    `<div class="mermaid-fallback" role="note">` +
    `<p class="mermaid-fallback-notice">Diagram could not be rendered: ${escapeHtml(reason)}</p>` +
    `<pre><code>${escapeHtml(source)}</code></pre>` +
    `</div>`
  );
}

let counter = 0;

/**
 * Renders one Mermaid code-fence source string to sanitized SVG. On any failure — malformed
 * diagram, non-completing render, or an exceeding complexity ceiling — replaces only this region
 * with a visible notice plus the raw source, never blanking it or interrupting the rest of the
 * document (FR-008c).
 */
export async function renderMermaidBlock(source: string): Promise<string> {
  counter += 1;
  const id = `mermaid-${Date.now()}-${counter}`;
  try {
    const mermaid = await ensureInitialized();
    const renderPromise = mermaid.render(id, source);
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('render timed out')), 5000),
    );
    const { svg } = await Promise.race([renderPromise, timeout]);
    return domPurifySanitizer.sanitize(svg);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return fallbackBlock(source, message);
  }
}
