// Pre-flight simulation pill in sign-confirm. The SW already has a
// working `simulate-tx` handler that runs `eth_call` and reports
// revert. The UI side now surfaces the result as a tri-state pill:
//   - 'pending' while the SW responds  (yellow ⏳)
//   - 'pass'    when sim succeeded     (green ✓)
//   - 'fail' is paired with the existing detailed revert banner;
//     we don't render an extra pill in that state — the banner
//     already covers it.
// We patch `simulate-tx` at chrome.runtime so the test fires a
// deterministic response without needing a real RPC.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { connect, openTestDapp, triggerSignAndOpenPopup } from './_setup/dapp';

/** Force `simulate-tx` to return the given canned response. Other
 *  kinds pass through to the real SW so unlock + token fetch still
 *  work. Init script — call BEFORE the page that should be patched
 *  navigates. */
function patchSim(response: 'pass' | 'fail' | 'unavail') {
  let body: string;
  if (response === 'pass') {
    body = `queueMicrotask(() => cb({ ok: true, data: { ok: true } }));`;
  } else if (response === 'fail') {
    body = `queueMicrotask(() => cb({ ok: true, data: { ok: false, error: 'insufficient allowance' } }));`;
  } else {
    body = `queueMicrotask(() => cb({ ok: true, data: null }));`;
  }
  return `(() => {
    const w = window;
    const g = '__sim_${response}';
    if (w[g]) return;
    w[g] = true;
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((msg, cb) => {
      if (msg && msg.kind === 'simulate-tx' && typeof cb === 'function') {
        ${body}
        return undefined;
      }
      return native(msg, cb);
    });
  })();`;
}

async function setupConnectedDapp(
  context: import('@playwright/test').BrowserContext,
  popup: import('@playwright/test').Page,
  popupUrl: string,
) {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  return dapp;
}

test('sim pass → green "✓ simulation passed — no revert" pill', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchSim('pass') });
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Approve preset is the default in the multi-scenario panel — pick
  // it explicitly to be deterministic regardless of preset re-orders.
  await dapp.locator('[data-preset="approve"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');

  // Pill appears with the pass class. Use the locator filter to
  // tolerate any tween between 'pending' and 'pass' states.
  await expect(sign.locator('.aw-sim-pill.is-pass'))
    .toBeVisible({ timeout: 10_000 });
  await expect(sign.locator('.aw-sim-pill.is-pass'))
    .toContainText(/simulation passed/i);
  // No red revert banner.
  await expect(sign.getByText(/simulation says this tx will revert/i)).toHaveCount(0);

  await sign.getByRole('button', { name: /reject/i }).click();
  await sign.close().catch(() => {});
});

test('sim fail → red revert banner with reason; no extra success pill', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchSim('fail') });
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="approve"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');

  // Detailed revert banner from the body. The exact reason came from
  // our patched response.
  await expect(sign.getByText(/simulation says this tx will revert/i))
    .toBeVisible({ timeout: 10_000 });
  await expect(sign.getByText(/insufficient allowance/i)).toBeVisible();
  // Success pill must NOT render in fail state.
  await expect(sign.locator('.aw-sim-pill.is-pass')).toHaveCount(0);

  await sign.getByRole('button', { name: /reject/i }).click();
  await sign.close().catch(() => {});
});

test('sim unavailable (null) → neither pill nor revert banner', async ({ context, popupUrl, popup }) => {
  // The SW returns null when the chain doesn't support eth_call sim
  // or the wallet's locked. UI should stay quiet — no green pill, no
  // red banner.
  await context.addInitScript({ content: patchSim('unavail') });
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="approve"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');

  // The action card itself still renders, but no sim feedback.
  await expect(sign.locator('.aw-action-card h4').first()).toBeVisible({ timeout: 10_000 });
  await expect(sign.locator('.aw-sim-pill.is-pass')).toHaveCount(0);
  await expect(sign.getByText(/simulation says this tx will revert/i)).toHaveCount(0);

  await sign.getByRole('button', { name: /reject/i }).click();
  await sign.close().catch(() => {});
});
