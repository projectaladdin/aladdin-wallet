// Service worker. Holds:
//   - in-memory unlocked mnemonic (cleared on lock / SW idle = auto-relock)
//   - pending sign-request queue (origin, method, params, id)
//   - dispatch logic for RPC calls from content scripts and popup
//
// Persistent state (chrome.storage.local):
//   - encrypted vault
//   - connected origins
//   - current chain id (user/dapp can switch)
//   - custom chains (user-added beyond mainnet/sepolia builtin)
//
// MV3 service workers can be killed at any time. We accept this:
//   - encrypted vault is durable
//   - unlocked mnemonic is only in SW memory → SW killed = re-lock (good!)

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  recoverMessageAddress,
  type Address,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  addressFromMnemonic,
  decryptMnemonic,
  signAuthorizationFromMnemonic,
  signMessageFromMnemonic,
  signTypedDataFromMnemonic,
} from './core/crypto';
import {
  addConnectedOrigin,
  addCustomChain,
  addNftRecord,
  removeCustomChain,
  addTokenRecord,
  clearOriginAccount,
  getAccounts,
  getActiveAccountIndex,
  getAutoLockMinutes,
  getConnectedOrigins,
  getCurrency,
  getCurrentChainId,
  getCurrentNetwork,
  getDevFlags,
  clearSessionDevFlags,
  getHideZero,
  getOriginAccountMap,
  getVault,
  listAllNetworks,
  listNfts,
  listTokens,
  removeConnectedOrigin,
  removeNftRecord,
  removeTokenRecord,
  type NftRecord,
  mutateAccounts,
  resetAccounts,
  setActiveAccountIndex,
  type DevFlags,
  setAutoLockMinutes,
  setCurrency,
  setCurrentChainId,
  setCurrentRpcUrl,
  setDevFlag,
  setHideZero,
  setOriginAccount,
  addGrant,
  revokeGrant,
  listGrants,
  getAiOrigins,
  setAiOrigin,
  type AccountRecord,
} from './core/storage';
import { normalizeScope, serializeScope, type GrantRecord, type StoredScope } from './lib/grant-scope';
import {
  isZeroDelegate,
  buildDelegationGrantRecord,
  pickNewestActive7702GrantId,
} from './lib/delegation-grant';
import { parseGrantPermissionsRequest } from './lib/grant-request';
import {
  MULTICALL3_ABI,
  MULTICALL3_ADDRESS,
  detectMulticallSupport,
  fetchTokenBalancesBatch,
  fetchTokenMeta,
} from './core/erc20';
import {
  detectNftStandard,
  fetchNftMeta,
  verifyNftOwnership,
  getNftBalance,
} from './core/erc721';
import { BUILTIN_NETWORKS, BUILTIN_TOKENS, type Network } from './shared/config';
import { seedActiveChainOnInstall, type OnInstalledReason } from './core/on-installed';
import {
  addActivity,
  classifyTx,
  listActivity,
  updateActivityStatus,
  type ActivityEntry,
} from './core/activity';
import type {
  FromBackground,
  PendingRequest,
  RpcRequest,
  ToBackground,
} from './shared/protocol';
import { PROTO_TAG, SIGN_METHODS } from './shared/protocol';
import {
  validateTypedDataSchema,
  validateSendTransactionParams,
  validateWatchAssetParams,
  unpackTypedDataParams,
} from './lib/validators';
import { normalizeAuthorizationList } from './lib/auth-normalize';
import { verifyContract, fetchContractAbi, type VerificationResult } from './lib/contract-verify';
import { decodeTxData } from './lib/decoders';

let unlockedMnemonic: string | null = null;
const pending = new Map<string, PendingRequest>();
type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };
// Each pending id can have MULTIPLE resolvers attached when dapps issue
// connect-class duplicates (e.g. wagmi's wallet_requestPermissions +
// eth_requestAccounts back-to-back). They all settle together — one popup
// click answers every waiter that's been coalesced into the same prompt.
const pendingResolvers = new Map<string, Resolver[]>();

/** Methods that should dedupe per-origin in `queuePending` — i.e. a second
 *  call piggy-backs onto the first instead of stacking another popup.
 *
 *  This is the same approach MetaMask/Rabby take in their approval-controller:
 *  collapse parallel duplicates into a single approval. We deliberately do
 *  NOT add a post-rejection cooldown — none of the major wallets do, and a
 *  cooldown causes the dapp's own UI to spew "connection rejected" repeatedly
 *  as wagmi's fallback `eth_requestAccounts` keeps getting silently 4001'd.
 *  Better behavior: dapp gets one clean rejection per real user click, and
 *  any further popup is the dapp's mistake (it shouldn't auto-retry). */
const COALESCE_METHODS = new Set<string>([
  'eth_requestAccounts',
  'wallet_requestPermissions',
]);

// ─── Auto-lock timer ───────────────────────────────────────────────────────
// MV3 service workers die after ~30s of inactivity. If the unlocked mnemonic
// only lived in SW memory, the wallet would auto-lock far earlier than the
// user-configured 30/60/120-min window — every SW death = surprise relock.
//
// To make the timer faithful to its label, we persist the unlocked mnemonic
// in `chrome.storage.session` (Chrome 102+, in-memory, per-browser-session,
// per-extension — never written to disk) along with an absolute `lockAt`
// timestamp. On any SW startup we restore the mnemonic if `lockAt` is still
// in the future, otherwise we wipe it. The chrome.alarms entry uses `when`
// (absolute time) so it survives SW restarts too.
//
// Security note: `chrome.storage.session` lives in browser memory, same place
// the SW's local `unlockedMnemonic` lives — moving it there doesn't widen the
// attack surface. The phrase still leaves memory at lock, alarm, browser
// close, and OS reboot.
//
// On encrypting the session-storage copy with a SW-ephemeral key: this
// was considered, implemented, and reverted. The encryption key has to
// die when the SW dies for the threat model to hold, but MV3 SW
// recycles every ~30s of idle — the auto-lock window collapses to
// seconds, breaking the "1 hour idle then re-prompt" UX the user
// asked for in Settings.
// Industry standard (MetaMask / Rabby / Phantom / Coinbase Wallet) is the
// design below: plaintext mnemonic in chrome.storage.session, time-bounded
// by lockAt, accepting that anyone with cross-process memory read access
// has already defeated browser-level isolation. See wallet-AUDIT W1 for
// the full rationale.

const AUTO_LOCK_ALARM = 'auto-lock';
const SESSION_KEY_UNLOCK = 'unlock';
type UnlockSession = {
  mnemonic: string;
  /** ms since epoch. Number.MAX_SAFE_INTEGER means "never auto-lock". */
  lockAt: number;
};

async function persistUnlockSession(mnemonic: string): Promise<number> {
  const minutes = await getAutoLockMinutes();
  const lockAt = minutes > 0 ? Date.now() + minutes * 60_000 : Number.MAX_SAFE_INTEGER;
  await chrome.storage.session.set({
    [SESSION_KEY_UNLOCK]: { mnemonic, lockAt } satisfies UnlockSession,
  });
  return lockAt;
}

async function clearUnlockSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY_UNLOCK);
}

/** Restore unlocked state from session storage if SW just woke. Idempotent —
 *  cheap to call at the top of every handler. */
async function ensureUnlockRestored(): Promise<void> {
  if (unlockedMnemonic !== null) return;
  const got = await chrome.storage.session.get(SESSION_KEY_UNLOCK);
  const u = got[SESSION_KEY_UNLOCK] as UnlockSession | undefined;
  if (!u) return;
  if (Date.now() >= u.lockAt) {
    await clearUnlockSession();
    return;
  }
  unlockedMnemonic = u.mnemonic;
  // Re-arm the alarm at the absolute lockAt — `when` means "at time T",
  // surviving SW restart.
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  if (u.lockAt < Number.MAX_SAFE_INTEGER) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { when: u.lockAt });
  }
}

async function scheduleAutoLock(): Promise<void> {
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  if (!unlockedMnemonic) return;
  const lockAt = await persistUnlockSession(unlockedMnemonic);
  if (lockAt < Number.MAX_SAFE_INTEGER) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { when: lockAt });
  }
}

async function clearAutoLock(): Promise<void> {
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await clearUnlockSession();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  // In-memory clear is sync. Awaiting the session-storage clear inside the
  // async wrapper closes a race where another RPC arrives during the gap and
  // ensureUnlockRestored reads the stale entry, "restoring" a mnemonic the
  // user expected to be locked.
  void (async () => {
    unlockedMnemonic = null;
    await clearUnlockSession();
    // Mirror the `case 'lock'` handler: auto-lock should drop the
    // session-scoped danger override too, otherwise idle timeout
    // leaves the gate-bypass flag silently armed for the next unlock.
    await clearSessionDevFlags();
    devFlagsCache = null;
    await broadcastEvent('accountsChanged', []);
  })();
});

// ─── helpers ───────────────────────────────────────────────────────────────

