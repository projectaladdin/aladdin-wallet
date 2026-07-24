import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { newMnemonic } from './core/crypto';
import { hasVault } from './core/storage';
import type { PendingRequest } from './shared/protocol';
import {
  ToastContext,
  send,
  type ToastFn,
  type ToastInput,
} from './popup/shared';
import { SignConfirm } from './popup/screens/sign-confirm';
import { Create, Import, Loading, Unlock, Welcome } from './popup/screens/onboarding';
import {
  AccountsScreen,
  AddToken,
  ConnectedSitesScreen,
  Dashboard,
  NetworkProvider,
} from './popup/screens/dashboard';
import { ReceiveScreen } from './popup/screens/receive';
import { ActivityScreen } from './popup/screens/activity';
import { SendScreen } from './popup/screens/send';
import { AddNftScreen } from './popup/screens/nfts';
import { AddChain, ResetConfirm, RevealRecovery, Settings } from './popup/screens/settings';
import { About } from './popup/screens/about';
import { DevSettingsScreen } from './popup/screens/dev-settings';
import { Safety } from './popup/screens/safety';

type Screen =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: 'create'; mnemonic: string }
  | { name: 'import' }
  | { name: 'unlock' }
  | { name: 'dashboard'; address: Address }
  | { name: 'settings'; address: Address }
  | { name: 'add-chain'; from: 'settings' }
  | { name: 'add-token'; address: Address }
  | { name: 'add-nft'; address: Address }
  | { name: 'send'; address: Address; initialToken?: string }
  | { name: 'receive'; address: Address }
  | { name: 'activity'; address: Address }
  | { name: 'accounts'; address: Address }
  | { name: 'connected'; address: Address }
  | { name: 'safety'; address: Address }
  | { name: 'reveal-recovery' }
  | { name: 'reset-confirm' }
  | { name: 'dev-settings' }
  | { name: 'about' }
  | { name: 'sign-confirm'; request: PendingRequest; address: Address };

