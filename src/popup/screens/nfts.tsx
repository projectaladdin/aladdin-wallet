// AddNFT — paste a contract + tokenId, fetch metadata, persist.
// Auto-discovery was removed: it relied on eth_getLogs scans that
// hit RPC range limits (publicnode caps 50k, Alchemy/Infura free
// 10k) and the chunked workaround still leaked the user's address
// to the RPC for every chunk. Mandatory tokenId keeps the flow
// single-RPC-call and predictable.

import { useState } from 'react';
import { Header } from '../components/header';
import { send, useToast } from '../shared';
import type { NftRecord } from '../../core/storage';

export function AddNftScreen({ onDone }: { onDone: () => void }) {
  const showToast = useToast();
  const [addr, setAddr] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<NftRecord | null>(null);

  const validAddr = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
  const trimmedId = tokenId.trim();
  const validId = /^(0x[0-9a-fA-F]+|\d+)$/.test(trimmedId);

  async function importNft() {
    setBusy(true); setErr(null); setPreview(null);
    try {
      const recs = await send<NftRecord[]>({
        kind: 'add-nft',
        address: addr.trim(),
        tokenId: trimmedId,
      });
      const rec = recs[0]!;
      setPreview(rec);
      showToast({ tone: 'green', icon: '✓', text: `${rec.name} added.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      showToast({ tone: 'red', icon: '⚠', text: msg.slice(0, 100) });
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <>
      <Header status="unlocked" onBack={busy ? undefined : onDone} label="add nft" />
      <div className="aw-card">
        <h2 className="aw-card-title">add NFT</h2>
        <p className="aw-mono" style={{ fontSize: 11, opacity: 0.6, marginTop: 0, marginBottom: 8 }}>
          paste an ERC-721 / ERC-1155 contract + tokenId. metadata is
          read on-chain.
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
        <label className="aw-label" style={{ marginTop: 10 }}>tokenId</label>
        <input
          className="aw-input"
          value={tokenId}
          onChange={(e) => { setTokenId(e.target.value); setPreview(null); setErr(null); }}
          placeholder="e.g. 123 or 0x7b"
          disabled={busy}
          inputMode="numeric"
        />
        {err && <div className="aw-alert aw-alert-danger" style={{ marginTop: 10 }}>{err}</div>}
        {preview && (
          <div className="aw-alert aw-alert-info" style={{ marginTop: 10 }}>
            ✓ added <b>{preview.name}</b> — {preview.standard} #{preview.tokenId}
          </div>
        )}
        <div className="aw-btn-row" style={{ marginTop: 12 }}>
          <button
            className="aw-btn aw-btn-ghost"
            onClick={onDone}
            disabled={busy}
          >
            {preview ? 'done' : 'cancel'}
          </button>
          <button
            className="aw-btn"
            onClick={importNft}
            disabled={!validAddr || !validId || busy || !!preview}
            style={{ flex: 1 }}
          >
            {busy ? 'reading chain…' : preview ? 'imported' : 'import'}
          </button>
        </div>
      </div>
    </>
  );
}
