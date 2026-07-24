// ENS reverse-resolution end-to-end. Two surfaces:
//   1. Send screen recipient hint — paste a 0x address, the popup
//      reverse-resolves to a `.eth` name and shows `↳ <name>`
//      below the input.
//   2. Activity row — when the recipient has a known primary name,
//      `→ 0xabc…def` is replaced by `→ vitalik.eth`.
// Both wired through the same SW `resolve-ens-name` handler, which
// we patch at chrome.runtime level so tests don't need a live ENS
// resolver.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** Patch the SW so:
 *  - resolve-ens-name returns the canned map for tested addresses
 *  - read-token-balances returns the minimal stub Send needs
 *  - estimate-tx-cost returns a quiet response (no error toast spam)
 *  Everything else passes through to the real SW. */
function patchEnsReverse() {
  return `(() => {
    const w = window;
    if (w.__ens_patched) return;
    w.__ens_patched = true;
    const NAMES = {
      ${'"' + VITALIK.toLowerCase() + '"'}: 'vitalik.eth',
      ${'"' + ALICE.toLowerCase() + '"'}: null,
    };
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((msg, cb) => {
      if (msg && typeof cb === 'function') {
        if (msg.kind === 'resolve-ens-name') {
          const addr = (msg.address || '').toLowerCase();
          queueMicrotask(() => cb({ ok: true, data: addr in NAMES ? NAMES[addr] : null }));
          return undefined;
        }
        if (msg.kind === 'read-token-balances') {
          queueMicrotask(() => cb({
            ok: true,
            data: { tokens: [
              { address: 'native', symbol: 'ETH', name: 'Ether',
                decimals: 18, builtin: true, isNative: true,
                balance: '1.0', priceUsd: null },
            ], ethUsdRate: null },
          }));
          return undefined;
        }
        if (msg.kind === 'estimate-tx-cost') {
          queueMicrotask(() => cb({ ok: true, data: null }));
          return undefined;
        }
      }
      return native(msg, cb);
    });
  })();`;
}

test('Send screen reverse-resolves a pasted 0x address to its ENS name', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchEnsReverse() });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);

  await p.getByRole('button', { name: /send/i }).first().click();
  await expect(p.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });

  // Paste vitalik's address — debounce is ~350 ms, so we expect the
  // reverse-name hint within a second.
  const recipient = p.locator('input[placeholder*="0x"]');
  await recipient.fill(VITALIK);
  // The hint renders as `↳ vitalik.eth` below the input.
  await expect(p.locator('.aw-field-card').filter({ hasText: '↳ vitalik.eth' }))
    .toBeVisible({ timeout: 3_000 });
});

test('Send screen shows nothing when the pasted address has no primary ENS name', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchEnsReverse() });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);

  await p.getByRole('button', { name: /send/i }).first().click();
  await expect(p.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });

  await p.locator('input[placeholder*="0x"]').fill(ALICE);
  // Settle the debounce window, then assert no `↳` line rendered.
  await p.waitForTimeout(600);
  await expect(p.locator('.aw-field-card').filter({ hasText: '↳' })).toHaveCount(0);
});

test('Activity rows swap truncated 0x… for ENS name when reverse-resolved', async ({ context, popupUrl, popup }) => {
  // Activity screen requires its own list-activity + read-token-info
  // patches alongside resolve-ens-name. Stack them in one init script.
  await context.addInitScript({
    content: `(() => {
      const w = window;
      if (w.__act_ens) return;
      w.__act_ens = true;
      const NAMES = { ${'"' + VITALIK.toLowerCase() + '"'}: 'vitalik.eth' };
      const ITEMS = [{
        hash: '0x' + 'a'.repeat(64),
        chainId: 11155111,
        account: '0x' + 'f'.repeat(40),
        kind: 'send',
        to: '${VITALIK}',
        value: '500000000000000000',
        data: null,
        addedAt: Date.now() - 1000,
        status: 'success',
      }];
      const native = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((msg, cb) => {
        if (msg && typeof cb === 'function') {
          if (msg.kind === 'list-activity' || msg.kind === 'refresh-activity-status') {
            queueMicrotask(() => cb({ ok: true, data: ITEMS }));
            return undefined;
          }
          if (msg.kind === 'read-token-info') {
            queueMicrotask(() => cb({ ok: true, data: {} }));
            return undefined;
          }
          if (msg.kind === 'resolve-ens-name') {
            const addr = (msg.address || '').toLowerCase();
            queueMicrotask(() => cb({ ok: true, data: NAMES[addr] || null }));
            return undefined;
          }
        }
        return native(msg, cb);
      });
    })();`,
  });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);
  await p.getByRole('button', { name: /activity/i }).first().click();

  // Row's recipient detail should swap to `→ vitalik.eth`. We allow a
  // generous timeout — useEnsNames fires asynchronously after the
  // initial render.
  const row = p.locator('.aw-act-row').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.aw-act-line2')).toContainText('vitalik.eth', { timeout: 5_000 });
  await expect(row.locator('.aw-act-line2')).not.toContainText('0xd8dA');
});
