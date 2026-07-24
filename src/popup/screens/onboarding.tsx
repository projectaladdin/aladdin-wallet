// Pre-vault and unlock screens — Loading, Welcome, Create, Import,
// PasswordSetCard, Unlock. Extracted from popup.tsx during the
// modularisation pass; no behaviour change.

import { useState } from 'react';
import { encryptMnemonic, isValidMnemonic } from '../../core/crypto';
import { setVault } from '../../core/storage';
import { Header } from '../components/header';
import { Lamp, send, useToast } from '../shared';

export function Loading() {
  return <><Header /><p className="aw-mono" style={{ opacity: 0.5 }}>loading…</p></>;
}

export function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <>
      <Header status="no-wallet" />
      <div className="aw-welcome-hero">
        <div className="aw-welcome-logo">
          <img src="icons/128.png" alt="" width={64} height={64} />
        </div>
        <h1 className="aw-welcome-title">ALADDIN</h1>
        <p className="aw-welcome-sub">a wallet for the age of djinn</p>
      </div>

      <button
        type="button"
        className="aw-welcome-option is-recommended"
        onClick={onCreate}
      >
        <span className="aw-welcome-rec-stamp">recommended</span>
        <span className="aw-welcome-icon">＋</span>
        <span className="aw-welcome-body">
          <span className="aw-welcome-name">create new wallet</span>
          <span className="aw-welcome-hint">fresh seed, fresh start</span>
        </span>
        <span className="aw-welcome-arrow">→</span>
      </button>

      <button
        type="button"
        className="aw-welcome-option"
        onClick={onImport}
      >
        <span className="aw-welcome-icon">↓</span>
        <span className="aw-welcome-body">
          <span className="aw-welcome-name">import seed phrase</span>
          <span className="aw-welcome-hint">12 / 24 words from another wallet</span>
        </span>
        <span className="aw-welcome-arrow">→</span>
      </button>

      <p className="aw-welcome-foot">
        <Lamp size={48} />
        by continuing u agree to be a responsible user. not financial advice.
      </p>
    </>
  );
}

