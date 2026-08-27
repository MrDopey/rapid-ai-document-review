import MarkdownIt from 'markdown-it';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const md = new MarkdownIt({
  html: true, // pasted raw SVG passes through; the sanitizer (run after this) is the real gate
  linkify: true,
  breaks: false,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defaultFenceRenderer: any =
  md.renderer.rules.fence ?? ((tokens: any, idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const lang = token.info.trim().toLowerCase();
  if (lang === 'mermaid') {
    // Post-processed asynchronously by the Preview component via renderMermaidBlock(),
    // since markdown-it rendering is synchronous and mermaid.render() is not.
    return `<pre class="mermaid-pending">${escapeHtml(token.content)}</pre>`;
  }
  return defaultFenceRenderer(tokens, idx, options, env, self);
};

/** markdown-it → dirty HTML. Callers MUST sanitize the result before inserting into the DOM. */
export function render(markdown: string): string {
  return md.render(markdown);
}
