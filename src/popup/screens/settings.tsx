// Settings cluster — Settings screen, AddChain modal, RevealRecovery
// password challenge, ResetConfirm wallet-wipe flow, AUTO_LOCK_OPTIONS.
// Extracted from popup.tsx during the modularisation pass; no behaviour
// change.

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { addCustomChain, getCurrentNetwork, listAllNetworks } from '../../core/storage';
import { BUILTIN_NETWORKS, type Network } from '../../shared/config';
import { Header } from '../components/header';
import { AccountGlyph, send, useToast } from '../shared';
import { useNetworkState } from './dashboard';

// ─── Reveal recovery phrase screen ────────────────────────────────────────
// Re-prompts for the wallet password, then displays the 12-word mnemonic.
// Phrase is held in component state only — leaving the screen drops it.

export function RevealRecovery({ onBack }: { onBack: () => void }) {
  const [pw, setPw] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reveal() {
    setBusy(true); setErr(null);
    try {
      const m = await send<string>({ kind: 'reveal-mnemonic', password: pw });
      setPhrase(m);
      setPw(''); // wipe password from local state once we have the phrase
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} />

      {phrase ? (
        <>
          <div className="aw-set-card">
            <h4 style={{ background: 'var(--alarm-red)', color: 'var(--white)' }}>
              recovery phrase
            </h4>
            <div style={{ padding: '12px 14px' }}>
              <div className="aw-mnemonic">
                {phrase.split(/\s+/).map((w, i) => (
                  <div key={i} className="aw-mnemonic-cell" data-i={i + 1}>{w}</div>
                ))}
              </div>
              <p
                className="aw-caption"
                style={{ marginTop: 4, fontSize: 12, lineHeight: 1.3 }}
              >
                never share these 12 words. anyone who has them can drain this wallet.
              </p>
            </div>
          </div>
          <button
            className="aw-btn aw-btn-block"
            onClick={onBack}
            style={{ marginTop: 'auto' }}
          >
            done
          </button>
        </>
      ) : (
        <div className="aw-set-card">
          <h4>enter password</h4>
          <div style={{ padding: '12px 14px' }}>
            <p className="aw-caption" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.3 }}>
              we re-ask for your password before showing the secret phrase. anyone holding your
              laptop shouldn't get it just by clicking around.
            </p>
            <input
              autoFocus
              className="aw-input"
              type="password"
              placeholder="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && pw) void reveal(); }}
            />
            {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
            <button
              className="aw-btn aw-btn-block"
              style={{ marginTop: 12 }}
              disabled={!pw || busy}
              onClick={reveal}
            >
              {busy ? 'decrypting…' : 'reveal phrase'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Reset wallet confirmation screen ────────────────────────────────────
// Two-gate destructive action: explicit checkbox ("I have my phrase saved")
// + click "reset". Backend wipes the encrypted vault and ALL chrome.storage
// state. After completion, popup auto-routes to the Welcome screen.

export function ResetConfirm({
  onBack, onDone,
}: { onBack: () => void; onDone: () => void | Promise<void> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={busy ? undefined : onBack} />

      <div className="aw-set-card">
        <h4 style={{ background: 'var(--alarm-red)', color: 'var(--white)' }}>
          reset wallet
        </h4>
        <div style={{ padding: '14px' }}>
          <div className="aw-alert aw-alert-danger">
            this wipes the encrypted recovery phrase, every account, every custom chain,
            connected sites, and added tokens from this browser. <b>without your 12 words
            you cannot recover.</b>
          </div>

          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              marginTop: 14,
              fontFamily: 'var(--font-pixel)',
              fontWeight: 700,
              fontSize: 13,
              lineHeight: 1.3,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
              disabled={busy}
            />
            <span>i have my recovery phrase saved somewhere safe (and tested it)</span>
          </label>

          <button
            className="aw-btn aw-btn-danger aw-btn-block"
            style={{ marginTop: 14 }}
            disabled={!confirmed || busy}
            onClick={reset}
          >
            {busy ? 'wiping…' : 'reset wallet'}
          </button>
          <button
            className="aw-btn aw-btn-ghost aw-btn-block"
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={onBack}
          >
            cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Screens ───────────────────────────────────────────────────────────────





const AUTO_LOCK_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 30,  label: '30 min' },
  { minutes: 60,  label: '1 hour' },
  { minutes: 120, label: '2 hours' },
];

export function Settings({
  address, onBack, onLock, onAddChain, onAccounts, onConnected, onSafety, onRevealRecovery, onResetWallet, onDeveloper, onAbout,
}: {
  address: Address;
  onBack: () => void;
  onLock: () => void;
  onAddChain: () => void;
  onAccounts: () => void;
  onConnected: () => void;
  onSafety: () => void;
  onRevealRecovery: () => void;
  onResetWallet: () => void;
  onDeveloper: () => void;
  onAbout: () => void;
}) {
  const showToast = useToast();
  const { chainId, rpcUrl: currentRpcUrl, networks, current, switchTo } = useNetworkState();
  const [origins, setOrigins] = useState<string[]>([]);
  const [autoLock, setAutoLock] = useState<number | null>(null);
  const [currency, setCurrencyState] = useState<'eth' | 'usd'>('usd');

  useEffect(() => {
    void refresh();
  }, []);
  async function refresh() {
    setOrigins(await send<string[]>({ kind: 'list-connected-origins' }));
    setAutoLock(await send<number>({ kind: 'get-auto-lock' }));
    try { setCurrencyState(await send<'eth' | 'usd'>({ kind: 'get-currency' })); } catch {/* keep default */}
  }
  async function pickAutoLock(minutes: number) {
    await send({ kind: 'set-auto-lock', minutes });
    setAutoLock(minutes);
    const lbl = AUTO_LOCK_OPTIONS.find((o) => o.minutes === minutes)?.label ?? `${minutes} min`;
    showToast({ tone: 'green', icon: '⏱', text: `auto-lock set to ${lbl}.` });
  }
  async function pickCurrency(c: 'eth' | 'usd') {
    await send({ kind: 'set-currency', value: c });
    setCurrencyState(c);
    showToast({
      tone: 'green',
      icon: c === 'eth' ? 'Ξ' : '$',
      text: c === 'eth' ? 'showing balances in ETH.' : 'showing balances in USD.',
    });
  }

  const autoLockLabel = AUTO_LOCK_OPTIONS.find((o) => o.minutes === autoLock)?.label ?? `${autoLock ?? '?'} min`;

  return (
    <>
      <Header
        status="unlocked"
        onBack={onBack}
        chainSwitcher={chainId !== null ? { current: chainId, currentRpcUrl, networks, onSwitch: switchTo } : undefined}
        caption="tinker w/ stuff"
      />

      {/* Account — current account is a single row that navigates to the
          accounts screen for switch/rename/add. Recovery + lock stay here. */}
      <div className="aw-set-card">
        <h4>account</h4>
        <div className="aw-set-row is-clickable" onClick={onAccounts}>
          <AccountGlyph address={address} size={22} />
          <span className="label">manage accounts</span>
          <span className="val">{address.slice(0, 6)}…{address.slice(-4)}</span>
          <span className="car">›</span>
        </div>
        <div className="aw-set-row is-clickable" onClick={onRevealRecovery}>
          <span className="ico">🔑</span>
          <span className="label">show recovery phrase</span>
          <span className="car">›</span>
        </div>
        <div className="aw-set-row is-clickable" onClick={onLock}>
          <span className="ico">🔒</span>
          <span className="label">lock wallet</span>
          <span className="car">›</span>
        </div>
      </div>

      {/* Currency — ETH or USD display preference. */}
      <div className="aw-set-card">
        <h4>currency · {currency === 'eth' ? 'ETH' : 'USD'}</h4>
        <div
          className="aw-set-row is-clickable"
          onClick={() => pickCurrency('eth')}
          style={{ background: currency === 'eth' ? 'var(--cream)' : undefined }}
        >
          <span className="ico">Ξ</span>
          <span className="label">ETH
            <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
              how balances are shown
            </span>
          </span>
          <span className="car">{currency === 'eth' ? '✓' : ''}</span>
        </div>
        <div
          className="aw-set-row is-clickable"
          onClick={() => pickCurrency('usd')}
          style={{ background: currency === 'usd' ? 'var(--cream)' : undefined }}
        >
          <span className="ico">$</span>
          <span className="label">USD
            <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
              us dollar value
            </span>
          </span>
          <span className="car">{currency === 'usd' ? '✓' : ''}</span>
        </div>
      </div>

      {/* Auto-lock — idle timer before the wallet relocks. */}
      <div className="aw-set-card">
        <h4>auto-lock · {autoLockLabel}</h4>
        {AUTO_LOCK_OPTIONS.map((opt) => (
          <div
            key={opt.minutes}
            className={'aw-set-row is-clickable'}
            onClick={() => pickAutoLock(opt.minutes)}
            style={{ background: autoLock === opt.minutes ? 'var(--cream)' : undefined }}
          >
            <span className="ico">⏱</span>
            <span className="label">{opt.label}</span>
            <span className="car">{autoLock === opt.minutes ? '✓' : ''}</span>
          </div>
        ))}
      </div>

      {/* Network — current chain readout + add-custom entry point. */}
      <div className="aw-set-card">
        <h4>network · {current?.chain.name ?? `id ${chainId ?? '?'}`}</h4>
        <div className="aw-set-row is-clickable" onClick={onAddChain}>
          <span className="ico">＋</span>
          <span className="label">add custom chain</span>
          <span className="car">›</span>
        </div>
      </div>

      {/* Connected sites — full management on its own screen. */}
      <div className="aw-set-card">
        <h4>connected sites</h4>
        <div className="aw-set-row is-clickable" onClick={onConnected}>
          <span className="ico">🔗</span>
          <span className="label">manage connected dapps</span>
          <span className="val">{origins.length}</span>
          <span className="car">›</span>
        </div>
      </div>

      {/* Safety Panel — active grants (session permissions + 7702 delegations)
          with CAN/CANNOT view and one-click revoke. */}
      <div className="aw-set-card">
        <h4>safety</h4>
        <div className="aw-set-row is-clickable" onClick={onSafety}>
          <span className="ico">🛡</span>
          <span className="label">safety panel
            <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
              active grants · revoke access
            </span>
          </span>
          <span className="car">›</span>
        </div>
      </div>

      {/* Developer — moved into its own screen. Lives behind this single
          link so the inline dev toggles (rpc trace, 7702 unverified-
          delegate override) don't crowd the everyday Settings list. */}
      <div className="aw-set-card">
        <h4>advanced</h4>
        <div className="aw-set-row is-clickable" onClick={onDeveloper}>
          <span className="ico">🛠</span>
          <span className="label">developer</span>
          <span className="car">›</span>
        </div>
      </div>

      {/* About — static capability + brand overview on its own screen. */}
      <div className="aw-set-card">
        <h4>about</h4>
        <div className="aw-set-row is-clickable" onClick={onAbout}>
          <span className="ico">💡</span>
          <span className="label">about aladdin</span>
          <span className="car">›</span>
        </div>
      </div>

      {/* Danger zone — destructive only; reset wipes encrypted vault + all
          wallet state. Lock (reversible) lives in the account section above. */}
      <div className="aw-set-card">
        <h4 style={{ background: 'var(--alarm-red)', color: 'var(--white)' }}>danger zone</h4>
        <div className="aw-set-row is-clickable is-danger" onClick={onResetWallet}>
          <span className="ico">🗑</span>
          <span className="label">reset wallet</span>
          <span className="car">›</span>
        </div>
      </div>

      <p
        className="aw-mono"
        style={{ fontSize: 10, opacity: 0.4, textAlign: 'center', marginTop: 'auto' }}
      >
        Aladdin Wallet v{chrome.runtime.getManifest().version} · MV3 · EIP-6963
      </p>
    </>
  );
}

export function AddChain({ onDone }: { onDone: () => void }) {
  const showToast = useToast();
  const [chainId, setChainId] = useState('');
  const [name, setName] = useState('');
  const [rpcUrl, setRpcUrl] = useState('');
  const [symbol, setSymbol] = useState('ETH');
  const [explorer, setExplorer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [customs, setCustoms] = useState<Network[]>([]);
  const [currentChain, setCurrentChain] = useState<{ id: number; rpcUrl: string } | null>(null);

  // Pull all networks then filter out builtin entries (matching by both chainId
  // AND rpcUrl) — leaves user-added customs visible even when their chainId
  // matches a builtin (e.g. user added a private Ethereum mainnet RPC at
  // chainId=1; that entry must remain manageable, not silently filtered).
  async function refresh() {
    try {
      const [list, net] = await Promise.all([
        listAllNetworks(),
        getCurrentNetwork(),
      ]);
      setCustoms(list.filter((n) => {
        const builtin = BUILTIN_NETWORKS[n.chain.id];
        return !builtin || builtin.rpcUrl !== n.rpcUrl;
      }));
      setCurrentChain({ id: net.chain.id, rpcUrl: net.rpcUrl });
    } catch {/* keep last */}
  }
  useEffect(() => { void refresh(); }, []);

  const id = parseInt(chainId, 10);
  const ok = Number.isFinite(id) && id > 0 && name.trim() && rpcUrl.trim().startsWith('http');

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await addCustomChain({
        chainId: id,
        name: name.trim(),
        rpcUrl: rpcUrl.trim(),
        symbol: symbol.trim() || 'ETH',
        ...(explorer.trim() ? { blockExplorer: explorer.trim() } : {}),
      });
      // Stay on the screen — clear form, refresh list, toast confirm. Lets
      // user add several chains in a row without bouncing back to settings.
      setChainId(''); setName(''); setRpcUrl(''); setSymbol('ETH'); setExplorer('');
      await refresh();
      showToast({ tone: 'green', icon: '🌐', text: `${name.trim() || 'chain'} added.` });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(net: Network) {
    setBusy(true);
    try {
      // If the deleted entry IS the currently-active one, switch the wallet
      // to a still-existing entry first so getCurrentNetwork doesn't throw on
      // the next read. Prefer another entry on the same chainId (builtin or
      // another custom RPC); fall back to mainnet only if this is the last
      // viable entry for this chainId.
      const isActive =
        currentChain?.id === net.chain.id && currentChain.rpcUrl === net.rpcUrl;
      if (isActive) {
        const allForChain = (await listAllNetworks()).filter(
          (n) => n.chain.id === net.chain.id && n.rpcUrl !== net.rpcUrl,
        );
        if (allForChain.length > 0) {
          await send({ kind: 'switch-chain', chainId: net.chain.id, rpcUrl: allForChain[0]!.rpcUrl });
        } else {
          await send({ kind: 'switch-chain', chainId: 1 });
        }
      }
      await send({ kind: 'remove-chain', chainId: net.chain.id, rpcUrl: net.rpcUrl });
      await refresh();
      showToast({ tone: 'yellow', icon: '🗑', text: `${net.chain.name} removed.` });
    } catch (e) {
      showToast({ tone: 'red', icon: '⚠', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={busy ? undefined : onDone} label="chains" />

      {customs.length > 0 && (
        <div className="aw-set-card">
          <h4>your custom chains</h4>
          {customs.map((n) => (
            <div className="aw-set-row" key={`${n.chain.id}:${n.rpcUrl}`}>
              <span className="ico">🌐</span>
              <span className="label">
                {n.chain.name}
                <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                  chainId {n.chain.id} · {n.rpcUrl}
                </span>
              </span>
              {currentChain?.id === n.chain.id && currentChain.rpcUrl === n.rpcUrl && (
                <span className="val" style={{ fontSize: 10, opacity: 0.6 }}>active</span>
              )}
              <button
                className="aw-btn aw-btn-ghost aw-btn-sm"
                onClick={() => remove(n)}
                disabled={busy}
                style={{ padding: '4px 8px', fontSize: 11 }}
                title="remove this chain"
              >🗑</button>
            </div>
          ))}
        </div>
      )}

      <div className="aw-card">
        <h2 className="aw-card-title">add custom chain</h2>
        <label className="aw-label">chain id (decimal)</label>
        <input className="aw-input" value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="e.g. 31337" />
        <label className="aw-label" style={{ marginTop: 10 }}>name</label>
        <input className="aw-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anvil local" />
        <label className="aw-label" style={{ marginTop: 10 }}>rpc url</label>
        <input className="aw-input" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder="https://…" />
        <label className="aw-label" style={{ marginTop: 10 }}>currency symbol</label>
        <input className="aw-input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="ETH" />
        <label className="aw-label" style={{ marginTop: 10 }}>block explorer (optional)</label>
        <input className="aw-input" value={explorer} onChange={(e) => setExplorer(e.target.value)} placeholder="https://etherscan.io" />
        {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
        <div className="aw-btn-row" style={{ marginTop: 12 }}>
          <button className="aw-btn aw-btn-ghost" onClick={onDone} disabled={busy}>done</button>
          <button className="aw-btn" onClick={save} disabled={!ok || busy} style={{ flex: 1 }}>
            {busy ? 'saving…' : 'add chain'}
          </button>
        </div>
      </div>
    </>
  );
}
