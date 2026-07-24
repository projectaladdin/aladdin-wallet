// Settings operations end-to-end. The Settings screen owns three
// state-mutating flows that production users hit:
//   - auto-lock timer adjustment (idle minutes before re-lock)
//   - currency toggle (ETH vs USD display)
//   - reset wallet (wipes encrypted vault + all per-browser state)
//
// Each was previously rendered-but-untested. SW persistence is the
// load-bearing contract for the first two; the reset flow is the
// only path in the wallet that calls `chrome.storage.local.clear()`
// and lands the popup back on Welcome.

import { test, expect } from './_setup/extension';
import { unlock, openSettings, onboard, TEST_PASSWORD } from './_setup/helpers';

test('auto-lock timer: pick 1 hour → persists across popup reopen', async ({ context, popup, popupUrl }) => {
  await unlock(popup);
  await openSettings(popup);

  // Auto-lock card lists 30 min / 1 hour / 2 hours. Each row's
  // text content concatenates icon "⏱" + label + cursor "✓". Use
  // a label match that excludes "2 hours".
  const oneHourRow = popup.locator('.aw-set-row').filter({ hasText: '1 hour' }).first();
  await expect(oneHourRow).toBeVisible();
  await oneHourRow.click();

  // h4 reflects the choice immediately (single source of truth from
  // the autoLock state hook).
  await expect(popup.locator('.aw-set-card h4').filter({ hasText: /auto-lock/i }))
    .toContainText(/1 hour/i);

  // Cross-popup persistence: open a fresh popup, navigate to
  // Settings, the 1-hour row should be the highlighted one.
  const probe = await context.newPage();
  await probe.goto(popupUrl);
  await expect(probe.getByRole('button', { name: 'settings' })).toBeVisible({ timeout: 10_000 });
  await probe.getByRole('button', { name: 'settings' }).click();
  await expect(probe.locator('.aw-set-card h4').filter({ hasText: /auto-lock/i }))
    .toContainText(/1 hour/i);
  await probe.close();
});

test('currency toggle: USD → ETH switches hero display', async ({ popup }) => {
  await unlock(popup);

  // Dashboard hero default is USD — the balance is prefixed with a "$"
  // glyph. Pin that as the canonical "in USD mode" marker.
  await expect(popup.locator('.aw-hero-bal')).toContainText('$');

  await openSettings(popup);
  // Currency card has two rows; pick the ETH one by its inner
  // `.label` text (avoids matching the nested sub-line copy).
  await popup.locator('.aw-set-row .label')
    .filter({ hasText: /^ETH/ })
    .first()
    .click();
  // h4 reflects the choice.
  await expect(popup.locator('.aw-set-card h4').filter({ hasText: /currency/i }))
    .toContainText(/ETH/);

  // Back to dashboard — hero now renders the ETH glyph "Ξ".
  await popup.getByRole('button', { name: 'back' }).click();
  await expect(popup.locator('.aw-hero-bal')).toContainText('Ξ');
});

test('reset wallet: confirm checkbox gates the wipe button', async ({ popup }) => {
  await unlock(popup);
  await openSettings(popup);
  // Scroll to danger zone and click "reset wallet".
  await popup.getByText(/^reset wallet$/).click();
  await expect(popup.locator('.aw-set-card h4').filter({ hasText: /reset wallet/i })).toBeVisible();

  // Wipe button is initially disabled — the "i have my recovery
  // phrase saved" checkbox must be checked first.
  const wipeBtn = popup.getByRole('button', { name: /reset wallet, no take-backs/i });
  await expect(wipeBtn).toBeDisabled();

  // Tick the box → button enables.
  await popup.locator('input[type="checkbox"]').check();
  await expect(wipeBtn).toBeEnabled();

  // Don't actually wipe — destructive. Back out via the Header's
  // ← back button (use `exact: true` to disambiguate from the wipe
  // button's accessible name).
  await popup.getByRole('button', { name: 'back', exact: true }).click();
  // Land back on Settings.
  await expect(popup.getByText('lock wallet')).toBeVisible();
});

test('reset wallet: actually wiping lands on Welcome screen', async ({ pristinePopup: popup }) => {
  // Use the pristine fixture so we can onboard a throwaway wallet,
  // wipe it, and verify the Welcome screen returns — without
  // affecting OTHER tests' snapshot-injected state.
  await onboard(popup);
  await popup.getByRole('button', { name: 'settings' }).click();
  await popup.getByText(/^reset wallet$/).click();
  await popup.locator('input[type="checkbox"]').check();
  await popup.getByRole('button', { name: /reset wallet, no take-backs/i }).click();

  // Wipe finishes — popup re-routes to Welcome (no vault on disk).
  await expect(popup.locator('.aw-welcome-title'))
    .toHaveText('ALADDIN', { timeout: 15_000 });
});

// Sanity: TEST_PASSWORD is exported. Some tests in other files
// reference it via _helpers; mention here keeps the import warmed.
void TEST_PASSWORD;
