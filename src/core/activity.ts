// Wallet activity log. Captures every tx the popup is itself the
// signer for — `popup-send` user flows + the `eth_sendTransaction`
// branch of sign-confirm's approve(). Stored locally; the wallet
// does NOT call a remote indexer for this list (no Etherscan / no
// Alchemy). Per-row "open in explorer" links cover the case where
// the user wants the deeper view that only a real indexer can give.
//
// Storage layout:
//   chrome.storage.local.activity =
//     Record<chainId, Record<account-lowercased, ActivityEntry[]>>
//
// Per (chain × account) so switching chain or account in the wallet
// shows only the relevant history. Newest entries first (UI reverses
// nothing — append at index 0).
//
// Status is set ONCE at capture time as 'pending' (we have a tx hash
// but no receipt yet). A separate refresh path polls receipts and
// flips status. The current iteration keeps that polling client-side
// in the Activity screen — SW would burn CPU re-polling for every
// account on every wake.

import type { Address } from 'viem';
import { mutateKey } from './storage';

/** Classification of what the tx is "about" — drives the verbed
 *  label on each row ("sent", "approved", "swapped", "minted",
 *  "delegated"). Derived at capture time from the calldata decoder
 *  the same way sign-confirm's mode classifier does.
 *  v1 keeps a coarse set; future expansion (bridge / mint / unwrap)
 *  comes from extending the decoder rather than this enum. */
export type ActivityKind =
  | 'send'         // native transfer (no data)
  | 'erc20-transfer'
  | 'approve'      // ERC-20 / ERC-721 approve OR setApprovalForAll
  | 'nft-transfer'
  | 'contract-call'  // unrecognized calldata
  | 'deploy'       // contract creation (no `to`)
  | '7702'         // wallet_signAuthorization delegate change
  | 'sign-message'
  | 'sign-typed';

export type ActivityStatus = 'pending' | 'success' | 'failed';

export type ActivityEntry = {
  /** Tx hash on `chainId`. For sign-only ops (personal_sign /
   *  signTypedData / wallet_signAuthorization without a follow-up
   *  send) this is the signature itself, not an on-chain hash —
   *  status stays 'success' immediately. */
  hash: string;
  chainId: number;
  /** Wallet account that signed (lowercased 0x address). */
  account: string;
  kind: ActivityKind;
  /** Recipient / contract address for tx-shaped entries, or empty
   *  string for sign-only entries / contract deploys. */
  to: string;
  /** Native value in wei as a decimal string. '0' for non-payable calls. */
  value: string;
  /** Raw calldata hex (with leading 0x), or null when the tx is a
   *  bare native transfer. Stored so the Activity screen can decode
   *  ERC-20 / NFT amounts + spenders without re-fetching anything. */
  data?: string | null;
  /** Account nonce at broadcast time. Used to collapse a speed-up /
   *  cancel replacement (same nonce, different hash) onto the
   *  original row instead of showing two pending entries forever. */
  nonce?: number;
  /** ms since epoch — when the wallet's popup recorded the broadcast. */
  addedAt: number;
  status: ActivityStatus;
  /** Optional short label override (e.g. "approve USDC", "send 0.5 ETH").
   *  When omitted the UI synthesizes from `kind` + on-chain data. */
  label?: string;
  /** When a replacement tx (same nonce, different hash) supersedes
   *  this one, store the replacement hash here so the UI can show
   *  "replaced by 0xabc…". Kept as a flat field rather than a
   *  nested entry so the dedup logic stays simple. */
  replacedBy?: string;
};

type ByAccount = Record<string, ActivityEntry[]>;
type ByChain = Record<number, ByAccount>;

async function get<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] as T | undefined));
  });
}

const KEY = 'activity';
/** Soft cap per (chain, account) bucket — keep the storage object
 *  bounded so a year of activity doesn't blow up chrome.storage's
 *  per-key 8 KB-ish QUOTA_BYTES_PER_ITEM limit. Oldest entries past
 *  this cap roll off on every prepend. */
const MAX_PER_BUCKET = 200;