// Toast notification system + AccountGlyph + send() + TokenMeta/TokenRow types
// are imported from ./popup/shared.

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => { void route(); }, []);

  // Heartbeat port to the SW so it can detect when the popup goes
  // away. The port closes automatically when the popup unloads —
  // the SW listens for `onDisconnect` and rejects every pending
  // request with EIP-1193 4001 (user rejected) after a short grace
  // window. Without this, closing the popup without clicking
  // approve/reject left the dapp's `provider.request()` Promise
  // hanging forever.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'popup-alive' });
    return () => { try { port.disconnect(); } catch { /* SW gone */ } };
  }, []);

  // Block the browser's native context menu across the entire popup.
  // Industry standard for wallet popups (MetaMask / Phantom / Rabby all
  // do this). Reasons:
  //   - Reserves right-click as an in-app gesture (token row remove
  //     pill, future copy-address shortcuts, etc.) without competing
  //     with native menu items.
  //   - Hides "Inspect Element" / dev-tool entry points from non-dev
  //     users — popup is still inspectable via the toolbar icon's
  //     "Inspect popup" option, so the dev workflow isn't lost.
  //   - Trade-off: users lose right-click → Paste in input fields. They
  //     can still use Cmd/Ctrl+V; the address-pill copy button remains
  //     the canonical way to copy the wallet address.
  // The listener is attached to `document` so it catches every event
  // before per-screen React handlers — but React's synthetic
  // onContextMenu props (e.g. on token rows) still fire alongside,
  // because they ride React's own dispatcher, not the bubble path
  // this listener intercepts.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  const showToast: ToastFn = (t) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now() + Math.random(), ...t });
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  async function route() {
    // Defensive: every send() may fail if SW is mid-restart or in a weird
    // transient state. Rather than freezing the popup on a half-routed view,
    // fall back to the most reasonable screen when something throws.
    try {
      const exists = await hasVault();
      if (!exists) return setScreen({ name: 'welcome' });

      const unlocked = await send<boolean>({ kind: 'is-unlocked' }).catch(() => false);
      if (!unlocked) return setScreen({ name: 'unlock' });

      let address: Address;
      try {
        address = await send<Address>({ kind: 'get-account' });
      } catch {
        // Lock-race (was unlocked when we asked, locked by the time we
        // followed up). Re-route to unlock, user re-enters password.
        return setScreen({ name: 'unlock' });
      }

      const pendingList = await send<PendingRequest[]>({ kind: 'list-pending-requests' }).catch(() => [] as PendingRequest[]);
      if (pendingList.length > 0) {
        return setScreen({ name: 'sign-confirm', request: pendingList[0]!, address });
      }
      setScreen({ name: 'dashboard', address });
    } catch (e) {
      // hasVault failure (chrome.storage glitch) is the only thing not caught
      // above. Fall through to welcome — user can rebuild from there.
      console.error('route error:', e);
      setScreen({ name: 'welcome' });
    }
  }

  const backToSettings = async () => {
    const a = await send<Address>({ kind: 'get-account' });
    setScreen({ name: 'settings', address: a });
  };

  const renderScreen = () => {
    switch (screen.name) {
      case 'loading':       return <Loading />;
      case 'welcome':       return <Welcome
                              onCreate={() => setScreen({ name: 'create', mnemonic: newMnemonic() })}
                              onImport={() => setScreen({ name: 'import' })}
                            />;
      case 'create':        return <Create
                              mnemonic={screen.mnemonic}
                              onDone={route}
                              onBack={() => setScreen({ name: 'welcome' })}
                            />;
      case 'import':        return <Import
                              onDone={route}
                              onBack={() => setScreen({ name: 'welcome' })}
                            />;
      case 'unlock':        return <Unlock onUnlocked={route} />;
      case 'dashboard':     return <Dashboard
                              address={screen.address}
                              onSettings={() => setScreen({ name: 'settings', address: screen.address })}
                              onAddToken={() => setScreen({ name: 'add-token', address: screen.address })}
                              onSend={(tok) => setScreen({ name: 'send', address: screen.address, initialToken: tok })}
                              onReceive={() => setScreen({ name: 'receive', address: screen.address })}
                              onAddNft={() => setScreen({ name: 'add-nft', address: screen.address })}
                              onActivity={() => setScreen({ name: 'activity', address: screen.address })}
                            />;
      case 'settings':      return <Settings
                              address={screen.address}
                              onBack={() => setScreen({ name: 'dashboard', address: screen.address })}
                              onLock={async () => {
                                await send({ kind: 'lock' });
                                showToast({ tone: 'green', icon: '🔒', text: 'wallet locked.' });
                                route();
                              }}
                              onAddChain={() => setScreen({ name: 'add-chain', from: 'settings' })}
                              onAccounts={() => setScreen({ name: 'accounts', address: screen.address })}
                              onConnected={() => setScreen({ name: 'connected', address: screen.address })}
                              onSafety={() => setScreen({ name: 'safety', address: screen.address })}
                              onRevealRecovery={() => setScreen({ name: 'reveal-recovery' })}
                              onResetWallet={() => setScreen({ name: 'reset-confirm' })}
                              onDeveloper={() => setScreen({ name: 'dev-settings' })}
                              onAbout={() => setScreen({ name: 'about' })}
                            />;
      case 'add-chain':     return <AddChain onDone={async () => {
                              const address = await send<Address>({ kind: 'get-account' });
                              setScreen({ name: 'settings', address });
                            }} />;
      case 'add-token':     return <AddToken
                              onDone={() => setScreen({ name: 'dashboard', address: screen.address })}
                            />;
      case 'add-nft':       return <AddNftScreen
                              onDone={() => setScreen({ name: 'dashboard', address: screen.address })}
                            />;
      case 'send':          return <SendScreen
                              address={screen.address}
                              initialToken={screen.initialToken}
                              onBack={() => setScreen({ name: 'dashboard', address: screen.address })}
                              onSent={() => setScreen({ name: 'dashboard', address: screen.address })}
                            />;
      case 'receive':       return <ReceiveScreen
                              address={screen.address}
                              onBack={() => setScreen({ name: 'dashboard', address: screen.address })}
                            />;
      case 'activity':      return <ActivityScreen
                              address={screen.address}
                              onBack={() => setScreen({ name: 'dashboard', address: screen.address })}
                            />;
      case 'accounts':      return <AccountsScreen
                              address={screen.address}
                              onBack={backToSettings}
                              onChange={route}
                            />;
      case 'connected':     return <ConnectedSitesScreen onBack={backToSettings} />;
      case 'safety':        return <Safety address={screen.address} onBack={backToSettings} />;
      case 'reveal-recovery': return <RevealRecovery onBack={backToSettings} />;
      case 'dev-settings':  return <DevSettingsScreen onBack={backToSettings} />;
      case 'about':         return <About onBack={backToSettings} />;
      case 'reset-confirm': return <ResetConfirm
                              onBack={backToSettings}
                              onDone={async () => {
                                await send({ kind: 'reset-wallet' });
                                showToast({ tone: 'red', icon: '🗑', text: 'wallet wiped.' });
                                route();
                              }}
                            />;
      case 'sign-confirm':  return <SignConfirm
                              key={screen.request.id}
                              request={screen.request}
                              address={screen.address}
                              onResolved={route}
                            />;
    }
  };

  return (
    <ToastContext.Provider value={showToast}>
      <NetworkProvider>
        {renderScreen()}
        {toast && (
          <div key={toast.id} className={'aw-toast ' + (toast.tone ?? 'yellow')}>
            {toast.icon && <span className="ico">{toast.icon}</span>}
            <span>{toast.text}</span>
          </div>
        )}
      </NetworkProvider>
    </ToastContext.Provider>
  );
}




// ─── Accounts screen — full-page picker / rename / add ──────────────────
// Lifted out of Settings so the picker has room: per-account glyph + label +
// truncated address + rename, with "+ add account" pinned at the bottom.


