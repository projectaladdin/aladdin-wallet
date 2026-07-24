// Dashboard cluster — main account view, accounts picker, connected-sites
// management, AddToken modal, and the network/balance hook (useNetworkState)
// shared with Settings. Extracted from popup.tsx during the modularisation
// pass; no behaviour change.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { encodeFunctionData, type Address } from 'viem';
import { formatCurrency, truncateAddr } from '../../lib/format';
import { IPFS_GATEWAYS, ipfsTailFromUrl } from '../../core/erc721';
import { useCopyToClipboard, useEscapeKey } from '../hooks/use-clipboard';
import { getCurrentNetwork, listAllNetworks, type NftRecord } from '../../core/storage';
import type { Network } from '../../shared/config';
import { Header } from '../components/header';
import {
  AccountGlyph,
  send,
  useToast,
  type TokenMeta,
  type TokenRow,
} from '../shared';

export function AccountsScreen({
  address, onBack, onChange,
}: { address: Address; onBack: () => void; onChange: () => void }) {
  const showToast = useToast();
  const [accounts, setAccounts] = useState<AccountWithAddress[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  useEffect(() => { void load(); }, [address]);
  async function load() {
    try {
      setAccounts(await send<AccountWithAddress[]>({ kind: 'list-accounts' }));
    } catch { setAccounts([]); }
  }

  async function pick(idx: number) {
    setEditingIndex(null);
    if (accounts.find((a) => a.address.toLowerCase() === address.toLowerCase())?.index === idx) {
      onBack();
      return;
    }
    const switched = await send<AccountWithAddress>({ kind: 'switch-account', index: idx });
    showToast({ tone: 'yellow', icon: '✓', text: `switched to ${switched.label}.` });
    onChange();
  }
  async function add() {
    setEditingIndex(null);
    const created = await send<AccountWithAddress>({ kind: 'add-account' });
    await load();
    showToast({ tone: 'green', icon: '＋', text: `${created.label} added.` });
  }
  function startRename(a: AccountWithAddress) {
    setEditingIndex(a.index);
    setDraftLabel(a.label);
  }
  async function commitRename() {
    if (editingIndex === null) return;
    const label = draftLabel.trim();
    if (!label) { setEditingIndex(null); return; }
    await send({ kind: 'rename-account', index: editingIndex, label });
    setEditingIndex(null);
    await load();
    showToast({ tone: 'yellow', icon: '✎', text: `renamed to "${label}".` });
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} />

      <div className="aw-set-card">
        <h4>your accounts</h4>
        {accounts.map((a) => {
          const isCurrent = a.address.toLowerCase() === address.toLowerCase();
          const isEditing = editingIndex === a.index;
          const aShort = truncateAddr(a.address);

          if (isEditing) {
            return (
              <div className="aw-set-row" key={a.index} style={{ gap: 6, background: 'var(--cream)' }}>
                <AccountGlyph address={a.address} size={22} />
                <input
                  autoFocus
                  className="aw-input"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                    if (e.key === 'Escape') setEditingIndex(null);
                  }}
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px', boxShadow: 'none' }}
                />
                <button
                  type="button"
                  className="aw-btn aw-btn-sm"
                  onClick={() => void commitRename()}
                  style={{ padding: '4px 8px', fontSize: 11 }}
                >
                  save
                </button>
              </div>
            );
          }

          const balDisplay =
            a.nativeBalance != null
              ? `${Number(a.nativeBalance).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${a.nativeSymbol ?? ''}`
              : '—';
          return (
            <div
              key={a.index}
              className="aw-set-row is-clickable"
              onClick={() => pick(a.index)}
              style={{ background: isCurrent ? 'var(--cream)' : undefined }}
            >
              <AccountGlyph address={a.address} size={22} />
              <span className="label" style={{ minWidth: 0 }}>
                <span style={{ display: 'block' }}>
                  {a.label}
                  {isCurrent && (
                    <span style={{ marginLeft: 6, color: 'var(--chunky-green)', fontFamily: 'var(--font-mono)' }}>✓</span>
                  )}
                </span>
                <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.6, fontWeight: 600, marginTop: 2 }}>
                  {aShort} · {balDisplay}
                </span>
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); startRename(a); }}
                title="rename"
                aria-label={`rename ${a.label}`}
                style={{
                  border: '2px solid var(--ink)',
                  background: 'var(--white)',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontSize: 11,
                  marginLeft: 4,
                }}
              >
                ✎
              </button>
            </div>
          );
        })}
        <div
          className="aw-set-row is-clickable"
          onClick={() => void add()}
          style={{ background: 'var(--chunky-green)' }}
        >
          <span className="ico">＋</span>
          <span className="label" style={{ fontWeight: 800 }}>add account</span>
          <span className="car">›</span>
        </div>
      </div>
    </>
  );
}

// ─── Connected sites screen — every authorised origin + its pinned account
//      + revoke button. Per-origin account memory means each dapp shows
//      exactly which HD account it sees. ─────────────────────────────────

type ConnectedSite = {
  origin: string;
  accountIndex: number;
  accountLabel: string;
  address: Address;
};