function bucketKey(account: string): string {
  return account.toLowerCase();
}

export async function listActivity(chainId: number, account: Address): Promise<ActivityEntry[]> {
  const all = (await get<ByChain>(KEY)) ?? {};
  const bucket = all[chainId]?.[bucketKey(account)] ?? [];
  return bucket;
}

export async function addActivity(entry: ActivityEntry): Promise<void> {
  await mutateKey<ByChain>(KEY, (cur) => {
    const all = cur ?? {};
    const chain = all[entry.chainId] ?? (all[entry.chainId] = {});
    const k = bucketKey(entry.account);
    const bucket = chain[k] ?? [];

    // Exact-hash dedup — re-recording the same broadcast (popup
    // re-render firing capture twice) silently no-ops.
    if (bucket.some((e) => e.hash.toLowerCase() === entry.hash.toLowerCase())) return all;

    // Nonce-aware speed-up / cancel dedup. If the bucket already has
    // a pending entry with the same nonce but a different hash, the
    // new entry is a replacement (user bumped gas in the dapp, or
    // sent a "cancel" tx with higher fee + zero-value-to-self).
    // Mark the old one as `replacedBy` + flip to 'failed' so it
    // doesn't sit pending forever; the new entry takes the live slot.
    if (entry.nonce !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        const e = bucket[i]!;
        if (
          e.nonce === entry.nonce &&
          e.status === 'pending' &&
          e.hash.toLowerCase() !== entry.hash.toLowerCase()
        ) {
          bucket[i] = { ...e, status: 'failed', replacedBy: entry.hash };
        }
      }
    }

    chain[k] = [entry, ...bucket].slice(0, MAX_PER_BUCKET);
    return all;
  });
}

export async function updateActivityStatus(
  chainId: number,
  account: Address,
  hash: string,
  status: ActivityStatus,
): Promise<void> {
  // Same serialisation rationale — refreshActivityStatuses fan-outs
  // 8 status flips in parallel; without mutateKey, last writer wins
  // and the other 7 flips disappear silently from storage.
  await mutateKey<ByChain>(KEY, (cur) => {
    const all = cur ?? {};
    const k = bucketKey(account);
    const bucket = all[chainId]?.[k];
    if (!bucket) return all;
    const idx = bucket.findIndex((e) => e.hash.toLowerCase() === hash.toLowerCase());
    if (idx < 0) return all;
    bucket[idx] = { ...bucket[idx]!, status };
    return all;
  });
}

/** Classify a tx by its shape (`to` / `data` / `value`) and a small
 *  selector lookup. Mirrors the popup's sign-confirm `deriveSignMode`
 *  classification but keeps this module self-contained so the SW can
 *  call it at broadcast time without importing popup-side code.
 *  Selectors are the canonical ERC-20 / ERC-721 ones — exactly the
 *  set the wallet's calldata decoder also recognizes. */
export function classifyTx(args: {
  to?: string | null;
  data?: string | null;
  value?: string | null;
}): ActivityKind {
  const to = args.to?.toLowerCase() ?? '';
  const data = (args.data ?? '0x').toLowerCase();
  // No `to` (or zero address) = contract creation.
  if (!to || to === '0x' || /^0x0+$/.test(to)) return 'deploy';
  if (data === '' || data === '0x') return 'send';
  const sel = data.slice(0, 10);
  if (sel === '0xa9059cbb') return 'erc20-transfer';        // transfer(address,uint256)
  if (sel === '0x23b872dd') return 'erc20-transfer';        // transferFrom(address,address,uint256)
  if (sel === '0x42842e0e') return 'nft-transfer';          // safeTransferFrom(address,address,uint256) — 721
  if (sel === '0xf242432a') return 'nft-transfer';          // safeTransferFrom(address,address,uint256,uint256,bytes) — 1155
  if (sel === '0x095ea7b3') return 'approve';               // approve(address,uint256)
  if (sel === '0xa22cb465') return 'approve';               // setApprovalForAll(address,bool)
  return 'contract-call';
}