function nextId(): string {
  return `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function activeIndex(): Promise<number> {
  return getActiveAccountIndex();
}

async function unlockedAddress(): Promise<Address> {
  if (!unlockedMnemonic) throw new Error('locked');
  return addressFromMnemonic(unlockedMnemonic, await activeIndex());
}

async function refreshBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: pending.size > 0 ? String(pending.size) : '' });
  if (pending.size > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#FF4D4D' });
  }
}

async function openPopupForApproval(): Promise<void> {
  void refreshBadge();
  try {
    await chrome.action.openPopup();
  } catch {
    /* not allowed without user gesture; badge alone has to do */
  }
}

async function broadcastEvent(
  event: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect',
  data: unknown,
): Promise<void> {
  // Fan out to every tab so any open dapp page hears about it.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { kind: 'event', tag: PROTO_TAG, event, data }).catch(() => {
      /* tab without our content script - ignore */
    });
  }
}

// ─── RPC passthrough (Layer 3) ─────────────────────────────────────────────
// SW fetch is not subject to page CORS — we proxy any unknown JSON-RPC method
// to the active chain's RPC URL. Read methods (eth_call, eth_getBalance, etc)
// are handled this way; the dapp gets the same shape it would from its own RPC.

let rpcRequestId = 1;

async function passthroughRpc(payload: RpcRequest): Promise<unknown> {
  const network = await cachedNetwork();
  const body = {
    jsonrpc: '2.0',
    id: rpcRequestId++,
    method: payload.method,
    params: payload.params ?? [],
  };
  const res = await fetch(network.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (json.error) {
    throw Object.assign(new Error(json.error.message), { code: json.error.code });
  }
  return json.result;
}

// ─── RPC dispatcher ────────────────────────────────────────────────────────

// In-memory cache of dev flags so the hot RPC path doesn't await chrome.storage
// on every call. Loaded on first SW boot, refreshed via storage.onChanged.
let devFlagsCache: DevFlags | null = null;
async function getCachedDevFlags(): Promise<DevFlags> {
  if (devFlagsCache !== null) return devFlagsCache;
  devFlagsCache = await getDevFlags();
  return devFlagsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  // Persistent dev flags (rpcTrace) live in local; session-scoped
  // ones (allowUnverifiedDelegate) live in session under a different
  // key. Either side changing invalidates the merged cache — next
  // read re-merges from both.
  if (area === 'local' && changes.devFlags) {
    devFlagsCache = null;
  }
  if (area === 'session' && changes.devFlagsSesh) {
    devFlagsCache = null;
  }
});

// ─── SW-warm caches (network + viem clients) ──────────────────────────────
// `getCurrentNetwork()` is 3 cold-storage reads (5–15 ms each after SW
// wake) and `createPublicClient(...)` allocates an HTTP transport each
// time. Cache the resolved network in memory and bust on chain / rpc /
// customChains changes so RPC dispatchers stay hot across calls.
//
// Client objects are cheap to make individually but the per-call setup cost
// adds up (transport closure, action attachers). Re-using them lets later
// requests in the same SW lifetime reach the wire roughly one event-loop
// turn faster, and avoids creating fresh AbortController plumbing per call.
let networkCache: Network | null = null;
async function cachedNetwork(): Promise<Network> {
  if (networkCache !== null) return networkCache;
  networkCache = await getCurrentNetwork();
  return networkCache;
}
// Use `unknown` storage + casts on return: viem's inferred client type is so
// generic-laden that storing it directly in a homogeneous Map produces
// "type X not assignable to itself" diagnostics. The runtime objects are
// identical — TypeScript just can't unify the type-level shape across calls.
const publicClientCache = new Map<string, unknown>();
function cachedPublicClient(network: Network) {
  const key = `${network.chain.id}::${network.rpcUrl}`;
  const hit = publicClientCache.get(key);
  if (hit) return hit as ReturnType<typeof createPublicClient>;
  const c = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl, { timeout: 15_000 }) });
  publicClientCache.set(key, c);
  return c;
}
const walletClientCache = new Map<string, WalletClient>();
function cachedWalletClient(
  mnemonic: string,
  addressIndex: number,
  network: Network,
): WalletClient {
  // Mnemonic is part of the key so a different unlocked vault (e.g. user
  // re-imported with a different phrase) never reuses the prior account's
  // signing client. We hash via length+slice rather than full string so the
  // key isn't a memory leak that pins the secret beyond its normal lifetime.
  const mKey = `${mnemonic.length}:${mnemonic.slice(0, 4)}:${mnemonic.slice(-4)}`;
  const key = `${network.chain.id}::${network.rpcUrl}::${addressIndex}::${mKey}`;
  let w = walletClientCache.get(key);
  if (!w) {
    const account = mnemonicToAccount(mnemonic, { addressIndex });
    w = createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl, { timeout: 15_000 }) });
    walletClientCache.set(key, w);
  }
  return w;
}
function bustNetworkCaches(): void {
  networkCache = null;
  publicClientCache.clear();
  walletClientCache.clear();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.currentChainId || changes.currentRpcUrl || changes.customChains) {
    bustNetworkCaches();
  }
});

async function handleRpcFromPage(origin: string, payload: RpcRequest): Promise<unknown> {
  // v3 == v4: identical JSON shape, identical EIP-712 hashing rules, viem's
  // signTypedData handles both the same way. The only difference v3-vs-v4
  // ever had (v4 added array support) is invisible to the wallet. Normalize
  // here so every downstream check (schema validation, popup render, sign,
  // SIGN_METHODS gate) only has to know about v4.
  if (payload.method === 'eth_signTypedData_v3') {
    payload = { ...payload, method: 'eth_signTypedData_v4' };
  }
  await ensureUnlockRestored();
  // Trace incoming RPCs when the user has toggled it in Settings → developer.
  // Backed by chrome.storage.local so the toggle survives SW recycle, cached
  // in memory so dispatch pays one storage read per SW boot rather than per
  // call. Wrap in try/catch so a stringify failure on weird payloads NEVER
  // breaks the actual RPC dispatch. The matching `←` response line is
  // printed in the dispatcher case below.
  const flags = await getCachedDevFlags();
  if (flags.rpcTrace) {
    try {
      // Full params, no truncation. Trace is opt-in (off by default) so the
      // user has explicitly asked to see everything; truncating contract
      // deploy initcode at 200 chars hides the very thing they need to
      // inspect. JSON.stringify(undefined) === undefined → default to '[]'.
      const full = JSON.stringify(payload.params) ?? '[]';
      console.log(`[rpc] → ${payload.method}  origin=${origin}  params=${full}`);
    } catch (e) {
      console.log(`[rpc] → ${payload.method}  origin=${origin}  (trace-error: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  // Fast-path methods that don't need user interaction.
  if (payload.method === 'eth_chainId') {
    const id = await getCurrentChainId();
    return `0x${id.toString(16)}`;
  }

  if (payload.method === 'net_version') {
    const id = await getCurrentChainId();
    return String(id);
  }

  // Connected origins read the wallet's currently active account — same
  // model as MetaMask / Rabby / OKX. Switching the active account in the
  // UI immediately propagates to every connected dapp via accountsChanged
  // (broadcast in switchAccount). originAccountMap is still written on
  // approve + read by `list-connected-sites` to surface "which account
  // each dapp was originally connected as" in the Connected Sites screen,
  // but it no longer overrides accountForOrigin() for eth_accounts.
  const accountForOrigin = async (): Promise<Address> => {
    if (!unlockedMnemonic) throw new Error('locked');
    const idx = await getActiveAccountIndex();
    return addressFromMnemonic(unlockedMnemonic, idx);
  };

  if (payload.method === 'eth_accounts') {
    if (!unlockedMnemonic) return [];
    const connected = await getConnectedOrigins();
    if (!connected.includes(origin)) return [];
    return [await accountForOrigin()];
  }

  if (payload.method === 'eth_requestAccounts') {
    if (!unlockedMnemonic) return queuePending(origin, payload);
    const connected = await getConnectedOrigins();
    if (!connected.includes(origin)) return queuePending(origin, payload);
    return [await accountForOrigin()];
  }

  if (payload.method === 'wallet_switchEthereumChain') {
    const params = payload.params as [{ chainId: string }];
    const raw = params[0]?.chainId;
    // Reject malformed input with -32602 (invalid params), not 4902
    // (unrecognised chain) — wagmi branches on `err.code` and 4902 triggers
    // an "add chain" follow-up flow which is wrong for garbage input.
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw Object.assign(new Error('chainId must be a 0x-prefixed hex string'), { code: -32602 });
    }
    return switchChain(parseInt(raw, 16));
  }

  if (payload.method === 'wallet_addEthereumChain') {
    // User must approve adding a chain (it widens the trust surface) — queue it.
    return queuePending(origin, payload);
  }

  // ERC-7715 scoped permission grant. Parse + normalize the requested scope
  // UPFRONT so a malformed / over-broad request (wildcard target, empty
  // function list, missing expiry) is rejected with -32602 BEFORE any popup
  // opens — mirroring the eth_sendTransaction / typed-data upfront rejections
  // above. The normalized scope is serialized (JSON-safe) and rides along on
  // the pending request so the sign-confirm popup (Task 4.2) can render
  // CAN/CANNOT and approve() can persist the grant without re-parsing.
  //
  // Security: this path NEVER broadcasts a transaction. On approval it only
  // records a bounded `session` GrantRecord and returns an ERC-7715 permission
  // context for a relayer to redeem. The wallet is not a UserOp signer and
  // exposes no generic execute path.
  if (payload.method === 'wallet_grantPermissions') {
    let grantScope: StoredScope;
    try {
      const activeChainId = await getCurrentChainId();
      const req = parseGrantPermissionsRequest(payload.params, activeChainId);
      grantScope = serializeScope(normalizeScope(req));
    } catch (e) {
      const err = new Error(
        `malformed wallet_grantPermissions — ${e instanceof Error ? e.message : String(e)}`,
      );
      (err as Error & { code?: number }).code = -32602;
      throw err;
    }
    return queuePending(origin, payload, grantScope);
  }

  // personal_ecRecover (MM helper) — pure-compute address recovery from a
  // personal_sign signature. No key access, no popup, no approval needed.
  // Most modern dapps recover client-side via viem/ethers; we support it
  // anyway because it's trivial and a few legacy dapps still call it.
  if (payload.method === 'personal_ecRecover') {
    const params = payload.params as [string, `0x${string}`];
    const message = params[0];
    const signature = params[1];
    return recoverMessageAddress({
      message: typeof message === 'string' && message.startsWith('0x')
        ? { raw: message as `0x${string}` }
        : message,
      signature,
    });
  }

  // eth_sign signs a raw 32-byte hash with the private key, no prefix. The
  // exact same primitive that signs Ethereum transactions and Bitcoin
  // sighashes — a hash signed this way is indistinguishable from a real tx.
  // Industry has deprecated it (MM hides it, Rabby refuses it). We just
  // refuse with a clear EIP-1474 4200 (unsupported method) so the dapp dev
  // gets a useful error and switches to personal_sign.
  if (payload.method === 'eth_sign') {
    const e = new Error('eth_sign is disabled — ask the dapp to use personal_sign instead.');
    (e as Error & { code?: number }).code = 4200;
    throw e;
  }

  // EIP-712 typed data — covers all four method aliases (v0 / v1 / v3 / v4).
  // We do TWO upfront rejections before queueing a popup:
  //   1. v1 legacy flat-array form (`[{name,type,value}, ...]`) has no
  //      EIP-712 domain separator → replay across any dapp. Refuse with 4200.
  //   2. EIP-712 schema sanity (validateTypedDataSchema) catches the six
  //      standard malformed cases — INVALID TYPE / NO PRIMARY TYPE / INVALID
  //      PRIMARY TYPE / EMPTY DOMAIN / INVALID VERIFYING CONTRACT / EXTRA
  //      DATA NOT TYPED. -32602 means dapp dev sees the error in console
  //      immediately; user never sees a popup for an un-signable payload.
  if (
    payload.method === 'eth_signTypedData' ||
    payload.method === 'eth_signTypedData_v1' ||
    payload.method === 'eth_signTypedData_v4'
  ) {
    // unpackTypedDataParams handles both param orderings — v3/v4 puts
    // the address first, v1 puts it last — and prefers `params[1]` as
    // data when neither slot is an address, so a dapp that mistakenly
    // sends `[null, typed_data]` doesn't get a misleading "typed data
    // must be an object" error pointing at the wrong slot.
    const { signer, data } = unpackTypedDataParams(payload.params);
    if (Array.isArray(data)) {
      const e = new Error(
        'eth_signTypedData v1 (legacy array form) is not supported — no EIP-712 domain separator means signatures can be replayed across dapps. ask the dapp to use eth_signTypedData_v4.',
      );
      (e as Error & { code?: number }).code = 4200;
      throw e;
    }
    if (!signer) {
      // Neither slot held a 20-byte hex address. v3/v4 requires the
      // signer address explicitly so the wallet knows which account
      // to sign as. Reject with -32602 pointing at the real problem
      // rather than letting validateTypedDataSchema choke on the
      // typed-data slot first.
      const e = new Error(
        'signer address missing — eth_signTypedData params must include a 20-byte hex address (v3/v4: [address, typed_data]; v1: [typed_data, address]).',
      );
      (e as Error & { code?: number }).code = -32602;
      throw e;
    }
    const schemaErr = validateTypedDataSchema(data);
    if (schemaErr) {
      const e = new Error(`malformed EIP-712 typed data — ${schemaErr}`);
      (e as Error & { code?: number }).code = -32602;
      throw e;
    }
  }

  // eth_sendTransaction param validation. Some dapps send `value: "0.01"`
  // (decimal ETH instead of hex wei) or omit the `0x` prefix entirely;
  // signing those would fail at viem with a confusing error AFTER the user
  // approved a popup that displayed "invalid ETH" as the value. Refuse
  // upfront with -32602 so the dapp dev sees the spec violation immediately.
  if (payload.method === 'eth_sendTransaction') {
    const txErr = validateSendTransactionParams(payload.params);
    if (txErr) {
      const e = new Error(`malformed eth_sendTransaction — ${txErr}`);
      (e as Error & { code?: number }).code = -32602;
      throw e;
    }
  }

  // EIP-747 wallet_watchAsset — dapp-suggested token. Validate the params
  // shape upfront (only ERC20 supported today; ERC721 / ERC1155 deferred
  // until proper NFT support lands). dapp gets -32602 if structure is bad.
  if (payload.method === 'wallet_watchAsset') {
    const watchErr = validateWatchAssetParams(payload.params);
    if (watchErr) {
      const e = new Error(`malformed wallet_watchAsset — ${watchErr}`);
      (e as Error & { code?: number }).code = -32602;
      throw e;
    }
  }

  // Methods that require explicit user approval (popup).
  if (SIGN_METHODS.has(payload.method)) {
    if (!unlockedMnemonic) {
      // queue + popup will lead to unlock then sign in one flow.
      return queuePending(origin, payload);
    }
    return queuePending(origin, payload);
  }

  // Default: forward to chain RPC. Covers eth_call, eth_getBalance,
  // eth_blockNumber, eth_getTransactionReceipt, eth_estimateGas, eth_gasPrice,
  // eth_getCode, eth_getLogs, eth_getTransactionCount, eth_feeHistory,
  // eth_maxPriorityFeePerGas, eth_sendRawTransaction, etc.
  return passthroughRpc(payload);
}

async function switchChain(chainId: number, rpcUrl?: string): Promise<null> {
  const network = await tryResolveNetwork(chainId);
  if (!network) {
    // EIP-3326: throw 4902 to indicate chain not configured.
    throw Object.assign(new Error(`chainId 0x${chainId.toString(16)} not in supported list`), { code: 4902 });
  }
  // Probe the new RPC before flipping. EIP-3326 says return null only
  // on successful switch — a dead RPC after switch means every
  // subsequent dapp call fails with mysterious "network error"
  // instead of the user understanding the chain doesn't actually
  // work. eth_chainId is the cheapest sanity probe.
  try {
    const probedHex = await createPublicClient({
      chain: network.chain,
      transport: http(network.rpcUrl, { timeout: 5_000 }),
    }).request({ method: 'eth_chainId' }) as string;
    const probedId = parseInt(probedHex, 16);
    if (probedId !== chainId) {
      throw Object.assign(
        new Error(
          `RPC at ${network.rpcUrl} reports chainId ${probedId}, not ${chainId}. ` +
          `Refusing to switch — the chain configuration is wrong.`,
        ),
        { code: 4901 },
      );
    }
  } catch (e) {
    // Network unreachable or wrong chainId — EIP-1193 4901 (chain
    // disconnected) is the closest standard code. Preserve nested
    // 4901 from the chainId mismatch above; otherwise wrap.
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: number }).code === 4901) throw e;
    throw Object.assign(
      new Error(
        `Cannot reach RPC at ${network.rpcUrl}. Chain switch aborted — fix the ` +
        `RPC URL in settings before trying again.`,
      ),
      { code: 4901 },
    );
  }
  await setCurrentChainId(chainId);
  // When the chain has multiple custom entries, persist which RPC URL the
  // user picked so getCurrentNetwork resolves to the same one across SW
  // restarts. Pass undefined to clear and fall back to first-match logic.
  await setCurrentRpcUrl(rpcUrl);
  // Balance cache key is `${chainId}:${owner}`. Switching chain changes the
  // key; without explicit clear the dashboard briefly shows the previous
  // chain's stale balances on first paint (TTL is 30 s).
  await invalidateBalanceCache();
  await broadcastEvent('chainChanged', `0x${chainId.toString(16)}`);
  return null;
}

async function tryResolveNetwork(chainId: number) {
  if (BUILTIN_NETWORKS[chainId]) return BUILTIN_NETWORKS[chainId];
  // Re-use the storage helper so custom chains resolve.
  try {
    const stash = await getCurrentChainId();
    await setCurrentChainId(chainId);
    const n = await getCurrentNetwork();
    await setCurrentChainId(stash); // restore (we'll re-set on success)
    return n;
  } catch {
    return undefined;
  }
}

// ─── 7702 verify prefetch ─────────────────────────────────────────────────
// When wallet_signAuthorization enters the queue, kick off the Sourcify
// lookup + eth_getCode in parallel BEFORE the user opens the popup.
// By the time the popup mounts and asks for the gate state, the result
// is usually already cached — slide gate paints resolved on first frame
// instead of "verifying…" for ~1s.
//
// Cache is keyed by `${chainId}:${lowercase-address}` so multiple
// requests for the same delegate dedupe to one network round-trip.
// We cache the in-flight Promise (not the resolved value) so concurrent
// requests share the same fetch. Entries don't expire — within a SW
// lifetime, verification status doesn't change in practice (Sourcify
// only goes verified → verified-with-more-matches, never back).
type Seven702VerifyCacheEntry = {
  verify: VerificationResult;
  /** `eth_getCode` result: `0x` = empty, longer hex = contract code,
   *  null = couldn't query (chain unknown / RPC down). */
  code: string | null;
};

