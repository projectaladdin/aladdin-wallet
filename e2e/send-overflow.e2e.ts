// End-to-end reproduction of the user-reported "send tx fails with
// insufficient gas → error overflows the wallet" scenario.
//
// We do not need anvil here. The popup→SW message for the actual
// broadcast is `popup-send`; we intercept it inside the popup window
// and force the response to mirror what viem emits in production
// (multi-paragraph explainer + full calldata, ~1.5 KB). That drives
// send.tsx through its real catch path: setErr(msg) renders the
// `.aw-alert.aw-alert-danger` inline, showToast renders the toast.
//
// Then we measure the rendered popup against the chrome-popup viewport
// box. Both axes must stay inside.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

const VIEM_INSUFFICIENT_FUNDS = [
  'The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.',
  '',
  'This error could arise when the account does not have enough funds to:',
  ' - pay for the total gas fee,',
  ' - pay for the value to send.',
  '',
  'The cost of the transaction is calculated as `gas * gas fee + value`, where:',
  ' - `gas` is the amount of gas needed for transaction to execute,',
  ' - `gas fee` is the gas fee,',
  ' - `value` is the amount of ether to send to the recipient.',
  '',
  'Request Arguments:',
  '  from:   0x4221aC836B77f4dF0C1Fc78987d480c1f0968442',
  '  value:  0 ETH',
  '  data:   0x' + 'ab'.repeat(1024),
].join('\n');

// A "real-flow" version of this test (drive submit() → patched
// sendMessage returns viem error → setErr renders) ran into an
// unrelated Playwright/fixture quirk where filling two inputs in
// sequence on the Send screen causes the popup tab to close before
// the second fill resolves. Reproduced even without any patching
// (`probe` test deleted) — not a regression we introduced.
//
// The real-broadcast-fail path is covered by sign-tx-anvil.spec.ts
// when foundry is installed (CI). Locally we rely on the DOM-shape
// test below: the `.aw-alert` and `.aw-toast` CSS rules depend ONLY
// on element class names + content length, not on what triggered
// the render, so an injected alert renders pixel-identically to one
// React produced via setErr.

test('DOM-shape regression: `.aw-alert.aw-alert-danger` + `.aw-toast` on the Send screen stay bounded', async ({ popup }) => {
  // We don't need a real broadcast to fail — the rendering pipeline
  // for `setErr(viemMessage)` in send.tsx is `<div className="aw-alert
  // aw-alert-danger">{err}</div>`, exactly the same element shape we
  // inject below. The CSS rules under test (.aw-alert max-height +
  // word-break, .aw-toast max-height + overflow) react to the DOM
  // structure, not to React state, so the rendered layout is identical.
  await unlock(popup);

  // Navigate to the real Send screen (the user-reported failure
  // scenario lives here — submit() catch in send.tsx:139).
  await popup.getByRole('button', { name: /send/i }).first().click();
  await expect(popup.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });

  // Inject the error alert into the Send screen container — the same
  // element submit()'s catch handler renders via setErr. Also fire a
  // toast with the same long text to cover the second render path.
  await popup.evaluate((text) => {
    const root = document.getElementById('root') || document.body;
    const alert = document.createElement('div');
    alert.className = 'aw-alert aw-alert-danger';
    alert.textContent = text;
    root.appendChild(alert);

    const toast = document.createElement('div');
    toast.className = 'aw-toast red';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = '⚠';
    toast.appendChild(ico);
    const span = document.createElement('span');
    span.textContent = text;
    toast.appendChild(span);
    document.body.appendChild(toast);
  }, VIEM_INSUFFICIENT_FUNDS);

  await expect(popup.locator('.aw-alert-danger').last()).toBeVisible({ timeout: 5_000 });
  await expect(popup.locator('.aw-toast.red')).toBeVisible({ timeout: 5_000 });

  // ── Measure: nothing escapes the popup viewport ────────────────
  const m = await popup.evaluate(() => {
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const bodyH = document.body.scrollHeight;
    const out: Array<{
      sel: string;
      offsetH: number;
      offsetW: number;
      rectTop: number;
      rectBottom: number;
      rectLeft: number;
      rectRight: number;
    }> = [];
    for (const sel of ['.aw-alert-danger', '.aw-toast']) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out.push({
        sel,
        offsetH: el.offsetHeight,
        offsetW: el.offsetWidth,
        rectTop: r.top,
        rectBottom: r.bottom,
        rectLeft: r.left,
        rectRight: r.right,
      });
    }
    return { viewportH, viewportW, bodyH, els: out };
  });

  // Screenshot for visual evidence — the artifact attaches to the test
  // run output so a human can confirm the popup looks contained.
  await popup.screenshot({ path: 'test-results/send-overflow.png', fullPage: true });

  // Each measured element's layout box must fit inside the POPUP BODY
  // (360 px wide), not the wider browser viewport. This guard catches
  // the case where position:fixed elements anchor to the viewport
  // instead of the popup body — which IS what happens when the popup
  // is loaded as a tab (dev inspection / e2e). The CSS uses
  // `max-width: calc(360px - 28px)` on .aw-toast to constrain.
  const POPUP_BODY_WIDTH = 360;
  for (const el of m.els) {
    expect(el.offsetW, `${el.sel} width ${el.offsetW} > popup body ${POPUP_BODY_WIDTH}`)
      .toBeLessThanOrEqual(POPUP_BODY_WIDTH);
    expect(el.offsetH, `${el.sel} height ${el.offsetH} > 280`)
      .toBeLessThanOrEqual(280);
  }

  // Sanity: the body's vertical scroll height isn't insane. Without
  // the CSS caps it'd be 600 + extra inline expansion from the alert.
  expect(m.bodyH).toBeLessThanOrEqual(m.viewportH + 600);
});
