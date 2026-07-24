// Thin promisified wrapper around chrome.storage.local. Used for the
// encrypted vault + connected origins + active chain id + custom networks.

import type { EncryptedVault } from './crypto';
import { BUILTIN_NETWORKS, DEFAULT_CHAIN_ID, type Network } from '../shared/config';
import type { GrantRecord } from '../lib/grant-scope';

const KEYS = {
  vault: 'vault',                   // EncryptedVault | undefined
  connectedOrigins: 'connected',    // string[] (origins user has authorized)
  aiOrigins: 'aiOrigins',           // string[] (origins the user flagged as an AI/MCP agent)
  currentChainId: 'currentChainId', // number — active chain (defaults to mainnet)
  customChains: 'customChains',     // Record<chainId, Network>
  autoLockMinutes: 'autoLockMin',   // number — minutes idle before auto-lock (0 = SW lifecycle only)
  tokens: 'tokens',                 // Record<chainId, Record<addressLower, TokenRecord>>
  accounts: 'accounts',             // AccountRecord[] — HD-derived account list (BIP-44 indices)
  activeAccountIndex: 'activeAcct', // number — which account is currently selected
  hideZero: 'hideZero',             // boolean — hide tokens with balance 0 from dashboard
  currency: 'currency',              // 'eth' | 'usd' — display currency for balance values
  currentRpcUrl: 'currentRpcUrl',    // string | undef — preferred rpcUrl when chainId has multiple
  originAccountMap: 'originAcctMap', // Record<origin, accountIndex> — per-dapp account memory
  devFlags: 'devFlags',              // DevFlags — opt-in developer toggles (rpc trace, …)
  nfts: 'nfts',                      // Record<chainId, Record<contract::tokenId, NftRecord>>
  activity: 'activity',              // Record<chainId, Record<account, ActivityEntry[]>> — popup-broadcast tx history
  grants: 'grants',                  // Record<chainIdString, Record<accountLower, GrantRecord[]>> — 7702/session permission registry
} as const;

/** Display currency for the dashboard / token rows / send-screen previews.
 *  Default 'usd'. Backend also fetches an ETH/USD spot rate so the UI can
 *  render balances denominated in ETH; if the rate is unavailable (e.g.
 *  network blip) the UI falls back to the raw USD value with a `$` prefix. */
export type Currency = 'eth' | 'usd';

/** Developer/app toggles. `rpcTrace` is off by default; `allowUnverifiedDelegate`
 *  defaults ON for this app-dedicated wallet (see its doc below). */
export type DevFlags = {
  /** When true, the SW prints `[rpc] method origin=… params=…` for every
   *  incoming dapp RPC. Useful when chasing "why did this dapp fire two
   *  signs for one click" without a rebuild. */
  rpcTrace?: boolean;
  /** Override for the EIP-7702 source-verification gate: when true the
   *  popup lets the user confirm a delegation even if the delegate
   *  contract isn't source-verified on Sourcify/Blockscout.
   *
   *  DEFAULT ON for this app-dedicated wallet — users create a fresh
   *  wallet for the app and delegate to the app's OWN contracts, which
   *  may not be source-verified (pre-verification, or a custom Blockscout
   *  deploy). `getDevFlags` defaults it to `true` when unset; an explicit
   *  OFF in Settings is respected for that session.
   *
   *  SESSION-SCOPED: an explicit value lives in `chrome.storage.session`
   *  and is cleared on `lock`, after which it returns to the ON default. */
  allowUnverifiedDelegate?: boolean;
};

/** Keys of DevFlags that the popup can toggle via `set-dev-flag`.
 *  Kept here (not in protocol.ts) so the boolean-only invariant lives
 *  next to the type that documents it. */
export type DevFlagKey = keyof DevFlags;

/** Default auto-lock timer (minutes). User can adjust in Settings.
 *  Must be one of the values offered by the Settings UI so the UI shows a
 *  highlighted default before the user has explicitly picked. */
const DEFAULT_AUTO_LOCK_MINUTES = 30;

async function get<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] as T | undefined));
  });
}

