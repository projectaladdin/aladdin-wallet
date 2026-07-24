// Sign-confirm cluster e2e — drives our local fixture dapp at
// http://127.0.0.1:4269/test-dapp.html through the wallet's content +
// inject scripts to trigger real EIP-1193 calls, then verifies the
// popup renders the right body for each mode.
//
// Each mode of `deriveSignMode` (message / typed / approve / sendtx /
// addchain / watchAsset / 7702) gets one test. Coverage of the 1646-line
// sign-confirm module is the largest remaining popup-refactor risk.

import type { Page } from '@playwright/test';
import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { connect, openTestDapp, triggerSignAndOpenPopup } from './_setup/dapp';
import {
  mockSourcify,
  verifiedContract,
  unverifiedContract,
  unreachableContract,
} from './_setup/network-mocks';

// Permit2 deploys to the SAME canonical address across every chain
// (it's a Uniswap singleton). We hit the sepolia version here because
// global-setup leaves the wallet on sepolia by default — the
// wallet's wallet_signAuthorization handler refuses signatures whose
// request chainId ≠ active chain. The `permit2-sepolia` preset in
// the fixture dapp pre-fills the matching chainId.
const PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SEPOLIA_CID = 11155111;

/** Boilerplate shared by every sign-confirm test: unlock wallet (vault
 *  pre-loaded by global-setup snapshot), close popup, open dapp,
 *  connect. Returns the dapp page; caller closes it. */
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

test('eth_sign (deprecated) → rejected upstream with code 4200, no popup', async ({ context, popupUrl, popup }) => {
  // eth_sign signs a raw 32-byte hash with no prefix — indistinguishable
  // from a real transaction hash. Wallet refuses with EIP-1474 4200
  // (unsupported method) BEFORE any popup ever queues. This test
  // catches the regression where someone "helpfully" wires eth_sign
  // through to personal_sign by mistake.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Click the deprecated-method button. The dapp catches the throw and
  // surfaces the error to its `#error` pane.
  await dapp.locator('#eth-sign-deprecated').click();

  // Error pane shows code 4200 + a hint message.
  await expect(dapp.locator('#error')).toContainText('4200', { timeout: 5_000 });
  await expect(dapp.locator('#error')).toContainText('eth_sign');
  await expect(dapp.locator('#error')).toContainText(/personal_sign|disabled/i);

  // Critical assertion: NO popup got queued. If `eth_sign` had been
  // pushed onto the pending queue (i.e. refused only at popup-render
  // time), opening the popup would auto-route to the pending request
  // screen. Instead it should land on Dashboard.
  const probe = await context.newPage();
  await probe.goto(popupUrl);
  // Dashboard's settings cog is the canonical Dashboard-mode marker.
  await expect(probe.getByRole('button', { name: 'settings' }))
    .toBeVisible({ timeout: 5_000 });
  // Sign-confirm's distinctive "sign message" / "send transaction" h4
  // must NOT be present.
  await expect(probe.locator('.aw-action-card h4')).toHaveCount(0);
  await probe.close().catch(() => {});

  // Dapp's `#result` pane stays at reset (none) — confirms no
  // signature was quietly returned.
  await expect(dapp.locator('#result')).toHaveText('(none)');
});

test('personal_sign → MessageBody', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'personal-sign');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('sign message', { timeout: 10_000 });
  await expect(sign.getByText(/signing a message — no funds will move/i)).toBeVisible();
  // Reject closes the SW pending queue cleanly.
  await sign.getByRole('button', { name: 'reject' }).click();
  await sign.close().catch(() => {});
});