/** TTL + LRU cache for SW-side prefetches. A raw Map with no eviction
 *  would let a hostile dapp spam queue requests to fill memory + force
 *  unbounded Sourcify traffic, so both axes are bounded:
 *    • TTL covers the "Sourcify went verified → unverified due to
 *      compiler bump" edge case (don't pin a stale verdict forever).
 *    • LRU caps the working-set size against deliberate spam.
 *  Each entry stores the in-flight Promise so concurrent reads dedupe
 *  to a single fetch. */
class TtlLruCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private map = new Map<string, { value: Promise<V>; ts: number }>();
  constructor(max: number, ttlMs: number) { this.max = max; this.ttlMs = ttlMs; }
  get(key: string): Promise<V> | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch — re-insert to move to the tail.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: Promise<V>): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string): void { this.map.delete(key); }
  has(key: string): boolean {
    const hit = this.map.get(key);
    if (!hit) return false;
    if (Date.now() - hit.ts > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }
}

const TEN_MIN_MS = 10 * 60 * 1000;
const seven702VerifyCache = new TtlLruCache<Seven702VerifyCacheEntry>(256, TEN_MIN_MS);

function seven702CacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function prefetchSeven702Verify(chainId: number, address: string): void {
  // Zero-address revoke is detected popup-side without a lookup — skip
  // the network round-trip entirely so we don't ratelimit Sourcify on
  // every revoke flow.
  if (/^0x0+$/.test(address)) return;
  const key = seven702CacheKey(chainId, address);
  if (seven702VerifyCache.has(key)) return;

  const p = (async (): Promise<Seven702VerifyCacheEntry> => {
    const all = await listAllNetworks();
    const network = all.find((n) => n.chain.id === chainId);
    const codePromise: Promise<string | null> = network
      ? cachedPublicClient(network)
        .getCode({ address: address as Address })
        .then((c) => c ?? '0x')
        .catch(() => null)
      : Promise.resolve(null);
    const [verify, code] = await Promise.all([
      verifyContract(chainId, address),
      codePromise,
    ]);
    return { verify, code };
  })();

  // Don't propagate rejection as an unhandled promise — verifyContract
  // is already fail-closed, but catch defensively so a transient bug
  // can't crash the SW.
  p.catch(() => { /* swallowed; popup re-queries / falls back */ });
  // Evict transient errors so a retry can succeed without waiting for
  // the SW to respawn. `error` means Sourcify was unreachable
  // (rate-limited / network glitch) — successive prefetches will get
  // fresh attempts. Stable results (verified / unverified) stay cached.
  p.then((entry) => {
    if (entry.verify.status === 'error') seven702VerifyCache.delete(key);
  }, () => { /* already swallowed above */ });
  seven702VerifyCache.set(key, p);
}

// ─── Contract ABI prefetch (for the calldata decoder fallback) ────────────
// When an `eth_sendTransaction` enters the queue with a function the
// bundled local selector table doesn't recognise, we kick off a
// Sourcify ABI lookup so the popup can show the decoded function name
// + args instead of raw selector hex. Same prefetch pattern as the
// 7702 verify cache — keyed by `(chainId, lowercase-addr)`, holding
// in-flight Promises so concurrent reads dedupe to one fetch.
//
// Skipped when the bundled table already decodes the call (no point
// hitting Sourcify for plain ERC-20 transfer / Uniswap swap / etc.).
// Skipped for contract-deploy (no `to`). Errors (Sourcify unreachable
// / contract unverified) cache as `null` for this SW lifetime; cache
// clears on SW respawn so transient failures recover on next idle.
const contractAbiCache = new TtlLruCache<unknown[] | null>(256, TEN_MIN_MS);

function contractAbiCacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function prefetchContractAbi(chainId: number, address: string): void {
  const key = contractAbiCacheKey(chainId, address);
  if (contractAbiCache.has(key)) return;
  const p = fetchContractAbi(chainId, address).catch(() => null);
  contractAbiCache.set(key, p);
  // Evict null (Sourcify miss) once it resolves — a missed lookup
  // costs more than a retry; we want a fresh attempt the next time
  // the user actually approaches this contract instead of pinning
  // "no ABI" forever. Verified ABIs stay until TTL expiry.
  p.then((abi) => { if (abi === null) contractAbiCache.delete(key); });
}

/** Caps on the SW's `pending` map. A misbehaving / hostile dapp can
 *  call sign / send in a tight loop; without limits the map grows
 *  unbounded (memory) and every entry triggers a Sourcify / ABI
 *  prefetch (network). Per-origin cap stops one origin alone; global
 *  cap catches a coalition of phishing pages. Numbers picked to give
 *  legitimate flows plenty of headroom — a normal swap is 1-3 pending
 *  at peak. */
const MAX_PENDING_PER_ORIGIN = 16;
const MAX_PENDING_GLOBAL = 64;

async function queuePending(
  origin: string,
  payload: RpcRequest,
  grantScope?: StoredScope,
): Promise<unknown> {
  // Coalesce in-flight connect-style duplicates onto the existing prompt so
  // the user sees one popup; one click answers all waiters. Sign/send DON'T
  // coalesce — every dapp call deserves its own popup. One call ↔ one
  // popup ↔ one signature is the only contract that scales: any heuristic
  // dedupe (race window, payload hash) eventually merges two distinct
  // intents the user actually wanted to confirm separately.
  if (COALESCE_METHODS.has(payload.method)) {
    for (const [existingId, req] of pending.entries()) {
      if (req.origin === origin && COALESCE_METHODS.has(req.payload.method)) {
        return new Promise<unknown>((resolve, reject) => {
          const arr = pendingResolvers.get(existingId);
          if (arr) arr.push({ resolve, reject });
          else pendingResolvers.set(existingId, [{ resolve, reject }]);
        });
      }
    }
  }

  // DoS guard. Reject with -32603 (internal error) when the queue is
  // already at the per-origin or global cap. The user still has
  // recourse: every approve/reject pops one off the queue, so a
  // legit dapp that hit the cap can retry once the user is caught
  // up. A hostile dapp just keeps getting rejected.
  let perOriginCount = 0;
  for (const req of pending.values()) {
    if (req.origin === origin) perOriginCount++;
  }
  if (perOriginCount >= MAX_PENDING_PER_ORIGIN) {
    return Promise.reject(
      Object.assign(new Error(
        `too many pending requests from ${origin} (${perOriginCount}/${MAX_PENDING_PER_ORIGIN}). ` +
        `approve or reject the existing requests before sending more.`,
      ), { code: -32603 }),
    );
  }
  if (pending.size >= MAX_PENDING_GLOBAL) {
    return Promise.reject(
      Object.assign(new Error(
        `wallet's pending queue is full (${pending.size}/${MAX_PENDING_GLOBAL}). ` +
        `approve or reject existing requests first.`,
      ), { code: -32603 }),
    );
  }

  const id = nextId();
  // Snapshot chainId + accountIndex at queue time. The popup will
  // display these; sign() at approve time asserts the wallet's
  // CURRENT chain + account still match. If the user switched in
  // another popup between queue and approve, the assertion rejects
  // — no silent cross-chain or cross-account signing.
  const [snapChainId, snapAccountIndex] = await Promise.all([
    getCurrentChainId(),
    activeIndex(),
  ]);
  const req: PendingRequest = {
    id, origin, payload, createdAt: Date.now(),
    chainId: snapChainId,
    accountIndex: snapAccountIndex,
    // ERC-7715 grants only — the parsed/normalized scope parsed upfront in
    // the dispatcher. undefined for every other method.
    ...(grantScope ? { grantScope } : {}),
  };
  pending.set(id, req);

  // 7702 prefetch — start verifying the delegate the moment the request
  // enters the queue, in parallel with the popup-open / user-walk-to-
  // computer latency. By the time the user clicks the wallet icon and
  // the popup mounts, the result is usually already cached.
  if (payload.method === 'wallet_signAuthorization') {
    const p = (payload.params as [{ address?: string; chainId?: string }])[0];
    if (p?.address && p?.chainId && /^0x[0-9a-fA-F]+$/.test(p.chainId)) {
      const cidBig = BigInt(p.chainId);
      if (cidBig <= BigInt(Number.MAX_SAFE_INTEGER) && cidBig > 0n) {
        prefetchSeven702Verify(Number(cidBig), p.address);
      }
    }
  }

  // Contract ABI prefetch — when the dapp sends a tx whose calldata
  // doesn't decode against the bundled local selector table, fetch
  // the destination contract's ABI from Sourcify in parallel with
  // the popup-open latency. Local-table hits skip the prefetch
  // (already decoded; no Sourcify call needed). `to` missing means
  // contract deploy (no ABI to fetch).
  if (payload.method === 'eth_sendTransaction') {
    const p = (payload.params as [{ to?: string; data?: string }])[0];
    if (p?.to && /^0x[0-9a-fA-F]{40}$/.test(p.to)) {
      const localDecoded = decodeTxData(p.data);
      if (localDecoded.kind === 'unknown') {
        // Active chain at queue time — the SW's `cachedNetwork()` is
        // fire-and-forget here; if the resolution races a chain
        // switch the prefetch may target the wrong chain, but the
        // popup re-queries with its own current chainId anyway.
        void (async () => {
          try {
            const network = await cachedNetwork();
            prefetchContractAbi(network.chain.id, p.to as string);
          } catch { /* prefetch is best-effort */ }
        })();
      }
    }
  }

  void openPopupForApproval();
  return new Promise<unknown>((resolve, reject) => {
    pendingResolvers.set(id, [{ resolve, reject }]);
  });
}

async function approve(
  id: string,
  _password: string,
  txOverride?: { data?: `0x${string}` },
): Promise<unknown> {
  // Wallet must already be unlocked (popup's App router gates on `is-unlocked`
  // before showing the sign/connect screen). Fail loud if not — never fall
  // back to "decrypt with password", popup doesn't collect one anymore.
  if (!unlockedMnemonic) {
    throw new Error('wallet was locked while you decided. unlock and try again.');
  }
  // Re-entrancy guard. Two popups open simultaneously (toolbar +
  // standalone tab) could both call approve(id) before either sees
  // the other's delete; both would broadcast the same tx (the second
  // gets "nonce too low" but the user still saw two signatures).
  // Delete-on-entry — claim the slot atomically. Subsequent calls
  // for the same id find an empty slot and throw cleanly.
  const req = pending.get(id);
  const resolvers = pendingResolvers.get(id);
  if (!req || !resolvers || resolvers.length === 0) {
    throw new Error('request expired — close this and try from the dapp again.');
  }
  pending.delete(id);
  // Don't delete resolvers yet — we need them to resolve / reject
  // once sign() lands. They get cleaned up at the bottom of the fn
  // (or in the catch block on error).
  const mnemonic = unlockedMnemonic;

  // Approve-amount override: the popup's approve mode lets the user bump or
  // cap the requested allowance. We patch the pending request's calldata
  // before signing — the dapp still sees a successful tx, just with a
  // different (user-chosen) amount. Only allowed for eth_sendTransaction.
  if (txOverride?.data && req.payload.method === 'eth_sendTransaction') {
    const params = req.payload.params as [{ data?: string }];
    if (params?.[0]) params[0].data = txOverride.data;
  }

  let result: unknown;
  try {
    result = await sign(req, mnemonic);
  } catch (e) {
    for (const r of resolvers) r.reject(e as Error);
    pendingResolvers.delete(id);
    void refreshBadge();
    throw e;
  }

  if (req.payload.method === 'eth_requestAccounts') {
    await addConnectedOrigin(req.origin);
    // Pin THIS origin to the snapshotted HD account (not whatever's
    // active now). Switching active later won't disturb the dapp's
    // view; it'll keep seeing this account until the user explicitly
    // revokes + reconnects.
    await setOriginAccount(req.origin, req.accountIndex);
    // EIP-1193 `connect` event — wagmi / viem subscribe to this for
    // the "is the wallet alive?" handshake. Carries the chainId per
    // spec. Fire BEFORE accountsChanged so dapps see "wallet there →
    // here's its account" in the right order.
    const chainHex = `0x${req.chainId.toString(16)}` as const;
    await broadcastEvent('connect', { chainId: chainHex });
    await broadcastEvent('accountsChanged', [addressFromMnemonic(mnemonic, req.accountIndex)]);
  }

  for (const r of resolvers) r.resolve(result);
  pendingResolvers.delete(id);
  void refreshBadge();
  // Await — if SW recycles between resolve and the alarm getting persisted to
  // chrome.alarms storage, the auto-lock timer is silently lost (user thinks
  // 30 min, wallet stays unlocked indefinitely). The await is essentially free
  // (chrome.alarms.create finishes in <1 ms) and closes that race.
  await scheduleAutoLock();
  return result;
}

function reject(id: string): void {
  const resolvers = pendingResolvers.get(id);
  if (resolvers) {
    const err = Object.assign(new Error('user rejected request'), { code: 4001 });
    for (const r of resolvers) r.reject(err);
  }
  pending.delete(id);
  pendingResolvers.delete(id);
  seenByPopup.delete(id);
  void refreshBadge();
}

