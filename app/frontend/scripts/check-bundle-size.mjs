#!/usr/bin/env node
// Guards against mermaid (and its katex/cytoscape dependencies) silently creeping back into the
// eagerly-loaded entry chunk — e.g. a future change reintroducing a static top-level
// `import mermaid from 'mermaid'`. Run after `vite build`; asserts against dist/assets.
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const assetsDir = fileURLToPath(new URL('../dist/assets', import.meta.url));

// Generous ceiling for the entry chunk (currently ~935 KB) — catches gross regressions
// (e.g. mermaid's core getting statically bundled again) without being brittle against
// normal app growth.
const ENTRY_MAX_BYTES = 1_100_000;

// These ship as their own async chunks only when mermaid is dynamically imported. If mermaid's
// import ever becomes static again, these chunk names disappear (their code gets inlined
// elsewhere), so their presence is a reliable proxy for "mermaid is still lazy-loaded".
const REQUIRED_ASYNC_CHUNK_PATTERNS = [/^mermaid\.core-/, /^katex-/, /^cytoscape\.esm-/];

function sizeOf(filename) {
  return statSync(path.join(assetsDir, filename)).size;
}

const files = readdirSync(assetsDir);
const jsFiles = files.filter((f) => f.endsWith('.js'));

const entryFiles = jsFiles.filter((f) => /^index-.*\.js$/.test(f));
if (entryFiles.length !== 1) {
  console.error(
    `Expected exactly one entry chunk matching index-*.js, found: ${entryFiles.join(', ') || '(none)'}`,
  );
  process.exit(1);
}
const [entryFile] = entryFiles;
const entrySize = sizeOf(entryFile);
if (entrySize > ENTRY_MAX_BYTES) {
  console.error(
    `Entry chunk ${entryFile} is ${entrySize} bytes, exceeding the ${ENTRY_MAX_BYTES}-byte ceiling.\n` +
      `If this is expected app growth, raise ENTRY_MAX_BYTES. If not, check for a new static ` +
      `top-level import of a heavy dependency (mermaid, katex, cytoscape, ...).`,
  );
  process.exit(1);
}

const missing = REQUIRED_ASYNC_CHUNK_PATTERNS.filter(
  (pattern) => !jsFiles.some((f) => pattern.test(f)),
);
if (missing.length > 0) {
  console.error(
    `Expected async chunk(s) matching ${missing.map(String).join(', ')} were not found in dist/assets.\n` +
      `This likely means mermaid (or one of its katex/cytoscape dependencies) is no longer ` +
      `dynamically imported and has been inlined into the eager bundle instead.`,
  );
  process.exit(1);
}

console.log(
  `Bundle size check passed: entry chunk ${entryFile} is ${entrySize} bytes (limit ${ENTRY_MAX_BYTES}).`,
);
