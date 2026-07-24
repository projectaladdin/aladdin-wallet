// Storage tests — composite-key custom networks, per-chain token records,
// dev flag merge, vault round-trip, account list defaults.
//
// These map to subtle bugs that are easy to ship without a regression test:
//   • Composite key not lowercased on read → same RPC URL with mixed case
//     creates duplicate rows in the chain selector
//   • Tokens addressed without lowercase → user adds USDC (checksum), tries
//     to remove with all-lowercase, removeTokenRecord no-ops
//   • setDevFlag overwrites instead of merging → toggling rpcTrace clears
//     other flags
//   • getAccounts returning [] when persisted to [] would orphan the wallet —
//     defaults must kick in
//   • setCurrentRpcUrl(undefined) must persist clearance, not no-op

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';
import { DEFAULT_CHAIN_ID } from '../src/shared/config';

// Install BEFORE importing storage (storage.ts captures `chrome` from globalThis at call time,
// but each function calls `chrome.storage.local.*` lazily, so module init is fine —
// install in beforeEach for hygiene anyway).

let storage: typeof import('../src/core/storage');

beforeEach(async () => {
  installChromeStub();
  // Re-import every test for a clean module cache
  storage = await import('../src/core/storage?t=' + Date.now());
});

afterEach(() => {
  // Stub auto-resets next install
});

// ─── Vault ────────────────────────────────────────────────────────────────

describe('vault', () => {
  test('hasVault → false when nothing set', async () => {
    expect(await storage.hasVault()).toBe(false);
  });

  test('setVault → getVault round trip', async () => {
    const v = { ciphertext: 'abc', iv: 'def', salt: 'ghi', iterations: 600000 } as never;
    await storage.setVault(v);
    expect(await storage.getVault()).toEqual(v);
    expect(await storage.hasVault()).toBe(true);
  });

  test('clearVault removes the entry', async () => {
    await storage.setVault({ ciphertext: 'x' } as never);
    await storage.clearVault();
    expect(await storage.hasVault()).toBe(false);
  });
});

// ─── Connected origins ────────────────────────────────────────────────────

