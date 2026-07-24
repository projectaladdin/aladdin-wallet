// src/shared/rh-chains.ts
import { defineChain, type Chain } from "viem";

export const RH_MAINNET_ID = 4663;
export const RH_TESTNET_ID = 46630;

const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export const robinhoodMainnet: Chain = defineChain({
  id: RH_MAINNET_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: RH_EXPLORER, apiUrl: `${RH_EXPLORER}/api` } },
});

export const robinhoodTestnet: Chain = defineChain({
  id: RH_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: RH_EXPLORER, apiUrl: `${RH_EXPLORER}/api` } },
  testnet: true,
});

export function isRobinhoodChain(chainId: number): boolean {
  return chainId === RH_MAINNET_ID || chainId === RH_TESTNET_ID;
}

/** Blockscout REST API base for a chain, or null if the chain isn't Blockscout-backed. */
export function blockscoutApiBaseFor(chainId: number): string | null {
  return isRobinhoodChain(chainId) ? `${RH_EXPLORER}/api` : null;
}
