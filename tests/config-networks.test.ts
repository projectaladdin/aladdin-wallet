// tests/config-networks.test.ts
import { test, expect } from "bun:test";
import { BUILTIN_NETWORKS, DEFAULT_CHAIN_ID } from "../src/shared/config";

test("RH mainnet is the default network", () => {
  expect(DEFAULT_CHAIN_ID).toBe(4663);
});

test("RH + ETH networks are all built in", () => {
  const ids = Object.keys(BUILTIN_NETWORKS).map(Number);
  for (const id of [4663, 46630, 1, 11155111]) expect(ids).toContain(id);
  expect(BUILTIN_NETWORKS[4663].rpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
});
