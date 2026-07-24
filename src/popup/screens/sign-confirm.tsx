// Sign-confirm cluster — the multi-mode pending-request screen and the
// connect-approval screen, both extracted verbatim from popup.tsx during
// the modularisation pass. Bodies are mode-specific (message / typed /
// approve / sendtx / addchain / watchAsset / 7702) and share state via
// the SignConfirmBody parent.
//
// Imports below match what the original popup.tsx provided to this block —
// no behaviour changes, only relocation.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import { encodeFunctionData, parseUnits } from 'viem';
import type { Abi } from 'viem';
import {
  COMMON_TX_ABI,
  decodeTxData,
  decodeTxDataWithAbi,
  isStandardERC2612Permit,
  isStandardPermit2Single,
  isStandardPermit2Batch,
  getRawTypes,
  relativeFromUnix,
  parseTyped,
  type DecodedTx,
} from '../../lib/decoders';
import { unpackTypedDataParams } from '../../lib/validators';
import { compactNumber, isInfinityAllowance } from '../../lib/approve-format';
import {
  formatCurrency,
  formatTokenAmount,
  formatTokenContract,
  formatWeiHex,
  humanDeadline,
  chainBadge,
  explorerAddressUrl,
  truncateAddr,
  type TokenInfo,
} from '../../lib/format';
import { isDangerous } from '../../lib/risk';
import { runEngine } from '../../lib/security-engine';
import { SecurityChecks } from '../components/security-checks';
import { verifyContract } from '../../lib/contract-verify';
import {
  decideSeven702Gate,
  type SevenSevenZeroTwoGate,
} from '../../lib/seven702-gate';
import { deriveSignMode, signActionLabel, type StampTone } from '../../lib/sign-mode';
import {
  deserializeScope,
  describeGrantCan,
  deriveCannotList,
  type GrantRecord,
} from '../../lib/grant-scope';
import { evaluateTxAgainstGrants } from '../../lib/scope-guard';
import { buildIntentFromTx, type IntentAction } from '../../lib/mcp-intent';
import type { PendingRequest } from '../../shared/protocol';
import { AccountGlyph, send, useToast, type TokenRow } from '../shared';

type Row = {
  label: string;
  value: string;
  mono?: boolean;
  /** When set, the row's value renders as an `<a target="_blank">`
   *  link. Used for address-type rows (e.g. `token:` in send-tx
   *  decoded view) so the user can jump to the block explorer
   *  (Etherscan / Sourcify fallback) for that contract. */
  href?: string;
};

// ─── Sign-confirm modes (5 visual / interaction shapes) ─────────────────
//
//  message  EIP-191 personal_sign — green LOW RISK, no funds move
//  typed    EIP-712 typed data — structured kv with amount highlights
//  approve  ERC-20 approve — capped/max toggle
//  7702     wallet_signAuthorization — slide-to-confirm + chain badge
//  sendtx   plain eth_sendTransaction (decoded calldata fallback)
//  addchain wallet_addEthereumChain
//
// `eth_sign` is rejected upstream in background.ts (EIP-1474 4200) — it
// signs a raw 32-byte hash with no prefix, identical to the primitive that
// signs both ETH and BTC tx hashes, so it's a phishing magnet by design.
//
// Each mode owns its own header stamp, body layout, lock mechanism, and CTA.

/* No friendly-name registry. Hard-coded address → label maps need
   active maintenance per chain + protocol upgrade; an out-of-date
   entry becomes attack surface (a phisher reusing a stale "Uniswap
   V3 Router" address gets a free trust signal). Sign-confirm UI
   shows the raw 0x40 hex address everywhere and defers identification
   to the user's preferred explorer. A future iteration could pull
   labels from a maintained token-list / chainId-aware registry. */

/** Semantic view of a typed-data sign request — maps known protocol shapes
 *  (Permit / Permit2 / OrderComponents / Mail) into a uniform 5-row layout
 *  (who / to / what / amount / when) so the UI can render the SAME shape
 *  regardless of primaryType. Unknown shapes set `unknown: true` and the
 *  caller renders a red banner + raw-data-open accordion. */
type SemRow = {
  /** Friendly name (e.g., "Cow", "Bob") — only set when the message struct
   *  itself carries a `name` field. We do NOT look up addresses against any
   *  protocol registry to avoid stale-data attack surface. */
  name?: string;
  /** Full 20-byte EVM address shown inline with a copy button. */
  addr?: string;
};
type SemView = {
  /** Goes in the yellow strip header — primaryType uppercased ("MAIL", "PERMIT"). */
  title: string;
  /** Shown under the header in a cream pill — the dapp's origin. */
  url: string;
  who: SemRow;
  to: SemRow;
  what: SemRow & { display?: string };
  /** Yellow chunky amount block (e.g., "2.5 ETH", "500 USDC", "∞ MAX"). */
  amount?: { display: string };
  /** Bold relative time + mono `unix N` sub. */
  when?: { display: string; sub: string };
  /** Domain footer pill — neutral cream pill showing name + chainId. */
  domain: { name: string; chainId?: number };
  /** True when we couldn't map the shape — caller surfaces danger banner + opens raw data. */
  unknown: boolean;
  /** Raw payload echo for the accordion. */
  raw: { types: Record<string, unknown>; primaryType: string; domain: unknown; message: unknown } | null;
};

function decodeSemantics(
  req: PendingRequest,
  tokenInfo: Record<string, TokenInfo>,
): SemView {
  const { data } = unpackTypedDataParams(req.payload.params);
  const td = parseTyped(data);
  const types = getRawTypes(data) ?? {};
  const url = req.origin;
  const domain = (td?.domain ?? {}) as Record<string, unknown>;
  const verifyingContract = String(domain.verifyingContract ?? '').toLowerCase();
  const domainTag = {
    name: String(domain.name ?? '?'),
    chainId: domain.chainId !== undefined ? Number(domain.chainId) : undefined,
  };
  const rawObj = (() => {
    try {
      const o = typeof data === 'string' ? JSON.parse(data) : data;
      if (o && typeof o === 'object') return o as SemView['raw'];
    } catch { /* */ }
    return null;
  })();

  const baseUnknown: SemView = {
    title: td?.primaryType?.toUpperCase() ?? 'OPAQUEPAYLOAD',
    url, who: {}, to: {}, what: {},
    domain: domainTag, unknown: true, raw: rawObj,
  };

  if (!td) return baseUnknown;
  const pt = td.primaryType;

  // ─── ERC-2612 Permit ─────────────────────────────────────────────────
  if (pt === 'Permit' && isStandardERC2612Permit(types)) {
    const m = td.message as { owner?: string; spender?: string; value?: string; deadline?: string };
    const tokenAddr = verifyingContract;
    const tokenInf = tokenInfo[tokenAddr];
    const isMax = m.value && /^0x[fF]+$/.test(String(m.value));
    let amountDisplay: string | undefined;
    if (isMax) amountDisplay = '∞ MAX';
    else if (m.value !== undefined && tokenInf) {
      const n = Number(BigInt(m.value)) / 10 ** tokenInf.decimals;
      amountDisplay = `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${tokenInf.symbol}`;
    } else if (m.value !== undefined) amountDisplay = String(m.value);
    return {
      title: 'PERMIT', url,
      who: { addr: m.owner },
      to: { addr: m.spender },
      what: {
        display: tokenInf ? `${tokenInf.name} (${tokenInf.symbol})` : undefined,
        addr: tokenAddr || undefined,
      },
      amount: amountDisplay ? { display: amountDisplay } : undefined,
      when: m.deadline ? relativeFromUnix(m.deadline) ?? undefined : undefined,
      domain: domainTag, unknown: false, raw: rawObj,
    };
  }

  // ─── Permit2 PermitSingle ────────────────────────────────────────────
  if (pt === 'PermitSingle' && isStandardPermit2Single(types)) {
    const m = td.message as {
      details?: { token?: string; amount?: string; expiration?: string };
      spender?: string; sigDeadline?: string;
    };
    const det = m.details ?? {};
    const tokenInf = det.token ? tokenInfo[det.token.toLowerCase()] : undefined;
    const isMax = det.amount && /^0x[fF]+$/.test(String(det.amount));
    let amountDisplay: string | undefined;
    if (isMax) amountDisplay = '∞ MAX';
    else if (det.amount !== undefined && tokenInf) {
      const n = Number(BigInt(det.amount)) / 10 ** tokenInf.decimals;
      amountDisplay = `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${tokenInf.symbol}`;
    }
    return {
      title: 'PERMITSINGLE', url,
      who: {},
      to: { addr: m.spender },
      what: {
        display: tokenInf ? `${tokenInf.name} (${tokenInf.symbol})` : undefined,
        addr: det.token,
      },
      amount: amountDisplay ? { display: amountDisplay } : undefined,
      when: m.sigDeadline ? relativeFromUnix(m.sigDeadline) ?? undefined : undefined,
      domain: domainTag, unknown: false, raw: rawObj,
    };
  }

  // ─── Seaport OrderComponents ─────────────────────────────────────────
  if (pt === 'OrderComponents') {
    const m = td.message as {
      offerer?: string; zone?: string;
      offer?: { token?: string }[];
      consideration?: { startAmount?: string }[];
      endTime?: string;
    };
    const offerToken = Array.isArray(m.offer) && m.offer[0]?.token;
    const considerationAmt = Array.isArray(m.consideration) && m.consideration[0]?.startAmount;
    let amountDisplay: string | undefined;
    if (considerationAmt) {
      try {
        const wei = BigInt(considerationAmt);
        const eth = Number(wei) / 1e18;
        amountDisplay = `${eth.toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH`;
      } catch { /* skip */ }
    }
    return {
      title: 'ORDERCOMPONENTS', url,
      who: { addr: m.offerer },
      to: { addr: m.zone },
      what: { addr: offerToken || undefined },
      amount: amountDisplay ? { display: amountDisplay } : undefined,
      when: m.endTime ? relativeFromUnix(m.endTime) ?? undefined : undefined,
      domain: domainTag, unknown: false, raw: rawObj,
    };
  }

  // ─── Mail (EIP-712 spec example) ─────────────────────────────────────
  if (pt === 'Mail') {
    const m = td.message as {
      from?: { name?: string; wallet?: string };
      to?:   { name?: string; wallet?: string };
      contents?: string;
    };
    return {
      title: 'MAIL', url,
      who:  { name: m.from?.name, addr: m.from?.wallet },
      to:   { name: m.to?.name,   addr: m.to?.wallet   },
      what: { display: m.contents !== undefined ? `"${m.contents}"` : undefined },
      domain: domainTag, unknown: false, raw: rawObj,
    };
  }

  // Parseable but unrecognised primaryType — opaque payload, populate signer
  // only from address-shaped fields if any obvious one exists.
  return baseUnknown;
}

