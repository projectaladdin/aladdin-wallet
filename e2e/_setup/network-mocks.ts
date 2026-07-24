// External-API mocks for e2e tests. Targets the network calls the
// wallet makes that aren't part of the chain RPC:
//   - Sourcify V2 contract lookup (7702 gate verification + ABI fetch
//     for the calldata decoder Sourcify fallback)
//   - DefiLlama price feed (USD prices in the hero/token list)
//
// Why intercept rather than hit the real services?
//   - Determinism: 7702 verify tests like "Sourcify returns 429 →
//     wallet shows 'verifier unreachable'" can't be reliably driven
//     against the real Sourcify (it doesn't return 429 on demand).
//   - Speed: a Sourcify round-trip is 200-500 ms; mocked is <1 ms.
//   - Offline: CI in a tight network environment can run the suite
//     without external reachability.
//   - Privacy property check: we can ASSERT the wallet never calls
//     out to e.g. 4byte.directory by intercepting * and routing
//     anything unexpected to a fail-the-test stub.
//
// Playwright's `context.route()` intercepts both page and Service
// Worker fetch calls within the same context, so the wallet's SW-side
// `fetchContractAbi` / `verifyContract` / DefiLlama price fetch are
// all visible here.

import type { BrowserContext, Route } from '@playwright/test';

/** Per-contract Sourcify mock entry. */
export type SourcifyContractMock = {
  /** HTTP status. 200 = verified or unverified depending on `body.match`;
   *  404 = unverified (the canonical "not on Sourcify" response);
   *  429/500 = error (verifier unreachable). */
  status?: number;
  /** JSON body of the response. For status=200:
   *    `{ match: 'exact_match', verifiedAt: '...', abi: [...] }`
   *  Match values: 'exact_match' | 'match' | null. */
  body?: unknown;
};

export type SourcifyScenario = {
  /** Per-(chainId, lowercase-address) responses. Keyed by `${chainId}:${addr}`.
   *  Addresses without an entry get 404 by default (treated as "unverified"
   *  by the wallet). */
  contracts: Record<string, SourcifyContractMock>;
  /** If true, throw if Sourcify is called for an address NOT in `contracts`.
   *  Used by tests asserting the wallet skips Sourcify in some scenario
   *  (e.g. revoke flow). */
  unexpectedFailsTest?: boolean;
};

/** Install a Sourcify route handler on `context`. Idempotent within a
 *  test — calling twice replaces the previous handler. */
export async function mockSourcify(
  context: BrowserContext,
  scenario: SourcifyScenario,
): Promise<{ callCount: () => number; calls: () => string[] }> {
  const calls: string[] = [];
  await context.unroute('**/sourcify.dev/**').catch(() => { /* none registered yet */ });
  await context.route('**/sourcify.dev/**', (route: Route) => {
    const url = new URL(route.request().url());
    // URL shape: /server/v2/contract/{chainId}/{address}?fields=...
    const m = url.pathname.match(/\/v2\/contract\/(\d+)\/(0x[a-fA-F0-9]{40})/);
    if (!m) {
      // Unknown Sourcify endpoint — pass through to real (or 404 to
      // be safe if offline). Test-side mocks only cover what we know.
      void route.fulfill({ status: 404, body: '{}' });
      return;
    }
    const chainId = m[1]!;
    const addr = m[2]!.toLowerCase();
    const key = `${chainId}:${addr}`;
    calls.push(key + (url.search ? url.search : ''));

    const mock = scenario.contracts[key];
    if (!mock) {
      if (scenario.unexpectedFailsTest) {
        // Returning 500 with a marker body — test asserts the URL
        // wasn't called, so this is just a paranoid safety net.
        void route.fulfill({
          status: 500,
          body: JSON.stringify({ error: 'unexpected sourcify call', key }),
        });
        return;
      }
      // Default for un-mocked addresses: 404 unverified.
      void route.fulfill({
        status: 404,
        body: JSON.stringify({ match: null }),
        headers: { 'content-type': 'application/json' },
      });
      return;
    }

    void route.fulfill({
      status: mock.status ?? 200,
      body: JSON.stringify(mock.body ?? {}),
      headers: { 'content-type': 'application/json' },
    });
  });

  return {
    callCount: () => calls.length,
    calls: () => calls.slice(),
  };
}

/** Helper: build a `contracts` entry for the canonical "verified" reply
 *  (exact_match + a recent verifiedAt). Caller supplies the chainId and
 *  address; optional `abi` rides along for the calldata fallback path. */
export function verifiedContract(
  chainId: number,
  address: string,
  opts: { abi?: unknown[] } = {},
): [string, SourcifyContractMock] {
  return [`${chainId}:${address.toLowerCase()}`, {
    status: 200,
    body: {
      match: 'exact_match',
      verifiedAt: '2025-01-01T00:00:00Z',
      ...(opts.abi ? { abi: opts.abi } : {}),
    },
  }];
}

/** Helper: build an "unverified" reply (404 + match:null). */
export function unverifiedContract(
  chainId: number,
  address: string,
): [string, SourcifyContractMock] {
  return [`${chainId}:${address.toLowerCase()}`, {
    status: 404,
    body: { match: null },
  }];
}

/** Helper: build an "error" reply (verifier unreachable — 429 or 500). */
export function unreachableContract(
  chainId: number,
  address: string,
  status: 429 | 500 = 429,
): [string, SourcifyContractMock] {
  return [`${chainId}:${address.toLowerCase()}`, {
    status,
    body: '',
  }];
}
