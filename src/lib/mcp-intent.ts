// src/lib/mcp-intent.ts
//
// Generic per-action signed-intent (EIP-712). Prompt-injection defense for the
// MCP/AI flow (Task 6.x): a value-moving action requested via an AI tool must
// carry an intent that the wallet key itself signed. The signature commits to
// the exact action — chain, target contract, function, arguments, value, nonce
// and expiry — so a tampered request (e.g. an injected prompt swapping the
// amount or the recipient) no longer matches the signature and fails to verify.
//
// The variable-length `args` are collapsed into a fixed `bytes32 argsHash` so
// the EIP-712 struct has a static shape (viem needs a concrete type). Identical
// args always hash to the same value; any change to any arg flips the hash and
// therefore breaks verification.
//
// Pure crypto only (viem). Task 6.2 wires build/verify into background + UI.

import { keccak256, encodeAbiParameters, getAddress, size, slice, verifyTypedData, type Address, type Hex } from "viem";

/** The action an AI/MCP flow wants the wallet to perform. All numeric-but-large
 *  fields (valueWei, nonce) are strings so they survive JSON transport without
 *  precision loss; chainId/expiry stay plain numbers (safe-integer range). */
export interface IntentAction {
  chainId: number;
  target: string;
  functionName: string;
  args: string[];
  valueWei: string;
  nonce: string;
  expiry: number;
}

/** Fixed-shape EIP-712 struct definition for the Intent. Static field set so the
 *  type hash is constant regardless of how many args the action carries. */
const INTENT_TYPES = {
  Intent: [
    { name: "chainId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "functionName", type: "string" },
    { name: "argsHash", type: "bytes32" },
    { name: "valueWei", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/** Deterministically collapse the variable `args` into a single bytes32. Uses
 *  ABI encoding of the string array so distinct arg lists cannot collide by
 *  concatenation ambiguity ("a","bc" vs "ab","c") and identical lists always
 *  produce the identical hash. */
export function hashArgs(args: string[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "string[]" }], [args]));
}

/** Build the EIP-712 typed data for an action. The signer (wallet key) signs
 *  this; the verifier recomputes the exact same structure from the action it
 *  received and checks the signature against it. Shape:
 *  `{ domain, types, primaryType: "Intent", message }`. */
export function buildIntentTypedData(action: IntentAction) {
  return {
    domain: {
      name: "Aladdin Wallet Intent",
      version: "1",
      chainId: action.chainId,
    },
    types: INTENT_TYPES,
    primaryType: "Intent" as const,
    message: {
      chainId: BigInt(action.chainId),
      target: action.target as Address,
      functionName: action.functionName,
      argsHash: hashArgs(action.args),
      valueWei: BigInt(action.valueWei),
      nonce: BigInt(action.nonce),
      expiry: BigInt(action.expiry),
    },
  };
}

/** Adapt a raw `eth_sendTransaction` payload into the same `IntentAction`
 *  shape the signed-intent path (6.1) uses, so the sign-confirm popup can
 *  render an itemized "what the AI is asking to do" view for an AI/MCP-flagged
 *  origin. Pure + best-effort — no ABI lookup, no network:
 *   • data with a ≥4-byte selector → `functionName` is the selector hex
 *     (`0x` + first 4 bytes) and `args` carries the remaining calldata as a
 *     single hex string (`['0x…']`, or `['0x']` when only the selector is
 *     present).
 *   • empty / `0x` data → a native transfer: `functionName: 'transfer'`,
 *     `args: []`.
 *  `target` is checksummed via `getAddress`; `valueWei` is the decimal-string
 *  wei so it round-trips through JSON without bigint precision loss.
 *
 *  NOTE: this builds the human-legible action for DISPLAY + the security-engine
 *  gate. It is NOT signed/verified in the wallet flow — the tx approval itself
 *  is the consent (see `verifyIntent` below, kept as a utility for a future
 *  relayer-attestation path). */
export function buildIntentFromTx(
  tx: { to: string; data: `0x${string}`; value: bigint },
  chainId: number,
  nonce: string,
  expiry: number,
): IntentAction {
  const target = getAddress(tx.to);
  const valueWei = tx.value.toString();
  const data = (tx.data ?? "0x") as Hex;

  if (size(data) >= 4) {
    const functionName = slice(data, 0, 4); // '0x' + first 4 bytes
    // Remaining calldata after the selector. When the payload is exactly the
    // 4-byte selector (no args), `slice(data, 4)` would be an empty slice — use
    // '0x' explicitly so `args[0]` is always a valid hex string.
    const rest = size(data) > 4 ? slice(data, 4) : "0x";
    return { chainId, target, functionName, args: [rest], valueWei, nonce, expiry };
  }

  // Empty / short calldata → native transfer.
  return { chainId, target, functionName: "transfer", args: [], valueWei, nonce, expiry };
}

/** Verify that `signature` over `action` was produced by `expectedSigner`.
 *  Recomputes the typed data from `action` (so any tampering — changed args,
 *  target, value, etc. — yields different typed data and fails) and delegates
 *  to viem's `verifyTypedData`. Returns false rather than throwing on a bad
 *  signature so callers get a clean boolean gate. */
export async function verifyIntent(
  action: IntentAction,
  signature: Hex,
  expectedSigner: Address,
): Promise<boolean> {
  const typedData = buildIntentTypedData(action);
  try {
    return await verifyTypedData({
      address: expectedSigner,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
  } catch {
    return false;
  }
}
