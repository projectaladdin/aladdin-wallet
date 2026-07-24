// Activity screen end-to-end. We don't need to broadcast a real tx —
// the screen renders whatever the SW's `list-activity` /
// `refresh-activity-status` returns. Patch those at chrome.runtime.
// sendMessage level + seed the responses with synthetic entries so
// we can deterministically assert label formatting (the user-facing
// "sent 0.5 ETH" / "approved ∞ USDC" / "transferred NFT #42" rules
// the activity-format module enforces).
//
// Per-row token-info lookups use `read-token-info` — also patched.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

/** Build the addInitScript body. Uses a guard so re-runs across the
 *  same context don't double-patch. Token info + activity list +
 *  refresh all return canned values; reverse-ENS returns null so the
 *  recipient stays in 0x… form (we cover the ENS-name swap in
 *  ens-reverse.spec.ts). */
function patchActivity(scenario: 'mixed' | 'pending' | 'empty') {
  // ERC-20 transfer calldata: transfer(ALICE, 1.234560 USDC).
  const usdcTransferAmount = (BigInt(1_234_560)).toString(16).padStart(64, '0');
  const usdcTransferData = '0xa9059cbb'
    + '0'.repeat(24) + ALICE.slice(2).toLowerCase()
    + usdcTransferAmount;
  // Approve(BOB, uint256.max) — should render as ∞.
  const maxHex = ((1n << 256n) - 1n).toString(16);
  const approveMaxData = '0x095ea7b3'
    + '0'.repeat(24) + BOB.slice(2).toLowerCase()
    + maxHex;
  // ERC-721 safeTransferFrom(from, to, tokenId=42)
  const tokenIdHex = (42n).toString(16).padStart(64, '0');
  const nftTransferData = '0x42842e0e'
    + '0'.repeat(24) + ALICE.slice(2).toLowerCase()
    + '0'.repeat(24) + BOB.slice(2).toLowerCase()
    + tokenIdHex;

  const mixedItems = [
    {
      hash: '0x' + 'a'.repeat(64),
      chainId: 11155111,
      account: ALICE.toLowerCase(),
      kind: 'send',
      to: BOB,
      value: '500000000000000000', // 0.5 ETH
      data: null,
      addedAt: Date.now() - 5_000,
      status: 'success',
    },
    {
      hash: '0x' + 'b'.repeat(64),
      chainId: 11155111,
      account: ALICE.toLowerCase(),
      kind: 'erc20-transfer',
      to: USDC,
      value: '0',
      data: usdcTransferData,
      addedAt: Date.now() - 60_000,
      status: 'success',
    },
    {
      hash: '0x' + 'c'.repeat(64),
      chainId: 11155111,
      account: ALICE.toLowerCase(),
      kind: 'approve',
      to: USDC,
      value: '0',
      data: approveMaxData,
      addedAt: Date.now() - 120_000,
      status: 'success',
    },
    {
      hash: '0x' + 'd'.repeat(64),
      chainId: 11155111,
      account: ALICE.toLowerCase(),
      kind: 'nft-transfer',
      to: USDC,  // pretend USDC is also an NFT contract — formatter doesn't check
      value: '0',
      data: nftTransferData,
      addedAt: Date.now() - 180_000,
      status: 'failed',
    },
  ];
  const pendingItems = [
    {
      hash: '0x' + '1'.repeat(64),
      chainId: 11155111,
      account: ALICE.toLowerCase(),
      kind: 'send',
      to: BOB,
      value: '100000000000000000',
      data: null,
      addedAt: Date.now() - 2_000,
      status: 'pending',
    },
  ];
  const items =
    scenario === 'empty'   ? []
    : scenario === 'pending' ? pendingItems
    : mixedItems;

  return `(() => {
    const g = '__act_${scenario}';
    const w = window;
    if (w[g]) return;
    w[g] = true;
    const ITEMS = ${JSON.stringify(items)};
    const TOKEN_INFO = {
      ${'"' + USDC.toLowerCase() + '"'}: { symbol: 'USDC', decimals: 6 },
    };
    const native = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((msg, cb) => {
      if (msg && typeof cb === 'function') {
        if (msg.kind === 'list-activity' || msg.kind === 'refresh-activity-status') {
          queueMicrotask(() => cb({ ok: true, data: ITEMS }));
          return undefined;
        }
        if (msg.kind === 'read-token-info') {
          queueMicrotask(() => cb({ ok: true, data: TOKEN_INFO }));
          return undefined;
        }
        if (msg.kind === 'resolve-ens-name') {
          // Don't swap addresses in this test — checked separately.
          queueMicrotask(() => cb({ ok: true, data: null }));
          return undefined;
        }
      }
      return native(msg, cb);
    });
  })();`;
}