async function set<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      // Surface chrome.runtime.lastError. Pre-fix this was silently
      // swallowed — a QUOTA_BYTES-exceeded write looked successful to
      // the caller while the data was dropped, so addActivity /
      // addToken / addNft would silently no-op while the popup's
      // optimistic state still showed the row. Propagating the error
      // lets the popup show a "storage full" toast.
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`chrome.storage.local.set(${key}) failed: ${err.message}`));
      else resolve();
    });
  });
}

async function remove(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`chrome.storage.local.remove(${key}) failed: ${err.message}`));
      else resolve();
    });
  });
}

/** Per-key serial queue for read-modify-write operations on
 *  chrome.storage.local. The naive pattern
 *      const x = await get(k); mutate(x); await set(k, x);
 *  has a TOCTOU window — two concurrent callers each read the same
 *  starting value, each mutate it, the second `set` wins and the
 *  first's mutation is lost. Symptoms in this wallet have included
 *  `addConnectedOrigin` losing freshly-approved origins under fast
 *  double-clicks, and `updateActivityStatus` dropping status flips
 *  when a popup-send races with a dapp tx.
 *
 *  `mutateKey(key, fn)` runs `fn` against a fresh read of `key`,
 *  writes the result, and ensures every other `mutateKey(sameKey)`
 *  call waits its turn. Different keys still proceed in parallel. */
const writeLocks = new Map<string, Promise<void>>();
export async function mutateKey<T>(
  key: string,
  fn: (current: T | undefined) => Promise<T> | T,
): Promise<void> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* don't propagate prior failure to this caller */ })
    .then(async () => {
      const cur = await get<T>(key);
      const result = await fn(cur);
      await set(key, result);
    });
  writeLocks.set(key, next);
  try {
    await next;
  } finally {
    // Clean up only if we're still the latest writer for this key
    // (a faster caller may have already replaced it).
    if (writeLocks.get(key) === next) writeLocks.delete(key);
  }
}

export async function getVault(): Promise<EncryptedVault | undefined> {
  return get<EncryptedVault>(KEYS.vault);
}

export async function setVault(v: EncryptedVault): Promise<void> {
  return set(KEYS.vault, v);
}

export async function clearVault(): Promise<void> {
  return remove(KEYS.vault);
}

export async function hasVault(): Promise<boolean> {
  return (await getVault()) !== undefined;
}

export async function getConnectedOrigins(): Promise<string[]> {
  return (await get<string[]>(KEYS.connectedOrigins)) ?? [];
}

export async function addConnectedOrigin(origin: string): Promise<void> {
  await mutateKey<string[]>(KEYS.connectedOrigins, (cur) => {
    const list = cur ?? [];
    return list.includes(origin) ? list : [...list, origin];
  });
}

export async function removeConnectedOrigin(origin: string): Promise<void> {
  await mutateKey<string[]>(KEYS.connectedOrigins, (cur) => {
    return (cur ?? []).filter((o) => o !== origin);
  });
}

// ─── AI/MCP-flagged origins (Task 6.2) ─────────────────────────────────────
// Opt-in per-origin flag. When the user marks an origin as an "AI agent", the
// sign-confirm layer treats that origin's `eth_sendTransaction` as
// attacker-influenced (prompt-injection defense): it renders the itemized
// intent and requires an explicit acknowledgement before Approve. Stored as a
// simple allow-list of origins, mirroring `connectedOrigins`. Purely additive —
// an origin being AI-flagged never changes its connection/permission state.

export async function getAiOrigins(): Promise<string[]> {
  return (await get<string[]>(KEYS.aiOrigins)) ?? [];
}

export async function isAiOrigin(origin: string): Promise<boolean> {
  return (await getAiOrigins()).includes(origin);
}

export async function setAiOrigin(origin: string, on: boolean): Promise<void> {
  await mutateKey<string[]>(KEYS.aiOrigins, (cur) => {
    const list = cur ?? [];
    if (on) return list.includes(origin) ? list : [...list, origin];
    return list.filter((o) => o !== origin);
  });
}

// ─── Active chain + custom networks ────────────────────────────────────────

/**
 * Custom networks store. Network has a viem `Chain` object which contains
 * functions and won't survive structuredClone into chrome.storage. Persist
 * as the inputs only and rehydrate via viem's `defineChain` on read.
 */
