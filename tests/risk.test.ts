// Risk classification tests — danger banner + soft-mismatch chips shown in
// SignConfirm.
//
// These map to the security-critical UX:
//   • Failing to flag wallet_signAuthorization → user signs full delegation
//     thinking it's a routine sig
//   • Failing to detect a non-canonical "Permit" struct → green-light a
//     phisher contract sig (real ERC-2612 contracts won't accept it, but
//     custom contracts will)
//   • Missing chainId mismatch → user signs a permit valid on a different
//     chain that an attacker has already prepared an exploit on
//   • False-positive signer mismatch on v1 typed-data array params →
//     TypeError crash in past versions

import { describe, expect, test } from 'bun:test';
import type { Address } from 'viem';
import { isDangerous, inconsistencies } from '../src/lib/risk';
import type { PendingRequest } from '../src/shared/protocol';

const ACTIVE = '0x1111111111111111111111111111111111111111' as Address;
const OTHER  = '0x2222222222222222222222222222222222222222' as Address;
const SPENDER = '0x3333333333333333333333333333333333333333';
const TOKEN   = '0x4444444444444444444444444444444444444444';
const CHAIN_ID = 1;

const CURRENT = { address: ACTIVE, chainId: CHAIN_ID };

function req(method: string, params: unknown): PendingRequest {
  return {
    id: 'test-id',
    origin: 'https://example.com',
    payload: { method, params },
    createdAt: Date.now(),
    chainId: CHAIN_ID,
    accountIndex: 0,
  };
}

const UINT256_MAX = '0x' + 'f'.repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 86400;
const PAST = Math.floor(Date.now() / 1000) - 600;

const PERMIT_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Permit: [
    { name: 'owner',    type: 'address' },
    { name: 'spender',  type: 'address' },
    { name: 'value',    type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

function permitData(value: string, deadline: number | string = FUTURE) {
  return {
    types: PERMIT_TYPES,
    domain: { name: 'TKN', version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN },
    primaryType: 'Permit',
    message: { owner: ACTIVE, spender: SPENDER, value, nonce: '0', deadline },
  };
}

// ─── isDangerous ──────────────────────────────────────────────────────────

describe('isDangerous: 7702 authorization', () => {
  test('wallet_signAuthorization → routine (app-dedicated wallet: 7702 is the normal flow)', () => {
    // The seven702-delegation signal is informational + non-primary now, so the
    // isDangerous adapter surfaces no primary danger → routine (null).
    const r = isDangerous(req('wallet_signAuthorization', [{ chainId: '0x1', address: SPENDER, nonce: '0x0' }]));
    expect(r).toBeNull();
  });
});

describe('isDangerous: canonical Permit', () => {
  test('UNLIMITED Permit → high', () => {
    const r = isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData(UINT256_MAX))]));
    expect(r?.level).toBe('high');
    expect(r?.message).toMatch(/UNLIMITED/);
  });

  test('regular finite Permit → medium', () => {
    const r = isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData('1000000'))]));
    expect(r?.level).toBe('medium');
  });
});

describe('isDangerous: non-canonical Permit phishing', () => {
  test('reordered Permit fields → high (phishing tell)', () => {
    const td = permitData('1000');
    td.types = {
      ...PERMIT_TYPES,
      Permit: [
        // value moved to first — different typeHash, real ERC-2612 won't verify
        { name: 'value',    type: 'uint256' },
        { name: 'owner',    type: 'address' },
        { name: 'spender',  type: 'address' },
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const r = isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]));
    expect(r?.level).toBe('high');
    expect(r?.message).toMatch(/non-standard/i);
  });

  test('PermitSingle with mismatched details shape → high', () => {
    const td = {
      types: {
        EIP712Domain: PERMIT_TYPES.EIP712Domain,
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
        // Wrong width on amount → not canonical Permit2
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
      },
      domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'PermitSingle',
      message: { details: { token: TOKEN, amount: '1', expiration: '0', nonce: '0' }, spender: SPENDER, sigDeadline: String(FUTURE) },
    };
    const r = isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]));
    expect(r?.level).toBe('high');
  });
});

