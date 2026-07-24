// Pure decoders + canonical-shape recognizers — no React / chrome / DOM
// dependencies. popup.tsx imports from here so the same logic is unit-
// testable from `tests/`.

import { decodeFunctionData, type Abi } from 'viem';
import { SELECTOR_TABLE_ABI } from './selector-table';

// ─── Common ERC-20 / WETH calldata ABI ────────────────────────────────────
// Decoded args land in the sign-confirm UI so users see "approve UNLIMITED
// to attacker.eth" instead of a hex blob. NFT-specific entries
// (setApprovalForAll, safeTransferFrom) intentionally omitted until proper
// NFT support lands.

export const COMMON_TX_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'to' }, { type: 'uint256', name: 'amount' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'from' }, { type: 'address', name: 'to' }, { type: 'uint256', name: 'amount' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'amount' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
] as const;

export type DecodedTx =
  | { kind: 'native' }
  | { kind: 'known'; name: string; args: readonly unknown[] }
  | { kind: 'unknown'; selector: string; bytes: number };

/** Decode `eth_sendTransaction.data`. Returns:
 *  • `{kind: 'native'}` when there's no calldata (plain ETH transfer)
 *  • `{kind: 'known', name, args}` when a bundled ABI matches the selector
 *  • `{kind: 'unknown', selector, bytes}` otherwise — caller can then
 *    fall back to Sourcify ABI lookup via `decodeTxDataWithAbi`.
 *
 *  Tries the two bundled tables in order:
 *    1. `COMMON_TX_ABI` (ERC-20 transfer / approve / transferFrom +
 *       WETH deposit / withdraw) — kept separate so the canonical
 *       hot path stays priority and other code paths that import
 *       COMMON_TX_ABI directly keep working.
 *    2. `SELECTOR_TABLE_ABI` (ERC-721/1155, Uniswap V2/V3, Universal
 *       Router, Permit2, Seaport, Multicall3, common DeFi patterns).
 */
export function decodeTxData(data: string | undefined): DecodedTx {
  if (!data || data === '0x' || data.length < 10) return { kind: 'native' };
  try {
    const r = decodeFunctionData({ abi: COMMON_TX_ABI, data: data as `0x${string}` });
    return { kind: 'known', name: r.functionName, args: r.args ?? [] };
  } catch { /* fall through to extended table */ }
  try {
    const r = decodeFunctionData({ abi: SELECTOR_TABLE_ABI, data: data as `0x${string}` });
    return { kind: 'known', name: r.functionName, args: r.args ?? [] };
  } catch {
    return { kind: 'unknown', selector: data.slice(0, 10), bytes: Math.max(0, (data.length - 2) / 2) };
  }
}

/** Walk the inner calldata array of a multicall-style outer call and
 *  return each entry decoded against the same selector table. Caller
 *  must have already verified `decoded.kind === 'known'`; this helper
 *  only knows how to find the bytes[] inside known wrapper functions.
 *
 *  Supported wrappers:
 *    • `multicall(bytes[])` — Uniswap V3 SwapRouter
 *    • `multicall(uint256 deadline, bytes[])` — V3 deadline variant
 *    • `aggregate3((address target, bool allowFailure, bytes callData)[])`
 *      — Multicall3 (callData lives inside each tuple)
 *
 *  Universal Router's `execute(bytes commands, bytes[] inputs)` uses a
 *  packed-byte command opcode scheme NOT compatible with selector
 *  matching — out of scope here. Returns null for any wrapper we
 *  don't recognise (caller treats as "non-multicall" and skips
 *  recursive risk analysis).
 *
 *  Depth-bounded: returns a flat list of inner-call decodes; a nested
 *  multicall stays as `{kind: 'known', name: 'multicall'}` for the
 *  rule layer to walk further (with its own depth limit). */
export function decodeMulticallInner(decoded: DecodedTx): DecodedTx[] | null {
  if (decoded.kind !== 'known') return null;
  // For multicall(bytes[]) and multicall(uint256, bytes[]), the
  // bytes[] is the LAST arg.
  if (decoded.name === 'multicall') {
    const last = decoded.args[decoded.args.length - 1];
    if (!Array.isArray(last)) return null;
    return last.map((calldata: unknown) =>
      typeof calldata === 'string' ? decodeTxData(calldata) : { kind: 'unknown', selector: '0x', bytes: 0 },
    );
  }
  // aggregate3 takes a tuple[] where each element is
  // { target, allowFailure, callData }.
  if (decoded.name === 'aggregate3') {
    const calls = decoded.args[0];
    if (!Array.isArray(calls)) return null;
    return calls.map((entry: unknown) => {
      const callData = (entry as { callData?: unknown })?.callData;
      return typeof callData === 'string'
        ? decodeTxData(callData)
        : { kind: 'unknown' as const, selector: '0x', bytes: 0 };
    });
  }
  return null;
}

/** Names of wrapper functions that `decodeMulticallInner` understands.
 *  Used by the security engine to early-exit non-multicall calls. */
export const MULTICALL_NAMES: ReadonlySet<string> = new Set(['multicall', 'aggregate3']);

/** Decode using a caller-supplied ABI — the second-stage decoder for the
 *  Sourcify fallback path. `decodeTxData` is called first (synchronous,
 *  local table); if it returns `'unknown'`, the popup fetches the
 *  destination contract's ABI from Sourcify via the SW and re-decodes
 *  with this function. Returns the same `DecodedTx` shape so the
 *  renderer doesn't branch on the lookup source. */
