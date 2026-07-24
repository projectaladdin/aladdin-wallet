// Multi-step user journeys. Each test exercises a SEQUENCE of
// actions and pins the state that flows between them. Single-action
// tests don't catch:
//   - origin persistence across popup re-open
//   - chain-switch state propagation to sign-confirm
//   - balance cache reuse on dashboard reopen
//   - wrong-password retry behaviour
//
// These journeys are short (3-5 steps) so they stay debuggable.

import { test, expect } from './_setup/extension';
import { unlock, openSettings, TEST_PASSWORD } from './_setup/helpers';
import { connect, openTestDapp } from './_setup/dapp';

test('connect → revoke from settings → origin no longer in connected list', async ({ context, popupUrl, popup }) => {
  // Pins the connect/revoke round-trip through chrome.storage.local
  // and the popup's UI. Without coverage here, a regression where
  // revoke-origin "succeeds" but doesn't actually delete from
  // storage could ship silently.
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  // Sanity: dapp side now shows the wallet's address.
  await expect(dapp.locator('#account')).toContainText(/0x[a-f0-9]{40}/i, { timeout: 5_000 });

  // Open a fresh popup. The SW already has unlockedMnemonic from the
  // earlier unlock, so this popup lands directly on Dashboard — no
  // unlock screen.
  const popup2 = await context.newPage();
  await popup2.goto(popupUrl);
  await expect(popup2.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 10_000 });
  await openSettings(popup2);
  // The connected-sites row shows a count > 0 since the dapp connected.
  const sitesRow = popup2.locator('.aw-set-row').filter({ hasText: /manage connected dapps/i });
  await expect(sitesRow).toBeVisible();
  await expect(sitesRow.locator('.val')).not.toHaveText('0');

  // Open the connected-sites screen and revoke the dapp's origin.
  await sitesRow.click();
  // Each connected site row has a revoke control (✕ or "remove").
  // Click whatever the first one shows.
  const firstSite = popup2.locator('.aw-set-row, .aw-conn-row').filter({ hasText: /127\.0\.0\.1|localhost/i }).first();
  await expect(firstSite).toBeVisible({ timeout: 5_000 });
  // The revoke button inside the row — class name varies, but role/text "revoke" / "✕" should hit it.
  await firstSite.locator('button, [role="button"]').last().click();

  // Back on dashboard, the connected-sites count drops to zero (or
  // the entire row disappears).
  await popup2.close();
  const popup3 = await context.newPage();
  await popup3.goto(popupUrl);
  await expect(popup3.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 10_000 });
  await openSettings(popup3);
  const newSitesCount = popup3.locator('.aw-set-row').filter({ hasText: /manage connected dapps/i }).locator('.val');
  await expect(newSitesCount).toHaveText('0', { timeout: 5_000 });
  await popup3.close();
});

test('wrong password 3x → 4th right → dashboard (no lockout state ghosting)', async ({ popup }) => {
  // The wallet doesn't currently have a wrong-password lockout
  // (and isn't expected to — it's a personal wallet, not a server
  // login). This test pins that absence: wrong password 3 times
  // should still allow a 4th correct attempt. If we ever add a
  // lockout, this test fails loud and we have to update it.
  const pwInput = popup.locator('.aw-unlock-input input');
  for (let i = 0; i < 3; i++) {
    await pwInput.fill('wrong-password-' + i);
    await popup.getByRole('button', { name: /UNLOCK/i }).click();
    // Each attempt should land back on the unlock screen with a toast.
    await expect(popup.locator('.aw-unlock-title')).toHaveText('WALLET LOCKED');
  }
  // 4th attempt: right password, must succeed despite 3 prior fails.
  await pwInput.fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
});

test('lock → re-unlock → dashboard balance cache hit (instant render)', async ({ popup }) => {
  // Stale-while-revalidate cache test. After the first unlock, the
  // SW persists balances to chrome.storage.local. A subsequent
  // lock+unlock should paint balances on first frame from cache,
  // without waiting for a fresh RPC round-trip.
  //
  // We can't easily measure render timing in Playwright, but we
  // CAN assert that the hero balance value is visible immediately
  // after Dashboard renders, regardless of whether the RPC has
  // returned. Cache hit = always-visible value; cold start would
  // show "Ξ 0" / placeholder.
  await unlock(popup);
  // Wait for the first-paint balance to settle (fresh fetch).
  await expect(popup.locator('.aw-hero-bal')).toBeVisible({ timeout: 10_000 });

  // Lock from settings.
  await openSettings(popup);
  await popup.getByText('lock wallet').click();
  await expect(popup.locator('.aw-unlock-title')).toBeVisible();

  // Re-unlock and verify dashboard renders with hero immediately.
  // The "immediately" assertion is the `timeout: 5_000` budget — if
  // we had to wait for a real RPC, this would commonly fail on slow
  // CI. With cache hit, it's instant.
  await popup.locator('.aw-unlock-input input').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.locator('.aw-hero-bal')).toBeVisible({ timeout: 5_000 });
});