type CustomNetworkRecord = {
  chainId: number;
  name: string;
  rpcUrl: string;
  symbol?: string;
  blockExplorer?: string;
};

export async function getCurrentChainId(): Promise<number> {
  return (await get<number>(KEYS.currentChainId)) ?? DEFAULT_CHAIN_ID;
}

export async function setCurrentChainId(chainId: number): Promise<void> {
  return set(KEYS.currentChainId, chainId);
}

/** Composite key for custom records: `${chainId}:${rpcUrl.toLowerCase()}`.
 *  Lets a single chainId have multiple parallel entries (e.g. "Ethereum via
 *  PublicNode" + "Ethereum via Alchemy" + "Ethereum via local Anvil fork"
 *  all coexist). Builtins remain keyed by chainId in `BUILTIN_NETWORKS` and
 *  are merged on read. */
function customKey(chainId: number, rpcUrl: string): string {
  return `${chainId}:${rpcUrl.toLowerCase()}`;
}

async function getCustomRecords(): Promise<Record<string, CustomNetworkRecord>> {
  return (await get<Record<string, CustomNetworkRecord>>(KEYS.customChains)) ?? {};
}

export async function addCustomChain(rec: CustomNetworkRecord): Promise<void> {
  // Lowercase the stored rpcUrl too (matching customKey) so currentRpcUrl
  // comparisons in getCurrentNetwork can do exact-equality without a
  // case-fold dance — and so re-adding the same logical RPC with different
  // casing actually overwrites instead of producing a parallel entry that's
  // visually duplicate on the picker.
  const normalized: CustomNetworkRecord = { ...rec, rpcUrl: rec.rpcUrl.toLowerCase() };
  await mutateKey<Record<string, CustomNetworkRecord>>(KEYS.customChains, (cur) => {
    const all = cur ?? {};
    all[customKey(normalized.chainId, normalized.rpcUrl)] = normalized;
    return all;
  });
}

export async function removeCustomChain(chainId: number, rpcUrl: string): Promise<void> {
  await mutateKey<Record<string, CustomNetworkRecord>>(KEYS.customChains, (cur) => {
    const all = cur ?? {};
    delete all[customKey(chainId, rpcUrl)];
    return all;
  });
  // If the deleted entry was the user's persisted RPC preference, clear it.
  const preferred = await get<string>(KEYS.currentRpcUrl);
  if (preferred && preferred === rpcUrl.toLowerCase()) {
    await remove(KEYS.currentRpcUrl);
  }
}

/** Resolve current network for the active chainId. When multiple custom
 *  entries share the chainId, prefer the one matching the user-set
 *  `currentRpcUrl` (latest switch); otherwise pick the first custom in
 *  insertion order; finally fall back to the builtin entry. */
export async function getCurrentNetwork(): Promise<Network> {
  const chainId = await getCurrentChainId();
  const customs = await getCustomRecords();
  const matches = Object.values(customs).filter((c) => c.chainId === chainId);
  if (matches.length > 0) {
    const preferred = await get<string>(KEYS.currentRpcUrl);
    const hit = preferred ? matches.find((c) => c.rpcUrl === preferred) : undefined;
    return rehydrateCustom(hit ?? matches[0]!);
  }
  const b = BUILTIN_NETWORKS[chainId];
  if (b) return b;
  throw new Error(`current chainId ${chainId} no longer in builtin or custom list`);
}

/** Persist the user's RPC choice when there are multiple entries for the
 *  same chainId. Used by switchChain so the chain pill reflects "Ethereum
 *  via Alchemy" vs "Ethereum via PublicNode" stably across SW restarts.
 *  Pass `undefined` to clear the preference (storage.remove rather than
 *  writing `undefined`, which left a stale empty entry behind).
 *
 *  Lowercased on persist to match the customKey storage convention. Without
 *  this, a user-typed `https://ETH.example.com` saved here would mismatch
 *  the lowercased rpcUrl coming back from `getCustomRecords()` rehydration,
 *  silently falling back to first-match. */
export async function setCurrentRpcUrl(rpcUrl: string | undefined): Promise<void> {
  if (rpcUrl === undefined) return remove(KEYS.currentRpcUrl);
  return set(KEYS.currentRpcUrl, rpcUrl.toLowerCase());
}

