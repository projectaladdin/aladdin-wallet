// Clipboard + Esc shortcut hooks. Both patterns were duplicated 5+
// times across popup screens (dashboard / send / receive / sign-
// confirm / settings) — same try/writeText/toast for copy, same
// keydown+cleanup for Esc. Lifted here to one source of truth.

import { useCallback, useEffect } from 'react';
import { useToast } from '../shared';

/** Returns a `copy(text, label?)` callback. Fires a green toast on
 *  success (`${label} copied`) or a red one on failure. `label`
 *  defaults to "address" — most call sites copy an Ethereum address. */
export function useCopyToClipboard() {
  const showToast = useToast();
  return useCallback(async (text: string, label = 'address'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ tone: 'green', icon: '📋', text: `${label} copied` });
    } catch {
      showToast({ tone: 'red', icon: '⚠', text: 'copy failed' });
    }
  }, [showToast]);
}

/** Wire `onClose` to the document Escape key. Auto-detaches on
 *  unmount and respects the `enabled` flag (e.g. ignore Esc while
 *  a broadcast is in flight). Cancels in capture phase so it wins
 *  against any deeper handlers. */
export function useEscapeKey(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, enabled]);
}
