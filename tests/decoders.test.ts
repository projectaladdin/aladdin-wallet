// Decoder tests — calldata recognition + Permit canonical-shape phishing
// detection + relative time formatting.
//
// These map to the security-critical paths in src/popup/screens/sign-confirm.tsx:
//   • A wrong decode = user signs something they don't see (display lies).
//   • A canonical-shape false positive on a phishing struct = green-light
//     UI on a sig that bypasses real Permit contracts.
//   • An off-by-one in relativeFromUnix = expired deadline shown as live.

import { describe, expect, test } from 'bun:test';
import { encodeFunctionData } from 'viem';
import {
  decodeTxData,
  COMMON_TX_ABI,
  isStandardERC2612Permit,
  isStandardPermit2Single,
  isStandardPermit2Batch,
  shapeMatches,
  CANONICAL_PERMIT_FIELDS,
  getRawTypes,
  relativeFromUnix,
  parseTyped,
} from '../src/lib/decoders';

const A1 = '0x1111111111111111111111111111111111111111' as const;
const A2 = '0x2222222222222222222222222222222222222222' as const;

// ─── decodeTxData ─────────────────────────────────────────────────────────

describe('decodeTxData', () => {
  test('empty data → native transfer', () => {
    expect(decodeTxData(undefined).kind).toBe('native');
    expect(decodeTxData('').kind).toBe('native');
    expect(decodeTxData('0x').kind).toBe('native');
  });

  test('< 10 chars → native transfer (selector requires 4 bytes = 0x + 8 hex)', () => {
    expect(decodeTxData('0x1234').kind).toBe('native');
  });

  test('decodes ERC-20 transfer', () => {
    const data = encodeFunctionData({
      abi: COMMON_TX_ABI,
      functionName: 'transfer',
      args: [A1, 100n],
    });
    const r = decodeTxData(data);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.name).toBe('transfer');
      expect(r.args[0]).toBe(A1);
      expect(r.args[1]).toBe(100n);
    }
  });

  test('decodes ERC-20 approve with uint256.max', () => {
    const MAX = (1n << 256n) - 1n;
    const data = encodeFunctionData({
      abi: COMMON_TX_ABI,
      functionName: 'approve',
      args: [A2, MAX],
    });
    const r = decodeTxData(data);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.name).toBe('approve');
      expect(r.args[1]).toBe(MAX);
    }
  });

  test('decodes ERC-20 transferFrom', () => {
    const data = encodeFunctionData({
      abi: COMMON_TX_ABI,
      functionName: 'transferFrom',
      args: [A1, A2, 1n],
    });
    const r = decodeTxData(data);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.name).toBe('transferFrom');
  });

  test('decodes WETH deposit / withdraw', () => {
    const dep = encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'deposit', args: [] });
    expect((decodeTxData(dep) as { name: string }).name).toBe('deposit');

    const w = encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'withdraw', args: [10n] });
    expect((decodeTxData(w) as { name: string }).name).toBe('withdraw');
  });

  test('unknown selector falls through to {kind: unknown}', () => {
    // Selector chosen to not collide with anything in COMMON_TX_ABI or
    // SELECTOR_TABLE_ABI. (`setApprovalForAll` used to be the unknown
    // case here, but it's now in the bundled ERC-721 entries.)
    const r = decodeTxData('0xdeadbeef' + '00'.repeat(64));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.selector).toBe('0xdeadbeef');
      expect(r.bytes).toBe(4 + 64);
    }
  });

  test('contract deploy bytecode (0x60806040...) returns unknown with full byte count', () => {
    const initcode = '0x60806040' + 'aa'.repeat(1000);
    const r = decodeTxData(initcode);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.selector).toBe('0x60806040');
      expect(r.bytes).toBe(4 + 1000);
    }
  });

  test('truncated calldata that matches selector but bad encoding → unknown (graceful)', () => {
    // transfer selector but only 4 bytes of args (need 64) — viem's decoder
    // throws; we surface as unknown rather than crashing.
    const r = decodeTxData('0xa9059cbb' + '00');
    expect(r.kind).toBe('unknown');
  });
});

// ─── Permit canonical-shape detection (phishing defense) ──────────────────

