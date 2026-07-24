// Message protocol — shared by inject.ts (page MAIN world) ↔ content.ts
// (extension ISOLATED world) ↔ background.ts (service worker) ↔ popup.tsx.
//
// Three transports:
//   page ⇄ content      : window.postMessage + DOM CustomEvent
//   content ⇄ background : chrome.runtime.sendMessage / port
//   popup ⇄ background   : chrome.runtime.sendMessage
//
// All messages are tagged with `kind` so each layer can route blindly.

import type { StoredScope } from '../lib/grant-scope';

// Stable string tag on every message that crosses page ↔ content via
// window.postMessage. Without this we'd accidentally consume MetaMask's or
// other wallets' messages.
export const PROTO_TAG = 'aladdin-wallet-v1';

/** Generic JSON-RPC shape — we accept arbitrary methods and forward unknown
 *  ones to the active chain's RPC (Layer 3 passthrough). The dispatcher in
 *  background.ts narrows on `method` at runtime. */
export type RpcRequest = {
  method: string;
  params?: unknown;
};

export type RpcSuccess = { jsonrpc: '2.0'; id: number | string; result: unknown };
export type RpcError = {
  jsonrpc: '2.0';
  id: number | string;
  error: { code: number; message: string; data?: unknown };
};
export type RpcResponse = RpcSuccess | RpcError;

// page → content (window.postMessage)
export type PageToContent =
  | { kind: 'rpc-request'; tag: typeof PROTO_TAG; id: string; payload: RpcRequest }
  | { kind: 'announce'; tag: typeof PROTO_TAG };

// content → page (window.postMessage)
export type ContentToPage =
  | { kind: 'rpc-response'; tag: typeof PROTO_TAG; id: string; response: RpcResponse }
  | {
      kind: 'event';
      tag: typeof PROTO_TAG;
      event: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
      data: unknown;
    };