/** Common ERC-20 / ERC-721 / WETH function ABIs we recognise inside an
 *  `eth_sendTransaction` calldata payload. Keeping this minimal: each entry
 *  corresponds to a 4-byte selector that 90% of phishing payloads ride on.
 *  Decoded args land in the sign-confirm so users see "approve UNLIMITED to
 *  attacker.eth" instead of a hex blob. */
// COMMON_TX_ABI / DecodedTx / decodeTxData moved to ./decoders so tests can
// import them without pulling in React. popup re-imports them at the top.

/** Walk a typed-data Permit/PermitSingle/PermitBatch and pull every token
 *  address that the popup may need decimals/symbol for. Used to fire
 *  read-token-info on mount of SignConfirm. */
function collectPermitTokens(request: PendingRequest): string[] {
  const m = request.payload.method;
  const out = new Set<string>();

  // eth_sendTransaction → if the calldata decodes to a known ERC-20/-721
  // function, the `to` is the token contract; we want its decimals + symbol.
  if (m === 'eth_sendTransaction') {
    const p = (request.payload.params as [{ to?: string; data?: string }])[0];
    if (p?.to && p.data && p.data !== '0x') {
      const decoded = decodeTxData(p.data);
      if (decoded.kind === 'known') out.add(p.to.toLowerCase());
    }
    return Array.from(out);
  }

  // Permit / PermitSingle / PermitBatch in typed data
  if (m === 'eth_signTypedData_v4' || m === 'eth_signTypedData' || m === 'eth_signTypedData_v1') {
    const { data } = unpackTypedDataParams(request.payload.params);
    const td = parseTyped(data);
    if (!td) return [];
    const rawTypes = getRawTypes(data);
    // Only fetch token decimals/symbol for canonical Permit shapes — a
    // non-standard "Permit" has no guarantee its `value` / `details[].amount`
    // semantics map to ERC-20 token amounts, so the lookup would mislead.
    if (td.primaryType === 'Permit' && isStandardERC2612Permit(rawTypes)) {
      const vc = (td.domain as { verifyingContract?: string } | undefined)?.verifyingContract;
      if (vc) out.add(vc.toLowerCase());
    } else if (td.primaryType === 'PermitSingle' && isStandardPermit2Single(rawTypes)) {
      const details = (td.message as { details?: unknown }).details;
      const arr = Array.isArray(details) ? details : details ? [details] : [];
      for (const d of arr) {
        const tok = (d as { token?: string }).token;
        if (tok) out.add(tok.toLowerCase());
      }
    } else if (td.primaryType === 'PermitBatch' && isStandardPermit2Batch(rawTypes)) {
      const details = (td.message as { details?: unknown }).details;
      const arr = Array.isArray(details) ? details : details ? [details] : [];
      for (const d of arr) {
        const tok = (d as { token?: string }).token;
        if (tok) out.add(tok.toLowerCase());
      }
    }
  }
  return Array.from(out);
}

function describeRequest(
  request: PendingRequest,
  tokenInfo: Record<string, TokenInfo> = {},
  /** Sourcify-resolved decode for `eth_sendTransaction`, preferred
   *  over the sync local-table decode. null when the local table
   *  already matched (or when Sourcify lookup hasn't returned / had
   *  no result). Only meaningful for the sendtx branch below. */
  decodedOverride: DecodedTx | null = null,
  /** Current chain — when known, address rows render as clickable
   *  block-explorer links (Etherscan / Sourcify fallback). Null
   *  before the popup's `get-current-chain` resolves; in that brief
   *  window rows render as plain text. */
  chainId: number | null = null,
): Row[] {
  const method = request.payload.method;

  if (method === 'wallet_signAuthorization') {
    const p = (request.payload.params as [{ address: string; chainId: string; nonce: string }])[0]!;
    return [
      { label: 'method', value: 'sign 7702 authorization' },
      { label: 'delegate', value: p.address, mono: true },
      { label: 'chainId', value: String(parseInt(p.chainId, 16)) },
      { label: 'nonce', value: String(parseInt(p.nonce, 16)) },
    ];
  }

  if (method === 'eth_sendTransaction') {
    // `to` is optional (contract deploys omit it). Native + ERC-20 / WETH
    // branches assume it; the unknown-calldata branch handles both shapes.
    const p = (request.payload.params as [{
      to?: string; value?: string; data?: string; authorizationList?: unknown[];
    }])[0]!;
    // Sourcify override (contract-specific ABI) wins over the bundled
    // local table when present — it has the actual function name and
    // arg names from the verified source. Renderer is agnostic to
    // which source the decode came from.
    const decoded = decodedOverride ?? decodeTxData(p.data);
    const rows: Row[] = [];

    // Normalize deploy: dapps split between omitting `to` entirely and
    // explicitly sending zero address. Default missing `to` to 0x0…0 so
    // every code path sees a string and the user always gets the same
    // `to / value / function` triple — no empty-row glitch.
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    const toAddr = p.to ?? ZERO_ADDR;

    if (decoded.kind === 'native') {
      // No "kind: native transfer" label — the SignHead subtitle ("SEND
      // TRANSACTION") already says it, and to+value rows make the shape
      // self-evident.
      rows.push({ label: 'to', value: toAddr, mono: true });
      rows.push({ label: 'value', value: `${formatWeiHex(p.value)} ETH` });
    } else if (decoded.kind === 'known') {
      const args = decoded.args;
      rows.push({ label: 'fn', value: decoded.name });
      // Enrich `token:` with the symbol when we have it cached, and
      // attach an explorer href so the user can jump to Etherscan /
      // Sourcify-lookup for the contract. The link reuses the same
      // pattern as the 7702 `delegate:` row.
      rows.push({
        label: 'token',
        value: formatTokenContract(toAddr, tokenInfo),
        mono: true,
        href: chainId !== null ? explorerAddressUrl(chainId, toAddr) : undefined,
      });
      if (decoded.name === 'transfer' && args.length >= 2) {
        rows.push({ label: 'to', value: String(args[0]), mono: true });
        rows.push({ label: 'amount', value: formatTokenAmount(String(args[1]), p.to, tokenInfo) });
      } else if (decoded.name === 'approve' && args.length >= 2) {
        rows.push({ label: 'spender', value: String(args[0]), mono: true });
        rows.push({ label: 'amount', value: formatTokenAmount(String(args[1]), p.to, tokenInfo) });
      } else if (decoded.name === 'transferFrom' && args.length >= 3) {
        rows.push({ label: 'from', value: String(args[0]), mono: true });
        rows.push({ label: 'to', value: String(args[1]), mono: true });
        rows.push({ label: 'amount', value: formatTokenAmount(String(args[2]), p.to, tokenInfo) });
      } else if (decoded.name === 'deposit') {
        rows.push({ label: 'value', value: `${formatWeiHex(p.value)} ETH (wrap)` });
      } else if (decoded.name === 'withdraw' && args.length >= 1) {
        rows.push({ label: 'amount', value: formatTokenAmount(String(args[0]), p.to, tokenInfo) });
      }
      if (p.value && p.value !== '0x0' && decoded.name !== 'deposit') {
        rows.push({ label: 'value', value: `${formatWeiHex(p.value)} ETH` });
      }
    } else {
      // Unknown calldata to a real address.
      rows.push({ label: 'to', value: toAddr, mono: true });
      rows.push({ label: 'value', value: `${formatWeiHex(p.value)} ETH` });
      rows.push({ label: 'function', value: `${decoded.selector} (${decoded.bytes} bytes)`, mono: true });
    }
    if (p.authorizationList?.length) {
      rows.push({ label: '7702 auth list', value: `${p.authorizationList.length} entries` });
    }
    return rows;
  }

  if (method === 'wallet_addEthereumChain') {
    const p = (request.payload.params as [{
      chainId: string; chainName: string; rpcUrls: string[];
    }])[0]!;
    return [
      { label: 'method', value: 'add custom chain' },
      { label: 'name', value: p.chainName },
      { label: 'chainId', value: String(parseInt(p.chainId, 16)) },
      { label: 'rpc', value: p.rpcUrls?.[0] ?? '—', mono: true },
    ];
  }

  if (method === 'personal_sign') {
    const params = request.payload.params as [string, string];
    let preview = params[0] ?? '';
    if (typeof preview === 'string' && preview.startsWith('0x')) {
      // Try to decode as utf-8 hex.
      try {
        const bytes = preview.slice(2).match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) ?? [];
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
        preview = decoded;
      } catch {
        /* keep hex */
      }
    }
    return [
      { label: 'method', value: 'sign message (EIP-191)' },
      { label: 'message', value: preview.slice(0, 240) + (preview.length > 240 ? '…' : ''), mono: true },
    ];
  }

  if (
    method === 'eth_signTypedData' ||
    method === 'eth_signTypedData_v1' ||
    method === 'eth_signTypedData_v4'
  ) {
    const { data } = unpackTypedDataParams(request.payload.params);
    const td = parseTyped(data);
    if (!td) {
      // v1 legacy form: typed data is a flat array of {name, type, value}.
      // Render those directly so the user sees what they're signing instead
      // of a useless "unparseable" line.
      if (Array.isArray(data)) {
        return [
          { label: 'method', value: `sign typed data (v1 legacy)` },
          ...(data as { name?: string; type?: string; value?: unknown }[]).slice(0, 8).map((f) => ({
            label: String(f.name ?? '?'),
            value: `${String(f.value ?? '')}${f.type ? `  :${f.type}` : ''}`,
            mono: true,
          })),
        ];
      }
      return [{ label: 'method', value: method }, { label: 'params', value: 'unparseable' }];
    }
    const rows: Row[] = [
      { label: 'method', value: `sign typed data (${td.primaryType})` },
    ];
    const domain = td.domain;
    if (domain) {
      if (domain.name) rows.push({ label: 'domain', value: String(domain.name) });
      if (domain.chainId !== undefined) rows.push({ label: 'chainId', value: String(domain.chainId) });
      if (domain.verifyingContract) {
        rows.push({ label: 'contract', value: String(domain.verifyingContract), mono: true });
      }
    }
    const rawTypes = getRawTypes(data);
    // EIP-2612 Permit — only render Permit-flavored rows when the struct
    // shape is canonical. A custom "Permit" with reordered/renamed fields
    // falls through to generic JSON render so the user sees the truth.
    if (td.primaryType === 'Permit' && isStandardERC2612Permit(rawTypes)) {
      const m = td.message as { owner?: string; spender?: string; value?: string; deadline?: string; nonce?: string };
      const tokenAddr = (domain as { verifyingContract?: string } | undefined)?.verifyingContract;
      if (m.owner)    rows.push({ label: 'owner',    value: String(m.owner),   mono: true });
      if (m.spender)  rows.push({ label: 'spender',  value: String(m.spender), mono: true });
      if (m.value !== undefined) {
        rows.push({ label: 'amount', value: formatTokenAmount(m.value, tokenAddr, tokenInfo) });
      }
      if (m.deadline) rows.push({ label: 'deadline', value: humanDeadline(m.deadline) });
    }
    // Permit2 single / batch
    else if (
      (td.primaryType === 'PermitSingle' && isStandardPermit2Single(rawTypes)) ||
      (td.primaryType === 'PermitBatch'  && isStandardPermit2Batch(rawTypes))
    ) {
      const m = td.message as { spender?: string; details?: unknown; sigDeadline?: string };
      if (m.spender)     rows.push({ label: 'spender',     value: String(m.spender), mono: true });
      if (m.sigDeadline) rows.push({ label: 'sig deadline', value: humanDeadline(m.sigDeadline) });
      const details = Array.isArray(m.details)
        ? m.details
        : m.details
          ? [m.details]
          : [];
      details.slice(0, 4).forEach((d, i) => {
        const dd = d as { token?: string; amount?: string; expiration?: string };
        if (dd.token)  rows.push({ label: `token #${i + 1}`,  value: String(dd.token), mono: true });
        if (dd.amount) {
          rows.push({ label: `amount #${i + 1}`, value: formatTokenAmount(dd.amount, dd.token, tokenInfo) });
        }
      });
    }
    // Generic fallback — show truncated JSON of message
    else {
      const j = JSON.stringify(td.message);
      rows.push({ label: 'message', value: j.length > 200 ? j.slice(0, 200) + '…' : j, mono: true });
    }
    return rows;
  }

  return [
    { label: 'method', value: method },
    { label: 'params', value: JSON.stringify(request.payload.params).slice(0, 200), mono: true },
  ];
}

