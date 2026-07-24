// End-to-end NFT send against a real EVM. Steps:
//   1. Spin up anvil (provided by fixture)
//   2. Compile MinimalErc721.sol via solc-js
//   3. Deploy the contract; mint tokenId=42 to the wallet's account
//   4. Connect wallet, switch to anvil chain, fund account
//   5. Inject the NFT record into wallet storage (simulating manual add)
//   6. Drive the NftDetailModal send view → recipient input → broadcast
//   7. Read ownerOf(42) on-chain — confirm it's now the recipient
//
// This is the ONE test in the suite that actually broadcasts an
// NFT-changing tx. The wallet-side `popup-send` path, the gas-tier
// fee bump, the receipt poll, the EIP-1559 fee handling — all
// covered. Requires anvil binary; skipped gracefully without.

import { test, expect, anvilAvailable } from './_setup/extension';
import { unlock } from './_setup/helpers';
import {
  addAnvilChainAndSwitch,
  connect,
  openTestDapp,
  setAnvilBalance,
  walletAccount,
} from './_setup/dapp';
import { deployAndMintErc721, readOwnerOf } from './fixtures/erc721-helpers';

test.skip(!anvilAvailable(), 'anvil binary not in PATH — install foundry to run');

test('deploy ERC-721, mint to wallet, send via UI, verify on-chain owner change', async ({
  context, popupUrl, popup, anvil,
}) => {
  // ── Setup: connect + switch to anvil chain ─────────────────────
  await unlock(popup);
  await popup.close();
  const dapp = await openTestDapp(context);
  await connect(context, dapp, popupUrl);
  await addAnvilChainAndSwitch(context, dapp, popupUrl, anvil);

  const walletAddr = await walletAccount(dapp);
  await setAnvilBalance(anvil.rpcUrl, walletAddr, '0x56BC75E2D63100000'); // 100 ETH

  // ── Deploy + mint to the wallet's HD address ───────────────────
  const TOKEN_ID = 42n;
  const nftContract = await deployAndMintErc721(anvil.rpcUrl, walletAddr, TOKEN_ID);

  // Sanity: chain says wallet owns it now.
  const beforeOwner = await readOwnerOf(anvil.rpcUrl, nftContract, TOKEN_ID);
  expect(beforeOwner.toLowerCase()).toBe(walletAddr.toLowerCase());

  // ── Inject the NFT into wallet storage so it shows on Dashboard ─
  // (Skipping the AddNftScreen → real-contract round-trip because
  // that's a separate flow already covered by the AddNFT e2e; this
  // test focuses on the send path.)
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('no service worker');
  await sw.evaluate(async ({ contract, cid }) => {
    const existing = ((await chrome.storage.local.get('nfts')).nfts ?? {}) as Record<number, Record<string, unknown>>;
    existing[cid] = existing[cid] ?? {};
    existing[cid]![`${contract.toLowerCase()}::42`] = {
      address: contract.toLowerCase(),
      tokenId: '42',
      standard: 'ERC721',
      name: 'Test #42',
      image: null,
      description: null,
      addedAt: Date.now(),
    };
    await chrome.storage.local.set({ nfts: existing });
  }, { contract: nftContract, cid: anvil.chainId });

  // ── Open the popup, navigate to NFTs tab, hit "send ↗" ─────────
  const dashboardPopup = await context.newPage();
  await dashboardPopup.goto(popupUrl);
  await expect(dashboardPopup.getByRole('button', { name: /send/i }).first())
    .toBeVisible({ timeout: 10_000 });
  const nftsTab = dashboardPopup.getByRole('tab', { name: /my NFTs/i });
  const box = await nftsTab.boundingBox();
  if (!box) throw new Error('nfts tab not laid out');
  await nftsTab.click({ position: { x: Math.max(60, box.width - 20), y: box.height / 2 } });

  await expect(dashboardPopup.getByText('Test #42')).toBeVisible({ timeout: 10_000 });
  await dashboardPopup.locator('.aw-nft-send').first().click();
  // send-↗ opens the unified detail/send modal directly in send view —
  // the title is the NFT's display name, not a static screen header.
  await expect(dashboardPopup.locator('.aw-modal-title')).toHaveText('Test #42');

  // ── Fill recipient (anvil's account #2) and broadcast ──────────
  const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  await dashboardPopup.locator('.aw-modal input[placeholder="0x…"]').fill(RECIPIENT);
  await dashboardPopup.locator('.aw-modal').getByRole('button', { name: /send it/i }).click();

  // The popup-send path doesn't surface tx hash in the UI directly
  // (success toast + return to dashboard). Wait for the
  // dashboard-return signal (Settings cog visible = Dashboard mode)
  // or the green toast.
  await expect(
    dashboardPopup.locator('.aw-toast.green').or(dashboardPopup.getByRole('button', { name: 'settings' })),
  ).toBeVisible({ timeout: 30_000 });

  // ── Verify the on-chain state: ownerOf(42) is now the recipient ─
  // Small retry window — anvil mines instantly but the popup's send
  // is async; the wallet's receipt-wait may take a tick to settle.
  let afterOwner = '0x' as `0x${string}`;
  for (let i = 0; i < 10; i++) {
    afterOwner = await readOwnerOf(anvil.rpcUrl, nftContract, TOKEN_ID);
    if (afterOwner.toLowerCase() === RECIPIENT.toLowerCase()) break;
    await dashboardPopup.waitForTimeout(500);
  }
  expect(afterOwner.toLowerCase()).toBe(RECIPIENT.toLowerCase());

  await dashboardPopup.close().catch(() => {});
});
