// Send screen — token picker + amount entry + recipient + gas tier review.
// SendScreen owns the form state; ReviewBody handles the second step's
// confirm-and-broadcast layout. Extracted from popup.tsx during the
// modularisation pass.

import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { encodeFunctionData, parseUnits } from 'viem';
import { formatCurrency } from '../../lib/format';
import { Header } from '../components/header';
import {
  AccountGlyph,
  send,
  useToast,
  type TokenRow,
} from '../shared';
import { useNetworkState } from './dashboard';

// ─── Send screen — token picker + amount + recipient ─────────────────────

type GasTier = 'slow' | 'normal' | 'fast';
type GasCosts = {
  /** USD cost per tier — null when no price feed for the chain's native token. */
  slow: number | null; normal: number | null; fast: number | null;
  /** maxFeePerGas in gwei per tier — surfaced under each tier button so the
   *  user can see the actual gas price they're committing to, not just USD. */
  gwei?: { slow: number; normal: number; fast: number };
  /** Native-currency cost per tier (e.g. ETH on mainnet). Used by the MAX
   *  button on native sends to subtract gas before setting amount, so the
   *  resulting tx has enough native balance left to pay the fee. */
  eth?: { slow: number; normal: number; fast: number };
};

export function SendScreen({
  address, onBack, onSent, initialToken,
}: {
  address: Address;
  onBack: () => void;
  onSent: () => void;
  /** Pre-select a token by address. 'native' = ETH/native gas token,
   *  0x-prefixed = a specific ERC-20 row. Used by the Dashboard token
   *  detail modal's Send CTA so the user lands on the form already
   *  scoped to the token they were inspecting. */
  initialToken?: string;
}) {
  const showToast = useToast();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [selectedAddr, setSelectedAddr] = useState<string>(initialToken ?? 'native');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [gasTier, setGasTier] = useState<GasTier>('normal');
  const [gasCosts, setGasCosts] = useState<GasCosts | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Currency preference + ETH/USD rate for live amount conversion. Loaded
  // alongside the balance fetch so the "≈ $X" preview switches to "≈ Ξ X"
  // when the user has ETH selected.
  const [currency, setCurrency] = useState<'eth' | 'usd'>('usd');
  const [ethUsdRate, setEthUsdRate] = useState<number | null>(null);
  /** 'edit' = filling out the form. 'confirm' = preview screen with gas
   *  summary, awaiting "send it" click. Back button returns to edit. */
  const [phase, setPhase] = useState<'edit' | 'confirm'>('edit');

  useEffect(() => {
    void (async () => {
      try {
        const reply = await send<{ tokens: TokenRow[]; ethUsdRate: number | null }>({ kind: 'read-token-balances' });
        // SW returns balances WITHOUT a `loaded` field — Dashboard
        // tracks that flag locally for stale-while-revalidate UX.
        // Send fetches synchronously on mount, so by the time we set
        // state every row IS loaded; mark them so the MAX button's
        // `!selected.loaded` guard doesn't permanently disable click.
        setTokens(reply.tokens.map((t) => ({ ...t, loaded: true })));
        setEthUsdRate(reply.ethUsdRate);
      } catch {/* keep empty */}
      try {
        const c = await send<'eth' | 'usd'>({ kind: 'get-currency' });
        setCurrency(c);
      } catch {/* keep default */}
    })();
  }, [address]);

  const selected = tokens.find((t) => t.address.toLowerCase() === selectedAddr.toLowerCase());
  const isNative = selected?.isNative ?? selectedAddr === 'native';

  // ENS resolution — both directions:
  //   • forward: `vitalik.eth` → 0x address (used at submit time)
  //   • reverse: 0x address → primary `.eth` name (shown as a hint
  //     below the input so the user can spot a typo'd address that
  //     resolves to someone they didn't mean to send to)
  // Debounced ~350 ms so each keystroke doesn't fire an RPC.
  const trimmedRecipient = recipient.trim();
  const isHexAddr = /^0x[0-9a-fA-F]{40}$/.test(trimmedRecipient);
  const looksLikeEns = trimmedRecipient.length > 0 && !isHexAddr && trimmedRecipient.includes('.');
  const [resolvedEns, setResolvedEns] = useState<string | null>(null);
  const [resolvingEns, setResolvingEns] = useState(false);
  const [reverseEnsName, setReverseEnsName] = useState<string | null>(null);

  useEffect(() => {
    if (!looksLikeEns) { setResolvedEns(null); setResolvingEns(false); return; }
    let cancelled = false;
    // Clear the previous resolved address IMMEDIATELY on every name
    // change. Without this, when the user edits `vitalik.eth` →
    // `nobody.eth`, the 350 ms debounce window leaves `resolvedEns`
    // pointing at the OLD address; clicking "review →" mid-debounce
    // would broadcast to vitalik.eth's address while the input shows
    // "nobody.eth". The cleared state forces `validRecipient` to be
    // false until the new name resolves.
    setResolvedEns(null);
    setResolvingEns(true);
    const t = setTimeout(async () => {
      try {
        const addr = await send<string | null>({ kind: 'resolve-ens', name: trimmedRecipient });
        if (!cancelled) setResolvedEns(addr);
      } catch {
        if (!cancelled) setResolvedEns(null);
      } finally {
        if (!cancelled) setResolvingEns(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [trimmedRecipient, looksLikeEns]);

  useEffect(() => {
    if (!isHexAddr) { setReverseEnsName(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const name = await send<string | null>({ kind: 'resolve-ens-name', address: trimmedRecipient });
        if (!cancelled) setReverseEnsName(name);
      } catch {
        if (!cancelled) setReverseEnsName(null);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [trimmedRecipient, isHexAddr]);

  // The address the wallet will actually sign for. ENS name → resolved
  // address when one exists; otherwise the user's literal input.
  const effectiveRecipient = looksLikeEns && resolvedEns ? resolvedEns : trimmedRecipient;
  const validRecipient = /^0x[0-9a-fA-F]{40}$/.test(effectiveRecipient);
  // Reject locale-dependent decimal punctuation (e.g. `1,5` in de-DE
   // Chrome) — `<input type="number">` may surface the comma form in
   // `.value` on some platforms, and `parseFloat('1,5')` silently
   // truncates to 1. We require an ASCII dot to avoid sending an
   // off-by-10x amount.
  const amountNum = /,/.test(amount) ? NaN : parseFloat(amount);
  const validAmount = Number.isFinite(amountNum) && amountNum > 0;
  const ok = !!selected && validRecipient && validAmount;
  const usdEquiv =
    selected?.priceUsd != null && validAmount
      ? formatCurrency(amountNum * selected.priceUsd, currency, ethUsdRate)
      : null;

  // Live gas estimate — fires as soon as the user picks a token. The gas
  // cost only depends on chain fees + tx shape (21k native / 65k contract
  // call), NOT on amount or recipient, so we don't wait for the form to
  // be valid. Placeholder `to` and a token-transfer selector for ERC-20
  // are enough to cue the static-estimator branch.
  useEffect(() => {
    if (!selected) { setGasCosts(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const placeholderTo = '0x0000000000000000000000000000000000000000' as `0x${string}`;
        const tx = isNative
          ? { to: placeholderTo, value: '0x0' as `0x${string}` }
          : {
              // any non-empty data flips estimator to 65k. Use real `transfer()`
              // selector so the tx shape matches what we'll actually send.
              to: selected.address as `0x${string}`,
              data: '0xa9059cbb' as `0x${string}`,
              value: '0x0' as `0x${string}`,
            };
        const costs = await send<GasCosts | null>({ kind: 'estimate-tx-cost', tx });
        if (!cancelled) setGasCosts(costs);
      } catch {
        if (!cancelled) setGasCosts(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedAddr, isNative, selected]);

  async function submit() {
    if (!ok || !selected) return;
    setBusy(true); setErr(null);
    try {
      const valueUnits = parseUnits(amount, selected.decimals);
      let tx: { to: `0x${string}`; data?: `0x${string}`; value?: `0x${string}` };
      if (isNative) {
        tx = {
          to: effectiveRecipient as `0x${string}`,
          value: ('0x' + valueUnits.toString(16)) as `0x${string}`,
        };
      } else {
        const data = encodeFunctionData({
          abi: [{
            type: 'function', name: 'transfer', stateMutability: 'nonpayable',
            inputs: [{ type: 'address' }, { type: 'uint256' }],
            outputs: [{ type: 'bool' }],
          }],
          functionName: 'transfer',
          args: [effectiveRecipient as `0x${string}`, valueUnits],
        });
        tx = { to: selected.address as `0x${string}`, data, value: '0x0' };
      }
      const hash = await send<string>({ kind: 'popup-send', tx, gasTier });
      showToast({
        tone: 'green',
        icon: '✓',
        text: `sent ${amount} ${selected.symbol}. ${hash.slice(0, 10)}…`,
      });
      onSent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      showToast({ tone: 'red', icon: '⚠', text: msg.slice(0, 90) });
      setBusy(false);
    }
  }

  // Inline token picker — opens below the cream pill, dismisses on outside click.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Header ←: in edit phase goes back to dashboard; in confirm phase goes
  // back to edit (so user can fix typos without re-entering everything).
  const headerBack = busy
    ? undefined
    : phase === 'confirm'
      ? () => setPhase('edit')
      : onBack;

  return (
    <>
      <Header
        status="unlocked"
        onBack={headerBack}
        label={phase === 'confirm' ? 'review' : 'send'}
      />

      {phase === 'edit' && (<>

      {/* Amount stage — big stroked number, USD ≈, token pill picker. */}
      <div className="aw-amt-stage">
        <input
          className="aw-amt-input"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          disabled={busy}
        />
        <div className="aw-amt-secondary">
          {usdEquiv ? `≈ ${usdEquiv}` : ' '}
        </div>

        {/* Compact balance + MAX, sits directly above the token picker pill
           so they read as one unit (this is what you have / set max). Just
           the number — symbol context is on the pill below.
           For NATIVE sends, MAX subtracts the active gas tier's estimated
           fee so the tx leaves enough balance to pay gas. ERC-20 sends keep
           full balance because gas is paid in native, not the token. */}
        {selected && (
          <div className="aw-amt-balance">
            <span className="val">
              {Number(selected.balance).toLocaleString('en-US', { maximumFractionDigits: 6 })}
            </span>
            <button
              type="button"
              className="aw-amt-max"
              onClick={() => {
                const bal = Number(selected.balance);
                if (!Number.isFinite(bal)) return;
                if (isNative && gasCosts?.eth) {
                  // 1.5× safety multiplier on the gas reserve — the static
                  // 21k estimate runs ~5% under reality and the user's tx
                  // could land in a slightly higher gas-price block.
                  const gasReserve = gasCosts.eth[gasTier] * 1.5;
                  const sendable = Math.max(0, bal - gasReserve);
                  setAmount(sendable.toString());
                } else {
                  setAmount(selected.balance);
                }
              }}
              disabled={busy || !selected.loaded || Number(selected.balance) <= 0}
            >MAX</button>
          </div>
        )}

        <div className="aw-amt-token" ref={pickerRef}>
          <button
            type="button"
            className="aw-amt-token-trigger"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={busy}
          >
            <span>{selected?.symbol ?? 'pick'}</span>
            <span className="car">▾</span>
          </button>
          {pickerOpen && (
            <div className="aw-amt-token-menu">
              {tokens.map((t) => (
                <button
                  key={t.address}
                  type="button"
                  className={t.address.toLowerCase() === selectedAddr.toLowerCase() ? 'is-current' : ''}
                  onClick={() => {
                    setSelectedAddr(t.address);
                    setPickerOpen(false);
                  }}
                >
                  <span>{t.symbol}</span>
                  <span className="bal">
                    {Number(t.balance).toLocaleString('en-US', { maximumFractionDigits: 6 })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recipient field. Accepts a 0x-prefixed address or an ENS
          name; ENS resolution lights up the hint below. */}
      <div className="aw-field-card">
        <label>send to</label>
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x… or name.eth"
          disabled={busy}
        />
        {looksLikeEns && (
          <div className="aw-mono" style={{ fontSize: 11, marginTop: 4, opacity: 0.75 }}>
            {resolvingEns
              ? <>resolving ENS…</>
              : resolvedEns
                ? <>→ {resolvedEns}</>
                : <span style={{ color: 'var(--alarm-red)' }}>no ENS record found</span>}
          </div>
        )}
        {isHexAddr && reverseEnsName && (
          <div className="aw-mono" style={{ fontSize: 11, marginTop: 4, opacity: 0.75 }}>
            ↳ {reverseEnsName}
          </div>
        )}
      </div>

      {/* Gas tier moved to the review screen — first screen is just
          recipient + amount, the user picks slow/normal/fast with full USD
          numbers visible right before signing. Avoids gas-knob fiddling
          during the "where am I sending and how much" mental phase. */}

      {err && <div className="aw-alert aw-alert-danger">{err}</div>}

      <button
        className="aw-cta-primary"
        onClick={() => { setErr(null); setPhase('confirm'); }}
        disabled={!ok || busy}
      >
        {ok ? <>review →</> : 'fill it out'}
      </button>

      </>)}

      {phase === 'confirm' && (
        <ReviewBody
          amount={amount}
          tokenSymbol={selected?.symbol ?? ''}
          usdValue={selected?.priceUsd != null && validAmount ? amountNum * selected.priceUsd : null}
          currency={currency}
          ethUsdRate={ethUsdRate}
          recipient={effectiveRecipient as Address}
          gasTier={gasTier}
          setGasTier={setGasTier}
          gasCosts={gasCosts}
          err={err}
          busy={busy}
          onConfirm={submit}
        />
      )}
    </>
  );
}

/** Review (confirm) phase of the Send flow. Sourced from the Aladdin Wallet
 *  mock: ← REVIEW header + going-out stamp + big stroked amount + cream
 *  recipient block + gas tier + network / fee / total card + warning + CTA. */
function ReviewBody({
  amount, tokenSymbol, usdValue, currency, ethUsdRate, recipient, gasTier, setGasTier, gasCosts,
  err, busy, onConfirm,
}: {
  amount: string;
  tokenSymbol: string;
  /** Raw USD value of the send amount (price feed × amount), or null when
   *  no feed is available for this token. ReviewBody formats it itself in
   *  the active currency, instead of receiving a pre-formatted string and
   *  having to parse digits back out. */
  usdValue: number | null;
  currency: 'eth' | 'usd';
  ethUsdRate: number | null;
  recipient: Address;
  gasTier: GasTier;
  setGasTier: (t: GasTier) => void;
  gasCosts: GasCosts | null;
  err: string | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { current } = useNetworkState();
  const chainName = current?.chain.name ?? 'this network';
  const networkFee = gasCosts?.[gasTier] ?? null;
  const fmtCost = (v: number | null | undefined): string => {
    if (v == null) return '—';
    return formatCurrency(v, currency, ethUsdRate);
  };
  const usdEquiv = usdValue != null ? formatCurrency(usdValue, currency, ethUsdRate) : null;

  // Total cost = amount-in-USD + network fee USD. If amount has no price
  // feed (testnet, custom chain), just show the fee on its own.
  const totalUsdNum = usdValue != null && networkFee != null
    ? usdValue + networkFee
    : null;
  const totalDisplay = totalUsdNum != null
    ? formatCurrency(totalUsdNum, currency, ethUsdRate)
    : (usdEquiv ?? '—');


  return (
    <>
      {/* aw-review-head removed — the Header strip's "review" sticker
         already labels this phase, big REVIEW heading was redundant. */}
      <div className="aw-set-card" style={{ position: 'relative', padding: '20px 16px 14px' }}>
        <span className="aw-going-stamp">going out</span>

        <div className="aw-amt-display">
          <span className="num">{amount}</span>
          <span className="sym">{tokenSymbol}</span>
        </div>
        <div className="aw-amt-secondary" style={{ textAlign: 'center' }}>
          {usdEquiv ? `≈ ${usdEquiv}` : ' '}
        </div>

        <div style={{ textAlign: 'center' }}>
          <span className="aw-arrow-pill">↓</span>
        </div>

        <div className="aw-recipient-row">
          <AccountGlyph address={recipient} size={36} />
          <div className="info">
            {/* Full 40-char address only — no truncated alias above. CSS
               `word-break: break-all` lets it wrap inside the cream block. */}
            <div className="addr">{recipient}</div>
          </div>
        </div>
      </div>

      <div className="aw-gas-card">
        <div className="head">
          <span className="lbl">gas</span>
          <span className="val">
            {fmtCost(networkFee)}
            {gasCosts?.gwei && (
              <span className="gwei">
                {' · '}
                {gasCosts.gwei[gasTier].toLocaleString('en-US', { maximumFractionDigits: 2 })} gwei
              </span>
            )}
          </span>
        </div>
        <div className="aw-gas-options">
          {([
            { k: 'slow',   label: 'slow',   eta: '~2 min'  },
            { k: 'normal', label: 'normal', eta: '~30 sec' },
            { k: 'fast',   label: 'fast',   eta: '~5 sec'  },
          ] as const).map((g) => (
            <button
              key={g.k}
              type="button"
              className={'aw-gas-option' + (gasTier === g.k ? ' is-on' : '')}
              onClick={() => setGasTier(g.k)}
              disabled={busy}
            >
              {g.label}
              <span className="num">{g.eta}</span>
              {gasCosts?.gwei && (
                <span className="num gwei">
                  {gasCosts.gwei[g.k].toLocaleString('en-US', { maximumFractionDigits: 2 })} gwei
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="aw-fee-card">
        <div className="aw-fee-row">
          <span className="k">network</span>
          <span className="v">{chainName.toLowerCase()}</span>
        </div>
        <div className="aw-fee-row" style={{ borderTop: '2px solid var(--ink)' }}>
          <span className="k">network fee</span>
          <span className="v">{fmtCost(networkFee)}</span>
        </div>
        <div className="aw-fee-divider" />
        <div className="aw-fee-row is-total">
          <span className="k">total cost</span>
          <span className="v">{totalDisplay}</span>
        </div>
      </div>

      <div className="aw-warn">
        <span className="ico">⚠</span>
        <span>txns are forever. once signed, no take-backs.</span>
      </div>

      {err && <div className="aw-alert aw-alert-danger">{err}</div>}

      <button
        className="aw-cta-primary"
        onClick={onConfirm}
        disabled={busy}
        style={{ marginTop: 'auto' }}
      >
        {busy ? 'sending…' : 'send it'}
      </button>
    </>
  );
}
