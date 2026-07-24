// Connect-coalesce contract: multiple parallel `eth_requestAccounts`
// / `wallet_requestPermissions` from the same origin must dedupe to
// a single approval prompt. Without this, spam dapps + auto-retrying
// wagmi clients pile up popups during one user click.
//
// Earlier attempt (failure-paths.spec.ts) hit Page-lifecycle issues
// where the auto-closed `popup` fixture raced with a test-opened
// approval page. Fix: ignore the fixture's popup entirely (it's
// just unused here) and own the approval page lifecycle.

import { test, expect } from './_setup/extension';
import { unlock } from './_setup/helpers';
import { openTestDapp } from './_setup/dapp';

test('5 parallel eth_requestAccounts coalesce into one popup', async ({ context, popupUrl, popup }) => {
  // Initial unlock through the fixture popup. After this the SW has
  // unlockedMnemonic in memory — any future popup opens land on
  // either Dashboard (no pending) or Sign-Confirm (1+ pending). We
  // need the latter exactly once.
  await unlock(popup);
  await popup.close();

  const dapp = await openTestDapp(context);

  // Fire 5 parallel connect requests via window.ethereum (inject
  // script mounts the provider there). Don't await — they queue
  // at the SW; resolution comes when the popup approves/rejects.
  const dispatched = dapp.evaluate(() => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    }).ethereum;
    if (!eth) throw new Error('window.ethereum not mounted');
    // Mix of method aliases — both COALESCE_METHODS entries.
    return Promise.allSettled([
      eth.request({ method: 'eth_requestAccounts', params: [] }),
      eth.request({ method: 'eth_requestAccounts', params: [] }),
      eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }),
      eth.request({ method: 'eth_requestAccounts', params: [] }),
      eth.request({ method: 'eth_requestAccounts', params: [] }),
    ]);
  });

  // Open the approval popup. SW dedups all 5 onto a single pending
  // request, so opening this page surfaces the connect-confirm
  // screen — not 5 stacked.
  const approval = await context.newPage();
  await approval.goto(popupUrl);
  // Connect screen — the green "connect" CTA is the canonical marker.
  const connectBtn = approval.getByRole('button', { name: /connect/i });
  await expect(connectBtn).toBeVisible({ timeout: 10_000 });

  // Approve — all 5 promises on the dapp side should resolve with the
  // wallet's address. (Reject would settle all 5 with code 4001; both
  // outcomes exercise the resolver-list dedup, but approve is the
  // happier branch since it surfaces a positive result we can assert.)
  await connectBtn.click();

  const results = await dispatched as PromiseSettledResult<unknown>[];
  // Every single one fulfilled — the single approval drained the queue.
  for (const r of results) {
    expect(r.status).toBe('fulfilled');
  }
  // eth_requestAccounts returns string[] of addresses; permissions
  // returns Permission[] objects. Both shapes are truthy / non-empty.
  const acctResult = results[0];
  if (acctResult.status === 'fulfilled') {
    expect(Array.isArray(acctResult.value)).toBe(true);
    expect((acctResult.value as string[])[0]).toMatch(/^0x[a-f0-9]{40}$/i);
  }

  await approval.close().catch(() => {});
});
