// Playwright config — Chrome MV3 extension e2e tests.
//
// Loads the unpacked extension from `dist/` into a real Chromium with a
// persistent profile (extensions don't load in incognito). Tests live in
// `e2e/` and use the `extension` fixture to get a popup Page already
// pointed at chrome-extension://<id>/popup.html.
//
// Pre-req: `bun run build` must have produced dist/ — the config does NOT
// rebuild for you. CI should chain `bun run build && bun run test:e2e`.

import { defineConfig } from '@playwright/test';

// 4269 — a fixed, uncommon local port for the fixture dapp. Chosen to
// avoid 4318 (the previous pick, which collides with OpenTelemetry
// OTLP/HTTP if a local collector is running).
const DAPP_PORT = 4269;

export default defineConfig({
  testDir: './e2e',
  // Use .e2e.ts not .spec.ts so bare `bun test` (which auto-discovers
  // *.spec.ts everywhere) doesn't try to execute Playwright fixtures
  // and report 25 spurious failures. Unit tests live in tests/*.test.ts.
  testMatch: /.*\.e2e\.ts$/,
  // Runs once before the suite: onboards the wallet in a throwaway
  // profile and snapshots chrome.storage.local. Each test's popup
  // fixture loads the snapshot into a fresh profile, so individual
  // tests skip the slow Welcome → seed → password flow and start on
  // the Unlock screen (~1 s vs ~5 s).
  globalSetup: './e2e/_setup/global-setup.ts',
  // Fixture dapp — a tiny static HTML page driving EIP-1193 calls. We
  // host it ourselves rather than use the public MetaMask test-dapp so
  // the test suite stays offline-capable and stable across MM redesigns.
  webServer: {
    command: `bun run e2e/fixtures/serve.ts ${DAPP_PORT}`,
    url: `http://127.0.0.1:${DAPP_PORT}/test-dapp.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  // Extensions can't run in parallel against the same persistent profile;
  // give each test its own tmp profile via the fixture and serialise here.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${DAPP_PORT}/`,
    // Surface failures with screenshots — popup is 360×600, fits in one shot.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
