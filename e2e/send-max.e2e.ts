// Regression guard for the Send-screen MAX-button bug. The SW's
// `read-token-balances` response doesn't carry a `loaded` field —
// Dashboard tracks that flag locally for stale-while-revalidate UX.
// SendScreen used to `setTokens(reply.tokens)` raw, leaving every row
// at `loaded: undefined`, which made the MAX button's disabled check
// (`!selected.loaded`) permanently true. Fix: SendScreen now stamps
// `loaded: true` on every fetched row. This test intercepts the
// SW response so we can deterministically deliver a non-zero balance
// regardless of fixture chain state.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

test('Send MAX button: enabled after balance fetch returns a non-zero amount', async ({ context, popupUrl, popup }) => {
  // Patch `read-token-balances` to return one native row with 1.5 ETH
  // BEFORE popup.js boots — the popup's send-screen mount fires this
  // RPC and consumes whatever we hand back. Other kinds pass through
  // so unlock / get-account / chain reads still hit the real SW.
  await context.addInitScript(() => {
    const w = window as unknown as { __maxPatched?: boolean };
    if (w.__maxPatched) return;
    w.__maxPatched = true;
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    (chrome.runtime as unknown as { sendMessage: typeof native }).sendMessage = ((
      msg: { kind?: string },
      cb?: (resp: unknown) => void,
    ) => {
      if (msg?.kind === 'read-token-balances' && typeof cb === 'function') {
        queueMicrotask(() => cb({
          ok: true,
          data: {
            tokens: [{
              address: 'native',
              symbol: 'ETH',
              name: 'Ether',
              decimals: 18,
              builtin: true,
              isNative: true,
              // 1.5 ETH — deliberately well above the gas reserve so
              // MAX can compute a non-zero sendable amount.
              balance: '1.5',
              priceUsd: null,
              // NOTE: no `loaded` field here — that's the SW contract.
              // SendScreen must stamp `loaded: true` itself.
            }],
            ethUsdRate: null,
          },
        }));
        return undefined as unknown as Promise<unknown>;
      }
      return (native as (...args: unknown[]) => unknown)(msg, cb!) as Promise<unknown>;
    }) as typeof native;
  });

  // Reopen the fixture popup so the init script runs against a fresh
  // page (init scripts only fire on navigation; the popup fixture
  // was created before we registered the patch).
  await popup.close().catch(() => {});
  const fresh = await context.newPage();
  await fresh.goto(popupUrl);
  await unlock(fresh);

  await fresh.getByRole('button', { name: /send/i }).first().click();
  await expect(fresh.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });

  // Wait for the patched token to land. The balance value shows on the
  // small `.aw-amt-balance .val` strip above the picker pill.
  await expect(fresh.locator('.aw-amt-balance .val')).toContainText('1.5', { timeout: 10_000 });

  // MAX button must be enabled (the bug: it was disabled because
  // selected.loaded === undefined → `!undefined` → true → disabled).
  const maxBtn = fresh.locator('.aw-amt-max');
  await expect(maxBtn).toBeVisible();
  await expect(maxBtn).toBeEnabled();

  // Clicking MAX fills the amount input. For native sends, MAX
  // subtracts the gas reserve, so the resulting amount is just under
  // 1.5 — we assert it's a positive number string, not zero.
  await maxBtn.click();
  const amt = await fresh.locator('.aw-amt-input').inputValue();
  expect(Number(amt)).toBeGreaterThan(0);
  expect(Number(amt)).toBeLessThanOrEqual(1.5);
});

test('Send MAX button: stays disabled when balance reads back as 0', async ({ context, popupUrl, popup }) => {
  // Mirror test for the OTHER half of the disabled condition: a real
  // zero balance should still disable MAX (no sendable amount). This
  // pins the `Number(balance) <= 0` branch so a future "always enable"
  // refactor doesn't accidentally allow click-MAX-on-empty-wallet.
  await context.addInitScript(() => {
    const w = window as unknown as { __maxPatched0?: boolean };
    if (w.__maxPatched0) return;
    w.__maxPatched0 = true;
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    (chrome.runtime as unknown as { sendMessage: typeof native }).sendMessage = ((
      msg: { kind?: string },
      cb?: (resp: unknown) => void,
    ) => {
      if (msg?.kind === 'read-token-balances' && typeof cb === 'function') {
        queueMicrotask(() => cb({
          ok: true,
          data: {
            tokens: [{
              address: 'native', symbol: 'ETH', name: 'Ether',
              decimals: 18, builtin: true, isNative: true,
              balance: '0', priceUsd: null,
            }],
            ethUsdRate: null,
          },
        }));
        return undefined as unknown as Promise<unknown>;
      }
      return (native as (...args: unknown[]) => unknown)(msg, cb!) as Promise<unknown>;
    }) as typeof native;
  });

  await popup.close().catch(() => {});
  const fresh = await context.newPage();
  await fresh.goto(popupUrl);
  await unlock(fresh);

  await fresh.getByRole('button', { name: /send/i }).first().click();
  await expect(fresh.locator('.aw-amt-input')).toBeVisible({ timeout: 10_000 });
  // Balance row displays the 0 we faked.
  await expect(fresh.locator('.aw-amt-balance .val')).toContainText('0', { timeout: 10_000 });

  await expect(fresh.locator('.aw-amt-max')).toBeDisabled();
});
