// src/lib/grant-request.ts
//
// Pure parser: maps an ERC-7715-style `wallet_grantPermissions` param object
// into the wallet-internal `PermissionRequest` that grant-scope's
// `normalizeScope` consumes. Deliberately dependency-free (no chrome, no
// storage, no viem client) so it unit-tests in isolation and can run inside
// the service worker's upfront-validation path before any popup opens.
//
// This is an app-dedicated wallet. It issues two grant shapes:
//   * BOUNDED — one concrete target contract + an explicit allow-list of
//     function signatures + an expiry (the default; wildcards refused).
//   * GENERIC — `generic: true`: the session key may call any function on the
//     app's contracts (the app drives its whole surface). No target/function
//     list; an expiry is still REQUIRED. A missing/invalid expiry is always
//     refused HERE, before any popup.
//
// Accepted input shape (canonical ERC-7715, with light tolerance):
//   params[0] = {
//     chainId?: hex | number,          // advisory; the caller's active chainId wins
//     account?: address,               // optional signer/account hint
//     expiry: number,                  // unix seconds — REQUIRED, must be > 0
//     permissions: [                   // REQUIRED non-empty; first entry is used
//       { type?: string, data: {
//           target: address,           // REQUIRED concrete 20-byte address
//           allowedFunctions: string[] // REQUIRED non-empty human signatures
//           nativeCapWei?, gasCapWei?, erc20Caps?  // optional caps
//       } }
//     ]
//   }
// A flat form (target/allowedFunctions directly on params[0], no `permissions`
// wrapper) is also accepted so simple relayer payloads work without ceremony.

import type { Address } from "viem";
import type { PermissionRequest } from "./grant-scope";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON-RPC wraps the single request object in the params array. Tolerate
 *  both `[req]` and a bare `req` so the SW can hand us `payload.params`
 *  verbatim. */
function unwrap(rawParams: unknown): Record<string, unknown> {
  const obj = Array.isArray(rawParams) ? rawParams[0] : rawParams;
  if (!isRecord(obj)) throw new Error("params[0] must be a request object");
  return obj;
}

/** Coerce an optional cap (number | bigint | numeric string) to bigint.
 *  Undefined/null → undefined (the caller defaults it). */
function toBigIntOrUndef(v: unknown): bigint | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.trim().length > 0) return BigInt(v.trim());
  throw new Error("cap must be a number, bigint, or numeric string");
}

export function parseGrantPermissionsRequest(
  rawParams: unknown,
  chainId: number,
): PermissionRequest {
  const obj = unwrap(rawParams);

  // ── expiry (top-level, required) ──────────────────────────────────────────
  // Checked first: a grant with no time bound is the most dangerous shape,
  // so refuse it before doing any other work.
  const expiry = obj.expiry;
  if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0) {
    throw new Error(
      "missing or invalid expiry — expected a positive unix-seconds number",
    );
  }

  // ── locate the permission entry ───────────────────────────────────────────
  // Canonical ERC-7715 wraps a list of permissions; we grant a single bounded
  // scope so the first entry is authoritative. Tolerate a flat form where
  // target/allowedFunctions live directly on the request object.
  let data: Record<string, unknown>;
  const permissions = obj.permissions;
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error("permissions must be a non-empty array");
    }
    const entry = permissions[0];
    if (!isRecord(entry)) throw new Error("permissions[0] must be an object");
    data = isRecord(entry.data) ? entry.data : entry;
  } else {
    data = obj;
  }

  // ── generic vs bounded ────────────────────────────────────────────────────
  // This is an app-dedicated wallet: the app may request a GENERIC grant so the
  // session key can drive all of the app's contracts (not just one bounded
  // scope). A generic request sets `generic: true` (on the permission entry or
  // the top-level object) and needs NO target / function list — only the expiry
  // checked above (+ optional caps below). A request that is NOT generic still
  // must carry a concrete target + non-empty function list, as before.
  const isGeneric = data.generic === true || obj.generic === true;

  let target: Address;
  let allowedFunctions: string[];
  if (isGeneric) {
    target = ZERO_ADDRESS as Address; // any-target sentinel
    allowedFunctions = [];
  } else {
    // ── target (required, concrete — reject wildcards) ──────────────────────
    const rawTarget = data.target ?? data.address;
    if (typeof rawTarget !== "string" || !ADDRESS_RE.test(rawTarget)) {
      throw new Error(
        "missing or wildcard target — a concrete 20-byte contract address is required",
      );
    }
    if (rawTarget.toLowerCase() === ZERO_ADDRESS) {
      throw new Error("target is the zero address (wildcard) — refused");
    }
    target = rawTarget as Address;

    // ── allowedFunctions (required, non-empty human signatures) ─────────────
    const rawFns = data.allowedFunctions ?? data.functions;
    if (!Array.isArray(rawFns) || rawFns.length === 0) {
      throw new Error(
        "allowedFunctions must be a non-empty array of function signatures",
      );
    }
    allowedFunctions = rawFns.map((f) => {
      if (typeof f !== "string" || !f.includes("(")) {
        throw new Error(
          `invalid function signature "${String(f)}" — expected e.g. "mint(uint256)"`,
        );
      }
      return f;
    });
  }

  // ── optional caps ─────────────────────────────────────────────────────────
  const nativeCapWei = toBigIntOrUndef(data.nativeCapWei);
  const gasCapWei = toBigIntOrUndef(data.gasCapWei);
  let erc20Caps: { token: Address; cap: bigint }[] | undefined;
  if (data.erc20Caps !== undefined) {
    if (!Array.isArray(data.erc20Caps)) {
      throw new Error("erc20Caps must be an array");
    }
    erc20Caps = data.erc20Caps.map((c) => {
      if (!isRecord(c) || typeof c.token !== "string" || !ADDRESS_RE.test(c.token)) {
        throw new Error("erc20Caps entries need a valid token address");
      }
      return { token: c.token as Address, cap: toBigIntOrUndef(c.cap) ?? 0n };
    });
  }

  // ── optional account hint ─────────────────────────────────────────────────
  // Advisory only — the SW records the grant against the APPROVING account,
  // never blindly against a dapp-supplied address.
  const rawAccount = obj.account;
  const account =
    typeof rawAccount === "string" && ADDRESS_RE.test(rawAccount)
      ? (rawAccount as Address)
      : undefined;

  return {
    chainId,
    ...(account ? { account } : {}),
    ...(isGeneric ? { generic: true } : {}),
    target,
    allowedFunctions,
    ...(nativeCapWei !== undefined ? { nativeCapWei } : {}),
    ...(erc20Caps ? { erc20Caps } : {}),
    ...(gasCapWei !== undefined ? { gasCapWei } : {}),
    expiry,
  };
}
