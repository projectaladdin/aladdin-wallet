// Developer / app settings — own screen. Toggles persisted in DevFlags:
//
//   rpcTrace                  — log every dapp RPC to the SW console.
//   allowUnverifiedDelegate   — skip the EIP-7702 source-verification check
//                                before signing a delegation. ON by default
//                                for this app-dedicated wallet (users delegate
//                                to the app's own, sometimes-unverified
//                                contracts); a plain toggle, session-scoped.
//
// Layout mirrors AccountsScreen: own Header with onBack, list of rows below.

import { useEffect, useState } from 'react';
import { Header } from '../components/header';
import { send, useToast } from '../shared';

type DevFlagsView = {
  rpcTrace: boolean;
  allowUnverifiedDelegate: boolean;
};

export function DevSettingsScreen({ onBack }: { onBack: () => void }) {
  const showToast = useToast();
  const [flags, setFlags] = useState<DevFlagsView>({
    rpcTrace: false,
    // ON by default — matches getDevFlags(); the fetch below confirms the
    // real value (an explicit session OFF, if any).
    allowUnverifiedDelegate: true,
  });

  useEffect(() => {
    void (async () => {
      try {
        const f = await send<Partial<DevFlagsView>>({ kind: 'get-dev-flags' });
        setFlags({
          rpcTrace: !!f.rpcTrace,
          allowUnverifiedDelegate: f.allowUnverifiedDelegate ?? true,
        });
      } catch { /* keep defaults */ }
    })();
  }, []);

  async function setFlag(key: keyof DevFlagsView, value: boolean) {
    try {
      await send({ kind: 'set-dev-flag', key, value });
      setFlags((cur) => ({ ...cur, [key]: value }));
    } catch (e) {
      showToast({
        tone: 'red', icon: '⚠',
        text: (e instanceof Error ? e.message : String(e)).slice(0, 90),
      });
    }
  }

  return (
    <>
      <Header status="unlocked" onBack={onBack} label="developer" caption="opt-in toggles" />

      {/* RPC trace — neutral toggle. */}
      <div className="aw-set-card">
        <h4>diagnostics</h4>
        <div
          className="aw-set-row is-clickable"
          onClick={() => void setFlag('rpcTrace', !flags.rpcTrace)}
          style={{ background: flags.rpcTrace ? 'var(--cream)' : undefined }}
        >
          <span className="ico">🔍</span>
          <span className="label">
            rpc trace
            <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
              log every dapp call to SW console
            </span>
          </span>
          <span className="val">{flags.rpcTrace ? 'ON' : 'off'}</span>
        </div>
      </div>

      {/* 7702 source-verification override — plain toggle, ON by default. */}
      <div className="aw-set-card">
        <h4>7702 delegation</h4>
        <div
          className="aw-set-row is-clickable"
          onClick={() => void setFlag('allowUnverifiedDelegate', !flags.allowUnverifiedDelegate)}
          style={{ background: flags.allowUnverifiedDelegate ? 'var(--cream)' : undefined }}
        >
          <span className="ico">🔓</span>
          <span className="label">
            allow unverified 7702 delegate
            <span className="aw-mono" style={{ display: 'block', fontSize: 10, opacity: 0.55, marginTop: 2 }}>
              skips the source-verification check before signing a delegation.
              on by default for this app; session-only.
            </span>
          </span>
          <span className="val">{flags.allowUnverifiedDelegate ? 'ON' : 'off'}</span>
        </div>
      </div>
    </>
  );
}
