import DOMPurify from 'dompurify';

/**
 * The single sanitization gate (Constitution Principle VI). Runs last in every render path —
 * Markdown, Mermaid-generated SVG, raw inline SVG, and streamed agent reasoning all pass through
 * here before touching the DOM (FR-008, FR-008a).
 */
export interface SanitizerPort {
  sanitize(html: string): string;
}

const ALLOWED_TAGS = [
  // Markdown structural elements
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'strong', 'em', 'del', 'span', 'div',
  // Inline / Mermaid-rendered SVG
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'marker', 'title', 'desc', 'foreignObject', 'style',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id',
  // SVG presentation/geometry attributes
  'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'fill', 'stroke', 'stroke-width', 'transform', 'font-size', 'font-family',
  'text-anchor', 'marker-end', 'marker-start', 'opacity',
];

export const domPurifySanitizer: SanitizerPort = {
  sanitize(html: string): string {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    });
  },
};
