// Runs in MAIN world (page context). Mounts a window.aladdin / window.ethereum
// EIP-1193 provider and announces it via EIP-6963. wagmi auto-discovers it.
//
// Communication with content.ts (ISOLATED world) is via window.postMessage
// since the two worlds share the DOM but not JS scope.
//
// Three layers of method handling (chrome.md §3):
//   Layer 1 — answered locally (no SW round-trip): eth_chainId, eth_accounts,
//             web3_clientVersion, net_version, wallet_get/request/revokePermissions,
//             wallet_getCapabilities, _metamask.isUnlocked
//   Layer 2 — forwarded to background, requires user approval: eth_sendTransaction,
//             personal_sign, eth_signTypedData_v4, wallet_signAuthorization, etc.
//   Layer 3 — passthrough to chain RPC (read methods like eth_call, eth_getBalance)
//             — handled in background.ts via SW fetch.
//
// Defensive: any unrecognised `wallet_*` method throws 4200 instead of being
// blindly forwarded — otherwise dapps think we support arbitrary wallet APIs.

/** Inlined at build time from manifest.json#version. See scripts/build.ts
 *  `define: { __WALLET_VERSION__: ... }`. Used for `web3_clientVersion`
 *  and the EIP-6963 announce so dapps always see the live extension
 *  version, not a hand-typed constant. */
declare const __WALLET_VERSION__: string;

import type {
  ContentToPage,
  PageToContent,
  RpcRequest,
  RpcResponse,
} from './shared/protocol';
import { PROTO_TAG, KNOWN_WALLET_METHODS } from './shared/protocol';
import { WALLET_INFO } from './shared/config';

type EventHandler = (data: unknown) => void;

