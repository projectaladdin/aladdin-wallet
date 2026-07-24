// Activity screen — popup-side broadcast history for the current
// (chainId, account) tuple. Renders the entries that background.ts
// captured at sign time, with the calldata decoded into a human
// label ("sent 0.5 ETH" / "approved ∞ USDC to 0xabc…"). Status
// auto-refreshes on screen mount + every 5 s while any entry is
// still pending, so the user doesn't have to keep ↻'ing.
//
// Per-row `↗` opens the explorer's tx page; the top-level
// `view my address on explorer ↗` button surfaces the same external
// link that's accessible from the dashboard action strip.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import { Header } from '../components/header';
import { send, useToast } from '../shared';
import { useNetworkState } from './dashboard';
import { formatActivityLabel, type TokenInfoMap } from '../../lib/activity-format';
import { useEnsNames } from '../hooks/use-ens-names';
import type { ActivityEntry } from '../../core/activity';

function shortHash(h: string): string {
  if (!h) return '—';
  if (h.length < 16) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function statusBadge(s: ActivityEntry['status']): string {
  if (s === 'success') return '✓';
  if (s === 'failed')  return '✗';
  return '…';
}

function timeAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ActivityScreen({
  address, onBack,
}: { address: Address; onBack: () => void }) {
  const showToast = useToast();
  const { current } = useNetworkState();
  const explorer = current?.chain.blockExplorers?.default?.url;
  const nativeSym = current?.chain.nativeCurrency?.symbol ?? 'ETH';
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [tokenInfo, setTokenInfo] = useState<TokenInfoMap>({});
  const [refreshing, setRefreshing] = useState(false);

  // Track the last-seen "any-still-pending?" state so the polling
  // effect can stop firing once everything's settled.
  const hasPending = useMemo(
    () => (items ?? []).some((e) => e.status === 'pending'),
    [items],
  );

  // Reverse-resolve every recipient address into its ENS name (when
  // one exists). Falls back to the truncated 0x string per row when
  // the lookup misses or returns null.
  const recipients = useMemo(
    () => Array.from(new Set((items ?? []).map((e) => e.to).filter(Boolean))),
    [items],
  );
  const ensNames = useEnsNames(recipients);

  // Initial load — kick off `refresh-activity-status` directly (not
  // plain `list-activity`) so the user sees fresh receipt state on
  // first paint, not stale 'pending' chips from a session ago.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await send<ActivityEntry[]>({ kind: 'refresh-activity-status' });
        if (!cancelled) setItems(list);
      } catch {
        // Fall back to a plain read if refresh fails (e.g. RPC down) —
        // better to show last-known state than a blank screen.
        try {
          const list = await send<ActivityEntry[]>({ kind: 'list-activity' });
          if (!cancelled) setItems(list);
        } catch (e2) {
          if (!cancelled) {
            showToast({ tone: 'red', icon: '⚠', text: e2 instanceof Error ? e2.message : String(e2) });
            setItems([]);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  // Auto-poll while ANY entry is pending. 5 s cadence — long enough
  // to not hammer the RPC, short enough to feel live for a fresh
  // broadcast. Stops the moment everything's settled.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!hasPending) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const list = await send<ActivityEntry[]>({ kind: 'refresh-activity-status' });
          setItems(list);
        } catch { /* keep polling; transient RPC blip */ }
      })();
    }, 5_000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [hasPending]);

  // Fetch symbol + decimals for every contract that any entry touches —
  // batched so the SW does one round-trip per render-cycle, not one
  // per row. Map keyed by lowercased address; native (no contract)
  // entries skip this.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const addrs = new Set<string>();
    for (const e of items) {
      // Only entries whose `to` is the TOKEN contract benefit (erc20
      // transfer / approve target the token; nft transfer + nft
      // approve target the NFT contract, which read-token-info on
      // currently doesn't cover — symbol/decimals lookup gracefully
      // degrades for them).
      if (e.kind === 'erc20-transfer' || e.kind === 'approve' || e.kind === 'nft-transfer') {
        if (e.to && /^0x[0-9a-fA-F]{40}$/.test(e.to)) addrs.add(e.to.toLowerCase());
      }
    }
    if (addrs.size === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await send<TokenInfoMap>({
          kind: 'read-token-info',
          addresses: Array.from(addrs),
        });
        if (!cancelled) setTokenInfo(info);
      } catch { /* leave map empty; formatter shows 'token' fallback */ }
    })();
    return () => { cancelled = true; };
  }, [items]);

  const explorerBase = explorer ? explorer.replace(/\/$/, '') : null;
  function explorerTxUrl(hash: string): string | null {
    return explorerBase ? `${explorerBase}/tx/${hash}` : null;
  }
  function explorerAddrUrl(addr: string): string | null {
    return explorerBase ? `${explorerBase}/address/${addr}` : null;
  }

  async function manualRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const list = await send<ActivityEntry[]>({ kind: 'refresh-activity-status' });
      setItems(list);
    } catch (e) {
      showToast({ tone: 'red', icon: '⚠', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} label="activity" />
      <div className="aw-card">
        <div className="aw-act-toolbar">
          {explorer && (
            <button
              type="button"
              className="aw-btn aw-btn-ghost"
              onClick={() => window.open(explorerAddrUrl(address)!, '_blank', 'noopener')}
              title="view my address on the chain's block explorer"
            >
              view my address on explorer ↗
            </button>
          )}
          <button
            type="button"
            className="aw-btn aw-btn-ghost"
            onClick={manualRefresh}
            disabled={refreshing}
            title="re-poll receipts for pending entries"
          >
            {refreshing ? 'refreshing…' : '↻ refresh'}
          </button>
        </div>

        {items === null ? (
          <p className="aw-mono" style={{ opacity: 0.6, fontSize: 12 }}>loading…</p>
        ) : items.length === 0 ? (
          <div className="aw-empty">
            <span className="aw-stamp">nothing here yet</span>
            <h3>no activity yet</h3>
            <p>
              every send / approve / 7702 you sign here gets recorded
              for this chain + account. nothing fetched from indexers —
              just what this wallet has watched go out.
            </p>
          </div>
        ) : (
          <ul className="aw-act-list">
            {items.map((e) => {
              const { verb, detail } = formatActivityLabel(e, tokenInfo, nativeSym, ensNames);
              return (
                <li className="aw-act-row" key={e.hash + e.addedAt}>
                  <span className={`aw-act-status is-${e.status}`} aria-hidden>{statusBadge(e.status)}</span>
                  <div className="aw-act-body">
                    <div className="aw-act-line1">
                      <span className="kind">{verb}</span>
                      <span className="time aw-mono">{timeAgo(e.addedAt)}</span>
                    </div>
                    {detail && (
                      <div className="aw-act-line2 aw-mono">{detail}</div>
                    )}
                    <div className="aw-act-line3 aw-mono">
                      <code>{shortHash(e.hash)}</code>
                      {explorerTxUrl(e.hash) && (
                        <a
                          className="aw-act-explorer"
                          href={explorerTxUrl(e.hash)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="open this tx on the block explorer"
                        > ↗</a>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
