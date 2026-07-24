// Pure number / time / chain formatters. Extracted from popup.tsx so unit
// tests don't need to mount React or stub chrome.

import type { Chain } from 'viem/chains';
import { VIEM_CHAIN_REGISTRY } from '../shared/config';

/** Token metadata fetched from `read-token-info` (decimals + symbol + name). */
export type TokenInfo = { decimals: number; symbol: string; name: string };

/** Truncate an EVM address (or any hex string) to `0xXXXX…YYYY` for
 *  compact UI rendering. Default head/tail = 6/4 means "0x + 4 chars
 *  + … + last 4 chars" — same shape as Etherscan / MetaMask. Pass-
 *  through when too short to truncate. Lives here because half a
 *  dozen popup screens (and the activity formatter) were reinventing
 *  the same one-liner. */
export function truncateAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Format wei (hex `0x...` or decimal string) into a human-readable ETH
 *  amount. Returns `'0'` for missing / zero, `'—'` for unparseable input.
 *  Trims trailing fraction zeros — `0.5 ETH` instead of `0.500000000000000000`. */
export function formatWeiHex(v: string | undefined): string {
  if (!v) return '0';
  try {
    const wei = BigInt(v);
    if (wei === 0n) return '0';
    const ETH = 10n ** 18n;
    const whole = wei / ETH;
    const frac = wei % ETH;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  } catch {
    // Should be unreachable — background.validateSendTransactionParams
    // rejects malformed values with -32602 before the popup ever opens.
    // Fallback to a neutral dash rather than echoing the bad input.
    return '—';
  }
}

/** Approximate human format for a uint256 amount when token decimals are
 *  unknown. Surfaces `UINT256_MAX` (== "UNLIMITED") and very large numbers
 *  with a "≥ 1e6 with 18 decimals" hint. */
export function humanAmount(v: string | number): string {
  try {
    const big = BigInt(v as string);
    const max = (1n << 256n) - 1n;
    if (big === max) return 'UNLIMITED (uint256.max)';
    if (big >= 10n ** 24n) return `${big.toString()} (≥ 1e6 with 18 decimals)`;
    return big.toString();
  } catch {
    return String(v);
  }
}

/** Format a unix-second deadline into ISO + relative tag (e.g. "in 5h",
 *  "-3d" for past). Returns the raw value as fallback when un-parseable. */
export function humanDeadline(v: string | number): string {
  try {
    const sec = Number(BigInt(v as string));
    if (sec === 0 || !Number.isFinite(sec)) return String(v);
    const max = 2 ** 53 - 1;
    if (sec > max) return `${v} (very far future)`;
    const d = new Date(sec * 1000);
    const now = Date.now();
    const dt = d.getTime() - now;
    const mins = Math.round(dt / 60000);
    const tag =
      Math.abs(mins) < 60       ? `${mins}m`
      : Math.abs(mins) < 60 * 24 ? `${Math.round(mins / 60)}h`
                                 : `${Math.round(mins / 60 / 24)}d`;
    return `${d.toISOString()} (${dt > 0 ? 'in' : ''} ${tag})`;
  } catch {
    return String(v);
  }
}

/** Render a token contract address with its symbol when known:
 *    `USDC · 0xA0b8…eB48`
 *  Used in sign-confirm's `token:` row for ERC-20/721 calls so the
 *  user sees "USDC" instead of staring at a raw hex string and
 *  trying to match it against tokenlists. Falls back to the raw
 *  address when `tokenInfo` doesn't have an entry — i.e. the
 *  background SW's read-token-info round-trip hasn't landed yet, or
 *  the contract isn't an ERC-20 we could read. */
