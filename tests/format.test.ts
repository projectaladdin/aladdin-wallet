// Formatter tests — number/time/chain rendering used in sign-confirm UI.
//
// These map to display-correctness paths that bias user decisions:
//   • formatWeiHex returning '—' on valid input → user sees no ETH amount
//   • formatTokenAmount falling through to humanAmount for known tokens →
//     loses "USDC" symbol, user reads raw 1e6 as "tiny" amount
//   • UNLIMITED detection failing → user signs uint256.max thinking it's bounded
//   • chainBadge returning testnet=true on mainnet → green pill on real funds

import { describe, expect, test } from 'bun:test';
import {
  formatCurrency,
  formatWeiHex,
  humanAmount,
  humanDeadline,
  formatTokenAmount,
  formatTokenContract,
  explorerAddressUrl,
  chainBadge,
  type TokenInfo,
} from '../src/lib/format';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const usdcInfo: Record<string, TokenInfo> = {
  [USDC.toLowerCase()]: { decimals: 6, symbol: 'USDC', name: 'USD Coin' },
};
const tokenAInfo: Record<string, TokenInfo> = {
  [TOKEN_A]: { decimals: 18, symbol: 'AAA', name: 'AlphaAlpha' },
};

// ─── formatWeiHex ─────────────────────────────────────────────────────────

describe('formatWeiHex', () => {
  test('undefined / empty → "0"', () => {
    expect(formatWeiHex(undefined)).toBe('0');
    expect(formatWeiHex('')).toBe('0');
  });

  test('zero hex → "0"', () => {
    expect(formatWeiHex('0x0')).toBe('0');
    expect(formatWeiHex('0x00')).toBe('0');
  });

  test('1 ETH (10^18 wei)', () => {
    expect(formatWeiHex('0xde0b6b3a7640000')).toBe('1');
  });

  test('0.5 ETH trims trailing zeros', () => {
    // 5e17 wei = 0.5 ETH
    expect(formatWeiHex('0x6f05b59d3b20000')).toBe('0.5');
  });

  test('decimal-string input also accepted', () => {
    expect(formatWeiHex('1000000000000000000')).toBe('1');
  });

  test('1 wei stays as a tiny fraction (no trailing zero loss)', () => {
    expect(formatWeiHex('0x1')).toBe('0.000000000000000001');
  });

  test('garbage falls back to dash, not throw', () => {
    expect(formatWeiHex('not-a-number')).toBe('—');
  });
});

// ─── humanAmount ──────────────────────────────────────────────────────────

describe('humanAmount', () => {
  test('UINT256_MAX → UNLIMITED', () => {
    const max = ((1n << 256n) - 1n).toString();
    expect(humanAmount(max)).toBe('UNLIMITED (uint256.max)');
  });

  test('values ≥ 1e24 get the "≥ 1e6 with 18 decimals" hint', () => {
    expect(humanAmount('1000000000000000000000000')).toMatch(/≥ 1e6 with 18 decimals/);
  });

  test('small values render as plain decimal string', () => {
    expect(humanAmount('1000')).toBe('1000');
  });

  test('garbage falls back to String(v) (no throw)', () => {
    expect(humanAmount('not-a-number')).toBe('not-a-number');
  });
});

// ─── humanDeadline ────────────────────────────────────────────────────────

describe('humanDeadline', () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);

  test('zero → "0" passthrough', () => {
    expect(humanDeadline(0)).toBe('0');
  });

  test('past timestamp shows negative tag', () => {
    const out = humanDeadline(NOW_SEC - 600);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T.*\(/);
    expect(out).toMatch(/-\d+m\)$/);
  });

  test('future timestamp shows "in" prefix', () => {
    const out = humanDeadline(NOW_SEC + 3600);
    expect(out).toMatch(/in \d+h\)$/);
  });

  test('multi-day future → days tag', () => {
    expect(humanDeadline(NOW_SEC + 5 * 86400)).toMatch(/in \d+d\)$/);
  });

  test('very-far-future timestamp gets human note (not Invalid Date)', () => {
    const farFuture = (2 ** 53).toString(); // > MAX_SAFE_INTEGER
    expect(humanDeadline(farFuture)).toMatch(/very far future/);
  });

  test('garbage falls back to passthrough', () => {
    expect(humanDeadline('not-a-number')).toBe('not-a-number');
  });
});

// ─── formatTokenAmount ────────────────────────────────────────────────────