export function ConnectedSitesScreen({ onBack }: { onBack: () => void }) {
  const showToast = useToast();
  const [sites, setSites] = useState<ConnectedSite[] | null>(null);
  // Task 6.2 — per-origin "treat as AI agent" flag. Origins in this set get an
  // itemized-intent confirmation on the sign-confirm screen for value-moving
  // eth_sendTransactions (prompt-injection defense). Loaded alongside the
  // connected sites; toggled per-row via `set-ai-origin`.
  const [aiOrigins, setAiOrigins] = useState<string[]>([]);

  useEffect(() => { void load(); }, []);
  async function load() {
    try {
      const [siteList, ai] = await Promise.all([
        send<ConnectedSite[]>({ kind: 'list-connected-sites' }),
        send<string[]>({ kind: 'list-ai-origins' }).catch(() => [] as string[]),
      ]);
      setSites(siteList);
      setAiOrigins(ai);
    } catch {
      setSites([]);
    }
  }
  async function revoke(origin: string) {
    await send({ kind: 'revoke-origin', origin });
    setSites((cur) => cur?.filter((s) => s.origin !== origin) ?? null);
    showToast({ tone: 'yellow', icon: '🔗', text: `revoked ${origin.replace(/^https?:\/\//, '')}` });
  }
  async function toggleAi(origin: string) {
    const on = !aiOrigins.includes(origin);
    // Optimistic flip, reconciled from the SW's echoed value.
    setAiOrigins((cur) => (on ? [...cur, origin] : cur.filter((o) => o !== origin)));
    try {
      await send({ kind: 'set-ai-origin', origin, on });
      showToast({
        tone: on ? 'yellow' : 'green',
        icon: '🤖',
        text: on
          ? `${origin.replace(/^https?:\/\//, '')} flagged as AI agent`
          : `AI flag cleared for ${origin.replace(/^https?:\/\//, '')}`,
      });
    } catch (e) {
      // Roll back the optimistic flip on failure.
      setAiOrigins((cur) => (on ? cur.filter((o) => o !== origin) : [...cur, origin]));
      showToast({ tone: 'red', icon: '💥', text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} />

      <div className="aw-set-card">
        <h4>connected dapps · {sites?.length ?? 0}</h4>
        {sites === null ? (
          <p className="aw-mono" style={{ padding: 14, opacity: 0.55, textAlign: 'center' }}>loading…</p>
        ) : sites.length === 0 ? (
          <div className="aw-empty" style={{ marginTop: 14, marginBottom: 6 }}>
            <span className="aw-stamp">nothing here yet</span>
            <h3>no dapps yet</h3>
            <p>connect a site, it'll show up here.</p>
          </div>
        ) : (
          sites.map((s) => {
            const host = s.origin.replace(/^https?:\/\//, '');
            const isAi = aiOrigins.includes(s.origin);
            return (
              <div className="aw-set-row" key={s.origin} style={{ alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
                <AccountGlyph address={s.address} size={26} />
                <span
                  className="label"
                  style={{ minWidth: 0, paddingLeft: 6, textTransform: 'none' }}
                >
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={host}
                  >
                    {host}
                  </span>
                  {/* Task 6.2 — per-origin AI-agent flag. When on, value-moving
                     eth_sendTransactions from this origin render an itemized
                     intent + require an explicit ack before Approve. */}
                  <button
                    onClick={() => void toggleAi(s.origin)}
                    title="When on, transactions from this origin show an itemized AI-intent confirmation before you can approve."
                    style={{
                      marginTop: 4,
                      background: isAi ? 'var(--ink)' : 'transparent',
                      color: isAi ? 'var(--aw-gold)' : 'var(--ink)',
                      border: '2px solid var(--ink)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      fontWeight: 700,
                      padding: '2px 6px',
                      cursor: 'pointer',
                    }}
                  >
                    {isAi ? '🤖 AI agent: on' : 'treat as AI agent'}
                  </button>
                </span>
                <button
                  onClick={() => revoke(s.origin)}
                  style={{
                    background: 'var(--ink)',
                    color: 'var(--aw-gold)',
                    border: '2px solid var(--ink)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  revoke
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}


/** Shape of the network state shared across every popup screen. */
type NetworkState = {
  chainId: number | null;
  rpcUrl: string | null;
  networks: Network[];
  current: Network | undefined;
  switchTo: (n: Network) => Promise<void>;
};

const DEFAULT_NETWORK_STATE: NetworkState = {
  chainId: null,
  rpcUrl: null,
  networks: [],
  current: undefined,
  switchTo: async () => {},
};

// Context that hoists `useNetworkState`'s storage reads into a single
// fetch shared across every screen. Without this, each consumer
// (Dashboard, Send, Activity, Settings, Receive) would run its own
// useEffect → 5 separate chrome.storage.local.get calls on every
// navigation. NetworkProvider centralises the fetch so the popup pays
// it once per chain switch.
const NetworkContext = createContext<NetworkState>(DEFAULT_NETWORK_STATE);

export function NetworkProvider({ children }: { children: import('react').ReactNode }) {
  const showToast = useToast();
  const [chainId, setChainId] = useState<number | null>(null);
  const [rpcUrl, setRpcUrl] = useState<string | null>(null);
  const [networks, setNetworks] = useState<Network[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [net, list] = await Promise.all([
        getCurrentNetwork(),
        listAllNetworks(),
      ]);
      if (cancelled) return;
      setChainId(net.chain.id);
      setRpcUrl(net.rpcUrl);
      setNetworks(list);
    })();
    return () => { cancelled = true; };
  }, []);

  const switchTo = async (n: Network) => {
    await send({ kind: 'switch-chain', chainId: n.chain.id, rpcUrl: n.rpcUrl });
    setChainId(n.chain.id);
    setRpcUrl(n.rpcUrl);
    showToast({ tone: 'yellow', icon: '⛓', text: `switched to ${n.chain.name}.` });
  };

  // Pick THE active entry by (chainId, rpcUrl) tuple — chainId alone
  // matches multiple rows when a custom RPC for a builtin chain was
  // added. Memoized so consumer-side comparisons are stable across
  // unrelated renders.
  const value = useMemo<NetworkState>(() => {
    const current = chainId !== null
      ? networks.find((n) => n.chain.id === chainId && (!rpcUrl || n.rpcUrl === rpcUrl))
        ?? networks.find((n) => n.chain.id === chainId)
      : undefined;
    return { chainId, rpcUrl, networks, current, switchTo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, rpcUrl, networks]);

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetworkState(): NetworkState {
  return useContext(NetworkContext);
}

type AccountWithAddress = {
  index: number;
  label: string;
  address: Address;
  /** Active-chain native balance (formatted decimal string), or null if RPC failed. */
  nativeBalance?: string | null;
  /** Active chain's native symbol (ETH / BNB / MATIC / …). */
  nativeSymbol?: string;
};

/** Pick the visual class for the token icon block based on symbol. Falls
 *  back to a generic cream square so unknown tokens still look styled. */
function tokenIconClass(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s === 'USDC') return 'usdc';
  if (s === 'USDT') return 'usdt';
  if (s === 'DAI')  return 'dai';
  if (s === 'WETH') return 'weth';
  if (s === 'ETH')  return 'eth';
  return 'gen';
}

/** Race-load an NFT image across every IPFS_GATEWAYS entry in parallel.
 *  ipfs.io alone is unreliable (504s in the wild); nftstorage / w3s
 *  serve nft.storage uploads but 30x-redirect Pinata-pinned content;
 *  pinata serves its own pins but is slow elsewhere. Single-gateway
 *  defaults always pick wrong some fraction of the time, so we
 *  literally fire one hidden `<img>` per gateway and let the first
 *  to fire `onLoad` become the visible source — guaranteed fastest
 *  working gateway with zero JS-side polling/probing. When `src`
 *  isn't an IPFS path (data: URLs, https://example.com/...), short-
 *  circuit to a single img — no race needed. */
function NftImage({ srcs, alt = '' }: { srcs: string[]; alt?: string }) {
  const [winner, setWinner] = useState<string | null>(null);

  // Expand every input src into its full candidate set:
  //   - if `src` contains an IPFS CID tail, expand to [src, ...public-gateway mirrors]
  //   - otherwise (plain https / data: / arweave.net), just [src]
  // Dedup the union so we don't double-probe when two metadata fields
  // collapse to the same URL (common when `image` and `image_url` mirror).
  const candidates = (() => {
    const all: string[] = [];
    for (const src of srcs) {
      all.push(src);
      const tail = ipfsTailFromUrl(src);
      if (tail) for (const gw of IPFS_GATEWAYS) all.push(gw + tail);
    }
    return Array.from(new Set(all));
  })();

  if (candidates.length === 0) {
    return <span className="placeholder" aria-hidden>🖼</span>;
  }

  return (
    <>
      {winner ? (
        <img src={winner} alt={alt} loading="lazy" />
      ) : (
        <span className="placeholder" aria-hidden>🖼</span>
      )}
      {/* Hidden probes — once any fires onLoad we record it and React
          unmounts the rest (their pending requests get cancelled by
          the browser). 1×1 invisible so layout doesn't shift. */}
      {!winner && candidates.map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            width: 1, height: 1,
            opacity: 0, pointerEvents: 'none',
          }}
          onLoad={() => setWinner((cur) => cur ?? url)}
        />
      ))}
    </>
  );
}

export function Dashboard({
  address, onSettings, onAddToken, onSend, onReceive, onAddNft, onActivity,
}: {
  address: Address;
  onSettings: () => void;
  onAddToken: () => void;
  /** `tokenAddress` pre-selects which token the Send screen opens
   *  with. Pass 'native' for ETH/BNB/etc.; pass a 0x-prefixed ERC-20
   *  contract address for a custom token. Defaults to native when
   *  omitted (existing top-bar Send button keeps that behavior). */
  onSend: (tokenAddress?: string) => void;
  onReceive: () => void;
  onAddNft: () => void;
  onActivity: () => void;
}) {
  const { chainId, rpcUrl: currentRpcUrl, networks, switchTo } = useNetworkState();
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [hideZero, setHideZero] = useState(false);
  const [tabOrigin, setTabOrigin] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // Display-currency preference + ETH/USD rate. Currency is loaded once on
  // mount; rate arrives with each read-token-balances response so it stays
  // fresh (DefiLlama 60s TTL behind it). Defaulting both to safe fallbacks
  // means the very first render is `$0.00` not blank.
  const [currency, setCurrency] = useState<'eth' | 'usd'>('usd');
  const [ethUsdRate, setEthUsdRate] = useState<number | null>(null);
  // Bump this to force a token-list refetch (e.g. after a balance-changed
  // broadcast, so new rows appear in the list).
  const [reloadKey, setReloadKey] = useState(0);
  // Listen for SW-broadcast "balance-changed" — fires after a popup-
  // initiated send's tx receipt lands. Bumps reloadKey so the
  // dashboard refetches and shows the post-tx amounts WITHOUT the
  // user needing to manually close + reopen the popup or wait for
  // the stale-while-revalidate TTL.
  useEffect(() => {
    const onMessage = (msg: unknown): void => {
      if ((msg as { kind?: string })?.kind === 'balance-changed') {
        setReloadKey((k) => k + 1);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);
  // Right-click context menu — which token row's "🗑 remove" pill is
  // currently open (null when none). Replaces the always-visible ✕ on
  // each row; right-click is more deliberate than a misclick on a
  // permanent button. Builtin + native rows never set this (they're
  // not removable; their onContextMenu handler is omitted so the
  // browser's native menu shows on right-click — useful for "copy
  // contract address" etc.).
  const [removeCtxAddr, setRemoveCtxAddr] = useState<string | null>(null);
  // NFT right-click context menu — keyed by `${address}::${tokenId}`
  // so the same contract's multiple tokens each get their own toggle
  // state. Mirrors the token-row pattern below.
  const [removeCtxNftKey, setRemoveCtxNftKey] = useState<string | null>(null);
  // NFT detail/send modal: which NFT (if any) is showing the big card,
  // and which view it opens to. Click a grid card → 'detail'; click
  // the send button → 'send' directly. Backdrop / Esc / ✕ closes.
  const [previewNft, setPreviewNft] = useState<{ nft: NftRecord; view: 'detail' | 'send' } | null>(null);
  // Token detail modal — same overlay pattern as NFT. Click a token
  // row in the list → opens. Modal has its own Send CTA that closes
  // the modal and routes to SendScreen with that token pre-selected.
  const [previewToken, setPreviewToken] = useState<TokenRow | null>(null);
  // Tokens / NFTs tab switch — the section between the action row and
  // the "+ add" strip swaps the rendered list. Both are loaded on
  // mount so switching is instant (no re-fetch on toggle).
  const [activeTab, setActiveTab] = useState<'tokens' | 'nfts'>('tokens');
  const [nfts, setNfts] = useState<NftRecord[] | null>(null);
  // Folding-screen tab strip — measure THREE things at runtime so
  // the overlap covers exactly the inactive tab's "MY " prefix +
  // its left padding/border, no more, no less:
  //   tokensWidth — full intrinsic width of "MY TOKENS" button
  //   nftsWidth   — full intrinsic width of "MY NFTS" button
  //   myPrefixPx  — rendered width of the "MY " glyph in the
  //                 display font + the inactive tab's left padding
  //                 + border (i.e. the exact overlap we want)
  // Inactive's `left` = activeWidth − myPrefixPx so the active
  // tab's right border lands at the END of the inactive's "MY ".
  // No hard-coded pixel guesses — every value is observed.
  const tokensTabRef = useRef<HTMLButtonElement>(null);
  const nftsTabRef = useRef<HTMLButtonElement>(null);
  const myProbeRef = useRef<HTMLSpanElement>(null);
  const [tabWidths, setTabWidths] = useState<{ tokens: number; nfts: number }>({ tokens: 0, nfts: 0 });
  const [myPrefixPx, setMyPrefixPx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await send<'eth' | 'usd'>({ kind: 'get-currency' });
        if (!cancelled) setCurrency(c);
      } catch { /* keep default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Detect whether the currently-active browser tab is an origin we've
  // authorized. Updates the connection strip at the bottom of the dashboard.
  useEffect(() => {
    void (async () => {
      let origin: string | null = null;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) origin = new URL(tab.url).origin;
      } catch { /* tab access denied — skip */ }
      setTabOrigin(origin);
      if (!origin) { setIsConnected(false); return; }
      try {
        const list = await send<string[]>({ kind: 'list-connected-origins' });
        setIsConnected(list.includes(origin));
      } catch { setIsConnected(false); }
    })();
  }, [address]);

  async function disconnectTab() {
    if (!tabOrigin) return;
    try {
      await send({ kind: 'revoke-origin', origin: tabOrigin });
      setIsConnected(false);
      showToast({ tone: 'yellow', icon: '🔗', text: 'disconnected.' });
    } catch { /* keep state */ }
  }

  // Close the right-click "remove" context menu on outside left-click
  // or Escape. Right-clicks (button !== 0) are NOT handled here —
  // they're forwarded to the row's own onContextMenu, which toggles
  // the menu state directly. Without this filter, a right-click on
  // the same row would (a) fire mousedown (closes the menu) then
  // (b) fire contextmenu (toggles back to open) — net effect: menu
  // never actually toggles closed via right-click.
  useEffect(() => {
    if (!removeCtxAddr && !removeCtxNftKey) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      // Click anywhere outside the open context menu (.aw-trow-ctx
      // for tokens, .aw-nft-ctx for NFTs) closes it.
      if (!t.closest('.aw-trow-ctx')) setRemoveCtxAddr(null);
      if (!t.closest('.aw-nft-ctx')) setRemoveCtxNftKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRemoveCtxAddr(null);
        setRemoveCtxNftKey(null);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [removeCtxAddr, removeCtxNftKey]);

  // Measure tab widths + "MY " prefix width (font-rendered) so the
  // overlap can be derived rather than guessed. useLayoutEffect runs
  // before paint — no flash of wrong-position. Re-runs on every
  // render (intrinsic widths are stable; the state guard prevents
  // setState→re-render loop).
  useLayoutEffect(() => {
    const tw = tokensTabRef.current?.offsetWidth ?? 0;
    const nw = nftsTabRef.current?.offsetWidth ?? 0;
    // myProbeRef is a visibility:hidden absolute-positioned span
    // mounted next to the tabs (see JSX below). Its computed width
    // includes the inactive tab's left border + padding (we style
    // the probe identically). Result: setting inactive.left =
    // activeWidth − this value puts active's right border exactly
    // at the seam after the inactive's "MY " glyph.
    const mw = myProbeRef.current?.offsetWidth ?? 0;
    if (tw !== tabWidths.tokens || nw !== tabWidths.nfts) {
      setTabWidths({ tokens: tw, nfts: nw });
    }
    if (mw !== myPrefixPx) setMyPrefixPx(mw);
  });

  // Pull the hide-zero pref on mount.
  useEffect(() => {
    void (async () => {
      try { setHideZero(await send<boolean>({ kind: 'get-hide-zero' })); } catch {}
    })();
  }, []);

  async function toggleHideZero() {
    const next = !hideZero;
    setHideZero(next);
    try {
      await send({ kind: 'set-hide-zero', value: next });
    } catch {
      // Persisting failed — revert UI so it doesn't lie about state.
      setHideZero(!next);
    }
  }

  // Three-phase load (stale-while-revalidate):
  //   1. metadata (instant, no RPC) — list of tokens with placeholder balances
  //   2. stale cache (chrome.storage.local read, microseconds) — last-known
  //      balances + USD prices from a previous session. Renders immediately
  //      so the user sees real numbers on first frame, even if they haven't
  //      opened the wallet in days.
  //   3. fresh fetch (RPC + DefiLlama, can be slow) — overrides phase 2
  //      values as data arrives.
  // Race-safe: phase 2 only writes if no fresh data has arrived yet
  // (cancelled-by-phase-3 guard via `freshDone` flag).
  useEffect(() => {
    if (chainId === null) return;
    let cancelled = false;
    let freshDone = false;
    (async () => {
      setTokens(null);
      let metaList: TokenMeta[];
      try {
        metaList = await send<TokenMeta[]>({ kind: 'list-tokens' });
        if (cancelled) return;
        setTokens(metaList.map((m) => ({ ...m, balance: '0', loaded: false, priceUsd: null })));
      } catch {
        if (!cancelled) setTokens([]);
        return;
      }

      // Phase 2 — stale cache paint. Fire-and-forget; the fresh call
      // races against it but is virtually always slower (microseconds
      // vs. RPC round-trip), so this paints first in practice.
      void (async () => {
        try {
          const stale = await send<{
            tokens: (TokenMeta & { balance: string; priceUsd: number | null })[];
            ethUsdRate: number | null;
            fetchedAt: number;
          } | null>({ kind: 'read-token-balances-stale' });
          if (cancelled || freshDone || !stale) return;
          setEthUsdRate(stale.ethUsdRate);
          const byAddr = new Map(stale.tokens.map((t) => [t.address.toLowerCase(), t]));
          setTokens((cur) =>
            cur?.map((t) => {
              const next = byAddr.get(t.address.toLowerCase());
              return next ? { ...t, balance: next.balance, priceUsd: next.priceUsd, loaded: true } : t;
            }) ?? cur,
          );
        } catch {
          // No cache yet (first-ever open) or storage glitch — phase 3
          // will fill in shortly. Nothing to surface to the user.
        }
      })();

      // Phase 3 — fresh fetch. Always runs, even if phase 2 painted.
      try {
        const reply = await send<{
          tokens: (TokenMeta & { balance: string; priceUsd: number | null })[];
          ethUsdRate: number | null;
        }>({
          kind: 'read-token-balances',
        });
        if (cancelled) return;
        freshDone = true;
        const filled = reply.tokens;
        setEthUsdRate(reply.ethUsdRate);
        const byAddr = new Map(filled.map((t) => [t.address.toLowerCase(), t]));
        setTokens((cur) =>
          cur?.map((t) => {
            const next = byAddr.get(t.address.toLowerCase());
            return next ? { ...t, balance: next.balance, priceUsd: next.priceUsd, loaded: true } : t;
          }) ?? cur,
        );
      } catch {
        // RPC failed wholesale — phase 2's stale data stays on screen
        // if it landed. Otherwise the "0" placeholder remains. Either
        // way the user sees the token list, not a stuck spinner.
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, reloadKey]);

  // NFT list — same lifecycle (per-chain, re-fetch on reload bump).
  // Loaded independently of tokens so a slow NFT fetch never blocks
  // the dashboard's hero/token render. Empty/null states are handled
  // by the NFTs tab's render branch.
  useEffect(() => {
    if (chainId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await send<NftRecord[]>({ kind: 'list-nfts' });
        if (!cancelled) setNfts(list);
      } catch {
        if (!cancelled) setNfts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, reloadKey]);

  async function removeNft(addr: string, tokenId: string) {
    try {
      await send({ kind: 'remove-nft', address: addr, tokenId });
      setNfts((cur) => cur?.filter(
        (n) => !(n.address === addr.toLowerCase() && n.tokenId === tokenId),
      ) ?? null);
      showToast({ tone: 'yellow', icon: '🗑', text: 'NFT removed.' });
    } catch (e) {
      showToast({
        tone: 'red', icon: '⚠',
        text: (e instanceof Error ? e.message : String(e)).slice(0, 90),
      });
    }
  }

  async function removeToken(addr: string) {
    if (addr === 'native') return; // safety: native row is non-removable
    await send({ kind: 'remove-token', address: addr });
    setTokens((cur) => cur?.filter((t) => t.address !== addr.toLowerCase()) ?? null);
    showToast({ tone: 'yellow', icon: '🗑', text: 'token removed.' });
  }

  /** Format a token row's value in the user's chosen currency. Returns '—' if
   *  no price feed for this token (testnets, unsupported chains). */
  function rowUsd(t: TokenRow): string {
    const bal = parseFloat(t.balance);
    if (!Number.isFinite(bal) || t.priceUsd == null) return '—';
    return formatCurrency(bal * t.priceUsd, currency, ethUsdRate);
  }

  const showToast = useToast();
  // Hero address pill — copies the active account address to clipboard,
  // flashes a "copied" state for 1.5s + fires a yellow toast.
  const [copied, setCopied] = useState(false);
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      showToast({ tone: 'green', icon: '✓', text: 'address copied' });
    } catch {
      showToast({ tone: 'red', icon: '⚠', text: 'clipboard blocked, copy manually' });
    }
  }
  const shortAddr = truncateAddr(address);

  // Aggregate USD across all rows (always, even hidden ones — total is the
  // wallet's full worth, not "what's visible"). Rows without a price feed
  // contribute 0 — testnets etc. don't poison the total.
  const totalUsd = (tokens ?? []).reduce((acc, t) => {
    const bal = parseFloat(t.balance);
    if (!Number.isFinite(bal) || t.priceUsd == null) return acc;
    return acc + bal * t.priceUsd;
  }, 0);
  // Single-currency hero: the active currency's full string. The pre-split
  // form (whole + cents) was specific to "$X.XX" two-decimal USD, so we keep
  // a USD whole/cents path for the existing big-number layout but compute
  // the Ξ form as one block when active.
  const totalUsdStr = totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [usdWhole, usdCents] = totalUsdStr.split('.');
  const totalEthStr = formatCurrency(totalUsd, 'eth', ethUsdRate);
  const allLoaded = tokens !== null && tokens.every((t) => t.loaded);

  // List filter: hide zero balances if the user opted in. Native row is
  // exempt — it's the chain's gas asset and hiding it leaves a weird gap.
  const visibleTokens = (tokens ?? []).filter((t) => {
    if (!hideZero) return true;
    if (t.isNative) return true;
    const bal = parseFloat(t.balance);
    return Number.isFinite(bal) && bal > 0;
  });

  return (
    <>
      <Header
        status="unlocked"
        chainSwitcher={chainId !== null ? { current: chainId, currentRpcUrl, networks, onSwitch: switchTo } : undefined}
        onSettings={onSettings}
      />

      {/* Yellow tilted hero — total balance in active currency. */}
      <div className="aw-hero">
        <div className="aw-hero-eyebrow">total worth</div>
        <div className="aw-hero-bal" style={{ opacity: allLoaded ? 1 : 0.7 }}>
          {currency === 'eth' ? (
            <>
              <span style={{ fontSize: '0.55em', verticalAlign: '0.6em', marginRight: 4 }}>Ξ</span>
              {totalEthStr.replace(/^Ξ\s*/, '')}
            </>
          ) : (
            <>
              <span style={{ fontSize: '0.55em', verticalAlign: '0.6em', marginRight: 2 }}>$</span>
              {usdWhole}
              <span className="unit">.{usdCents}</span>
            </>
          )}
        </div>
        <div className="aw-hero-foot">
          <button
            className={'aw-hero-addr' + (copied ? ' is-copied' : '')}
            onClick={copyAddress}
            title="copy address"
          >
            {copied ? 'copied! ✓' : `${shortAddr} ⧉`}
          </button>
        </div>
      </div>

      {/* Action row — send / receive / activity. The third slot used
          to be "explorer" (linked out per-chain); we moved that link
          INSIDE the Activity screen so the dashboard surfaces local
          history first and the explorer is one click further (where
          you'd want it anyway when investigating a specific tx). */}
      <div className="aw-actions" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <button onClick={() => onSend()}>
          <span className="ico">↑</span>
          <span>send</span>
        </button>
        <button onClick={onReceive}>
          <span className="ico">↓</span>
          <span>receive</span>
        </button>
        <button onClick={onActivity}>
          <span className="ico">⌚</span>
          <span>activity</span>
        </button>
      </div>

      {/* Folding-screen tab strip — active tab moves to the front-left,
          extends rightward, and covers the inactive tab's "my " prefix.
          The user reads:
            tokens active → "my tokens" + "NFTs"
            nfts   active → "my NFTs"  + "tokens"
          The hidden "my " on the inactive tab is intentional — implies
          you're switching to "tokens" or "NFTs" specifically, the "my"
          prefix is shared. */}
      <div className="aw-tokens-head">
        <div
          className="aw-assets-tabs"
          role="tablist"
          data-active={activeTab}
          style={{
            width: tabWidths.tokens && tabWidths.nfts && myPrefixPx
              ? (activeTab === 'tokens' ? tabWidths.tokens : tabWidths.nfts) +
                (activeTab === 'tokens' ? tabWidths.nfts : tabWidths.tokens) -
                myPrefixPx
              : undefined,
          }}
        >
          <button
            ref={tokensTabRef}
            role="tab"
            aria-selected={activeTab === 'tokens'}
            className="aw-assets-tab"
            data-tab="tokens"
            onClick={() => setActiveTab('tokens')}
            style={{
              left: tabWidths.tokens && tabWidths.nfts && myPrefixPx
                ? (activeTab === 'tokens' ? 0 : tabWidths.nfts - myPrefixPx)
                : undefined,
            }}
          >
            my tokens
          </button>
          <button
            ref={nftsTabRef}
            role="tab"
            aria-selected={activeTab === 'nfts'}
            className="aw-assets-tab"
            data-tab="nfts"
            onClick={() => setActiveTab('nfts')}
            style={{
              left: tabWidths.tokens && tabWidths.nfts && myPrefixPx
                ? (activeTab === 'nfts' ? 0 : tabWidths.tokens - myPrefixPx)
                : undefined,
            }}
          >
            my NFTs
          </button>
          {/* Hidden width probe — gives offsetWidth = the inactive
              tab's LEFT border (2 px) + left padding (12 px) + font-
              rendered "MY " glyph width. That sum is the exact px
              count we need active to extend INTO the inactive to
              cover its leading "MY " label.
              Styled inline (not via .aw-assets-tab) so right padding
              and right border are explicitly 0 — we only care about
              the left side of the inactive. visibility:hidden +
              pointer-events:none keep it inert; it still occupies
              layout for offsetWidth measurement to work. */}
          <span
            ref={myProbeRef}
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              visibility: 'hidden',
              pointerEvents: 'none',
              fontFamily: 'var(--font-display)',
              textTransform: 'uppercase',
              fontSize: '18px',
              lineHeight: 1,
              paddingLeft: '12px',
              borderLeft: '2px solid #000',
              boxSizing: 'content-box',
              whiteSpace: 'pre',
            }}
          >
            MY{' '}
          </span>
        </div>
        <span className="aw-tokens-meta">
          {activeTab === 'tokens' ? (
            <>
              {visibleTokens.length}{hideZero && tokens && tokens.length > visibleTokens.length ? `/${tokens.length}` : ''} coins
              <button
                className={'aw-tokens-toggle' + (hideZero ? ' is-on' : '')}
                onClick={toggleHideZero}
                title="hide tokens with 0 balance"
                aria-pressed={hideZero}
              >
                {hideZero ? 'hide 0 ✓' : 'hide 0'}
              </button>
            </>
          ) : (
            <>{nfts?.length ?? 0} NFTs</>
          )}
        </span>
      </div>

      {/* Tokens tab — same render as before. */}
      {activeTab === 'tokens' && (tokens === null ? (
        <p className="aw-mono" style={{ fontSize: 12, opacity: 0.55, textAlign: 'center', padding: '12px 0' }}>
          loading…
        </p>
      ) : visibleTokens.length === 0 ? (
        <div className="aw-empty">
          <span className="aw-stamp">nothing here yet</span>
          <h3>no tokens yet</h3>
          <p>
            {hideZero
              ? 'all hidden by hide-zero. flip it off in settings.'
              : `no defaults on this chain (id ${chainId ?? '?'}). paste a contract address below to add one.`}
          </p>
        </div>
      ) : (
        <div className="aw-tlist">
          {visibleTokens.map((t) => {
            // Removable rows: user-added ERC-20s. Builtins (USDC/USDT/DAI/WETH
            // on mainnet, USDC on Sepolia) and the synthetic native row are
            // not — their onContextMenu is left undefined so right-clicks
            // are no-ops on those rows. The browser's native context menu
            // is blocked popup-wide by App's `contextmenu` listener, so a
            // right-click on a builtin shows nothing (intentional — these
            // tokens aren't user-managed).
            const removable = !t.builtin && t.address !== 'native';
            return (
              <div
                className="aw-trow"
                key={t.address}
                onClick={(e) => {
                  // Don't open the detail modal when the remove-ctx
                  // pill is the actual click target (mirrors the NFT
                  // card pattern).
                  if ((e.target as HTMLElement).closest('.aw-trow-ctx')) return;
                  setRemoveCtxAddr(null);
                  setPreviewToken(t);
                }}
                onContextMenu={removable ? (e) => {
                  e.preventDefault();
                  // Toggle: same row right-clicked again hides the
                  // pill; different row switches the pill to that row.
                  setRemoveCtxAddr((cur) => (cur === t.address ? null : t.address));
                } : undefined}
              >
                <div className={`aw-tic ${tokenIconClass(t.symbol)}`}>
                  {t.symbol.slice(0, 1)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{t.symbol}</div>
                  <div className="sub">{t.name}</div>
                </div>
                <div className="right">
                  <div className="bal" style={{ opacity: t.loaded ? 1 : 0.5 }}>
                    {Number(t.balance).toLocaleString('en-US', { maximumFractionDigits: 6 })}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      opacity: 0.7,
                      marginTop: 2,
                      textAlign: 'right',
                    }}
                  >
                    {rowUsd(t)}
                  </div>
                </div>
                {removeCtxAddr === t.address && (
                  <div className="aw-trow-ctx">
                    <button
                      type="button"
                      className="aw-trow-ctx-btn"
                      onClick={() => {
                        void removeToken(t.address);
                        setRemoveCtxAddr(null);
                      }}
                    >
                      🗑 remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* NFTs tab — same chain-scoped list, grid layout per card.
          Empty state mirrors the tokens-empty shape. Right-click on a
          card toggles the remove behaviour to be implemented in v2; for
          now the corner ✕ button stays as the only delete affordance
          (NFT cards are visually busy enough that a permanent X is
          fine; reconsider when adding context menus there). */}
      {activeTab === 'nfts' && (nfts === null ? (
        <p className="aw-mono" style={{ fontSize: 12, opacity: 0.55, textAlign: 'center', padding: '12px 0' }}>
          loading…
        </p>
      ) : nfts.length === 0 ? (
        <div className="aw-empty">
          <span className="aw-stamp">nothing here yet</span>
          <h3>no NFTs yet</h3>
          <p>
            paste a contract + tokenId below. metadata is read on-chain.
            no indexer, no tracking.
          </p>
        </div>
      ) : (
        <div className="aw-nft-grid">
          {nfts.map((n) => {
            const key = `${n.address}::${n.tokenId}`;
            return (
              <div
                className="aw-nft-card"
                key={key}
                onClick={(e) => {
                  // Don't fire detail-open when the inner Send button
                  // or remove-ctx pill is the actual click target —
                  // those have their own handlers.
                  if ((e.target as HTMLElement).closest('.aw-nft-send, .aw-nft-ctx')) return;
                  setRemoveCtxNftKey(null);
                  setPreviewNft({ nft: n, view: 'detail' });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Same toggle pattern as token rows — right-click
                  // the same card hides the pill; right-click a
                  // different card switches the pill there.
                  setRemoveCtxNftKey((cur) => (cur === key ? null : key));
                }}
              >
                <div className="thumb">
                  {n.imageCandidates.length > 0 ? (
                    <NftImage srcs={n.imageCandidates} />
                  ) : (
                    <span className="placeholder" aria-hidden>🖼</span>
                  )}
                  <span className="standard">{n.standard === 'ERC721' ? '721' : '1155'}</span>
                </div>
                <div className="meta">
                  <div className="name" title={n.name}>{n.name}</div>
                  <div className="sub aw-mono">
                    #{n.tokenId.length > 10 ? n.tokenId.slice(0, 6) + '…' : n.tokenId}
                    {/* ERC-1155: tack on the owned-count next to the
                        tokenId. ERC-721 is always 1-of-1 so the badge
                        would be noise; null balance means "RPC blip,
                        don't lie to the user". */}
                    {n.standard === 'ERC1155' && n.balance != null && (
                      <span className="aw-nft-count"> · ×{n.balance}</span>
                    )}
                  </div>
                  <button
                    className="aw-nft-send"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRemoveCtxNftKey(null);
                      setPreviewNft({ nft: n, view: 'send' });
                    }}
                    aria-label="send NFT"
                  >send ↗</button>
                </div>
                {removeCtxNftKey === key && (
                  <div className="aw-nft-ctx">
                    <button
                      type="button"
                      className="aw-nft-ctx-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeNft(n.address, n.tokenId);
                        setRemoveCtxNftKey(null);
                      }}
                    >
                      🗑 remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {previewNft && (
        <NftDetailModal
          nft={previewNft.nft}
          initialView={previewNft.view}
          address={address}
          onClose={() => setPreviewNft(null)}
          onSent={() => setPreviewNft(null)}
          onBalanceRefreshed={(updated) => {
            setPreviewNft((cur) => cur && { ...cur, nft: updated });
            setNfts((cur) => cur?.map((n) =>
              n.address === updated.address && n.tokenId === updated.tokenId ? updated : n,
            ) ?? cur);
          }}
        />
      )}

      {previewToken && (
        <TokenDetailModal
          token={previewToken}
          currency={currency}
          ethUsdRate={ethUsdRate}
          onClose={() => setPreviewToken(null)}
          onSend={(addr) => {
            setPreviewToken(null);
            onSend(addr);
          }}
        />
      )}

      {activeTab === 'tokens' ? (
        <button className="aw-add-strip" onClick={onAddToken}>
          + add token
        </button>
      ) : (
        <button className="aw-add-strip" onClick={onAddNft}>
          + add NFT (paste contract + tokenId)
        </button>
      )}

      {/* Floating connection strip — ONLY when the active tab is an
          authorized origin. Surfacing "not connected" for every random page
          is noise; users care that they ARE connected, not that they aren't. */}
      {tabOrigin && isConnected && (
        <>
          <div aria-hidden style={{ height: 50, flexShrink: 0 }} />
          <div className="aw-conn-strip is-on">
            <span className="dot" />
            <span className="host">
              connected · {tabOrigin.replace(/^https?:\/\//, '')}
            </span>
            <button className="disconnect" onClick={disconnectTab}>
              disconnect
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** ERC-721 / ERC-1155 transfer calldata ABIs. `safeTransferFrom` over
 *  the bare `transferFrom` so the recipient contract (if any) gets the
 *  standard onReceived hook — matches what MetaMask / Phantom send. */
const ERC721_TRANSFER_ABI = [{
  type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
  inputs: [
    { type: 'address', name: 'from' },
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'tokenId' },
  ],
  outputs: [],
}] as const;
const ERC1155_TRANSFER_ABI = [{
  type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
  inputs: [
    { type: 'address', name: 'from' },
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'id' },
    { type: 'uint256', name: 'amount' },
    { type: 'bytes',   name: 'data' },
  ],
  outputs: [],
}] as const;

/** Combined NFT detail + send modal. Two views inside one overlay:
 *    - 'detail': bigger image, name, ERC-1155 balance with refresh,
 *                truncated contract + tokenId (click-to-copy), the
 *                "send …" CTA that flips to 'send' view.
 *    - 'send':   recipient input + amount (1155) + cancel/send buttons.
 *                Cancel returns to 'detail'; successful broadcast fires
 *                onSent which closes the modal.
 *  Esc / backdrop / ✕ close the whole thing regardless of view. */
function NftDetailModal({
  nft,
  initialView,
  address,
  onClose,
  onSent,
  onBalanceRefreshed,
}: {
  nft: NftRecord;
  initialView: 'detail' | 'send';
  address: Address;
  onClose: () => void;
  onSent: () => void;
  onBalanceRefreshed: (updated: NftRecord) => void;
}) {
  const showToast = useToast();
  const [view, setView] = useState<'detail' | 'send'>(initialView);
  const [refreshing, setRefreshing] = useState(false);

  // Send-view state — defaults to "send 1 of <tokenId>". Reset when
  // the modal opens fresh (initialView change = different NFT picked).
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const validRecipient = /^0x[0-9a-fA-F]{40}$/.test(recipient.trim());
  const isErc1155 = nft.standard === 'ERC1155';
  const amountNum = isErc1155 ? Number(amount) : 1;
  const validAmount = isErc1155
    ? Number.isFinite(amountNum) && amountNum > 0 && Number.isInteger(amountNum)
    : true;
  const ok = validRecipient && validAmount && !busy;

  // Esc closes the modal but is suppressed during a broadcast — the
  // user shouldn't be able to abort the modal mid-sign and lose the
  // success toast / status update.
  useEscapeKey(onClose, !busy);

  const shortAddr = truncateAddr;
  const copyText = useCopyToClipboard();

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const updated = await send<NftRecord | null>({
        kind: 'refresh-nft-balance', address: nft.address, tokenId: nft.tokenId,
      });
      if (updated) onBalanceRefreshed(updated);
    } catch (e) {
      showToast({ tone: 'red', icon: '⚠', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  async function broadcast() {
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const data = isErc1155
        ? encodeFunctionData({
            abi: ERC1155_TRANSFER_ABI,
            functionName: 'safeTransferFrom',
            args: [
              address,
              recipient.trim() as Address,
              BigInt(nft.tokenId),
              BigInt(amountNum),
              '0x' as `0x${string}`,
            ],
          })
        : encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: 'safeTransferFrom',
            args: [
              address,
              recipient.trim() as Address,
              BigInt(nft.tokenId),
            ],
          });
      const hash = await send<`0x${string}`>({
        kind: 'popup-send',
        tx: { to: nft.address as Address, data, value: '0x0' },
        gasTier: 'normal',
      });
      showToast({ tone: 'green', icon: '✓', text: `sent! tx ${hash.slice(0, 10)}…` });
      onSent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      showToast({ tone: 'red', icon: '⚠', text: msg.slice(0, 100) });
      setBusy(false);
    }
  }

  return (
    <div className="aw-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="aw-modal" onClick={(e) => e.stopPropagation()}>
        {!busy && <button className="aw-modal-close" onClick={onClose} aria-label="close">✕</button>}
        <div className="aw-modal-thumb">
          {nft.imageCandidates.length > 0
            ? <NftImage srcs={nft.imageCandidates} />
            : <span className="placeholder" aria-hidden>🖼</span>}
        </div>
        <h3 className="aw-modal-title" title={nft.name}>{nft.name}</h3>
        {isErc1155 && (
          <div className="aw-modal-balance">
            <span className="lbl">you own</span>
            <span className="val">× {nft.balance ?? '—'}</span>
            {view === 'detail' && (
              <button
                type="button"
                className="aw-modal-refresh"
                onClick={refresh}
                disabled={refreshing}
                title="re-read balanceOf"
              >{refreshing ? '…' : '↻'}</button>
            )}
          </div>
        )}

        {view === 'detail' ? (
          <>
            <dl className="aw-modal-kv">
              <dt>contract</dt>
              <dd>
                <span
                  className="aw-modal-addr"
                  onClick={() => copyText(nft.address, 'contract')}
                  title="copy full address"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void copyText(nft.address, 'contract');
                    }
                  }}
                >
                  <code className="aw-mono">{shortAddr(nft.address)}</code>
                  <span className="aw-modal-copy-icon" aria-hidden> ⧉</span>
                </span>
              </dd>
              <dt>tokenId</dt>
              <dd>
                <code
                  className="aw-mono"
                  onClick={() => copyText(nft.tokenId, 'tokenId')}
                  title="copy tokenId"
                >{nft.tokenId}</code>
              </dd>
              <dt>standard</dt>
              <dd><code className="aw-mono">{nft.standard}</code></dd>
            </dl>
            <button className="aw-cta-primary" onClick={() => setView('send')}>
              send {isErc1155 ? 'tokens' : 'NFT'} ↗
            </button>
          </>
        ) : (
          <>
            <label className="aw-label">recipient address</label>
            <input
              className="aw-input"
              value={recipient}
              onChange={(e) => { setRecipient(e.target.value); setErr(null); }}
              placeholder="0x…"
              autoFocus
              disabled={busy}
            />
            {isErc1155 && (
              <>
                <label className="aw-label" style={{ marginTop: 10 }}>amount</label>
                <input
                  className="aw-input"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setErr(null); }}
                  placeholder="1"
                  disabled={busy}
                  inputMode="numeric"
                />
                <p className="aw-mono" style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
                  ERC-1155 is semi-fungible — pick how many of this id to send.
                </p>
              </>
            )}
            {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
            <div className="aw-btn-row" style={{ marginTop: 12 }}>
              <button
                className="aw-btn aw-btn-ghost"
                onClick={() => { setView('detail'); setErr(null); }}
                disabled={busy}
              >cancel</button>
              <button
                className="aw-btn"
                onClick={broadcast}
                disabled={!ok}
                style={{ flex: 1 }}
              >{busy ? 'broadcasting…' : 'send it'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Token detail overlay. Same modal scheme as NftDetailModal (cream
 *  card, backdrop, ✕ close, Esc handler) but content tailored to ERC-
 *  20 / native rows: big icon glyph, symbol + name, balance prominently
 *  with the active-currency value, contract address truncated +
 *  click-to-copy (native rows skip the contract row entirely),
 *  decimals + standard tags, and a Send CTA that closes the modal and
 *  navigates to SendScreen pre-selected on this token. */
function TokenDetailModal({
  token, currency, ethUsdRate, onClose, onSend,
}: {
  token: TokenRow;
  currency: 'eth' | 'usd';
  ethUsdRate: number | null;
  onClose: () => void;
  onSend: (tokenAddress: string) => void;
}) {
  useEscapeKey(onClose);
  const shortAddr = truncateAddr;
  const copyText = useCopyToClipboard();

  const isNative = token.isNative ?? token.address === 'native';
  const balanceNum = Number(token.balance);
  const balanceDisplay = Number.isFinite(balanceNum)
    ? balanceNum.toLocaleString('en-US', { maximumFractionDigits: 8 })
    : token.balance;
  const valueLine = token.priceUsd != null && Number.isFinite(balanceNum)
    ? formatCurrency(balanceNum * token.priceUsd, currency, ethUsdRate)
    : null;

  return (
    <div className="aw-modal-backdrop" onClick={onClose}>
      <div className="aw-modal" onClick={(e) => e.stopPropagation()}>
        <button className="aw-modal-close" onClick={onClose} aria-label="close">✕</button>
        <div className={`aw-tic aw-modal-token-icon ${tokenIconClass(token.symbol)}`}>
          {token.symbol.slice(0, 1)}
        </div>
        <h3 className="aw-modal-title" title={token.name}>{token.symbol}</h3>
        <div className="aw-mono" style={{ fontSize: 12, opacity: 0.7, marginTop: -6 }}>{token.name}</div>
        <div className="aw-modal-balance">
          <span className="lbl">balance</span>
          <span className="val">{balanceDisplay} {token.symbol}</span>
        </div>
        {valueLine && (
          <div className="aw-mono" style={{ fontSize: 12, opacity: 0.8, marginTop: -4 }}>
            ≈ {valueLine}
          </div>
        )}
        <dl className="aw-modal-kv">
          {!isNative && (
            <>
              <dt>contract</dt>
              <dd>
                <span
                  className="aw-modal-addr"
                  onClick={() => copyText(token.address, 'contract')}
                  title="copy full address"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void copyText(token.address, 'contract');
                    }
                  }}
                >
                  <code className="aw-mono">{shortAddr(token.address)}</code>
                  <span className="aw-modal-copy-icon" aria-hidden> ⧉</span>
                </span>
              </dd>
            </>
          )}
          <dt>decimals</dt>
          <dd><code className="aw-mono">{token.decimals}</code></dd>
          <dt>standard</dt>
          <dd><code className="aw-mono">{isNative ? 'Native' : 'ERC-20'}</code></dd>
        </dl>
        <button className="aw-cta-primary" onClick={() => onSend(token.address)}>
          send {token.symbol} ↗
        </button>
      </div>
    </div>
  );
}

export function AddToken({ onDone }: { onDone: () => void }) {
  const showToast = useToast();
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; symbol: string; decimals: number } | null>(null);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  async function importToken() {
    setBusy(true); setErr(null); setPreview(null);
    try {
      const meta = await send<{ name: string; symbol: string; decimals: number }>({
        kind: 'add-token',
        address: addr.trim(),
      });
      setPreview(meta);
      showToast({ tone: 'green', icon: '✓', text: `${meta.symbol} imported.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      showToast({ tone: 'red', icon: '⚠', text: msg.slice(0, 90) });
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <>
      <Header status="unlocked" onBack={busy ? undefined : onDone} />
      <div className="aw-card">
        <h2 className="aw-card-title">add token</h2>
        <p className="aw-mono" style={{ fontSize: 11, opacity: 0.6, marginTop: 0, marginBottom: 8 }}>
          paste an ERC-20 contract address. metadata is read straight from the chain.
        </p>
        <label className="aw-label">contract address</label>
        <input
          className="aw-input"
          value={addr}
          onChange={(e) => { setAddr(e.target.value); setPreview(null); setErr(null); }}
          placeholder="0x…"
          autoFocus
          disabled={busy}
        />
        {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
        {preview && (
          <div className="aw-alert aw-alert-info" style={{ marginTop: 10 }}>
            ✓ added <b>{preview.symbol}</b> — {preview.name} (decimals {preview.decimals})
          </div>
        )}
        <div className="aw-btn-row" style={{ marginTop: 12 }}>
          <button className="aw-btn aw-btn-ghost" onClick={onDone} disabled={busy}>
            {preview ? 'done' : 'cancel'}
          </button>
          <button
            className="aw-btn"
            onClick={importToken}
            disabled={!valid || busy || !!preview}
            style={{ flex: 1 }}
          >
            {busy ? 'reading chain…' : preview ? 'imported' : 'import'}
          </button>
        </div>
      </div>
    </>
  );
}
