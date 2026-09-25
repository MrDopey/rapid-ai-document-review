import { createHash } from 'node:crypto';

/**
 * Stale-write detector for `list_item.text` (research.md R2) — deliberately not a security
 * control, just a short, opaque, deterministic fingerprint of the current text so a caller can
 * assert "nothing changed since I last looked" without shipping the full previous text back.
 */
export function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 10);
}