async function sign(req: PendingRequest, mnemonic: string): Promise<unknown> {
  const { payload } = req;
  const method = payload.method;
  // Use the SNAPSHOT, not the wallet's current state. Pre-fix, this
  // re-read `activeIndex()` at sign time — a user who switched account
  // mid-popup would sign with the new key while looking at the old
  // address. For methods without a `from` check (personal_sign,
  // signTypedData, wallet_signAuthorization) the swap was silent.
  const idx = req.accountIndex;
  // Assert the wallet's CURRENT chain still matches the snapshot.
  // For tx-shaped methods we'd cross chains; for sign-only methods
  // the user's typed-data domain.chainId could have been a different
  // chain when they queued. Either way: refuse.
  if (method === 'eth_sendTransaction' || method === 'wallet_signAuthorization') {
    const nowChain = await getCurrentChainId();
    if (nowChain !== req.chainId) {
      throw new Error(
        `wallet chain changed mid-popup (was ${req.chainId}, now ${nowChain}). ` +
        `Refusing to sign — switch back to chain ${req.chainId} and try again.`,
      );
    }
  }

  switch (method) {
    case 'eth_requestAccounts':
      return [addressFromMnemonic(mnemonic, idx)];

    case 'personal_sign': {
      // EIP-1474 / MetaMask convention is `[message, address]`. Geth's
      // original is `[address, message]`. ethers prior to v6 still
      // sends the geth order from `provider.send('personal_sign', ...)`.
      // Detect which slot looks like a 20-byte 0x address and treat
      // the OTHER as the message. Pre-fix the wallet treated params[0]
      // as always the message — a geth-order dapp would have the
      // wallet sign the address as if it were the message.
      const params = payload.params as unknown[];
      const isAddr = (v: unknown): v is `0x${string}` =>
        typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
      const message: unknown = isAddr(params[0]) ? params[1] : params[0];
      if (typeof message !== 'string') {
        throw new Error('personal_sign: message must be a string (hex or utf8)');
      }
      return signMessageFromMnemonic(
        mnemonic,
        message.startsWith('0x')
          ? { raw: message as `0x${string}` }
          : message,
        idx,
      );
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v1':
    case 'eth_signTypedData_v4': {
      // v4: [signer, dataJsonOrObject]   (v3 normalized to v4 upstream)
      // v1: [dataArray, signer]          (legacy MetaMask form)
      // Detect by which slot looks like an EVM address.
      const params = payload.params as unknown[];
      const isAddr = (v: unknown): v is Address =>
        typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
      const data = isAddr(params[0]) ? params[1] : params[0];
      // viem's signTypedData expects {domain, types, primaryType, message}.
      // v1's {name,type,value}[] form has no native viem path — the only dapp
      // still emitting it is MM's test page. Refuse with a clear message
      // rather than silently producing the wrong signature.
      if (Array.isArray(data)) {
        throw new Error('eth_signTypedData v1 (legacy array form) is not supported. ask the dapp to use v4.');
      }
      return signTypedDataFromMnemonic(mnemonic, data, idx);
    }

    case 'wallet_signAuthorization': {
      // EIP-7702 safety belt — chrome.md §4.4. All checks happen here at sign
      // time, AFTER the user clicked "approve" but BEFORE the private key
      // touches the message. Any of these throwing kills the signature with
      // a clear message; popup catches and toasts the reason.
      const params = payload.params as [{ address: Address; chainId: string; nonce: string }];
      const p = params[0]!;
      if (!p) throw new Error('wallet_signAuthorization: missing params');

      // Address shape (20-byte hex) only — checksum is a UI display concern,
      // not a wire-validity one. The user has already seen the full address
      // on the popup and approved it; the regex stops obvious garbage like
      // `0xABC` or non-string from reaching the signer.
      if (typeof p.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(p.address)) {
        throw new Error('wallet_signAuthorization: invalid delegate address');
      }

      // chainId / nonce must be hex strings. parseInt of "0x" or non-hex
      // returns NaN — reject before it becomes a silent zero or undefined.
      if (typeof p.chainId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(p.chainId)) {
        throw new Error('wallet_signAuthorization: chainId must be 0x-prefixed hex');
      }
      if (typeof p.nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(p.nonce)) {
        throw new Error('wallet_signAuthorization: nonce must be 0x-prefixed hex');
      }

      // JS numbers are 53-bit safe. uint64 chainId/nonce above that silently
      // truncate to a different integer — sign the wrong chain, never notice.
      // Use BigInt for the bounds check, only narrow to number after.
      const reqChainBig = BigInt(p.chainId);
      const reqNonceBig = BigInt(p.nonce);
      if (reqChainBig > BigInt(Number.MAX_SAFE_INTEGER) || reqChainBig < 0n) {
        throw new Error('wallet_signAuthorization: chainId out of safe integer range');
      }
      if (reqNonceBig > BigInt(Number.MAX_SAFE_INTEGER) || reqNonceBig < 0n) {
        throw new Error('wallet_signAuthorization: nonce out of safe integer range');
      }
      const reqChain = Number(reqChainBig);
      const reqNonce = Number(reqNonceBig);

      // chainId === 0 is the cross-chain replay marker. Signing it gives
      // the delegate jurisdiction over THIS EOA on EVERY EVM chain. Never
      // do that — even if the user approved, refuse at the wallet level.
      if (reqChain === 0) {
        throw new Error('wallet_signAuthorization: chainId 0 (cross-chain replay) refused');
      }

      // Snapshot the active chain ONCE before signing so a mid-flight switch
      // can't slip a wrong-chain signature past the assert/sign/return seam.
      const network = await cachedNetwork();
      const activeChain = network.chain.id;
      if (activeChain !== reqChain) {
        throw new Error(
          `chainId mismatch: dapp requested ${reqChain}, wallet is on ${activeChain}. Switch chain first.`,
        );
      }

      // User saw the delegate target with a red banner and an explicit
      // confirmation. We don't refuse arbitrary delegates — only structural
      // safety violations get blocked here.
      const authorization = await signAuthorizationFromMnemonic(mnemonic, {
        contractAddress: p.address,
        chainId: reqChain,
        nonce: reqNonce,
      }, idx);

      // Record the (now successful) delegation into the generic grant registry
      // so the Safety Panel (Task 4.3) can list it and offer revoke. This runs
      // ONLY after the signature is produced — any earlier throw never reaches
      // here, so we never record a delegation that didn't happen. A delegate of
      // the zero address is a REVOCATION (the EOA points back at itself): mark
      // the newest active 7702 grant revoked instead of adding a new one. The
      // entire write is best-effort — a chrome.storage hiccup must NEVER fail an
      // authorization we've already handed the signature for, so we swallow +
      // log rather than let it propagate past the return.
      try {
        const account = addressFromMnemonic(mnemonic, idx).toLowerCase();
        const now = Math.floor(Date.now() / 1000);
        if (isZeroDelegate(p.address)) {
          const id = pickNewestActive7702GrantId(await listGrants(reqChain, account));
          if (id) await revokeGrant(id, now);
        } else {
          await addGrant(
            buildDelegationGrantRecord({
              delegate: p.address,
              chainId: reqChain,
              account,
              createdAt: now,
            }),
          );
        }
      } catch (err) {
        console.warn('[7702] failed to record delegation in grant registry (non-fatal):', err);
      }

      return authorization;
    }

    case 'eth_sendTransaction': {
      const params = payload.params as [
        {
          from?: Address;
          to: Address;
          data?: `0x${string}`;
          value?: `0x${string}`;
          gas?: `0x${string}`;
          maxFeePerGas?: `0x${string}`;
          maxPriorityFeePerGas?: `0x${string}`;
          nonce?: `0x${string}`;
          authorizationList?: unknown[];
        },
      ];
      const tx = params[0]!;
      const network = await cachedNetwork();
      const wallet = cachedWalletClient(mnemonic, idx, network);
      const account = wallet.account!;
      if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`tx.from ${tx.from} does not match wallet account ${account.address}`);
      }
      // EIP-7702 DoS guard — a misbehaving dapp could pass thousands of
      // authorizations to wedge the wallet. 256 is the hard cap from the
      // chrome.md security checklist; legitimate flows use 1–2.
      if (tx.authorizationList && tx.authorizationList.length > 256) {
        throw new Error(`authorizationList too long (${tx.authorizationList.length} > 256)`);
      }
      // viem auto-detects type-4 when authorizationList is present and signs +
      // broadcasts in one shot. The authorizationList arrives in EIP-1193 wire
      // format (every numeric field hex-stringified); we normalise it back to
      // viem's typed shape via lib/auth-normalize so its serialiser doesn't
      // misfire on stringToHex of a hex literal — see auth-normalize.ts for
      // the full bug story.
      const hex = (v?: `0x${string}`) => (v ? BigInt(v) : undefined);
      const sendArgs = {
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
        ...(tx.maxFeePerGas ? { maxFeePerGas: hex(tx.maxFeePerGas) } : {}),
        ...(tx.maxPriorityFeePerGas ? { maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas) } : {}),
        ...(tx.nonce ? { nonce: parseInt(tx.nonce, 16) } : {}),
        ...(tx.authorizationList
          ? { authorizationList: normalizeAuthorizationList(tx.authorizationList) }
          : {}),
      };
      // Diagnostic: dump the full tx including authorizationList when rpcTrace
      // is on, so a failed 7702 activation can be inspected (auth nonce / chainId
      // / yParity vs. the on-chain tx via Sepolia explorer).
      const flags = await getCachedDevFlags();
      if (flags.rpcTrace) {
        try {
          console.log(`[rpc] eth_sendTransaction sendArgs:`, JSON.stringify(sendArgs, (_k, v) =>
            typeof v === 'bigint' ? `0x${v.toString(16)}` : v,
          ));
        } catch { /* trace must never break dispatch */ }
      }
      // Predict the nonce before broadcast so we can record it in
      // the activity log. dapp-supplied nonce wins; otherwise we read
      // the EOA's pending nonce (viem uses the same value internally).
      // Used downstream by addActivity for speed-up / cancel dedup
      // (same nonce + different hash collapses onto the original row).
      let predictedNonce: number | undefined;
      if (tx.nonce) {
        const n = BigInt(tx.nonce);
        if (n <= BigInt(Number.MAX_SAFE_INTEGER)) predictedNonce = Number(n);
      } else {
        try {
          predictedNonce = await cachedPublicClient(network).getTransactionCount({
            address: account.address, blockTag: 'pending',
          });
        } catch { /* leave undefined; dedup just becomes hash-only */ }
      }
      const hash = await wallet.sendTransaction(sendArgs as Parameters<typeof wallet.sendTransaction>[0]);
      const isAuth = !!(tx.authorizationList && tx.authorizationList.length > 0);
      await addActivity({
        hash,
        chainId: network.chain.id,
        account: account.address.toLowerCase(),
        kind: isAuth ? '7702' : classifyTx({ to: tx.to, data: tx.data, value: tx.value }),
        to: tx.to,
        value: tx.value ? BigInt(tx.value).toString() : '0',
        data: tx.data ?? null,
        nonce: predictedNonce,
        addedAt: Date.now(),
        status: 'pending',
      });
      return hash;
    }

    case 'wallet_addEthereumChain': {
      const params = payload.params as [
        {
          chainId: string;
          chainName: string;
          rpcUrls: string[];
          nativeCurrency?: { symbol?: string };
          blockExplorerUrls?: string[];
        },
      ];
      const p = params[0]!;
      const id = parseInt(p.chainId, 16);
      if (!p.rpcUrls?.[0]) throw new Error('rpcUrls[0] is required');
      await addCustomChain({
        chainId: id,
        name: p.chainName,
        rpcUrl: p.rpcUrls[0],
        symbol: p.nativeCurrency?.symbol,
        blockExplorer: p.blockExplorerUrls?.[0],
      });
      return null;
    }

    case 'wallet_watchAsset': {
      // EIP-747. Validation in handleRpcFromPage already confirmed the
      // type is one of ERC20 / ERC721 / ERC1155 + address shape.
      // Approval step already happened in the popup; here we persist
      // to the appropriate list for the active chain.
      const params = payload.params as {
        type: 'ERC20' | 'ERC721' | 'ERC1155';
        options: {
          address: Address;
          symbol?: string;
          decimals?: number;
          image?: string;
          tokenId?: string;
        };
      };
      const o = params.options;
      const chainId = await getCurrentChainId();
      const network = await cachedNetwork();

      if (params.type === 'ERC20') {
        // Fetch on-chain decimals/symbol/name to corroborate (or fill
        // gaps in) what the dapp suggested. Dapp-provided strings are
        // advisory — a phisher could lie. addTokenRecord stores the
        // on-chain truth.
        try {
          const meta = await fetchTokenMeta(network.chain, network.rpcUrl, o.address);
          await addTokenRecord(chainId, {
            address: o.address.toLowerCase() as Address,
            name: meta.name,
            symbol: meta.symbol,
            decimals: meta.decimals,
          });
        } catch {
          // Fall back to dapp-supplied metadata if chain read fails
          // (custom chain w/o proper RPC etc.). Better than no token.
          if (!o.symbol || o.decimals === undefined) {
            throw new Error('could not fetch token metadata and dapp omitted symbol/decimals');
          }
          await addTokenRecord(chainId, {
            address: o.address.toLowerCase() as Address,
            name: o.symbol,
            symbol: o.symbol,
            decimals: o.decimals,
          });
        }
      } else {
        // ERC721 / ERC1155 — reuse the manual-add `addNft` path
        // entirely. Same ownership check (phishing defence), same
        // on-chain metadata fetch, same persistence shape. validator
        // already confirmed tokenId is present + parseable.
        await addNft(o.address, o.tokenId!);
      }
      // EIP-747 spec: return true on success.
      return true;
    }

    case 'wallet_grantPermissions': {
      // ERC-7715 scoped grant. The scope was parsed, normalized, and
      // serialized upfront in handleRpcFromPage (a malformed request never
      // reaches this queue), so here we only RECORD it and hand back a
      // permission context. No signature, no transaction — the wallet is not
      // a UserOp signer; a relayer redeems the returned context out-of-band.
      const scope = req.grantScope;
      if (!scope) {
        // Defensive: the dispatcher only queues grants WITH a parsed scope.
        throw new Error('wallet_grantPermissions: missing parsed scope on pending request');
      }
      const account = addressFromMnemonic(mnemonic, idx).toLowerCase();
      const createdAt = Math.floor(Date.now() / 1000);
      const target = scope.target;
      const chainId = req.chainId;
      const id = `${chainId}:${target}:${createdAt}`;
      const record: GrantRecord = {
        id,
        kind: 'session',
        chainId,
        account,
        target,
        scope,
        createdAt,
        expiry: scope.expiry,
      };
      await addGrant(record);
      // ERC-7715-style result. Top-level {id, target, expiry, scope} gives a
      // relayer everything it needs to redeem the grant; grantedPermissions +
      // permissionsContext match the shape wagmi/viem's ERC-7715 client reads.
      // `permissionsContext` is the opaque handle the relayer echoes back — we
      // use the globally-unique grant id.
      return {
        id,
        target,
        expiry: scope.expiry,
        scope,
        grantedPermissions: [{ type: 'session', target, scope, expiry: scope.expiry }],
        permissionsContext: id,
      };
    }

    default:
      throw new Error(`unhandled sign method: ${method}`);
  }
}