async function openActivityScreen(
  context: import('@playwright/test').BrowserContext,
  popupUrl: string,
  popup: import('@playwright/test').Page,
) {
  await popup.close().catch(() => {});
  const p = await context.newPage();
  await p.goto(popupUrl);
  await unlock(p);
  await p.getByRole('button', { name: /activity/i }).first().click();
  return p;
}

test('Activity rows render decoded labels for native / ERC-20 / approve / NFT', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchActivity('mixed') });
  const p = await openActivityScreen(context, popupUrl, popup);

  // Each ActivityKind in the mixed fixture maps to a specific verb.
  // We assert by `.kind` cell text in the activity row body.
  const rows = p.locator('.aw-act-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator('.kind')).toHaveText('sent 0.5 ETH');
  await expect(rows.nth(1).locator('.kind')).toHaveText(/sent 1\.23456 USDC/);
  await expect(rows.nth(2).locator('.kind')).toHaveText('approved ∞');
  await expect(rows.nth(3).locator('.kind')).toHaveText('transferred NFT #42');
});

test('Activity status badges reflect success / pending / failed', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchActivity('mixed') });
  const p = await openActivityScreen(context, popupUrl, popup);

  // 3 success + 1 failed in the mixed fixture.
  await expect(p.locator('.aw-act-status.is-success')).toHaveCount(3);
  await expect(p.locator('.aw-act-status.is-failed')).toHaveCount(1);
  await expect(p.locator('.aw-act-status.is-pending')).toHaveCount(0);
});

test('Activity empty state renders when nothing has been broadcast', async ({ context, popupUrl, popup }) => {
  await context.addInitScript({ content: patchActivity('empty') });
  const p = await openActivityScreen(context, popupUrl, popup);

  await expect(p.getByText(/no activity yet/i)).toBeVisible();
  await expect(p.locator('.aw-act-row')).toHaveCount(0);
});

test('Activity pending entry triggers the auto-poll loop (refresh fires on mount + interval)', async ({ context, popupUrl, popup }) => {
  // Use a counter-aware patch — every refresh-activity-status call
  // bumps a window counter; we assert it ticks past 1 within ~6 s,
  // proving the 5 s interval fired at least once after mount.
  await context.addInitScript({
    content: `(() => {
      const w = window;
      if (w.__poll_patched) return;
      w.__poll_patched = true;
      w.__poll_count = 0;
      const ITEMS = ${JSON.stringify([{
        hash: '0x' + '1'.repeat(64),
        chainId: 11155111,
        account: '0x' + 'f'.repeat(40),
        kind: 'send',
        to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        value: '0',
        data: null,
        addedAt: Date.now() - 1000,
        status: 'pending',
      }])};
      const native = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((msg, cb) => {
        if (msg && typeof cb === 'function') {
          if (msg.kind === 'refresh-activity-status') {
            w.__poll_count++;
            queueMicrotask(() => cb({ ok: true, data: ITEMS }));
            return undefined;
          }
          if (msg.kind === 'list-activity' || msg.kind === 'read-token-info' || msg.kind === 'resolve-ens-name') {
            queueMicrotask(() => cb({ ok: true, data: msg.kind === 'read-token-info' ? {} : (msg.kind === 'resolve-ens-name' ? null : ITEMS) }));
            return undefined;
          }
        }
        return native(msg, cb);
      });
    })();`,
  });
  const p = await openActivityScreen(context, popupUrl, popup);

  // Row visible — that's mount + first refresh fired.
  await expect(p.locator('.aw-act-row')).toHaveCount(1);

  // Wait long enough for the 5 s interval to fire at least once.
  // We allow 6.5 s slack so a slow CI doesn't false-negative.
  await p.waitForFunction(() => (window as unknown as { __poll_count: number }).__poll_count >= 2, null, {
    timeout: 7_000,
  });
});
