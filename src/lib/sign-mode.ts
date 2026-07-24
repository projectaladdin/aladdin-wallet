// Pure sign-confirm mode classifier + action label. Extracted from popup.tsx
// so unit tests don't need React. Modes drive the visual shape of the
// confirm screen; action labels go into the SignHead subtitle.

import type { PendingRequest } from '../shared/protocol';
import { decodeTxData, parseTyped } from './decoders';
import { unpackTypedDataParams } from './validators';

// Modes ordered to match SIGN_METHODS / KNOWN_WALLET_METHODS in protocol.ts:
// eth_* signing first (low → high), then wallet_* state mutations, then
// wallet_* signing (highest risk).
export type SignMode = 'message' | 'typed' | 'approve' | 'sendtx' | 'addchain' | 'watchAsset' | '7702';

export type StampTone = 'low' | 'warn' | 'bad';

export type ModeInfo = {
  mode: SignMode;
  stampText: string;
  stampTone: StampTone;
};

/** Map a pending request to the visual mode + header stamp the SignConfirm
 *  screen should render. Throws on unknown method — every method that
 *  reaches this point must be in SIGN_METHODS or wallet_addEthereumChain. */
export function deriveSignMode(req: PendingRequest): ModeInfo {
  const m = req.payload.method;
  if (m === 'wallet_signAuthorization') {
    return { mode: '7702',     stampText: 'Wallet takeover', stampTone: 'bad'  };
  }
  if (m === 'eth_sendTransaction') {
    const p = (req.payload.params as [{ data?: string }])[0];
    const decoded = decodeTxData(p?.data);
    if (decoded.kind === 'known' && decoded.name === 'approve') {
      return { mode: 'approve', stampText: 'Spends ur tokens', stampTone: 'bad' };
    }
    return { mode: 'sendtx',  stampText: 'Send tx',         stampTone: 'warn' };
  }
  if (m === 'wallet_addEthereumChain') {
    return { mode: 'addchain', stampText: 'Adds a chain',   stampTone: 'warn' };
  }
  if (m === 'wallet_watchAsset') {
    // EIP-747 covers ERC-20 + NFT (ERC-721/1155). Stamp + mode are
    // shared; specific copy ("add token" vs "add NFT") branches in
    // sign-confirm's CTA + body.
    return { mode: 'watchAsset', stampText: 'Adds an asset', stampTone: 'low' };
  }
  if (m === 'personal_sign') {
    return { mode: 'message',  stampText: 'Low risk',       stampTone: 'low'  };
  }
  if (m.startsWith('eth_signTypedData')) {
    return { mode: 'typed',    stampText: 'Check carefully', stampTone: 'warn' };
  }
  throw new Error(`unhandled sign method: ${m}`);
}

/** Short verb-phrase used as the SignHead subtitle ("approve token", "send
 *  transaction", "sign Permit", etc.). Tries to be specific based on
 *  decoded calldata or typed-data primaryType, falls back to a generic
 *  category label. */
export function signActionLabel(req: PendingRequest): string {
  const m = req.payload.method;
  if (m === 'wallet_signAuthorization') return 'sign 7702 delegation';
  if (m === 'wallet_addEthereumChain')  return 'add custom chain';
  if (m === 'wallet_watchAsset') {
    const raw = req.payload.params as unknown;
    const p = (Array.isArray(raw) ? (raw as unknown[])[0] : raw) as { type?: string };
    return (p?.type === 'ERC721' || p?.type === 'ERC1155') ? 'add NFT' : 'add token';
  }
  if (m === 'personal_sign')            return 'sign message';
  if (m === 'eth_sendTransaction') {
    const p = (req.payload.params as [{ to?: string; data?: string }])[0];
    // Contract deploy — `to` omitted or zero address.
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    if (!p?.to || p.to.toLowerCase() === ZERO_ADDR) return 'deploy contract';
    const decoded = decodeTxData(p.data);
    if (decoded.kind === 'known') {
      if (decoded.name === 'approve')                                          return 'approve token';
      if (decoded.name === 'transfer' || decoded.name === 'transferFrom')      return 'transfer token';
      if (decoded.name === 'deposit')                                           return 'wrap ETH';
      if (decoded.name === 'withdraw')                                          return 'unwrap';
    }
    return 'send transaction';
  }
  if (m.startsWith('eth_signTypedData')) {
    const { data } = unpackTypedDataParams(req.payload.params);
    const td = parseTyped(data);
    if (td?.primaryType) return `sign ${td.primaryType}`;
    return 'sign typed data';
  }
  return 'requesting signature';
}
