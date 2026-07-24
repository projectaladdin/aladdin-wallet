// src/lib/grant-scope.ts
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";

export type GrantKind = "7702" | "session";

export interface AllowedCall {
  selector: Hex;
  signature: string;    // "mint(uint256)"
  functionName: string; // "mint"
  valueLimitWei: bigint;
}

export interface NormalizedScope {
  /** A generic grant: the session key may call any function on any of the app's
   *  contracts (this is an app-dedicated wallet). When true, `target` is the
   *  any-sentinel (zero address) and `calls` is empty; caps + expiry still apply. */
  generic?: boolean;
  target: Address;
  calls: AllowedCall[];
  nativeCapWei: bigint;
  erc20Caps: { token: Address; cap: bigint }[];
  gasCapWei: bigint;
  expiry: number; // unix seconds
}

/** Wallet-internal, ERC-7715-aligned request the dapp sends via wallet_grantPermissions. */
export interface PermissionRequest {
  chainId: number;
  account?: Address;
  /** When true, a generic grant (any contract, any function); `target`/
   *  `allowedFunctions` are ignored. */
  generic?: boolean;
  target: Address;
  allowedFunctions: string[]; // human signatures
  nativeCapWei?: bigint;
  erc20Caps?: { token: Address; cap: bigint }[];
  gasCapWei?: bigint;
  expiry: number; // unix seconds
}

/** Any-target sentinel for a generic grant (also used so scope-guard's
 *  target-match never treats a real tx as "out of scope" for a generic key). */
export const ANY_TARGET = "0x0000000000000000000000000000000000000000";

export function normalizeScope(req: PermissionRequest): NormalizedScope {
  const caps = {
    nativeCapWei: req.nativeCapWei ?? 0n,
    erc20Caps: (req.erc20Caps ?? []).map((c) => ({ token: getAddress(c.token), cap: c.cap })),
    gasCapWei: req.gasCapWei ?? 0n,
    expiry: req.expiry,
  };
  if (req.generic) {
    return { generic: true, target: getAddress(ANY_TARGET), calls: [], ...caps };
  }
  const calls: AllowedCall[] = req.allowedFunctions.map((sig) => ({
    selector: toFunctionSelector(sig),
    signature: sig,
    functionName: sig.slice(0, sig.indexOf("(")),
    valueLimitWei: 0n,
  }));
  return { generic: false, target: getAddress(req.target), calls, ...caps };
}

/** Human "CAN" lines for the sign-confirm grant-review screen (Task 4.2).
 *  The positive space of the grant: the single target contract, every call
 *  the dapp may make (functionName + full signature), each spend cap that is
 *  actually set (native / erc20 / gas — zero caps are omitted, not shown as
 *  "0"), and the expiry. Pairs with `deriveCannotList` (the negative space)
 *  to render the CAN/CANNOT view. Pure — no I/O, no display copy from the
 *  dapp; every line is derived from the normalized scope the wallet parsed. */
export function describeGrantCan(scope: NormalizedScope): string[] {
  if (scope.generic) {
    const g: string[] = [];
    g.push("Act on your behalf across this app's contracts (any of its actions)");
    if (scope.nativeCapWei > 0n) g.push(`Spend up to ${scope.nativeCapWei.toString()} wei of native ETH`);
    for (const cap of scope.erc20Caps) {
      if (cap.cap > 0n) g.push(`Spend up to ${cap.cap.toString()} units of token ${cap.token}`);
    }
    if (scope.gasCapWei > 0n) g.push(`Use up to ${scope.gasCapWei.toString()} wei for gas`);
    g.push(`Expires at unix time ${scope.expiry}`);
    return g;
  }
  const lines: string[] = [];
  lines.push(`Interact only with the contract at ${scope.target}`);
  for (const c of scope.calls) {
    lines.push(`Call ${c.functionName}() — ${c.signature}`);
  }
  if (scope.nativeCapWei > 0n) {
    lines.push(`Spend up to ${scope.nativeCapWei.toString()} wei of native ETH`);
  }
  for (const cap of scope.erc20Caps) {
    if (cap.cap > 0n) {
      lines.push(`Spend up to ${cap.cap.toString()} units of token ${cap.token}`);
    }
  }
  if (scope.gasCapWei > 0n) {
    lines.push(`Use up to ${scope.gasCapWei.toString()} wei for gas`);
  }
  lines.push(`Expires at unix time ${scope.expiry}`);
  return lines;
}