// content/popup → background (chrome.runtime.sendMessage)
export type ToBackground =
  | { kind: 'rpc-from-page'; origin: string; payload: RpcRequest }
  | { kind: 'list-pending-requests' }
  | {
      kind: 'approve-pending-request';
      id: string;
      password: string;
      /** Optional calldata override applied to an `eth_sendTransaction`
       *  pending request before signing — used by the approve-mode toggle
       *  so the user can bump a finite allowance to uint256.max (or the
       *  reverse: cap an unlimited request). Ignored for non-tx requests. */
      txOverride?: { data?: `0x${string}` };
    }
  | { kind: 'reject-pending-request'; id: string }
  | { kind: 'reject-pending-from-origin'; origin: string }
  | { kind: 'unlock'; password: string }
  | { kind: 'lock' }
  | { kind: 'is-unlocked' }
  | { kind: 'get-account' }
  | { kind: 'switch-chain'; chainId: number; rpcUrl?: string }
  | { kind: 'remove-chain'; chainId: number; rpcUrl: string }
  | { kind: 'get-current-chain' }
  | { kind: 'list-connected-origins' }
  | { kind: 'list-connected-sites' }
  | { kind: 'revoke-origin'; origin: string }
  | { kind: 'get-auto-lock' }
  | { kind: 'set-auto-lock'; minutes: number }
  | { kind: 'list-tokens' }
  | { kind: 'add-token'; address: string }
  | { kind: 'remove-token'; address: string }
  | { kind: 'read-token-balances' }
  // Stale-while-revalidate variant: returns last persisted balances
  // for the current (chainId, owner) regardless of TTL, plus the
  // `fetchedAt` timestamp. Popup paints with this on first frame
  // then fires `read-token-balances` to refresh. Returns null when
  // there's nothing cached for this account/chain yet.
  | { kind: 'read-token-balances-stale' }
  | { kind: 'read-token-info'; addresses: string[] }
  // NFT v1 — manual add by (contract, tokenId). Auto-discovery via an
  // indexer is a future iteration; for now the wallet only stores what
  // the user explicitly adds.
  | { kind: 'list-nfts' }
  // Single-NFT import — tokenId required. Response is `NftRecord[]`
  // (always length 1) so the popup keeps one response shape.
  | { kind: 'add-nft'; address: string; tokenId: string }
  | { kind: 'remove-nft'; address: string; tokenId: string }
  // Re-read balanceOf for a single ERC-1155 entry. ERC-721 always
  // resolves to "1" so calling on a 721 is a fast no-op. Response is
  // the updated NftRecord (balance refreshed, other fields unchanged).
  | { kind: 'refresh-nft-balance'; address: string; tokenId: string }
  // Activity log — popup-side broadcasts (popup-send + sign-confirm
  // approve of eth_sendTransaction) write here at capture time;
  // dashboard's Activity screen lists by (chain, account). Status
  // starts at 'pending'; `refresh-activity-status` polls receipts
  // for every still-pending hash and flips to success/failed.
  | { kind: 'list-activity' }
  | { kind: 'refresh-activity-status' }
  // ENS resolution — viem on Ethereum mainnet (the canonical ENS
  // registry). Resolves `<name>.eth` (or any name) to an address;
  // null when the name has no resolver / no address record. The
  // popup uses this on the Send screen recipient input so users can
  // type `vitalik.eth` instead of a 40-char hex blob.
  | { kind: 'resolve-ens'; name: string }
  // Reverse ENS — given an address, return its primary ENS name (the
  // one set via `setName` on the canonical reverse resolver) or null.
  // Cached SW-side because the lookup is multi-hop (resolver →
  // node → text record). Used by Activity rows, Send recipient hint,
  // and Connect screen to humanize 40-hex addresses.
  | { kind: 'resolve-ens-name'; address: string }
  // Returns deployed bytecode at `address` on `chainId` (hex string,
  // `0x` if nothing's there). Used by the 7702 sign-confirm to detect
  // delegation targets that aren't actually contracts (signing those
  // bricks the EOA — every call routes into empty code).
  | { kind: 'get-code'; chainId: number; address: string }
  // 7702 verify lookup result, prefetched by the SW as soon as
  // `wallet_signAuthorization` enters the pending queue. Popup pulls
  // the cached result so the slide gate shows resolved state on first
  // paint instead of "verifying…" for ~1s while Sourcify responds.
  // Returns null when the SW hasn't started a lookup for this target
  // (e.g. popup opened a 7702 request from an older session).
  | { kind: 'get-7702-verify'; chainId: number; address: string }
  // Contract ABI lookup (Sourcify), used by the calldata decoder's
  // fallback path when the bundled selector-table.ts misses an
  // `eth_sendTransaction`'s function. SW prefetches when the request
  // enters the queue so the popup gets a resolved ABI on first paint.
  // Returns `unknown[]` (the ABI array) or null on miss / verifier
  // unreachable / SW hadn't seen this address yet.
  | { kind: 'get-contract-abi'; chainId: number; address: string }
  | { kind: 'list-accounts' }
  | { kind: 'add-account' }
  | { kind: 'switch-account'; index: number }
  | { kind: 'rename-account'; index: number; label: string }
  | { kind: 'reset-accounts' }
  | { kind: 'reveal-mnemonic'; password: string }
  | { kind: 'reset-wallet' }
  | {
      kind: 'popup-send';
      tx: {
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: `0x${string}`;
      };
      /** Gas tier multiplier on the network's auto-estimated fees. Defaults
       *  to 'normal' (1×) if omitted. */
      gasTier?: 'slow' | 'normal' | 'fast';
    }
  | { kind: 'estimate-tx-cost'; tx: { to: `0x${string}`; data?: `0x${string}`; value?: `0x${string}` } }
  | {
      kind: 'simulate-tx';
      tx: {
        from?: `0x${string}`;
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: `0x${string}`;
      };
    }
  | { kind: 'get-hide-zero' }
  | { kind: 'set-hide-zero'; value: boolean }
  | { kind: 'get-currency' }
  | { kind: 'set-currency'; value: 'eth' | 'usd' }
  | { kind: 'get-dev-flags' }
  | {
      kind: 'set-dev-flag';
      /** Must be a key of DevFlags (rpcTrace, allowUnverifiedDelegate, …).
       *  Kept as a string union here rather than `keyof DevFlags` to
       *  avoid cross-file type entanglement; the SW dispatcher coerces
       *  to the storage layer's typed setter. */
      key: 'rpcTrace' | 'allowUnverifiedDelegate';
      value: boolean;
    }
  // ── ERC-7715 scoped grants — list/revoke stored permission grants
  // for a (chain, account). Handlers land in a later task (3.4/4.3);
  // this is protocol wiring + types only.
  | { kind: 'list-grants'; chainId: number; account: string }
  | { kind: 'revoke-grant'; id: string }
  // ── AI/MCP-flagged origins (Task 6.2) — opt-in per-origin flag. When set,
  // the sign-confirm popup renders the itemized intent for that origin's
  // eth_sendTransaction and gates Approve behind an explicit acknowledgement
  // (prompt-injection defense; the AI chat is treated as untrusted).
  | { kind: 'list-ai-origins' }
  | { kind: 'set-ai-origin'; origin: string; on: boolean };