/** Get every selectable network (builtin + every custom record). Multiple
 *  entries with the same chainId are kept distinct — UI disambiguates by
 *  `chain.name` + `rpcUrl`. Order: builtins first, then customs in
 *  insertion order. */
export async function listAllNetworks(): Promise<Network[]> {
  const customs = await getCustomRecords();
  const out: Network[] = [];
  for (const n of Object.values(BUILTIN_NETWORKS)) out.push(n);
  for (const c of Object.values(customs)) out.push(rehydrateCustom(c));
  return out;
}

// ─── ERC-20 token list (per chain) ─────────────────────────────────────────
// User-added tokens that the dashboard should display balances for.
// Stored per chain since the same address can mean a different token on
// different chains (or be absent).

export type TokenRecord = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
};

type TokensByChain = Record<number, Record<string, TokenRecord>>;

async function getAllTokens(): Promise<TokensByChain> {
  return (await get<TokensByChain>(KEYS.tokens)) ?? {};
}

export async function listTokens(chainId: number): Promise<TokenRecord[]> {
  const all = await getAllTokens();
  return Object.values(all[chainId] ?? {});
}

export async function addTokenRecord(chainId: number, token: TokenRecord): Promise<void> {
  await mutateKey<TokensByChain>(KEYS.tokens, (cur) => {
    const all = cur ?? {};
    if (!all[chainId]) all[chainId] = {};
    all[chainId]![token.address.toLowerCase()] = {
      ...token,
      address: token.address.toLowerCase(),
    };
    return all;
  });
}

export async function removeTokenRecord(chainId: number, address: string): Promise<void> {
  await mutateKey<TokensByChain>(KEYS.tokens, (cur) => {
    const all = cur ?? {};
    if (all[chainId]) {
      delete all[chainId]![address.toLowerCase()];
    }
    return all;
  });
}

// ─── NFTs (manual add by contract+tokenId) ───────────────────────────────
// v1 NFT support: no auto-discovery (would need an external indexer).
// User pastes contract address + tokenId; wallet reads on-chain metadata
// and stores the result for offline display.
//
// Storage layout: Record<chainId, Record<"contract::tokenId", NftRecord>>.
// Composite-string key keeps the dedupe/lookup semantics aligned with how
// tokens are stored, just with a wider key space (a single contract has
// many tokenIds).

export type NftRecord = {
  /** Contract address — lowercased on persist. */
  address: string;
  /** Token id as a decimal string (uint256 fits in JS BigInt but bigint
   *  doesn't survive JSON.stringify, so we serialise as a base-10 string). */
  tokenId: string;
  /** Token-standard tag — affects how the dispatcher reads metadata
   *  (tokenURI vs uri) and how a future Send-NFT flow encodes calldata
   *  (transferFrom vs safeTransferFrom). */
  standard: 'ERC721' | 'ERC1155';
  /** Display name. Best-effort: from metadata.name; falls back to a
   *  derived "<symbol> #<tokenId>" if metadata fetch failed. */
  name: string;
  /** Resolved image URLs from every image-shaped metadata field
   *  (`image`, `image_url`, `animation_url`, `image_alt`), each already
   *  passed through resolveTokenUri. Empty array when no recognised
   *  image field was present or the metadata JSON was unreachable. The
   *  renderer races all entries plus IPFS-gateway mirrors so whichever
   *  URL the user's network resolves fastest wins. */
  imageCandidates: string[];
  /** Optional description from metadata.description. */
  description: string | null;
  /** Owned-count as decimal string. ERC-721 is always "1" by definition;
   *  ERC-1155 is the balanceOf(owner, tokenId) at add-time. null when
   *  the on-chain read failed and we want the UI to omit the badge.
   *  Older records (added before this field existed) read as undefined
   *  — same render as null. */
  balance?: string | null;
  /** ms since epoch — when the user added this. UI orders newest-first. */
  addedAt: number;
};

type NftsByChain = Record<number, Record<string, NftRecord>>;

function nftKey(address: string, tokenId: string): string {
  return `${address.toLowerCase()}::${tokenId}`;
}

