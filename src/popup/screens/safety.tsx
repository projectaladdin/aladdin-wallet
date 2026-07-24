// Safety Panel (Task 4.3) — lists the wallet's *active* grants for the current
// (chain, account) with a CAN / CANNOT view and a one-click Revoke.
//
// Two grant kinds land in the same registry (see src/lib/grant-scope.ts):
//   • session — an ERC-7715-style scoped permission. We deserialize the stored
//     scope and render `describeGrantCan` (the positive space) under CAN and
//     `deriveCannotList` (the negative space) under CANNOT. Same tested helpers
//     the sign-confirm grant-review screen uses — no CAN/CANNOT logic is
//     duplicated here.
//   • 7702 — an EIP-7702 delegation. We show the delegate address + its
//     source-verification badge (the same `verifyContract` trust signal the
//     7702 sign gate uses).
//
// Revoke is a *wallet-side* registry mark (revoke-grant → revokeGrant stamps
// revokedAt). It never depends on the dapp being reachable, and the grant
// disappears from this panel immediately. For 7702 grants that mark does NOT
// clear the on-chain delegation — there is no self-broadcast path in the
// wallet today — so we surface an honest note rather than implying otherwise.

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import {
  deriveCannotList,
  describeGrantCan,
  deserializeScope,
  isGrantActive,
  type GrantRecord,
} from '../../lib/grant-scope';
import { verifyContract, type VerificationStatus } from '../../lib/contract-verify';
import { Header } from '../components/header';
import { AccountGlyph, send, useToast } from '../shared';
import { useNetworkState } from './dashboard';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Small coloured pill mirroring the sign-confirm 7702 gate's trust cue. */
function VerifyBadge({ status }: { status: VerificationStatus | 'pending' }) {
  if (status === 'pending') return <span className="aw-sticker aw-sticker-yellow">checking…</span>;
  if (status === 'verified') return <span className="aw-sticker aw-sticker-green">verified ✓</span>;
  if (status === 'unverified') return <span className="aw-sticker aw-sticker-red">unverified</span>;
  return <span className="aw-sticker aw-sticker-yellow">verifier unreachable</span>;
}

function CanCannot({ grant }: { grant: GrantRecord }) {
  // Session grants carry the stored scope; deserialize and reuse the tested
  // CAN / CANNOT helpers. A malformed/absent scope shouldn't crash the panel.
  if (!grant.scope) return null;
  let can: string[];
  let cannot: string[];
  try {
    const scope = deserializeScope(grant.scope);
    can = describeGrantCan(scope);
    cannot = deriveCannotList(scope);
  } catch {
    return (
      <p className="aw-mono" style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>
        (could not parse stored scope)
      </p>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--chunky-green, #2a8d3a)' }}>CAN</div>
      <ul style={{ margin: '4px 0 8px', paddingLeft: 16, fontSize: 11, lineHeight: 1.4 }}>
        {can.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--alarm-red, #c0392b)' }}>CANNOT</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11, lineHeight: 1.4, opacity: 0.8 }}>
        {cannot.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

export function Safety({ address, onBack }: { address: Address; onBack: () => void }) {
  const showToast = useToast();
  const { chainId } = useNetworkState();
  const [grants, setGrants] = useState<GrantRecord[] | null>(null);
  // Per-7702-grant source-verification status, keyed by grant id.
  const [verifyById, setVerifyById] = useState<Record<string, VerificationStatus | 'pending'>>({});

  useEffect(() => { if (chainId !== null) void load(chainId); }, [chainId, address]);

  async function load(cid: number) {
    try {
      const all = await send<GrantRecord[]>({ kind: 'list-grants', chainId: cid, account: address });
      const now = Math.floor(Date.now() / 1000);
      const active = all.filter((g) => isGrantActive(g, now));
      setGrants(active);
      // Kick off verification for each 7702 delegate — same trust signal the
      // sign gate uses. Fail-closed: any lookup error shows as 'error'.
      for (const g of active) {
        if (g.kind !== '7702') continue;
        setVerifyById((m) => ({ ...m, [g.id]: 'pending' }));
        void verifyContract(cid, g.target)
          .then((r) => setVerifyById((m) => ({ ...m, [g.id]: r.status })))
          .catch(() => setVerifyById((m) => ({ ...m, [g.id]: 'error' })));
      }
    } catch {
      setGrants([]);
    }
  }

  async function revoke(g: GrantRecord) {
    // Wallet-side mark — succeeds regardless of dapp reachability. On success
    // the grant leaves the active list.
    await send({ kind: 'revoke-grant', id: g.id });
    setGrants((cur) => cur?.filter((x) => x.id !== g.id) ?? null);
    showToast({ tone: 'green', icon: '🛡', text: 'grant revoked.' });
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} label="safety" caption="who can touch your wallet" />

      <div className="aw-set-card">
        <h4>active grants · {grants?.length ?? 0}</h4>
        {grants === null ? (
          <p className="aw-mono" style={{ padding: 14, opacity: 0.55, textAlign: 'center' }}>loading…</p>
        ) : grants.length === 0 ? (
          <div className="aw-empty" style={{ marginTop: 14, marginBottom: 6 }}>
            <span className="aw-stamp">nothing here yet</span>
            <h3>no active grants</h3>
            <p>no dapp holds a session permission or delegation on this account.</p>
          </div>
        ) : (
          grants.map((g) => (
            <div
              className="aw-set-row"
              key={g.id}
              style={{ alignItems: 'flex-start', flexDirection: 'column', paddingTop: 12, paddingBottom: 12, gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 8 }}>
                <AccountGlyph address={g.target as Address} size={24} />
                <span className="label" style={{ minWidth: 0, textTransform: 'none', flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: 12 }}>
                    {g.kind === '7702' ? 'EIP-7702 delegation' : 'session permission'}
                  </span>
                  <span className="aw-mono" style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>
                    {g.kind === '7702' ? 'delegate ' : 'target '}{short(g.target)}
                  </span>
                </span>
                {g.kind === '7702' && <VerifyBadge status={verifyById[g.id] ?? 'pending'} />}
                <button
                  className="aw-btn aw-btn-ghost aw-btn-sm"
                  onClick={() => void revoke(g)}
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  title="revoke this grant"
                >
                  revoke
                </button>
              </div>

              {g.kind === 'session' && <CanCannot grant={g} />}

              {g.kind === '7702' && (
                <p
                  className="aw-mono"
                  style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.35, marginTop: 4 }}
                >
                  removing this stops the wallet from tracking it. if the delegation is still
                  active on-chain, also submit an on-chain revocation (delegate → 0x0).
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