test('eth_signTypedData_v4 with null signer slot → -32602 pointing at signer (not typed data)', async ({ context, popupUrl, popup }) => {
  // Regression: dapp sends `params = [null, typed_data_json_string]`.
  // The wallet's old upfront extractor (`isAddr(p[0]) ? p[1] : p[0]`)
  // would fall through to `data = p[0] = null`, then
  // validateTypedDataSchema(null) returned "typed data must be an
  // object" — pointing at the wrong slot and misleading the dapp dev.
  // After the fix, the wallet uses unpackTypedDataParams which prefers
  // params[1] when neither slot is an address, then explicitly rejects
  // missing signer with a message that names the real problem.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.evaluate(async () => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 1,
        verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      },
      message: {
        spender: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        value: '1000000',
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    // Bypass the dapp's call() wrapper so we can inject `null` as the
    // first param (the wrapper builds params from typed inputs). Mirror
    // the wrapper's error shape into #error manually.
    try {
      await eth.request({
        method: 'eth_signTypedData_v4',
        params: [null, typedData],
      });
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string };
      const pane = document.getElementById('error');
      if (pane) pane.textContent = JSON.stringify({
        method: 'eth_signTypedData_v4',
        code: err.code,
        message: err.message,
      }, null, 2);
    }
  });

  // Dapp's #error pane carries the -32602 code + a signer-pointed
  // message. Critically NOT "typed data must be an object" — that
  // was the misleading message before the fix.
  await expect(dapp.locator('#error')).toContainText('-32602', { timeout: 5_000 });
  await expect(dapp.locator('#error')).toContainText(/signer address missing/i);
  await expect(dapp.locator('#error')).not.toContainText(/typed data must be an object/i);

  // No popup queued — the rejection happens upfront in the SW.
  const probe = await context.newPage();
  await probe.goto(popupUrl);
  await expect(probe.getByRole('button', { name: 'settings' }))
    .toBeVisible({ timeout: 5_000 });
  await expect(probe.locator('.aw-action-card h4')).toHaveCount(0);
  await probe.close().catch(() => {});
});

