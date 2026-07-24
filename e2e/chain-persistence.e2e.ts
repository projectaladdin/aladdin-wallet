// Regression guard for chain selection persistence across wallet
// reloads. The user-reported bug: "after reloading the wallet, the
// active chain loses memory" — i.e. switching from default Sepolia
// (seeded by global-setup) to mainnet should survive a popup close +
// reopen. Storage lives in chrome.storage.local which DOES persist
// across SW restarts, so any regression here points at the popup
// boot path mis-reading the persisted value.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

// The onInstalled('update') path that was the root cause of the
// user-reported "reload wipes chain" bug is exercised directly by
// tests/on-installed.test.ts (unit tests over seedActiveChainOnInstall).
// Reproducing it end-to-end via chrome.runtime.reload() inside the
// Playwright context turned out to be unreliable — the extension takes
// 1–3 s to come back, frequently 404ing on goto() — and the unit-level
// gate is the actual contract under test. The e2e below covers the
// downstream half: that chrome.storage.local actually persists across
// popup close + reopen given a working SW.
test('switched chain survives popup close + reopen', async ({ context, popup, popupUrl }) => {
  await unlock(popup);

  // Pin the starting state — fixture seeds Sepolia. If this assertion
  // ever flips, global-setup changed and this test needs updating.
  await expect(popup.locator('.aw-chain-pill')).toContainText(/sepolia/i, { timeout: 5_000 });

  // Switch via the background's switch-chain message — same path the
  // chain-picker uses. Mainnet = chainId 1.
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({ kind: 'switch-chain', chainId: 1 });
  });
  // Pill updates after the switch (the useNetworkState hook re-reads
  // after a switchTo, but switch-chain via raw sendMessage doesn't go
  // through the hook — wait for the storage write then re-render by
  // reopening). Easier: just reopen now and check.
  await popup.close();

  const second = await context.newPage();
  await second.goto(popupUrl);
  // Wallet was already unlocked in the first popup — SW retains the
  // unlocked mnemonic, so the second popup lands directly on Dashboard.
  // Mainnet's viem name is "Ethereum" — must show in the pill, NOT
  // "Sepolia" / default fallback.
  await expect(second.locator('.aw-chain-pill')).toContainText(/ethereum/i, { timeout: 10_000 });
  await expect(second.locator('.aw-chain-pill')).not.toContainText(/sepolia/i);
});
