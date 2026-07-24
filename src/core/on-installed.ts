// Side effects to run when chrome.runtime.onInstalled fires.
// Extracted from background.ts so the install-vs-update gate can be
// unit-tested directly without pulling the SW's module-level event
// wiring (alarms, contextMenus, full RPC dispatcher) into the test.
//
// Why the `reason === 'install'` gate: chrome.runtime.onInstalled fires
// for `install`, `update`, `chrome_update`, `shared_module_update`.
// `update` lands on every dev reload at chrome://extensions/ — without
// gating, setCurrentChainId(DEFAULT_CHAIN_ID) would clobber the user's
// chosen chain on each reload. Gating preserves persistence;
// getCurrentChainId() falls back to DEFAULT on empty storage so
// first-install defaults still apply.

import { setCurrentChainId } from './storage';
import { DEFAULT_CHAIN_ID } from '../shared/config';

export type OnInstalledReason =
  | 'install'
  | 'update'
  | 'chrome_update'
  | 'shared_module_update';

/** Persistent-state side effects on chrome.runtime.onInstalled.
 *  Only the FIRST install seeds the active chain — every other reason
 *  (update / chrome_update / shared_module_update) leaves storage
 *  alone. background.ts handles in-memory cleanup (unlockedMnemonic /
 *  pending) inline because those don't need extraction for testability. */
export async function seedActiveChainOnInstall(reason: OnInstalledReason): Promise<void> {
  if (reason === 'install') {
    await setCurrentChainId(DEFAULT_CHAIN_ID);
  }
}
