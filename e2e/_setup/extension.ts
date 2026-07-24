// Extension test fixture — wraps `test()` so each test gets:
//   - a fresh persistent-context profile (so vault state doesn't leak
//     between tests)
//   - the loaded extension's id (parsed from the SW URL Chrome assigns)
//   - a `popup` Page already navigated to popup.html so the test body
//     starts where the user would
//
// MV3 quirks handled:
//   - Extensions only run in persistent contexts. We launch a fresh
//     userDataDir per test under os.tmpdir() and clean it up after.
//   - The SW may already be running (Playwright caught it during launch)
//     or may not (cold start). Cover both: read context.serviceWorkers()
//     first, then `await context.waitForEvent('serviceworker')` if empty.
//   - `headless: true` works for extensions on Playwright 1.40+ via the
//     new headless mode. Set HEADED=1 to watch the run during dev.

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { SNAPSHOT_PATH } from './global-setup';

const EXTENSION_PATH = resolve(__dirname, '../../dist');

/** Anvil handle exposed to tests that need a local EVM RPC. */
export type Anvil = {
  rpcUrl: string;
  chainId: number;
  /** First pre-funded account (10 000 ETH on anvil default). */
  account: `0x${string}`;
};

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  /** chrome-extension://<id>/popup.html — for tests that open the popup
   *  themselves after some other event (e.g. dapp triggered a pending
   *  request). Use the `popup` fixture instead for simple direct-popup
   *  flows. */
  popupUrl: string;
  /** Onboarded-but-locked popup. The wallet vault has already been
   *  created (via global-setup) and injected into the fresh profile's
   *  `chrome.storage.local`, so the popup lands on the Unlock screen.
   *  Tests call `unlock(popup)` to reach the Dashboard — much faster
   *  than `onboard(popup)` (~1 s vs. ~5 s).
   *
   *  For tests that genuinely need a pristine, never-onboarded state
   *  (the onboarding spec itself), use `pristinePopup`. */
  popup: Page;
  /** Fresh-install popup — no vault, no accounts, no settings. Lands on
   *  the Welcome screen. Skips snapshot injection. Used by
   *  `onboarding.e2e.ts` and the first-unlock cases. */
  pristinePopup: Page;
  /** Lazy: only starts when a test requests it. Anvil 1.5.1 in PATH
   *  (foundry). Random port to avoid collisions across parallel runs. */
  anvil: Anvil;
};

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern — Playwright fixture signature.
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'aladdin-wallet-e2e-'));
    // Chrome's classic --headless=old doesn't load extensions. The new
    // headless mode (--headless=new) does, but Playwright's `headless: true`
    // still maps to the old flag for compat. Force the new mode via args
    // unless HEADED=1 is set (then we run with a real window for debugging).
    const headed = !!process.env.HEADED;
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // pass an explicit --headless=new arg below instead
      args: [
        ...(headed ? [] : ['--headless=new']),
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    // The SW may already be running (Playwright caught it during launch)
    // or may need a moment. Cap the wait so a missing extension fails fast
    // instead of riding the 30 s test timeout.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    // SW URL: chrome-extension://<id>/background.js
    const id = sw.url().split('/')[2]!;
    await use(id);
  },

  popupUrl: async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/popup.html`);
  },

  popup: async ({ context, popupUrl }, use) => {
    // Inject the onboarded chrome.storage.local snapshot before the
    // popup mounts so the wallet's route() sees the vault on first
    // render and lands on the Unlock screen. SW is guaranteed to be
    // up at this point (extensionId fixture resolved it already).
    if (!existsSync(SNAPSHOT_PATH)) {
      throw new Error(
        `e2e snapshot missing at ${SNAPSHOT_PATH}. Did playwright.config.ts ` +
        `lose its globalSetup setting? Run \`bunx playwright test\` from the ` +
        `repo root so global-setup.ts re-snapshots.`,
      );
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    const [sw] = context.serviceWorkers();
    if (!sw) throw new Error('no service worker available to inject storage snapshot');
    await sw.evaluate(async (s: Record<string, unknown>) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(s);
    }, snapshot);

    const page = await context.newPage();
    await page.goto(popupUrl);
    await use(page);
    await page.close();
  },

  pristinePopup: async ({ context, popupUrl }, use) => {
    // Opt-out of snapshot injection — used by onboarding spec and any
    // other test that needs to drive the wallet from a fresh-install
    // state.
    const page = await context.newPage();
    await page.goto(popupUrl);
    await use(page);
    await page.close();
  },

  // eslint-disable-next-line no-empty-pattern — Playwright fixture signature.
  anvil: async ({}, use) => {
    const port = await freePort();
    const proc = spawn(
      'anvil',
      [
        '--port', String(port),
        // Default mining mode is "automine" — block sealed on each tx,
        // which is exactly what we want for deterministic tx tests.
        // (`--block-time` requires a positive integer in Anvil 1.5+.)
        '--silent',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Wait for the RPC port to accept connections. Anvil prints `Listening
    // on 127.0.0.1:<port>` to stdout when ready, but `--silent` suppresses
    // most of that — fall back to a TCP probe with a short retry loop.
    await waitForPort(port, 5_000);
    const rpcUrl = `http://127.0.0.1:${port}`;
    await use({
      rpcUrl,
      chainId: 31337,
      // anvil's first pre-funded account, deterministic from the default mnemonic
      // ('test test test test test test test test test test test junk').
      account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
    proc.kill();
    // Wait for the process to actually exit so the port is free for the
    // next test. spawn().kill() is async — without this we occasionally
    // race the next test's freePort() picking the same port.
    await new Promise((r) => proc.once('exit', r));
  },
});

/** True iff the `anvil` binary is on PATH. Used by anvil-dependent
 *  tests to skip cleanly when foundry isn't installed (typical on
 *  fresh dev machines / minimal CI runners) — beats a confusing
 *  `ENOENT` crash mid-fixture. Result is cached for the process. */
let anvilProbeResult: boolean | null = null;
export function anvilAvailable(): boolean {
  if (anvilProbeResult !== null) return anvilProbeResult;
  try {
    const r = spawnSync('anvil', ['--version'], { stdio: 'ignore', timeout: 2_000 });
    anvilProbeResult = r.status === 0;
  } catch {
    anvilProbeResult = false;
  }
  return anvilProbeResult;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('could not get port'));
      }
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = new (require('node:net').Socket)();
      sock.setTimeout(200);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.connect(port, '127.0.0.1');
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} did not become ready within ${timeoutMs}ms`);
}

export { expect } from '@playwright/test';
