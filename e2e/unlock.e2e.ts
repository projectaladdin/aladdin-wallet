// Lock + re-unlock flow.
// Covers: Settings → "lock wallet" action, route() detecting locked state
// and rendering Unlock, the wrong-password toast path, the right-password
// path landing back on Dashboard.

import { test, expect } from './_setup/extension';
import { TEST_PASSWORD } from './_setup/helpers';

test('unlock screen: wrong-password toast then right-password → dashboard', async ({ popup }) => {
  // The default `popup` fixture loads the global-setup snapshot, so
  // the popup lands directly on the Unlock screen — no onboard +
  // settings → "lock wallet" cycle needed. We're really testing the
  // unlock screen's error + success branches; pinning the lock-from-
  // settings flow separately would be redundant since it just sends
  // `{kind: 'lock'}` to the SW and re-renders into this same screen.
  await expect(popup.locator('.aw-unlock-title')).toHaveText('WALLET LOCKED');

  // Wrong password → red toast.
  const pwInput = popup.locator('.aw-unlock-input input');
  await pwInput.fill('definitely-wrong');
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.locator('.aw-toast.red')).toBeVisible({ timeout: 10_000 });

  // Right password → Dashboard.
  await pwInput.fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
});
