// Pins the security engine's `Signal[]` output shape — the richer
// data structure the future checks-panel UI will read directly. The
// legacy `isDangerous` / `inconsistencies` adapters are still
// covered by `tests/risk.test.ts`; this file targets the parts that
// shim away (signal IDs, severities, multi-signal returns).

import { describe, expect, test } from 'bun:test';
import { runEngine, primarySignal } from '../src/lib/security-engine';
import type { Address } from 'viem';
import type { PendingRequest } from '../src/shared/protocol';

const USER = '0x1111111111111111111111111111111111111111' as Address;
const CTX = { address: USER, chainId: 1 } as const;

function makeReq(method: string, params: unknown): PendingRequest {
  return {
    id: 'test-1',
    origin: 'https://test.example',
    payload: { method, params },
    createdAt: Date.now(),
    chainId: 1,
    accountIndex: 0,
  };
}

describe('runEngine: 7702 authorization', () => {
  test('fires the seven702-delegation signal as informational (non-primary, info, no ack, silent)', () => {
    const req = makeReq('wallet_signAuthorization', [{
      address: '0xabc0000000000000000000000000000000000000',
      chainId: '0x1',
      nonce: '0x0',
    }]);
    const signals = runEngine(req, CTX);
    const s = signals.find((x) => x.id === 'seven702-delegation');
    expect(s).toBeDefined();
    // App-dedicated wallet: 7702 delegation is the normal flow — informational,
    // not a danger banner, no forced ack. The 7702 body renders a neutral intro
    // + slide-to-confirm. `silent` keeps it out of the SecurityChecks panel.
    expect(s?.severity).toBe('info');
    expect(s?.primary).toBe(false);
    expect(s?.requiresAck).toBe(false);
    expect(s?.silent).toBe(true);
  });

  test('emits chain-mismatch danger when wallet on different chain', () => {
    const req = makeReq('wallet_signAuthorization', [{
      address: '0xabc0000000000000000000000000000000000000',
      chainId: '0xaa36a7', // sepolia
      nonce: '0x0',
    }]);
    const signals = runEngine(req, CTX); // wallet on mainnet
    const mismatch = signals.find((x) => x.id === 'auth-chain-mismatch');
    expect(mismatch).toBeDefined();
    // Chain-mismatch is a hard block — the 7702 gate refuses to
    // unlock regardless of Sourcify result, since a delegation
    // signed for chain A is meaningless when submitted on chain B.
    // Severity escalated from 'warning' → 'danger' so the wallet's
    // existing high-severity treatment (slide refuses to unlock,
    // even with the dev override) kicks in.
    expect(mismatch?.severity).toBe('danger');
    expect(mismatch?.primary).toBeFalsy();
  });
});

describe('runEngine: signer-mismatch on personal_sign', () => {
  test('fires when params[1] differs from active address', () => {
    const wrong = '0x9999999999999999999999999999999999999999';
    const req = makeReq('personal_sign', ['0xdeadbeef', wrong]);
    const signals = runEngine(req, CTX);
    expect(signals.find((s) => s.id === 'signer-mismatch')).toBeDefined();
  });

  test('does not fire when signer matches', () => {
    const req = makeReq('personal_sign', ['0xdeadbeef', USER]);
    const signals = runEngine(req, CTX);
    expect(signals.find((s) => s.id === 'signer-mismatch')).toBeUndefined();
  });
});

describe('runEngine: canonical Permit', () => {
  const canonicalPermit = JSON.stringify({
    primaryType: 'Permit',
    domain: { chainId: 1, verifyingContract: USER },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: { owner: USER, spender: USER, value: '100', nonce: '0', deadline: '0' },
  });

  test('finite value → permit warning (primary, not requiresAck)', () => {
    const req = makeReq('eth_signTypedData_v4', [USER, canonicalPermit]);
    const signals = runEngine(req, CTX);
    const s = signals.find((x) => x.id === 'permit');
    expect(s?.severity).toBe('warning');
    expect(s?.primary).toBe(true);
    expect(s?.requiresAck).toBeFalsy();
  });

  test('unlimited (0xff...ff) value → permit-unlimited danger (requiresAck)', () => {
    const max = '0x' + 'f'.repeat(64);
    const req = makeReq('eth_signTypedData_v4', [USER, canonicalPermit.replace(
      '"value":"100"', `"value":"${max}"`,
    )]);
    const signals = runEngine(req, CTX);
    const s = signals.find((x) => x.id === 'permit-unlimited');
    expect(s?.severity).toBe('danger');
    expect(s?.primary).toBe(true);
    expect(s?.requiresAck).toBe(true);
  });
});

