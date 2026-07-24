// Settings + RevealRecovery.
// Covers: Settings render with all rows present; RevealRecovery's password
// challenge → SW `reveal-mnemonic` round-trip → 12 mnemonic cells displayed.
//
// This is the only path in the wallet where the popup directly handles a
// plaintext mnemonic (decrypted in SW, returned via send()), so it's the
// single most security-sensitive screen — worth pinning.

import { test, expect } from './_setup/extension';
import { unlock, openSettings, TEST_PASSWORD } from './_setup/helpers';

test('settings → reveal recovery shows 12 words', async ({ popup }) => {
  await unlock(popup);
  await openSettings(popup);

  // All four primary settings rows render.
  await expect(popup.getByText('show recovery phrase')).toBeVisible();
  await expect(popup.getByText('lock wallet')).toBeVisible();
  await expect(popup.getByText(/auto-lock/i)).toBeVisible();
  await expect(popup.getByText(/network/i)).toBeVisible();

  // Click "show recovery phrase" → password challenge.
  await popup.getByText('show recovery phrase').click();
  await expect(popup.getByText('enter password')).toBeVisible();

  // Type password → reveal phrase.
  await popup.locator('input[type="password"]').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: 'reveal phrase' }).click();

  // 12 mnemonic cells appear, each with a non-empty word.
  await expect(popup.locator('.aw-mnemonic-cell')).toHaveCount(12, { timeout: 10_000 });
  for (let i = 0; i < 12; i++) {
    const word = (await popup.locator('.aw-mnemonic-cell').nth(i).innerText()).trim();
    expect(word.length).toBeGreaterThan(0);
  }

  // "done" returns to Settings.
  await popup.getByRole('button', { name: 'done' }).click();
  await expect(popup.getByText('show recovery phrase')).toBeVisible();
});
