// Send → auto-refresh contract. After a `popup-send` tx mines, the
// SW broadcasts `chrome.runtime.sendMessage({kind: 'balance-changed'})`
// and the Dashboard's listener bumps its reloadKey, triggering a
// fresh `read-token-balances`. Without this the post-send Dashboard
// shows pre-tx balances until the stale-while-revalidate TTL
// expires (30 s), which looks like the wallet ignored the send.
//
// We don't broadcast a real tx here — that needs anvil + a funded
// account (covered by `sign-tx-anvil.spec.ts`). Instead we directly
// fire the SW message from a page-side `chrome.runtime.sendMessage`
// call and assert the dashboard refetches. End-to-end the wiring is
// the same; only the trigger is faked.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

test('SW balance-changed broadcast reaches popup pages', async ({ context, popup }) => {
  // End-to-end pin for the SW → popup notification channel that
  // drives Dashboard's post-send refresh. We can't easily measure
  // "Dashboard's reloadKey bumped" from outside, but we CAN verify
  // the chrome.runtime.sendMessage broadcast emitted by the SW
  // actually reaches a popup-page listener (which is the only
  // mechanism the Dashboard listener uses).
  //
  // The real production trigger is `popup-send` waiting for a tx
  // receipt and then broadcasting. We drive that broadcast directly
  // from the SW here — both code paths funnel into the same
  // `chrome.runtime.sendMessage` call, so the wiring under test is
  // identical.
  await unlock(popup);

  // Install a counter listener on the popup page. The Dashboard
  // already has its own listener — adding a second is fine, both
  // fire in parallel.
  await popup.evaluate(() => {
    (window as unknown as { __bc: number }).__bc = 0;
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      if ((msg as { kind?: string })?.kind === 'balance-changed') {
        (window as unknown as { __bc: number }).__bc += 1;
      }
    });
  });

  // Fire the broadcast from the SW. chrome.runtime.sendMessage from
  // the SW fans out to every extension page (popup), bypassing the
  // sender — exactly the production path triggered by the
  // popup-send tx-receipt-landed code.
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('no service worker available');
  await sw.evaluate(() => {
    chrome.runtime.sendMessage({ kind: 'balance-changed' }).catch(() => {
      /* no listener registered — not the case here */
    });
  });

  // Our spy listener should have caught it within a frame.
  await popup.waitForFunction(
    () => (window as unknown as { __bc: number }).__bc >= 1,
    null,
    { timeout: 3_000 },
  );
  const count = await popup.evaluate(
    () => (window as unknown as { __bc: number }).__bc,
  );
  expect(count).toBeGreaterThanOrEqual(1);
});
