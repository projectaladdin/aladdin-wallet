// tests/rh-chains.test.ts
import { test, expect } from "bun:test";
import {
  RH_MAINNET_ID, RH_TESTNET_ID, robinhoodMainnet, robinhoodTestnet,
  isRobinhoodChain, blockscoutApiBaseFor,
} from "../src/shared/rh-chains";

test("RH mainnet chain shape", () => {
  expect(RH_MAINNET_ID).toBe(4663);
  expect(robinhoodMainnet.id).toBe(4663);
  expect(robinhoodMainnet.nativeCurrency.symbol).toBe("ETH");
  expect(robinhoodMainnet.rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
  expect(robinhoodMainnet.blockExplorers?.default.url).toBe("https://robinhoodchain.blockscout.com");
});

test("RH testnet is flagged testnet", () => {
  expect(RH_TESTNET_ID).toBe(46630);
  expect(robinhoodTestnet.testnet).toBe(true);
  expect(robinhoodTestnet.rpcUrls.default.http[0]).toBe("https://rpc.testnet.chain.robinhood.com");
});

test("isRobinhoodChain / blockscoutApiBaseFor", () => {
  expect(isRobinhoodChain(4663)).toBe(true);
  expect(isRobinhoodChain(46630)).toBe(true);
  expect(isRobinhoodChain(1)).toBe(false);
  expect(blockscoutApiBaseFor(4663)).toBe("https://robinhoodchain.blockscout.com/api");
  expect(blockscoutApiBaseFor(1)).toBeNull();
});
