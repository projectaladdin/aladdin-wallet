// Lock-state behaviour. The wallet's security model rests on:
//   - manual lock (Settings → "lock wallet")
//   - auto-lock (idle timeout via chrome.alarms)
//   - lock clears `unlockedMnemonic` AND session-scoped dev flags
// Each of these was previously untested. This file pins them.

import { test, expect } from './_setup/extension';
import { unlock, openSettings, TEST_PASSWORD } from './_setup/helpers';

test('manual lock from Settings → unlock screen reappears', async ({ popup }) => {
  await unlock(popup);
  await openSettings(popup);

  await popup.getByText('lock wallet').click();
  await expect(popup.locator('.aw-unlock-title')).toHaveText('WALLET LOCKED');

  // Re-unlock to confirm round-trip — vault still encrypts with the
  // same password, so the right password lands on Dashboard.
  await popup.locator('.aw-unlock-input input').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
});

test('session danger override clears on lock', async ({ popup }) => {
  // The `allowUnverifiedDelegate` flag is session-scoped (lives in
  // chrome.storage.session, cleared on lock). This test pins that
  // promise end-to-end: enable → lock → re-unlock → flag is off.
  await unlock(popup);

  // Enable the flag via the SW message protocol (faster than driving
  // the two-stage settings confirm UI; we're testing the lock-clear
  // contract here, not the UI).
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({
      kind: 'set-dev-flag',
      key: 'allowUnverifiedDelegate',
      value: true,
    });
  });
  const before = await popup.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ kind: 'get-dev-flags' });
    return r.data as { allowUnverifiedDelegate?: boolean };
  });
  expect(before.allowUnverifiedDelegate).toBe(true);

  // Lock.
  await openSettings(popup);
  await popup.getByText('lock wallet').click();
  await expect(popup.locator('.aw-unlock-title')).toHaveText('WALLET LOCKED');

  // Re-unlock and read the flag back.
  await popup.locator('.aw-unlock-input input').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });

  const after = await popup.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ kind: 'get-dev-flags' });
    return r.data as { allowUnverifiedDelegate?: boolean };
  });
  // Session-scoped: must be undefined or false after the lock cycle.
  expect(after.allowUnverifiedDelegate).toBeFalsy();
  // Sanity — persistent flags (none set in this test) shouldn't ghost.
  expect(Object.keys(after).filter((k) => (after as Record<string, unknown>)[k] === true))
    .toHaveLength(0);
});

test('auto-lock alarm fires → wallet locks', async ({ context, popup }) => {
  // Drives the real chrome.alarms.onAlarm pathway by creating an
  // alarm named exactly `auto-lock` (what the SW listens for) with a
  // near-immediate `when`. The wallet's listener doesn't care which
  // process scheduled it; the same code-path executes.
  //
  // Unpacked-extension Chrome lets us schedule alarms with no minimum
  // delay (the 30-second minimum applies to packed/published
  // extensions only). If this becomes flaky on a future Chrome
  // version, fall back to setting auto-lock minutes to 1 and using
  // page.clock.fastForward.
  await unlock(popup);

  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('no service worker available');
  await sw.evaluate(async () => {
    await chrome.alarms.create('auto-lock', { when: Date.now() + 100 });
  });

  // Wait for the alarm to fire and the lock handler to clear state.
  // The popup auto-routes to Unlock when route() sees the wallet is
  // locked — but route() only re-runs on the next is-unlocked poll,
  // which happens on focus or storage events. Force a re-check by
  // reloading the popup.
  await popup.waitForTimeout(1_500);
  await popup.reload();
  await expect(popup.locator('.aw-unlock-title'))
    .toHaveText('WALLET LOCKED', { timeout: 10_000 });
});

test('auto-lock clears session danger override (parity with manual lock)', async ({ context, popup }) => {
  // The SW's chrome.alarms.onAlarm handler must mirror the case 'lock'
  // message handler — both paths terminate the unlock and BOTH must
  // clear session-scoped dev flags. If the alarm path ever forgets
  // to call clearSessionDevFlags(), this catches it.
  await unlock(popup);
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({
      kind: 'set-dev-flag',
      key: 'allowUnverifiedDelegate',
      value: true,
    });
  });

  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('no service worker available');
  await sw.evaluate(async () => {
    await chrome.alarms.create('auto-lock', { when: Date.now() + 100 });
  });
  await popup.waitForTimeout(1_500);
  await popup.reload();
  await expect(popup.locator('.aw-unlock-title'))
    .toHaveText('WALLET LOCKED', { timeout: 10_000 });

  // Re-unlock and confirm flag is gone.
  await popup.locator('.aw-unlock-input input').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: /UNLOCK/i }).click();
  await expect(popup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 15_000 });
  const after = await popup.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ kind: 'get-dev-flags' });
    return r.data as { allowUnverifiedDelegate?: boolean };
  });
  expect(after.allowUnverifiedDelegate).toBeFalsy();
});
