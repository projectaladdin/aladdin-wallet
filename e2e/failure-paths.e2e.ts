// Failure-mode coverage. The wallet must degrade gracefully when
// external services fail — Sourcify rate-limited, DefiLlama down,
// dapp sending malformed input. These scenarios occur in production
// and the happy-path tests don't catch them.
//
// Strategy: use Playwright's `context.route()` to intercept specific
// network endpoints and force errors, then verify the wallet's UI
// either falls back safely (no crash, no signed tx) or shows a
// clear error to the user.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { connect, openTestDapp, triggerSignAndOpenPopup } from './_setup/dapp';
import { mockSourcify, unreachableContract } from './_setup/network-mocks';

// Permit2 — canonical singleton, same address on every chain. We
// use the sepolia deployment because global-setup leaves the wallet
// on sepolia (wallet rejects 7702 sigs whose request chainId ≠
// active chain).
const PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SEPOLIA_CID = 11155111;

test('Sourcify 500 → 7702 gate shows "verifier unreachable" (not "unverified")', async ({ context, popupUrl, popup }) => {
  // Distinguishing 5xx (transient — user should retry) from 404
  // (definitive — contract genuinely not on Sourcify) is the
  // wallet's UX contract. A 500 must NOT collapse into "unverified"
  // because that would tell the user to give up when they should
  // retry.
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([unreachableContract(SEPOLIA_CID, PERMIT2_ADDR, 500)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  await expect(sign.locator('.aw-slide-track .label'))
    .toContainText(/verifier unreachable/i, { timeout: 10_000 });
  // Body banner: distinct copy from the 404/unverified case (retry hint).
  await expect(sign.locator('.aw-verify-block').first()).toContainText(/retry/i);
  // NOT the unverified copy.
  await expect(sign.locator('.aw-verify-block').first()).not.toContainText(/not auditable/i);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('Sourcify network rejection → 7702 gate falls to "verifier unreachable"', async ({ context, popupUrl, popup }) => {
  // Simulate TCP-level failure (DNS resolves but connection refused
  // / DNS fails) by aborting the route. The wallet's fetch wrapper
  // catches and resolves to `status: 'error'`.
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await context.route('**/sourcify.dev/**', (route) => route.abort('connectionrefused'));

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  await expect(sign.locator('.aw-slide-track .label'))
    .toContainText(/verifier unreachable/i, { timeout: 10_000 });
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('DefiLlama down → dashboard still renders (USD fallback / Ξ 0)', async ({ context, popup }) => {
  // DefiLlama outage shouldn't break the wallet. The hero should
  // display whatever it can — Ξ 0 or $0.00 — and the token list
  // should still show with placeholder balances.
  await context.route('**/coins.llama.fi/**', (route) => route.abort('connectionrefused'));
  await unlock(popup);
  // Dashboard's hero renders the balance. Whatever the displayed
  // currency, the digits must be present (not a stuck spinner).
  await expect(popup.locator('.aw-hero-bal')).toBeVisible({ timeout: 10_000 });
  // Token list renders — even with zero loaded balances, the rows
  // (or empty state) should be visible.
  await expect(popup.locator('.aw-tokens-head')).toBeVisible();
});

test('publicnode RPC down → dashboard still renders (cached state visible)', async ({ context, popup }) => {
  // If the chain RPC is unreachable, the balance fetch silently
  // fails — but cached state (from stale-while-revalidate) and the
  // local-only data (token list metadata, account address) must
  // still render. Specifically: hero must NOT be stuck loading.
  await context.route('**/publicnode.com/**', (route) => route.abort('connectionrefused'));
  await unlock(popup);
  await expect(popup.locator('.aw-hero-bal')).toBeVisible({ timeout: 10_000 });
  // Address copy button still rendered = popup mounted past initial
  // RPC errors.
  await expect(popup.locator('.aw-hero-addr')).toBeVisible();
});

test('large calldata (10 KB) → sign-confirm renders and rejects cleanly', async ({ context, popupUrl, popup }) => {
  // Some bridge dapps fire txs with 5-10 KB of calldata. The
  // decoder + UI must not choke. Test: send tx with a long random
  // hex blob, verify popup mounts and reject works.
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);

  // Build a 10 KB calldata blob and inject via the dapp's `data` input.
  // 10 KB = 20_000 hex chars + 0x prefix.
  // `to` must be exactly 40 hex chars (20 bytes) — anything else and
  // the wallet rejects upstream before sign-confirm renders.
  const largeData = '0xdeadbeef' + 'aa'.repeat(10_000);
  await dapp.locator('#tx-to').fill('0x' + '00'.repeat(18) + 'abcd');
  await dapp.locator('#tx-data').fill(largeData);
  await dapp.locator('#tx-value').fill('0x0');

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // Function row shows raw selector with byte count (the fallback).
  await expect(sign.getByText(/0xdeadbeef/)).toBeVisible();
  // Reject works even with the large blob in state.
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

// NOTE: a connect-coalesce e2e (5 parallel `eth_requestAccounts` →
// only 1 popup) was attempted here but the page-lifecycle interaction
// between the fixture's auto-closed `popup` and the test-opened
// approval page is too fragile to be useful — the test would
// false-fail on teardown timing rather than on the wallet contract.
// COALESCE_METHODS is exercised at the unit level via the connect
// fixture and `setupConnectedDapp` boilerplate (which runs once per
// connection); the SW's resolver-list dedup is straight code, not a
// state-machine that needs an e2e. Re-attempt this when we have a
// proper `connectionFlow` helper that owns the approval-popup
// lifecycle.
