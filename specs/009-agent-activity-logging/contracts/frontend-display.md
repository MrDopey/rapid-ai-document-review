# Contract: Frontend Display Behavior

Applies to `app/frontend/src/components/conversation/MessageBubble.vue` and
`app/frontend/src/stores/settings.ts`.

## `thinkingVisible` — narrowed scope, same store/API

No change to `settings.ts`'s `DEFAULTS.thinkingVisible`, the `GET/PATCH /api/settings` contract, or
the `settings_changed` event. What changes is only what this flag is allowed to gate:

- **Still gated by `thinkingVisible`**: the message's `reasoning` text, and the existing
  `isToolCallCarrier`-only-bubble visibility (an assistant message segment that carries *only* a
  tool call, no text/reasoning — `MessageBubble.vue:82`).
- **No longer applicable / not gated by anything new**: tool-call detail itself (name, args,
  result/failure) is not conditioned on `thinkingVisible` at all (Research Decision 5) — it renders
  whenever `message.toolCalls` is non-empty, independent of the toggle.

## New tool-call display block

For each entry in `message.toolCalls` (now populated per the HTTP contract), render:
- Tool name (e.g. `web_search`, `web_fetch`, `read_document`, `propose_document_edit`).
- Its `args` (e.g. the search query or fetch URL) as plain text.
- Either `resultText` (bounded/possibly-truncated) or, when `isError`, `failureReason` — never
  both.

**Constitution Principle VI (Sanitize Before Render)**: `resultText`/`args` may contain arbitrary
text sourced from an external web page (`web_fetch`) or search snippet (`web_search`) — untrusted
content by the same standard as any other LLM-adjacent content. This block MUST route through the
same sanitization abstraction already used for rendering message `text`/Markdown content, not a new
unsanitized `v-html`/raw-text path. If the existing sanitizer only targets full Markdown documents,
the tool-call block MUST render this content as plain escaped text (Vue's default text
interpolation, which is HTML-escaped by default) rather than through any raw-HTML binding — the
gate is "no unsanitized HTML," not "must support Markdown here."

## Content formatting is a display-only concern

`args`/`resultText` are stored exactly as captured — raw serialized values, not pretty-printed
(Data Model: `args` is `unknown`, `resultText` a plain bounded string) — so re-formatting is purely
a rendering choice, not something the backend or event log is responsible for:
- When `args` is an object (e.g. `{ query: "..." }`), the display block MUST pretty-print it (e.g.
  `JSON.stringify(args, null, 2)`) inside a `<pre>`/monospace block at render time. The stored event
  data itself remains compact/unformatted — pretty-printing MUST NOT happen before persistence.
- `resultText` (already plain text, e.g. rendered search results or fetched page text) is shown
  as-is in a monospace/`<pre>`-style block for legibility, still subject to the sanitization rule
  above (escaped text, not raw HTML).
- If a future tool's `result` is structured (JSON) rather than pre-rendered text, the same
  render-time `JSON.stringify(..., null, 2)` treatment applies — no new stored field or backend
  formatting step is introduced for this.

## Color coding

Tool-call blocks get their own dedicated token pair, following this codebase's existing
one-token-pair-per-semantic-category convention (`ConversationStatusBadges.vue`,
`style.css`'s `--<name>-color`/`--<name>-bg`): reuse `--info-color`/`--info-bg`/`--info-border`
(`style.css` lines 45-47 light / 163-165 dark) — already defined but currently unused by any
component, and semantically the right fit ("informational, read-only agent activity"), distinct
from `--status-active-color`/`--status-active-bg` (already scoped to conversation working/pending
state) and from `--queue-color` (already scoped to the run queue). A failed tool call within the
same block reuses the existing `--danger-color`/`--danger-bg` pair (already used for
errored/closed), rather than inventing a second new token, so "this tool call failed" reads
consistently with every other error state in the app.

## Retroactive visibility (FR-006 / SC-002)

Since gating moves entirely to render time and the underlying data is now always present, toggling
`thinkingVisible` on for an already-open, already-loaded conversation must reveal reasoning for
every past message in that conversation immediately — this requires no re-fetch if `MessageDto`s
already include `reasoning`/`toolCalls` (which they now unconditionally do per the HTTP contract);
a simple reactive re-render keyed on the settings store's `thinkingVisible` value is sufficient,
consistent with the toggle's current implementation approach.