async function getAllNfts(): Promise<NftsByChain> {
  return (await get<NftsByChain>(KEYS.nfts)) ?? {};
}

export async function listNfts(chainId: number): Promise<NftRecord[]> {
  const all = await getAllNfts();
  return Object.values(all[chainId] ?? {})
    .map(normalizeNftRecord)
    // Newest first.
    .sort((a, b) => b.addedAt - a.addedAt);
}

/** Records persisted before v0.6.1 hold `image: string | null` instead of
 *  `imageCandidates: string[]`. Promote the legacy field at read-time so
 *  consumers always see the new shape. Records are upgraded in-place on
 *  the next write (addNftRecord overwrites with the new shape). */
function normalizeNftRecord(raw: NftRecord): NftRecord {
  const r = raw as NftRecord & { image?: string | null };
  if (Array.isArray(r.imageCandidates)) {
    const { image: _legacy, ...rest } = r;
    return rest as NftRecord;
  }
  const legacy = typeof r.image === 'string' && r.image ? [r.image] : [];
  const { image: _drop, ...rest } = r;
  return { ...rest, imageCandidates: legacy } as NftRecord;
}

export async function addNftRecord(chainId: number, nft: NftRecord): Promise<void> {
  await mutateKey<NftsByChain>(KEYS.nfts, (cur) => {
    const all = cur ?? {};
    if (!all[chainId]) all[chainId] = {};
    const key = nftKey(nft.address, nft.tokenId);
    all[chainId]![key] = {
      ...nft,
      address: nft.address.toLowerCase(),
    };
    return all;
  });
}

export async function removeNftRecord(
  chainId: number, address: string, tokenId: string,
): Promise<void> {
  await mutateKey<NftsByChain>(KEYS.nfts, (cur) => {
    const all = cur ?? {};
    if (all[chainId]) {
      delete all[chainId]![nftKey(address, tokenId)];
    }
    return all;
  });
}

// ─── Grant registry (7702 delegations + session permissions) ──────────────
// Generic store for every permission the wallet has granted, keyed
// chainId → accountLower → GrantRecord[]. Both 7702 delegations and
// ERC-7715-style session grants land here; the discriminant is
// GrantRecord.kind. Consumed by the revoke/list UIs and the dispatcher's
// pre-flight scope check (tasks 4.x).
//
// chainId is stringified for the outer key so the JSON object round-trips
// cleanly (JSON object keys are always strings anyway) and matches how the
// map is typed. account is lowercased on BOTH write and read so a dapp
// sending a checksum address still resolves the grants it was issued.

type GrantsMap = Record<string, Record<string, GrantRecord[]>>; // chainId -> accountLower -> grants

async function getAllGrants(): Promise<GrantsMap> {
  return (await get<GrantsMap>(KEYS.grants)) ?? {};
}

/** All grants for a (chainId, account) pair. Case-insensitive on account,
 *  empty array when none. Includes revoked/expired records — callers that
 *  want only live grants filter on `revokedAt`/`expiry` themselves. */
export async function listGrants(chainId: number, account: string): Promise<GrantRecord[]> {
  const all = await getAllGrants();
  return all[String(chainId)]?.[account.toLowerCase()] ?? [];
}

/** Append a grant into its chainId → accountLower bucket. Serialized per-key
 *  via mutateKey so two concurrent grant approvals can't drop each other. */
export async function addGrant(g: GrantRecord): Promise<void> {
  await mutateKey<GrantsMap>(KEYS.grants, (cur) => {
    const all = cur ?? {};
    const cid = String(g.chainId);
    const acct = g.account.toLowerCase();
    const chainMap = all[cid] ?? {};
    const list = chainMap[acct] ?? [];
    return { ...all, [cid]: { ...chainMap, [acct]: [...list, g] } };
  });
}

/** Stamp `revokedAt = at` on the grant with `id`, wherever it lives. Scans
 *  every chain/account bucket since a grant id is globally unique but the UI
 *  revoking it may not know which bucket holds it. No-op if `id` is absent. */
