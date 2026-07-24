// Regression guard for the inline `.aw-alert.aw-alert-danger` rule.
// Viem error messages (InsufficientFunds + full calldata) are ~1–2 KB
// of multi-paragraph text. Without `word-break` + `max-height` +
// `overflow-y: auto` on `.aw-alert`, the error block grew past the
// popup viewport (340×600 px) — what the user reports as "the error
// overflows the entire wallet".
//
// We inject a fake `.aw-alert.aw-alert-danger` node into the popup
// DOM with a real-shape viem error string, then measure the rendered
// box. Both axes must stay inside the popup body.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

const VIEM_ERR = [
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
  // Full deploy bytecode — ~2 KB. This is the worst case in the wild
  // (test-dapp ERC-1155 deploy preset emits this exact shape).
  '  data:   0x' + 'ab'.repeat(1024),
].join('\n');

test('`.aw-alert.aw-alert-danger` containing a 2 KB viem error stays inside the popup viewport', async ({ popup }) => {
  // Bring popup to dashboard (any unlocked screen has the global popup
  // body — the .aw-alert rule is global and applies everywhere).
  await unlock(popup);

  // Inject a fake alert node onto the page. Use a real popup body
  // child so it inherits the popup's width context.
  await popup.evaluate((text) => {
    const root = document.getElementById('root') || document.body;
    const el = document.createElement('div');
    el.id = 'test-alert-probe';
    el.className = 'aw-alert aw-alert-danger';
    el.textContent = text;
    root.appendChild(el);
  }, VIEM_ERR);

  const probe = popup.locator('#test-alert-probe');
  await expect(probe).toBeVisible();

  const bodyBox = await popup.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { width: b.width, height: b.height };
  });
  const probeBox = await probe.boundingBox();
  if (!probeBox) throw new Error('probe not laid out');

  // Width: alert must NOT exceed the popup body's width. (Tolerance:
  // 1 px sub-pixel rounding.)
  expect(probeBox.width).toBeLessThanOrEqual(bodyBox.width + 1);

  // Height: max-height: 14em at font-size 13 px ≈ 182 px. We allow
  // up to 240 px to account for any line-height / padding inflation
  // across font metrics. The unbounded version would be 30+ lines
  // (~600 px) — well past our cap.
  expect(probeBox.height).toBeLessThanOrEqual(240);

  // The element scrolls internally instead of growing — scrollHeight
  // is far larger than offsetHeight (proves the cap is doing real
  // work, not just by accident of short content).
  const { scrollHeight, offsetHeight } = await probe.evaluate((el) => ({
    scrollHeight: (el as HTMLElement).scrollHeight,
    offsetHeight: (el as HTMLElement).offsetHeight,
  }));
  expect(scrollHeight).toBeGreaterThan(offsetHeight);
});

test('`.aw-toast` containing a 2 KB viem error stays inside the popup viewport (CSS cap)', async ({ popup }) => {
  // Toast was previously bounded at render-time via a 160-char slice;
  // we now rely on CSS `max-height: 30vh; overflow: hidden` so the
  // FULL message is in the DOM and the user sees the leading lines
  // (most useful for diagnosing the failure) — trailing dump clips.
  await unlock(popup);

  // Inject a toast with the FULL 2 KB text — the cap must come from
  // CSS, not from any sneaky JS truncation upstream.
  await popup.evaluate((text) => {
    const t = document.createElement('div');
    t.id = 'test-toast-probe';
    t.className = 'aw-toast red';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = '💥';
    t.appendChild(ico);
    const span = document.createElement('span');
    span.textContent = text;
    t.appendChild(span);
    document.body.appendChild(t);
  }, VIEM_ERR);

  const probe = popup.locator('#test-toast-probe');
  await expect(probe).toBeVisible();
  // boundingBox() returns the visual rect AFTER `transform: rotate(-1deg)`,
  // which is ~30% taller than the CSS box. Use offsetHeight for the
  // untransformed layout box — that's what max-height: 30vh caps.
  const { offsetHeight, scrollHeight, viewportH } = await probe.evaluate((el) => ({
    offsetHeight: (el as HTMLElement).offsetHeight,
    scrollHeight: (el as HTMLElement).scrollHeight,
    viewportH: window.innerHeight,
  }));

  // 30vh cap at any viewport height — layout box ≤ 30% of viewport.
  // Allow 1 px slack for sub-pixel layout rounding.
  expect(offsetHeight).toBeLessThanOrEqual(viewportH * 0.30 + 1);

  // The full text is in the DOM but visually clipped — scrollHeight
  // exceeds offsetHeight (proves the cap is doing real work).
  expect(scrollHeight).toBeGreaterThan(offsetHeight);
});