test('eth_signTypedData_v4 (Permit) → TypedBody', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-typed-data-v4');
  // Canonical Permit shape → TypedBody renders with title "sign permit".
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText(/sign permit/i, { timeout: 10_000 });
  // Permit's semantic 5-row layout: who/to/what/much/when. Verify the
  // amount pill rendered (proves decodeSemantics + token-info round-trip).
  await expect(sign.locator('.aw-semrow').first()).toBeVisible();
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('wallet_addEthereumChain → AddChainBody (Arbitrum preset)', async ({ context, popupUrl, popup }) => {
  // Default preset (Arbitrum) — sanity-check the AddChainBody mode
  // and that name/chainId/rpc surfaces correctly.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="arbitrum"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'add-chain-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add custom chain', { timeout: 10_000 });
  await expect(sign.getByText('Arbitrum One')).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('wallet_addEthereumChain → AddChainBody (Polygon preset)', async ({ context, popupUrl, popup }) => {
  // Verifies the preset swap actually drives different params into
  // the SW. A regression where applyAddChainPreset doesn't refill
  // the inputs would show Arbitrum here despite clicking Polygon.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="polygon"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'add-chain-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add custom chain', { timeout: 10_000 });
  await expect(sign.getByText('Polygon Mainnet')).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('wallet_addEthereumChain → AddChainBody (Base preset)', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="base"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'add-chain-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add custom chain', { timeout: 10_000 });
  // Exact match — "Base" string appears twice on screen (chain name
  // + inside the rpcUrl https://mainnet.base.org); the chain-name
  // rendering uses a plain <dd> while the rpc is a `.mono` <dd>.
  await expect(sign.getByText('Base', { exact: true })).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('wallet_watchAsset → WatchAssetBody (ERC-20 path)', async ({ context, popupUrl, popup }) => {
  // The standalone "Watch Asset (ERC-20: USDC)" button was retired —
  // ERC-20 watchAsset is now triggered through the ERC-20 panel's
  // own preset (which targets a freshly-deployed test token). Fire
  // the same EIP-747 payload directly via window.ethereum.request so
  // this test stays focused on the popup-render contract.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.evaluate(() => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    eth.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: {
          address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          symbol: 'USDC',
          decimals: 6,
          image: 'https://example.com/usdc.png',
        },
      },
    }).catch(() => { /* expected when test clicks cancel */ });
  });
  const sign = await context.newPage();
  await sign.goto(popupUrl);

  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add token', { timeout: 10_000 });
  await expect(sign.getByText('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', { exact: false })).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('wallet_watchAsset ERC-721 → WatchAssetBody renders NFT shape', async ({ context, popupUrl, popup }) => {
  // EIP-747 NFT variant. Dapp fires `{type: 'ERC721', options: {address,
  // tokenId}}` via window.ethereum. Popup should route to the
  // watchAsset mode but render the NFT-flavoured body (no symbol /
  // decimals fields, has tokenId, h4 "add NFT").
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Fire-and-forget request — the wallet will queue a pending popup
  // and reject once we click cancel. We catch the rejection on the
  // page side so it doesn't propagate up to Playwright's evaluate.
  await dapp.evaluate(() => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    eth.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC721',
        options: {
          address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '42',
        },
      },
    }).catch(() => { /* expected when test clicks cancel */ });
  });

  const sign = await context.newPage();
  await sign.goto(popupUrl);
  // NFT-flavoured body: h4 says "add NFT" (not "add token"), shows
  // tokenId field.
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add NFT', { timeout: 10_000 });
  await expect(sign.getByText('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', { exact: false })).toBeVisible();
  await expect(sign.getByText('42', { exact: true })).toBeVisible();
  // CTA copy is "add NFT" rather than "add token".
  await expect(sign.getByRole('button', { name: /add NFT/i })).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('NFT panel — ERC-721 and ERC-1155 render as independent stacked panels', async ({ context, popupUrl, popup }) => {
  // Layout regression guard. The two panels share preset semantics but
  // must stay structurally independent — selecting a chip in one panel
  // can't bleed into the other, and each carries its own input set.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Both panels exist, each with their own namespaced run button.
  await expect(dapp.locator('#nft721-run')).toBeVisible();
  await expect(dapp.locator('#nft1155-run')).toBeVisible();

  // Each panel has its own action input, contract input, etc. No legacy
  // shared `#nft-*` IDs left over after the split.
  await expect(dapp.locator('#nft721-contract')).toBeVisible();
  await expect(dapp.locator('#nft1155-contract')).toBeVisible();
  expect(await dapp.locator('#nft-contract').count()).toBe(0);
  expect(await dapp.locator('#nft-run').count()).toBe(0);

  // Floating "Watch Asset (ERC-721/1155)" buttons were folded into the
  // panels as preset chips — the actions strip no longer carries them.
  expect(await dapp.locator('#watch-asset-erc721').count()).toBe(0);
  expect(await dapp.locator('#watch-asset-erc1155').count()).toBe(0);

  // Each panel has exactly 5 preset chips (deploy / mint / transfer /
  // approve / watchAsset) — the canonical taxonomy per standard.
  const panel721  = dapp.locator('.nft-panel').filter({ hasText: 'ERC-721' }).first();
  const panel1155 = dapp.locator('.nft-panel').filter({ hasText: 'ERC-1155' }).first();
  await expect(panel721.locator('.nft-preset')).toHaveCount(5);
  await expect(panel1155.locator('.nft-preset')).toHaveCount(5);

  // Independence: defaults set Deploy active on BOTH panels. Click the
  // Mint chip in the 1155 panel — the 721 panel's Deploy chip must
  // stay active (toggle scope is panel-local).
  await expect(panel721.locator('[data-action="deploy-erc721"]')).toHaveClass(/is-active/);
  await expect(panel1155.locator('[data-action="deploy-erc1155"]')).toHaveClass(/is-active/);
  await panel1155.locator('[data-action="mint-erc1155"]').click();
  await expect(panel1155.locator('[data-action="mint-erc1155"]')).toHaveClass(/is-active/);
  await expect(panel721.locator('[data-action="deploy-erc721"]')).toHaveClass(/is-active/);
});

