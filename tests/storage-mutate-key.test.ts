// Pin the per-key serialization contract of `mutateKey`. The bug we're
// guarding: pre-fix, concurrent load-modify-save against the same
// chrome.storage key could lose writes (read A, read B, mutate A,
// mutate B, set A, set B — A's mutation discarded by B's overwrite).
// `mutateKey` runs every mutator for a given key strictly in arrival
// order, dropping the race window entirely.

import { describe, it, expect, beforeEach } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';
import { mutateKey } from '../src/core/storage';

beforeEach(() => { installChromeStub(); });

describe('mutateKey', () => {
  it('runs a single mutator end-to-end', async () => {
    await mutateKey<number>('x', () => 1);
    await mutateKey<number>('x', (cur) => (cur ?? 0) + 10);
    const got = await new Promise<number>((r) => {
      chrome.storage.local.get('x', (out) => r(out.x as number));
    });
    expect(got).toBe(11);
  });

  it('serialises concurrent mutators against the same key — no lost writes', async () => {
    // 50 concurrent +1 increments. Without serialization, each one
    // reads the same starting 0, sets 1, and the final value is 1.
    // With serialization, every mutator sees the result of the
    // previous one and the final value is 50.
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      ps.push(mutateKey<number>('counter', (cur) => (cur ?? 0) + 1));
    }
    await Promise.all(ps);
    const got = await new Promise<number>((r) => {
      chrome.storage.local.get('counter', (out) => r(out.counter as number));
    });
    expect(got).toBe(50);
  });

  it('different keys run in parallel — no cross-key blocking', async () => {
    // Two slow mutators on different keys should complete in roughly
    // the time of one (parallel), not two (serial).
    const start = Date.now();
    await Promise.all([
      mutateKey<number>('a', async (cur) => {
        await new Promise((r) => setTimeout(r, 50));
        return (cur ?? 0) + 1;
      }),
      mutateKey<number>('b', async (cur) => {
        await new Promise((r) => setTimeout(r, 50));
        return (cur ?? 0) + 1;
      }),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120);  // < 2× single-call duration
  });

  it('failure in one mutator does not block subsequent ones on the same key', async () => {
    // The lock chains through `.catch(() => undefined)` so a thrown
    // mutator releases the lock for the next caller. Verify the
    // failure propagates to the originating caller (not silently
    // swallowed) while the next mutator still runs.
    const a = mutateKey<number>('z', () => { throw new Error('boom'); });
    const b = mutateKey<number>('z', () => 42);
    await expect(a).rejects.toThrow(/boom/);
    await b;
    const got = await new Promise<number>((r) => {
      chrome.storage.local.get('z', (out) => r(out.z as number));
    });
    expect(got).toBe(42);
  });
});
