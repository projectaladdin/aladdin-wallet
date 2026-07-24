// EIP-7702 authorizationList wire-format → typed-format normaliser.
//
// Why this exists (catastrophic bug):
//
// When a dapp calls `eth_sendTransaction({authorizationList: [auth]})` over
// EIP-1193, viem on the dapp side runs `formatAuthorizationList` (in
// transactionRequest.js) which hex-stringifies every numeric field so the
// JSON-RPC wire is JSON-safe:
//
//     { chainId: 11155111, nonce: 4, yParity: 1, ... }
//   → { chainId: "0xaa36a7", nonce: "0x4", yParity: "0x1", ... }
//
// Our wallet's `eth_sendTransaction` then calls viem's local
// `wallet.sendTransaction` with the wire-format list. viem's
// `serializeAuthorizationList` calls `toHex(chainId)` and `toHex(nonce)` —
// and `toHex` of a STRING does `stringToHex` (UTF-8 byte encoding of the
// literal hex characters) instead of `numberToHex`:
//
//     toHex("0x4") = stringToHex("0x4")
//                  = bytes ['0','x','4']
//                  = 0x307834
//                  = decimal 3,176,499
//
// The resulting type-4 tx's RLP-encoded auth has garbage chainId / nonce.
// EVM ecrecover gives a junk authority that doesn't match tx.from, the auth
// is silently skipped, and the tx mines as type-4 with NO delegation
// applied. Symptom: "Activation tx mined but EOA code didn't change. Got: 0x"
//
// Fix: coerce every numeric field back to a real `number` before handing
// the list to viem's signer. Tests in `tests/auth-normalize.test.ts` lock
// this in with both unit and serialiser-roundtrip coverage.
//
// This module is pure — no chrome / React / RPC dependencies — so the same
// helper is reusable from background.ts and unit-testable in isolation.

import type { Address, Hex } from 'viem';

/** Typed-format authorization, ready for viem's `serializeAuthorizationList`. */
export type TypedAuthorization = {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
};

/** Coerce any reasonable representation of a numeric field (number, bigint,
 *  hex string, decimal string) into a JS number AFTER validating it fits in
 *  Number.MAX_SAFE_INTEGER. Throwing on overflow is the safety guarantee:
 *  a malicious or buggy dapp sending nonce=2^60 cannot silently round into
 *  a different on-chain nonce — ecrecover would yield garbage authority,
 *  the auth would no-op on chain, and the dapp dev would chase a phantom
 *  "tx mined but delegation didn't apply" bug. Fail loud at the JSON-RPC
 *  boundary instead of broadcasting a doomed tx. */
function toSafeNumber(v: unknown, field: string): number {
  if (v === null || v === undefined || v === '') return 0;
  let big: bigint;
  if (typeof v === 'bigint') big = v;
  else if (typeof v === 'number') big = BigInt(v);
  else if (typeof v === 'string') {
    try { big = BigInt(v); }
    catch { throw new Error(`authorizationList.${field}: not a valid integer ("${v}")`); }
  } else {
    throw new Error(`authorizationList.${field}: unsupported type ${typeof v}`);
  }
  if (big < 0n) throw new Error(`authorizationList.${field}: negative value (${big})`);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `authorizationList.${field}: value ${big} exceeds Number.MAX_SAFE_INTEGER. ` +
      `Signing a 7702 authorization with this value would silently truncate ` +
      `and ecrecover would yield a junk authority.`,
    );
  }
  return Number(big);
}

/** yParity is a single bit in EIP-7702. We THROW on out-of-range values
 *  (anything other than 0/1) instead of silently clamping — a buggy
 *  dapp shipping v=27/28 (forgotten conversion from pre-EIP-155 sig
 *  encoding) would otherwise have its 27 → 0 and get a broken-but-
 *  valid-looking auth, ecrecover yields garbage authority, the auth
 *  silently fails. Loud refusal lets the dapp dev see the bug. */
function toYParity(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  let big: bigint;
  try {
    if (typeof v === 'bigint') big = v;
    else if (typeof v === 'number') big = BigInt(v);
    else if (typeof v === 'string') big = BigInt(v);
    else throw new Error(`unsupported type ${typeof v}`);
  } catch {
    throw new Error(`authorizationList.yParity: not a valid integer ("${String(v)}")`);
  }
  if (big !== 0n && big !== 1n) {
    throw new Error(
      `authorizationList.yParity: must be 0 or 1 (got ${big}). ` +
      `If your dapp is sending v=27/28, downconvert: yParity = v - 27.`,
    );
  }
  return Number(big);
}

/** Normalise an `authorizationList` from EIP-1193 wire format (every numeric
 *  field is a hex string) to viem's typed format (numbers). Pass-through for
 *  fields that are already numbers — idempotent, safe to apply twice. Throws
 *  on out-of-range chainId / nonce so the SW rejects malformed dapp input
 *  instead of silently truncating. */
export function normalizeAuthorizationList(list: unknown[]): TypedAuthorization[] {
  return list.map((rawAuth) => {
    const a = rawAuth as Record<string, unknown>;
    return {
      address: a.address as Address,
      chainId: toSafeNumber(a.chainId, 'chainId'),
      nonce: toSafeNumber(a.nonce, 'nonce'),
      r: a.r as Hex,
      s: a.s as Hex,
      yParity: toYParity(a.yParity),
    };
  });
}