export async function revokeGrant(id: string, at: number): Promise<void> {
  await mutateKey<GrantsMap>(KEYS.grants, (cur) => {
    const all = cur ?? {};
    const next: GrantsMap = {};
    for (const [cid, accts] of Object.entries(all)) {
      next[cid] = {};
      for (const [acct, list] of Object.entries(accts)) {
        next[cid]![acct] = list.map((g) => (g.id === id ? { ...g, revokedAt: at } : g));
      }
    }
    return next;
  });
}

// ─── Per-origin account memory ────────────────────────────────────────────
// chrome.md §5.4 — each dapp remembers which HD account the user authorized
// it for. Switching the wallet's global active account doesn't disturb a
// dapp's view: it keeps seeing whichever account it was originally connected
// to. Set on `eth_requestAccounts` approve, read by `eth_accounts`.

export async function getOriginAccountMap(): Promise<Record<string, number>> {
  return (await get<Record<string, number>>(KEYS.originAccountMap)) ?? {};
}
export async function setOriginAccount(origin: string, index: number): Promise<void> {
  await mutateKey<Record<string, number>>(KEYS.originAccountMap, (cur) => {
    const all = cur ?? {};
    all[origin] = index;
    return all;
  });
}
export async function getOriginAccount(origin: string): Promise<number | undefined> {
  const all = await getOriginAccountMap();
  return all[origin];
}
export async function clearOriginAccount(origin: string): Promise<void> {
  await mutateKey<Record<string, number>>(KEYS.originAccountMap, (cur) => {
    const all = cur ?? {};
    delete all[origin];
    return all;
  });
}

// ─── HD accounts ───────────────────────────────────────────────────────────
// Each entry pins a BIP-44 addressIndex (m/44'/60'/0'/0/N) and the user-facing
// label. Addresses themselves are NOT cached — they're derived live from the
// unlocked mnemonic so a stale address can never be shown if the user re-imports
// a different mnemonic. (Tradeoff: account list isn't viewable while locked.)

export type AccountRecord = {
  index: number;
  label: string;
};

export async function getAccounts(): Promise<AccountRecord[]> {
  const v = await get<AccountRecord[]>(KEYS.accounts);
  if (Array.isArray(v) && v.length > 0) return v;
  // First-launch default: a single account at index 0. The Settings UI
  // can add more by deriving the next unused index.
  return [{ index: 0, label: 'Account 1' }];
}

export async function setAccounts(accounts: AccountRecord[]): Promise<void> {
  return set(KEYS.accounts, accounts);
}

/** Read-modify-write the account list with per-key serialization, so two
 *  parallel popups racing on rename / add don't drop each other's edit. */
export async function mutateAccounts(
  fn: (cur: AccountRecord[]) => AccountRecord[],
): Promise<void> {
  await mutateKey<AccountRecord[]>(KEYS.accounts, (cur) => fn(cur ?? [{ index: 0, label: 'Account 1' }]));
}

export async function getActiveAccountIndex(): Promise<number> {
  const v = await get<number>(KEYS.activeAccountIndex);
  return typeof v === 'number' ? v : 0;
}

export async function setActiveAccountIndex(index: number): Promise<void> {
  return set(KEYS.activeAccountIndex, index);
}

/** Reset accounts to a single Account 1 at index 0. Called after a fresh
 *  create or import — the new mnemonic shouldn't keep an old account list. */
export async function resetAccounts(): Promise<void> {
  await set(KEYS.accounts, [{ index: 0, label: 'Account 1' }] satisfies AccountRecord[]);
  await set(KEYS.activeAccountIndex, 0);
}

// ─── Display preferences ───────────────────────────────────────────────────

export async function getHideZero(): Promise<boolean> {
  return (await get<boolean>(KEYS.hideZero)) ?? false;
}
export async function setHideZero(v: boolean): Promise<void> {
  return set(KEYS.hideZero, v);
}

export async function getCurrency(): Promise<Currency> {
  // Default 'usd' — USD presentation, ETH an opt-in.
  const v = await get<Currency>(KEYS.currency);
  return v === 'eth' ? 'eth' : 'usd';
}
export async function setCurrency(v: Currency): Promise<void> {
  return set(KEYS.currency, v);
}