export function SignConfirm({
  request, address, onResolved,
}: { request: PendingRequest; address: Address; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  // Approve-mode override: ApproveBody bubbles up replacement calldata when
  // the user flips capped ↔ max. Stays null for every other mode → background
  // signs the dapp's original tx unchanged.
  const [txOverride, setTxOverride] = useState<`0x${string}` | null>(null);
  const showToast = useToast();

  async function approve() {
    setBusy(true);
    try {
      await send({
        kind: 'approve-pending-request',
        id: request.id,
        password: '',
        txOverride: txOverride ? { data: txOverride } : undefined,
      });
      onResolved();
    } catch (e) {
      showToast({ tone: 'red', icon: '💥', text: e instanceof Error ? e.message : String(e) });
    } finally {
      // Always clear busy. If onResolved unmounted the component, React drops
      // the update silently. If it re-rendered the same SignConfirm with a
      // different request (only possible without the key= prop, but defensive),
      // busy resets so buttons aren't stuck disabled.
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    try {
      // Reject only the request currently shown. Connect-style fan-outs
      // (wagmi calls wallet_requestPermissions + eth_requestAccounts +
      // eth_accounts in parallel) collapse into a single pending entry via
      // COALESCE_METHODS, so this one rejection answers all the parallel
      // resolvers at once. For independent stacked sign/send requests, the
      // user gets to decide each one — rejecting an approve shouldn't
      // also kill the swap tx queued behind it.
      await send({ kind: 'reject-pending-request', id: request.id });
      onResolved();
    } catch (e) {
      showToast({ tone: 'red', icon: '💥', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Connect-style screen for `eth_requestAccounts`. Different intent (grant
  // origin permission, not sign anything), so it deserves its own UI rather
  // than the generic sign-confirm summary.
  if (request.payload.method === 'eth_requestAccounts') {
    return (
      <ConnectConfirm
        origin={request.origin}
        address={address}
        busy={busy}
        onApprove={approve}
        onReject={reject}
      />
    );
  }

  return (
    <SignConfirmBody
      request={request}
      address={address}
      busy={busy}
      onApprove={approve}
      onReject={reject}
      setTxOverride={setTxOverride}
    />
  );
}

/** Black-strip header used by every sign-confirm mode. Site favicon (with
 *  Google s2 fallback) + URL + "requesting signature" subtitle + a
 *  mode-specific stamp on the right (LOW RISK / CHECK CAREFULLY / etc.). */
/** Derive the action label that goes under the host in `SignHead`. For
 *  typed data we surface the primaryType (`sign Order`, `sign Mail`,
 *  `sign Permit`) so the user immediately sees what kind of message the
 *  dapp is asking for. Other methods fall back to a method-friendly verb. */
function SignHead({
  origin, stamp, subtitle,
}: {
  origin: string;
  stamp: { text: string; tone: StampTone };
  subtitle?: string;
}) {
  const host = origin.replace(/^https?:\/\//, '');
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: origin + '/*' });
        const tab = tabs.find((t) => !!t.favIconUrl);
        setFaviconUrl(
          tab?.favIconUrl ??
            `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`,
        );
      } catch {
        setFaviconUrl(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`);
      }
    })();
  }, [origin, host]);

  return (
    <div className="aw-sign-head">
      {faviconUrl ? (
        <img
          src={faviconUrl}
          alt=""
          className="ico"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
      ) : (
        <span className="ico">🌐</span>
      )}
      <div className="meta">
        <div className="host">{host}</div>
        <div className="sub">{subtitle ?? 'requesting signature'}</div>
      </div>
      <span className={'aw-sign-stamp tone-' + stamp.tone}>{stamp.text}</span>
    </div>
  );
}

/** Drag-the-thumb-to-the-end gesture, used as the unlock for high-risk CTAs
 *  in mode E (7702). Fires `onComplete` once the thumb crosses 90% — caller
 *  is expected to enable the actual approve button afterwards. */
function SlideToConfirm({
  hint, label, onComplete, disabled,
}: {
  hint: string;
  label: string;
  onComplete: () => void;
  disabled?: boolean;
}) {
  const [pos, setPos] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const beginDrag = (startX: number) => {
    if (unlocked || disabled) return;
    const track = trackRef.current!;
    const rect = track.getBoundingClientRect();
    const thumbW = 52;
    const max = rect.width - thumbW;
    draggingRef.current = true;
    let lastP = pos;
    const move = (clientX: number) => {
      const rel = clientX - rect.left - thumbW / 2;
      const p = Math.max(0, Math.min(1, rel / max));
      lastP = p;
      setPos(p);
    };
    const onMove = (e: PointerEvent) => move(e.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      draggingRef.current = false;
      if (lastP >= 0.92) {
        setPos(1);
        setUnlocked(true);
        onComplete();
      } else {
        setPos(0);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    move(startX);
  };

  return (
    <>
      {hint && <div className="aw-slide-hint">{hint}</div>}
      <div
        ref={trackRef}
        className={'aw-slide-track' + (unlocked ? ' is-unlocked' : '')}
      >
        <span className="label">{unlocked ? '✓ unlocked' : label}</span>
        <div
          className="aw-slide-thumb"
          onPointerDown={(e) => beginDrag(e.clientX)}
          style={{
            transform: `translateX(${pos * 100}%)`,
            // wrapping: parent has overflow hidden; use percentage via thumb
            // width relative — actually use direct pixel via ref width
            left: 0,
            transition: draggingRef.current ? 'none' : 'transform 200ms',
          }}
        >→</div>
      </div>
    </>
  );
}

/** Body of the non-connect sign confirm. Pulled out so we can run the
 *  inconsistencies check + manage the "I understand the risk" checkbox
 *  state without crowding the parent. */
function SignConfirmBody({
  request, address, busy, onApprove, onReject, setTxOverride,
}: {
  request: PendingRequest;
  address: Address;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  setTxOverride: (data: `0x${string}` | null) => void;
}) {
  const [chainId, setChainId] = useState<number | null>(null);
  const [ack, setAck] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<Record<string, TokenInfo>>({});
  const [simulationError, setSimulationError] = useState<string | null>(null);
  /** Tri-state simulation outcome shown next to the calldata decode.
   *  'pending' before the SW responds, 'pass' / 'fail' / 'skipped' after.
   *  Existing `simulationError` keeps the revert reason for the
   *  failure banner; this adds the positive-case indicator so the
   *  user sees the sim DID run even when nothing's wrong. */
  const [simulationStatus, setSimulationStatus] = useState<'idle' | 'pending' | 'pass' | 'fail' | 'skipped'>('idle');
  // 7702-only: source verification + dev override. Stays at default
  // ('pending' / false) for every other mode; the body uses it.
  const [gate, setGate] = useState<SevenSevenZeroTwoGate | null>(null);
  // Calldata-decode override. Stays null when the bundled local
  // selector table already decoded the tx; populated by an async SW
  // round-trip to the prefetched Sourcify ABI cache when the local
  // table missed. `SendTxBody` prefers this over its own sync local
  // decode (matched contract ABI gives real arg names / overload
  // disambiguation that the bundled generic table can't).
  const [txDecodeOverride, setTxDecodeOverride] = useState<DecodedTx | null>(null);
  // Task 5.2 — sign-time grant-scope enforcement (defense-in-depth). For an
  // `eth_sendTransaction` we fetch the active grant registry and check whether
  // the call lands on a live SESSION grant's target but outside its recorded
  // selectors/caps (an out-of-scope call the relayer/dapp shouldn't be able to
  // slip through). The check is async (reads the registry), so it can't run in
  // the pure security engine — we compute the violation `reason` here in an
  // effect, hold it in state, and feed it into the engine ctx below. `null` =
  // no violation (in-scope, or the tx doesn't touch any granted target).
  const [grantScopeViolation, setGrantScopeViolation] = useState<string | null>(null);
  // Task 6.2 — AI/MCP-flagged origin intent confirmation. When the requesting
  // origin has been flagged by the user as an AI agent, we build the itemized
  // intent from the raw `eth_sendTransaction` (buildIntentFromTx) and hold it
  // in `aiIntentAction` for the "AI-initiated action" panel, plus a short
  // summary in `aiIntent` that feeds the security engine (fires the `ai-intent`
  // rule → existing ack gate). Both stay null for non-flagged origins and for
  // every non-tx method. Fail-open: any flag-fetch error leaves them null and
  // signing proceeds unhindered.
  const [aiIntent, setAiIntent] = useState<string | null>(null);
  const [aiIntentAction, setAiIntentAction] = useState<IntentAction | null>(null);
  // FIX 1 — async ack-gate race guard (eth_sendTransaction only). The two
  // best-effort checks below (grant-scope + AI-origin) feed `requireAck` via
  // `grantScopeViolation` / `aiIntent`, but both are set inside async SW
  // round-trips — so without this flag the Approve button would be hot on the
  // first render, before those gates have been evaluated, and a fast approve
  // could race past them. `checksPending` holds Approve LOCKED (folded into
  // `canApprove`) until BOTH checks settle. Initialized `true` for an
  // eth_sendTransaction so it's locked from the very first render (before the
  // effect fires); the effect clears it once both resolve (success OR failure —
  // a fetch error still unblocks, never stuck true). Never set for any other
  // mode, so their approve timing is unchanged. Reset naturally by the
  // key={request.id} remount (fresh lazy initializer).
  const [checksPending, setChecksPending] = useState(
    () => request.payload.method === 'eth_sendTransaction',
  );

  useEffect(() => {
    void (async () => {
      try { setChainId(await send<number>({ kind: 'get-current-chain' })); }
      catch { /* keep null — inconsistencies skip chain checks */ }
    })();
    // Token decimals + symbol fetch (Permit family + decoded ERC-20 sends).
    const addrs = collectPermitTokens(request);
    if (addrs.length > 0) {
      void (async () => {
        try {
          const info = await send<Record<string, TokenInfo>>({
            kind: 'read-token-info',
            addresses: addrs,
          });
          setTokenInfo(info);
        } catch { /* keep raw display */ }
      })();
    }
    // 7702-only — read the SW's prefetched verify result. The SW kicks
    // off the Sourcify lookup + eth_getCode the moment a 7702 request
    // enters the pending queue, so by the time the popup mounts the
    // result is usually already cached. `get-7702-verify` returns the
    // resolved cache entry (awaits the in-flight Promise if not yet
    // settled), or kicks off a fresh lookup if the cache evaporated
    // (MV3 SW respawn).
    //
    // The slide-to-confirm gesture below is disabled until either:
    //   - verification returns 'verified' (default safe path), OR
    //   - the dev override flag is on (power-user opt-in via
    //     dev-settings, with two-stage confirmation gate).
    if (request.payload.method === 'wallet_signAuthorization') {
      const p = (request.payload.params as [{ address: string; chainId: string }])[0];
      if (p?.address && p?.chainId) {
        const targetAddr = p.address;
        const targetChain = parseInt(p.chainId, 16);

        // Zero-address fast path: EIP-7702 spec uses delegation to
        // the zero address as the way to CLEAR a previous delegation.
        // Not a security gate situation — let it through without
        // Sourcify / getCode. (Sourcify would 404 it anyway, but
        // showing red BLOCKED for a legitimate revoke is misleading.)
        if (/^0x0+$/.test(targetAddr)) {
          setGate({ verification: 'revoke', allowOverride: false });
        } else if (chainId !== null && targetChain !== chainId) {
          // Chain-mismatch fast path: the auth claims a chainId that
          // doesn't match the wallet's active chain. Short-circuit
          // BEFORE Sourcify — a delegate's source on chain A is
          // irrelevant when we're signing for chain B. Hard-blocked;
          // the dev override does not bypass (overriding a wrong-
          // chain signature is meaningless, not just dangerous).
          setGate({ verification: 'chain-mismatch', allowOverride: false });
        } else {
          setGate({ verification: 'pending', allowOverride: false });
          void (async () => {
            type CacheEntry = {
              verify: { status: 'verified' | 'unverified' | 'error'; match?: 'exact_match' | 'match'; verifiedAt?: string };
              code: string | null;
            };
            const [cached, flags] = await Promise.all([
              send<CacheEntry | null>({ kind: 'get-7702-verify', chainId: targetChain, address: targetAddr })
                .catch(() => null),
              send<{ allowUnverifiedDelegate?: boolean }>({ kind: 'get-dev-flags' })
                .catch(() => ({} as { allowUnverifiedDelegate?: boolean })),
            ]);
            // SW cache miss is exceedingly rare (would mean the SW
            // crashed between queueing the request and the popup
            // mounting). Defensive fallback runs Sourcify/getCode in
            // the popup itself so the gate still resolves.
            let verify: { status: 'verified' | 'unverified' | 'error'; match?: 'exact_match' | 'match'; verifiedAt?: string };
            let code: string | null;
            if (cached) {
              verify = cached.verify;
              code = cached.code;
            } else {
              const [v, c] = await Promise.all([
                verifyContract(targetChain, targetAddr),
                send<string | null>({ kind: 'get-code', chainId: targetChain, address: targetAddr })
                  .catch(() => null),
              ]);
              verify = v;
              code = c;
            }
            // no-code beats everything else: a delegate without
            // bytecode bricks the EOA, which is worse than
            // "unverified". '0x' or '0x0' both mean empty.
            const hasNoCode = code === '0x' || code === '0x0';
            setGate({
              verification: hasNoCode ? 'no-code' : verify.status,
              match: verify.match,
              verifiedAt: verify.verifiedAt,
              allowOverride: !!flags.allowUnverifiedDelegate,
            });
          })();
        }
      }
    }
    // Pre-flight simulation for `eth_sendTransaction` — `eth_call` the same
    // tx and surface any guaranteed revert. Static call, no gas charged.
    if (request.payload.method === 'eth_sendTransaction') {
      const p = (request.payload.params as [{
        to?: string; data?: string; value?: string;
      }])[0];
      if (p?.to) {
        setSimulationStatus('pending');
        void (async () => {
          try {
            const result = await send<{ ok: boolean; error?: string } | null>({
              kind: 'simulate-tx',
              tx: {
                from: address,
                to: p.to as `0x${string}`,
                data: p.data as `0x${string}` | undefined,
                value: p.value as `0x${string}` | undefined,
              },
            });
            if (!result) {
              setSimulationStatus('skipped');
            } else if (!result.ok) {
              setSimulationStatus('fail');
              if (result.error) setSimulationError(result.error);
            } else {
              setSimulationStatus('pass');
            }
          } catch {
            setSimulationStatus('skipped');
          }
        })();
      } else {
        setSimulationStatus('skipped');
      }
      // FIX 1 — lock Approve until BOTH async checks below (grant-scope +
      // AI-origin) have resolved. Set the flag true as the checks kick off and
      // clear it only once both have settled (via clearChecksIfDone). Each
      // check flips its own `*Checked` flag in a `finally` so an error path
      // still unblocks — Approve is never permanently stuck locked.
      setChecksPending(true);
      let grantChecked = false;
      let aiChecked = false;
      const clearChecksIfDone = () => {
        if (grantChecked && aiChecked) setChecksPending(false);
      };
      // Task 5.2 — sign-time grant-scope enforcement (defense-in-depth).
      // Fetch the active grant registry for the (chain, account) bucket and
      // check whether THIS tx calls a live session grant's target outside the
      // recorded selectors/caps. A violation's `reason` is stashed in state and
      // fed into the security engine below, which surfaces it via the existing
      // danger banner + ack gate. Fail-open on any error: a `list-grants`
      // hiccup must never block signing — it only means we skip this extra,
      // best-effort check (the primary decoder + simulation defenses still run).
      if (p?.to) {
        void (async () => {
          try {
            const cid = await send<number>({ kind: 'get-current-chain' });
            const grants = await send<GrantRecord[]>({
              kind: 'list-grants',
              chainId: cid,
              account: address,
            });
            const violation = evaluateTxAgainstGrants(
              {
                to: p.to as string,
                data: (p.data ?? '0x') as `0x${string}`,
                value: p.value ? BigInt(p.value) : 0n,
              },
              grants,
              Math.floor(Date.now() / 1000),
            );
            setGrantScopeViolation(violation?.reason ?? null);
          } catch {
            // Non-fatal: leave grantScopeViolation as-is (null) and let the
            // rest of the sign flow proceed unhindered.
          } finally {
            grantChecked = true;
            clearChecksIfDone();
          }
        })();
      } else {
        // No `to` (contract deploy) → grant-scope check doesn't run; count it
        // as done so the AI-origin check alone can clear the flag.
        grantChecked = true;
      }
      // Task 6.2 — AI/MCP-flagged origin intent confirmation. If the user has
      // flagged THIS origin as an AI agent, treat the request as
      // attacker-influenced (the AI chat is untrusted): build the itemized
      // intent from the raw tx and (a) surface it in the AI-initiated action
      // panel, (b) feed a short summary into the security engine so the
      // `ai-intent` rule fires and the existing ack gate blocks a blind
      // approve. Fail-open on ANY error (flag fetch, chain read, address
      // parse): a hiccup here must never block signing — it only means we skip
      // this extra, best-effort confirmation. Never auto-approves/rejects.
      void (async () => {
        try {
          const aiOrigins = await send<string[]>({ kind: 'list-ai-origins' });
          if (!aiOrigins.includes(request.origin)) return;
          const cid = await send<number>({ kind: 'get-current-chain' });
          const ZERO = '0x0000000000000000000000000000000000000000';
          const action = buildIntentFromTx(
            {
              to: (p.to ?? ZERO) as string,
              data: (p.data ?? '0x') as `0x${string}`,
              value: p.value ? BigInt(p.value) : 0n,
            },
            cid,
            '0',
            0,
          );
          setAiIntentAction(action);
          setAiIntent(
            `${action.functionName} → ${truncateAddr(action.target)}` +
              (action.valueWei !== '0' ? ` · ${formatWeiHex(action.valueWei)} ETH` : ''),
          );
        } catch {
          // Fail-open — no AI intent gate on this request.
        } finally {
          // FIX 1 — mark the AI-origin check done (runs on the success, early-
          // return, and error paths alike) so Approve can unlock.
          aiChecked = true;
          clearChecksIfDone();
        }
      })();
      // Sourcify ABI fallback decode — only when the bundled local
      // selector table didn't recognise this tx's calldata. The SW
      // already prefetched the destination contract's ABI when the
      // request entered the queue (see prefetchContractAbi in
      // background.ts), so this is usually a cache-hit round-trip.
      if (p?.to && /^0x[0-9a-fA-F]{40}$/.test(p.to)) {
        const localDecoded = decodeTxData(p.data);
        if (localDecoded.kind === 'unknown') {
          void (async () => {
            try {
              // Use the popup's current chainId so the lookup matches
              // what the user actually sees on screen (the SW prefetch
              // used the active chain at queue time, which is almost
              // always the same).
              const cid = await send<number>({ kind: 'get-current-chain' });
              const abi = await send<Abi | null>({
                kind: 'get-contract-abi',
                chainId: cid,
                address: p.to as string,
              });
              if (!abi) return;
              const decoded = decodeTxDataWithAbi(p.data, abi);
              if (decoded.kind === 'known') setTxDecodeOverride(decoded);
            } catch { /* fallback display stays as raw selector */ }
          })();
        }
      }
    }
  }, [request, address]);

  // `danger` is the legacy "highest primary signal" — drives the ack
  // checkbox gate. Computed independently so the requireAck path
  // stays stable while the visual rendering moves to the SecurityChecks
  // panel below.
  const danger = isDangerous(request);
  // Full engine signals — the SecurityChecks panel renders every one
  // (primary banner + warning chips + any future positive items).
  // chainId-dependent checks (signer / chain mismatch) need
  // chainId !== null; before that resolves, we pass an empty array
  // so the panel renders nothing instead of a misleading "no chain"
  // mismatch chip.
  // useMemo here matters — runEngine + every rule's evaluate() walks
  // the typed-data tree, decodes calldata, etc. Without the memo it
  // re-runs on every render (busy flip, ack toggle, sim status, child
  // state change). Keying on request.id + address + chainId catches
  // the only inputs the engine actually reads.
  const signals = useMemo(
    () =>
      chainId !== null
        ? runEngine(request, {
            address,
            chainId,
            grantScopeViolation: grantScopeViolation ?? undefined,
            aiIntent: aiIntent ?? undefined,
          })
        : [],
    [request, address, chainId, grantScopeViolation, aiIntent],
  );

  // `wallet_grantPermissions` (ERC-7715) is NOT one of deriveSignMode's
  // methods — it would throw. It reaches this screen via the popup's
  // route-any-pending path (popup.tsx), carrying a serialized scope on
  // `request.grantScope`. Give it a dedicated pseudo-mode so it flows
  // through the same SignHead + body + approve/reject shell as every
  // other mode, without touching deriveSignMode (which stays the sole
  // classifier for the signing methods).
  const isGrant = request.payload.method === 'wallet_grantPermissions';
  const modeInfo = isGrant
    ? ({ mode: 'grant', stampText: 'Scoped permission', stampTone: 'warn' } as const)
    : deriveSignMode(request);
  const { mode } = modeInfo;

  // raw + 7702 + unlimited-Permit + SafeTx-DELEGATECALL all need an explicit
  // unlock gesture before the approve button is hot. 7702 uses the
  // slide-to-confirm; high-danger typed (unlimited Permit / SafeTx
  // delegatecall) uses the ack checkbox.
  const [unlocked7702, setUnlocked7702] = useState(false);
  // ApproveBody flips this to true when the user is in 'capped' mode
  // but the custom-amount input is empty — there's no defensible
  // amount to broadcast yet, so we lock the approve button until they
  // type something (or switch to 'max').
  const [approveBlocked, setApproveBlocked] = useState(false);
  // `danger` (from isDangerous) runs the engine with a dummy ctx and so can't
  // see the async grant-scope violation; OR it in explicitly so an out-of-scope
  // eth_sendTransaction forces the same "I understand" ack gate. Purely
  // additive — grantScopeViolation is only ever set for eth_sendTransaction
  // (never mode '7702'), so existing danger handling is untouched.
  // `aiIntent` is OR'd in for the same reason as `grantScopeViolation`: the
  // `danger` shim runs the engine with a dummy ctx and can't see the async
  // AI-origin flag, so an AI-flagged eth_sendTransaction wouldn't otherwise
  // trip the ack gate. Purely additive — aiIntent is only ever set for an
  // eth_sendTransaction (never mode '7702').
  const requireAck =
    (danger?.level === 'high' || grantScopeViolation !== null || aiIntent !== null) &&
    mode !== '7702';
  // `!checksPending` (FIX 1) keeps Approve locked until the async grant-scope +
  // AI-origin checks resolve. It's only ever true for an eth_sendTransaction, so
  // this leaves every other mode's approve timing (7702, grant, personal_sign,
  // typed, connect, addchain, watchAsset) exactly as before.
  const canApprove = !busy && !approveBlocked && !checksPending && (mode === '7702' ? unlocked7702 : (!requireAck || ack));

  // sendtx / addchain reuse the generic decoded-kv layout — the rest get
  // hand-tailored bodies that visually match the screenshot for that mode.
  const renderBody = () => {
    switch (mode) {
      case 'message':    return <MessageBody    request={request} address={address} />;
      case 'typed':      return <TypedBody      request={request} address={address} tokenInfo={tokenInfo} />;
      case 'approve':    return <ApproveBody    request={request} address={address} chainId={chainId} tokenInfo={tokenInfo} simulationError={simulationError} onOverride={setTxOverride} onApproveBlocked={setApproveBlocked} />;
      case 'sendtx':     return <SendTxBody     request={request} address={address} chainId={chainId} tokenInfo={tokenInfo} simulationError={simulationError} decodedOverride={txDecodeOverride} />;
      case 'addchain':   return <AddChainBody   request={request} />;
      case 'watchAsset': return <WatchAssetBody request={request} />;
      case '7702':       return <SevenSevenZeroTwoBody request={request} address={address} chainId={chainId} gate={gate} />;
      case 'grant':      return <GrantBody      request={request} address={address} />;
    }
  };

  // CTA labels per mode. 7702 swaps in the slide-to-confirm + a red "delegate"
  // CTA; the rest are normal sign / approve / send.
  let approveLabel: string;
  let approveClass = 'aw-btn';
  let cancelLabel = 'reject';
  if (busy) {
    approveLabel = '…';
  } else {
    switch (mode) {
      case 'message':    approveLabel = 'sign';                                              break;
      case 'typed':      approveLabel = requireAck ? 'sign (DANGEROUS)'    : 'sign';         break;
      case 'approve':    approveLabel = 'approve';                                           break;
      case 'sendtx':     approveLabel = 'send it';                                           break;
      case 'addchain':   approveLabel = 'add chain';        cancelLabel = 'cancel';          break;
      case 'watchAsset': {
        // EIP-747 covers ERC-20, ERC-721, ERC-1155 — CTA copy follows.
        const raw = request.payload.params as unknown;
        const wp = (Array.isArray(raw) ? (raw as unknown[])[0] : raw) as { type?: string };
        approveLabel = (wp?.type === 'ERC721' || wp?.type === 'ERC1155') ? 'add NFT' : 'add token';
        cancelLabel = 'cancel';
        break;
      }
      case '7702':       approveLabel = 'Delegate & sign'; approveClass = 'aw-btn'; break;
      case 'grant':      approveLabel = 'grant permission';                                       break;
    }
  }
  if (busy) {
    approveLabel = mode === 'addchain' || mode === 'watchAsset'
      ? 'adding…'
      : mode === 'sendtx'
        ? 'sending…'
        : mode === 'grant'
          ? 'granting…'
          : 'signing…';
  }

  // 7702 hides its own primary CTA inside the slide track. Once the user
  // crosses 92% the slide goes green and the real "DELEGATE" button below
  // wakes up — two-step gesture per chrome.md §5.1.
  return (
    <>
      <SignHead
        origin={request.origin}
        stamp={{ text: modeInfo.stampText, tone: modeInfo.stampTone }}
        subtitle={signActionLabel(request)}
      />

      {/* Unified security-checks panel. Renders every signal the
         engine emitted (primary danger banner, signer / chain
         mismatch chips). Bodies don't render danger/warning alerts
         inline — single source of truth means deduplicated visuals
         and one place to update when a new rule lands. */}
      <SecurityChecks signals={signals} />

      {/* Task 6.2 — AI-initiated action panel. Only rendered when the origin
          was flagged as an AI agent (aiIntentAction set). Shows the itemized
          intent (target / function / args / value) the AI is asking the wallet
          to perform, so the user can confirm it matches what they asked for
          before ticking the ack box. This is the ONLY new gating surface; the
          block itself is enforced by the existing ack checkbox below (driven by
          the `ai-intent` security rule via requireAck). */}
      {aiIntentAction && (
        <div
          style={{
            border: '2px solid var(--ink)',
            background: 'var(--aw-gold)',
            margin: '10px 0',
            padding: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            🤖 AI-initiated action — review the intent
          </div>
          {([
            ['target', aiIntentAction.target],
            ['function', aiIntentAction.functionName],
            ['args', aiIntentAction.args.length ? aiIntentAction.args.join(', ') : '—'],
            [
              'value',
              aiIntentAction.valueWei !== '0'
                ? `${formatWeiHex(aiIntentAction.valueWei)} ETH`
                : '0',
            ],
          ] as const).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ minWidth: 62, opacity: 0.7 }}>{k}</span>
              <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, opacity: 0.8 }}>
            this request came from an AI agent origin. confirm it matches what you asked for.
          </div>
        </div>
      )}

      {/* Signer is rendered as the first row INSIDE each mode's action-card
         body (see SignerLine). That way "who's signing" is visually anchored
         to the action-card it applies to, not floating in its own card. */}
      {renderBody()}

      {/* Pre-flight simulation status — small pill so the user knows
          the wallet actually ran a static-call sim before letting them
          sign. 'pass' = success path, no revert; 'fail' is paired with
          the detailed revert banner inside each body; 'skipped' covers
          sign-only ops (no calldata to simulate). */}
      {(simulationStatus === 'pending' || simulationStatus === 'pass') && (
        <div className={`aw-sim-pill is-${simulationStatus}`}>
          {simulationStatus === 'pending' ? '⏳ simulating tx…' : '✓ simulation passed — no revert'}
        </div>
      )}

      {requireAck && (
        <label className="aw-ack-row">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={busy}
          />
          <span>i understand this is dangerous.</span>
        </label>
      )}

      {mode === '7702' && (() => {
        const slide = decideSeven702Gate(gate);
        return (
          <SlideToConfirm
            hint={slide.hint}
            label={slide.label}
            onComplete={() => setUnlocked7702(true)}
            disabled={busy || !slide.slideOpen}
          />
        );
      })()}

      <div className="aw-btn-row">
        <button className="aw-btn aw-btn-ghost" onClick={onReject} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          className={canApprove ? approveClass : approveClass + ' aw-cta-locked'}
          onClick={onApprove}
          disabled={!canApprove}
          style={{ flex: 1 }}
        >
          {approveLabel}
        </button>
      </div>
    </>
  );
}

// ─── Mode-specific bodies ───────────────────────────────────────────────
// Each mode renders a hand-tailored body inside the parent SignConfirmBody.
// They share state (chainId, tokenInfo, ack, simulation) via props so the
// parent owns the network calls and the children stay pure-render.

/** First-row signer line shared by every sign-confirm body. Sits inside
 *  the action-card body just below the yellow `<h4>` strip, with a dashed
 *  divider below — visually anchoring "who's signing" to the action-card
 *  itself instead of floating in its own card above. */
function SignerLine({ address }: { address: Address }) {
  return (
    <>
      <div className="aw-signer-line">
        <span className="cap">signing as</span>
        <span className="addr">{address}</span>
      </div>
      <div className="aw-row-dashed" />
    </>
  );
}

function MessageBody({ request, address }: { request: PendingRequest; address: Address }) {
  const params = request.payload.params as [string, string];
  let preview = params?.[0] ?? '';
  // EIP-191 spec wraps the message in personal_sign's prefix — most dapps
  // pass utf-8 directly but some (SIWE included) hex-encode. Decode hex into
  // text when valid utf-8, otherwise show the raw hex.
  if (typeof preview === 'string' && preview.startsWith('0x')) {
    try {
      const bytes = preview.slice(2).match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) ?? [];
      preview = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch { /* keep hex */ }
  }

  return (
    <div className="aw-action-card">
      <h4>sign message</h4>
      <div className="body">
        <SignerLine address={address} />
        <div className="aw-typed-msg">
          <div className="head">message (EIP-191)</div>
          {/* No truncation — signing pages must show every byte the user is
             being asked to sign. SIWE messages run 300–600 chars (over our
             old 320 cap), and "show full message" was a security smell. */}
          <div style={{
            padding: 10,
            fontFamily: 'var(--font-mono)', fontSize: 11,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {preview}
          </div>
        </div>
        <div className="aw-tip-strip">
          <span className="ico">✦</span>
          <span>signing a message — no funds will move.</span>
        </div>
      </div>
    </div>
  );
}

function TypedBody({
  request, address, tokenInfo,
}: {
  request: PendingRequest;
  address: Address;
  tokenInfo: Record<string, TokenInfo>;
}) {
  const sem = decodeSemantics(request, tokenInfo);

  const renderSemRow = (
    label: string,
    row: SemRow & { display?: string },
  ) => {
    const empty = !row.display && !row.name && !row.addr;
    return (
      <div className="aw-semrow" key={label}>
        <div className="k">{label}</div>
        <div className="v">
          {empty ? <span className="dash">—</span> : (
            // Name + contract addr in one flex-wrap row. No copy button —
            // user can select-and-copy the text directly; address selection
            // works fine in the popup.
            <div className="lead">
              {(row.display || row.name) && <span className="name">{row.display ?? row.name}</span>}
              {row.addr && <span className="addr">{row.addr}</span>}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="aw-action-card">
      <h4>sign {sem.title.toLowerCase()}</h4>
      <div className="body">
        <SignerLine address={address} />
        {sem.unknown && (
          <div className="aw-alert aw-alert-danger">
            ⚠ unknown signature shape — wallet can't decode safely
          </div>
        )}

        {/* Inline danger banner + warning chips moved to the parent's
            <SecurityChecks/> panel (single source of truth). The
            `sem.unknown` "can't decode signature shape" warning above
            stays inline because it's about the renderer, not engine
            risk. */}

        {renderSemRow('who',  sem.who)}
        {renderSemRow('to',   sem.to)}
        {renderSemRow('what', sem.what)}

        <div className="aw-semrow">
          <div className="k">amount</div>
          <div className="v">
            {sem.amount
              ? <span className="aw-amount-pill">{sem.amount.display}</span>
              : <span className="dash">—</span>}
          </div>
        </div>

        <div className="aw-semrow">
          <div className="k">when</div>
          <div className="v">
            {sem.when ? (
              <div className="lead">
                <span className="name">{sem.when.display}</span>
                <span className="addr">{sem.when.sub}</span>
              </div>
            ) : <span className="dash">—</span>}
          </div>
        </div>

        <div className="aw-row-dashed" />

        <div className="aw-domain-pill">
          {sem.domain.name}
          {sem.domain.chainId !== undefined && <span className="chain"> · chain {sem.domain.chainId}</span>}
        </div>

        {sem.raw && (
          <details className="aw-rawdata" open={sem.unknown}>
            <summary>
              <span className="caret">▶</span>
              <span className="lbl">raw data</span>
              <span className="meta">
                {Object.keys(sem.raw.types ?? {}).length} types · {sem.raw.primaryType}
              </span>
            </summary>
            <pre>{JSON.stringify(sem.raw, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function ApproveBody({
  request, address, chainId, tokenInfo, simulationError, onOverride, onApproveBlocked,
}: {
  request: PendingRequest;
  address: Address;
  chainId: number | null;
  tokenInfo: Record<string, TokenInfo>;
  simulationError: string | null;
  /** Bubble override calldata up to SignConfirm. null = leave dapp's
   *  original tx untouched; bytes = swap in this calldata before signing. */
  onOverride: (data: `0x${string}` | null) => void;
  /** Tell SignConfirm to lock the Approve button. Used when the user
   *  has picked 'capped' but left the custom-amount field empty —
   *  there's no defensible bytes to broadcast yet. */
  onApproveBlocked: (blocked: boolean) => void;
}) {
  // ApproveBody only handles ERC-20 `approve`. setApprovalForAll (NFT) is
  // not decoded today — those go through generic SendTxBody until proper
  // NFT support lands.
  const p = (request.payload.params as [{ to: string; data?: string; value?: string }])[0];
  const decoded = decodeTxData(p.data);
  const args = decoded.kind === 'known' ? decoded.args : [];
  const spender = String(args[0] ?? '');
  const tokenAddr = p.to.toLowerCase();
  const meta = tokenInfo[tokenAddr];

  const UINT256_MAX = (1n << 256n) - 1n;
  const askedAmount: bigint = (() => {
    try { return BigInt(String(args[1] ?? '0')); }
    catch { return 0n; }
  })();
  const askedIsMax = isInfinityAllowance(askedAmount);

  // Local choice — capped expands an input where the user types any amount
  // they're willing to grant; max snaps to uint256.max. Default to max when
  // the dapp already asked for max (so the toggle reflects current state),
  // otherwise capped (prefilled with dapp's amount = effectively "as asked"
  // until the user edits it).
  const [choice, setChoice] = useState<'capped' | 'max'>(askedIsMax ? 'max' : 'capped');

  // String state for the editable amount — keep it as the user typed so we
  // don't fight their cursor on every keystroke. Parsed lazily into bigint
  // for the override calldata.
  const formatBig = (v: bigint): string => {
    if (!meta) return v.toString();
    const n = Number(v) / 10 ** meta.decimals;
    if (!Number.isFinite(n)) return v.toString();
    return n.toLocaleString('en-US', {
      maximumFractionDigits: meta.decimals,
      useGrouping: false,
    });
  };
  const [customStr, setCustomStr] = useState<string>(askedIsMax ? '' : formatBig(askedAmount));

  // Re-prefill the input once meta arrives. The initial render runs before
  // read-token-info comes back, so the first `formatBig(askedAmount)` falls
  // through to the raw bigint string ("1000000000000000000"). When meta
  // arrives, swap to the human-formatted decimal ("1.0") — but ONLY if the
  // user hasn't typed (i.e. customStr still equals the raw-bigint default
  // or is empty for the max case). Skipping that guard would clobber any
  // amount the user manually typed during the meta fetch.
  useEffect(() => {
    if (!meta || askedIsMax) return;
    setCustomStr((cur) => {
      if (cur === '' || cur === askedAmount.toString()) return formatBig(askedAmount);
      return cur;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Parse the typed amount. Empty / unparseable → null (we'll disable the
  // submit downstream so the user doesn't sign garbage). Memoized so a
  // unrelated re-render (busy flip, parent state) doesn't re-run
  // parseUnits — typing in customStr already fires it once per
  // keystroke, no need to multiply.
  const parsedCustom: bigint | null = useMemo(() => {
    if (!meta) return null;
    const trimmed = customStr.trim();
    if (!trimmed) return null;
    try { return parseUnits(trimmed as `${number}`, meta.decimals); }
    catch { return null; }
  }, [meta, customStr]);

  const effectiveAmount = choice === 'max' ? UINT256_MAX : (parsedCustom ?? askedAmount);
  const isMax = isInfinityAllowance(effectiveAmount);

  // Re-encode the approve calldata whenever the effective amount drifts
  // from the dapp's original.
  useEffect(() => {
    if (effectiveAmount === askedAmount) { onOverride(null); return; }
    try {
      const data = encodeFunctionData({
        abi: COMMON_TX_ABI,
        functionName: 'approve',
        args: [spender as `0x${string}`, effectiveAmount],
      });
      onOverride(data);
    } catch { onOverride(null); }
  }, [spender, effectiveAmount, askedAmount]);

  // Format the active amount for the big display. When user is editing,
  // prefer the typed value verbatim — it matches what they see in the input.
  // Tell the parent to disable the Approve button when capped is
  // selected but the custom-amount field is empty. We don't want to
  // silently fall back to the dapp's original (possibly max) amount
  // here — the user clearly intended a cap, just hasn't filled it.
  const capWithoutValue = choice === 'capped' && customStr.trim() === '';
  useEffect(() => {
    onApproveBlocked(capWithoutValue);
    // Reset on unmount so a downstream re-render with a different
    // mode doesn't inherit a stale lock.
    return () => onApproveBlocked(false);
  }, [capWithoutValue, onApproveBlocked]);

  let bigDisplay = '?';
  const symbol = meta?.symbol ?? 'TOKEN';
  if (isMax) {
    bigDisplay = '∞';
  } else if (choice === 'capped' && parsedCustom !== null) {
    bigDisplay = customStr;
  } else if (meta) {
    try {
      const n = Number(effectiveAmount) / 10 ** meta.decimals;
      bigDisplay = Number.isFinite(n) ? compactNumber(n) : effectiveAmount.toString();
    } catch { bigDisplay = effectiveAmount.toString(); }
  } else {
    bigDisplay = effectiveAmount.toString();
  }

  const badge = chainId !== null ? chainBadge(chainId) : null;

  return (
    <div className="aw-action-card">
      <h4>token approval</h4>
      <div className="body">
        <SignerLine address={address} />
        {simulationError && (
          <div className="aw-alert aw-alert-danger">
            💥 simulation says this tx will revert: {simulationError}
          </div>
        )}
        {/* warnings moved to parent's SecurityChecks panel */}

        <div className="aw-approve-display">
          <div className="cap">allowance</div>
          <div className="big">
            {/* Shrink as the number grows so a 13-digit user input doesn't
               blow past the 360px popup width. ∞ alone keeps the full 56px;
               long numbers fall back to mono so digit widths stay even. */}
            <span style={(() => {
              const len = bigDisplay.length;
              const fontSize =
                len <= 6  ? 56 :
                len <= 9  ? 44 :
                len <= 12 ? 32 :
                len <= 16 ? 24 : 18;
              return {
                fontSize,
                fontFamily: len > 6 ? 'var(--font-mono)' : undefined,
                wordBreak: 'break-all' as const,
                maxWidth: '100%',
              };
            })()}>
              {bigDisplay}
            </span>
            <span className="sym">{symbol}</span>
          </div>
          <div className="aw-approve-toggle">
            <button
              type="button"
              className={choice === 'capped' ? 'is-on' : ''}
              onClick={() => setChoice('capped')}
            >
              capped
            </button>
            <button
              type="button"
              className={choice === 'max' ? 'is-on' : ''}
              onClick={() => setChoice('max')}
            >
              max ∞
            </button>
          </div>
          {choice === 'capped' && (
            <div className="aw-approve-input">
              <input
                type="text"
                inputMode="decimal"
                value={customStr}
                placeholder={meta ? `0.0 ${meta.symbol}` : 'loading…'}
                disabled={!meta}
                onChange={(e) => setCustomStr(e.target.value)}
              />
              <span className="sym">{meta?.symbol ?? 'TOKEN'}</span>
            </div>
          )}
          {choice === 'capped' && parsedCustom === null && customStr.trim() !== '' && (
            <div className="aw-alert">⚠ amount unparseable — fix or pick max.</div>
          )}
        </div>

        {isMax && choice === 'max' && (
          <div className="aw-alert">
            ⚠ max approval — this spender can pull every {symbol} you own, now
            and any you receive later. revoke after using if unsure.
          </div>
        )}

        <dl className="kv-grid">
          <dt>spender</dt>
          {/* Full address — no friendly-name lookup, no UNKNOWN tag. The
             registry that drove those was unmaintained and risked false-
             positively trusting stale addresses. User checks Etherscan. */}
          <dd className="mono">{spender}</dd>
          <dt>token</dt>
          <dd className="mono">
            {chainId !== null ? (
              <a
                href={explorerAddressUrl(chainId, p.to)}
                target="_blank"
                rel="noopener noreferrer"
                className="aw-addr-link"
              >
                {formatTokenContract(p.to, tokenInfo)}
              </a>
            ) : formatTokenContract(p.to, tokenInfo)}
          </dd>
          {badge && (
            <>
              <dt>chain</dt>
              <dd>
                <span className={'aw-chain-badge' + (badge.isTest ? ' is-test' : '')}>
                  {badge.name}
                </span>
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function SevenSevenZeroTwoBody({
  request, address, chainId, gate,
}: {
  request: PendingRequest;
  address: Address;
  chainId: number | null;
  gate: SevenSevenZeroTwoGate | null;
}) {
  const p = (request.payload.params as [{ address: string; chainId: string; nonce: string }])[0]!;
  const reqChainId = parseInt(p.chainId, 16);
  const reqNonce = parseInt(p.nonce, 16);
  const badge = chainBadge(reqChainId) ?? (chainId !== null ? chainBadge(chainId) : null);

  return (
    <>
      <div className="aw-action-card">
        <h4>EIP-7702 delegation</h4>
        <div className="body">
        <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-pixel)', fontSize: 12, lineHeight: 1.4, opacity: 0.75 }}>
          Delegates your account to this contract so the app can act on your
          behalf. It stays active until you revoke it.
        </p>
        <SignerLine address={address} />

        {/* Source-verification status banner — drives both the UI cue
            and the slide-to-confirm enable state. Four cases:
              pending      — Sourcify lookup in flight; show neutral.
              verified     — green ✓, slide unlocked.
              unverified   — red HARD-BLOCK; slide stays locked unless
                             the user has flipped the dev override.
              error        — red soft-block (verifier unreachable);
                             same lock behaviour, slightly different
                             phrasing so user knows it's worth a retry. */}
        {gate?.verification === 'pending' && (
          <div className="aw-verify aw-verify-pending">
            ⏳ checking delegate source on Sourcify…
          </div>
        )}
        {gate?.verification === 'revoke' && (
          <div className="aw-verify aw-verify-pending">
            🧹 EIP-7702 revoke — signing this clears any existing
            delegation from your EOA. no contract control is granted.
          </div>
        )}
        {gate?.verification === 'chain-mismatch' && (
          <div className="aw-verify aw-verify-block">
            🚫 BLOCKED — authorization targets a chain that's NOT the
            active wallet chain.
            <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
              signing this would commit a delegation against the wrong
              chain — switch the wallet to the chain the dapp asked for,
              or have the dapp re-issue the authorization on this chain.
              the dev override does NOT bypass this; a wrong-chain
              signature is meaningless, not just unsafe.
            </span>
          </div>
        )}
        {gate?.verification === 'no-code' && !gate.allowOverride && (
          <div className="aw-verify aw-verify-block">
            🚫 BLOCKED — delegate has NO contract code at this address.
            <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
              signing this bricks your EOA — every call routes into
              empty bytecode and reverts. enable the override in
              Settings → developer only if you know what you are doing.
            </span>
          </div>
        )}
        {gate?.verification === 'unverified' && !gate.allowOverride && (
          <div className="aw-verify aw-verify-block">
            🚫 BLOCKED — delegate contract source is NOT auditable
            (no open-source listing on Sourcify).
            <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
              refusing to sign. enable the override in Settings → developer
              if you accept the risk of delegating to unaudited code.
            </span>
          </div>
        )}
        {gate?.verification === 'error' && !gate.allowOverride && (
          <div className="aw-verify aw-verify-block">
            🚫 BLOCKED — couldn't reach Sourcify to verify the delegate.
            <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
              network down, chain unsupported, or rate-limited. retry,
              or enable the dev override.
            </span>
          </div>
        )}
        {gate?.allowOverride &&
          gate.verification !== 'verified' &&
          gate.verification !== 'revoke' &&
          gate.verification !== 'chain-mismatch' && (
          <div className="aw-verify aw-verify-pending">
            {gate.verification === 'no-code'
              ? "This address has no contract code — a delegation to it wouldn't work."
              : "Delegate source isn't published on Sourcify/Blockscout."}
          </div>
        )}

        <dl className="kv-grid">
          <dt>delegate</dt>
          <dd className="mono">
            {/* Delegate address links out: chain's own block explorer
                if viem knows the chain, Sourcify universal lookup
                otherwise. See explorerAddressUrl docs.
                target=_blank + rel=noopener so the target page can't
                reach back via window.opener. */}
            <a
              href={explorerAddressUrl(reqChainId, p.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="aw-addr-link"
            >
              {p.address} <span className="aw-addr-link-arrow" aria-hidden>↗</span>
            </a>
          </dd>
          <dt>chainId</dt>
          <dd>
            {String(reqChainId)}
            {badge && (
              <>
                {' '}
                <span className={'aw-chain-badge' + (badge.isTest ? ' is-test' : '')}>
                  {badge.name}
                </span>
              </>
            )}
          </dd>
          <dt>nonce</dt>
          <dd className="mono">{String(reqNonce)}</dd>
        </dl>
        </div>
      </div>
    </>
  );
}

/** ERC-7715 `wallet_grantPermissions` body (Task 4.2). Renders the bounded,
 *  revocable scope the dapp asked for as a plain-language CAN / CANNOT review
 *  instead of raw params. The scope is reconstituted from the JSON-safe
 *  `StoredScope` the background serialized onto the pending request
 *  (`request.grantScope`) at queue time — `deserializeScope` turns the
 *  string-encoded bigints back into a `NormalizedScope`. Every line shown is
 *  derived from the wallet's OWN normalized scope (`describeGrantCan` /
 *  `deriveCannotList`), never from any dapp-supplied display copy.
 *
 *  Guard: the dispatcher only ever queues a grant WITH a parsed scope, but if
 *  `grantScope` is somehow absent we fall back to the generic method/params
 *  dump rather than crash — the user still sees something auditable. */
function GrantBody({ request, address }: { request: PendingRequest; address: Address }) {
  const stored = request.grantScope;

  if (!stored) {
    const rows = describeRequest(request);
    return (
      <div className="aw-action-card">
        <h4>grant permission</h4>
        <div className="body">
          <SignerLine address={address} />
          <div className="aw-alert aw-alert-danger">
            ⚠ scope unavailable — showing the raw request. don't approve unless
            you fully understand it.
          </div>
          <dl className="kv-grid">
            {rows.map((r) => (
              <div key={r.label} style={{ display: 'contents' }}>
                <dt>{r.label}</dt>
                <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    );
  }

  const scope = deserializeScope(stored);
  const can = describeGrantCan(scope);
  const cannot = deriveCannotList(scope);

  return (
    <div className="aw-action-card">
      <h4>grant scoped permission</h4>
      <div className="body">
        <SignerLine address={address} />
        <div className="aw-tip-strip">
          <span className="ico">🔐</span>
          <span>a dapp wants a bounded, revocable permission — review exactly what it can and cannot do.</span>
        </div>

        <div className="aw-grant-block">
          <div className="head" style={{ fontWeight: 700, marginBottom: 6 }}>This permission CAN:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {can.map((line, i) => (
              <li key={i} style={{ fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' }}>{line}</li>
            ))}
          </ul>
        </div>

        <div className="aw-row-dashed" />

        <div className="aw-grant-block">
          <div className="head" style={{ fontWeight: 700, marginBottom: 6 }}>It CANNOT:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {cannot.map((line, i) => (
              <li key={i} style={{ fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' }}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SendTxBody({
  request, address, chainId, tokenInfo, simulationError, decodedOverride,
}: {
  request: PendingRequest;
  address: Address;
  chainId: number | null;
  tokenInfo: Record<string, TokenInfo>;
  simulationError: string | null;
  decodedOverride: DecodedTx | null;
}) {
  const summary = describeRequest(request, tokenInfo, decodedOverride, chainId);
  const p = (request.payload.params as [{ data?: string }])[0];
  const data = p?.data && p.data !== '0x' ? p.data : null;
  const [showData, setShowData] = useState(false);
  const badge = chainId !== null ? chainBadge(chainId) : null;

  return (
    <div className="aw-action-card">
      <h4>send transaction</h4>
      <div className="body">
        <SignerLine address={address} />
        {simulationError && (
          <div className="aw-alert aw-alert-danger">
            💥 simulation says this tx will revert: {simulationError}. signing
            will burn gas for nothing.
          </div>
        )}
        {/* warnings moved to parent's SecurityChecks panel */}
        <dl className="kv-grid">
          {summary.map((s) => (
            <div key={s.label} style={{ display: 'contents' }}>
              <dt>{s.label}</dt>
              <dd className={s.mono ? 'mono' : undefined}>
                {s.href ? (
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="aw-addr-link"
                  >
                    {s.value}
                  </a>
                ) : s.value}
              </dd>
            </div>
          ))}
          {badge && (
            <>
              <dt>chain</dt>
              <dd>
                <span className={'aw-chain-badge' + (badge.isTest ? ' is-test' : '')}>
                  {badge.name}
                </span>
              </dd>
            </>
          )}
        </dl>

        {data && (
          <>
            <button
              className="aw-raw-show-more"
              onClick={() => setShowData(!showData)}
              style={{ alignSelf: 'flex-start' }}
            >
              {showData ? 'hide raw data ▴' : `show raw data (${(data.length - 2) / 2} bytes) ▾`}
            </button>
            {showData && (
              <div className="aw-typed-msg">
                <div className="head">calldata</div>
                <div style={{
                  padding: 10,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  wordBreak: 'break-all',
                  maxHeight: 200,
                  overflowY: 'auto',
                }}>
                  {data}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** EIP-747 wallet_watchAsset body. dapp suggests a token; we IMMEDIATELY
 *  fetch on-chain metadata via read-token-info so the user sees the real
 *  name/symbol/decimals — not whatever string the dapp chose to display.
 *
 *  Phishing scenario: dapp passes `symbol: "ETH"` for a contract that
 *  actually returns "FAKE_USDC" on-chain. Without fetching, the popup would
 *  show "ETH" → user adds → token list now has "FAKE_USDC" with the user
 *  thinking they added ETH. We show on-chain values prominently and flag
 *  any dapp claim that disagrees in red. */
function WatchAssetBody({ request }: { request: PendingRequest }) {
  // EIP-747 — three asset types:
  //   ERC20   → name/symbol/decimals from chain
  //   ERC721  → name + tokenURI metadata from chain, tokenId from dapp
  //   ERC1155 → uri(id) metadata from chain, tokenId from dapp
  // params can be `{type, options}` (bare object per EIP-747 example) or
  // `[{type, options}]` (JSON-RPC convention) — accept both.
  const raw = request.payload.params as unknown;
  const p = (Array.isArray(raw) ? (raw as unknown[])[0] : raw) as {
    type: 'ERC20' | 'ERC721' | 'ERC1155';
    options: {
      address: string;
      symbol?: string;
      decimals?: number;
      image?: string;
      tokenId?: string;
    };
  };
  const o = p.options;
  const addr = o.address.toLowerCase();
  const isNft = p.type === 'ERC721' || p.type === 'ERC1155';
  return isNft
    ? <WatchAssetNftBody addr={addr} type={p.type as 'ERC721' | 'ERC1155'} tokenId={o.tokenId ?? ''} />
    : <WatchAssetErc20Body addr={addr} type={p.type} dappImage={o.image} />;
}

function WatchAssetErc20Body({
  addr, type, dappImage,
}: { addr: string; type: string; dappImage?: string }) {
  const [chainMeta, setChainMeta] = useState<TokenInfo | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const info = await send<Record<string, TokenInfo>>({
          kind: 'read-token-info',
          addresses: [addr],
        });
        const m = info[addr];
        if (m) setChainMeta(m);
        else setFetchErr('contract did not respond to ERC-20 metadata reads');
      } catch (e) {
        setFetchErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [addr]);

  return (
    <div className="aw-action-card">
      <h4>add token</h4>
      <div className="body">
        {dappImage && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 6 }}>
            <img
              src={dappImage}
              alt={chainMeta?.symbol ?? 'token'}
              style={{ width: 56, height: 56, border: '2px solid var(--ink)', background: 'var(--white)' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        )}

        <dl className="kv-grid">
          <dt>type</dt>     <dd>{type}</dd>
          <dt>contract</dt> <dd className="mono">{addr}</dd>
          <dt>name</dt>
          <dd>{chainMeta ? chainMeta.name
            : fetchErr ? <span style={{ opacity: 0.5 }}>—</span>
            : <span style={{ opacity: 0.5 }}>loading…</span>}</dd>
          <dt>symbol</dt>
          <dd>{chainMeta ? chainMeta.symbol
            : fetchErr ? <span style={{ opacity: 0.5 }}>—</span>
            : <span style={{ opacity: 0.5 }}>loading…</span>}</dd>
          <dt>decimals</dt>
          <dd>{chainMeta ? chainMeta.decimals
            : fetchErr ? <span style={{ opacity: 0.5 }}>—</span>
            : <span style={{ opacity: 0.5 }}>loading…</span>}</dd>
        </dl>

        {fetchErr && (
          <div className="aw-alert">
            ⚡ couldn't read contract metadata on-chain: {fetchErr}. don't add unless you trust this contract.
          </div>
        )}

        <div className="aw-tip-strip">
          <span className="ico">✦</span>
          <span>name / symbol / decimals come straight from the contract. anything the dapp claimed is ignored.</span>
        </div>
      </div>
    </div>
  );
}

function WatchAssetNftBody({
  addr, type, tokenId,
}: { addr: string; type: 'ERC721' | 'ERC1155'; tokenId: string }) {
  // For NFTs we don't pre-fetch metadata in the popup — the SW's
  // `addNft` path does it after approve, including the ownership
  // check (phishing defence) and tokenURI fetch. Pre-fetching here
  // would duplicate the RPC calls and the result wouldn't change
  // what the user sees (no image render in the sign-confirm body —
  // the image lives on the NFT card after approve). Keep this body
  // a clean preview of "what's about to be added".
  return (
    <div className="aw-action-card">
      <h4>add NFT</h4>
      <div className="body">
        <dl className="kv-grid">
          <dt>type</dt>     <dd>{type}</dd>
          <dt>contract</dt> <dd className="mono">{addr}</dd>
          <dt>tokenId</dt>  <dd className="mono">{tokenId || <span style={{ opacity: 0.5 }}>—</span>}</dd>
        </dl>

        <div className="aw-tip-strip">
          <span className="ico">✦</span>
          <span>
            metadata + ownership are checked on-chain after you approve.
            if you don't own this token, the wallet refuses to add it.
          </span>
        </div>
      </div>
    </div>
  );
}

function AddChainBody({ request }: { request: PendingRequest }) {
  const summary = describeRequest(request);
  return (
    <div className="aw-action-card">
      <h4>add custom chain</h4>
      <div className="body">
        {/* warnings moved to parent's SecurityChecks panel */}
        <dl className="kv-grid">
          {summary.map((s) => (
            <div key={s.label} style={{ display: 'contents' }}>
              <dt>{s.label}</dt>
              <dd className={s.mono ? 'mono' : undefined}>
                {s.href ? (
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="aw-addr-link"
                  >
                    {s.value}
                  </a>
                ) : s.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="aw-tip-strip">
          <span className="ico">🌐</span>
          <span>chain RPCs see every tx you send through them. trust the dapp adding this.</span>
        </div>
      </div>
    </div>
  );
}

// ─── Connect approval (eth_requestAccounts) ───────────────────────────────
// Dapp asks to see the wallet address; user approves the origin so future
// sign requests come without a re-grant. Distinct UI from sign-confirm —
// no transaction details, just origin + active account preview.

function ConnectConfirm({
  origin, address, busy, onApprove, onReject,
}: {
  origin: string;
  address: Address;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const host = origin.replace(/^https?:\/\//, '');
  const [accountLabel, setAccountLabel] = useState<string>('account');
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [isFirstVisit, setIsFirstVisit] = useState(true);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  // Display currency + ETH/USD rate so the summary's total respects the
  // user's preference (usd default). ethUsdRate arrives with the balance
  // reply, currency is loaded once on mount.
  const [currency, setCurrency] = useState<'eth' | 'usd'>('usd');
  const [ethUsdRate, setEthUsdRate] = useState<number | null>(null);

  // Pull current account label + token balances + first-visit detection +
  // site favicon (active-tab cached → free; Google s2 fallback for everything
  // else) so the summary block can show "Ξ X / $X · N tokens" with a real site icon.
  useEffect(() => {
    void (async () => {
      try {
        const list = await send<{ index: number; label: string; address: string }[]>({ kind: 'list-accounts' });
        const me = list.find((a) => a.address.toLowerCase() === address.toLowerCase());
        if (me) setAccountLabel(me.label);
      } catch {/* keep default */}
      try {
        const reply = await send<{ tokens: TokenRow[]; ethUsdRate: number | null }>({ kind: 'read-token-balances' });
        setTokens(reply.tokens);
        setEthUsdRate(reply.ethUsdRate);
      } catch {/* keep null — UI falls back to '—' */}
      try {
        const c = await send<'eth' | 'usd'>({ kind: 'get-currency' });
        setCurrency(c);
      } catch {/* keep default */}
      try {
        const origins = await send<string[]>({ kind: 'list-connected-origins' });
        setIsFirstVisit(!origins.includes(origin));
      } catch {/* assume first visit */}
      try {
        const tabs = await chrome.tabs.query({ url: origin + '/*' });
        const tab = tabs.find((t) => !!t.favIconUrl);
        setFaviconUrl(
          tab?.favIconUrl ??
            `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`,
        );
      } catch {
        setFaviconUrl(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`);
      }
    })();
  }, [address, origin, host]);

  // Total USD across all rows (skip rows with no price feed). Token count is
  // total rows — gives the user a sense of the wallet's scope at a glance.
  const totalUsd = (tokens ?? []).reduce((acc, t) => {
    const bal = parseFloat(t.balance);
    if (!Number.isFinite(bal) || t.priceUsd == null) return acc;
    return acc + bal * t.priceUsd;
  }, 0);
  const usdStr = formatCurrency(totalUsd, currency, ethUsdRate);
  const tokenCount = tokens?.length ?? 0;
  const shortAddr = truncateAddr(address);

  return (
    <>
      {/* Black header strip — site favicon tile + host + first-visit + NEW stamp */}
      <div className="aw-connect-head">
        {faviconUrl ? (
          <img
            src={faviconUrl}
            alt=""
            className="ico"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        ) : (
          <span className="ico">🌐</span>
        )}
        <div className="meta">
          <div className="host">{host}</div>
          <div className="sub">{isFirstVisit ? 'first visit' : 'returning site'}</div>
        </div>
        {isFirstVisit && <div className="new">NEW</div>}
      </div>

      {/* CONNECT TO SITE? */}
      <div className="aw-set-card">
        <h4>connect to site?</h4>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="aw-host-greeting">
            <code>{host}</code> says hi 👋
          </div>
          <div className="aw-acct-summary">
            <AccountGlyph address={address} className="ic" />
            <div className="info">
              <div className="name">{accountLabel}</div>
              <div className="meta">
                {tokens === null ? '…' : usdStr} · {tokenCount} {tokenCount === 1 ? 'token' : 'tokens'}
              </div>
            </div>
            <div className="addr-pill">{shortAddr}</div>
          </div>
        </div>
      </div>

      {/* IT CAN */}
      <div className="aw-set-card">
        <h4>it can</h4>
        <div className="aw-set-row">
          <span className="aw-perm-ico ok">👁</span>
          <span className="label" style={{ textTransform: 'none', fontWeight: 700 }}>
            see ur address &amp; balance
          </span>
        </div>
        <div className="aw-set-row">
          <span className="aw-perm-ico ok">📝</span>
          <span className="label" style={{ textTransform: 'none', fontWeight: 700 }}>
            ask u to sign — u approve each one
          </span>
        </div>
        <div className="aw-set-row is-blocked">
          <span className="aw-perm-ico bad">✗</span>
          <span
            className="label"
            style={{ textTransform: 'none', fontWeight: 700, color: 'var(--alarm-red)' }}
          >
            move funds w/o asking
          </span>
        </div>
      </div>

      {/* Anti-phishing dashed warning */}
      <div className="aw-warn-strip">
        <span className="ico">✦</span>
        <span>check the URL. scammers copy real ones.</span>
      </div>

      {/* NOPE / CONNECT */}
      <div className="aw-btn-row" style={{ marginTop: 'auto' }}>
        <button className="aw-btn aw-btn-ghost" onClick={onReject} disabled={busy}>
          nope
        </button>
        <button className="aw-btn" onClick={onApprove} disabled={busy} style={{ flex: 2 }}>
          {busy ? 'connecting…' : 'connect'}
        </button>
      </div>
    </>
  );
}
