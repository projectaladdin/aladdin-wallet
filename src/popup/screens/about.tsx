// About screen — static capability + brand overview for Aladdin Wallet.
// Reached from Settings › about. Purely informational: no state, no network
// calls. Lists the standards and primitives the wallet implements, using the
// same Header + card/row primitives the Settings screen uses.

import { Header } from '../components/header';
import { Lamp } from '../shared';

// Standards / primitives the wallet ships with. Kept as data so the row markup
// below stays a single map — same shape the Settings cards use (icon + label +
// muted sub-caption).
const CAPABILITIES: { icon: string; name: string; desc: string }[] = [
  { icon: '🔗', name: 'EIP-7702', desc: 'upgrade your EOA to a smart account for a single transaction.' },
  { icon: '🎟', name: 'ERC-7715', desc: 'grant scoped, revocable permissions to apps.' },
  { icon: '📡', name: 'EIP-6963', desc: 'announced to dapps as Aladdin Wallet, no injection clashes.' },
  { icon: '✍', name: 'EIP-712', desc: 'typed-data signing with human-readable prompts.' },
  { icon: '⛽', name: 'EIP-1559', desc: 'fee-market gas with slow / normal / fast tiers.' },
  { icon: '🧮', name: 'Multicall3', desc: 'batches balance reads into one RPC round-trip.' },
  { icon: '🔤', name: 'ENS', desc: 'resolves .eth names for sends and display.' },
  { icon: '🛡', name: 'Sourcify / Blockscout', desc: 'verifies contract source before you sign.' },
  { icon: '🔐', name: 'AES-GCM vault', desc: 'your keys are encrypted at rest and never leave this device.' },
  { icon: '🌱', name: 'BIP-39 / BIP-44', desc: 'standard mnemonic and HD derivation.' },
];

export function About({ onBack }: { onBack: () => void }) {
  return (
    <>
      <Header status="unlocked" onBack={onBack} />

      {/* Hero — brand mark + name + tagline. */}
      <div style={{ textAlign: 'center', padding: '18px 14px 6px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <Lamp size={40} />
        </div>
        <h2 className="aw-card-title" style={{ margin: 0 }}>ALADDIN</h2>
        <p className="aw-mono" style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.6 }}>
          a wallet for the age of djinn
        </p>
      </div>

      {/* Capabilities — one row per standard / primitive. */}
      <div className="aw-set-card">
        <h4>capabilities</h4>
        {CAPABILITIES.map((c) => (
          <div className="aw-set-row" key={c.name}>
            <span className="ico">{c.icon}</span>
            <span className="label">{c.name}
              <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                {c.desc}
              </span>
            </span>
          </div>
        ))}
      </div>

      <p
        className="aw-mono"
        style={{ fontSize: 10, opacity: 0.4, textAlign: 'center', marginTop: 'auto' }}
      >
        Aladdin Wallet v{chrome.runtime.getManifest().version} · MV3 · EIP-6963
      </p>
      <p
        className="aw-mono"
        style={{ fontSize: 10, opacity: 0.4, textAlign: 'center', marginTop: 4 }}
      >
        not investment advice.
      </p>
    </>
  );
}