// Errors raised through `request()` carry an EIP-1193 / -1474 numeric code.
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class AladdinProvider {
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<EventHandler>>();

  // Local mirrors maintained from background events. Used by Layer 1 fast
  // paths so dapps don't see RPC latency on hot calls.
  private _accounts: string[] = [];
  private _chainIdHex = '0x1';

  constructor() {
    window.addEventListener('message', this.onMessage);
    // Lazy hydrate on construction. Don't block — if SW isn't ready yet,
    // first `eth_chainId` call will route to it.
    void this.hydrate();
  }

  /** EIP-1193-recognised flag — and we also masquerade as MetaMask so dapps
   *  that hard-check `isMetaMask` (a non-trivial slice of the long tail) still
   *  let us connect. EIP-6963 + isMetaMask both true is the standard "play
   *  nice with everything" approach. */
  isAladdin = true as const;
  isMetaMask = true as const;

  // _metamask.isUnlocked must always resolve true — wagmi/ethers init checks
  // this before connect; if it returns false they treat the wallet as locked.
  // Real lock/unlock state surfaces through eth_requestAccounts, not here.
  // chrome.md §2.7
  _metamask = {
    isUnlocked: () => Promise.resolve(true),
  };

  /** EIP-1193 `request`. */
  async request<T = unknown>(args: { method: string; params?: unknown }): Promise<T> {
    const { method } = args;

    // ─── Layer 1: client-side fast paths ──────────────────────────────────
    switch (method) {
      case 'eth_chainId':
        return this._chainIdHex as T;

      case 'net_version':
        return String(parseInt(this._chainIdHex, 16)) as T;

      case 'eth_accounts':
        // EIP-1193: return cached accounts; if empty, dapp is supposed to call
        // eth_requestAccounts.  Returning [] for unauthorized origins is fine.
        return this._accounts as T;

      case 'eth_requestAccounts':
        // Fast-path: if we already have an authorized account cached (i.e. the
        // user previously approved this origin and `accountsChanged` populated
        // `_accounts`), return it directly without a SW round-trip. wagmi /
        // some test dapps spam this method on every render — without the cache
        // each call costs page → content → SW hop. Cache is invalidated by
        // `accountsChanged([])` event on disconnect, so revoke still re-prompts.
        if (this._accounts.length > 0) return this._accounts as T;
        break;

      case 'web3_clientVersion':
        // Don't impersonate MetaMask in clientVersion — Chrome Web Store §8
        // (IP infringement) flags any string containing "MetaMask/...".
        // The `isMetaMask: true` flag on the provider object stays (industry
        // compatibility marker), but identification strings must be ours.
        // Version is INLINED at build time from manifest.json via Bun's
        // `define: { __WALLET_VERSION__: ... }` — inject.ts runs in MAIN
        // world so chrome.runtime isn't available at runtime, but build-
        // time substitution keeps the string in sync without manual edits.
        return `Aladdin/${__WALLET_VERSION__}` as T;

      case 'wallet_getCapabilities':
        // chrome.md §2.5 — only declare capabilities we truly implement.
        // wallet_sendCalls is not implemented yet → return empty caps.
        return {} as T;

      case 'wallet_requestPermissions': {
        // chrome.md §2.8 — wagmi shimDisconnect calls this BEFORE
        // eth_requestAccounts. Resolve by triggering a connect and returning
        // the EIP-2255 permission shape.
        const accounts = await this.forward<string[]>({ method: 'eth_requestAccounts' });
        return [
          {
            parentCapability: 'eth_accounts',
            caveats: [{ type: 'filterResponse', value: accounts }],
          },
        ] as T;
      }

      case 'wallet_getPermissions':
        return (
          this._accounts.length > 0
            ? [
                {
                  parentCapability: 'eth_accounts',
                  caveats: [{ type: 'filterResponse', value: this._accounts }],
                },
              ]
            : []
        ) as T;

      case 'wallet_revokePermissions':
        // We treat this as a soft-disconnect: clear local accounts cache and
        // emit accountsChanged([]). The vault and origin authorization in SW
        // remain — the user re-grants by calling eth_requestAccounts again.
        // (Full revoke is a future feature, exposed in popup settings.)
        this._accounts = [];
        this.fire('accountsChanged', []);
        return null as T;
    }

    // ─── Defensive: unknown wallet_* throws 4200 ──────────────────────────
    if (method.startsWith('wallet_') && !KNOWN_WALLET_METHODS.has(method)) {
      throw rpcError(4200, `unsupported method: ${method}`);
    }

    // ─── Layer 2 / Layer 3: forward to background ─────────────────────────
    const result = await this.forward<T>(args);

    // Side-effect: cache accounts/chain after relevant calls so subsequent
    // sync reads see fresh values without another round-trip.
    if (method === 'eth_requestAccounts' && Array.isArray(result)) {
      this._accounts = result as string[];
      this.fire('accountsChanged', result);
    }
    return result;
  }

  private forward<T>(args: { method: string; params?: unknown }): Promise<T> {
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg: PageToContent = {
        kind: 'rpc-request',
        tag: PROTO_TAG,
        id,
        payload: args as RpcRequest,
      };
      window.postMessage(msg, window.location.origin);
    });
  }

  /** Pull current chain id and accounts from SW once on load so Layer 1
   *  fast paths return correct values from the start. Failures are silent —
   *  first user interaction will route to SW anyway. */
  private async hydrate(): Promise<void> {
    try {
      const c = await this.forward<string>({ method: 'eth_chainId' });
      if (typeof c === 'string') this._chainIdHex = c;
    } catch { /* SW not ready */ }
  }

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeListener(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private fire(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((h) => h(data));
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as ContentToPage | undefined;
    if (!data || data.tag !== PROTO_TAG) return;

    if (data.kind === 'rpc-response') {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      const r = data.response as RpcResponse;
      if ('error' in r) {
        p.reject(Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data }));
      } else {
        p.resolve(r.result);
      }
    } else if (data.kind === 'event') {
      // Cache locally so synchronous callers see the new value.
      if (data.event === 'accountsChanged' && Array.isArray(data.data)) {
        this._accounts = data.data as string[];
      } else if (data.event === 'chainChanged' && typeof data.data === 'string') {
        this._chainIdHex = data.data;
      }
      this.fire(data.event, data.data);
    }
  };
}

const provider = new AladdinProvider();

// Mount under both window.aladdin (our brand) and window.ethereum (so dapps
// that bypass EIP-6963 still find us). Don't smash an existing ethereum
// provider though — let the user pick via EIP-6963.
(window as { aladdin?: unknown }).aladdin = provider;
if (!(window as { ethereum?: unknown }).ethereum) {
  (window as { ethereum?: unknown }).ethereum = provider;
}

// Per-page-load uuid. EIP-6963 specifies `info.uuid` MUST be a
// globally-unique identifier (UUID v4). The shared WALLET_INFO holds
// the stable name / icon / rdns; we override its uuid here with a
// freshly-generated value per page-mount so wagmi / strict EIP-6963
// consumers can distinguish two browser tabs / two reloads as
// distinct sessions instead of treating them as one.
const PAGE_UUID = (() => {
  // crypto.randomUUID is available in every Chromium-based browser
  // that runs MV3 extensions; no fallback needed.
  try { return crypto.randomUUID(); }
  catch { return 'a1b2c3d4-a1ad-4d1a-8f0c-' + Date.now().toString(16).padStart(12, '0'); }
})();

// EIP-6963 wallet announcement. wagmi listens for `eip6963:requestProvider`
// and fires `eip6963:announceProvider` with our info → user sees us in
// connect modal alongside other detected wallets.
function announce() {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({
        info: { ...WALLET_INFO, uuid: PAGE_UUID },
        provider,
      }),
    }),
  );
}
window.addEventListener('eip6963:requestProvider', announce);
announce(); // also announce on load in case dapp already requested