export function decodeTxDataWithAbi(
  data: string | undefined,
  abi: Abi | undefined,
): DecodedTx {
  if (!data || data === '0x' || data.length < 10) return { kind: 'native' };
  if (!abi || abi.length === 0) {
    return { kind: 'unknown', selector: data.slice(0, 10), bytes: Math.max(0, (data.length - 2) / 2) };
  }
  try {
    const r = decodeFunctionData({ abi, data: data as `0x${string}` });
    return { kind: 'known', name: r.functionName, args: r.args ?? [] };
  } catch {
    return { kind: 'unknown', selector: data.slice(0, 10), bytes: Math.max(0, (data.length - 2) / 2) };
  }
}

// ─── Permit canonical-shape recognizers ───────────────────────────────────
// Phishing dapps deploy contracts that accept "Permit"-named typed data
// with reordered or retyped fields. The struct typeHash differs from the
// ERC-2612 spec, so a real Permit-using contract won't verify it — but a
// custom phisher contract will. UI must NOT use Permit-flavored
// rendering for these (would falsely reassure user).

export const CANONICAL_PERMIT_FIELDS = [
  { name: 'owner',    type: 'address' },
  { name: 'spender',  type: 'address' },
  { name: 'value',    type: 'uint256' },
  { name: 'nonce',    type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const;

export const CANONICAL_PERMIT2_DETAILS = [
  { name: 'token',      type: 'address' },
  { name: 'amount',     type: 'uint160' },
  { name: 'expiration', type: 'uint48'  },
  { name: 'nonce',      type: 'uint48'  },
] as const;

export const CANONICAL_PERMIT2_SINGLE = [
  { name: 'details',     type: 'PermitDetails' },
  { name: 'spender',     type: 'address' },
  { name: 'sigDeadline', type: 'uint256' },
] as const;

export const CANONICAL_PERMIT2_BATCH = [
  { name: 'details',     type: 'PermitDetails[]' },
  { name: 'spender',     type: 'address' },
  { name: 'sigDeadline', type: 'uint256' },
] as const;

export function shapeMatches(
  fields: readonly { name: string; type: string }[] | undefined,
  spec: readonly { name: string; type: string }[],
): boolean {
  if (!fields || fields.length !== spec.length) return false;
  return spec.every((s, i) => fields[i]?.name === s.name && fields[i]?.type === s.type);
}

export function isStandardERC2612Permit(types: Record<string, unknown> | undefined): boolean {
  return shapeMatches(types?.Permit as { name: string; type: string }[] | undefined, CANONICAL_PERMIT_FIELDS);
}

export function isStandardPermit2Single(types: Record<string, unknown> | undefined): boolean {
  return shapeMatches(types?.PermitSingle as { name: string; type: string }[] | undefined, CANONICAL_PERMIT2_SINGLE)
      && shapeMatches(types?.PermitDetails as { name: string; type: string }[] | undefined, CANONICAL_PERMIT2_DETAILS);
}

export function isStandardPermit2Batch(types: Record<string, unknown> | undefined): boolean {
  return shapeMatches(types?.PermitBatch as { name: string; type: string }[] | undefined, CANONICAL_PERMIT2_BATCH)
      && shapeMatches(types?.PermitDetails as { name: string; type: string }[] | undefined, CANONICAL_PERMIT2_DETAILS);
}

/** Pull the typed-data `types` map out of the raw payload for shape checks. */
export function getRawTypes(raw: unknown): Record<string, unknown> | undefined {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const t = (obj as { types?: Record<string, unknown> })?.types;
    return t && typeof t === 'object' ? t : undefined;
  } catch { return undefined; }
}

/** Light typed-data parser used by display / risk paths. Returns `null` for
 *  anything that doesn't look like EIP-712 — strict structural validation
 *  lives in validators.ts (validateTypedDataSchema) which has already run
 *  upstream by the time this is called. */
export function parseTyped(raw: unknown): {
  domain?: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
} | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as { primaryType?: string; message?: unknown; domain?: unknown };
    if (!o.primaryType || !o.message) return null;
    return {
      domain: (o.domain as Record<string, unknown>) ?? undefined,
      primaryType: o.primaryType,
      message: o.message as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

// ─── Time formatting ──────────────────────────────────────────────────────

/** Format a unix-second deadline into a "in 7 days" / "in 58 mins" relative
 *  display + raw `unix N` sub-line. Returns null when unparseable / zero. */
export function relativeFromUnix(v: string | number): { display: string; sub: string } | null {
  try {
    const sec = Number(BigInt(v as string | number));
    if (!Number.isFinite(sec) || sec === 0) return null;
    const dt = sec * 1000 - Date.now();
    if (dt <= 0) return { display: 'expired', sub: `unix ${sec}` };
    const mins = Math.round(dt / 60000);
    let display: string;
    if (mins < 60)                  display = `in ${mins} min${mins === 1 ? '' : 's'}`;
    else if (mins < 60 * 24)        display = `in ${Math.round(mins / 60)} hours`;
    else if (mins < 60 * 24 * 30)   display = `in ${Math.round(mins / 60 / 24)} days`;
    else                            display = `in ${Math.round(mins / 60 / 24 / 30)} months`;
    return { display, sub: `unix ${sec}` };
  } catch {
    return null;
  }
}
