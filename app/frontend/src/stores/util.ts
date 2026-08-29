/**
 * Get-or-create an array at `key` in `record`, creating and storing an empty one on first
 * access. Shared by stores/conversations.ts (`messagesByConversation`) and stores/edits.ts
 * (`byConversation`), which both keep per-conversation arrays keyed by conversation id.
 */
export function ensureArray<T>(record: Record<string, T[]>, key: string): T[] {
  const existing = record[key];
  if (existing) return existing;
  const created: T[] = [];
  record[key] = created;
  return created;
}