export function formatTokenContract(
  addr: string,
  info: Record<string, TokenInfo>,
): string {
  const meta = info[addr.toLowerCase()];
  if (!meta) return addr;
  return `${meta.symbol} · ${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format a uint256 amount against optional on-chain decimals/symbol.
 *  Edge cases:
 *    • token meta missing      → fall back to humanAmount (no symbol)
 *    • amount === uint256.max  → `UNLIMITED ${symbol}`
 *    • amount > 0 but rounds to < 1e-6 → show raw wei + decimals so user
 *      doesn't read a non-zero amount as "0 ${symbol}"
 *    • amount > Number.MAX_SAFE_INTEGER → fall back to BigInt-divided
 *      whole-units form (`12345 USDC`) */
export function formatTokenAmount(
  value: string | number,
  tokenAddr: string | undefined,
  info: Record<string, TokenInfo>,
): string {
  if (!tokenAddr) return humanAmount(value);
  const meta = info[tokenAddr.toLowerCase()];
  if (!meta) return humanAmount(value);
  try {
    const big = BigInt(value as string);
    const max = (1n << 256n) - 1n;
    if (big === max) return `UNLIMITED ${meta.symbol}`;
    const formatted = Number(big) / 10 ** meta.decimals;
    // Non-zero but rounds to "0.000000" at 6-digit precision. Surfacing
    // "0 MTK" reads as "they're sending nothing" — actually misleading.
    if (big > 0n && formatted < 1e-6) {
      return `${big.toString()} wei (decimals=${meta.decimals}) ${meta.symbol}`;
    }
    if (Number.isFinite(formatted)) {
      return `${formatted.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${meta.symbol}`;
    }
    // Fall back to viem-style formatting for very large values.
    const whole = big / (10n ** BigInt(meta.decimals));
    return `${whole.toString()} ${meta.symbol}`;
  } catch {
    return String(value);
  }
}

/** chainId → display tag. Sourced from viem's `Chain` registry (`chain.name`
 *  + `chain.testnet`) — viem maintains those flags upstream so we don't
 *  ship stale data. Unknown chainIds get a neutral `chain N` fallback (so
 *  the chain row never disappears, custom chains still show up). */
export function chainBadge(chainId: number): { name: string; isTest: boolean } {
  const c: Chain | undefined = VIEM_CHAIN_REGISTRY[chainId];
  if (c) return { name: c.name, isTest: !!c.testnet };
  return { name: `chain ${chainId}`, isTest: false };
}

/** Build a "view this contract address" URL the user can jump to from
 *  the sign-confirm delegate row. Resolution order:
 *
 *    1. Chain's own default block explorer (Etherscan for mainnet,
 *       sepolia.etherscan.io for Sepolia, etc) — sourced from viem's
 *       Chain registry. Best UX since most users already know the
 *       explorer for the chain they're on.
 *    2. Sourcify universal contract lookup — fallback when the chain
 *       has no explorer entry in viem (newer / custom chains).
 *       Sourcify's lookup page accepts any address + auto-detects the
 *       chain from its index, so the user lands on the contract's
 *       source if it's been verified there.
 *
 *  Always returns a URL string. Caller is free to render it
 *  unconditionally as a link. */
export function explorerAddressUrl(chainId: number, address: string): string {
  const c: Chain | undefined = VIEM_CHAIN_REGISTRY[chainId];
  const base = c?.blockExplorers?.default?.url;
  if (base) {
    // Strip trailing slash so the join shape is predictable.
    return `${base.replace(/\/+$/, '')}/address/${address}`;
  }
  // No native explorer → Sourcify lookup. The hash-route is intentional;
  // Sourcify's app is SPA and routes via the URL fragment.
  return `https://sourcify.dev/#/lookup/${address}`;
}

/** Pretty-format a USD-denominated value as either USD (`$1,234.56`) or ETH
 *  (`Ξ 0.5138`) based on the user's preference. ETH conversion uses
 *  `ethUsdRate` (USD per ETH); when the rate is null (network blip,
 *  unsupported chain) we fall back to USD so the user never sees `Ξ —`.
 *
 *  Output rules:
 *    • USD: 2 decimal places. Sub-cent positives → `<$0.01`. Zero → `$0.00`.
 *    • ETH: up to 4 decimal places with a thin-spaced `Ξ ` prefix. Zero →
 *      `Ξ 0`; sub-0.0001 positives → `Ξ <0.0001`.
 *    • Both currencies clamp negative values to absolute (no negative
 *      balances render in this wallet — they're a bug if they appear). */
export function formatCurrency(
  usdValue: number,
  currency: 'eth' | 'usd',
  ethUsdRate: number | null,
): string {
  if (!Number.isFinite(usdValue)) return currency === 'eth' ? 'Ξ —' : '$—';
  const v = Math.abs(usdValue);
  if (currency === 'eth' && ethUsdRate && ethUsdRate > 0) {
    const eth = v / ethUsdRate;
    if (eth === 0) return 'Ξ 0';
    if (eth < 0.0001) return 'Ξ <0.0001';
    return 'Ξ ' + eth.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  if (v === 0) return '$0.00';
  if (v < 0.01) return '<$0.01';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
