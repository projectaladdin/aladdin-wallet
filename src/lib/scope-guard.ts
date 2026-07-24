// src/lib/scope-guard.ts
import { size, slice, type Hex } from "viem";
import type { GrantRecord, NormalizedScope } from "./grant-scope";
import { deserializeScope, isGrantActive } from "./grant-scope";

export interface ScopeViolation { reason: string; }

export function checkCallWithinScope(
  scope: NormalizedScope, target: string, calldata: Hex, valueWei: bigint,
): ScopeViolation | null {
  if (target.toLowerCase() !== scope.target.toLowerCase())
    return { reason: `target ${target} is outside the granted scope (${scope.target})` };
  const selector = (size(calldata) >= 4 ? slice(calldata, 0, 4) : "0x") as Hex;
  const call = scope.calls.find((c) => c.selector.toLowerCase() === selector.toLowerCase());
  if (!call) return { reason: `selector ${selector} is not in the granted scope` };
  if (valueWei > scope.nativeCapWei)
    return { reason: `value ${valueWei} exceeds native cap ${scope.nativeCapWei}` };
  return null;
}

/** Sign-time, defense-in-depth check for `eth_sendTransaction`. The wallet
 *  renders the `wallet_grantPermissions` scope from the payload, so an
 *  over-broad grant can't be created by construction — but a *later* tx
 *  (from the relayer/dapp) can still try to call a live session grant's
 *  target outside the selectors/caps the user actually approved. This walks
 *  the active grant registry and, for the FIRST live session grant whose
 *  target matches `tx.to` and that carries a stored scope, runs
 *  `checkCallWithinScope`. Grants that don't match `tx.to` — or that are
 *  revoked, expired, non-session, or scope-less — are not our concern here,
 *  so we return null (a tx to a contract you never granted a session to is a
 *  normal tx, judged by the other security rules, not by this one). Pure —
 *  no I/O; the caller supplies the already-fetched grants + clock. */
export function evaluateTxAgainstGrants(
  tx: { to: string; data: `0x${string}`; value: bigint },
  grants: GrantRecord[],
  nowSeconds: number,
): ScopeViolation | null {
  const toLower = tx.to.toLowerCase();
  const grant = grants.find(
    (g) =>
      isGrantActive(g, nowSeconds) &&
      g.kind === "session" &&
      g.target.toLowerCase() === toLower &&
      g.scope != null,
  );
  if (!grant || !grant.scope) return null;
  return checkCallWithinScope(deserializeScope(grant.scope), tx.to, tx.data, tx.value);
}

export function scopeExceedsRequest(
  displayed: NormalizedScope, actual: NormalizedScope,
): ScopeViolation | null {
  if (actual.target.toLowerCase() !== displayed.target.toLowerCase())
    return { reason: "target mismatch between displayed and actual scope" };
  const allowed = new Set(displayed.calls.map((c) => c.selector.toLowerCase()));
  for (const c of actual.calls)
    if (!allowed.has(c.selector.toLowerCase())) return { reason: `extra selector ${c.selector} not shown to the user` };
  if (actual.nativeCapWei > displayed.nativeCapWei) return { reason: "actual native cap exceeds displayed native cap" };
  if (actual.gasCapWei > displayed.gasCapWei) return { reason: "actual gas cap exceeds displayed gas cap" };
  return null;
}
