// Navigation: Send + Receive screens render and back-button returns to
// Dashboard. Catches: SendScreen import wiring, ReceiveScreen import +
// QR generation, Header `onBack` closure capturing setScreen correctly.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

test('dashboard → send screen renders + back returns', async ({ popup }) => {
  await unlock(popup);

  await popup.getByRole('button', { name: /send/i }).first().click();

  // SendScreen 'edit' phase: amount input present, "send" sticker on header.
  await expect(popup.locator('.aw-amt-input')).toBeVisible();
  await expect(popup.locator('.aw-sticker-green')).toContainText('send');

  // Header back button → Dashboard. The cog (settings) only renders on
  // Dashboard, so its presence after back proves we're back home.
  await popup.getByRole('button', { name: 'back' }).click();
  await expect(popup.getByRole('button', { name: 'settings' })).toBeVisible();
});

test('dashboard tokens/NFTs tab switch + AddNFT screen', async ({ popup }) => {
  await unlock(popup);

  // Tokens tab is the default active state — token list visible.
  await expect(popup.locator('.aw-assets-tab[aria-selected="true"]')).toHaveText('my tokens');
  // "+ add token" strip is the only add-strip in tokens-tab state.
  await expect(popup.getByText(/\+ add token/i)).toBeVisible();

  // Click the NFTs tab. The folding-screen overlap covers the inactive
  // tab's "my " prefix (~50 px on the left), so Playwright's default
  // center-click hits the active tab on top. Click towards the right
  // portion of the inactive tab where its "NFTs" word is visible.
  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });
  await expect(popup.locator('.aw-assets-tab[aria-selected="true"]')).toHaveText('my NFTs');
  await expect(popup.getByText('no NFTs yet')).toBeVisible();
  await expect(popup.getByText(/\+ add NFT/i)).toBeVisible();

  // Click "+ add NFT" → AddNFT screen opens.
  await popup.getByText(/\+ add NFT/i).click();
  await expect(popup.locator('.aw-card-title')).toHaveText('add NFT');
  await expect(popup.locator('input.aw-input')).toHaveCount(2);

  // Cancel back to Dashboard (lands on whichever tab was active —
  // dashboard re-mounts in default tokens state, that's fine for v1).
  await popup.getByRole('button', { name: 'cancel' }).click();
  await expect(popup.getByRole('button', { name: 'settings' })).toBeVisible();
});

test('AddNFT screen: tokenId is required; CTA disabled until address + tokenId valid', async ({ popup }) => {
  await unlock(popup);

  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });
  await popup.getByText(/\+ add NFT/i).click();
  await expect(popup.locator('.aw-card-title')).toHaveText('add NFT');

  const inputs = popup.locator('input.aw-input');
  const cta = popup.getByRole('button', { name: /^import$/i });

  // Address only — CTA still disabled (tokenId required now).
  await inputs.first().fill('0x1234567890123456789012345678901234567890');
  await expect(cta).toBeDisabled();

  // Address + tokenId — enabled.
  await inputs.nth(1).fill('42');
  await expect(cta).toBeEnabled();

  await popup.getByRole('button', { name: 'cancel' }).click();
  await expect(popup.getByRole('button', { name: 'settings' })).toBeVisible();
});

test('dashboard → receive screen renders QR + back returns', async ({ popup }) => {
  await unlock(popup);

  await popup.getByRole('button', { name: /receive/i }).first().click();

  // ReceiveScreen header sticker, "scan me" stamp, and both visual layers
  // of the QR (the qrcode-generated SVG + the AccountGlyph overlay
  // glyph centered on top). Two SVGs both inside `.aw-qr-frame` is the
  // signal that QRCode.toString resolved AND the address-derived avatar
  // mounted — covers the qrcode lib + AccountGlyph import path together.
  await expect(popup.locator('.aw-sticker-green')).toContainText('receive');
  await expect(popup.locator('.aw-receive-stamp')).toHaveText('scan me');
  await expect(popup.locator('.aw-qr-frame svg')).toHaveCount(2, { timeout: 10_000 });
  // The QR itself is the first SVG (smaller viewBox); the glyph overlay is
  // the second. Both must be visible for the receive screen to be usable.
  await expect(popup.locator('.aw-qr-frame svg').first()).toBeVisible();
  await expect(popup.locator('.aw-qr-frame svg').nth(1)).toBeVisible();

  // Back to Dashboard.
  await popup.getByRole('button', { name: 'back' }).click();
  await expect(popup.getByRole('button', { name: 'settings' })).toBeVisible();
});
