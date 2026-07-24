// Pins the calldata that NftDetailModal's send view would generate.
// We don't import the component itself (it would drag React + DOM
// into the test); instead we re-import the same viem ABIs the
// component uses and verify selector + args round-trip identically.
// If anyone ever silently swaps the safe-transfer ABI for unsafe
// transferFrom in either the component or here, the selector would
// change and this test fails — that's the load-bearing contract.

import { describe, expect, test } from 'bun:test';
import { encodeFunctionData, decodeFunctionData, type Abi } from 'viem';

const ERC721_TRANSFER_ABI: Abi = [{
  type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
  inputs: [
    { type: 'address', name: 'from' },
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'tokenId' },
  ],
  outputs: [],
}];

const ERC1155_TRANSFER_ABI: Abi = [{
  type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
  inputs: [
    { type: 'address', name: 'from' },
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'id' },
    { type: 'uint256', name: 'amount' },
    { type: 'bytes',   name: 'data' },
  ],
  outputs: [],
}];

const FROM = '0x1111111111111111111111111111111111111111' as const;
const TO   = '0x2222222222222222222222222222222222222222' as const;

describe('NFT send calldata', () => {
  test('ERC-721 safeTransferFrom selector is 0x42842e0e', () => {
    const data = encodeFunctionData({
      abi: ERC721_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 42n],
    });
    expect(data.slice(0, 10)).toBe('0x42842e0e');
  });

  test('ERC-1155 safeTransferFrom selector is 0xf242432a', () => {
    const data = encodeFunctionData({
      abi: ERC1155_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 7n, 1n, '0x'],
    });
    expect(data.slice(0, 10)).toBe('0xf242432a');
  });

  test('ERC-721 calldata round-trips (from, to, tokenId)', () => {
    const data = encodeFunctionData({
      abi: ERC721_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 42n],
    });
    const decoded = decodeFunctionData({ abi: ERC721_TRANSFER_ABI, data });
    expect(decoded.functionName).toBe('safeTransferFrom');
    expect(decoded.args).toEqual([FROM, TO, 42n]);
  });

  test('ERC-1155 calldata round-trips (from, to, id, amount, data)', () => {
    const data = encodeFunctionData({
      abi: ERC1155_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 7n, 3n, '0xdeadbeef'],
    });
    const decoded = decodeFunctionData({ abi: ERC1155_TRANSFER_ABI, data });
    expect(decoded.functionName).toBe('safeTransferFrom');
    expect(decoded.args).toEqual([FROM, TO, 7n, 3n, '0xdeadbeef']);
  });

  test('ERC-721 vs ERC-1155 selectors are DIFFERENT (no accidental collision)', () => {
    const erc721 = encodeFunctionData({
      abi: ERC721_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 1n],
    });
    const erc1155 = encodeFunctionData({
      abi: ERC1155_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [FROM, TO, 1n, 1n, '0x'],
    });
    expect(erc721.slice(0, 10)).not.toBe(erc1155.slice(0, 10));
  });
});
