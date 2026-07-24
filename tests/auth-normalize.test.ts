// EIP-7702 authorizationList normaliser tests.
//
// These map to a real production failure: a dapp called wallet_signAuthorization,
// our wallet returned a valid SignedAuthorization, the dapp passed it back via
// eth_sendTransaction, and the type-4 tx mined on Sepolia — but the on-chain
// EOA code didn't change. The cause was viem's `toHex(chainId)` /
// `toHex(nonce)` going through `stringToHex` (UTF-8 byte encoding of the
// literal hex chars "0xaa36a7" / "0x4") instead of `numberToHex`, because the
// dapp-side formatter had hex-stringified the numeric fields for the
// EIP-1193 wire. Result: garbage chainId / nonce in the RLP auth, ecrecover
// returns a junk authority, auth silently skipped, no delegation.
//
// Two test layers:
//   1. Unit:        normalizeAuthorizationList shape conversions in isolation.
//   2. Roundtrip:   simulate the dapp-side wire formatting → our normalize →
//                   viem's serializeAuthorizationList → assert the RLP
//                   chainId/nonce match what was actually signed. This is
//                   the exact failure mode the bug produced — a regression
//                   here means the on-chain tx will silently lose its auth.

import { describe, expect, test } from 'bun:test';
import { numberToHex } from 'viem';
import { signAuthorization } from 'viem/accounts';
import { recoverAuthorizationAddress, serializeAuthorizationList } from 'viem/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeAuthorizationList } from '../src/lib/auth-normalize';

// Anvil test private key 0 — same vector used by tests/crypto.test.ts.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDR = privateKeyToAccount(TEST_PK).address;
const DELEGATE = '0x9c2d9007ebb6E7816203528EF3bdE9d8f8DFE9D0' as const;
const SEPOLIA_CHAIN = 11155111;
const SEPOLIA_HEX = '0xaa36a7';

// ─── Unit ─────────────────────────────────────────────────────────────────