describe('isStandardERC2612Permit', () => {
  const okPermit = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };

  test('accepts canonical ERC-2612 shape', () => {
    expect(isStandardERC2612Permit(okPermit)).toBe(true);
  });

  test('rejects reordered fields (different typeHash)', () => {
    expect(isStandardERC2612Permit({
      Permit: [
        { name: 'spender',  type: 'address' },
        { name: 'owner',    type: 'address' }, // swapped
        { name: 'value',    type: 'uint256' },
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    })).toBe(false);
  });

  test('rejects renamed field', () => {
    expect(isStandardERC2612Permit({
      Permit: [
        { name: 'owner',    type: 'address' },
        { name: 'spender',  type: 'address' },
        { name: 'amount',   type: 'uint256' }, // value → amount
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    })).toBe(false);
  });

  test('rejects retyped field', () => {
    expect(isStandardERC2612Permit({
      Permit: [
        { name: 'owner',    type: 'address' },
        { name: 'spender',  type: 'address' },
        { name: 'value',    type: 'uint128' }, // uint256 → uint128
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    })).toBe(false);
  });

  test('rejects shorter / longer field list', () => {
    expect(isStandardERC2612Permit({
      Permit: okPermit.Permit.slice(0, 4), // missing deadline
    })).toBe(false);
    expect(isStandardERC2612Permit({
      Permit: [...okPermit.Permit, { name: 'extra', type: 'uint256' }],
    })).toBe(false);
  });

  test('rejects missing Permit entry / undefined types', () => {
    expect(isStandardERC2612Permit(undefined)).toBe(false);
    expect(isStandardERC2612Permit({})).toBe(false);
  });
});

describe('isStandardPermit2Single', () => {
  const okTypes = {
    PermitSingle: [
      { name: 'details',     type: 'PermitDetails' },
      { name: 'spender',     type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: [
      { name: 'token',      type: 'address' },
      { name: 'amount',     type: 'uint160' },
      { name: 'expiration', type: 'uint48'  },
      { name: 'nonce',      type: 'uint48'  },
    ],
  };

  test('accepts canonical Permit2 single shape', () => {
    expect(isStandardPermit2Single(okTypes)).toBe(true);
  });

  test('rejects when PermitDetails is reordered', () => {
    expect(isStandardPermit2Single({
      ...okTypes,
      PermitDetails: [
        { name: 'amount',     type: 'uint160' }, // moved up
        { name: 'token',      type: 'address' },
        { name: 'expiration', type: 'uint48'  },
        { name: 'nonce',      type: 'uint48'  },
      ],
    })).toBe(false);
  });

  test('rejects when amount is uint256 instead of uint160 (Permit2 spec is uint160)', () => {
    expect(isStandardPermit2Single({
      ...okTypes,
      PermitDetails: [
        { name: 'token',      type: 'address' },
        { name: 'amount',     type: 'uint256' }, // wrong width
        { name: 'expiration', type: 'uint48'  },
        { name: 'nonce',      type: 'uint48'  },
      ],
    })).toBe(false);
  });

  test('rejects when only PermitSingle is canonical but PermitDetails missing', () => {
    expect(isStandardPermit2Single({ PermitSingle: okTypes.PermitSingle })).toBe(false);
  });
});

describe('isStandardPermit2Batch', () => {
  test('accepts canonical batch (details: PermitDetails[])', () => {
    expect(isStandardPermit2Batch({
      PermitBatch: [
        { name: 'details',     type: 'PermitDetails[]' },
        { name: 'spender',     type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token',      type: 'address' },
        { name: 'amount',     type: 'uint160' },
        { name: 'expiration', type: 'uint48'  },
        { name: 'nonce',      type: 'uint48'  },
      ],
    })).toBe(true);
  });

  test('rejects single shape (details is non-array)', () => {
    expect(isStandardPermit2Batch({
      PermitBatch: [
        { name: 'details',     type: 'PermitDetails' }, // missing []
        { name: 'spender',     type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    })).toBe(false);
  });
});

describe('shapeMatches (low-level)', () => {
  test('same length + same fields = true', () => {
    expect(shapeMatches(
      [{ name: 'a', type: 'uint256' }, { name: 'b', type: 'address' }],
      [{ name: 'a', type: 'uint256' }, { name: 'b', type: 'address' }],
    )).toBe(true);
  });

  test('returns false for undefined input', () => {
    expect(shapeMatches(undefined, CANONICAL_PERMIT_FIELDS)).toBe(false);
  });
});

// ─── getRawTypes ──────────────────────────────────────────────────────────

describe('getRawTypes', () => {
  test('extracts types from object', () => {
    expect(getRawTypes({ types: { Foo: [] }, primaryType: 'Foo' })).toEqual({ Foo: [] });
  });

  test('extracts types from JSON string', () => {
    expect(getRawTypes(JSON.stringify({ types: { Bar: [] } }))).toEqual({ Bar: [] });
  });

  test('returns undefined for unparseable / wrong shape', () => {
    expect(getRawTypes('{not-json}')).toBeUndefined();
    expect(getRawTypes(null)).toBeUndefined();
    expect(getRawTypes({ noTypes: true })).toBeUndefined();
    expect(getRawTypes({ types: 'not-an-object' })).toBeUndefined();
  });
});

// ─── relativeFromUnix ─────────────────────────────────────────────────────

describe('relativeFromUnix', () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);

  test('returns "expired" for past timestamps (and provides unix sub)', () => {
    const r = relativeFromUnix(NOW_SEC - 60);
    expect(r?.display).toBe('expired');
    expect(r?.sub).toMatch(/^unix \d+$/);
  });

  test('formats minutes for sub-hour deadlines', () => {
    const r = relativeFromUnix(NOW_SEC + 30 * 60);
    expect(r?.display).toMatch(/in \d+ mins?/);
  });

  test('formats hours for sub-day deadlines', () => {
    const r = relativeFromUnix(NOW_SEC + 5 * 3600);
    expect(r?.display).toMatch(/in \d+ hours/);
  });

  test('formats days for multi-day deadlines', () => {
    const r = relativeFromUnix(NOW_SEC + 7 * 86400);
    expect(r?.display).toMatch(/in 7 days/);
  });

  test('formats months for far-future deadlines', () => {
    const r = relativeFromUnix(NOW_SEC + 90 * 86400);
    expect(r?.display).toMatch(/in \d+ months/);
  });

  test('handles "in 1 min" singular vs "in 30 mins" plural correctly', () => {
    // 60 seconds → exactly 1 minute (Math.round(60/60) === 1) → singular form.
    expect(relativeFromUnix(NOW_SEC + 60)?.display).toBe('in 1 min');
    expect(relativeFromUnix(NOW_SEC + 30 * 60)?.display).toMatch(/^in \d+ mins$/);
  });

  test('returns null for zero / unparseable input', () => {
    expect(relativeFromUnix(0)).toBeNull();
    expect(relativeFromUnix('not-a-number')).toBeNull();
  });

  test('accepts hex / number / string formats (BigInt parses them all)', () => {
    const future = NOW_SEC + 3600;
    expect(relativeFromUnix(String(future))?.display).toMatch(/in \d+ hours?/);
    expect(relativeFromUnix(`0x${future.toString(16)}`)?.display).toMatch(/in \d+ hours?/);
  });
});

// ─── parseTyped ───────────────────────────────────────────────────────────

describe('parseTyped', () => {
  test('extracts primaryType / message / domain from object', () => {
    const r = parseTyped({
      primaryType: 'Permit',
      message: { value: '1' },
      domain: { name: 'TKN' },
    });
    expect(r?.primaryType).toBe('Permit');
    expect(r?.message).toEqual({ value: '1' });
    expect(r?.domain).toEqual({ name: 'TKN' });
  });

  test('parses JSON-string payload (eth_signTypedData_v4 wire format)', () => {
    const json = JSON.stringify({ primaryType: 'Mail', message: { contents: 'hi' }, domain: {} });
    const r = parseTyped(json);
    expect(r?.primaryType).toBe('Mail');
  });

  test('returns null for unparseable JSON', () => {
    expect(parseTyped('{not-json}')).toBeNull();
  });

  test('returns null for null / non-object', () => {
    expect(parseTyped(null)).toBeNull();
    expect(parseTyped(42)).toBeNull();
  });

  test('returns null when primaryType missing (degenerate)', () => {
    expect(parseTyped({ message: { v: 1 } })).toBeNull();
  });

  test('returns null when message missing', () => {
    expect(parseTyped({ primaryType: 'Foo' })).toBeNull();
  });

  test('domain absent → undefined (not error)', () => {
    const r = parseTyped({ primaryType: 'Foo', message: {} });
    expect(r?.domain).toBeUndefined();
  });
});
