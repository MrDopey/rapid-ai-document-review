import MarkdownIt from 'markdown-it';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeMarkdownIt(html: boolean): MarkdownIt {
  const instance = new MarkdownIt({
    html, // pasted raw SVG passes through when true; the sanitizer (run after this) is the real gate
    linkify: true,
    breaks: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defaultFenceRenderer: any = instance.renderer.rules.fence ?? ((tokens: any, idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));

  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const lang = token.info.trim().toLowerCase();
    if (lang === 'mermaid') {
      // Post-processed asynchronously by the Preview component via renderMermaidBlock(),
      // since markdown-it rendering is synchronous and mermaid.render() is not.
      return `<pre class="mermaid-pending">${escapeHtml(token.content)}</pre>`;
    }
    return defaultFenceRenderer(tokens, idx, options, env, self);
  };

  return instance;
}

// Two configs: the document preview needs raw HTML/SVG passthrough; conversation messages don't
// author HTML and must show any literal `<tag>` (e.g. a seed message's `<document-revision-N>`)
// as visible text rather than have it silently swallowed by the sanitizer as an unknown element.
const mdHtml = makeMarkdownIt(true);
const mdNoHtml = makeMarkdownIt(false);

/** markdown-it → dirty HTML. Callers MUST sanitize the result before inserting into the DOM. */
export function render(markdown: string, opts: { html?: boolean } = {}): string {
  const instance = opts.html === false ? mdNoHtml : mdHtml;
  return instance.render(markdown);
}