// ─── Token-balance cache (chrome.storage.local, per chain+account) ────────
// Persistent across browser restarts so the FIRST popup open of the day
// renders previous balances instantly while a fresh fetch runs in the
// background (stale-while-revalidate).
//
// Storage shape: a single map keyed by `${chainId}:${address.toLowerCase()}`
// so multiple accounts / chains coexist. Switching account doesn't wipe
// the previous one's cache.
//
// Two consumption modes:
//   - readBalanceCacheFresh: respects TTL, returns null when stale →
//     drives the SW's "should I skip the RPC?" decision in
//     readTokenBalances.
//   - readBalanceCacheStale: ignores TTL, returns whatever's persisted
//     → drives the popup's initial-paint stale-while-revalidate flow.

const BALANCE_CACHE_KEY = 'balCacheV2';
const BALANCE_CACHE_TTL_MS = 30_000;

type CachedBalancesEntry = {
  ts: number;
  // Stored as `unknown` so the cache can hold either the raw token-row array
  // (legacy shape) or the new {tokens, ethUsdRate} envelope. Reader
  // narrows on shape.
  rows: unknown;
};
type BalanceCacheMap = Record<string, CachedBalancesEntry>;

async function loadBalanceCacheMap(): Promise<BalanceCacheMap> {
  try {
    const got = await chrome.storage.local.get(BALANCE_CACHE_KEY);
    return (got[BALANCE_CACHE_KEY] as BalanceCacheMap | undefined) ?? {};
  } catch {
    return {};
  }
}

async function readBalanceCacheFresh(key: string): Promise<unknown | null> {
  const map = await loadBalanceCacheMap();
  const c = map[key];
  if (!c) return null;
  if (Date.now() - c.ts > BALANCE_CACHE_TTL_MS) return null;
  return c.rows;
}

/** Stale-while-revalidate path — returns the cache regardless of TTL.
 *  Includes the timestamp so the UI can show "X minutes ago" hints
 *  (or simply trust the fresh refetch to overwrite shortly). */
async function readBalanceCacheStale(
  key: string,
): Promise<{ rows: unknown; fetchedAt: number } | null> {
  const map = await loadBalanceCacheMap();
  const c = map[key];
  if (!c) return null;
  return { rows: c.rows, fetchedAt: c.ts };
}

async function writeBalanceCache(key: string, rows: unknown): Promise<void> {
  try {
    const map = await loadBalanceCacheMap();
    map[key] = { ts: Date.now(), rows };
    await chrome.storage.local.set({ [BALANCE_CACHE_KEY]: map });
  } catch { /* storage full is unlikely; ignore */ }
}

async function invalidateBalanceCache(): Promise<void> {
  // Clear ALL accounts/chains. Called on send / token-add / lock / reset —
  // any one of those can invalidate balances broadly enough that targeted
  // eviction isn't worth the complexity.
  try { await chrome.storage.local.remove(BALANCE_CACHE_KEY); } catch {}
}

// ─── USD price feed (DefiLlama) ────────────────────────────────────────────
// Free, no-API-key endpoint that takes `${chain}:${addr}` keys and returns
// USD prices. Mainnet + L2s only — Sepolia (and other testnets) get no
// price coverage on purpose (testnet tokens have no USD value).
//
// Cache hits served in-memory for 60s so a dashboard refresh doesn't re-hit
// the network. Cache survives until SW idle (then everything reloads anyway).

const PRICE_TTL_MS = 60_000;
type PriceEntry = { price: number; ts: number };
const priceCache = new Map<string, PriceEntry>();

/** Map chainId → DefiLlama chain slug. Only chains the API supports go here.
 *  Anything else returns null prices (sepolia, anvil, custom). */
const LLAMA_CHAIN_SLUGS: Record<number, string> = {
  1:     'ethereum',
  10:    'optimism',
  56:    'bsc',
  137:   'polygon',
  8453:  'base',
  42161: 'arbitrum',
};

/** Native asset → CoinGecko id used by DefiLlama via the `coingecko:` prefix. */
function nativeCoingeckoId(symbol: string | undefined): string | null {
  switch (symbol) {
    case 'ETH':   return 'coingecko:ethereum';
    case 'BNB':   return 'coingecko:binancecoin';
    case 'MATIC': return 'coingecko:matic-network';
    default:      return null;
  }
}

async function fetchPricesFromLlama(keys: string[]): Promise<Record<string, number>> {
  if (keys.length === 0) return {};
  const url = `https://coins.llama.fi/prices/current/${keys.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`price fetch HTTP ${res.status}`);
  const j = (await res.json()) as { coins: Record<string, { price: number }> };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(j.coins)) {
    out[k.toLowerCase()] = v.price;
  }
  return out;
}

async function getPrices(keys: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const stale = keys.filter((k) => {
    const c = priceCache.get(k.toLowerCase());
    return !c || now - c.ts > PRICE_TTL_MS;
  });
  if (stale.length > 0) {
    try {
      const fresh = await fetchPricesFromLlama(stale);
      for (const [k, p] of Object.entries(fresh)) {
        priceCache.set(k.toLowerCase(), { price: p, ts: now });
      }
    } catch {
      // Network blip — leave cache; missing keys just return absent below.
    }
  }
  const out: Record<string, number> = {};
  for (const k of keys) {
    const c = priceCache.get(k.toLowerCase());
    if (c) out[k.toLowerCase()] = c.price;
  }
  return out;
}

// ─── HD account management ─────────────────────────────────────────────────

type AccountWithAddress = AccountRecord & {
  address: Address;
  /** Active-chain native balance (formatted as a decimal string) — populated
   *  best-effort via Multicall3's getEthBalance. `null` when RPC fails or
   *  the chain has no Multicall3 fallback path that could resolve. */
  nativeBalance?: string | null;
  /** Active chain's native symbol so the picker can show "1.234 ETH". */
  nativeSymbol?: string;
};

async function listAccountsWithAddresses(): Promise<AccountWithAddress[]> {
  if (!unlockedMnemonic) throw new Error('locked');
  const records = await getAccounts();
  const network = await cachedNetwork();
  const accounts = records.map((r) => ({
    ...r,
    address: addressFromMnemonic(unlockedMnemonic!, r.index),
  }));

  // Read every account's native balance in one Multicall3 call (1 RPC),
  // falling back to N parallel getBalance reads if multicall isn't deployed.
  const c = cachedPublicClient(network);
  const sym = network.chain.nativeCurrency?.symbol ?? 'ETH';
  let balances: (string | null)[];
  try {
    if (await detectMulticallSupport(c, network.rpcUrl)) {
      const results = await c.multicall({
        contracts: accounts.map((a) => ({
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionName: 'getEthBalance' as const,
          args: [a.address] as const,
        })),
        multicallAddress: MULTICALL3_ADDRESS,
        allowFailure: true,
      });
      balances = results.map((r) =>
        r.status === 'success' && typeof r.result === 'bigint'
          ? formatUnits(r.result, network.chain.nativeCurrency?.decimals ?? 18)
          : null,
      );
    } else {
      balances = await Promise.all(
        accounts.map(async (a) => {
          try {
            const raw = await c.getBalance({ address: a.address });
            return formatUnits(raw, network.chain.nativeCurrency?.decimals ?? 18);
          } catch {
            return null;
          }
        }),
      );
    }
  } catch {
    balances = accounts.map(() => null);
  }

  return accounts.map((a, i) => ({
    ...a,
    nativeBalance: balances[i]!,
    nativeSymbol: sym,
  }));
}

async function addAccount(): Promise<AccountWithAddress> {
  if (!unlockedMnemonic) throw new Error('locked');
  let newRec!: AccountRecord;
  await mutateAccounts((records) => {
    // Smallest unused non-negative index — usually max+1 but tolerant of
    // gaps from a future "remove account" feature.
    const used = new Set(records.map((r) => r.index));
    let next = 0;
    while (used.has(next)) next++;
    newRec = { index: next, label: `Account ${records.length + 1}` };
    return [...records, newRec];
  });
  return { ...newRec, address: addressFromMnemonic(unlockedMnemonic, newRec.index) };
}

async function switchAccount(index: number): Promise<AccountWithAddress> {
  if (!unlockedMnemonic) throw new Error('locked');
  const records = await getAccounts();
  if (!records.some((r) => r.index === index)) {
    throw new Error(`account index ${index} not in list`);
  }
  await setActiveAccountIndex(index);
  // Balance cache key includes the active address; switching the active
  // account changes the key, but the popup's first read after switch can
  // still race with a stale entry held in memory if not explicitly cleared.
  await invalidateBalanceCache();
  await scheduleAutoLock();
  const rec = records.find((r) => r.index === index)!;
  const address = addressFromMnemonic(unlockedMnemonic, index);
  // Propagate to every connected dapp — same convention as MetaMask /
  // Rabby. Dapps using wagmi / web3-react listen on accountsChanged and
  // re-derive the connected account from the event payload. Without this
  // broadcast a UI account switch silently desyncs from connected dapps,
  // leaving the dapp signing as the previous account.
  await broadcastEvent('accountsChanged', [address]);
  return { ...rec, address };
}

async function renameAccount(index: number, label: string): Promise<void> {
  await mutateAccounts((records) => records.map((r) => (r.index === index ? { ...r, label } : r)));
}

// ─── ERC-20 token list helpers ─────────────────────────────────────────────

async function addToken(address: string): Promise<unknown> {
  const network = await cachedNetwork();
  // Normalise to checksummed-lower form for storage; viem will read as-is.
  const addr = address.trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('invalid address');
  let meta;
  try {
    meta = await fetchTokenMeta(network.chain, network.rpcUrl, addr);
  } catch (e) {
    // viem surfaces "cannot parse json-rpc response" when the public RPC
    // returns a 502/Cloudflare error page instead of JSON; rethrow with
    // a popup-friendly message so the user knows whose fault it is.
    const msg = e instanceof Error ? e.message : String(e);
    if (/parse json-rpc|invalid chars|upstream/i.test(msg)) {
      throw new Error(
        `RPC error: ${network.chain.name} provider (${new URL(network.rpcUrl).hostname}) ` +
          'returned a non-JSON response. Try again, or switch RPC in Settings.',
      );
    }
    if (/reverted|returned no data/i.test(msg)) {
      throw new Error(`not an ERC-20 token at ${addr} (call to decimals/symbol/name reverted)`);
    }
    throw new Error(`couldn't read token: ${msg}`);
  }
  await addTokenRecord(network.chain.id, {
    address: meta.address,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
  });
  return meta;
}

// ─── NFT add — single contract + tokenId, on-chain metadata ──────────
// Auto-discovery was removed: the Transfer-event scan exceeded public
// RPC range limits (publicnode 50k / Alchemy & Infura free 10k) on
// any non-trivial wallet, and even after chunking it leaked the
// user's address to the RPC across many requests.
// Always returns an array (length 1) so the popup keeps a single
// response shape.
async function addNft(rawAddress: string, rawTokenId: string): Promise<NftRecord[]> {
  const network = await cachedNetwork();
  const address = rawAddress.trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('invalid contract address');
  }

  const standard = await detectNftStandard(network.chain, network.rpcUrl, address);
  if (!standard) {
    throw new Error(
      `not an ERC-721 or ERC-1155 contract at ${address} ` +
      '(supportsInterface returned false / reverted on this chain)',
    );
  }

  const owner = await unlockedAddress();
  const trimmedId = rawTokenId.trim();
  if (trimmedId === '') throw new Error('tokenId is required');

  let tokenId: bigint;
  try {
    tokenId = BigInt(trimmedId);
  } catch {
    throw new Error('tokenId must be a non-negative integer (decimal or 0x-hex)');
  }
  if (tokenId < 0n) throw new Error('tokenId must be non-negative');

  const ownsIt = await verifyNftOwnership(
    network.chain, network.rpcUrl, address, tokenId, standard, owner,
  );
  if (ownsIt.kind === 'not-minted') {
    throw new Error(
      `${standard} #${tokenId.toString()} on ${address} hasn't been minted yet. ` +
      'Mint it first (or pick a tokenId that exists) — adding a record for a ' +
      'non-existent token would just fail every send/refresh later.',
    );
  }
  if (ownsIt.kind === 'wrong-owner') {
    const actualSuffix = ownsIt.actual ? ` (currently owned by ${ownsIt.actual})` : '';
    throw new Error(
      `${owner} doesn't currently own ${standard} ${address} #${tokenId.toString()}${actualSuffix}. ` +
      'Refusing to add — looks like a phishing attempt or you swapped accounts.',
    );
  }
  // ownsIt.kind === 'owns' OR 'rpc-unknown' → proceed. rpc-unknown
  // legitimately covers custom chains / flaky RPCs where the read
  // failed for non-content reasons; refusing those would block too
  // many real cases.
  const rec = await materializeNftRecord(network, address, tokenId, standard, owner);
  await addNftRecord(network.chain.id, rec);
  return [rec];
}

