// Header + ChainPicker — shared header strip used by every full-screen
// route (onboarding, dashboard, send, receive, settings, accounts, etc.).
// Extracted from popup.tsx during the modularisation pass; no behaviour
// change vs. the inline definitions.

import { useEffect, useRef, useState } from 'react';
import type { Network } from '../../shared/config';
import { Lamp } from '../shared';

// ─── Reusable header ───────────────────────────────────────────────────────

export function Header({
  status,
  onBack,
  chainSwitcher,
  onSettings,
  label,
  caption,
}: {
  status?: 'locked' | 'unlocked' | 'no-wallet';
  onBack?: () => void;
  chainSwitcher?: { current: number; currentRpcUrl: string | null; networks: Network[]; onSwitch: (n: Network) => void };
  onSettings?: () => void;
  /** Overrides the default `unlocked` green sticker with custom text — used
   *  by sub-flows like Send to show "send" instead of the global state. */
  label?: string;
  /** Optional one-line caption rendered as a second row inside the Header
   *  bounding box (same cream bg, same sticky context). Use this instead of
   *  rendering a free-floating <span> below the Header — keeps the caption
   *  attached to the title strip and avoids a half-empty pixel band between
   *  Header bottom and the next content block. Comic-style font, see
   *  `.aw-page-caption` in popup.css for the spec. */
  caption?: string;
}) {
  return (
    <div className="aw-header">
      <div className="aw-header-row">
        {onBack && (
          <button
            className="aw-btn aw-btn-ghost aw-btn-sm"
            onClick={onBack}
            style={{ padding: '4px 10px', marginRight: 8 }}
            aria-label="back"
          >
            ←
          </button>
        )}
        <Lamp size={30} className="aw-brand-icon" />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {chainSwitcher && (
            <ChainPicker
              current={chainSwitcher.current}
              currentRpcUrl={chainSwitcher.currentRpcUrl}
              networks={chainSwitcher.networks}
              onSwitch={chainSwitcher.onSwitch}
            />
          )}
          {onSettings && (
            <button
              className="aw-btn aw-btn-ghost aw-btn-sm"
              onClick={onSettings}
              style={{ padding: '4px 8px', fontSize: 14 }}
              aria-label="settings"
              title="settings"
            >
              ⚙
            </button>
          )}
          {/* Custom label takes precedence over the default unlocked sticker
              so sub-flows (Send / Review) can swap "unlocked" → "send" / "review". */}
          {!chainSwitcher && label && <div className="aw-sticker aw-sticker-green">{label}</div>}
          {!chainSwitcher && !label && status === 'unlocked' && <div className="aw-sticker aw-sticker-green">unlocked</div>}
          {status === 'locked' && <div className="aw-sticker aw-sticker-red">locked</div>}
          {status === 'no-wallet' && <div className="aw-sticker aw-sticker-yellow">new</div>}
        </div>
      </div>
      {caption && <span className="aw-page-caption">{caption}</span>}
    </div>
  );
}

/** Pull just the host out of an RPC URL for compact display. Falls back to
 *  the raw string when URL parse fails (e.g. dapp passed something weird). */
function safeRpcHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

// ─── Chain picker (custom dropdown — native <select> menu styling can't
// follow the Aladdin aesthetic, so we render our own panel) ────────────────

export function ChainPicker({
  current, currentRpcUrl, networks, onSwitch,
}: {
  current: number;
  /** Active rpcUrl — needed to disambiguate two entries sharing a chainId
   *  (e.g. a custom Ethereum mainnet RPC vs the builtin). When null, fall
   *  back to chainId-only matching. */
  currentRpcUrl: string | null;
  networks: Network[];
  /** Switch to a specific entry; rpcUrl matters when multiple entries share
   *  a chainId (custom override of a builtin, or two custom RPCs for the
   *  same chain). */
  onSwitch: (n: Network) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Tuple match by (chainId, rpcUrl) — picking the wrong entry here surfaces
  // the wrong network name in the pill when a custom RPC for a builtin chain
  // is active. Fall back to chainId-only when rpcUrl is unknown.
  const cur =
    networks.find((n) => n.chain.id === current && (!currentRpcUrl || n.rpcUrl === currentRpcUrl))
    ?? networks.find((n) => n.chain.id === current);

  return (
    <div className="aw-chain-picker" ref={ref}>
      <button
        type="button"
        className={`aw-chain-pill ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="switch chain"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="aw-chain-dot" />
        {cur?.chain.name ?? `chain ${current}`}
      </button>
      {open && (
        <div className="aw-chain-menu" role="listbox">
          {networks.map((n) => {
            // Disambiguate when multiple entries share a chainId: append
            // the RPC host so two "Ethereum" rows aren't visually identical.
            const dupes = networks.filter((m) => m.chain.id === n.chain.id).length;
            const rpcHost = dupes > 1 ? safeRpcHost(n.rpcUrl) : '';
            const key = `${n.chain.id}:${n.rpcUrl}`;
            // Only one entry can be the active one — match by the (chainId,
            // rpcUrl) tuple. With chainId-only matching, two duplicate entries
            // would both render `is-current`.
            const isCurrent =
              n.chain.id === current &&
              (currentRpcUrl === null || n.rpcUrl === currentRpcUrl);
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={isCurrent}
                className={`aw-chain-option ${isCurrent ? 'is-current' : ''}`}
                onClick={() => {
                  onSwitch(n);
                  setOpen(false);
                }}
              >
                <span>
                  {n.chain.name}
                  {rpcHost && <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>{rpcHost}</span>}
                </span>
                <span className="aw-chain-option-id">{n.chain.id}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
