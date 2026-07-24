// AI/MCP-flagged origin storage tests (Task 6.2). The flag is a simple
// allow-list of origins, mirroring `connectedOrigins`:
//   aiOrigins: string[]
//
// Pins the invariants:
//   • getAiOrigins on an empty store → []
//   • setAiOrigin(origin, true) adds without duplicating on repeat
//   • setAiOrigin(origin, false) removes; isAiOrigin reflects state
//   • toggling one origin never disturbs another

import { beforeEach, describe, expect, test } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';

let storage: typeof import('../src/core/storage');

beforeEach(async () => {
  installChromeStub();
  storage = await import('../src/core/storage?t=' + Date.now());
});

const A = 'https://agent.example';
const B = 'https://other.example';

describe('AI origins registry', () => {
  test('getAiOrigins on empty store → []', async () => {
    expect(await storage.getAiOrigins()).toEqual([]);
    expect(await storage.isAiOrigin(A)).toBe(false);
  });

  test('setAiOrigin(true) flags the origin', async () => {
    await storage.setAiOrigin(A, true);
    expect(await storage.getAiOrigins()).toEqual([A]);
    expect(await storage.isAiOrigin(A)).toBe(true);
  });

  test('setAiOrigin(true) is idempotent (no duplicate)', async () => {
    await storage.setAiOrigin(A, true);
    await storage.setAiOrigin(A, true);
    expect(await storage.getAiOrigins()).toEqual([A]);
  });

  test('setAiOrigin(false) removes the flag', async () => {
    await storage.setAiOrigin(A, true);
    await storage.setAiOrigin(A, false);
    expect(await storage.getAiOrigins()).toEqual([]);
    expect(await storage.isAiOrigin(A)).toBe(false);
  });

  test('setAiOrigin(false) on an unflagged origin is a no-op', async () => {
    await storage.setAiOrigin(A, false);
    expect(await storage.getAiOrigins()).toEqual([]);
  });

  test('toggling one origin does not disturb another', async () => {
    await storage.setAiOrigin(A, true);
    await storage.setAiOrigin(B, true);
    await storage.setAiOrigin(A, false);
    expect(await storage.isAiOrigin(A)).toBe(false);
    expect(await storage.isAiOrigin(B)).toBe(true);
    expect(await storage.getAiOrigins()).toEqual([B]);
  });
});
