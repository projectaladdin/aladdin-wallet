// verifyContract — Sourcify V2 lookup. These tests mock global fetch
// so they don't actually hit sourcify.dev (no network in CI; flaky
// real-API otherwise). The four cases pin the documented response
// shapes (200 verified, 200 unverified, 404, 429/500/network err)
// to the four output statuses.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { verifyContract } from '../src/lib/contract-verify';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
type FetchImpl = (...args: FetchArgs) => Promise<Response>;
const realFetch: FetchImpl = globalThis.fetch as FetchImpl;

function mockFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = impl;
}

beforeEach(() => {
  // Default mock to a no-op fail; each test overrides.
  mockFetch(() => Promise.reject(new Error('fetch not mocked')));
});

afterEach(() => {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = realFetch;
});

describe('verifyContract', () => {
  test('200 + match=exact_match → verified, match=exact_match', async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ match: 'exact_match', verifiedAt: '2026-05-08T08:38:30Z' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const r = await verifyContract(1, '0x4206936776996fD5DFd13dB2D69b38a5FA23C848');
    expect(r.status).toBe('verified');
    expect(r.match).toBe('exact_match');
    expect(r.verifiedAt).toBe('2026-05-08T08:38:30Z');
  });

  test('200 + match=match (partial-metadata) also verified', async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ match: 'match', verifiedAt: '2024-01-15T00:00:00Z' }),
      { status: 200 },
    )));
    const r = await verifyContract(1, '0x0000000000000000000000000000000000000001');
    expect(r.status).toBe('verified');
    expect(r.match).toBe('match');
  });

  test('404 + match=null → unverified', async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ match: null }),
      { status: 404 },
    )));
    const r = await verifyContract(1, '0x0000000000000000000000000000000000000000');
    expect(r.status).toBe('unverified');
    expect(r.match).toBeUndefined();
  });

  test('429 rate-limit → error (fail-closed)', async () => {
    mockFetch(() => Promise.resolve(new Response('', { status: 429 })));
    const r = await verifyContract(1, '0xabc');
    expect(r.status).toBe('error');
  });

  test('400 unsupported_chain → error', async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ customCode: 'unsupported_chain' }),
      { status: 400 },
    )));
    const r = await verifyContract(99999, '0xabc');
    expect(r.status).toBe('error');
  });

  test('fetch throws (network down) → error, no throw to caller', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await verifyContract(1, '0xabc');
    expect(r.status).toBe('error');
  });

  test('500 server error → error', async () => {
    mockFetch(() => Promise.resolve(new Response('', { status: 500 })));
    const r = await verifyContract(1, '0xabc');
    expect(r.status).toBe('error');
  });

  test('200 with unexpected body shape → unverified (defensive)', async () => {
    // Sourcify's contract is to return `match` as one of three values;
    // any deviation we treat as unverified rather than throwing.
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ someOtherField: 'hello' }),
      { status: 200 },
    )));
    const r = await verifyContract(1, '0xabc');
    expect(r.status).toBe('unverified');
  });

  test('mixed-case address → lowercased in the request URL', async () => {
    // Sourcify's address validator rejects non-EIP-55-checksum mixed
    // case with HTTP 400 invalid_parameter, which would surface as
    // "verifier unreachable" in the UI even though the contract
    // simply isn't indexed. Lowercase the address before fetching to
    // avoid that misclassification.
    let capturedUrl: string | URL | Request | undefined;
    mockFetch((input: RequestInfo | URL) => {
      capturedUrl = input;
      return Promise.resolve(new Response(
        JSON.stringify({ match: null }),
        { status: 404 },
      ));
    });
    await verifyContract(1, '0xdEAD00000000000000000000000000000000bEEF');
    expect(String(capturedUrl)).toContain('0xdead00000000000000000000000000000000beef');
    expect(String(capturedUrl)).not.toContain('0xdEAD');
  });
});
