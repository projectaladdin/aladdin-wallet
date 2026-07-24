// src/lib/delegation-grant.ts
// Pure helpers backing Task 4.1 — turning a successful EIP-7702
// `wallet_signAuthorization` into a `kind: "7702"` GrantRecord for the
// generic grant registry (so the Safety Panel can list + revoke it), and
// recognising a delegation to the zero address as a REVOCATION rather than a
// new grant. No storage / chrome deps here on purpose: keeps the logic
// unit-testable in isolation; background.ts wires these into the registry.

import type { GrantRecord } from "./grant-scope";

/**
 * True iff `delegate` is the zero address in any 0x000… form (case-
 * insensitive, tolerant of a short `0x0` or an uppercase `0X` prefix). A
 * type-4 authorization whose delegate is the zero address CLEARS a prior
 * delegation — the EOA points back at itself — so callers treat this as a
 * revocation signal, not a new grant.
 *
 * Requires at least one hex digit after the prefix, all of which must be `0`.
 * `"0x"` (empty body), non-hex junk, and the empty string are all NOT zero.
 */
export function isZeroDelegate(delegate: string): boolean {
  if (typeof delegate !== "string") return false;
  const m = /^0x([0-9a-fA-F]+)$/i.exec(delegate.trim());
  if (!m) return false;
  return /^0+$/.test(m[1]!);
}

/**
 * Build the `kind: "7702"` GrantRecord for a freshly-signed delegation.
 * `target` is the delegate as-approved; `account` is lowercased so a
 * checksum-cased EOA still resolves its grants on read. `id` embeds the
 * lowercased delegate + createdAt so re-delegating the same target at a
 * different time yields a distinct record. `expiry: 0` — a 7702 delegation
 * has no self-imposed expiry (it lives until explicitly revoked). `scope`
 * stays undefined (that field is session-grant-only).
 */
export function buildDelegationGrantRecord(args: {
  delegate: string;
  chainId: number;
  account: string;
  createdAt: number;
  txHash?: string;
}): GrantRecord {
  const { delegate, chainId, account, createdAt, txHash } = args;
  return {
    id: `7702:${chainId}:${delegate.toLowerCase()}:${createdAt}`,
    kind: "7702",
    chainId,
    account: account.toLowerCase(),
    target: delegate,
    createdAt,
    expiry: 0,
    ...(txHash ? { txHash } : {}),
  };
}

/**
 * Of the grants that are `kind: "7702"` and still active (no `revokedAt`),
 * return the `id` of the one with the greatest `createdAt` — the newest live
 * delegation, i.e. the one a zero-address revocation should clear. Returns
 * `null` when no active 7702 grant exists. Ignores session grants and any
 * already-revoked 7702 records.
 */
export function pickNewestActive7702GrantId(grants: GrantRecord[]): string | null {
  let best: GrantRecord | null = null;
  for (const g of grants) {
    if (g.kind !== "7702") continue;
    if (g.revokedAt) continue;
    if (!best || g.createdAt > best.createdAt) best = g;
  }
  return best ? best.id : null;
}
