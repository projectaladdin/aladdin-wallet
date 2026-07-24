// Pin the activity-row label rules. Each ActivityKind has a different
// shape of decode + format; this keeps that consistent across future
// edits.

import { describe, it, expect } from 'bun:test';
import { formatActivityLabel, type TokenInfoMap } from '../src/lib/activity-format';
import type { ActivityEntry } from '../src/core/activity';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TOKEN_INFO: TokenInfoMap = {
  [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
};

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    hash: '0x' + 'a'.repeat(64),
    chainId: 1,
    account: '0x' + 'b'.repeat(40),
    kind: 'send',
    to: ALICE,
    value: '0',
    addedAt: Date.now(),
    status: 'success',
    ...over,
  };
}

describe('formatActivityLabel', () => {
  it('native send → "sent 0.5 ETH" + recipient detail', () => {
    const r = formatActivityLabel(
      entry({ kind: 'send', value: '500000000000000000' /* 0.5 ETH wei */, data: null }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('sent 0.5 ETH');
    expect(r.detail).toContain('→');
    expect(r.detail).toContain(ALICE.slice(0, 6));
  });

  it('native send with chain native symbol other than ETH', () => {
    const r = formatActivityLabel(
      entry({ kind: 'send', value: '2000000000000000000', data: null }),
      {},
      'BNB',
    );
    expect(r.verb).toBe('sent 2 BNB');
  });

  it('erc20 transfer decodes amount + symbol from tokenInfo map', () => {
    // transfer(0x7099..., 1234.56e6) calldata.
    // 0xa9059cbb selector + 32B address + 32B amount
    const amountHex = (BigInt(1_234_560_000)).toString(16).padStart(64, '0');
    const data = '0xa9059cbb'
      + '0'.repeat(24) + ALICE.slice(2).toLowerCase()
      + amountHex;
    const r = formatActivityLabel(
      entry({ kind: 'erc20-transfer', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('sent 1,234.56 USDC');
    expect(r.detail).toContain(ALICE.slice(0, 6));
  });

  it('erc20 approve with uint256.max → "approved ∞ USDC to ..."', () => {
    const MAX = ((1n << 256n) - 1n).toString(16);
    const data = '0x095ea7b3'
      + '0'.repeat(24) + BOB.slice(2)
      + MAX;
    const r = formatActivityLabel(
      entry({ kind: 'approve', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('approved ∞');
    expect(r.detail.toLowerCase()).toContain('to');
    expect(r.detail.toLowerCase()).toContain(BOB.slice(0, 6).toLowerCase());
  });

  it('erc20 approve with Permit2 sentinel (uint160.max) → "approved ∞"', () => {
    const PERMIT2 = ((1n << 160n) - 1n).toString(16).padStart(64, '0');
    const data = '0x095ea7b3'
      + '0'.repeat(24) + BOB.slice(2)
      + PERMIT2;
    const r = formatActivityLabel(
      entry({ kind: 'approve', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('approved ∞');
  });

  it('erc20 approve with finite amount → "approved 100 USDC"', () => {
    const amount = (100n * 10n ** 6n).toString(16).padStart(64, '0');
    const data = '0x095ea7b3'
      + '0'.repeat(24) + BOB.slice(2)
      + amount;
    const r = formatActivityLabel(
      entry({ kind: 'approve', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('approved 100 USDC');
  });

  it('setApprovalForAll(operator, true) → "approved all <symbol>"', () => {
    // setApprovalForAll(operator, true) selector 0xa22cb465
    const data = '0xa22cb465'
      + '0'.repeat(24) + BOB.slice(2)
      + '0'.repeat(63) + '1';
    const r = formatActivityLabel(
      entry({ kind: 'approve', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('approved all USDC');
  });

  it('setApprovalForAll(operator, false) → "revoked <symbol> approval"', () => {
    const data = '0xa22cb465'
      + '0'.repeat(24) + BOB.slice(2)
      + '0'.repeat(64);
    const r = formatActivityLabel(
      entry({ kind: 'approve', to: USDC, data, value: '0' }),
      TOKEN_INFO,
      'ETH',
    );
    expect(r.verb).toBe('revoked USDC approval');
  });

  it('ERC-721 nft-transfer → "transferred NFT #<id>"', () => {
    // safeTransferFrom(from, to, tokenId) selector 0x42842e0e
    const tokenId = (42n).toString(16).padStart(64, '0');
    const data = '0x42842e0e'
      + '0'.repeat(24) + ALICE.slice(2)
      + '0'.repeat(24) + BOB.slice(2)
      + tokenId;
    const r = formatActivityLabel(
      entry({ kind: 'nft-transfer', to: USDC, data, value: '0' }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('transferred NFT #42');
    expect(r.detail.toLowerCase()).toContain(BOB.slice(0, 6).toLowerCase());
  });

  it('ERC-1155 nft-transfer → "transferred <count>× #<id>"', () => {
    // safeTransferFrom(from, to, id, amount, bytes) selector 0xf242432a
    const id = (7n).toString(16).padStart(64, '0');
    const amount = (5n).toString(16).padStart(64, '0');
    const data = '0xf242432a'
      + '0'.repeat(24) + ALICE.slice(2)
      + '0'.repeat(24) + BOB.slice(2)
      + id + amount
      // bytes offset + length 0
      + (160n).toString(16).padStart(64, '0')
      + '0'.repeat(64);
    const r = formatActivityLabel(
      entry({ kind: 'nft-transfer', to: USDC, data, value: '0' }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('transferred 5× #7');
  });

  it('7702 → "7702 delegation" with target detail', () => {
    const r = formatActivityLabel(
      entry({ kind: '7702', to: BOB }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('7702 delegation');
    expect(r.detail).toContain(BOB.slice(0, 6));
  });

  it('deploy → "deployed contract"', () => {
    const r = formatActivityLabel(
      entry({ kind: 'deploy', to: '' }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('deployed contract');
  });

  it('unknown calldata falls back to function name when decodeable', () => {
    // claim() — selector 0x4e71d92d, in SELECTOR_TABLE_ABI.
    const r = formatActivityLabel(
      entry({ kind: 'contract-call', to: BOB, data: '0x4e71d92d' }),
      {},
      'ETH',
    );
    expect(r.verb).toBe('claim');
  });
});