/** CANNOT list derived from the granted scope — the negative space of the grant.
 *  For a generic grant we list ONLY what is genuinely still forbidden (it expires,
 *  it can't extend/raise itself) — never a false "cannot move your assets"
 *  reassurance, since a generic key can. Honest, not alarmist. */
export function deriveCannotList(scope: NormalizedScope): string[] {
  if (scope.generic) {
    return [
      `Act after it expires (unix time ${scope.expiry})`,
      "Give itself more time or raise its own spend limits",
    ];
  }
  const fns = scope.calls.map((c) => c.functionName).join(", ") || "(none)";
  return [
    `Call any contract other than ${scope.target}`,
    `Call any function other than: ${fns}`,
    "Move ETH or tokens out of your wallet beyond the caps shown above",
    "Transfer, sell, or approve any NFT you own",
    "Touch any ERC-6551 token-bound account (no drain path)",
    "Raise its own caps or extend its own expiry",
  ];
}

// ---- storage-safe serialization (chrome.storage.local is JSON: no bigints) ----
export interface StoredScope {
  generic?: boolean;
  target: Address;
  calls: { selector: Hex; signature: string; functionName: string; valueLimitWei: string }[];
  nativeCapWei: string;
  erc20Caps: { token: Address; cap: string }[];
  gasCapWei: string;
  expiry: number;
}

export function serializeScope(s: NormalizedScope): StoredScope {
  return {
    ...(s.generic ? { generic: true } : {}),
    target: s.target,
    calls: s.calls.map((c) => ({ ...c, valueLimitWei: c.valueLimitWei.toString() })),
    nativeCapWei: s.nativeCapWei.toString(),
    erc20Caps: s.erc20Caps.map((c) => ({ token: c.token, cap: c.cap.toString() })),
    gasCapWei: s.gasCapWei.toString(),
    expiry: s.expiry,
  };
}

export function deserializeScope(s: StoredScope): NormalizedScope {
  return {
    ...(s.generic ? { generic: true } : {}),
    target: s.target,
    calls: s.calls.map((c) => ({ ...c, valueLimitWei: BigInt(c.valueLimitWei) })),
    nativeCapWei: BigInt(s.nativeCapWei),
    erc20Caps: s.erc20Caps.map((c) => ({ token: c.token, cap: BigInt(c.cap) })),
    gasCapWei: BigInt(s.gasCapWei),
    expiry: s.expiry,
  };
}

export interface GrantRecord {
  id: string;
  kind: GrantKind;
  chainId: number;
  account: string; // lowercased EOA
  target: string;  // delegate (7702) or permission target (session)
  scope?: StoredScope; // session grants only
  createdAt: number;
  expiry: number; // 0 = none
  revokedAt?: number;
  txHash?: string;
}

/** Is this grant still live at `nowSeconds`? The Safety Panel's source-of-truth
 *  predicate for deciding whether a registry entry appears in the active list.
 *  A grant is active iff it hasn't been revoked AND hasn't expired. `expiry === 0`
 *  is the "never expires" sentinel; a non-zero expiry is a strict upper bound
 *  (a grant whose expiry equals now has lapsed). Pure — no I/O. */
export function isGrantActive(grant: GrantRecord, nowSeconds: number): boolean {
  if (grant.revokedAt) return false;
  return grant.expiry === 0 || grant.expiry > nowSeconds;
}