// ─── Developer flags ───────────────────────────────────────────────────────
// Split storage by security impact:
//   - `rpcTrace`: persistent (chrome.storage.local). It's a debug aid;
//     surviving lock/restart matches developer expectations.
//   - `allowUnverifiedDelegate`: SESSION-only (chrome.storage.session).
//     Bypasses the 7702 Sourcify gate, so it's the wallet's highest-
//     risk toggle. Persisting across lock would mean a user who
//     enabled it once for a debugging session would silently still be
//     unprotected days later. Session-scoped ⇒ resets to off on every
//     lock + on browser close. Re-enabling is a deliberate two-tap
//     gesture in Settings each time, matching the high-risk UX
//     promise.
//
// Storage layout:
//   chrome.storage.local.devFlags         → { rpcTrace }
//   chrome.storage.session.devFlagsSesh   → { allowUnverifiedDelegate }
// Merged on read so callers see a single `DevFlags` object.

const SESSION_DEV_FLAGS_KEY = 'devFlagsSesh';

/** Keys that should be persisted across browser sessions. Adding a
 *  new dev flag = decide which side of this set it lives on, NOT
 *  default-include in `local`. */
const PERSISTENT_DEV_FLAG_KEYS: ReadonlySet<DevFlagKey> = new Set(['rpcTrace']);

async function getSessionDevFlags(): Promise<Partial<DevFlags>> {
  return new Promise((resolve) => {
    chrome.storage.session.get(SESSION_DEV_FLAGS_KEY, (result) =>
      resolve((result[SESSION_DEV_FLAGS_KEY] as Partial<DevFlags> | undefined) ?? {}),
    );
  });
}

async function setSessionDevFlags(flags: Partial<DevFlags>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [SESSION_DEV_FLAGS_KEY]: flags }, () => resolve());
  });
}

/** Clear all session-scoped dev flags. Called from the SW's `lock`
 *  handler so the danger override doesn't leak past a lock cycle. */
export async function clearSessionDevFlags(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.remove(SESSION_DEV_FLAGS_KEY, () => resolve());
  });
}

export async function getDevFlags(): Promise<DevFlags> {
  const [persistent, session] = await Promise.all([
    get<DevFlags>(KEYS.devFlags),
    getSessionDevFlags(),
  ]);
  const merged: DevFlags = { ...(persistent ?? {}), ...session };
  // App-dedicated wallet: the 7702 source-verification override defaults ON, so
  // delegating to the app's own (sometimes-unverified) contracts is not blocked.
  // Only defaulted when the user hasn't set it; an explicit OFF (session) wins.
  if (merged.allowUnverifiedDelegate === undefined) merged.allowUnverifiedDelegate = true;
  return merged;
}

export async function setDevFlag<K extends keyof DevFlags>(
  key: K, value: DevFlags[K],
): Promise<void> {
  if (PERSISTENT_DEV_FLAG_KEYS.has(key)) {
    const cur = (await get<DevFlags>(KEYS.devFlags)) ?? {};
    return set(KEYS.devFlags, { ...cur, [key]: value });
  }
  // Session path — covers allowUnverifiedDelegate (and any future
  // security-sensitive opt-in toggle).
  const cur = await getSessionDevFlags();
  return setSessionDevFlags({ ...cur, [key]: value });
}

// ─── Auto-lock timer ───────────────────────────────────────────────────────

export async function getAutoLockMinutes(): Promise<number> {
  const v = await get<number>(KEYS.autoLockMinutes);
  return typeof v === 'number' ? v : DEFAULT_AUTO_LOCK_MINUTES;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  return set(KEYS.autoLockMinutes, minutes);
}

function rehydrateCustom(rec: CustomNetworkRecord): Network {
  // Minimal viem Chain shape — enough for createWalletClient / readContract /
  // multicall. We don't bother filling iconUrl, contracts, etc.
  const chain = {
    id: rec.chainId,
    name: rec.name,
    nativeCurrency: { name: rec.symbol ?? 'ETH', symbol: rec.symbol ?? 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rec.rpcUrl] } },
    blockExplorers: rec.blockExplorer
      ? { default: { name: 'Explorer', url: rec.blockExplorer } }
      : undefined,
  } as unknown as Network['chain'];
  return {
    chain,
    rpcUrl: rec.rpcUrl,
  };
}
