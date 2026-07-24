// Playwright global setup — runs ONCE before the whole suite.
//
// Onboards the wallet (Welcome → seed reveal → password → Dashboard) in
// a throwaway profile, then dumps the extension's `chrome.storage.local`
// (vault, accounts, settings) as JSON. Each test's `popup` fixture
// loads this snapshot into a fresh profile before opening the popup,
// so individual tests start on the **unlock** screen instead of paying
// the ~3-5 s onboarding cost. PBKDF2 600k iters is the slowest part of
// onboarding; doing it once vs. ~20 times trims minutes off the suite.
//
// What we don't snapshot:
//   - `chrome.storage.session` — the unlocked-mnemonic cache. Session
//     storage is per-browser-process and naturally clears on context
//     reopen; tests unlock once with the password. That's deliberate:
//     the post-onboard "locked but onboarded" state is the realistic
//     warm start for almost every wallet flow worth testing.
//   - Cookies / IndexedDB / other extension-storage areas — the wallet
//     doesn't use them.
//
// Tests that genuinely need a fresh-install profile (the onboarding
// flow itself, the first-unlock screen) use the `pristinePopup`
// fixture instead, which skips the snapshot injection.

import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onboard } from './helpers';

const EXTENSION_PATH = resolve(__dirname, '../../dist');
export const SNAPSHOT_PATH = resolve(__dirname, '../.e2e-fixtures/onboarded-storage.json');

export default async function globalSetup(): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'aladdin-e2e-globalsetup-'));
  const headed = !!process.env.HEADED;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      ...(headed ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    const extensionId = sw.url().split('/')[2]!;

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await onboard(popup);

    // Switch to Sepolia BEFORE snapshotting so every test inherits a
    // testnet active chain. Mainnet defaults make e2e tests look
    // suspiciously close to real user activity (real addresses, real
    // signatures against real chainIds) — testnet is the appropriate
    // sandbox. Tests that explicitly need mainnet call
    // `switchToMainnet(popup)` from _helpers.ts.
    const SEPOLIA_CHAIN_ID = 11155111;
    await popup.evaluate(async (cid: number) => {
      await chrome.runtime.sendMessage({ kind: 'switch-chain', chainId: cid });
    }, SEPOLIA_CHAIN_ID);

    await popup.close();

    // Snapshot AFTER the popup is closed so any in-flight render
    // effects (e.g. balance fetch) have settled — we capture the
    // post-onboard steady state rather than mid-flight intermediates.
    const snapshot = await sw.evaluate(async () => {
      return await chrome.storage.local.get(null);
    });

    mkdirSync(resolve(__dirname, '../.e2e-fixtures'), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
