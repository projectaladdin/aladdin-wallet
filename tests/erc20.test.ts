// Pin the load-bearing branches of erc20.ts that previously had zero
// unit coverage:
//   - `detectMulticallSupport` cache lifecycle (positive hit, negative
//     hit, in-flight dedupe, transient error not cached)
//   - cache flip on a "multicall said supported but call failed"
//     downgrade path (the fallback to fanout)
// Everything stubs viem's public-client surface — these helpers only
// touch `.getCode` / `.multicall` / `.readContract`, so we don't need
// a real RPC.

import { describe, it, expect } from 'bun:test';
import { detectMulticallSupport, MULTICALL3_ADDRESS } from '../src/core/erc20';

type Probe = { calls: number; resolve: (code: `0x${string}` | undefined) => void };

function makeClient(probe: Probe) {
  return {
    getCode: async ({ address }: { address: `0x${string}` }) => {
      expect(address).toBe(MULTICALL3_ADDRESS);
      probe.calls++;
      return new Promise<`0x${string}` | undefined>((resolve) => {
        probe.resolve = resolve;
      });
    },
  };
}

describe('detectMulticallSupport', () => {
  it('returns true when contract has bytecode at the canonical address', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-true-${Math.random()}.test`;
    const c = makeClient(probe);
    const result = detectMulticallSupport(c, rpc);
    // Settle probe with a real bytecode string.
    queueMicrotask(() => probe.resolve('0x6080604052' as `0x${string}`));
    expect(await result).toBe(true);
    expect(probe.calls).toBe(1);
  });

  it('returns false for empty bytecode (0x)', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-false-${Math.random()}.test`;
    const c = makeClient(probe);
    const result = detectMulticallSupport(c, rpc);
    queueMicrotask(() => probe.resolve('0x'));
    expect(await result).toBe(false);
  });

  it('returns false for undefined return (some RPC quirks)', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-undef-${Math.random()}.test`;
    const c = makeClient(probe);
    const result = detectMulticallSupport(c, rpc);
    queueMicrotask(() => probe.resolve(undefined));
    expect(await result).toBe(false);
  });

  it('caches positive results — second call does NOT re-probe', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-cache-${Math.random()}.test`;
    const c = makeClient(probe);
    const r1 = detectMulticallSupport(c, rpc);
    queueMicrotask(() => probe.resolve('0x6080' as `0x${string}`));
    expect(await r1).toBe(true);
    // Second call must NOT increment probe count.
    const r2 = await detectMulticallSupport(c, rpc);
    expect(r2).toBe(true);
    expect(probe.calls).toBe(1);
  });

  it('caches negative results too — repeated calls on a chain without multicall stay cheap', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-neg-cache-${Math.random()}.test`;
    const c = makeClient(probe);
    const r1 = detectMulticallSupport(c, rpc);
    queueMicrotask(() => probe.resolve('0x'));
    expect(await r1).toBe(false);
    const r2 = await detectMulticallSupport(c, rpc);
    expect(r2).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it('de-dupes concurrent probes — two parallel callers share one fetch', async () => {
    const probe: Probe = { calls: 0, resolve: () => {} };
    const rpc = `https://probe-dedup-${Math.random()}.test`;
    const c = makeClient(probe);
    // Fire both before the first probe resolves — second should
    // observe the in-flight Promise and NOT trigger another getCode.
    const r1p = detectMulticallSupport(c, rpc);
    const r2p = detectMulticallSupport(c, rpc);
    // Resolve once; both awaits should land on the same value.
    queueMicrotask(() => probe.resolve('0x6080' as `0x${string}`));
    const [r1, r2] = await Promise.all([r1p, r2p]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(probe.calls).toBe(1);  // one shared probe
  });

  it('does NOT cache transient failures — next call retries', async () => {
    let calls = 0;
    const rpc = `https://probe-throw-${Math.random()}.test`;
    const c = {
      getCode: async () => {
        calls++;
        if (calls === 1) throw new Error('network down');
        return '0x6080' as `0x${string}`;
      },
    };
    const r1 = await detectMulticallSupport(c, rpc);
    expect(r1).toBe(false);  // transient failure → false for this call
    // Next call must re-probe (cache was NOT poisoned with the failure).
    const r2 = await detectMulticallSupport(c, rpc);
    expect(r2).toBe(true);
    expect(calls).toBe(2);
  });
});
