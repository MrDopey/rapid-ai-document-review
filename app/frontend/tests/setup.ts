// Node 26+ ships its own experimental global `localStorage` accessor (file-backed, requiring
// `--localstorage-file`) that evaluates to `undefined` without that flag — and in vitest's jsdom
// environment `window` *is* `globalThis`, so `window.localStorage` is the exact same broken
// accessor, not jsdom's own storage implementation. Any component under test that reads/writes
// the bare global (the existing `panePersistence.ts` convention, and this feature's
// `messageDisplayState.ts`) would otherwise see `undefined` instead of a working `Storage`. A
// small in-memory polyfill, installed once per test file, is simplest — real persistence across a
// page reload is never something a unit test needs anyway.
class MemoryStorage implements Storage {
  #data = new Map<string, string>();
  get length(): number {
    return this.#data.size;
  }
  clear(): void {
    this.#data.clear();
  }
  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.#data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
}

if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}
