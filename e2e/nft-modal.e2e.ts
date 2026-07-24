// Send-NFT UX coverage. We don't broadcast a real transaction here
// (anvil broadcast is covered by send-nft-anvil.spec.ts). Instead we
// drive the wallet into a state where an NFT exists in storage, then
// verify:
//   - the "send ↗" button appears on the card
//   - clicking it opens NftDetailModal's send view with the right NFT pre-filled
//   - form validation (recipient hex, amount for 1155)
//   - cancel returns to dashboard with state intact

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

type FakeNft = {
  address: string;
  tokenId: string;
  standard: 'ERC721' | 'ERC1155';
  name: string;
  image: string | null;
  description: string | null;
  addedAt: number;
};
const FAKE_NFT_721: FakeNft = {
  address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', // BAYC-style
  tokenId: '42',
  standard: 'ERC721',
  name: 'Test Ape #42',
  image: null,
  description: null,
  addedAt: Date.now(),
};
const FAKE_NFT_1155: FakeNft = {
  address: '0x495f947276749ce646f68ac8c248420045cb7b5e', // OpenSea shared
  tokenId: '7',
  standard: 'ERC1155',
  name: 'Test Collectible',
  image: null,
  description: null,
  addedAt: Date.now(),
};

/** Inject NFT records into the wallet's storage directly via the SW
 *  (more reliable than `popup.evaluate` — the SW doesn't get torn
 *  down between test reloads).
 *  Layout matches `src/core/storage.ts`:
 *    chrome.storage.local.nfts = Record<chainId, Record<addr::tokenId, NftRecord>>
 *  Default sepolia chainId since global-setup leaves wallet there. */
async function injectNfts(
  context: import('@playwright/test').BrowserContext,
  nfts: FakeNft[],
  chainId = 11155111,
): Promise<void> {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('no service worker available');
  await sw.evaluate(async ({ entries, cid }) => {
    const existing = ((await chrome.storage.local.get('nfts')).nfts ?? {}) as Record<number, Record<string, unknown>>;
    if (!existing[cid]) existing[cid] = {};
    for (const n of entries) {
      const key = `${n.address.toLowerCase()}::${n.tokenId}`;
      existing[cid]![key] = { ...n, address: n.address.toLowerCase() };
    }
    await chrome.storage.local.set({ nfts: existing });
  }, { entries: nfts, cid: chainId });
}

test('NFT card "send ↗" opens the unified detail/send modal in send view', async ({ context, popup }) => {
  // Both "click card" (detail view) and "click send ↗" (send view)
  // now route into the SAME `.aw-modal` overlay — the standalone
  // send-nft screen was retired so the visual scheme matches the
  // detail expand. This test asserts the send-↗ entrypoint lands
  // directly on send view with the recipient input visible.
  await injectNfts(context, [FAKE_NFT_721]);
  await unlock(popup);

  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });

  await expect(popup.getByText('Test Ape #42')).toBeVisible({ timeout: 10_000 });

  await popup.locator('.aw-nft-send').first().click();

  const modal = popup.locator('.aw-modal');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal.locator('.aw-modal-title')).toHaveText('Test Ape #42');
  // Send view shows recipient input + "send it" (disabled until
  // valid hex); detail-view kv list is not rendered.
  await expect(modal.locator('input[placeholder="0x…"]')).toBeVisible();
  await expect(modal.getByRole('button', { name: /send it/i })).toBeDisabled();
  await expect(modal).not.toContainText('contract');

  // Cancel returns to detail view (same modal), NOT to dashboard.
  await modal.getByRole('button', { name: /cancel/i }).click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('contract');
});

test('Send view: invalid recipient blocks submit; valid enables it', async ({ context, popup }) => {
  await injectNfts(context, [FAKE_NFT_721]);
  await unlock(popup);

  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });
  await popup.locator('.aw-nft-send').first().click();

  const modal = popup.locator('.aw-modal');
  const recipient = modal.locator('input[placeholder="0x…"]');
  const cta = modal.getByRole('button', { name: /send it/i });

  await recipient.fill('not-an-address');
  await expect(cta).toBeDisabled();
  await recipient.fill('0xabc');
  await expect(cta).toBeDisabled();
  await recipient.fill('0x1111111111111111111111111111111111111111');
  await expect(cta).toBeEnabled();
});

test('Dashboard ERC-1155 card shows "×N" count + click opens detail modal', async ({ context, popup }) => {
  // Inject an ERC-1155 with a non-trivial balance so the card has
  // something interesting to show.
  await injectNfts(context, [{ ...FAKE_NFT_1155, balance: '5' } as unknown as FakeNft]);
  await unlock(popup);

  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });

  // Card carries the ×5 badge on the tokenId line.
  const card = popup.locator('.aw-nft-card').filter({ hasText: 'Test Collectible' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator('.aw-nft-count')).toHaveText(/×\s*5/);

  // Click the card (NOT the send button) → detail modal opens.
  await card.click();
  const modal = popup.locator('.aw-modal');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  // Title = NFT name, balance row visible with "× 5".
  await expect(modal.locator('.aw-modal-title')).toHaveText('Test Collectible');
  await expect(modal.locator('.aw-modal-balance .val')).toHaveText('× 5');
  await expect(modal).toContainText('ERC1155');

  // Contract: rendered as truncated `0xXXXX…XXXX`, NOT the full 42-char
  // string. Click the address button opens explorer in a new tab — we
  // only assert the truncation here (popup.evaluate of window.open is
  // a separate concern).
  const addrBtn = modal.locator('.aw-modal-addr');
  await expect(addrBtn).toBeVisible();
  await expect(addrBtn).toContainText('0x495f');  // 0x + first 4
  await expect(addrBtn).toContainText('7b5e');    // last 4
  await expect(addrBtn).toContainText('…');       // truncation glyph
  // Full address should NOT appear anywhere in the visible modal —
  // mojibake-prone descriptions also removed entirely.
  await expect(modal).not.toContainText('0x495f947276749ce646f68ac8c248420045cb7b5e');

  // Close via the ✕ button.
  await modal.locator('.aw-modal-close').click();
  await expect(modal).toBeHidden();
});

test('Send view: ERC-1155 shows amount input; ERC-721 does not', async ({ context, popup }) => {
  await injectNfts(context, [FAKE_NFT_721, FAKE_NFT_1155]);
  await unlock(popup);

  const nftsTab = popup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });

  // The 721 card — open the modal in send view, no amount input.
  await popup.locator('.aw-nft-card').filter({ hasText: 'Test Ape #42' }).locator('.aw-nft-send').click();
  let modal = popup.locator('.aw-modal');
  await expect(modal.locator('.aw-modal-title')).toHaveText('Test Ape #42');
  await expect(modal.getByText('amount', { exact: true })).toHaveCount(0);
  await modal.locator('.aw-modal-close').click();

  // The 1155 card — same modal, amount input now present.
  await popup.locator('.aw-nft-card').filter({ hasText: 'Test Collectible' }).locator('.aw-nft-send').click();
  modal = popup.locator('.aw-modal');
  await expect(modal.locator('.aw-modal-title')).toHaveText('Test Collectible');
  await expect(modal.getByText('amount', { exact: true })).toBeVisible();
});