describe('formatTokenAmount', () => {
  test('undefined token addr → falls back to humanAmount', () => {
    expect(formatTokenAmount('1000', undefined, usdcInfo)).toBe('1000');
  });

  test('unknown token (no info) → falls back to humanAmount', () => {
    expect(formatTokenAmount('1000', '0xdead', usdcInfo)).toBe('1000');
  });

  test('USDC: 1_000_000 wei = 1 USDC', () => {
    expect(formatTokenAmount('1000000', USDC, usdcInfo)).toBe('1 USDC');
  });

  test('AAA: 100 wei (< 1e-6 with 18 decimals) shows raw wei + decimals (not "0 AAA")', () => {
    const out = formatTokenAmount('100', TOKEN_A, tokenAInfo);
    expect(out).toContain('100 wei');
    expect(out).toContain('decimals=18');
    expect(out).toContain('AAA');
  });

  test('UINT256_MAX → UNLIMITED ${symbol}', () => {
    const max = ((1n << 256n) - 1n).toString();
    expect(formatTokenAmount(max, USDC, usdcInfo)).toBe('UNLIMITED USDC');
  });

  test('uses lowercase address lookup (case insensitive)', () => {
    expect(formatTokenAmount('1000000', USDC.toUpperCase(), usdcInfo)).toBe('1 USDC');
  });

  test('AAA (18 dec): 1.5e18 → "1.5 AAA"', () => {
    expect(formatTokenAmount('1500000000000000000', TOKEN_A, tokenAInfo)).toBe('1.5 AAA');
  });

  test('large round amount renders with thousand separators', () => {
    expect(formatTokenAmount('1234000000', USDC, usdcInfo)).toMatch(/1,234 USDC/);
  });

  test('non-finite formatted (very large) → BigInt-divided whole units', () => {
    // 1e30 USDC wei → 1e24 whole USDC, well past Number.MAX_SAFE_INTEGER for the fractional path
    const big = (10n ** 30n).toString();
    const out = formatTokenAmount(big, USDC, usdcInfo);
    expect(out).toMatch(/USDC$/);
  });

  test('garbage value falls back to String(v)', () => {
    expect(formatTokenAmount('not-a-number', USDC, usdcInfo)).toBe('not-a-number');
  });
});

// ─── chainBadge ───────────────────────────────────────────────────────────

describe('chainBadge', () => {
  test('Ethereum mainnet (1) is not testnet', () => {
    const b = chainBadge(1);
    expect(b.name).toMatch(/Ethereum/);
    expect(b.isTest).toBe(false);
  });

  test('Sepolia (11155111) is testnet', () => {
    const b = chainBadge(11155111);
    expect(b.name).toMatch(/Sepolia/i);
    expect(b.isTest).toBe(true);
  });

  test('Base (8453) is mainnet', () => {
    const b = chainBadge(8453);
    expect(b.isTest).toBe(false);
  });

  test('unknown chainId → neutral fallback "chain N", isTest=false', () => {
    expect(chainBadge(99999999)).toEqual({ name: 'chain 99999999', isTest: false });
  });

  test('Anvil (31337) — fallback may or may not be in viem registry, but never throws', () => {
    const b = chainBadge(31337);
    expect(typeof b.name).toBe('string');
    expect(typeof b.isTest).toBe('boolean');
  });
});

// ─── formatCurrency ───────────────────────────────────────────────────────
//
// These map to the dashboard / send / connect-confirm currency displays.
// formatCurrency is the single source of truth for "how do we render a
// USD-denominated value as either Ξ or $". A bug here either over-states
// the user's net worth (UNLIMITED-style display tricks) or hides assets.
//
// Bug-class tests we explicitly cover:
//   • ETH display when rate is null   → must fall back to USD, not show "Ξ —"
//   • ETH display when rate is 0      → div-by-zero guard, falls back to USD
//   • Negative usdValue               → render absolute (no "-$5.00")
//   • Sub-cent positive               → "<$0.01" / "Ξ <0.0001" not "$0.00"
//   • Very large (>1e9)               → comma-separated, not exponential

