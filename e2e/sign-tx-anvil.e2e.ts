// Anvil-backed sign-confirm tests — the modes that need a real RPC to
// be useful (eth_sendTransaction with native value, ERC-20 approve
// calldata). Anvil fixture starts a local EVM, dapp adds it as a custom
// chain via `wallet_addEthereumChain`, switches to it, and the wallet's
// HD account gets pre-funded via `anvil_setBalance` so estimation +
// broadcast actually work.

import type { Page } from '@playwright/test';
import { test, expect, anvilAvailable } from './_setup/extension';
import { unlock } from './_setup/helpers';

// All tests in this file need the `anvil` binary (foundry) on PATH.
// Without it, the `anvil` fixture's spawn() throws ENOENT mid-launch
// and Playwright reports an unhelpful "test exited unexpectedly".
// Probe once at file-load and skip the whole describe if missing,
// so a fresh-install dev machine (or minimal CI image) sees a clean
// "anvil not installed — skipping" instead of red failures.
test.skip(!anvilAvailable(), 'anvil binary not in PATH — install foundry to run these tests');
import {
  addAnvilChainAndSwitch,
  connect,
  openTestDapp,
  setAnvilBalance,
  triggerSignAndOpenPopup,
  walletAccount,
} from './_setup/dapp';

/** Onboard wallet, open dapp, connect, add+switch to Anvil, fund the
 *  wallet's account. Returns the dapp page ready for tx tests. */
async function setupAnvilDapp(
  context: import('@playwright/test').BrowserContext,
  popup: Page,
  popupUrl: string,
  anvil: { rpcUrl: string; chainId: number; account: `0x${string}` },
): Promise<Page> {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await addAnvilChainAndSwitch(context, dapp, popupUrl, anvil);

  // Fund the wallet's randomly-derived address with 100 ETH so eth_estimateGas
  // and the broadcast path don't fail on insufficient balance. anvil_setBalance
  // is instant; uses the same precision as a real `eth_sendTransaction` write.
  const me = await walletAccount(dapp);
  // 100 ETH = 0x56bc75e2d63100000 wei
  await setAnvilBalance(anvil.rpcUrl, me, '0x56bc75e2d63100000');

  return dapp;
}

test('eth_sendTransaction native transfer → SendTxBody → broadcast', async ({
  context, popupUrl, popup, anvil,
}) => {
  const dapp = await setupAnvilDapp(context, popup, popupUrl, anvil);

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx');

  // Mode = sendtx → SendTxBody renders with "send transaction" h4 + the
  // native value preview + chain badge for our custom Anvil chain.
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // Decoded summary should show `to` (our placeholder 0x...1234) and value.
  await expect(sign.getByText('0x0000000000000000000000000000000000001234', { exact: false })).toBeVisible();

  // The signing button is "send it" (mode-specific cta in SignConfirmBody).
  await sign.getByRole('button', { name: /send it/i }).click();

  // Wait for the dapp's #result to populate with the tx hash. The dapp's
  // call() helper writes the raw return value into #result and the
  // {method, params} pair into #request, so a successful
  // eth_sendTransaction lands a 32-byte hash in #result.
  await expect(dapp.locator('#request')).toContainText(/eth_sendTransaction/i, { timeout: 30_000 });
  await expect(dapp.locator('#result')).toContainText(/0x[a-fA-F0-9]{64}/, { timeout: 30_000 });

  // Verify the tx actually landed on Anvil (not just that the wallet
  // returned a hash). Pull the hash, query Anvil, expect a real receipt.
  const resultJson = await dapp.locator('#result').innerText();
  const hashMatch = resultJson.match(/0x[a-fA-F0-9]{64}/);
  expect(hashMatch).not.toBeNull();
  const txHash = hashMatch![0];

  const rpc = await fetch(anvil.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash] }),
  });
  const rpcBody = (await rpc.json()) as { result?: { hash?: string; to?: string } };
  expect(rpcBody.result?.hash?.toLowerCase()).toBe(txHash.toLowerCase());
  expect(rpcBody.result?.to?.toLowerCase()).toBe('0x0000000000000000000000000000000000001234');

  await sign.close().catch(() => {});
});

test('broadcast failure (insufficient funds) → toast truncates verbose viem error', async ({
  context, popupUrl, popup, anvil,
}) => {
  // Regression guard: viem's InsufficientFundsError message is ~1 KB of
  // multi-paragraph explainer + full calldata. Without a cap on the
  // toast text it grows past the popup viewport. The SW + popup-side
  // truncation cuts the visible string well below the viewport width;
  // this test forces the exact error to fire by draining the wallet
  // account to 0 ETH then approving a tx.
  const dapp = await setupAnvilDapp(context, popup, popupUrl, anvil);

  // Drain to 0 — every subsequent gas-bearing tx now fails at broadcast.
  const me = await walletAccount(dapp);
  await setAnvilBalance(anvil.rpcUrl, me, '0x0');

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx');
  // sign-confirm should render normally — the failure surfaces only on
  // approve, not at queue time.
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });

  await sign.getByRole('button', { name: /send it/i }).click();

  // Wallet's approve() catches the viem throw and feeds it to the
  // sign-confirm reject-toast path; combined SW + popup-side trimming
  // keeps the visible string short enough to fit the popup viewport.
  const toast = sign.locator('.aw-toast.red');
  await expect(toast).toBeVisible({ timeout: 15_000 });
  const text = (await toast.innerText()).trim();
  // Bounded length — toast text + leading icon must NOT contain the
  // full 1 KB+ viem dump. We allow some slack (icon char + ellipsis +
  // a few line-feed renderings) on top of 160.
  expect(text.length).toBeLessThanOrEqual(180);
  // Ends in our truncation marker (or fits entirely — but viem's error
  // is well over 160 chars, so ellipsis is expected here).
  expect(text.endsWith('…')).toBe(true);

  await sign.close().catch(() => {});
});

test('eth_sendTransaction approve calldata → ApproveBody (capped/max toggle)', async ({
  context, popupUrl, popup, anvil,
}) => {
  const dapp = await setupAnvilDapp(context, popup, popupUrl, anvil);

  // Approve preset is the default in the multi-scenario panel, but
  // click it explicitly to be defensive against future default flips.
  await dapp.locator('[data-preset="approve"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');

  // Approve calldata routes to mode 'approve' → ApproveBody: distinctive
  // h4 "token approval" + capped/max toggle.
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('token approval', { timeout: 10_000 });
  // Capped + max ∞ buttons present.
  await expect(sign.getByRole('button', { name: 'capped' })).toBeVisible();
  await expect(sign.getByRole('button', { name: 'max ∞' })).toBeVisible();
  // Dapp asked for unlimited (uint256.max) — the body should default to
  // 'max' and show ∞ in the big display.
  await expect(sign.locator('.aw-approve-display .big')).toContainText('∞');

  // Reject without broadcasting — Approve mode needs no Anvil
  // confirmation, just the render pin.
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});
