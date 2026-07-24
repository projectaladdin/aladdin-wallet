// Onboarding smoke — Welcome → Create → seed reveal → password → dashboard.
// Covers: Header, Welcome, Create (both steps), PasswordSetCard, the send()
// RPC bridge, vault encrypt+persist on background, route() landing on
// Dashboard. Single test, ~30 s, catches the bulk of the popup-refactor
// regression surface in one shot.

import { test, expect } from './_setup/extension';
import { onboard, unlock, TEST_PASSWORD } from './_setup/helpers';

test('first-run onboarding lands on dashboard', async ({ pristinePopup: popup }) => {
  // 1. Welcome screen — brand title + the two welcome-option buttons.
  await expect(popup.locator('.aw-welcome-title')).toHaveText('ALADDIN');
  await expect(popup.getByText('create new wallet')).toBeVisible();
  await expect(popup.getByText('import seed phrase')).toBeVisible();

  // 2. Click "create new wallet" → Create step 'backup'.
  await popup.getByText('create new wallet').click();
  const reveal = popup.getByText('TAP TO REVEAL SEED');
  await expect(reveal).toBeVisible();

  // 3. Reveal the seed → 12 cells render.
  await reveal.click();
  await expect(popup.locator('.aw-seed-cell')).toHaveCount(12);
  // Spot-check that real words landed (every cell has a non-empty word).
  const firstWord = await popup.locator('.aw-seed-word').first().innerText();
  expect(firstWord.trim().length).toBeGreaterThan(0);

  // 4. Advance to password step.
  await popup.getByText('I WROTE IT DOWN →').click();
  await expect(popup.locator('.aw-card-title')).toHaveText('password');

  // 5. Fill password + confirm. The two inputs are bare <input type="password">
  //    inside the card; locate by order rather than name (no name attr).
  const inputs = popup.locator('input[type="password"]');
  await expect(inputs).toHaveCount(2);
  await inputs.nth(0).fill(TEST_PASSWORD);
  await inputs.nth(1).fill(TEST_PASSWORD);

  // 6. Submit.
  await popup.getByRole('button', { name: 'create wallet' }).click();

  // 7. Land on Dashboard — assert send + receive action buttons appear.
  //    PBKDF2 600k iters is the bottleneck here; allow a generous timeout
  //    since headless on slower machines / CI can run 1.5–3 s.
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
  await expect(popup.getByRole('button', { name: /receive/i }).first())
    .toBeVisible();
});

// Sanity check that the onboard() helper used by other specs actually
// produces the same end state. If this passes but the long version above
// fails, the helper has drifted.
test('onboard() helper reaches dashboard', async ({ pristinePopup: popup }) => {
  await onboard(popup);
});
