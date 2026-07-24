// Fixture dapp orchestration helpers.
//
// We host our own minimal EIP-1193 test page at e2e/fixtures/test-dapp.html
// (served on http://127.0.0.1:4269 via Playwright's webServer config).
// Original plan was to use MetaMask's hosted test-dapp, but that page has
// restructured into multiple routes / lazy-mounted sections that broke
// our locators. Vendoring our own dapp under e2e/fixtures/test-dapp.html:
//   - offline / no GitHub Pages dependency in CI
//   - stable selectors (`#personal-sign`, `#send-tx`, etc. — we own them)
//   - exact param shapes we want to test (canonical EIP-2612 Permit, etc.)
//   - covers all 7 sign-confirm modes plus connect
// MetaMask's test-dapp button params were used as the reference shape so
// our wallet behaviour is tested against the industry baseline, just on a
// page we control.

import { expect, type BrowserContext, type Page } from '@playwright/test';

const DAPP_URL = 'http://127.0.0.1:4269/test-dapp.html';

/** Open the fixture dapp in a fresh page. The wallet's content+inject
 *  scripts run on http://* so EIP-6963 announces our provider. The
 *  fixture's picker auto-selects the first announced wallet, so by
 *  the time this helper returns the Aladdin Wallet provider is the
 *  active one (Playwright runs against a profile that ONLY has our
 *  extension loaded — no MetaMask etc. to compete). */
export async function openTestDapp(context: BrowserContext): Promise<Page> {
  const dapp = await context.newPage();
  await dapp.goto(DAPP_URL, { waitUntil: 'domcontentloaded' });
  // Wait for EIP-6963 announcement to populate the picker and for the
  // auto-select to flip `#chosen-provider` to Aladdin Wallet (the fork's
  // rebranded WALLET_INFO.name). If this stays "none" past the timeout,
  // our inject script didn't run or didn't announce — every subsequent
  // call would hang.
  await expect(dapp.locator('#chosen-provider'))
    .toContainText(/Aladdin/i, { timeout: 5_000 });
  return dapp;
}

/** Click the dapp's Connect button, then drive the popup's
 *  ConnectConfirm to "connect". After this returns, the dapp has
 *  the wallet's address available in `#account`. */
export async function connect(
  context: BrowserContext,
  dapp: Page,
  popupUrl: string,
): Promise<void> {
  await dapp.locator('#connect').click();

  // Wallet has now queued an `eth_requestAccounts` pending request. The
  // SW would normally call chrome.action.openPopup() but that requires a
  // user-gesture context which Playwright clicks don't always satisfy.
  // Open the popup manually — popup.tsx route() detects the pending
  // request and lands on the sign-confirm screen.
  const popup = await context.newPage();
  await popup.goto(popupUrl);

  // ConnectConfirm screen — click the green "connect" CTA.
  await expect(popup.getByText('connect to site?')).toBeVisible({ timeout: 10_000 });
  await popup.getByRole('button', { name: /connect/i }).last().click();
  await popup.close().catch(() => {});

  // Wait for the dapp's account display to update — proves the
  // eth_requestAccounts response actually made it back through the
  // inject → content → SW → content → inject roundtrip.
  await expect(dapp.locator('#account')).toContainText(/0x[a-f0-9]{40}/i, { timeout: 5_000 });
}

/** Click a sign-trigger button on the dapp, open a fresh popup, return
 *  the popup Page positioned on the SignConfirm screen. The caller
 *  drives mode-specific assertions and finally clicks reject/approve. */
export async function triggerSignAndOpenPopup(
  context: BrowserContext,
  dapp: Page,
  popupUrl: string,
  buttonId: string,
): Promise<Page> {
  await dapp.locator(`#${buttonId}`).click();
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  return popup;
}

/** Anvil chainId → 0x prefixed hex string for EIP-1193 calls. */
function chainIdHex(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}` as `0x${string}`;
}

/** Add the running Anvil instance as a custom chain in the wallet, then
 *  switch to it. Goes through real wallet_addEthereumChain (popup + user
 *  approve, exercising AddChainBody) followed by wallet_switchEthereumChain
 *  (no popup — synchronous switch in our dispatcher). After this returns,
 *  every subsequent dapp RPC call hits Anvil. */
export async function addAnvilChainAndSwitch(
  context: BrowserContext,
  dapp: Page,
  popupUrl: string,
  anvil: { rpcUrl: string; chainId: number },
): Promise<void> {
  const cid = chainIdHex(anvil.chainId);

  // 1. wallet_addEthereumChain — needs popup approval.
  const addPromise = dapp.evaluate(
    ({ rpcUrl, cid }) =>
      // @ts-expect-error window.ethereum is wallet-injected.
      window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: cid,
          chainName: 'Anvil (e2e)',
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }],
      }),
    { rpcUrl: anvil.rpcUrl, cid },
  );
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.locator('.aw-action-card h4').first())
    .toHaveText('add custom chain', { timeout: 10_000 });
  await popup.getByRole('button', { name: 'add chain' }).click();
  await popup.close().catch(() => {});
  await addPromise;

  // 2. wallet_switchEthereumChain — no popup, immediate switch.
  await dapp.evaluate(
    ({ cid }) =>
      // @ts-expect-error window.ethereum is wallet-injected.
      window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: cid }],
      }),
    { cid },
  );

  // Wait for the dapp's chainId display to reflect the switch.
  await expect(dapp.locator('#chain-id')).toContainText(cid, { timeout: 5_000 });
}

/** Read the connected wallet account from the dapp's `#account` element.
 *  Set by the dapp's polling refreshAccount() after eth_accounts resolves. */
export async function walletAccount(dapp: Page): Promise<`0x${string}`> {
  const text = await dapp.locator('#account').innerText();
  const m = text.match(/0x[a-fA-F0-9]{40}/);
  if (!m) throw new Error(`expected wallet address in #account, got: ${text}`);
  return m[0]!.toLowerCase() as `0x${string}`;
}

/** Fund an address on a running Anvil via the `anvil_setBalance` RPC. */
export async function setAnvilBalance(
  rpcUrl: string,
  address: `0x${string}`,
  weiHex: `0x${string}`,
): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'anvil_setBalance',
      params: [address, weiHex],
    }),
  });
  const body = (await res.json()) as { error?: { message: string }; result?: unknown };
  if (body.error) throw new Error(`anvil_setBalance: ${body.error.message}`);
}

