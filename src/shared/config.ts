// General-purpose EIP-7702 wallet: ships with mainnet + sepolia builtin,
// users can add any other EVM chain at runtime via wallet_addEthereumChain
// or the popup's "Add chain" form.

import { mainnet, sepolia, type Chain } from 'viem/chains';
import type { Address } from 'viem';
import { robinhoodMainnet, robinhoodTestnet, RH_MAINNET_ID } from './rh-chains';
import { ICON_DATA_URL } from './icon-data-url';

export type Network = {
  chain: Chain;
  rpcUrl: string;
};

export const BUILTIN_NETWORKS: Record<number, Network> = {
  [robinhoodMainnet.id]: { chain: robinhoodMainnet, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
  [robinhoodTestnet.id]: { chain: robinhoodTestnet, rpcUrl: 'https://rpc.testnet.chain.robinhood.com' },
  [mainnet.id]: {
    chain: mainnet,
    // PublicNode is more reliable than llamarpc — llamarpc fronts a pool of
    // upstreams and occasionally returns plain-text error pages instead of
    // JSON-RPC, breaking viem's parser.
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
  },
  [sepolia.id]: {
    chain: sepolia,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
};

// Default for fresh installs only — existing users keep their persisted
// chain choice via getCurrentChainId() in core/storage.ts. Defaults to
// Robinhood Chain mainnet (RH_MAINNET_ID, 4663) — the wallet's primary
// network — so new installs land there rather than on a testnet or on
// Ethereum mainnet.
export const DEFAULT_CHAIN_ID = RH_MAINNET_ID;

/** Chain registry used by the sign-confirm chain badge. Limited to the
 *  networks this wallet actually ships with (BUILTIN_NETWORKS) — the source
 *  of truth for `chain.name` + `chain.testnet` is viem's own definitions
 *  imported above. Anything outside this set falls back to `chain {N}` in
 *  the badge. Adding a new shipped chain = extending BUILTIN_NETWORKS;
 *  the registry tracks it automatically. */
export const VIEM_CHAIN_REGISTRY: Record<number, Chain> = Object.fromEntries(
  Object.entries(BUILTIN_NETWORKS).map(([id, n]) => [id, n.chain]),
);

// Builtin ERC-20 tokens displayed on the dashboard for the chains we ship with
// (mainnet + Sepolia). Merged with user-added tokens (dedupe by address); the
// remove-button is suppressed for builtins. User-added custom chains get no
// defaults — token deploys vary per deployment.
export type BuiltinToken = {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
};

export const BUILTIN_TOKENS: Record<number, BuiltinToken[]> = {
  // Ethereum mainnet
  [mainnet.id]: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin',       symbol: 'USDC', decimals: 6  },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', name: 'Tether USD',     symbol: 'USDT', decimals: 6  },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', name: 'Dai Stablecoin', symbol: 'DAI',  decimals: 18 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', name: 'Wrapped Ether',  symbol: 'WETH', decimals: 18 },
  ],
  // Sepolia — only Circle's official testnet USDC has a stable address.
  [sepolia.id]: [
    { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', name: 'USD Coin (Sepolia)', symbol: 'USDC', decimals: 6 },
  ],
};

// Brand metadata announced via EIP-6963.
export const WALLET_INFO = {
  uuid: 'a1b2c3d4-a1ad-4d1a-8f0c-000000000001',
  name: 'Aladdin Wallet',
  icon: ICON_DATA_URL,
  rdns: 'wallet.aladdin',
} as const;
