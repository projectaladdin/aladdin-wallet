// Visual regression snapshots. Catches the class of bug that DOM-only
// assertions miss: jitter on the rotated hero, sub-pixel drift on the
// folding-screen tab overlap, a CSS rule getting stripped during a
// refactor, an emoji disappearing because the font fallback changed.
//
// Run `bunx playwright test --update-snapshots e2e/visual.spec.ts`
// after intentional UI changes to refresh baselines. Without that
// flag, snapshots are diff'd against the committed PNGs in
// `visual.spec.ts-snapshots/` and the test fails on any pixel
// difference above `maxDiffPixelRatio`.
//
// What we DO snapshot:
//   - Dashboard hero (balance + tilted gold card)
//   - Sign-confirm 7702 gate in each resolved state (driven by
//     Sourcify mocks — deterministic)
//   - Send-tx body with decoded calldata (clickable token row)
// What we DON'T snapshot (yet):
//   - Loading / pending states — async timing makes them flaky
//   - Toasts — animate in/out, would need fakeTimers
//   - Settings screens — visual-stable but lower regression risk

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { openTestDapp, connect, triggerSignAndOpenPopup } from './_setup/dapp';
import {
  mockSourcify,
  verifiedContract,
  unverifiedContract,
  unreachableContract,
} from './_setup/network-mocks';
import type { Page } from '@playwright/test';

// Permit2 — canonical singleton at the same address on every chain.
// global-setup leaves the wallet on sepolia by default; the 7702
// handler refuses requests whose chainId mismatches the active
// chain. So the snapshot lives in sepolia world.
const PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SEPOLIA_CID = 11155111;

/** Block until the page's fonts have loaded — without this, snapshots
 *  taken before Press Start 2P / Silkscreen / JetBrains Mono finish
 *  loading show fallback glyphs with different metrics and the
 *  baseline mismatches on every run. */
async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/** Sensible defaults for popup snapshots — small tolerance for
 *  sub-pixel font rendering, name follows the test name. */
const SNAP_OPTS = {
  // 0.5% pixel difference budget. Web fonts render with tiny sub-pixel
  // variance across runs (font hinting, GPU layer compose); 0.5%
  // absorbs that without letting real UI regressions through.
  maxDiffPixelRatio: 0.005,
  // (No element masks by default; specific tests opt in below if a
  //  glyph's font fallback renders inconsistently across Chromium
  //  versions.)
} as const;

test('dashboard initial render', async ({ popup }) => {
  await unlock(popup);
  await fontsReady(popup);
  // Hero anim done (`will-change: transform` settles within a frame).
  await popup.waitForTimeout(200);
  await expect(popup).toHaveScreenshot('dashboard.png', SNAP_OPTS);
});

test('sign-confirm: 7702 verified → unlockable', async ({ context, popupUrl, popup }) => {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([verifiedContract(SEPOLIA_CID, PERMIT2_ADDR)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  // Wait for the gate to resolve past 'pending' before snapping.
  await expect(sign.locator('.aw-slide-track .label')).toContainText(/slide to unlock/i, { timeout: 10_000 });
  await fontsReady(sign);
  await expect(sign).toHaveScreenshot('7702-verified.png', SNAP_OPTS);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('sign-confirm: 7702 unverified → blocked', async ({ context, popupUrl, popup }) => {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([unverifiedContract(SEPOLIA_CID, PERMIT2_ADDR)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  await expect(sign.locator('.aw-slide-track .label')).toContainText(/unverified — refusing/i, { timeout: 10_000 });
  await fontsReady(sign);
  await expect(sign).toHaveScreenshot('7702-unverified.png', SNAP_OPTS);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('sign-confirm: 7702 verifier unreachable', async ({ context, popupUrl, popup }) => {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([unreachableContract(SEPOLIA_CID, PERMIT2_ADDR, 429)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  await expect(sign.locator('.aw-slide-track .label')).toContainText(/verifier unreachable/i, { timeout: 10_000 });
  await fontsReady(sign);
  await expect(sign).toHaveScreenshot('7702-error.png', SNAP_OPTS);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('sign-confirm: send-tx decoded (setApprovalForAll)', async ({ context, popupUrl, popup }) => {
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);

  await dapp.locator('[data-preset="set-approval-all"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.getByText('setApprovalForAll', { exact: false }))
    .toBeVisible({ timeout: 10_000 });
  await fontsReady(sign);
  await expect(sign).toHaveScreenshot('send-tx-setApprovalForAll.png', SNAP_OPTS);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('dashboard: NFTs tab active (folding-screen overlap)', async ({ popup }) => {
  // Pins the folding-screen tab geometry (overlap covers inactive's
  // "MY " prefix, active tab's right edge sits at the seam). DOM-only
  // tests can't catch sub-pixel misalignment here — exactly the bug
  // class that justified the useLayoutEffect measurement pass.
  await unlock(popup);
  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });
  await expect(popup.locator('.aw-assets-tab[aria-selected="true"]')).toHaveText('my NFTs');
  await fontsReady(popup);
  // The slide animation is 300ms; let it settle before snapping.
  await popup.waitForTimeout(400);
  await expect(popup).toHaveScreenshot('dashboard-nfts-tab.png', SNAP_OPTS);
});