describe('isDangerous: SafeTx', () => {
  test('SafeTx with operation=1 (DELEGATECALL) → high', () => {
    const td = {
      types: { EIP712Domain: PERMIT_TYPES.EIP712Domain, SafeTx: [{ name: 'to', type: 'address' }, { name: 'operation', type: 'uint8' }] },
      domain: { chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'SafeTx',
      message: { to: SPENDER, operation: 1 },
    };
    const r = isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]));
    expect(r?.level).toBe('high');
    expect(r?.message).toMatch(/DELEGATECALL/);
  });

  test('SafeTx with operation=0 (CALL) → null (not dangerous beyond normal sig)', () => {
    const td = {
      types: { EIP712Domain: PERMIT_TYPES.EIP712Domain, SafeTx: [{ name: 'to', type: 'address' }, { name: 'operation', type: 'uint8' }] },
      domain: { chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'SafeTx',
      message: { to: SPENDER, operation: 0 },
    };
    expect(isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]))).toBeNull();
  });

  test('SafeTx with operation as string "0x1" → high', () => {
    const td = {
      types: { EIP712Domain: PERMIT_TYPES.EIP712Domain, SafeTx: [{ name: 'operation', type: 'uint8' }] },
      domain: { chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'SafeTx',
      message: { operation: '0x1' },
    };
    expect(isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]))?.level).toBe('high');
  });
});

describe('isDangerous: routine sigs', () => {
  test('personal_sign → null', () => {
    expect(isDangerous(req('personal_sign', ['0xdeadbeef', ACTIVE]))).toBeNull();
  });

  test('eth_sendTransaction → null (no danger banner — that\'s sendtx mode\'s job)', () => {
    expect(isDangerous(req('eth_sendTransaction', [{ to: SPENDER, value: '0x0' }]))).toBeNull();
  });

  test('typed Mail (non-Permit, non-SafeTx) → null', () => {
    const td = {
      types: { EIP712Domain: PERMIT_TYPES.EIP712Domain, Mail: [{ name: 'contents', type: 'string' }] },
      domain: { chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'Mail',
      message: { contents: 'hello' },
    };
    expect(isDangerous(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]))).toBeNull();
  });
});

// ─── inconsistencies ──────────────────────────────────────────────────────

describe('inconsistencies: signer mismatch', () => {
  test('personal_sign with wrong signer → flagged', () => {
    const out = inconsistencies(req('personal_sign', ['0xdead', OTHER]), CURRENT);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/signer/);
    expect(out[0]).toMatch(/active/);
  });

  test('personal_sign with active signer → no chip', () => {
    expect(inconsistencies(req('personal_sign', ['0xdead', ACTIVE]), CURRENT)).toEqual([]);
  });

  test('typed v4 with wrong signer → flagged', () => {
    const out = inconsistencies(req('eth_signTypedData_v4', [OTHER, JSON.stringify(permitData('1000'))]), CURRENT);
    expect(out.some((s) => s.includes('signer'))).toBe(true);
  });

  test('typed v1 with array params (not a string) does NOT crash on toLowerCase', () => {
    // v1 sneaks an array into params[0]; legacy bug called .toLowerCase on it
    // (TypeError: Array doesn't have toLowerCase). The fix is a typeof guard
    // in checkSigner — verify it's still in place by sending the exact shape
    // that previously crashed. With ACTIVE as signer, no chip should fire.
    const v1Data = [{ type: 'string', name: 'msg', value: 'hi' }];
    const out = inconsistencies(req('eth_signTypedData_v1', [v1Data, ACTIVE]), CURRENT);
    expect(Array.isArray(out)).toBe(true);
    // No false-positive "signer mismatch" for the legitimate active address.
    expect(out.every((s) => !s.includes('signer'))).toBe(true);
  });

  test('typed v1 with mismatched signer in params[1] still fires the chip', () => {
    // Counterpart to the crash regression — verify the typeof guard doesn't
    // accidentally swallow real signer mismatches when params[1] IS a string.
    const v1Data = [{ type: 'string', name: 'msg', value: 'hi' }];
    const out = inconsistencies(req('eth_signTypedData_v1', [v1Data, OTHER]), CURRENT);
    expect(out.some((s) => /signer/.test(s))).toBe(true);
  });

  test('signer-address comparison is case insensitive', () => {
    const out = inconsistencies(req('personal_sign', ['0xdead', ACTIVE.toUpperCase()]), CURRENT);
    expect(out).toEqual([]);
  });
});

