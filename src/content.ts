// Runs in ISOLATED world. Bridges page (MAIN world) ↔ background service
// worker. The page can't talk to chrome.runtime directly; we proxy.

import type {
  ContentToPage,
  FromBackground,
  PageToContent,
  ToBackground,
} from './shared/protocol';
import { PROTO_TAG } from './shared/protocol';

window.addEventListener('message', async (e) => {
  if (e.source !== window) return;
  const data = e.data as PageToContent | undefined;
  if (!data || data.tag !== PROTO_TAG) return;
  if (data.kind !== 'rpc-request') return;

  // Forward to background. Background figures out whether the call needs
  // user interaction (popup) or can be answered directly (eth_chainId etc).
  const msg: ToBackground = {
    kind: 'rpc-from-page',
    origin: window.location.origin,
    payload: data.payload,
  };
  let resp: FromBackground;
  try {
    resp = await chrome.runtime.sendMessage(msg);
  } catch (err) {
    resp = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const back: ContentToPage = {
    kind: 'rpc-response',
    tag: PROTO_TAG,
    id: data.id,
    response: resp.ok
      ? { jsonrpc: '2.0', id: data.id, result: resp.data }
      : {
          jsonrpc: '2.0',
          id: data.id,
          // Preserve the EIP-1193 code if background passed one (4001 user
          // rejected, 4200 unsupported, 4902 unrecognised chain, etc.) — wagmi
          // and friends branch on `err.code`. Fallback to -32603 (generic
          // internal error) only when no specific code was attached.
          error: { code: resp.code ?? -32603, message: resp.error },
        },
  };
  window.postMessage(back, window.location.origin);
});

// Forward extension-emitted events down to the page. Used for
// accountsChanged / chainChanged when the user switches things in the popup.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind !== 'event' || msg?.tag !== PROTO_TAG) return;
  window.postMessage(msg as ContentToPage, window.location.origin);
});
