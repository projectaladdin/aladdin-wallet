// Grant-lifecycle e2e (Task 5.3) — drives the full ERC-7715
// `wallet_grantPermissions` flow end to end against the real extension:
//
//   1. the fixture dapp issues a bounded `wallet_grantPermissions` request
//      (one concrete target + a mint/activate allow-list + a future expiry),
//   2. the popup opens on the sign-confirm grant screen and renders the
//      plain-language CAN / CANNOT review the wallet derives from its OWN
//      normalized scope,
//   3. the user approves the grant,
//   4. the Safety Panel (Settings → safety, Task 4.3) lists the now-active
//      session permission (target + scope visible),
//   5. Revoke removes it from the active list.
//
// This is the integration counterpart to the unit coverage in
// tests/grant-request.test.ts / tests/grant-active.test.ts: it proves the
// dapp → SW parse/queue → popup review → approve/record → Safety Panel
// list/revoke wiring holds together through the real content+inject+SW
// message plumbing, not just in isolation.

import type { Page } from '@playwright/test';
import { getAddress } from 'viem';
import { test, expect } from './_setup/extension';
import { unlock, openSettings } from './_setup/helpers';
import { connect, openTestDapp } from './_setup/dapp';

// The fixture dapp's grant button targets this contract with a
// mint(uint256)/activate(uint256,uint8) allow-list. The wallet checksums
// the target via viem's getAddress before storing + displaying it, so we
// assert against the checksummed form (which is what both the sign-confirm
// CAN list and the Safety Panel CAN list render verbatim).
const TARGET = getAddress('0xC0FFEE0000000000000000000000000000C0FFEE');

/** Boilerplate mirrored from sign-confirm.e2e.ts: unlock the pre-seeded
 *  vault, close the popup, open the fixture dapp and connect. Returns the
 *  dapp page; caller closes it. */
async function setupConnectedDapp(
  context: import('@playwright/test').BrowserContext,
  popup: Page,
  popupUrl: string,
): Promise<Page> {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  return dapp;
}

test('grant → review → revoke lifecycle (wallet_grantPermissions)', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // ── 1. dapp fires wallet_grantPermissions ────────────────────────────────
  // Fire-and-forget: the request stays pending in the SW until the user
  // approves in the popup, so we don't await the click's promise here.
  await dapp.locator('#grant-permissions').click();

  // ── 2. popup opens on the grant sign-confirm screen with CAN / CANNOT ─────
  const grant = await context.newPage();
  await grant.goto(popupUrl);

  await expect(grant.locator('.aw-action-card h4').first())
    .toHaveText('grant scoped permission', { timeout: 10_000 });

  // CAN section: the single concrete target + BOTH allowed functions
  // rendered under the "This permission CAN:" heading. Scope the assertion
  // to the CAN block because the target address also (legitimately) appears
  // in the CANNOT block's "Call any contract other than <target>" line.
  // Every line is derived from the wallet's own normalized scope
  // (describeGrantCan), never dapp-supplied copy.
  const canBlock = grant.locator('.aw-grant-block', { hasText: 'This permission CAN:' });
  await expect(canBlock).toBeVisible();
  await expect(canBlock).toContainText(TARGET);
  await expect(canBlock).toContainText('mint(uint256)');
  await expect(canBlock).toContainText('activate(uint256,uint8)');

  // CANNOT section renders (the negative space of the grant).
  await expect(grant.locator('.aw-grant-block', { hasText: 'It CANNOT:' })).toBeVisible();

  // ── 3. approve the grant ─────────────────────────────────────────────────
  // Same primary CTA the other sign-confirm approvals use — grant mode
  // labels it "grant permission".
  await grant.getByRole('button', { name: 'grant permission' }).click();

  // onResolved → route() lands the popup back on the Dashboard once the
  // pending request clears; the settings cog is the canonical marker.
  await expect(grant.getByRole('button', { name: 'settings' }))
    .toBeVisible({ timeout: 10_000 });

  // ── 4. Settings → Safety Panel lists the granted permission ──────────────
  await openSettings(grant);
  await grant.locator('.aw-set-row.is-clickable', { hasText: 'safety panel' }).click();
  // Safety screen header caption.
  await expect(grant.getByText('who can touch your wallet')).toBeVisible({ timeout: 10_000 });

  // The active session grant is listed: exactly one active grant, its kind
  // label, and its scope (target + allowed function via the same CAN line
  // the sign screen showed).
  // The `<h4>active grants · N</h4>` counter (an <h3>no active grants</h3>
  // empty-state heading appears after revoke, so scope to the h4 tag).
  const activeHeading = grant.locator('h4', { hasText: 'active grants' });
  await expect(activeHeading).toContainText('1');
  await expect(grant.getByText('session permission')).toBeVisible();
  // The CAN line names the target; assert it carries the granted address.
  await expect(grant.getByText(/Interact only with the contract at/)).toContainText(TARGET);
  await expect(grant.getByText(/mint\(uint256\)/)).toBeVisible();

  // ── 5. Revoke clears it from the active list ─────────────────────────────
  await grant.getByRole('button', { name: 'revoke' }).click();
  await expect(grant.getByText('no active grants')).toBeVisible({ timeout: 10_000 });
  await expect(activeHeading).toContainText('0');
  // The grant's target no longer appears anywhere on the panel.
  await expect(grant.getByText(TARGET, { exact: false })).toHaveCount(0);

  await dapp.close().catch(() => {});
  await grant.close().catch(() => {});
});