/** Read a single NFT's metadata + assemble a persistable NftRecord.
 *  Shared by both the single-add and discovery paths in addNft. The
 *  ERC-1155 balance is read in parallel with metadata so the popup's
 *  "× N" badge has a real number on first render (instead of waiting
 *  for a follow-up refresh). */
async function materializeNftRecord(
  network: Network,
  address: `0x${string}`,
  tokenId: bigint,
  standard: 'ERC721' | 'ERC1155',
  owner: `0x${string}`,
): Promise<NftRecord> {
  const [meta, bal] = await Promise.all([
    fetchNftMeta(network.chain, network.rpcUrl, address, tokenId, standard),
    getNftBalance(network.chain, network.rpcUrl, address, tokenId, standard, owner),
  ]);
  return {
    address: address.toLowerCase(),
    tokenId: tokenId.toString(),
    standard,
    name: meta.name,
    imageCandidates: meta.imageCandidates,
    description: meta.description,
    // ERC-721 always reads as 1n. ERC-1155 reads owner's balanceOf;
    // null = RPC failure, UI omits the badge rather than showing "× 0".
    balance: bal === null ? null : bal.toString(),
    addedAt: Date.now(),
  };
}

/** Re-read balanceOf for a stored ERC-1155 NFT and persist the result.
 *  For ERC-721 records this is a fast no-op (balance is always "1" by
 *  definition). Returns the updated record so the popup's detail-modal
 *  refresh button can swap state without a separate listNfts round-trip. */
async function refreshNftBalance(
  rawAddress: string,
  rawTokenId: string,
): Promise<NftRecord | null> {
  const network = await cachedNetwork();
  const chainId = network.chain.id;
  const list = await listNfts(chainId);
  const addr = rawAddress.toLowerCase();
  const rec = list.find((n) => n.address.toLowerCase() === addr && n.tokenId === rawTokenId);
  if (!rec) return null;
  const owner = await unlockedAddress();
  const bal = await getNftBalance(
    network.chain, network.rpcUrl,
    rec.address as `0x${string}`, BigInt(rec.tokenId), rec.standard, owner,
  );
  const updated: NftRecord = { ...rec, balance: bal === null ? null : bal.toString() };
  await addNftRecord(chainId, updated);
  return updated;
}

/** Poll receipts for every still-pending activity entry on the
 *  current (chain, account) bucket and flip status to success/failed.
 *  Returns the post-refresh list so the popup can swap state in one
 *  round-trip. Receipts that haven't landed yet stay 'pending' — we
 *  don't downgrade or wait for confirmations, the user can click
 *  refresh again later. */
async function refreshActivityStatuses(): Promise<ActivityEntry[]> {
  const network = await cachedNetwork();
  const pub = cachedPublicClient(network);
  const acct = await unlockedAddress();
  const list = await listActivity(network.chain.id, acct);
  const pending = list.filter((e) => e.status === 'pending');
  // Parallel receipt fetch capped at 8 — popups don't reload often
  // and pending lists are bounded by MAX_PER_BUCKET, but a slow RPC
  // shouldn't tie up every connection.
  const CONCURRENCY = 8;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const chunk = pending.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (e) => {
      try {
        const r = await pub.getTransactionReceipt({ hash: e.hash as `0x${string}` });
        const ok = r.status === 'success';
        await updateActivityStatus(network.chain.id, acct, e.hash, ok ? 'success' : 'failed');
      } catch {
        // Receipt not mined yet — leave as pending. Other RPC errors
        // (network blip) also leave as pending; next refresh tries again.
      }
    }));
  }
  return listActivity(network.chain.id, acct);
}

/** Resolve an ENS name (or address-passthrough) using viem's mainnet
 *  Universal Resolver. ENS lives on mainnet; CCIP-Read inside viem
 *  bridges to L2 / off-chain resolvers transparently when the record
 *  has been ENS-Improvement-Proposal-3668-set up. Returns null when:
 *    - input doesn't look like an ENS name (no `.` → noop)
 *    - resolver returns the zero address / no record
 *    - mainnet RPC fails
 *  Bare 0x addresses pass through unchanged so callers can funnel any
 *  user-typed recipient through this one helper. */
async function resolveEns(rawName: string): Promise<string | null> {
  const name = rawName.trim();
  if (!name) return null;
  // Already an address — short-circuit without an RPC roundtrip.
  if (/^0x[0-9a-fA-F]{40}$/.test(name)) return name;
  // Not an ENS-shaped name (must contain at least one dot). Avoids
  // burning an RPC call on every keystroke of '0xabc'.
  if (!name.includes('.')) return null;
  try {
    // ENS canonical chain is mainnet; we use whatever rpcUrl the user
    // has configured for chainId 1. If the user only has a custom chain
    // active (e.g. anvil), we still need mainnet for ENS — fall back
    // to BUILTIN_NETWORKS[1] when storage has no mainnet entry.
    const mainnet = BUILTIN_NETWORKS[1];
    if (!mainnet) return null;
    const { createPublicClient, http } = await import('viem');
    const { normalize } = await import('viem/ens');
    // `ccipRead: false` at the client level disables off-chain
    // gateway lookups (EIP-3668). CCIP-Read responses come from
    // arbitrary HTTPS URLs the resolver names — leaving it on lets
    // a malicious *.eth name point the SW at any URL it wants
    // (SSRF, LAN scans, etc.). On-chain-only resolution loses a
    // niche feature but keeps the threat surface bounded; the
    // wallet doesn't need off-chain ENS for Send UX.
    const ensClient = createPublicClient({
      chain: mainnet.chain,
      transport: http(mainnet.rpcUrl, { timeout: 15_000 }),
      ccipRead: false,
    });
    const addr = await ensClient.getEnsAddress({ name: normalize(name) });
    // Treat the zero address as "no record". viem returns 0x0…0 for
    // names whose resolver is set but `addr` text-record is empty;
    // the Send screen would otherwise broadcast to the zero address
    // (validRecipient regex matches it). Null forces the UI to show
    // "no ENS record found" instead of silently sending into the
    // burn address.
    if (!addr || /^0x0+$/.test(addr)) return null;
    return addr;
  } catch {
    return null;
  }
}

/** Reverse-resolve an address to its primary ENS name. Returns null
 *  when the address has no reverse-resolver set or the lookup fails.
 *  Cached in-memory for the SW lifetime — the user typically views
 *  the same recent recipients across screens, no point repeating the
 *  multi-hop resolver lookup. Cache is per-address (not per chain)
 *  because ENS lives on mainnet regardless of which chain you're on. */
const ensNameCache = new Map<string, { name: string | null; ts: number }>();
const ENS_NAME_TTL_MS = 5 * 60 * 1000;
async function resolveEnsName(rawAddress: string): Promise<string | null> {
  const addr = rawAddress.trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  const hit = ensNameCache.get(addr);
  if (hit && Date.now() - hit.ts < ENS_NAME_TTL_MS) return hit.name;
  try {
    const mainnet = BUILTIN_NETWORKS[1];
    if (!mainnet) return null;
    const { createPublicClient, http } = await import('viem');
    // ccipRead: false — same SSRF concern as the forward path.
    const ensClient = createPublicClient({
      chain: mainnet.chain,
      transport: http(mainnet.rpcUrl, { timeout: 15_000 }),
      ccipRead: false,
    });
    const name = await ensClient.getEnsName({ address: addr as `0x${string}` });
    ensNameCache.set(addr, { name: name ?? null, ts: Date.now() });
    return name ?? null;
  } catch {
    // Cache the null too so a flaky resolver doesn't make every row
    // re-fetch on every render. Shorter TTL for failures so a real
    // recovery picks up within 30 s.
    ensNameCache.set(addr, { name: null, ts: Date.now() - (ENS_NAME_TTL_MS - 30_000) });
    return null;
  }
}

/** Sentinel address used for the synthetic native row at the top of the
 *  token list. Real ERC-20 tokens are 0x-prefixed 40 hex chars; this string
 *  never collides. */
const NATIVE_TOKEN_ADDR = 'native';

type TokenMetaRow = {
  address: string; // either NATIVE_TOKEN_ADDR or `0x${string}`
  symbol: string;
  name: string;
  decimals: number;
  builtin: boolean;
  /** True only on the synthetic native row (ETH on mainnet/sepolia). The
   *  popup uses this to read balance from `getBalance` instead of `balanceOf`
   *  and to suppress the remove button. */
  isNative?: boolean;
};

type TokenBalanceRow = TokenMetaRow & {
  balance: string;
  /** USD price per unit of token, or null if no price feed. */
  priceUsd: number | null;
};

/** Reply shape for `read-token-balances`: token list + the current ETH/USD
 *  spot rate so the UI can render balances in either currency. `ethUsdRate`
 *  is null when DefiLlama doesn't return a fresh quote (network blip,
 *  testnet, etc.) — UI falls back to USD display in that case. */
export type ReadTokenBalancesReply = {
  tokens: TokenBalanceRow[];
  ethUsdRate: number | null;
};

const ETH_PRICE_KEY = 'coingecko:ethereum';

/** Cheap metadata list for the current chain — native first, then builtins,
 *  then user-added. No RPC calls; safe to render the dashboard immediately. */
async function listTokenMeta(): Promise<TokenMetaRow[]> {
  const network = await cachedNetwork();
  const chainId = network.chain.id;
  const builtins = BUILTIN_TOKENS[chainId] ?? [];
  const userAdded = await listTokens(chainId);

  // Native first — chain's gas asset (ETH on mainnet, BNB on BSC, etc.)
  const nativeSym = network.chain.nativeCurrency?.symbol ?? 'ETH';
  const nativeName = network.chain.nativeCurrency?.name ?? 'Ether';
  const out: TokenMetaRow[] = [
    {
      address: NATIVE_TOKEN_ADDR,
      symbol: nativeSym,
      name: nativeName,
      decimals: network.chain.nativeCurrency?.decimals ?? 18,
      builtin: true,
      isNative: true,
    },
  ];

  const seen = new Set<string>([NATIVE_TOKEN_ADDR]);
  for (const t of builtins) {
    const key = t.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: t.address as `0x${string}`,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      builtin: true,
    });
  }
  for (const t of userAdded) {
    const key = t.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: t.address as `0x${string}`,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      builtin: false,
    });
  }
  return out;
}

async function readTokenBalances(): Promise<ReadTokenBalancesReply> {
  if (!unlockedMnemonic) throw new Error('locked');
  const network = await cachedNetwork();
  const owner = await unlockedAddress();

  // Cache hit — return last computed balances without hitting RPC. Cache is
  // per (chain, account), TTL 30 s. Invalidated on send / add-token /
  // remove-token / switch-chain / switch-account / lock / reset.
  const cacheKey = `${network.chain.id}:${owner.toLowerCase()}`;
  const cached = await readBalanceCacheFresh(cacheKey);
  if (cached) return cached as ReadTokenBalancesReply;

  const meta = await listTokenMeta();

  // Build the price-key set up front so we make exactly one DefiLlama call.
  // Always include ETH/USD so the UI can switch currency without a refetch.
  const slug = LLAMA_CHAIN_SLUGS[network.chain.id] ?? null;
  const nativeId = nativeCoingeckoId(network.chain.nativeCurrency?.symbol);
  const priceKeys: string[] = [ETH_PRICE_KEY];
  if (nativeId) priceKeys.push(nativeId);
  if (slug) {
    for (const t of meta) {
      if (t.isNative) continue;
      priceKeys.push(`${slug}:${t.address.toLowerCase()}`);
    }
  }

  // Fire balance multicall + price fetch in parallel. Two network round-trips
  // total (one chain RPC for all balances, one HTTP to DefiLlama) regardless
  // of how many tokens are in the list.
  const [balances, prices] = await Promise.all([
    fetchTokenBalancesBatch(
      network.chain,
      network.rpcUrl,
      owner,
      meta.map((t) => ({
        address: t.address,
        decimals: t.decimals,
        isNative: t.isNative,
      })),
    ),
    getPrices(priceKeys),
  ]);

  const priceFor = (t: TokenMetaRow): number | null => {
    if (t.isNative) {
      return nativeId ? (prices[nativeId.toLowerCase()] ?? null) : null;
    }
    if (!slug) return null;
    return prices[`${slug}:${t.address.toLowerCase()}`] ?? null;
  };

  const tokens = meta.map((t, i) => ({
    ...t,
    balance: balances[i] ?? '0',
    priceUsd: priceFor(t),
  }));
  const ethUsdRate = prices[ETH_PRICE_KEY.toLowerCase()] ?? null;
  const result: ReadTokenBalancesReply = { tokens, ethUsdRate };
  await writeBalanceCache(cacheKey, result);
  return result;
}

/** Stale-while-revalidate handler for the popup. Returns whatever's
 *  cached for the current account+chain regardless of TTL, so the
 *  dashboard can paint last-known balances on first frame even if the
 *  wallet hasn't been opened in days. Returns null when:
 *    - wallet is locked (no owner to key by)
 *    - cache is empty for this (chainId, owner) pair
 *  The dashboard's normal `read-token-balances` call still runs after
 *  this one and overwrites with fresh data. */
async function readStaleTokenBalances(): Promise<
  (ReadTokenBalancesReply & { fetchedAt: number }) | null