describe('formatCurrency', () => {
  const ETH_RATE = 2500; // approximate ETH/USD spot rate for the test fixture

  test('USD: 1234.56 → "$1,234.56"', () => {
    expect(formatCurrency(1234.56, 'usd', ETH_RATE)).toBe('$1,234.56');
  });

  test('USD: zero → "$0.00"', () => {
    expect(formatCurrency(0, 'usd', ETH_RATE)).toBe('$0.00');
  });

  test('USD: sub-cent positive → "<$0.01"', () => {
    expect(formatCurrency(0.005, 'usd', ETH_RATE)).toBe('<$0.01');
  });

  test('USD: very large value → comma-separated, not exponential', () => {
    expect(formatCurrency(1_234_567.89, 'usd', ETH_RATE)).toBe('$1,234,567.89');
  });

  test('USD: negative input rendered as absolute (no minus sign)', () => {
    expect(formatCurrency(-50, 'usd', ETH_RATE)).toBe('$50.00');
  });

  test('USD: NaN / Infinity → "$—" (placeholder, never breaks layout)', () => {
    expect(formatCurrency(NaN, 'usd', ETH_RATE)).toBe('$—');
    expect(formatCurrency(Infinity, 'usd', ETH_RATE)).toBe('$—');
  });

  test('ETH with valid rate: 2500 USD → "Ξ 1" (whole ETH)', () => {
    expect(formatCurrency(2500, 'eth', ETH_RATE)).toBe('Ξ 1');
  });

  test('ETH with valid rate: 6250 USD → "Ξ 2.5" (fractional, trailing zeros trimmed)', () => {
    expect(formatCurrency(6250, 'eth', ETH_RATE)).toBe('Ξ 2.5');
  });

  test('ETH with valid rate: sub-ETH value keeps up to 4 dp', () => {
    // 1 / 2500 = 0.0004
    expect(formatCurrency(1, 'eth', ETH_RATE)).toBe('Ξ 0.0004');
  });

  test('ETH with valid rate: caps at 4 decimal places', () => {
    // 3 / 2500 = 0.0012
    expect(formatCurrency(3, 'eth', ETH_RATE)).toBe('Ξ 0.0012');
  });

  test('ETH with valid rate: large value comma-separated', () => {
    // 25,000,000 / 2500 = 10,000
    expect(formatCurrency(25_000_000, 'eth', ETH_RATE)).toBe('Ξ 10,000');
  });

  test('ETH with valid rate: zero USD → "Ξ 0"', () => {
    expect(formatCurrency(0, 'eth', ETH_RATE)).toBe('Ξ 0');
  });

  test('ETH with valid rate: sub-Ξ0.0001 → "Ξ <0.0001"', () => {
    // 0.1 / 2500 = 0.00004 → below 0.0001
    expect(formatCurrency(0.1, 'eth', ETH_RATE)).toBe('Ξ <0.0001');
  });

  test('ETH with null rate → falls back to USD format (no "Ξ —")', () => {
    expect(formatCurrency(50, 'eth', null)).toBe('$50.00');
  });

  test('ETH with rate=0 → falls back to USD (no Infinity)', () => {
    expect(formatCurrency(50, 'eth', 0)).toBe('$50.00');
  });

  test('ETH with negative rate → falls back to USD (defensive)', () => {
    expect(formatCurrency(50, 'eth', -1)).toBe('$50.00');
  });

  test('ETH: negative usdValue rendered as absolute', () => {
    // abs(-2500) / 2500 = 1 → "Ξ 1"
    expect(formatCurrency(-2500, 'eth', ETH_RATE)).toBe('Ξ 1');
  });

  test('ETH: NaN input → "Ξ —"', () => {
    expect(formatCurrency(NaN, 'eth', ETH_RATE)).toBe('Ξ —');
  });
});

// ─── formatTokenContract ─────────────────────────────────────────────────
// Pins the symbol-prefix UX added so the user sees "USDC · 0xA0b8…eB48"
// in the sign-confirm `token:` row instead of the raw hex contract.
// The check is two-pronged:
//   - lookup hit  → "<SYMBOL> · <truncated addr>" shape
//   - lookup miss → returns the raw address untouched (don't lie about a
//                   contract the wallet hasn't read metadata for yet)

describe('formatTokenContract', () => {
  test('known token → "SYMBOL · 0x….addr"', () => {
    const s = formatTokenContract(USDC, usdcInfo);
    expect(s).toContain('USDC');
    expect(s).toContain(USDC.slice(0, 6));
    expect(s).toContain(USDC.slice(-4));
  });

  test('case-insensitive address lookup', () => {
    const lower = USDC.toLowerCase();
    const upper = USDC.toUpperCase().replace('X', 'x'); // keep `0x`
    expect(formatTokenContract(lower, usdcInfo)).toContain('USDC');
    expect(formatTokenContract(upper, usdcInfo)).toContain('USDC');
  });

  test('unknown token → raw address returned untouched', () => {
    const result = formatTokenContract(TOKEN_A, usdcInfo);
    expect(result).toBe(TOKEN_A);
    // Negative: the result MUST NOT pretend the unknown contract has
    // a fabricated symbol.
    expect(result).not.toContain('·');
  });

  test('empty info map → raw address', () => {
    expect(formatTokenContract(USDC, {})).toBe(USDC);
  });
});

// ─── explorerAddressUrl ───────────────────────────────────────────────────
// The contract underpinning every address link in sign-confirm. Two
// paths: viem-registry-known chains → Etherscan-style explorer;
// unknown chains → Sourcify universal lookup. The fallback MUST exist
// for every numeric chainId so the link is never broken.

describe('explorerAddressUrl', () => {
  test('mainnet → etherscan /address/<addr>', () => {
    const url = explorerAddressUrl(1, USDC);
    expect(url).toContain('etherscan.io');
    expect(url).toContain(`/address/${USDC}`);
  });

  test('sepolia → sepolia.etherscan /address/<addr>', () => {
    const url = explorerAddressUrl(11155111, USDC);
    expect(url).toContain('sepolia.etherscan.io');
    expect(url).toContain(`/address/${USDC}`);
  });

  test('unknown chainId → sourcify universal lookup (never broken)', () => {
    const url = explorerAddressUrl(987654, USDC);
    expect(url).toContain('sourcify.dev');
    expect(url).toContain(USDC);
  });

  test('always returns a non-empty string (no null/undefined)', () => {
    // Defensive: every numeric chainId must produce a clickable URL.
    // A broken link would be worse UX than no link at all, and the
    // popup unconditionally wraps the address in <a href={...}>.
    for (const cid of [1, 11155111, 137, 8453, 42161, 0, -1, 999999]) {
      const url = explorerAddressUrl(cid, USDC);
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
      expect(url).toContain(USDC);
    }
  });
});