describe('normalizeAuthorizationList — shape conversion', () => {
  test('hex-string chainId / nonce / yParity → number', () => {
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: SEPOLIA_HEX,
      nonce: '0x4',
      r: '0x313222ce48c59d39d38b036ccc6929d5b8c90dbcb1f4e9c453f48841333b1d73',
      s: '0x7d93aebc0dc7da228ff91f2f6d5a9c33d7f73b5489ba34f9a81f105174d82bab',
      yParity: '0x1',
    }]);
    expect(out[0]).toEqual({
      address: DELEGATE,
      chainId: SEPOLIA_CHAIN,
      nonce: 4,
      r: '0x313222ce48c59d39d38b036ccc6929d5b8c90dbcb1f4e9c453f48841333b1d73',
      s: '0x7d93aebc0dc7da228ff91f2f6d5a9c33d7f73b5489ba34f9a81f105174d82bab',
      yParity: 1,
    });
  });

  test('idempotent — already-typed input passes through unchanged', () => {
    const typed = [{
      address: DELEGATE,
      chainId: SEPOLIA_CHAIN,
      nonce: 4,
      r: '0xaa',
      s: '0xbb',
      yParity: 0,
    }];
    expect(normalizeAuthorizationList(typed)).toEqual(typed as never);
  });

  test('bigint inputs (some viem paths return bigint) → number', () => {
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: BigInt(SEPOLIA_CHAIN),
      nonce: 4n,
      r: '0xaa',
      s: '0xbb',
      yParity: 0n,
    }]);
    expect(out[0]?.chainId).toBe(SEPOLIA_CHAIN);
    expect(out[0]?.nonce).toBe(4);
    expect(out[0]?.yParity).toBe(0);
  });

  test('chainId = "0x0" (cross-chain wildcard, per EIP-7702) → 0', () => {
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x0',
      nonce: '0x1',
      r: '0xaa',
      s: '0xbb',
      yParity: '0x0',
    }]);
    expect(out[0]?.chainId).toBe(0);
    expect(out[0]?.yParity).toBe(0);
  });

  test('nonce as decimal string "0" (not "0x0") still parses to 0', () => {
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0',
      r: '0xaa',
      s: '0xbb',
      yParity: '0',
    }]);
    expect(out[0]?.nonce).toBe(0);
    expect(out[0]?.yParity).toBe(0);
  });

  test('throws on nonce > Number.MAX_SAFE_INTEGER (precision-loss guard)', () => {
    // The bug we're fixing: a malicious dapp could send a nonce
    // greater than 2^53. The OLD `toNumber` did `Number(BigInt(v))`
    // and silently truncated; viem would sign for nonce=X but
    // ecrecover would yield a junk authority. Now we throw so the
    // SW returns a clean JSON-RPC error instead.
    const huge = (1n << 60n) + 7n;
    expect(() => normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: `0x${huge.toString(16)}`,
      r: '0xaa',
      s: '0xbb',
      yParity: '0x0',
    }])).toThrow(/exceeds Number\.MAX_SAFE_INTEGER/);
  });

  test('throws on negative chainId / nonce', () => {
    expect(() => normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: -1,
      nonce: '0x0',
      r: '0xaa',
      s: '0xbb',
      yParity: '0x0',
    }])).toThrow(/negative/);
  });

  test('yParity bigger than 1 throws (single-bit per spec, NO silent clamp)', () => {
    // Pre-fix the wallet silently clamped invalid yParity values to 0.
    // A buggy dapp shipping v=27 (forgotten EIP-155 down-conversion)
    // would get its 27 → 0 → broken-but-looks-valid auth. We throw
    // instead so the bug surfaces at the JSON-RPC boundary.
    expect(() => normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0x0',
      r: '0xaa',
      s: '0xbb',
      yParity: '0x2',
    }])).toThrow(/must be 0 or 1/);
  });

  test('yParity = 27 (geth legacy v) throws with downconvert hint', () => {
    expect(() => normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0x0',
      r: '0xaa',
      s: '0xbb',
      yParity: 27,
    }])).toThrow(/v - 27/);
  });

  test('yParity = boolean throws instead of falling through to 0', () => {
    // Pre-fix the type-narrow chain fell through to 0n for unhandled
    // types (boolean, object, …). A dapp accidentally shipping `true`
    // would get yParity=0 silently, ecrecover diverges from the
    // expected authority, and the auth no-ops on chain.
    expect(() => normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0x0',
      r: '0xaa',
      s: '0xbb',
      yParity: true as unknown as number,
    }])).toThrow(/not a valid integer/);
  });

  test('missing r / s pass through as undefined-cast Hex (caller responsibility)', () => {
    // Normalize doesn't synthesize signature components — it only coerces
    // numeric fields. If r or s aren't supplied (malformed wire input),
    // they propagate through; viem's downstream serializer will emit RLP
    // for missing fields as 0x00 and the recovered authority will be
    // wrong (auth gets silently skipped on chain). Test locks in the
    // pass-through so future refactors don't accidentally start
    // rejecting / synthesising.
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0x0',
      yParity: '0x1',
      // r and s deliberately omitted
    }]);
    expect(out[0]?.r).toBeUndefined();
    expect(out[0]?.s).toBeUndefined();
    expect(out[0]?.address).toBe(DELEGATE);
  });

  test('missing yParity / falsy fields default to 0n', () => {
    const out = normalizeAuthorizationList([{
      address: DELEGATE,
      chainId: '0x1',
      nonce: '0x0',
      r: '0xaa',
      s: '0xbb',
    }]);
    expect(out[0]?.yParity).toBe(0);
    expect(out[0]?.nonce).toBe(0);
  });

  test('multi-element list — every entry normalised independently', () => {
    const out = normalizeAuthorizationList([
      { address: DELEGATE, chainId: '0xaa36a7', nonce: '0x4', r: '0xaa', s: '0xbb', yParity: '0x1' },
      { address: DELEGATE, chainId: '0x1',     nonce: '0x0', r: '0xcc', s: '0xdd', yParity: '0x0' },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]?.chainId).toBe(SEPOLIA_CHAIN);
    expect(out[1]?.chainId).toBe(1);
  });
});

// ─── Roundtrip via viem's actual serialiser ───────────────────────────────
//
// This is the regression test that catches the production bug. We:
//   1. Sign an authorization locally (gets typed format from viem).
//   2. Simulate what the dapp-side viem `formatAuthorizationList` does
//      before sending eth_sendTransaction over EIP-1193 — hex-stringify
//      every numeric field.
//   3. Run our normalize on the wire-format list (this is what background.ts
//      does).
//   4. Run viem's `serializeAuthorizationList` (the same function that builds
//      the type-4 tx's RLP) on the normalized output.
//   5. Verify the RLP-encoded chainId / nonce are the proper compact hex
//      values, NOT the UTF-8 byte encoding of the string "0xaa36a7" / "0x4".
//   6. Verify recoverAuthorizationAddress on the typed auth recovers the
//      original signer.
//
// If `normalizeAuthorizationList` is broken or removed, step 5 produces
// `0x3078616136336137` (bytes of the literal string) instead of `0xaa36a7`,
// and step 6 returns a junk address — exactly the production failure.

