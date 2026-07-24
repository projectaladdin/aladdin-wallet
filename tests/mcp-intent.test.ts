// tests/mcp-intent.test.ts
import { test, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { buildIntentTypedData, verifyIntent } from "../src/lib/mcp-intent";

const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const action = { chainId: 4663, target: "0x2222222222222222222222222222222222222222", functionName: "mint", args: ["1"], valueWei: "0", nonce: "7", expiry: 9_000_000_000 };

test("valid signed intent verifies", async () => {
  const sig = await acct.signTypedData(buildIntentTypedData(action) as any);
  expect(await verifyIntent(action, sig, acct.address)).toBe(true);
});
test("tampered action fails", async () => {
  const sig = await acct.signTypedData(buildIntentTypedData(action) as any);
  expect(await verifyIntent({ ...action, args: ["1000000"] }, sig, acct.address)).toBe(false);
});
