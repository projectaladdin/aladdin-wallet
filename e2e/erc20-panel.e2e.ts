// ERC-20 multi-scenario panel regression. Mirrors the NFT-panel
// shape: deploy / mint / transfer / approve / watchAsset presets,
// each pre-fills a different input subset, single Run button
// dispatches against either the fixture compile endpoint
// (/compile/erc20) or `eth_sendTransaction` for state-mutating
// actions. We assert the *form-side contract* (visibility +
// preset selection); broadcast-side e2e lives in anvil tests when
// foundry is on PATH.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { connect, openTestDapp } from './_setup/dapp';

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

test('ERC-20 panel — renders with 5 presets and a Run button', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Run button is always visible (no per-action hide). Inputs are
  // dynamic — covered by the field-visibility test below. Here we
  // only assert structural presence in the DOM (count + attached),
  // not visibility, so the deploy-default's hide-contract doesn't
  // give a false negative.
  await expect(dapp.locator('#erc20-run')).toBeVisible();
  expect(await dapp.locator('#erc20-contract').count()).toBe(1);
  expect(await dapp.locator('#erc20-name').count()).toBe(1);
  expect(await dapp.locator('#erc20-symbol').count()).toBe(1);
  expect(await dapp.locator('#erc20-decimals').count()).toBe(1);
  expect(await dapp.locator('#erc20-amount').count()).toBe(1);
  expect(await dapp.locator('#erc20-recipient').count()).toBe(1);

  // 5 chips: deploy / mint / transfer / approve / watch-asset.
  await expect(dapp.locator('.erc20-preset')).toHaveCount(5);
});

test('ERC-20 panel — input rows hide/show per selected action', async ({ context, popupUrl, popup }) => {
  // Same "show what action consumes, hide what it ignores" pattern as
  // the NFT panels — the user-reported confusion was inputs showing
  // for actions that wouldn't use them.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  const panel = dapp.locator('#erc20-run').locator('xpath=ancestor::div[contains(@class, "nft-panel")]');

  // deploy → name / symbol / decimals only (no contract / amount / recipient)
  await dapp.locator('[data-action="deploy-erc20"]').click();
  await expect(panel.locator('[data-field="name"]')).toBeVisible();
  await expect(panel.locator('[data-field="symbol"]')).toBeVisible();
  await expect(panel.locator('[data-field="decimals"]')).toBeVisible();
  await expect(panel.locator('[data-field="contract"]')).toBeHidden();
  await expect(panel.locator('[data-field="amount"]')).toBeHidden();
  await expect(panel.locator('[data-field="recipient"]')).toBeHidden();

  // mint → contract + amount, no recipient (mint goes to caller `me`)
  await dapp.locator('[data-action="mint-erc20"]').click();
  await expect(panel.locator('[data-field="contract"]')).toBeVisible();
  await expect(panel.locator('[data-field="amount"]')).toBeVisible();
  await expect(panel.locator('[data-field="recipient"]')).toBeHidden();
  await expect(panel.locator('[data-field="name"]')).toBeHidden();

  // transfer → contract + amount + recipient
  await dapp.locator('[data-action="transfer-erc20"]').click();
  await expect(panel.locator('[data-field="recipient"]')).toBeVisible();
  await expect(panel.locator('[data-field="amount"]')).toBeVisible();

  // approve → contract + amount + recipient (recipient = spender)
  await dapp.locator('[data-action="approve-erc20"]').click();
  await expect(panel.locator('[data-field="recipient"]')).toBeVisible();
  await expect(panel.locator('[data-field="amount"]')).toBeVisible();
  // approve-erc20 preset pre-fills amount with 'max' for the
  // unlimited-allowance scam scenario the wallet's UI must call out.
  await expect(panel.locator('#erc20-amount')).toHaveValue('max');

  // watchAsset → contract only
  await dapp.locator('[data-action="watch-asset-erc20"]').click();
  await expect(panel.locator('[data-field="contract"]')).toBeVisible();
  await expect(panel.locator('[data-field="amount"]')).toBeHidden();
  await expect(panel.locator('[data-field="recipient"]')).toBeHidden();
});