> {
  if (!unlockedMnemonic) return null;
  const network = await cachedNetwork();
  const owner = await unlockedAddress();
  const cacheKey = `${network.chain.id}:${owner.toLowerCase()}`;
  const entry = await readBalanceCacheStale(cacheKey);
  if (!entry) return null;
  // Defensive shape narrowing — chrome.storage.session entries from
  // an older cache layout (different from the current
  // ReadTokenBalancesReply envelope) could still be sitting in storage
  // after an extension upgrade. Treat any unexpected shape as a miss
  // so we re-fetch rather than crash a destructure.
  const rows = entry.rows as Partial<ReadTokenBalancesReply> | undefined;
  if (!rows || !Array.isArray(rows.tokens)) return null;
  return {
    tokens: rows.tokens,
    ethUsdRate: rows.ethUsdRate ?? null,
    fetchedAt: entry.fetchedAt,
  };
}

// ─── message router ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: ToBackground, _sender, send: (r: FromBackground) => void) => {
  (async () => {
    try {
      // SW may have just woken up — restore unlocked state from session
      // storage so handlers don't see a falsely-locked wallet.
      await ensureUnlockRestored();
      switch (raw.kind) {
        case 'rpc-from-page': {
          // Run handler, then trace the outcome (success value or reject
          // error+code) before re-throwing or replying. The `→` request
          // line is printed inside handleRpcFromPage; this prints `←` so
          // request/response pair up clearly in the SW console.
          let traceResult: unknown;
          let traceErr: Error | null = null;
          try {
            traceResult = await handleRpcFromPage(raw.origin, raw.payload);
          } catch (e) {
            traceErr = e instanceof Error ? e : new Error(String(e));
          }
          const flags = await getCachedDevFlags();
          if (flags.rpcTrace) {
            try {
              if (traceErr) {
                const code = (traceErr as { code?: unknown }).code;
                console.log(`[rpc] ← ${raw.payload.method}  ERR  code=${code ?? '-'}  ${traceErr.message}`);
              } else {
                // Full result; same reasoning as the request-side trace.
                const full = JSON.stringify(traceResult) ?? 'undefined';
                console.log(`[rpc] ← ${raw.payload.method}  OK   ${full}`);
              }
            } catch { /* never let trace break dispatch */ }
          }
          if (traceErr) throw traceErr;
          send({ ok: true, data: traceResult });
          break;
        }
        case 'list-pending-requests':
          send({ ok: true, data: Array.from(pending.values()) });
          break;
        case 'approve-pending-request':
          send({ ok: true, data: await approve(raw.id, raw.password, raw.txOverride) });
          break;
        case 'reject-pending-request':
          reject(raw.id);
          send({ ok: true, data: null });
          break;
        case 'reject-pending-from-origin': {
          // Reject every queued request from this origin (parallel calls
          // already coalesce, so this is mostly belt-and-suspenders for the
          // "user rejected one, another snuck in mid-await" race).
          for (const [id, req] of Array.from(pending.entries())) {
            if (req.origin === raw.origin) reject(id);
          }
          send({ ok: true, data: null });
          break;
        }
        case 'unlock': {
          const vault = await getVault();
          if (!vault) throw new Error('no vault');
          unlockedMnemonic = await decryptMnemonic(vault, raw.password);
          await scheduleAutoLock();
          // Return the address for the *active* HD index, not always index 0,
          // so the popup lands on the same account the user picked last.
          send({ ok: true, data: await unlockedAddress() });
          break;
        }
        case 'lock':
          unlockedMnemonic = null;
          await clearAutoLock();
          await invalidateBalanceCache();
          // Drop session-scoped dev flags (allowUnverifiedDelegate +
          // any future security-sensitive opt-in). Bust the in-memory
          // cache so the next read re-merges from a now-empty session.
          await clearSessionDevFlags();
          devFlagsCache = null;
          await broadcastEvent('accountsChanged', []);
          send({ ok: true, data: null });
          break;
        case 'is-unlocked':
          send({ ok: true, data: unlockedMnemonic !== null });
          break;
        case 'get-account':
          if (!unlockedMnemonic) throw new Error('locked');
          // Must respect the active HD index — without it, every popup
          // re-route after a `switch-account` would still see Account 1's
          // address and the UI would silently revert.
          send({ ok: true, data: await unlockedAddress() });
          break;
        case 'switch-chain': {
          await switchChain(raw.chainId, raw.rpcUrl);
          send({ ok: true, data: raw.chainId });
          break;
        }
        case 'remove-chain': {
          // Drop a specific user-added custom chain entry, identified by
          // the (chainId, rpcUrl) composite key. Multiple entries can share
          // a chainId — only the matching rpcUrl is removed.
          await removeCustomChain(raw.chainId, raw.rpcUrl);
          send({ ok: true, data: raw.chainId });
          break;
        }
        case 'get-current-chain':
          send({ ok: true, data: await getCurrentChainId() });
          break;
        case 'list-connected-origins':
          send({ ok: true, data: await getConnectedOrigins() });
          break;
        case 'list-connected-sites': {
          // Richer view for the dedicated Connected Sites screen — each row
          // includes the account that origin is pinned to, so the user can
          // see "uniswap.org → Account 1" at a glance.
          if (!unlockedMnemonic) throw new Error('locked');
          const origins = await getConnectedOrigins();
          const accounts = await getAccounts();
          const labelFor = (idx: number): string =>
            accounts.find((a) => a.index === idx)?.label ?? `Account ${idx + 1}`;
          const fallbackIdx = await getActiveAccountIndex();
          const pinMap = await getOriginAccountMap();
          const sites = origins.map((origin) => {
            const saved = pinMap[origin];
            const idx = saved !== undefined ? saved : fallbackIdx;
            const address = addressFromMnemonic(unlockedMnemonic!, idx);
            return { origin, accountIndex: idx, accountLabel: labelFor(idx), address };
          });
          send({ ok: true, data: sites });
          break;
        }
        case 'revoke-origin':
          await removeConnectedOrigin(raw.origin);
          await clearOriginAccount(raw.origin);
          // Emit EIP-1193 disconnect for the revoked origin so wagmi /
          // viem react instantly instead of catching up on the next
          // eth_accounts poll. ProviderRpcError shape: code 4900 =
          // "disconnected from all chains and accounts".
          await broadcastEvent('disconnect', {
            code: 4900, message: 'wallet revoked permission for this origin',
          });
          send({ ok: true, data: null });
          break;
        // ── Grant registry (Safety Panel, Task 4.3) ──────────────────────
        // Generic list/revoke over the same registry the 7702 + session grant
        // flows write to. `list-grants` returns every record for the (chain,
        // account) bucket (including revoked/expired — the panel filters with
        // isGrantActive so it can also render history if it wants). `revoke-grant`
        // stamps revokedAt so the entry disappears from the active view — a
        // wallet-side mark that never depends on the dapp being reachable.
        case 'list-grants':
          send({ ok: true, data: await listGrants(raw.chainId, raw.account) });
          break;
        case 'revoke-grant':
          await revokeGrant(raw.id, Math.floor(Date.now() / 1000));
          send({ ok: true, data: true });
          break;
        // ── AI/MCP-flagged origins (Task 6.2) ────────────────────────────
        // Opt-in allow-list of origins the user marks as an AI agent. The
        // sign-confirm popup reads this to decide whether to render the
        // itemized-intent panel + ack gate for an eth_sendTransaction. Purely
        // additive: flagging an origin never changes its connection state.
        case 'list-ai-origins':
          send({ ok: true, data: await getAiOrigins() });
          break;
        case 'set-ai-origin':
          await setAiOrigin(raw.origin, raw.on);
          send({ ok: true, data: raw.on });
          break;
        case 'get-auto-lock':
          send({ ok: true, data: await getAutoLockMinutes() });
          break;
        case 'set-auto-lock':
          await setAutoLockMinutes(raw.minutes);
          // Reschedule with the new value (or clear if user picked 0/never).
          await scheduleAutoLock();
          send({ ok: true, data: raw.minutes });
          break;
        case 'list-tokens':
          // Returns the merged builtin + user-added metadata (no RPC), so the
          // dashboard can render the rows instantly. Balances follow via
          // `read-token-balances`.
          send({ ok: true, data: await listTokenMeta() });
          break;
        case 'add-token':
          send({ ok: true, data: await addToken(raw.address) });
          await invalidateBalanceCache();
          break;
        case 'remove-token':
          await removeTokenRecord(await getCurrentChainId(), raw.address);
          await invalidateBalanceCache();
          send({ ok: true, data: null });
          break;
        case 'list-nfts':
          send({ ok: true, data: await listNfts(await getCurrentChainId()) });
          break;
        case 'add-nft':
          send({ ok: true, data: await addNft(raw.address, raw.tokenId) });
          break;
        case 'remove-nft':
          await removeNftRecord(await getCurrentChainId(), raw.address, raw.tokenId);
          send({ ok: true, data: null });
          break;
        case 'refresh-nft-balance':
          send({ ok: true, data: await refreshNftBalance(raw.address, raw.tokenId) });
          break;
        case 'list-activity': {
          if (!unlockedMnemonic) throw new Error('locked');
          const chainId = await getCurrentChainId();
          const acct = await unlockedAddress();
          send({ ok: true, data: await listActivity(chainId, acct) });
          break;
        }
        case 'refresh-activity-status': {
          if (!unlockedMnemonic) throw new Error('locked');
          send({ ok: true, data: await refreshActivityStatuses() });
          break;
        }
        case 'resolve-ens':
          send({ ok: true, data: await resolveEns(raw.name) });
          break;
        case 'resolve-ens-name':
          send({ ok: true, data: await resolveEnsName(raw.address) });
          break;
        case 'get-7702-verify': {
          // Popup asks for the prefetched verify result. If the SW
          // already kicked off the lookup in queuePending, we await the
          // cached Promise (usually already settled). If not (e.g. popup
          // opened a stale request from a previous SW lifetime — MV3
          // service workers die after 30s idle and re-spawn fresh, so
          // the in-memory cache evaporates), we kick it off now and
          // await. Either way the popup ends up with the resolved gate
          // result; first-time latency falls back to the previous
          // popup-driven behaviour.
          prefetchSeven702Verify(raw.chainId, raw.address);
          const key = seven702CacheKey(raw.chainId, raw.address);
          const entry = await seven702VerifyCache.get(key);
          send({ ok: true, data: entry ?? null });
          break;
        }
        case 'get-contract-abi': {
          // Same on-demand-or-cached pattern as get-7702-verify. SW
          // started prefetching when the tx entered the queue (if the
          // local selector table didn't already decode it); popup pulls
          // the resolved ABI here. If the cache is empty for some
          // reason (SW respawn / popup ran before SW prefetch), we
          // kick off the fetch now and await — first-time latency
          // collapses to the Sourcify round-trip.
          prefetchContractAbi(raw.chainId, raw.address);
          const key = contractAbiCacheKey(raw.chainId, raw.address);
          const abi = await contractAbiCache.get(key);
          send({ ok: true, data: abi ?? null });
          break;
        }
        case 'get-code': {
          // Resolve the chainId to an RPC, then eth_getCode. Used by
          // the 7702 sign-confirm to detect a delegate target that's
          // not actually a contract. Returns '0x' when the address
          // has no code; the hex bytecode prefix when it does; null
          // when we can't query (chain unknown / RPC failure).
          //
          // Trying current network first (in-memory cached client)
          // because that's the common case — wallet's sign-auth
          // handler already rejects mismatched chain. Falls through
          // to listAllNetworks for the unusual mismatch case where
          // the popup is rendering a different chain's auth than the
          // wallet's currently on (still useful: lets verification
          // happen pre-switch).
          const all = await listAllNetworks();
          const network = all.find((n) => n.chain.id === raw.chainId);
          if (!network) { send({ ok: true, data: null }); break; }
          const c = cachedPublicClient(network);
          try {
            const code = await c.getCode({ address: raw.address as Address });
            send({ ok: true, data: code ?? '0x' });
          } catch {
            send({ ok: true, data: null });
          }
          break;
        }
        case 'read-token-balances':
          send({ ok: true, data: await readTokenBalances() });
          break;
        case 'read-token-balances-stale':
          send({ ok: true, data: await readStaleTokenBalances() });
          break;
        case 'read-token-info': {
          // Lazy fetch (symbol, decimals) per token address — used by Sign
          // Confirm to format Permit `value` as e.g. "100 USDC" instead of
          // a raw 18-decimal bigint. Best-effort: any failed lookup just
          // gets omitted from the result; popup falls back to raw display.
          const network = await cachedNetwork();
          const out: Record<string, { decimals: number; symbol: string; name: string }> = {};
          await Promise.all(
            raw.addresses.map(async (a) => {
              if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return;
              try {
                const meta = await fetchTokenMeta(
                  network.chain,
                  network.rpcUrl,
                  a as `0x${string}`,
                );
                out[a.toLowerCase()] = {
                  decimals: meta.decimals,
                  symbol: meta.symbol,
                  name: meta.name,
                };
              } catch { /* ignore — caller falls back */ }
            }),
          );
          send({ ok: true, data: out });
          break;
        }
        case 'list-accounts':
          send({ ok: true, data: await listAccountsWithAddresses() });
          break;
        case 'add-account':
          send({ ok: true, data: await addAccount() });
          break;
        case 'switch-account':
          send({ ok: true, data: await switchAccount(raw.index) });
          break;
        case 'rename-account':
          await renameAccount(raw.index, raw.label);
          send({ ok: true, data: null });
          break;
        case 'reset-accounts':
          await resetAccounts();
          send({ ok: true, data: null });
          break;
        case 'reveal-mnemonic': {
          // User must re-enter the password even if SW is currently unlocked.
          // The decrypted phrase is returned to the popup but never persisted
          // beyond the current request — popup shows it once then the local
          // state holding it is cleared on screen change.
          const vault = await getVault();
          if (!vault) throw new Error('no vault');
          const phrase = await decryptMnemonic(vault, raw.password);
          send({ ok: true, data: phrase });
          break;
        }
        case 'get-hide-zero':
          send({ ok: true, data: await getHideZero() });
          break;
        case 'set-hide-zero':
          await setHideZero(raw.value);
          send({ ok: true, data: raw.value });
          break;
        case 'get-currency':
          send({ ok: true, data: await getCurrency() });
          break;
        case 'set-currency':
          await setCurrency(raw.value);
          send({ ok: true, data: raw.value });
          break;
        case 'get-dev-flags':
          send({ ok: true, data: await getDevFlags() });
          break;
        case 'set-dev-flag':
          await setDevFlag(raw.key, raw.value);
          // Cache picks up the change via storage.onChanged listener.
          send({ ok: true, data: raw.value });
          break;
        case 'popup-send': {
          // Popup-initiated transaction. User is on the Send screen — no need
          // to bounce through the sign-confirm queue. Gas tier multiplies the
          // network's auto-suggested EIP-1559 fees so the user can pay extra
          // for faster inclusion (or save by going slow).
          if (!unlockedMnemonic) throw new Error('wallet locked');
          const idx = await activeIndex();
          const network = await cachedNetwork();
          const pub = cachedPublicClient(network);
          const wallet = cachedWalletClient(unlockedMnemonic, idx, network);
          const tx = raw.tx;
          const tier = raw.gasTier ?? 'normal';
          // multiplier × 100 (BigInt math is integer-only)
          const mul = tier === 'slow' ? 85n : tier === 'fast' ? 150n : 100n;
          let extra: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {};
          try {
            const fees = await pub.estimateFeesPerGas();
            if (fees.maxFeePerGas) extra.maxFeePerGas = (fees.maxFeePerGas * mul) / 100n;
            if (fees.maxPriorityFeePerGas) extra.maxPriorityFeePerGas = (fees.maxPriorityFeePerGas * mul) / 100n;
          } catch {
            // Chain may be legacy / non-EIP-1559 — viem will fall back to
            // gasPrice-based estimation if we leave fees unset.
            extra = {};
          }
          // Predict pending nonce for activity dedup (same nonce +
          // different hash = speed-up / cancel replacement).
          let predictedNonce: number | undefined;
          try {
            predictedNonce = await pub.getTransactionCount({
              address: wallet.account!.address, blockTag: 'pending',
            });
          } catch { /* dedup degrades to hash-only */ }
          const hash = await wallet.sendTransaction({
            account: wallet.account!,
            chain: network.chain,
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : 0n,
            ...extra,
          });
          await invalidateBalanceCache(); // sender's balance just changed
          // Record in activity log for the dashboard's "Activity"
          // screen. classifyTx looks at calldata shape so the row
          // surfaces "approved", "sent ERC-20", etc. without the
          // popup needing to decode again.
          await addActivity({
            hash,
            chainId: network.chain.id,
            account: wallet.account!.address.toLowerCase(),
            kind: classifyTx({ to: tx.to, data: tx.data, value: tx.value }),
            to: tx.to ?? '',
            value: tx.value ? BigInt(tx.value).toString() : '0',
            data: tx.data ?? null,
            nonce: predictedNonce,
            addedAt: Date.now(),
            status: 'pending',
          });
          await scheduleAutoLock();
          send({ ok: true, data: hash });

          // Fire-and-forget: wait for the receipt in the background,
          // then nudge popup pages to refetch balances. Without this
          // step the Dashboard's auto-refresh on send-return runs
          // BEFORE the tx is mined and shows the pre-tx state for a
          // confusing 12-30 s window. Cap the wait so a long-tail
          // pending tx doesn't pin a closure forever.
          void (async () => {
            try {
              await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
            } catch {
              // Mined too slowly / dropped / RPC blip. Cache eviction
              // below still fires so stale-while-revalidate eventually
              // catches up.
            }
            await invalidateBalanceCache();
            chrome.runtime.sendMessage({ kind: 'balance-changed' }).catch(() => {
              // No extension pages listening (popup closed). Fine —
              // next popup-open will see fresh state via the regular
              // load path.
            });
          })();
          break;
        }
        case 'simulate-tx': {
          // Pre-flight `eth_call` to detect a guaranteed revert before the
          // user signs. Saves gas + reveals what the contract really does.
          // Static call — no state change, no gas charged. Returns:
          //   { ok: true }            → simulation succeeded
          //   { ok: false, error }    → would revert (string is the human reason)
          //   null                    → can't simulate (RPC error, locked, etc.)
          const network = await cachedNetwork();
          const pub = cachedPublicClient(network);
          const tx = raw.tx;
          const from = tx.from ?? (unlockedMnemonic ? await unlockedAddress() : undefined);
          // Parse value defensively. Dapps occasionally send decimal strings
          // ("0.01") instead of hex wei, which throws in BigInt() — we'd
          // rather skip simulation than surface "Cannot convert 0.01 to a
          // BigInt" as a fake revert message.
          let value: bigint = 0n;
          if (tx.value !== undefined && tx.value !== null && (tx.value as string) !== '') {
            try { value = BigInt(tx.value as string); }
            catch { send({ ok: true, data: null }); break; }
          }
          try {
            await pub.call({
              account: from,
              to: tx.to,
              data: tx.data,
              value,
            });
            send({ ok: true, data: { ok: true } });
          } catch (e) {
            const raw = e instanceof Error ? e.message : String(e);
            // viem packs a richer error tree; pull out the most readable line.
            // Order: explicit revert reason > "Details:" line > first 200 chars.
            const reasonMatch =
              raw.match(/reverted with the following reason:\s*([^\n]+)/i) ||
              raw.match(/reverted with custom error\s*'([^']+)'/i) ||
              raw.match(/Details:\s*([^\n]+)/);
            const error = reasonMatch ? reasonMatch[1]!.trim() : raw.slice(0, 200);
            send({ ok: true, data: { ok: false, error } });
          }
          break;
        }
        case 'estimate-tx-cost': {
          // Show approximate cost per gas tier on the Send card. We deliberately
          // DON'T call eth_estimateGas — it reverts on insufficient balance,
          // bad recipient, or pre-funding state, which would make the card
          // show "—" exactly when the user most needs feedback. Static estimates
          // (21k native, 65k for any contract call) are within ~5% of reality
          // for plain transfers and good enough for tier UX.
          const network = await cachedNetwork();
          const pub = cachedPublicClient(network);
          const tx = raw.tx;

          const isContractCall = !!tx.data && tx.data !== '0x';
          const gasUnits = isContractCall ? 65_000n : 21_000n;

          // Fees + price in parallel. Both can fail independently and we still
          // try to return whatever we got — UI degrades to "—" per missing
          // signal, not "all tiers null".
          const ethPriceKey = nativeCoingeckoId(network.chain.nativeCurrency?.symbol);
          const [feesResult, gasPriceResult, prices] = await Promise.all([
            pub.estimateFeesPerGas().catch(() => null),
            // Legacy fallback for non-EIP-1559 chains.
            pub.getGasPrice().catch(() => null),
            ethPriceKey
              ? getPrices([ethPriceKey]).catch(() => ({} as Record<string, number>))
              : Promise.resolve({} as Record<string, number>),
          ]);

          const baseMaxFee =
            feesResult?.maxFeePerGas ?? gasPriceResult ?? 0n;
          if (baseMaxFee === 0n) {
            send({ ok: true, data: null });
            break;
          }
          const ethUsd = ethPriceKey ? (prices[ethPriceKey.toLowerCase()] ?? null) : null;

          const ethAt = (mul: bigint) => {
            const wei = (gasUnits * baseMaxFee * mul) / 100n;
            return Number(wei) / 1e18;
          };
          const usdAt = (eth: number) => (ethUsd != null ? eth * ethUsd : null);
          // Per-tier maxFeePerGas in gwei — fed back to the popup so the
          // user can see "12.3 gwei" alongside the USD estimate. Same
          // multipliers as the cost calculation.
          const gweiAt = (mul: bigint) =>
            Number((baseMaxFee * mul) / 100n) / 1e9;
          const ethSlow = ethAt(85n);
          const ethNormal = ethAt(100n);
          const ethFast = ethAt(150n);
          send({
            ok: true,
            data: {
              slow:   usdAt(ethSlow),
              normal: usdAt(ethNormal),
              fast:   usdAt(ethFast),
              gwei: {
                slow:   gweiAt(85n),
                normal: gweiAt(100n),
                fast:   gweiAt(150n),
              },
              // Native-currency cost per tier (ETH on mainnet, BNB on BSC, …).
              // Send screen subtracts this from balance for the MAX button on
              // native sends so the tx doesn't fail with "insufficient funds
              // for gas" after the user clicks max-send.
              eth: {
                slow:   ethSlow,
                normal: ethNormal,
                fast:   ethFast,
              },
            },
          });
          break;
        }
        case 'reset-wallet': {
          unlockedMnemonic = null;
          await clearAutoLock();
          await invalidateBalanceCache();
          // Tear down every persisted surface — local for the vault /
          // settings / activity, session for the unlocked-mnemonic
          // cache. Without the session.clear the old mnemonic survives
          // SW restart and could be picked up before the user finishes
          // re-onboarding from a fresh seed.
          await chrome.storage.local.clear();
          await chrome.storage.session.clear();
          // In-memory queues — a sign request that was pending before
          // the reset must not be approvable against a freshly imported
          // mnemonic. Reject everything cleanly (4001) so the dapp
          // promise settles, then drop the queue.
          for (const id of Array.from(pendingResolvers.keys())) reject(id);
          pending.clear();
          pendingResolvers.clear();
          seenByPopup.clear();
          await broadcastEvent('accountsChanged', []);
          send({ ok: true, data: null });
          break;
        }
        default: {
          // Broadcast from the SW itself (e.g. `balance-changed`
          // emitted after a tx receipt lands) hits this listener as
          // well — every extension page receives it, including the
          // SW. No-op those gracefully so we don't log spurious
          // "unknown message kind" replies that confuse debugging.
          if ((raw as { kind?: string })?.kind === 'balance-changed') {
            send({ ok: true, data: null });
            break;
          }
          send({ ok: false, error: 'unknown message kind' });
          break;
        }
      }
    } catch (e) {
      // Preserve EIP-1193 error codes (4001 user rejected, 4200 unsupported,
      // 4902 unrecognised chain, etc.) so wagmi/RainbowKit can branch on
      // `err.code` correctly. Without this, every error became -32603 in
      // content.ts and wagmi treated 4001 as "unknown" → fell back to
      // eth_requestAccounts → second popup.
      const code =
        typeof (e as { code?: unknown }).code === 'number'
          ? ((e as { code: number }).code)
          : undefined;
      send({ ok: false, error: e instanceof Error ? e.message : String(e), code });
    }
  })();
  return true;
});