// background → caller
export type FromBackground =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: number };

/** Pending interaction the popup must surface to the user.
 *  `chainId` and `accountIndex` are SNAPSHOTTED at queue time so a
 *  user switching chain / account in another popup mid-flow doesn't
 *  silently sign for a different chain or different account than
 *  the popup is rendering. Both are mandatory at the type level — the
 *  enqueue path in background.ts fills them; sign() asserts equality
 *  before broadcasting. */
export type PendingRequest = {
  id: string;
  origin: string;
  payload: RpcRequest;
  createdAt: number;
  /** Wallet's active chain at the moment the dapp called. The approve
   *  path refuses to broadcast if the wallet has since switched. */
  chainId: number;
  /** Wallet's active HD account index at queue time. `sign()` derives
   *  from THIS index, not whatever's active when the user clicks
   *  approve. */
  accountIndex: number;
  /** ERC-7715 `wallet_grantPermissions` only: the bounded scope the dapp
   *  asked for, already parsed + normalized + SERIALIZED at queue time.
   *  Rides along so the sign-confirm popup (Task 4.2) can render CAN/CANNOT
   *  and so `approve()` can persist the grant without re-parsing.
   *
   *  Stored as the JSON-safe `StoredScope` (string-encoded bigints) rather
   *  than the in-memory `NormalizedScope`, because a `PendingRequest` is
   *  shipped whole to the popup via `chrome.runtime` messaging on
   *  `list-pending-requests` — that transport is JSON-based and cannot carry
   *  bigint. `deserializeScope` reconstitutes the `NormalizedScope` popup-side. */
  grantScope?: StoredScope;
};

/** Methods that require the user to approve in the popup before signing.
 *  `eth_sign` is intentionally excluded — it signs a raw 32-byte hash with
 *  no prefix, indistinguishable from a real tx hash. The dispatcher rejects
 *  it with EIP-1474 4200 before any popup ever opens. */
export const SIGN_METHODS = new Set<string>([
  // ── eth_* signing, ascending risk ──
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  // v3 is normalized to v4 inside background.handleRpcFromPage; we never see
  // it as a distinct payload past that point.
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  // ── wallet_* state mutations, ascending risk ──
  // EIP-747 — dapp suggests a token. Approval = persist to storage + return true.
  'wallet_watchAsset',
  // EIP-7702 — gives a smart contract full control over the EOA. Highest risk.
  'wallet_signAuthorization',
]);

/** wallet_* methods our dispatcher knows about. Anything else with the
 *  `wallet_` prefix should be rejected with a 4200 (unsupported method)
 *  rather than silently forwarded to the chain RPC, per chrome.md §3.
 *  Order: read-only / no popup → state mutations → signing. */
export const KNOWN_WALLET_METHODS = new Set<string>([
  // ── EIP-2255 permissions (Layer 1 fast path / connect coalesce) ──
  'wallet_requestPermissions',
  // ── ERC-7715 scoped-permission request ──
  'wallet_grantPermissions',
  'wallet_getPermissions',
  'wallet_revokePermissions',
  // ── Capabilities discovery ──
  'wallet_getCapabilities',
  // ── EIP-3326/-2566 chain ops (state mutation) ──
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  // ── EIP-747 token suggestion (state mutation, popup) ──
  'wallet_watchAsset',
  // ── EIP-7702 signing (highest risk) ──
  'wallet_signAuthorization',
]);
