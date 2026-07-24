// tests/intent-from-tx.test.ts
//
// Pins `buildIntentFromTx` — the pure adapter that turns a raw
// `eth_sendTransaction` payload into the same `IntentAction` shape 6.1 uses.
// Best-effort decode: a ≥4-byte selector becomes the `functionName` (selector
// hex) with the remaining calldata carried in `args[0]`; empty calldata is a
// native transfer (`functionName: 'transfer'`, `args: []`). Target is always
// checksummed; value is the decimal-string wei.

import { test, expect } from "bun:test";
import { getAddress } from "viem";
import { buildIntentFromTx } from "../src/lib/mcp-intent";

const LOWER = "0x2222222222222222222222222222222222222222";

test("selector call → functionName is the 4-byte selector, args carries remaining calldata", () => {
  // transfer(address,uint256): selector 0xa9059cbb + two 32-byte args.
  const selector = "0xa9059cbb";
  const arg1 = "0".repeat(24) + "1111111111111111111111111111111111111111"; // address, left-padded
  const arg2 = "0".repeat(63) + "5"; // uint256 = 5
  const data = (selector + arg1 + arg2) as `0x${string}`;

  const action = buildIntentFromTx({ to: LOWER, data, value: 1000n }, 4663, "7", 9_000_000_000);

  expect(action.functionName).toBe(selector);
  expect(action.args).toHaveLength(1);
  expect(action.args[0]).toBe("0x" + arg1 + arg2);
  expect(action.valueWei).toBe("1000");
  expect(action.chainId).toBe(4663);
  expect(action.nonce).toBe("7");
  expect(action.expiry).toBe(9_000_000_000);
});

test("empty-data native transfer → functionName 'transfer', args []", () => {
  const action = buildIntentFromTx({ to: LOWER, data: "0x", value: 5n }, 1, "0", 0);
  expect(action.functionName).toBe("transfer");
  expect(action.args).toEqual([]);
  expect(action.valueWei).toBe("5");
});

test("target is checksummed", () => {
  const action = buildIntentFromTx({ to: LOWER, data: "0x", value: 0n }, 1, "0", 0);
  expect(action.target).toBe(getAddress(LOWER));
});