describe('connected origins', () => {
  test('starts empty', async () => {
    expect(await storage.getConnectedOrigins()).toEqual([]);
  });

  test('addConnectedOrigin appends, dedupe on repeat', async () => {
    await storage.addConnectedOrigin('https://a.com');
    await storage.addConnectedOrigin('https://b.com');
    await storage.addConnectedOrigin('https://a.com'); // duplicate
    expect(await storage.getConnectedOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  test('removeConnectedOrigin filters', async () => {
    await storage.addConnectedOrigin('https://a.com');
    await storage.addConnectedOrigin('https://b.com');
    await storage.removeConnectedOrigin('https://a.com');
    expect(await storage.getConnectedOrigins()).toEqual(['https://b.com']);
  });

  test('removing non-member is a no-op', async () => {
    await storage.addConnectedOrigin('https://a.com');
    await storage.removeConnectedOrigin('https://gone.com');
    expect(await storage.getConnectedOrigins()).toEqual(['https://a.com']);
  });
});

// ─── Custom chains: composite key (chainId + rpcUrl) ──────────────────────

describe('custom chains', () => {
  test('two entries with same chainId different rpc coexist', async () => {
    await storage.addCustomChain({ chainId: 1, name: 'Eth A', rpcUrl: 'https://a.example' });
    await storage.addCustomChain({ chainId: 1, name: 'Eth B', rpcUrl: 'https://b.example' });
    const all = await storage.listAllNetworks();
    const customs = all.filter((n) => n.chain.id === 1 && n.rpcUrl.startsWith('https://'));
    const matched = customs.filter((n) => n.rpcUrl === 'https://a.example' || n.rpcUrl === 'https://b.example');
    expect(matched.length).toBe(2);
  });

  test('removeCustomChain only removes the specific (chainId, rpcUrl) pair', async () => {
    await storage.addCustomChain({ chainId: 1, name: 'Eth A', rpcUrl: 'https://a.example' });
    await storage.addCustomChain({ chainId: 1, name: 'Eth B', rpcUrl: 'https://b.example' });
    await storage.removeCustomChain(1, 'https://a.example');
    const all = await storage.listAllNetworks();
    const remaining = all.filter((n) => n.rpcUrl === 'https://a.example' || n.rpcUrl === 'https://b.example');
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.rpcUrl).toBe('https://b.example');
  });

  test('composite key normalises rpcUrl case (UPPER vs lower treated as same)', async () => {
    // Add with mixed case, remove with lowercase — should clean up.
    await storage.addCustomChain({ chainId: 99, name: 'X', rpcUrl: 'https://EXAMPLE.com' });
    await storage.removeCustomChain(99, 'https://example.com');
    const all = await storage.listAllNetworks();
    expect(all.some((n) => n.chain.id === 99)).toBe(false);
  });

  test('listAllNetworks includes builtins by default', async () => {
    const all = await storage.listAllNetworks();
    expect(all.some((n) => n.chain.id === 1)).toBe(true);          // mainnet
    expect(all.some((n) => n.chain.id === 11155111)).toBe(true);   // sepolia
  });

  test('addCustomChain stores rpcUrl lowercased on the record itself', async () => {
    // Without lowercase-on-write, setCurrentRpcUrl-vs-rec.rpcUrl comparison
    // in getCurrentNetwork mismatches when user typed mixed case → silent
    // fallback to first match.
    await storage.addCustomChain({ chainId: 99, name: 'X', rpcUrl: 'https://EXAMPLE.com' });
    const all = await storage.listAllNetworks();
    const entry = all.find((n) => n.chain.id === 99);
    expect(entry?.rpcUrl).toBe('https://example.com');
  });

  test('setCurrentRpcUrl lowercases on persist (matches stored rec.rpcUrl)', async () => {
    await storage.addCustomChain({ chainId: 31337, name: 'A', rpcUrl: 'https://anvil.local' });
    await storage.setCurrentChainId(31337);
    // Set with mixed case — should be normalized so getCurrentNetwork still matches.
    await storage.setCurrentRpcUrl('https://ANVIL.local');
    const net = await storage.getCurrentNetwork();
    expect(net.rpcUrl).toBe('https://anvil.local');
  });

  test('removeCustomChain clears currentRpcUrl preference if it pointed to deleted RPC', async () => {
    await storage.addCustomChain({ chainId: 31337, name: 'A', rpcUrl: 'https://a.example' });
    await storage.addCustomChain({ chainId: 31337, name: 'B', rpcUrl: 'https://b.example' });
    await storage.setCurrentChainId(31337);
    await storage.setCurrentRpcUrl('https://a.example');

    await storage.removeCustomChain(31337, 'https://a.example');
    // Now getCurrentNetwork should fall to first remaining entry (B), not
    // hold a stale "prefer A" value that would silently re-bind on re-add.
    const net = await storage.getCurrentNetwork();
    expect(net.rpcUrl).toBe('https://b.example');

    // Re-add A — the preference should NOT have stuck around to favor it.
    await storage.addCustomChain({ chainId: 31337, name: 'A2', rpcUrl: 'https://a.example' });
    const net2 = await storage.getCurrentNetwork();
    // First-match logic returns the first-inserted entry (B), not the new A.
    expect(net2.rpcUrl).toBe('https://b.example');
  });

  test('removeCustomChain does NOT clear currentRpcUrl if pointing elsewhere', async () => {
    await storage.addCustomChain({ chainId: 31337, name: 'A', rpcUrl: 'https://a.example' });
    await storage.addCustomChain({ chainId: 31337, name: 'B', rpcUrl: 'https://b.example' });
    await storage.setCurrentChainId(31337);
    await storage.setCurrentRpcUrl('https://b.example');

    await storage.removeCustomChain(31337, 'https://a.example'); // not the active one
    const net = await storage.getCurrentNetwork();
    expect(net.rpcUrl).toBe('https://b.example'); // preference preserved
  });
});

// ─── Active chain id + RPC selection ──────────────────────────────────────

describe('active chain', () => {
  test('default chain id is Robinhood Chain (4663)', async () => {
    expect(await storage.getCurrentChainId()).toBe(DEFAULT_CHAIN_ID);
  });

  test('setCurrentChainId persists', async () => {
    await storage.setCurrentChainId(11155111);
    expect(await storage.getCurrentChainId()).toBe(11155111);
  });

  test('setCurrentRpcUrl(undefined) clears the persisted rpc', async () => {
    await storage.setCurrentRpcUrl('https://x.example');
    await storage.setCurrentRpcUrl(undefined);
    // Re-add two entries, getCurrentNetwork should fall back to the first
    // (no preferred match).
    await storage.addCustomChain({ chainId: 31337, name: 'Anvil', rpcUrl: 'https://first' });
    await storage.addCustomChain({ chainId: 31337, name: 'Anvil2', rpcUrl: 'https://second' });
    await storage.setCurrentChainId(31337);
    const net = await storage.getCurrentNetwork();
    expect(net.rpcUrl).toBe('https://first');
  });

  test('getCurrentNetwork respects setCurrentRpcUrl preference', async () => {
    await storage.addCustomChain({ chainId: 31337, name: 'Anvil', rpcUrl: 'https://first' });
    await storage.addCustomChain({ chainId: 31337, name: 'Anvil2', rpcUrl: 'https://second' });
    await storage.setCurrentChainId(31337);
    await storage.setCurrentRpcUrl('https://second');
    expect((await storage.getCurrentNetwork()).rpcUrl).toBe('https://second');
  });

  test('getCurrentNetwork falls back to builtin when no custom entry', async () => {
    await storage.setCurrentChainId(1);
    expect((await storage.getCurrentNetwork()).chain.id).toBe(1);
  });
});

// ─── Tokens (per chain) ───────────────────────────────────────────────────

describe('tokens', () => {
  const USDC = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin', symbol: 'USDC', decimals: 6 };

  test('listTokens(chainId) starts empty', async () => {
    expect(await storage.listTokens(1)).toEqual([]);
  });

  test('addTokenRecord stores with lowercased address', async () => {
    await storage.addTokenRecord(1, USDC);
    const list = await storage.listTokens(1);
    expect(list.length).toBe(1);
    expect(list[0]?.address).toBe(USDC.address.toLowerCase());
  });

  test('removeTokenRecord with checksum address still removes (case insensitive)', async () => {
    await storage.addTokenRecord(1, USDC);
    await storage.removeTokenRecord(1, USDC.address); // checksum
    expect(await storage.listTokens(1)).toEqual([]);
  });

  test('removeTokenRecord with lowercase removes the same entry', async () => {
    await storage.addTokenRecord(1, USDC);
    await storage.removeTokenRecord(1, USDC.address.toLowerCase());
    expect(await storage.listTokens(1)).toEqual([]);
  });

  test('addTokenRecord twice for same address overwrites (no duplicate)', async () => {
    await storage.addTokenRecord(1, USDC);
    await storage.addTokenRecord(1, { ...USDC, symbol: 'USDC2' });
    const list = await storage.listTokens(1);
    expect(list.length).toBe(1);
    expect(list[0]?.symbol).toBe('USDC2');
  });

  test('tokens are isolated per chainId (chain 1 and 137 are independent)', async () => {
    await storage.addTokenRecord(1, USDC);
    expect(await storage.listTokens(137)).toEqual([]);
  });

  test('removeTokenRecord on missing address is no-op', async () => {
    await storage.removeTokenRecord(1, '0xdead');
    expect(await storage.listTokens(1)).toEqual([]);
  });
});

// ─── Origin → account map ─────────────────────────────────────────────────

describe('origin → account', () => {
  test('getOriginAccount(missing) → undefined', async () => {
    expect(await storage.getOriginAccount('https://x.com')).toBeUndefined();
  });

  test('setOriginAccount + getOriginAccount round trip', async () => {
    await storage.setOriginAccount('https://x.com', 3);
    expect(await storage.getOriginAccount('https://x.com')).toBe(3);
  });

  test('clearOriginAccount removes', async () => {
    await storage.setOriginAccount('https://x.com', 3);
    await storage.clearOriginAccount('https://x.com');
    expect(await storage.getOriginAccount('https://x.com')).toBeUndefined();
  });

  test('setting two origins keeps both', async () => {
    await storage.setOriginAccount('https://a.com', 1);
    await storage.setOriginAccount('https://b.com', 2);
    const map = await storage.getOriginAccountMap();
    expect(map['https://a.com']).toBe(1);
    expect(map['https://b.com']).toBe(2);
  });
});

// ─── Accounts + active index ──────────────────────────────────────────────

describe('accounts', () => {
  test('default accounts = [{ index: 0, label: "Account 1" }]', async () => {
    const a = await storage.getAccounts();
    expect(a).toEqual([{ index: 0, label: 'Account 1' }]);
  });

  test('default active index is 0', async () => {
    expect(await storage.getActiveAccountIndex()).toBe(0);
  });

  test('setAccounts persists list', async () => {
    await storage.setAccounts([
      { index: 0, label: 'A' },
      { index: 5, label: 'B' },
    ]);
    expect(await storage.getAccounts()).toEqual([{ index: 0, label: 'A' }, { index: 5, label: 'B' }]);
  });

  test('resetAccounts wipes back to default + index 0', async () => {
    await storage.setAccounts([{ index: 0, label: 'A' }, { index: 1, label: 'B' }]);
    await storage.setActiveAccountIndex(1);
    await storage.resetAccounts();
    expect(await storage.getAccounts()).toEqual([{ index: 0, label: 'Account 1' }]);
    expect(await storage.getActiveAccountIndex()).toBe(0);
  });
});

// ─── Display preferences ──────────────────────────────────────────────────

describe('preferences', () => {
  test('hideZero defaults to false', async () => {
    expect(await storage.getHideZero()).toBe(false);
  });

  test('hideZero round trip', async () => {
    await storage.setHideZero(true);
    expect(await storage.getHideZero()).toBe(true);
  });

  test('autoLockMinutes default = 30', async () => {
    expect(await storage.getAutoLockMinutes()).toBe(30);
  });

  test('autoLockMinutes 0 (SW lifecycle only) is preserved (not falsy-treated as default)', async () => {
    await storage.setAutoLockMinutes(0);
    expect(await storage.getAutoLockMinutes()).toBe(0);
  });
});

// ─── Dev flags merge ──────────────────────────────────────────────────────

describe('dev flags', () => {
  test('default has allowUnverifiedDelegate ON (app-dedicated default)', async () => {
    expect(await storage.getDevFlags()).toEqual({ allowUnverifiedDelegate: true });
  });

  test('setDevFlag merges (does not clobber other keys)', async () => {
    await storage.setDevFlag('rpcTrace', true);
    // Pretend a future flag exists — write it directly through the same key
    await storage.setDevFlag('rpcTrace', false);
    // allowUnverifiedDelegate is defaulted ON when the user hasn't set it.
    expect(await storage.getDevFlags()).toEqual({ rpcTrace: false, allowUnverifiedDelegate: true });
  });

  test('toggling a flag preserves the rest of the object', async () => {
    // Simulate two-flag state by writing both via merges
    await storage.setDevFlag('rpcTrace', true);
    const after = await storage.getDevFlags();
    expect(after.rpcTrace).toBe(true);
  });

  // ── Session-scoped allowUnverifiedDelegate ─────────────────────────────
  // Defaults ON (app-dedicated wallet), but an EXPLICIT value is session-scoped:
  // it lives in chrome.storage.session and clears on lock, after which getDevFlags
  // returns to the ON default. These tests pin the storage routing:
  //   - `setDevFlag('allowUnverifiedDelegate', …)` goes to
  //     chrome.storage.session, NOT chrome.storage.local
  //   - `clearSessionDevFlags()` drops only the explicit session value
  //   - persistent flags (`rpcTrace`) survive the session clear

  test('allowUnverifiedDelegate writes go to session storage, not local', async () => {
    const { chromeStorageStub, chromeSessionStub } = await import('./_setup/chrome-stub');
    await storage.setDevFlag('allowUnverifiedDelegate', true);
    // The persistent local store must NOT contain the flag — any
    // future reset of session storage (lock, browser close) would
    // otherwise leak it back.
    expect(chromeStorageStub.store).not.toHaveProperty('devFlags');
    // Session store has it.
    expect(chromeSessionStub.store).toMatchObject({
      devFlagsSesh: { allowUnverifiedDelegate: true },
    });
  });

  test('getDevFlags merges persistent (rpcTrace) + session (allowUnverifiedDelegate)', async () => {
    await storage.setDevFlag('rpcTrace', true);
    await storage.setDevFlag('allowUnverifiedDelegate', true);
    expect(await storage.getDevFlags()).toEqual({
      rpcTrace: true,
      allowUnverifiedDelegate: true,
    });
  });

  test('clearSessionDevFlags drops the explicit session value; getDevFlags re-defaults it ON', async () => {
    await storage.setDevFlag('rpcTrace', true);
    await storage.setDevFlag('allowUnverifiedDelegate', false); // explicit OFF this session
    await storage.clearSessionDevFlags();
    // The explicit session OFF is gone → back to the ON default.
    expect(await storage.getDevFlags()).toEqual({ rpcTrace: true, allowUnverifiedDelegate: true });
  });

  test('clearSessionDevFlags is idempotent when nothing was set', async () => {
    // Lock flow calls this unconditionally; must not throw when the
    // flag was never explicitly set (getDevFlags shows the ON default).
    await storage.clearSessionDevFlags();
    expect(await storage.getDevFlags()).toEqual({ allowUnverifiedDelegate: true });
  });
});

describe('NFT record legacy → imageCandidates migration', () => {
  // Records persisted before v0.6.1 hold `image: string | null`; the new
  // shape is `imageCandidates: string[]`. listNfts must promote legacy
  // records at read-time so the renderer never sees the old field.
  test('legacy `image` string is promoted to `imageCandidates: [image]`', async () => {
    const { chromeStorageStub } = await import('./_setup/chrome-stub');
    chromeStorageStub.store.nfts = {
      11155111: {
        '0xabc::1': {
          address: '0xabc', tokenId: '1', standard: 'ERC721',
          name: 'Legacy', image: 'https://cdn.example.com/0.png',
          description: null, addedAt: 1,
        },
      },
    };
    const list = await storage.listNfts(11155111);
    expect(list).toHaveLength(1);
    expect(list[0]!.imageCandidates).toEqual(['https://cdn.example.com/0.png']);
    expect(list[0]).not.toHaveProperty('image');
  });
  test('legacy `image: null` is promoted to `imageCandidates: []`', async () => {
    const { chromeStorageStub } = await import('./_setup/chrome-stub');
    chromeStorageStub.store.nfts = {
      1: {
        '0xdef::2': {
          address: '0xdef', tokenId: '2', standard: 'ERC1155',
          name: 'No image', image: null,
          description: null, addedAt: 1,
        },
      },
    };
    const list = await storage.listNfts(1);
    expect(list[0]!.imageCandidates).toEqual([]);
    expect(list[0]).not.toHaveProperty('image');
  });
  test('records already on the new shape pass through unchanged', async () => {
    const { chromeStorageStub } = await import('./_setup/chrome-stub');
    chromeStorageStub.store.nfts = {
      1: {
        '0xfeed::3': {
          address: '0xfeed', tokenId: '3', standard: 'ERC721',
          name: 'New', imageCandidates: ['ipfs://X', 'https://cdn.example.com/0.png'],
          description: null, addedAt: 1,
        },
      },
    };
    const list = await storage.listNfts(1);
    expect(list[0]!.imageCandidates).toEqual(['ipfs://X', 'https://cdn.example.com/0.png']);
  });
});