export function Create({ mnemonic, onDone, onBack }: { mnemonic: string; onDone: () => void; onBack: () => void }) {
  // Two-step create flow:
  //   1. 'backup' — Aladdin "BACK IT UP" screen: tap-to-reveal seed → grid →
  //      user copies or confirms they wrote it down.
  //   2. 'password' — set unlock password, save vault, auto-unlock to dashboard.
  // The reveal-on-tap default keeps the seed off-screen during smoke tests
  // and shoulder-surf moments; user has to actively choose to view it.
  const [step, setStep] = useState<'backup' | 'password'>('backup');
  const [revealed, setRevealed] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const showToast = useToast();

  const words = mnemonic.split(' ');
  const pwOk = pw.length >= 8 && pw === pw2;

  async function copySeed() {
    try {
      await navigator.clipboard.writeText(mnemonic);
      showToast({ tone: 'green', icon: '📋', text: 'seed copied. paste somewhere safe, then wipe.' });
    } catch {
      showToast({ tone: 'red', icon: '💥', text: 'clipboard blocked by browser. write the words down manually.' });
    }
  }

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const vault = await encryptMnemonic(mnemonic, pw);
      await setVault(vault);
      // Fresh mnemonic → wipe any leftover account list from a prior wallet
      // and seed a single Account 1 at index 0.
      await send({ kind: 'reset-accounts' });
      // Auto-unlock with the password the user just set so they land
      // straight on the dashboard instead of being asked to re-type.
      await send({ kind: 'unlock', password: pw });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (step === 'backup') {
    return (
      <>
        <Header status="no-wallet" onBack={busy ? undefined : onBack} caption="ur seed phrase" />

        <div className="aw-warn-banner">
          <span className="aw-warn-emoji" aria-hidden="true">🥺</span>
          <span className="aw-warn-text">
            write these down. NEVER screenshot. anyone with these 12 words owns ur coins forever.
          </span>
        </div>

        {!revealed ? (
          <button
            type="button"
            className="aw-seed-veil"
            onClick={() => setRevealed(true)}
            aria-label="tap to reveal seed"
          >
            <div className="aw-seed-veil-inner">
              <div className="aw-seed-emoji" aria-hidden="true">🙈</div>
              <div className="aw-seed-veil-cta">TAP TO REVEAL SEED</div>
            </div>
          </button>
        ) : (
          <div className="aw-seed-grid" role="list">
            {words.map((w, i) => (
              <div key={i} className="aw-seed-cell" role="listitem">
                <span className="aw-seed-num">{i + 1}</span>
                <span className="aw-seed-word">{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className="aw-seed-actions">
          <button
            type="button"
            className="aw-btn aw-btn-ghost"
            onClick={copySeed}
            disabled={!revealed}
          >COPY</button>
          <button
            type="button"
            className="aw-btn"
            style={{ background: 'var(--aw-gold)', flex: 1 }}
            onClick={() => setStep('password')}
            disabled={!revealed}
          >I WROTE IT DOWN →</button>
        </div>
      </>
    );
  }

  // step === 'password'
  // No `label` — Header auto-renders the yellow "new" sticker via
  // status="no-wallet" branch. Passing label here would stack a green sticker
  // on top, which is what created the buggy "import seed" double-sticker.
  return (
    <>
      <Header status="no-wallet" onBack={busy ? undefined : () => setStep('backup')} />
      <PasswordSetCard pw={pw} pw2={pw2} pwOk={pwOk} setPw={setPw} setPw2={setPw2} err={err} busy={busy} onSubmit={save} cta="create wallet" />
    </>
  );
}

export function Import({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  // Two-step import flow, mirroring Create: 'enter' (per-cell seed grid)
  // → 'password' (set unlock password). Word grid is the modern wallet
  // pattern — per-cell inputs prevent accidental pastes of unrelated
  // clipboard content into a single textarea, and let us validate spell on
  // the fly. Paste-detection on any cell auto-distributes a multi-word
  // string across all cells, so the UX still beats a single textarea for
  // users coming from another wallet.
  const [step, setStep] = useState<'enter' | 'password'>('enter');
  const [size, setSize] = useState<12 | 24>(12);
  const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const showToast = useToast();

  const phrase = words.map((w) => w.trim().toLowerCase()).join(' ').trim();
  const filled = words.filter((w) => w.trim().length > 0).length;
  const phraseOk = filled === size && isValidMnemonic(phrase);
  const pwOk = pw.length >= 8 && pw === pw2;

  function changeSize(newSize: 12 | 24) {
    if (newSize === size) return;
    setSize(newSize);
    setWords((cur) => {
      const next = Array(newSize).fill('');
      // Preserve any words the user already typed in the smaller grid when
      // upgrading 12 → 24; when downsizing 24 → 12, drop the trailing 12.
      for (let i = 0; i < Math.min(cur.length, newSize); i++) next[i] = cur[i] ?? '';
      return next;
    });
  }

  function setWord(i: number, raw: string) {
    // Paste-detection: if a single field receives a string with whitespace
    // (12 / 24 words pasted at once), distribute it across all cells from
    // index `i`. This is the common case for users coming from another
    // wallet's "show recovery phrase" → copy.
    const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      // Compute target grid size FIRST so the setWords callback below
      // can allocate the right length up front. Previously we ran
      // setWords with the current (12-word) state and only called
      // setSize(24) afterwards — React's batching meant the setWords
      // closure saw `cur.length === 12`, the loop's `i + k < 12` clamp
      // truncated tokens[12..23], then setSize expanded the array with
      // those tokens already lost. Paste of 24 into a 12-grid silently
      // dropped half the seed.
      const autoResize = i === 0 && (tokens.length === 12 || tokens.length === 24);
      const targetSize: 12 | 24 = autoResize ? (tokens.length as 12 | 24) : size;
      if (autoResize && targetSize !== size) setSize(targetSize);
      setWords((cur) => {
        const next = Array(targetSize).fill('');
        // Preserve any cells before the paste insertion point.
        for (let p = 0; p < Math.min(cur.length, i, targetSize); p++) next[p] = cur[p] ?? '';
        for (let k = 0; k < tokens.length && i + k < targetSize; k++) {
          next[i + k] = tokens[k] ?? '';
        }
        return next;
      });
      return;
    }
    setWords((cur) => {
      const next = [...cur];
      next[i] = raw.toLowerCase();
      return next;
    });
  }

  function clearAll() {
    setWords(Array(size).fill(''));
  }

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const vault = await encryptMnemonic(phrase, pw);
      await setVault(vault);
      await send({ kind: 'reset-accounts' });
      await send({ kind: 'unlock', password: pw });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (step === 'enter') {
    return (
      <>
        <Header status="no-wallet" onBack={busy ? undefined : onBack} />

        <div className="aw-warn-banner">
          <span className="aw-warn-emoji" aria-hidden="true">🥺</span>
          <span className="aw-warn-text">
            never share these words. anyone who has them owns ur coins.
          </span>
        </div>

        <div className="aw-seed-size-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={size === 12}
            className={'aw-seed-size-tab' + (size === 12 ? ' is-active' : '')}
            onClick={() => changeSize(12)}
          >12 words</button>
          <button
            type="button"
            role="tab"
            aria-selected={size === 24}
            className={'aw-seed-size-tab' + (size === 24 ? ' is-active' : '')}
            onClick={() => changeSize(24)}
          >24 words</button>
        </div>

        <div className="aw-seed-input-grid" role="list">
          {words.map((w, i) => (
            <label key={i} className="aw-seed-input-cell" role="listitem">
              <span className="aw-seed-input-num">{i + 1}</span>
              <input
                type="text"
                className="aw-seed-input"
                value={w}
                onChange={(e) => setWord(i, e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={`word ${i + 1}`}
              />
            </label>
          ))}
        </div>

        <button
          type="button"
          className={'aw-btn aw-btn-block aw-seed-cta' + (phraseOk ? ' is-ready' : '')}
          onClick={() => phraseOk && setStep('password')}
          disabled={!phraseOk}
          style={{ background: phraseOk ? 'var(--aw-gold)' : undefined }}
        >
          {phrase && filled === size && !phraseOk
            ? 'invalid phrase ✗'
            : `${filled}/${size} WORDS${phraseOk ? ' ✓' : ''}`}
        </button>

        <button
          type="button"
          className="aw-seed-clear"
          onClick={() => {
            clearAll();
            showToast({ tone: 'yellow', icon: '🧹', text: 'cleared.' });
          }}
        >clear all</button>
      </>
    );
  }

  // step === 'password'
  // No `label` — Header auto-renders the yellow "new" sticker via
  // status="no-wallet" branch. Passing any explicit label stacks a green
  // sticker on top of the yellow auto one (double-sticker bug), so the
  // import screen relies on the auto-rendered sticker alone.
  return (
    <>
      <Header status="no-wallet" onBack={busy ? undefined : () => setStep('enter')} />
      <PasswordSetCard pw={pw} pw2={pw2} pwOk={pwOk} setPw={setPw} setPw2={setPw2} err={err} busy={busy} onSubmit={save} cta="import wallet" />
    </>
  );
}

function PasswordSetCard({
  pw, pw2, pwOk, setPw, setPw2, err, busy, onSubmit, cta,
}: {
  pw: string; pw2: string; pwOk: boolean;
  setPw: (s: string) => void; setPw2: (s: string) => void;
  err: string | null; busy: boolean; onSubmit: () => void; cta: string;
}) {
  return (
    <div className="aw-card">
      <h2 className="aw-card-title">password</h2>
      <p className="aw-caption">encrypts the phrase on this device. min 8 chars.</p>
      <label className="aw-label">password</label>
      <input className="aw-input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <label className="aw-label" style={{ marginTop: 10 }}>confirm</label>
      <input className="aw-input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
      <button className="aw-btn aw-btn-block" style={{ marginTop: 12 }} disabled={!pwOk || busy} onClick={onSubmit}>
        {busy ? 'encrypting…' : cta}
      </button>
    </div>
  );
}

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const showToast = useToast();

  async function tryUnlock() {
    setBusy(true);
    try {
      await send({ kind: 'unlock', password: pw });
      onUnlocked();
    } catch (e) {
      showToast({ tone: 'red', icon: '🔒', text: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  }

  return (
    <>
      <div className="aw-unlock">
        {/* Tilted black sticker holding a yellow lock — same pattern as the
           design mock screenshot. Sits centered on the dark + dot
           background; no Header strip on this screen for visual focus. */}
        <div className="aw-unlock-sticker" aria-hidden>🔒</div>
        <h1 className="aw-unlock-title">WALLET LOCKED</h1>
        <p className="aw-unlock-sub">enter password to unlock</p>

        <div className="aw-unlock-input">
          <input
            type={reveal ? 'text' : 'password'}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pw && !busy && tryUnlock()}
            autoFocus
            aria-label="password"
          />
          <button
            type="button"
            className="eye"
            onClick={() => setReveal(!reveal)}
            aria-label={reveal ? 'hide password' : 'reveal password'}
          >
            {reveal ? '🙈' : '👁'}
          </button>
        </div>

        <button
          className="aw-unlock-btn"
          disabled={!pw || busy}
          onClick={tryUnlock}
        >
          {busy ? 'UNLOCKING…' : 'UNLOCK'}
        </button>
      </div>
    </>
  );
}