// Popup-alive port tracking. The popup connects a `popup-alive` port
// on mount; we count active ports + a per-pending-id "popup actually
// saw this request" flag. When the popup count drops to 0, after a
// short grace window, only requests that the user had a chance to
// see / dismiss get rejected with EIP-1193 4001. Requests still
// waiting for FIRST popup-paint stay queued — the wallet will open
// the popup on the next dapp poll instead of preemptively killing
// the pending.
//
// Pre-fix: closing the popup without approve/reject left the dapp's
// `provider.request()` Promise hanging forever.
let popupAliveCount = 0;
let popupDeathTimer: ReturnType<typeof setTimeout> | null = null;
const seenByPopup = new Set<string>();
const POPUP_DEATH_GRACE_MS = 200;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup-alive') return;
  popupAliveCount++;
  // Any pending request the SW knew about when a popup connected has
  // been visible to the user; if they later close without acting,
  // we can confidently treat it as a user rejection.
  for (const id of pending.keys()) seenByPopup.add(id);
  if (popupDeathTimer) { clearTimeout(popupDeathTimer); popupDeathTimer = null; }
  port.onDisconnect.addListener(() => {
    popupAliveCount = Math.max(0, popupAliveCount - 1);
    if (popupAliveCount !== 0) return;
    if (popupDeathTimer) clearTimeout(popupDeathTimer);
    popupDeathTimer = setTimeout(() => {
      popupDeathTimer = null;
      if (popupAliveCount !== 0) return;
      const userRejected = Object.assign(
        new Error('user closed the popup without approving the request'),
        { code: 4001 },
      );
      for (const id of Array.from(pending.keys())) {
        // Only reject requests the popup actually had a chance to
        // surface. A pending that was queued AFTER the last popup
        // closed stays alive — it'll open a popup on the next dapp
        // call / user gesture.
        if (!seenByPopup.has(id)) continue;
        const resolvers = pendingResolvers.get(id);
        if (resolvers) {
          for (const r of resolvers) r.reject(userRejected);
        }
        pending.delete(id);
        pendingResolvers.delete(id);
        seenByPopup.delete(id);
      }
      void refreshBadge();
    }, POPUP_DEATH_GRACE_MS);
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  // In-memory state — SW restart already zeroed these; restating is
  // belt-and-suspenders for the unusual case where the listener fires
  // mid-session without a SW shutdown in between.
  unlockedMnemonic = null;
  pending.clear();
  pendingResolvers.clear();
  void refreshBadge();
  // Persistent state: only the FIRST `install` seeds the active chain.
  // `update` / `chrome_update` / `shared_module_update` must NOT touch
  // it — otherwise every dev reload at chrome://extensions/ wipes the
  // user's chain choice. Logic extracted to core/on-installed for unit
  // testability without the SW's module-level event wiring.
  void seedActiveChainOnInstall(details.reason as OnInstalledReason);
});
