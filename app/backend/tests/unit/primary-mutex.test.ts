import { describe, expect, it } from 'vitest';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FIX 4: `PrimaryMutex` has generalized from a lock used only by `propose_document_edit`/Primary
 * designation switches into the single per-document write lock every document-mutating path now
 * serializes against (manual edits, `EditService.apply()`, `acceptRemaining`, the propose-tool
 * path). Two things must hold for that to work:
 *  1. Two overlapping `withLock` calls for the SAME document from genuinely separate call chains
 *     still serialize (unchanged behavior).
 *  2. A call chain that already holds a document's lock can call `withLock` again for that same
 *     document (e.g. `EditService.apply()`'s own lock, invoked from inside
 *     `propose_document_edit`'s already-held lock) without deadlocking against itself.
 */
describe('PrimaryMutex (FIX 4: generalized per-document write lock)', () => {
  it('serializes two overlapping withLock calls for the same document: the second never starts before the first finishes', async () => {
    const mutex = new PrimaryMutex();
    const order: string[] = [];

    const first = mutex.withLock('doc-1', async () => {
      order.push('first:start');
      await sleep(30);
      order.push('first:end');
    });
    // Give `first` a chance to actually acquire the lock and start running before `second` is
    // even submitted, so this is unambiguously "second call arrives while first is in flight".
    await sleep(5);

    const second = mutex.withLock('doc-1', async () => {
      order.push('second:start');
      await sleep(5);
      order.push('second:end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not serialize withLock calls for DIFFERENT documents', async () => {
    const mutex = new PrimaryMutex();
    const order: string[] = [];

    const a = mutex.withLock('doc-a', async () => {
      order.push('a:start');
      await sleep(30);
      order.push('a:end');
    });
    await sleep(5);
    const b = mutex.withLock('doc-b', async () => {
      order.push('b:start');
      await sleep(5);
      order.push('b:end');
    });

    await Promise.all([a, b]);
    // `b` runs to completion well before `a` finishes — proof they were never serialized against
    // each other.
    expect(order.indexOf('b:end')).toBeLessThan(order.indexOf('a:end'));
  });

  it('is reentrant per document within one async call chain: a nested withLock for the same document runs inline instead of deadlocking', async () => {
    const mutex = new PrimaryMutex();
    const order: string[] = [];

    const result = await mutex.withLock('doc-1', async () => {
      order.push('outer:start');
      // This mirrors `EditService.apply()`'s own `withLock` call firing from inside
      // `propose_document_edit`'s already-held lock (document-tools.ts) — without reentrancy,
      // this would hang forever waiting to acquire a lock this same chain already holds.
      const inner = await mutex.withLock('doc-1', async () => {
        order.push('inner:start');
        return 'inner-result';
      });
      order.push('outer:end');
      return inner;
    });

    expect(result).toBe('inner-result');
    expect(order).toEqual(['outer:start', 'inner:start', 'outer:end']);
  });

  it('reentrancy is scoped to the actual documentId: a nested call for a DIFFERENT document still queues behind another chain holding that document', async () => {
    const mutex = new PrimaryMutex();
    const order: string[] = [];

    // A separate, independent call chain holds doc-b's lock for a while.
    const holder = mutex.withLock('doc-b', async () => {
      order.push('holder:start');
      await sleep(30);
      order.push('holder:end');
    });
    await sleep(5);

    // This chain holds doc-a's lock, then reaches for doc-b's — a genuinely different document,
    // so it must queue behind `holder` rather than being treated as already-held.
    const chained = mutex.withLock('doc-a', async () => {
      order.push('doc-a:start');
      await mutex.withLock('doc-b', async () => {
        order.push('doc-b:start');
      });
      order.push('doc-a:end');
    });

    await Promise.all([holder, chained]);
    expect(order.indexOf('holder:end')).toBeLessThan(order.indexOf('doc-b:start'));
  });

  it('releases the lock even when fn throws, so a subsequent call is never permanently blocked', async () => {
    const mutex = new PrimaryMutex();

    await expect(
      mutex.withLock('doc-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A following call for the same document must still be able to acquire the lock.
    const result = await mutex.withLock('doc-1', () => 'ok');
    expect(result).toBe('ok');
  });
});
