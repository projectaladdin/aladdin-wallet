// Shared helpers for e2e tests. Each spec file gets a fresh persistent
// profile via the `extension` fixture; these helpers run inside that
// fresh profile to bring the wallet into a known state.

import { expect, type Page } from '@playwright/test';

export const TEST_PASSWORD = 'test-password-123';

/** Drive Welcome → Create → seed reveal → password → Dashboard. After this
 *  returns, the popup is on the Dashboard with a freshly-encrypted vault
 *  and the wallet is unlocked. ~3–5 s including PBKDF2 600k iters. */
export async function onboard(popup: Page, password = TEST_PASSWORD): Promise<void> {
  await expect(popup.locator('.aw-welcome-title')).toHaveText('ALADDIN');
  await popup.getByText('create new wallet').click();
  await popup.getByText('TAP TO REVEAL SEED').click();
  await expect(popup.locator('.aw-seed-cell')).toHaveCount(12);
  await popup.getByText('I WROTE IT DOWN →').click();

  const inputs = popup.locator('input[type="password"]');
  await inputs.nth(0).fill(password);
  await inputs.nth(1).fill(password);
  await popup.getByRole('button', { name: 'create wallet' }).click();

  // Dashboard render = onboarding success. Send/Receive action buttons are
  // the most stable Dashboard markers across chain-state variations.
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
}

/** Drive the Unlock screen → Dashboard. The default `popup` fixture
 *  injects an onboarded snapshot, so the popup lands on the Unlock
 *  screen by default; tests call this to reach a usable Dashboard.
 *  Much faster than `onboard()` — one PBKDF2 decrypt vs. an
 *  encrypt+decrypt + 12-cell seed reveal walk. */
export async function unlock(popup: Page, password = TEST_PASSWORD): Promise<void> {
  await expect(popup.locator('.aw-unlock-title')).toHaveText('WALLET LOCKED', { timeout: 10_000 });
  await popup.locator('.aw-unlock-input input').fill(password);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  // Dashboard render = unlock success.
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
}

/** Switch the wallet to a given chainId via SW message. Used by
 *  tests that need to override the default (sepolia, set by
 *  global-setup) — usually for mainnet-specific flows like 7702
 *  signing against Permit2 mainnet. */
export async function switchToChain(popup: Page, chainId: number): Promise<void> {
  await popup.evaluate(async (cid: number) => {
    await chrome.runtime.sendMessage({ kind: 'switch-chain', chainId: cid });
  }, chainId);
}

/** Convenience: switch to Ethereum mainnet (chainId 1). */
export async function switchToMainnet(popup: Page): Promise<void> {
  await switchToChain(popup, 1);
}

/** Open Settings from Dashboard. */
export async function openSettings(popup: Page): Promise<void> {
  // Header's settings cog (⚙ aria-label="settings") is on Dashboard only.
  await popup.getByRole('button', { name: 'settings' }).click();
  await expect(popup.getByText('show recovery phrase')).toBeVisible();
}