test('NFT panel — input rows hide/show per selected action', async ({ context, popupUrl, popup }) => {
  // Each preset only USES a subset of the panel's inputs; rows for
  // unused fields hide so the form doesn't suggest values that the
  // run handler will silently ignore. (e.g. amount/recipient/tokenURI
  // are meaningless for watch-asset).
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  const panel1155 = dapp.locator('.nft-panel').filter({ hasText: 'ERC-1155' }).first();

  // watch-asset-1155 → action + contract + tokenId only.
  await panel1155.locator('[data-action="watch-asset-erc1155"]').click();
  await expect(panel1155.locator('[data-field="action"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="contract"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="tokenId"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="amount"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="recipient"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="tokenURI"]')).toBeHidden();

  // mint-1155 → tokenId + amount, no recipient/tokenURI.
  await panel1155.locator('[data-action="mint-erc1155"]').click();
  await expect(panel1155.locator('[data-field="tokenId"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="amount"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="recipient"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="tokenURI"]')).toBeHidden();

  // transfer-1155 → tokenId + amount + recipient.
  await panel1155.locator('[data-action="transfer-erc1155"]').click();
  await expect(panel1155.locator('[data-field="recipient"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="amount"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="tokenURI"]')).toBeHidden();

  // approve-1155 → recipient (operator) only; no tokenId/amount/uri.
  await panel1155.locator('[data-action="approve-erc1155"]').click();
  await expect(panel1155.locator('[data-field="recipient"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="tokenId"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="amount"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="tokenURI"]')).toBeHidden();

  // deploy-1155 → tokenURI is the only real input; no tokenId/amount/recipient.
  await panel1155.locator('[data-action="deploy-erc1155"]').click();
  await expect(panel1155.locator('[data-field="tokenURI"]')).toBeVisible();
  await expect(panel1155.locator('[data-field="tokenId"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="amount"]')).toBeHidden();
  await expect(panel1155.locator('[data-field="recipient"]')).toBeHidden();
});

test('NFT panel — ERC-721 watchAsset preset fires wallet_watchAsset(ERC721)', async ({ context, popupUrl, popup }) => {
  // The watchAsset chip now lives inside the ERC-721 panel. Clicking
  // it + Run should emit an EIP-747 ERC-721 watchAsset that lands in
  // the popup's NFT-flavoured WatchAssetBody (h4 = "add NFT").
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Pick the watchAsset preset — fills tokenId=1, leaves contract blank
  // (no deploy in this test) — then paste a known contract address so
  // we don't have to spin up an anvil deploy just to test the routing.
  await dapp.locator('#nft721-run').waitFor();
  await dapp.locator('[data-action="watch-asset-erc721"]').click();
  await dapp.locator('#nft721-contract').fill('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'nft721-run');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add NFT', { timeout: 10_000 });
  await expect(sign.getByText('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', { exact: false })).toBeVisible();
  // Preset's default tokenId for ERC-721 is `1`.
  await expect(sign.getByText('1', { exact: true })).toBeVisible();
  await expect(sign.getByRole('button', { name: /add NFT/i })).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('NFT panel — ERC-1155 watchAsset preset fires wallet_watchAsset(ERC1155)', async ({ context, popupUrl, popup }) => {
  // Mirror of the ERC-721 test. Different panel, different preset,
  // tokenId default = 7 (matches the ERC-1155 mint preset).
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('#nft1155-run').waitFor();
  await dapp.locator('[data-action="watch-asset-erc1155"]').click();
  await dapp.locator('#nft1155-contract').fill('0xabcdef0123456789abcdef0123456789abcdef01');

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'nft1155-run');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('add NFT', { timeout: 10_000 });
  await expect(sign.getByText('0xabcdef0123456789abcdef0123456789abcdef01', { exact: false })).toBeVisible();
  await expect(sign.getByText('7', { exact: true })).toBeVisible();
  await expect(sign.getByRole('button', { name: /add NFT/i })).toBeVisible();
  await sign.getByRole('button', { name: /cancel/i }).click();
  await sign.close().catch(() => {});
});

test('wallet_watchAsset rejects ERC721 without tokenId (validator)', async ({ context, popup, popupUrl }) => {
  // Validator catches malformed dapp payloads BEFORE the popup queues
  // — bad input gets a JSON-RPC error, no popup ever shows. Mirrors
  // the eth_sign-deprecated rejection test.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  const result = await dapp.evaluate(() => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    return eth.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC721',
        options: { address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' },
        // no tokenId
      },
    }).then(
      () => ({ ok: true }),
      (e: { code?: number; message?: string }) => ({ ok: false, code: e.code, message: e.message }),
    );
  });
  expect((result as { ok: boolean }).ok).toBe(false);
  expect((result as { message?: string }).message).toMatch(/tokenId is required/i);

  // No popup got queued — fresh open lands on Dashboard.
  const probe = await context.newPage();
  await probe.goto(popupUrl);
  await expect(probe.getByRole('button', { name: 'settings' })).toBeVisible({ timeout: 5_000 });
  await expect(probe.locator('.aw-action-card h4')).toHaveCount(0);
  await probe.close().catch(() => {});
});

