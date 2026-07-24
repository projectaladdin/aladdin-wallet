// Token row click → detail modal regression. Mirror of the NFT
// detail-modal flow added earlier; tokens now share the same scheme:
// click a row → big icon + balance + contract (truncated, copy-on-
// click) + Send CTA that closes the modal and routes to SendScreen
// pre-selected on this token.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

function patchTokenBalances(text: string) {
  // Patch BOTH `list-tokens` (initial render seed) AND
  // `read-token-balances{,-stale}` (balance fill). Dashboard merges
  // balances onto the list-tokens output by address; tokens absent
  // from list-tokens get filtered out at merge, so we must hand back
  // a consistent shape from both endpoints.
  const TOKENS_META = [
    { address: 'native', symbol: 'ETH', name: 'Ether',
      decimals: 18, builtin: true, isNative: true },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      symbol: 'USDC', name: 'USD Coin',
      decimals: 6, builtin: true, isNative: false },
  ];
  const TOKENS_WITH_BALANCE = [
    { ...TOKENS_META[0], balance: '1.5',    priceUsd: 2000 },
    { ...TOKENS_META[1], balance: '123.45', priceUsd: 1 },
  ];
  return `(() => {
    const guard = '__tok_${text}';
    const w = window;
    if (w[guard]) return;
    w[guard] = true;
    const META = ${JSON.stringify(TOKENS_META)};
    const WITH_BAL = ${JSON.stringify(TOKENS_WITH_BALANCE)};
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((msg, cb) => {
      if (msg && typeof cb === 'function') {
        if (msg.kind === 'list-tokens') {
          queueMicrotask(() => cb({ ok: true, data: META }));
          return undefined;
        }
        if (msg.kind === 'read-token-balances' || msg.kind === 'read-token-balances-stale') {
          queueMicrotask(() => cb({
            ok: true,
            data: { tokens: WITH_BAL, ethUsdRate: null },
          }));
          return undefined;
        }
      }
      return native(msg, cb);
    });
  })();`;
}

test('Token row click opens detail modal with balance + value + contract', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchTokenBalances('usdc') });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);

  // Tokens tab is default. Find the USDC row, click it.
  const usdc = p.locator('.aw-trow').filter({ hasText: 'USDC' });
  await expect(usdc).toBeVisible({ timeout: 10_000 });
  await usdc.click();

  // Modal renders with the token's full identity.
  const modal = p.locator('.aw-modal');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal.locator('.aw-modal-title')).toHaveText('USDC');
  await expect(modal).toContainText('USD Coin');
  // Balance row prominent.
  await expect(modal.locator('.aw-modal-balance .val')).toContainText('123.45');
  await expect(modal.locator('.aw-modal-balance .val')).toContainText('USDC');
  // Contract address truncated `0xXXXX…XXXX`, NOT the full 42-char string.
  const addr = modal.locator('.aw-modal-addr');
  await expect(addr).toContainText('0xa0b8');
  await expect(addr).toContainText('eb48');
  await expect(addr).toContainText('…');
  await expect(modal).not.toContainText('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  // Decimals + standard.
  await expect(modal).toContainText('6');
  await expect(modal).toContainText('ERC-20');

  // Close via ✕.
  await modal.locator('.aw-modal-close').click();
  await expect(modal).toBeHidden();
});

test('Native token row click opens detail modal — no contract row', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchTokenBalances('native') });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);

  const eth = p.locator('.aw-trow').filter({ hasText: 'ETH' }).first();
  await expect(eth).toBeVisible({ timeout: 10_000 });
  await eth.click();

  const modal = p.locator('.aw-modal');
  await expect(modal.locator('.aw-modal-title')).toHaveText('ETH');
  // Native = no contract address to copy. The whole row is omitted.
  await expect(modal).not.toContainText('contract');
  await expect(modal.locator('.aw-modal-addr')).toHaveCount(0);
  // Standard label is "Native", not "ERC-20".
  await expect(modal).toContainText('Native');
});

test('Modal Send CTA navigates to SendScreen pre-selected on that token', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchTokenBalances('cta') });
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);

  // Open USDC modal, click the Send CTA.
  await p.locator('.aw-trow').filter({ hasText: 'USDC' }).click();
  const modal = p.locator('.aw-modal');
  await modal.getByRole('button', { name: /send USDC/i }).click();

  // Modal closes, SendScreen renders with USDC pre-selected: the
  // token-picker pill text reads 'USDC' (not the default 'pick' /
  // 'ETH' fallback).
  await expect(modal).toBeHidden();
  await expect(p.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });
  await expect(p.locator('.aw-amt-token-trigger')).toContainText('USDC');
});
