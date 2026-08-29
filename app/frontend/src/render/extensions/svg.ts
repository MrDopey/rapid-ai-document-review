import { domPurifySanitizer } from '../sanitizer.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Pass-through for inline `<svg>` blocks pasted directly into the document. Always sanitized
 * (FR-008); a fragment that isn't parseable as SVG falls back to a visible notice plus raw
 * source, matching the Mermaid failure UX (FR-008c) rather than silently dropping the region.
 */
export function sanitizeInlineSvg(source: string): string {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const parserError = parsed.querySelector('parsererror');
  if (parserError) {
    return (
      `<div class="svg-fallback" role="note">` +
      `<p class="svg-fallback-notice">Vector graphic could not be rendered: invalid SVG.</p>` +
      `<pre><code>${escapeHtml(source)}</code></pre>` +
      `</div>`
    );
  }
  return domPurifySanitizer.sanitize(source);
}
