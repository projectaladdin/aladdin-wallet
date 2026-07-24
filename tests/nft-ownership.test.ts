// Pin behavior of verifyNftOwnership's three-way result. The bug we're
// guarding: user reported `safeTransferFrom` reverting with "wrong
// owner" after the wallet had silently let them add a non-existent
// tokenId. ownerOf(id) reverts with various phrasings depending on
// OZ version + contract implementation — all of which need to map to
// `{ kind: 'not-minted' }` so the add-NFT flow blocks early instead
// of letting the user try to send something that doesn't exist.

import { describe, it, expect } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';
import { verifyNftOwnership, type OwnershipResult } from '../src/core/erc721';
import type { Address, Chain } from 'viem';

installChromeStub();

// We don't need a real RPC for these tests — viem's createPublicClient
// only hits the wire on readContract(), and we're driving that via a
// stubbed `fetch` that returns canned JSON-RPC responses. Sepolia is
// chosen arbitrarily; the chain object only contributes the `id` to
// viem's request signing, not the network.
const SEPOLIA: Chain = {
  id: 11155111,
  name: 'Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:0'] } },
};
const RPC = 'http://127.0.0.1:0';
const CONTRACT = '0x8e6c0772a66cfed2726d8c532923914bf41abecc' as Address;
const OWNER = '0x4221aC836B77f4dF0C1Fc78987d480c1f0968442' as Address;
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

/** Stub global fetch with a JSON-RPC handler that returns whatever the
 *  test wants for the next call. Returns a cleanup function. */
function stubRpc(handler: (body: { method: string; params: unknown[] }) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { method: string; params: unknown[] };
    const result = handler(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

/** Stub global fetch to return a JSON-RPC error response — used to
 *  simulate `eth_call` revert. The Solidity revert string is ABI-
 *  encoded as `Error(string)` selector `0x08c379a0` followed by the
 *  string. viem decodes this back into `e.message`. */
function stubRpcRevert(reasonText: string): () => void {
  // ABI-encode Error(string): selector 4B + offset 32B + length 32B + padded bytes.
  const lengthHex = reasonText.length.toString(16).padStart(64, '0');
  const payloadHex = Buffer.from(reasonText, 'utf8').toString('hex')
    .padEnd(Math.ceil(reasonText.length / 32) * 64, '0');
  const data = '0x08c379a0' + '0'.repeat(62) + '20' + lengthHex + payloadHex;
  return stubRpc(() => {
    throw Object.assign(new Error('reverted'), {
      cause: { code: 3, message: `execution reverted: ${reasonText}`, data },
    });
  });
}

describe('verifyNftOwnership', () => {
  it('ERC-721 ownerOf returns the wallet → owns', async () => {
    // viem encodes ownerOf return as 32-byte left-padded address.
    const restore = stubRpc(() => '0x' + '0'.repeat(24) + OWNER.slice(2).toLowerCase());
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 1n, 'ERC721', OWNER);
      expect(r.kind).toBe('owns');
    } finally { restore(); }
  });

  it('ERC-721 ownerOf returns a different address → wrong-owner with `actual`', async () => {
    const restore = stubRpc(() => '0x' + '0'.repeat(24) + OTHER.slice(2).toLowerCase());
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 1n, 'ERC721', OWNER);
      expect(r.kind).toBe('wrong-owner');
      expect((r as Extract<OwnershipResult, { kind: 'wrong-owner' }>).actual?.toLowerCase()).toBe(OTHER.toLowerCase());
    } finally { restore(); }
  });

  it.each([
    'not minted',
    'ERC721: owner query for nonexistent token',
    'ERC721NonexistentToken',
    'URI query for nonexistent token',
    'invalid token id',
    'token does not exist',
  ])('classifies revert reason "%s" as not-minted', async (reason) => {
    const restore = stubRpcRevert(reason);
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 999n, 'ERC721', OWNER);
      expect(r.kind).toBe('not-minted');
    } finally { restore(); }
  });

  it('unknown revert reason → rpc-unknown (do not falsely refuse add)', async () => {
    const restore = stubRpcRevert('some bespoke error we have not seen before');
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 1n, 'ERC721', OWNER);
      expect(r.kind).toBe('rpc-unknown');
    } finally { restore(); }
  });

  it('ERC-1155 balanceOf(0) → wrong-owner (positive evidence of zero balance)', async () => {
    const restore = stubRpc(() => '0x' + '0'.repeat(64));
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 7n, 'ERC1155', OWNER);
      expect(r.kind).toBe('wrong-owner');
    } finally { restore(); }
  });

  it('ERC-1155 balanceOf > 0 → owns', async () => {
    const restore = stubRpc(() => '0x' + '0'.repeat(62) + '05');  // 5
    try {
      const r = await verifyNftOwnership(SEPOLIA, RPC, CONTRACT, 7n, 'ERC1155', OWNER);
      expect(r.kind).toBe('owns');
    } finally { restore(); }
  });
});
