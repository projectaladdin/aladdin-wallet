// Render an activity entry's primary line as a one-liner like
// "sent 0.5 ETH" / "approved ∞ USDC to 0xabcd…ef01" / "transferred
// NFT #42". Extracted from activity.tsx so the formatting rules
// can be unit-tested in isolation.
//
// Inputs:
//   entry      — the persisted ActivityEntry (from src/core/activity)
//   tokenInfo  — symbol/decimals map keyed by lowercased token address
//   nativeSym  — chain native symbol ('ETH' / 'BNB' / 'MATIC' / …)
//
// Output is a short phrase. The Activity row template renders the
// recipient + tx hash separately so callers don't need to embed
// addresses in this string.

import { decodeTxData } from './decoders';
import { compactNumber, isInfinityAllowance } from './approve-format';
import type { ActivityEntry } from '../core/activity';

export type TokenInfoMap = Record<string, { symbol: string; decimals: number }>;
/** Reverse-ENS map: lowercased address → primary name or null when
 *  unresolved. Optional — when omitted formatter falls back to the
 *  truncated 0x… form. */
export type EnsNameMap = Record<string, string | null>;

/** Format wei → human decimal with native symbol. Keeps full precision
 *  up to 6 fraction digits, then falls back to compactNumber's K/M/B
 *  suffix for huge values. */
function formatWei(wei: bigint, decimals: number, symbol: string): string {
  if (decimals < 0) decimals = 0;
  const n = Number(wei) / 10 ** decimals;
  if (!Number.isFinite(n)) return `${wei.toString()} ${symbol}`;
  return `${compactNumber(n)} ${symbol}`;
}

import { truncateAddr } from './format';

/** Prefer ENS name → truncated 0x… → empty. Used for every recipient
 *  / spender address rendered in an activity row. */
function nameOrShort(addr: string, ens?: EnsNameMap): string {
  if (!addr) return '';
  const name = ens?.[addr.toLowerCase()];
  return name || truncateAddr(addr);
}

export function formatActivityLabel(
  entry: ActivityEntry,
  tokenInfo: TokenInfoMap,
  nativeSym: string,
  ensNames?: EnsNameMap,
): { verb: string; detail: string } {
  // Sign-only ops first — no calldata, no value movement.
  if (entry.kind === 'sign-message') return { verb: 'signed message', detail: '' };
  if (entry.kind === 'sign-typed')   return { verb: 'signed typed data', detail: '' };
  if (entry.kind === '7702') return {
    verb: '7702 delegation',
    detail: entry.to ? `→ ${nameOrShort(entry.to, ensNames)}` : '',
  };
  if (entry.kind === 'deploy') return { verb: 'deployed contract', detail: '' };

  // Native send — value field already carries the amount in wei.
  if (entry.kind === 'send') {
    try {
      const wei = BigInt(entry.value || '0');
      return {
        verb: `sent ${formatWei(wei, 18, nativeSym)}`,
        detail: entry.to ? `→ ${nameOrShort(entry.to, ensNames)}` : '',
      };
    } catch {
      return { verb: 'sent', detail: entry.to ? `→ ${nameOrShort(entry.to, ensNames)}` : '' };
    }
  }

  // Contract calls — decode for amount + recipient + spender.
  const decoded = decodeTxData(entry.data ?? undefined);
  const tokenAddr = entry.to.toLowerCase();
  const meta = tokenInfo[tokenAddr];
  const tokenSym = meta?.symbol ?? 'token';
  const tokenDec = meta?.decimals ?? 0;

  if (entry.kind === 'erc20-transfer' && decoded.kind === 'known') {
    // transfer(to, amount) or transferFrom(from, to, amount).
    let to: string | undefined;
    let amountArg: unknown;
    if (decoded.name === 'transfer') {
      to = String(decoded.args[0] ?? '');
      amountArg = decoded.args[1];
    } else if (decoded.name === 'transferFrom') {
      to = String(decoded.args[1] ?? '');
      amountArg = decoded.args[2];
    }
    try {
      const amt = BigInt(String(amountArg ?? '0'));
      return {
        verb: `sent ${formatWei(amt, tokenDec, tokenSym)}`,
        detail: to ? `→ ${nameOrShort(to, ensNames)}` : '',
      };
    } catch { /* fall through */ }
  }

  if (entry.kind === 'approve' && decoded.kind === 'known') {
    if (decoded.name === 'approve') {
      const spender = String(decoded.args[0] ?? '');
      let amt: bigint = 0n;
      try { amt = BigInt(String(decoded.args[1] ?? '0')); } catch { /* keep 0 */ }
      const amountStr = isInfinityAllowance(amt)
        ? '∞'
        : formatWei(amt, tokenDec, tokenSym);
      return {
        verb: `approved ${amountStr}`,
        detail: spender ? `to ${nameOrShort(spender, ensNames)}` : '',
      };
    }
    if (decoded.name === 'setApprovalForAll') {
      const operator = String(decoded.args[0] ?? '');
      const approved = Boolean(decoded.args[1]);
      return {
        verb: approved ? `approved all ${tokenSym}` : `revoked ${tokenSym} approval`,
        detail: operator ? `to ${nameOrShort(operator, ensNames)}` : '',
      };
    }
  }

  if (entry.kind === 'nft-transfer' && decoded.kind === 'known') {
    // safeTransferFrom(from, to, tokenId) [ERC-721] or
    // safeTransferFrom(from, to, id, amount, bytes) [ERC-1155].
    const args = decoded.args;
    const to = String(args[1] ?? '');
    const tokenId = String(args[2] ?? '?');
    const is1155 = decoded.name === 'safeTransferFrom' && args.length >= 5;
    if (is1155) {
      let count = '?';
      try { count = String(args[3] ?? '?'); } catch { /* keep */ }
      return {
        verb: `transferred ${count}× #${tokenId}`,
        detail: to ? `→ ${nameOrShort(to, ensNames)}` : '',
      };
    }
    return {
      verb: `transferred NFT #${tokenId}`,
      detail: to ? `→ ${nameOrShort(to, ensNames)}` : '',
    };
  }

  // Fallback: unrecognized calldata. Render the kind + function name
  // (when decoded) so the user has SOMETHING to identify the row by.
  const fn = decoded.kind === 'known' ? decoded.name : 'contract call';
  return {
    verb: fn,
    detail: entry.to ? `→ ${nameOrShort(entry.to, ensNames)}` : '',
  };
}
