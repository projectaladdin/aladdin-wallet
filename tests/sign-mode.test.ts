// Sign-mode classification tests — picks the visual shape and action label
// for the SignConfirm screen.
//
// These map to display correctness:
//   • Wrong mode → wrong UI (e.g. "send tx" rendered for an approve, hides
//     the spender / amount highlight)
//   • Wrong action label → user reads wrong verb in subtitle ("send" instead
//     of "approve")
//   • Throw on unhandled method → loud failure beats silent fallthrough

import { describe, expect, test } from 'bun:test';
import { encodeFunctionData } from 'viem';
import { deriveSignMode, signActionLabel } from '../src/lib/sign-mode';
import { COMMON_TX_ABI } from '../src/lib/decoders';
import type { PendingRequest } from '../src/shared/protocol';

const ADDR_A = '0x1111111111111111111111111111111111111111' as const;
const ADDR_B = '0x2222222222222222222222222222222222222222' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

function req(method: string, params: unknown): PendingRequest {
  return {
    id: 't',
    origin: 'https://example.com',
    payload: { method, params },
    createdAt: 0,
    // Snapshot fields added by the chainId / accountIndex anti-race
    // fix; mode classification doesn't read these, so any valid values
    // suffice for unit-level dispatch tests.
    chainId: 1,
    accountIndex: 0,
  };
}

function approveCalldata(): `0x${string}` {
  return encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'approve', args: [ADDR_B, 1n] });
}

function transferCalldata(): `0x${string}` {
  return encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'transfer', args: [ADDR_B, 1n] });
}

// ─── deriveSignMode ───────────────────────────────────────────────────────

describe('deriveSignMode', () => {
  test('wallet_signAuthorization → 7702 with bad tone', () => {
    const r = deriveSignMode(req('wallet_signAuthorization', [{ chainId: '0x1', address: ADDR_B, nonce: '0x0' }]));
    expect(r).toEqual({ mode: '7702', stampText: 'Wallet takeover', stampTone: 'bad' });
  });

  test('eth_sendTransaction with approve calldata → approve mode', () => {
    const r = deriveSignMode(req('eth_sendTransaction', [{ to: ADDR_B, data: approveCalldata() }]));
    expect(r.mode).toBe('approve');
    expect(r.stampTone).toBe('bad');
  });

  test('eth_sendTransaction with transfer calldata → sendtx mode (not approve)', () => {
    const r = deriveSignMode(req('eth_sendTransaction', [{ to: ADDR_B, data: transferCalldata() }]));
    expect(r.mode).toBe('sendtx');
  });

  test('eth_sendTransaction with no data → sendtx mode', () => {
    const r = deriveSignMode(req('eth_sendTransaction', [{ to: ADDR_B, value: '0x1' }]));
    expect(r.mode).toBe('sendtx');
    expect(r.stampTone).toBe('warn');
  });

  test('wallet_addEthereumChain → addchain', () => {
    expect(deriveSignMode(req('wallet_addEthereumChain', [{ chainId: '0x1' }])).mode).toBe('addchain');
  });

  test('wallet_watchAsset → watchAsset (low risk stamp)', () => {
    const r = deriveSignMode(req('wallet_watchAsset', { type: 'ERC20', options: { address: ADDR_B } }));
    expect(r.mode).toBe('watchAsset');
    expect(r.stampTone).toBe('low');
  });

  test('personal_sign → message (low)', () => {
    expect(deriveSignMode(req('personal_sign', ['0xab', ADDR_A])).stampTone).toBe('low');
  });

  test('eth_signTypedData_v4 → typed', () => {
    expect(deriveSignMode(req('eth_signTypedData_v4', [ADDR_A, '{}'])).mode).toBe('typed');
  });

  test('eth_signTypedData_v1 → typed (v1 also matches startsWith)', () => {
    expect(deriveSignMode(req('eth_signTypedData_v1', [[], ADDR_A])).mode).toBe('typed');
  });

  test('unhandled method throws', () => {
    expect(() => deriveSignMode(req('eth_sign', ['0xab', ADDR_A]))).toThrow(/unhandled sign method/);
  });
});

// ─── signActionLabel ──────────────────────────────────────────────────────

describe('signActionLabel', () => {
  test('wallet_signAuthorization → "sign 7702 delegation"', () => {
    expect(signActionLabel(req('wallet_signAuthorization', [{ chainId: '0x1', address: ADDR_B, nonce: '0x0' }])))
      .toBe('sign 7702 delegation');
  });

  test('wallet_addEthereumChain → "add custom chain"', () => {
    expect(signActionLabel(req('wallet_addEthereumChain', [{}]))).toBe('add custom chain');
  });

  test('wallet_watchAsset → "add token"', () => {
    expect(signActionLabel(req('wallet_watchAsset', {}))).toBe('add token');
  });

  test('personal_sign → "sign message"', () => {
    expect(signActionLabel(req('personal_sign', ['0xab', ADDR_A]))).toBe('sign message');
  });

  test('eth_sendTransaction with no `to` → "deploy contract"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ data: '0x6080' }]))).toBe('deploy contract');
  });

  test('eth_sendTransaction with `to` = zero address → "deploy contract"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ZERO, data: '0x6080' }]))).toBe('deploy contract');
  });

  test('approve calldata → "approve token"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, data: approveCalldata() }])))
      .toBe('approve token');
  });

  test('transfer calldata → "transfer token"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, data: transferCalldata() }])))
      .toBe('transfer token');
  });

  test('deposit calldata → "wrap ETH"', () => {
    const data = encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'deposit' });
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, data }]))).toBe('wrap ETH');
  });

  test('withdraw calldata → "unwrap"', () => {
    const data = encodeFunctionData({ abi: COMMON_TX_ABI, functionName: 'withdraw', args: [1n] });
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, data }]))).toBe('unwrap');
  });

  test('unknown calldata → "send transaction"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, data: '0xdeadbeef' }])))
      .toBe('send transaction');
  });

  test('plain ETH transfer (no data) → "send transaction"', () => {
    expect(signActionLabel(req('eth_sendTransaction', [{ to: ADDR_B, value: '0x1' }])))
      .toBe('send transaction');
  });

  test('eth_signTypedData_v4 with primaryType → "sign Permit"', () => {
    const data = JSON.stringify({ primaryType: 'Permit', message: { value: '1' }, types: {} });
    expect(signActionLabel(req('eth_signTypedData_v4', [ADDR_A, data]))).toBe('sign Permit');
  });

  test('eth_signTypedData_v4 with unparseable data → "sign typed data"', () => {
    expect(signActionLabel(req('eth_signTypedData_v4', [ADDR_A, '{not-json}'])))
      .toBe('sign typed data');
  });

  test('unknown method falls back to "requesting signature"', () => {
    expect(signActionLabel(req('eth_chainId', []))).toBe('requesting signature');
  });
});