test('wallet_signAuthorization → SevenSevenZeroTwoBody (slide gate)', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  // The 7702 body has a distinctive "EIP-7702 delegation" big banner +
  // slide-to-confirm + DELEGATE button locked until slid.
  await expect(sign.locator('.aw-big-banner h5')).toContainText('EIP-7702 delegation', { timeout: 10_000 });
  await expect(sign.locator('.aw-slide-track')).toBeVisible();
  // Delegate button is locked (aw-cta-locked) until the user slides — assert
  // it has the locked class and disabled attribute set.
  const delegate = sign.getByRole('button', { name: /DELEGATE/i });
  await expect(delegate).toBeDisabled();
  // Reject without sliding.
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('7702 revoke preset → "slide to revoke" + NO Sourcify call', async ({ context, popupUrl, popup }) => {
  // EIP-7702 revoke uses `address: 0x000…000`. This is the spec way to
  // clear a previous delegation, NOT a Sourcify gate situation — slide
  // unlocks without any verification, with revoke-specific copy.
  // Verifies the popup short-circuits BEFORE any Sourcify network call
  // (mock fails the test if Sourcify is hit for the zero address).
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  const sourcify = await mockSourcify(context, {
    contracts: {},
    unexpectedFailsTest: true,
  });

  await dapp.locator('[data-preset="revoke"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');

  // Wait for the gate effect to resolve past 'pending' — revoke is
  // synchronous (no network calls) so this should be instant.
  // Slide label lives in `<span class="label">` next to the `→`
  // thumb — both nested inside `.aw-slide-track`.
  const thumb = sign.locator('.aw-slide-track .label');
  await expect(thumb).toContainText('slide to revoke', { timeout: 5_000 });
  // The neutral revoke banner sits in the body.
  await expect(sign.getByText(/EIP-7702 revoke/i).first()).toBeVisible();
  // Sourcify must NOT have been called — revoke is a spec short-
  // circuit (zero address). Catches regressions where the popup
  // accidentally goes through the verify path on this branch.
  expect(sourcify.callCount()).toBe(0);
  // Slide is NOT disabled — track should have the open class (not locked).
  // We don't assert the slide actually slides (gesture flakiness); just
  // that the thumb shows the revoke label, which only happens when
  // decideSeven702Gate returns slideOpen=true.
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('calldata decoder: approve preset → ApproveBody (dedicated mode)', async ({ context, popupUrl, popup }) => {
  // The approve preset's calldata is ERC-20 approve(spender, amount).
  // deriveSignMode routes it to 'approve' (its OWN body, not generic
  // SendTxBody) — proves COMMON_TX_ABI is still the priority path and
  // the mode-dispatcher picks the specialised UI.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="approve"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  // ApproveBody header + capped/max toggle (distinct from SendTxBody).
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('token approval', { timeout: 10_000 });
  await expect(sign.getByRole('button', { name: 'capped' })).toBeVisible();
  await expect(sign.getByRole('button', { name: 'max ∞' })).toBeVisible();
  // `token:` row is a clickable explorer link. Approve preset hits
  // USDC on mainnet so the href should target etherscan's USDC page.
  const tokenLink = sign.locator('.aw-addr-link', { hasText: /0xA0b8|USDC/i }).first();
  await expect(tokenLink).toBeVisible();
  const href = await tokenLink.getAttribute('href');
  expect(href).toContain('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('calldata decoder: setApprovalForAll (ERC-721) → "fn: setApprovalForAll" + clickable token link', async ({ context, popupUrl, popup }) => {
  // Verifies SELECTOR_TABLE_ABI is wired into decodeTxData. Raw
  // selector for this tx is 0xa22cb465; before the bundled table
  // existed, sign-confirm would show "function: 0xa22cb465 (68 bytes)".
  // After, it shows "fn: setApprovalForAll" in the kv rows.
  //
  // Doubles as e2e coverage for the SendTxBody `token:` row's
  // clickable explorer link (separate path from ApproveBody's
  // hand-rolled link — this one goes through the generic row
  // renderer + describeRequest's href injection).
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="set-approval-all"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // The decoded function name appears in a kv row labelled `fn`.
  await expect(sign.getByText('setApprovalForAll', { exact: false })).toBeVisible();
  // Negative assertion: raw selector should NOT appear as "function: 0x..."
  // anywhere (kv row with that label is the un-decoded fallback shape).
  await expect(sign.getByText(/0xa22cb465/)).not.toBeVisible();
  // Token row IS a clickable link. BAYC contract on mainnet → href
  // should target etherscan with the BAYC address.
  const tokenLink = sign.locator('.aw-addr-link').first();
  await expect(tokenLink).toBeVisible();
  const href = await tokenLink.getAttribute('href');
  // Wallet doesn't normalise case before building the explorer URL —
  // assert case-insensitively so this doesn't false-fail on the
  // checksum'd address embedded by the dapp.
  expect(href?.toLowerCase()).toContain('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
  // target=_blank + rel=noopener for security — the explorer page
  // must NOT be able to reach back via window.opener.
  await expect(tokenLink).toHaveAttribute('target', '_blank');
  await expect(tokenLink).toHaveAttribute('rel', /noopener/);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('calldata decoder: claim() → "fn: claim"', async ({ context, popupUrl, popup }) => {
  // Common-pattern selector 0x4e71d92d. Lives in SELECTOR_TABLE_ABI's
  // COMMON_PATTERNS group — the most-used vanity entries for "claim
  // airdrop" / "claim rewards" type contracts.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="claim"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // `claim` should appear as the decoded function name. Use exact:true
  // to avoid matching the word "claim" in any other body copy.
  await expect(sign.getByText('claim', { exact: true })).toBeVisible();
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('calldata decoder: unknown selector → raw selector fallback', async ({ context, popupUrl, popup }) => {
  // Negative test — ensures the decoder doesn't false-positive on a
  // random selector that ISN'T in COMMON_TX_ABI + SELECTOR_TABLE_ABI.
  // Sign-confirm should fall through to the "function: 0x<sel> (<n>
  // bytes)" raw display. Mocks Sourcify to return 404 too (no ABI
  // fallback), so the raw display is the only possible result.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  await mockSourcify(context, { contracts: {} }); // all addresses → 404

  await dapp.locator('[data-preset="unknown"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // The selector hex appears in the function row.
  await expect(sign.getByText(/0xdeadbeef/)).toBeVisible();
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('eth_sendTransaction deposit() with non-zero value (MM piggy-bank shape)', async ({ context, popupUrl, popup }) => {
  // Mirrors MetaMask test-dapp's "Piggy Bank deposit" button shape:
  // calldata is just the `deposit()` selector (4 bytes, no args),
  // value > 0. Our sign-mode classifier maps this to "wrap ETH".
  // Past failure mode worth pinning: a regression that drops calldata
  // when value > 0 would collapse the popup to a bare native-send
  // view and lose the action label. Verify both pieces render.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  // Fire directly via window.ethereum — keeps the test independent
  // of any preset wiring in the fixture dapp. `from` must be the
  // active account; wallet refuses unknown signers upfront.
  await dapp.evaluate(async () => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    const accounts = (await eth.request({ method: 'eth_accounts', params: [] })) as string[];
    eth.request({
      method: 'eth_sendTransaction',
      params: [{
        from: accounts[0],
        to:   '0x0000000000000000000000000000000000c0ffee',
        value: '0x16345785d8a0000', // 0.1 ETH
        data:  '0xd0e30db0',         // deposit()
      }],
    }).catch(() => { /* expected when test clicks reject */ });
  });

  const sign = await context.newPage();
  await sign.goto(popupUrl);

  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // 0.1 ETH renders in the value kv row (the dd contains the
  // amount + "(wrap)" annotation). Scoping to <dd> avoids matching
  // the dapp host "127.0.0.1:4269" elsewhere on the page.
  await expect(sign.locator('dd').filter({ hasText: /0\.1 ETH \(wrap\)/i })).toBeVisible();
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('multicall-risk: outer multicall wrapping UNLIMITED approve → red banner + ack required', async ({ context, popupUrl, popup }) => {
  // Phishing scenario: dapp asks for a "batched" tx that looks
  // innocuous (`fn: multicall`) but the inner bytes[] hides an
  // UNLIMITED approve to an attacker address. SecurityChecks panel
  // must surface this via the multicall-risk rule and force the
  // user to tick the ack checkbox before signing.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="multicall-phishing"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });

  // Red banner from SecurityChecks panel — message mentions the
  // inner UNLIMITED approve.
  const banner = sign.locator('[data-signal-id="multicall-risk"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/UNLIMITED approve/);
  // Critical: ack checkbox renders (requiresAck: true).
  await expect(sign.locator('.aw-ack-row')).toBeVisible();
  // CTA disabled until ack ticked.
  const cta = sign.getByRole('button', { name: /send it/i });
  await expect(cta).toBeDisabled();
  await sign.locator('.aw-ack-row input[type="checkbox"]').check();
  // After ack the CTA enables — proves the gating wiring is intact.
  await expect(cta).toBeEnabled();

  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('calldata decoder Sourcify ABI prefetch fires for unknown selector', async ({ context, popupUrl, popup }) => {
  // SW-side pipeline pin. When the bundled local selector table
  // misses a tx's calldata, the SW should prefetch the destination
  // contract's ABI from Sourcify (`?fields=abi`). We mock Sourcify
  // and assert the `?fields=abi` URL was actually called.
  //
  // We don't try to assert the popup re-decodes with a fake ABI:
  // viem matches by keccak256(signature), so faking a Sourcify ABI
  // to "decode" 0xdeadbeef would require a 4-byte selector pre-image
  // (a hash-cracking problem out of scope for a unit-style test).
  // The SW prefetch firing is the load-bearing behaviour worth
  // pinning; popup-side re-decode is exercised by the unit tests
  // for `decodeTxDataWithAbi`.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  let abiCallSeen = false;
  await context.route('**/sourcify.dev/**', (route) => {
    if (route.request().url().includes('fields=abi')) abiCallSeen = true;
    void route.fulfill({
      status: 404,
      body: JSON.stringify({ match: null }),
      headers: { 'content-type': 'application/json' },
    });
  });

  await dapp.locator('[data-preset="unknown"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'send-tx-multi');
  await expect(sign.locator('.aw-action-card h4').first())
    .toHaveText('send transaction', { timeout: 10_000 });
  // Popup display stays on raw selector (no matching ABI).
  await expect(sign.getByText(/0xdeadbeef/)).toBeVisible();
  // SW prefetch fires async; brief settle window before asserting.
  await sign.waitForTimeout(500);
  expect(abiCallSeen).toBe(true);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('7702 "unverified" preset → blocked (no-code branch wins over unverified)', async ({ context, popupUrl, popup }) => {
  // Preset address `0xdead…beef` was originally chosen as a quick
  // "Sourcify has no source for this contract" stand-in. In reality
  // it also has zero bytecode, so the `no-code` gate branch (which
  // we added later — stronger warning than plain unverified) wins
  // and the slide label says "🚫 no contract — refusing".
  // The end-user signal is the same (slide stays locked, body shows
  // a red BLOCKED banner) and this is what we actually want to
  // prevent in the wild: signing a delegate with no contract code
  // bricks the EOA. So we pin the harder branch.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);

  await dapp.locator('[data-preset="unverified"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');

  // Slide label lives in `<span class="label">` next to the `→`
  // thumb — both nested inside `.aw-slide-track`.
  const thumb = sign.locator('.aw-slide-track .label');
  await expect(thumb).toContainText(/no contract — refusing/i, { timeout: 15_000 });
  // DELEGATE button stays disabled (slide didn't open).
  await expect(sign.getByRole('button', { name: /DELEGATE/i })).toBeDisabled();
  // Body's red BLOCKED banner explains the no-code condition.
  await expect(sign.locator('.aw-verify-block').first()).toContainText(/NO contract code/i);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

// ─── Mock-driven 7702 gate scenarios ──────────────────────────────
// Permit2 deploys to the same canonical address on every chain.
// We use the sepolia deployment here because global-setup leaves
// the wallet on sepolia; the no-code branch won't fire (Permit2 is
// real bytecode there too), letting us isolate the Sourcify-result
// branch via mocked HTTP responses. Live Sourcify would be flaky
// — it doesn't return 429s on demand, response timing drifts.

test('7702 mocked Sourcify verified → "slide to unlock"', async ({ context, popupUrl, popup }) => {
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([verifiedContract(SEPOLIA_CID, PERMIT2_ADDR)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  const thumb = sign.locator('.aw-slide-track .label');
  await expect(thumb).toContainText(/slide to unlock/i, { timeout: 10_000 });
  // No body banner — verified delegates don't show a positive banner
  // (per intentional UX decision; verified ≠ safe).
  await expect(sign.locator('.aw-verify-block')).toHaveCount(0);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('7702 mocked Sourcify 404 → "🚫 unverified — refusing"', async ({ context, popupUrl, popup }) => {
  // Real unverified test — uses a contract WITH bytecode so the
  // no-code branch can't short-circuit. Sourcify mock returns 404,
  // wallet should land in 'unverified' state.
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([unverifiedContract(SEPOLIA_CID, PERMIT2_ADDR)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  const thumb = sign.locator('.aw-slide-track .label');
  await expect(thumb).toContainText(/unverified — refusing/i, { timeout: 10_000 });
  await expect(sign.getByRole('button', { name: /DELEGATE/i })).toBeDisabled();
  await expect(sign.locator('.aw-verify-block').first()).toContainText(/not auditable/i);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});

test('7702 mocked Sourcify 429 → "🚫 verifier unreachable"', async ({ context, popupUrl, popup }) => {
  // Sourcify rate-limited / network blip — error branch (distinct
  // from unverified so the user knows to retry).
  const dapp = await setupConnectedDapp(context, popup, popupUrl);
  await mockSourcify(context, {
    contracts: Object.fromEntries([unreachableContract(SEPOLIA_CID, PERMIT2_ADDR, 429)]),
  });

  await dapp.locator('[data-preset="permit2-sepolia"]').click();
  const sign = await triggerSignAndOpenPopup(context, dapp, popupUrl, 'sign-authorization');
  const thumb = sign.locator('.aw-slide-track .label');
  await expect(thumb).toContainText(/verifier unreachable/i, { timeout: 10_000 });
  // Body banner mentions "retry" so user knows it's not a permanent state.
  await expect(sign.locator('.aw-verify-block').first()).toContainText(/retry/i);
  await sign.getByRole('button', { name: /^reject$/ }).click();
  await sign.close().catch(() => {});
});
