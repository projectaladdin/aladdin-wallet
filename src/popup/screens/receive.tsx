// Receive screen — QR + chain-aware address strip. Extracted from
// popup.tsx during the modularisation pass.

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import QRCode from 'qrcode';
import { Header } from '../components/header';
import { AccountGlyph, useToast } from '../shared';
import { useNetworkState } from './dashboard';

// ─── Receive screen — QR + address + copy ────────────────────────────────

export function ReceiveScreen({ address, onBack }: { address: Address; onBack: () => void }) {
  const showToast = useToast();
  const { current } = useNetworkState();
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Chain-appropriate warning copy — "send only <chain> & ERC-20 tokens".
  const network = (current?.chain.name ?? 'this network').toLowerCase();
  const tokensLabel = '& ERC-20 tokens';

  useEffect(() => {
    void (async () => {
      // Static import — Bun's bundler doesn't code-split dynamic `import()`
      // for extension popups (no chunked URLs), so lazy importing 'qrcode'
      // resolved to undefined at runtime. Higher error correction (H, ~30%)
      // tolerates the AccountGlyph overlay covering the QR centre.
      const svg = await QRCode.toString(address, {
        type: 'svg',
        margin: 1,
        color: { dark: '#000000', light: '#FFF8E1' },
        errorCorrectionLevel: 'H',
      });
      setQrSvg(svg);
    })();
  }, [address]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      showToast({ tone: 'green', icon: '✓', text: 'address copied' });
    } catch {
      showToast({ tone: 'red', icon: '⚠', text: 'clipboard blocked, copy manually' });
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} label="receive" caption="share your address" />

      <div className="aw-receive-card">
        <span className="aw-receive-stamp">scan me</span>

        <div className="aw-qr-frame">
          {qrSvg ? (
            <div
              style={{ width: '100%', height: '100%' }}
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <span className="aw-mono" style={{ opacity: 0.4 }}>loading…</span>
          )}
          {/* Center overlay — the active account's pile-glyph identifies the
              wallet at a glance. QR error-correction (M, ~15%) tolerates the
              ~10% covered area in the middle. */}
          <div className="aw-qr-overlay">
            <AccountGlyph address={address} size={36} />
          </div>
        </div>

        <div className="aw-addr-card">{address}</div>

        <div className="aw-share-row">
          <button className={copied ? 'copied' : ''} onClick={copy}>
            {copied ? 'copied ✓' : 'copy ⧉'}
          </button>
        </div>
      </div>

      <div className="aw-warn">
        <span className="ico">😵</span>
        <span>
          send only {network} {tokensLabel} to this address. wrong network = lost coins.
        </span>
      </div>
    </>
  );
}