describe('primarySignal: severity ordering', () => {
  test('returns the highest-severity primary signal', () => {
    const signals = [
      { id: 'a', severity: 'warning', message: 'a', primary: true },
      { id: 'b', severity: 'danger',  message: 'b', primary: true },
      { id: 'c', severity: 'info',    message: 'c', primary: true },
    ] as const;
    expect(primarySignal(signals)?.id).toBe('b');
  });

  test('ignores non-primary signals even if higher severity', () => {
    const signals = [
      { id: 'a', severity: 'warning', message: 'a', primary: true },
      { id: 'b', severity: 'danger',  message: 'b' }, // no primary flag
    ] as const;
    expect(primarySignal(signals)?.id).toBe('a');
  });

  test('returns null when nothing primary', () => {
    const signals = [
      { id: 'a', severity: 'danger', message: 'a' },
    ] as const;
    expect(primarySignal(signals)).toBeNull();
  });
});

describe('runEngine: routine methods return no signals', () => {
  test('personal_sign with matching signer → empty', () => {
    const req = makeReq('personal_sign', ['0xdeadbeef', USER]);
    expect(runEngine(req, CTX)).toEqual([]);
  });

  test('eth_sendTransaction → empty (decoder + simulation handle tx risk separately)', () => {
    const req = makeReq('eth_sendTransaction', [{
      from: USER, to: USER, value: '0x0',
    }]);
    expect(runEngine(req, CTX)).toEqual([]);
  });
});

describe('runEngine: grant-scope-violation (Task 5.2)', () => {
  test('fires danger (primary, requiresAck) when ctx.grantScopeViolation is set on a tx', () => {
    const req = makeReq('eth_sendTransaction', [{ from: USER, to: USER, value: '0x0' }]);
    const signals = runEngine(req, { ...CTX, grantScopeViolation: 'selector 0xdeadbeef is not in the granted scope' });
    const s = signals.find((x) => x.id === 'grant-scope-violation');
    expect(s?.severity).toBe('danger');
    expect(s?.primary).toBe(true);
    expect(s?.requiresAck).toBe(true);
    expect(s?.message).toContain('selector 0xdeadbeef is not in the granted scope');
  });

  test('does NOT fire when the violation is absent (in-scope / no matching grant)', () => {
    const req = makeReq('eth_sendTransaction', [{ from: USER, to: USER, value: '0x0' }]);
    expect(runEngine(req, CTX).find((x) => x.id === 'grant-scope-violation')).toBeUndefined();
  });

  test('does NOT fire for a non-tx method even if a violation string is present', () => {
    // The field only carries meaning for eth_sendTransaction; other methods
    // must ignore it entirely.
    const req = makeReq('personal_sign', ['0xdeadbeef', USER]);
    const signals = runEngine(req, { ...CTX, grantScopeViolation: 'should be ignored' });
    expect(signals.find((x) => x.id === 'grant-scope-violation')).toBeUndefined();
  });
});

describe('runEngine: ai-intent (Task 6.2)', () => {
  test('fires warning (primary, requiresAck) when ctx.aiIntent is set on a tx', () => {
    const req = makeReq('eth_sendTransaction', [{ from: USER, to: USER, value: '0x0' }]);
    const signals = runEngine(req, { ...CTX, aiIntent: '0xa9059cbb → 0x2222…2222' });
    const s = signals.find((x) => x.id === 'ai-intent');
    expect(s?.severity).toBe('warning');
    expect(s?.primary).toBe(true);
    expect(s?.requiresAck).toBe(true);
    expect(s?.message).toContain('0xa9059cbb → 0x2222…2222');
  });

  test('does NOT fire when the origin is not AI-flagged (aiIntent absent)', () => {
    const req = makeReq('eth_sendTransaction', [{ from: USER, to: USER, value: '0x0' }]);
    expect(runEngine(req, CTX).find((x) => x.id === 'ai-intent')).toBeUndefined();
  });

  test('does NOT fire for a non-tx method even if aiIntent is present', () => {
    // Prompt-injection defense is scoped to value-moving eth_sendTransaction;
    // a plain personal_sign from a flagged origin must not trip this rule.
    const req = makeReq('personal_sign', ['0xdeadbeef', USER]);
    const signals = runEngine(req, { ...CTX, aiIntent: 'should be ignored' });
    expect(signals.find((x) => x.id === 'ai-intent')).toBeUndefined();
  });
});
