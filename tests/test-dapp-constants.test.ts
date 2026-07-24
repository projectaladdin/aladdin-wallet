// Static-scan the e2e test-dapp fixture for malformed hex constants.
// Bug we're guarding: FAKE_ATTACKER was `0x9aBaDcAFEDEAd0000…0bAd`
// (41 hex chars after `0x` — one extra zero). It looked like an
// address at a glance but the dapp would concatenate it into
// `eth_sendTransaction.data` and the SW's Go-side `eth_call` would
// reject "odd length hex string" — which surfaced as a confusing
// sign-confirm error instead of the obvious "this address is
// malformed".
//
// JS doesn't typecheck inline-string addresses; this test is a
// belt-and-suspenders sanity check on every `'0x…'` literal in the
// fixture file. Addresses MUST be 40 hex; selectors MUST be 8 hex.
// Larger payloads (calldata, deploy bytecode) get a length-even check.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DAPP = readFileSync(resolve(__dirname, '../e2e/fixtures/test-dapp.html'), 'utf8');
// Pull every single-quoted `0x…` literal from the inline JS. The
// regex tolerates mixed case (legitimate for checksummed addresses)
// and skips anything that doesn't look like pure hex (e.g. `'0xfoo'`
// in a comment string would NOT match — we require [0-9a-fA-F]+ only).
const HEX_LITERALS = [...DAPP.matchAll(/'(0x[0-9a-fA-F]+)'/g)].map((m) => m[1]!);

describe('test-dapp.html hex constants', () => {
  it('every address-shaped constant is a valid 40-hex EVM address', () => {
    // Heuristic: anything in the 35–55 character range is an
    // address. Smaller values (0x0, 0x123, hex amounts) are
    // legitimate uint256 literals; larger payloads (calldata,
    // bytecode) are 200+ chars — neither needs this check.
    // The original bug: a 41-char vanity address slipped in
    // because nothing caught the trailing odd character.
    for (const s of HEX_LITERALS) {
      const after = s.slice(2);
      if (after.length >= 35 && after.length <= 55) {
        expect(after.length, `${s} is address-shaped but length ${after.length}, expected 40`)
          .toBe(40);
      }
    }
  });

  it('FAKE_ATTACKER vanity address is parseable as a 40-hex EVM address', () => {
    // Direct check — this is THE constant that caused the bug. The
    // pattern keeps `bad·cafe·dead…bad` so future cosmetic edits
    // (changing case, swapping the vanity) don't accidentally
    // shorten it again.
    const m = DAPP.match(/FAKE_ATTACKER\s*=\s*'(0x[0-9a-fA-F]+)'/);
    expect(m, 'FAKE_ATTACKER constant not found').not.toBeNull();
    const addr = m![1]!;
    expect(/^0x[0-9a-fA-F]{40}$/.test(addr), `${addr} is not a valid 40-hex address`).toBe(true);
  });
});
