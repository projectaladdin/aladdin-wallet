// Multicall recursive risk-analysis tests.
//
// Two layers:
//   1. `decodeMulticallInner` (decoders.ts) — pure structural decode.
//      Given an outer multicall/aggregate3 known-decode, returns each
//      inner call decoded individually. Round-trip with encoded
//      calldata to confirm we pull the right bytes[] field.
//   2. `ruleMulticallRisk` (security-engine.ts) — applied semantics.
//      Wrap dangerous calldata into a multicall, assert the engine
//      emits a `multicall-risk` danger signal with the right phrases.

import { describe, expect, test } from 'bun:test';
import { encodeFunctionData, type Abi } from 'viem';
import {
  decodeMulticallInner,
  decodeTxData,
  MULTICALL_NAMES,
} from '../src/lib/decoders';
import { runEngine } from '../src/lib/security-engine';
import { SELECTOR_TABLE_ABI } from '../src/lib/selector-table';
import type { Address } from 'viem';
import type { PendingRequest } from '../src/shared/protocol';

const COMMON_ABI: Abi = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
];

const USER     = '0x1111111111111111111111111111111111111111' as const;
const ATTACKER = '0x2222222222222222222222222222222222222222' as const;
const VICTIM   = '0x3333333333333333333333333333333333333333' as const;
const UINT256_MAX = (1n << 256n) - 1n;

function makeTx(to: string, data: string): PendingRequest {
  return {
    id: '1', origin: 'https://test', createdAt: 0,
    chainId: 1, accountIndex: 0,
    payload: { method: 'eth_sendTransaction', params: [{ from: USER, to, data, value: '0x0' }] },
  };
}

describe('MULTICALL_NAMES', () => {
  test('canonical set is `multicall` + `aggregate3`', () => {
    expect(MULTICALL_NAMES.has('multicall')).toBe(true);
    expect(MULTICALL_NAMES.has('aggregate3')).toBe(true);
    expect(MULTICALL_NAMES.has('transfer')).toBe(false);
  });
});

describe('decodeMulticallInner: V3 multicall(bytes[])', () => {
  test('pulls inner calldata, decodes each as known', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const innerTransfer = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'transfer', args: [VICTIM, 1n],
    });
    const outer = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI,
      functionName: 'multicall',
      args: [[innerApprove, innerTransfer]],
    });
    const decoded = decodeTxData(outer);
    expect(decoded.kind).toBe('known');
    const inner = decodeMulticallInner(decoded);
    expect(inner).not.toBeNull();
    expect(inner!.length).toBe(2);
    expect(inner![0]!.kind).toBe('known');
    if (inner![0]!.kind === 'known') expect(inner![0]!.name).toBe('approve');
    if (inner![1]!.kind === 'known') expect(inner![1]!.name).toBe('transfer');
  });

  test('V3 deadline variant `multicall(uint256, bytes[])` works (bytes[] is LAST arg)', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const outer = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI,
      functionName: 'multicall',
      args: [9999999999n, [innerApprove]],
    });
    const decoded = decodeTxData(outer);
    const inner = decodeMulticallInner(decoded);
    expect(inner?.length).toBe(1);
    if (inner?.[0]?.kind === 'known') expect(inner[0].name).toBe('approve');
  });
});

describe('decodeMulticallInner: Multicall3 aggregate3', () => {
  test('extracts callData from each tuple', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const outer = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI,
      functionName: 'aggregate3',
      args: [[{ target: ATTACKER, allowFailure: false, callData: innerApprove }]],
    });
    const decoded = decodeTxData(outer);
    expect(decoded.kind).toBe('known');
    const inner = decodeMulticallInner(decoded);
    expect(inner?.length).toBe(1);
    if (inner?.[0]?.kind === 'known') expect(inner[0].name).toBe('approve');
  });
});

describe('ruleMulticallRisk: detects inner UNLIMITED approve', () => {
  test('multicall containing approve(attacker, max) → danger', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApprove]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    const s = signals.find((x) => x.id === 'multicall-risk');
    expect(s?.severity).toBe('danger');
    expect(s?.message).toMatch(/UNLIMITED approve/);
    expect(s?.requiresAck).toBe(true);
  });

  test('finite approve does NOT fire (not unlimited)', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, 100n],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApprove]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });
});

describe('ruleMulticallRisk: detects transferFrom from caller', () => {
  test('multicall containing transferFrom(user, attacker, _) → danger', () => {
    const innerTransfer = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'transferFrom',
      args: [USER, ATTACKER, 1000n],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerTransfer]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    const s = signals.find((x) => x.id === 'multicall-risk');
    expect(s?.message).toMatch(/pulls from your wallet/);
  });

  test('transferFrom from SOMEONE ELSE does not fire (you signed someone else pulling)', () => {
    const innerTransfer = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'transferFrom',
      args: [VICTIM, ATTACKER, 1000n],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerTransfer]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });
});

describe('ruleMulticallRisk: detects setApprovalForAll(true)', () => {
  test('inner setApprovalForAll(operator, true) → danger', () => {
    const innerApproveAll = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'setApprovalForAll',
      args: [ATTACKER, true],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApproveAll]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    const s = signals.find((x) => x.id === 'multicall-risk');
    expect(s?.message).toMatch(/setApprovalForAll/);
  });

  test('setApprovalForAll(false) does NOT fire (revoking is safe)', () => {
    const innerApproveAll = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'setApprovalForAll',
      args: [ATTACKER, false],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApproveAll]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });
});

describe('ruleMulticallRisk: aggregate3 (Multicall3) is recursed into', () => {
  test('aggregate3 wrapping approve(attacker, max) → danger', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'aggregate3',
      args: [[{ target: ATTACKER, allowFailure: false, callData: innerApprove }]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')?.severity).toBe('danger');
  });
});

describe('ruleMulticallRisk: nested multicall depth', () => {
  test('multicall containing multicall containing approve(max) → danger (recursive walk)', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve',
      args: [ATTACKER, UINT256_MAX],
    });
    const innerMulticall = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApprove]],
    });
    const outer = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerMulticall]],
    });
    const signals = runEngine(makeTx(VICTIM, outer), { address: USER as Address, chainId: 1 });
    const s = signals.find((x) => x.id === 'multicall-risk');
    expect(s).toBeDefined();
    expect(s?.message).toMatch(/UNLIMITED approve/);
  });
});

describe('ruleMulticallRisk: benign cases do not fire', () => {
  test('plain (non-multicall) tx → no signal', () => {
    const data = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'transfer', args: [VICTIM, 100n],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });

  test('empty multicall → no signal', () => {
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });

  test('multicall containing only finite approve + transfer → no signal', () => {
    const innerApprove = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'approve', args: [ATTACKER, 100n],
    });
    const innerTransfer = encodeFunctionData({
      abi: COMMON_ABI, functionName: 'transfer', args: [VICTIM, 1n],
    });
    const data = encodeFunctionData({
      abi: SELECTOR_TABLE_ABI, functionName: 'multicall',
      args: [[innerApprove, innerTransfer]],
    });
    const signals = runEngine(makeTx(VICTIM, data), { address: USER as Address, chainId: 1 });
    expect(signals.find((x) => x.id === 'multicall-risk')).toBeUndefined();
  });
});