describe('roundtrip: dapp wire format → normalize → viem serialise', () => {
  test('serialised RLP chainId / nonce match the signed values, not stringToHex of them', async () => {
    const signed = await signAuthorization({
      privateKey: TEST_PK,
      address: DELEGATE,
      chainId: SEPOLIA_CHAIN,
      nonce: 4,
    });

    // Step 2: simulate dapp-side formatter (transactionRequest.js
    // formatAuthorizationList) — every number → hex string.
    const wireFormat = {
      address: signed.address,
      chainId: numberToHex(signed.chainId),
      nonce: numberToHex(signed.nonce),
      r: signed.r,
      s: signed.s,
      yParity:
        signed.yParity !== undefined
          ? numberToHex(signed.yParity)
          : numberToHex(0),
    };
    expect(typeof wireFormat.chainId).toBe('string');
    expect(typeof wireFormat.nonce).toBe('string');

    // Step 3: our normalise.
    const [typed] = normalizeAuthorizationList([wireFormat]);

    // Step 4: viem's actual RLP serialiser (the one the wallet's local
    // sendTransaction runs to build the type-4 tx).
    const serialized = serializeAuthorizationList([typed!]);
    // Each entry is [chainId, contractAddress, nonce, yParity, r, s].
    const [rlpChainId, rlpAddress, rlpNonce] = serialized[0]!;

    // Step 5: assert RLP fields are compact-hex of the actual numbers,
    // not stringToHex of the string representation. The exact decimal
    // 3176499 (= 0x307834) is the "stringToHex bug" footprint and must
    // never appear in the serialised tx.
    // viem's numberToHex outputs compact (no leading zero), so 4 → '0x4'.
    expect(rlpChainId).toBe(SEPOLIA_HEX);
    expect(rlpNonce).toBe('0x4');
    expect(rlpAddress).toBe(DELEGATE);
    // Bug footprints — these are what got onto Sepolia in the production
    // failure. Asserting the absence locks in that normalise stayed in place.
    expect(rlpNonce).not.toBe('0x307834');
    expect(rlpChainId).not.toBe('0x3078616133366137');

    // Step 6: recoverAuthorizationAddress on the typed auth must return the
    // original signer. If normalize is broken, the auth's chainId/nonce
    // would be wrong and recovery returns a junk address.
    const recovered = await recoverAuthorizationAddress({ authorization: typed! });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  test('without normalise (counter-example), serialiser would produce stringToHex bug', () => {
    // Lock in WHY normalise is required: feed wire-format directly into
    // serialiseAuthorizationList without our normaliser and assert the
    // bug footprint shows up. This documents the exact failure mode.
    const wireFormat = {
      address: DELEGATE,
      chainId: SEPOLIA_HEX,            // string!
      nonce: '0x4',                     // string!
      r: '0x313222ce48c59d39d38b036ccc6929d5b8c90dbcb1f4e9c453f48841333b1d73',
      s: '0x7d93aebc0dc7da228ff91f2f6d5a9c33d7f73b5489ba34f9a81f105174d82bab',
      yParity: '0x1',
    };
    // Cast through unknown — viem's typed signature wants numbers and TS
    // would normally block this. The bug is precisely a missing runtime
    // guard that lets the wrong type slip through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = serializeAuthorizationList([wireFormat] as any);
    const [rlpChainId, , rlpNonce] = serialized[0]!;
    // viem's toHex routes string → stringToHex → UTF-8 byte encoding of
    // the literal hex chars. These are the exact mangled values seen on
    // Sepolia explorer when the bug happened in production.
    // "0xaa36a7" = 8 chars = bytes 0x30 0x78 0x61 0x61 0x33 0x36 0x61 0x37
    //            = 0x3078616133366137
    // "0x4" = 3 chars = bytes 0x30 0x78 0x34 = 0x307834 = 3176499 decimal
    expect(rlpChainId).toBe('0x3078616133366137');
    expect(rlpNonce).toBe('0x307834');
  });
});