describe('inconsistencies: chainId mismatch', () => {
  test('typed-data domain chainId differs from wallet chainId → flagged', () => {
    const td = permitData('1000');
    td.domain.chainId = 137; // Polygon
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]), CURRENT);
    expect(out.some((s) => /chainId 137 ≠/.test(s))).toBe(true);
  });

  test('matching chainId → no chip', () => {
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData('1000'))]), CURRENT);
    expect(out).toEqual([]);
  });

  test('7702 auth chainId mismatch is NOT in the warning-chip list (escalated to hard block)', () => {
    // Chain mismatch used to appear as a yellow warning chip. It's
    // now severity='danger' so the 7702 gate hard-blocks the slide
    // instead — the dedicated red BLOCKED banner above the slide
    // covers the user-facing surface. The chip list is reserved for
    // softer 'warning'-level signals; the rule still fires in the
    // engine (covered by security-engine.test.ts) but shouldn't
    // duplicate the banner here.
    const out = inconsistencies(
      req('wallet_signAuthorization', [{ chainId: '0x89', address: SPENDER, nonce: '0x0' }]),
      CURRENT,
    );
    expect(out.some((s) => /auth chainId 137/.test(s))).toBe(false);
  });

  test('7702 auth chainId 0 (any) — also escalated, NOT in chip list', () => {
    const out = inconsistencies(
      req('wallet_signAuthorization', [{ chainId: '0x0', address: SPENDER, nonce: '0x0' }]),
      CURRENT,
    );
    expect(out.some((s) => /auth chainId 0/.test(s))).toBe(false);
  });
});

describe('inconsistencies: deadline expired', () => {
  test('expired deadline → "deadline already expired"', () => {
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData('1000', PAST))]), CURRENT);
    expect(out.some((s) => /expired/.test(s))).toBe(true);
  });

  test('future deadline → not flagged', () => {
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData('1000', FUTURE))]), CURRENT);
    expect(out.every((s) => !/expired/.test(s))).toBe(true);
  });

  test('zero / empty deadline → ignored (treated as "no deadline")', () => {
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(permitData('1000', 0))]), CURRENT);
    expect(out.every((s) => !/expired/.test(s))).toBe(true);
  });

  test('Permit2 sigDeadline (alternate name) also detected', () => {
    const td = {
      types: {
        EIP712Domain: PERMIT_TYPES.EIP712Domain,
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
      },
      domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: SPENDER },
      primaryType: 'PermitSingle',
      message: { details: { token: TOKEN, amount: '1', expiration: '0', nonce: '0' }, spender: SPENDER, sigDeadline: String(PAST) },
    };
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]), CURRENT);
    expect(out.some((s) => /expired/.test(s))).toBe(true);
  });

  test('unparseable deadline → silently skipped, no throw', () => {
    const td = permitData('1000', 'not-a-number' as unknown as number);
    const out = inconsistencies(req('eth_signTypedData_v4', [ACTIVE, JSON.stringify(td)]), CURRENT);
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('inconsistencies: unrelated methods', () => {
  test('eth_sendTransaction → no chips (handled in sendtx mode UI)', () => {
    expect(inconsistencies(req('eth_sendTransaction', [{ to: SPENDER, value: '0x0' }]), CURRENT)).toEqual([]);
  });
});
