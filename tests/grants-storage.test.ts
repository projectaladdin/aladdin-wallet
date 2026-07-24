// Grant-registry storage tests — the generic grant store used by the 7702 /
// session-permission flows (tasks 4.x). Storage shape:
//   grants: Record<chainIdString, Record<accountLower, GrantRecord[]>>
//
// Pins the invariants that are easy to break:
//   • listGrants is case-insensitive on account (dapp may send checksum, we
//     store lowercased) → mismatched casing must still find the grant
//   • addGrant nests chainId → account → [] and appends (doesn't clobber)
//   • revokeGrant stamps revokedAt on the matching id regardless of which
//     chain/account bucket the grant lives in

import { beforeEach, describe, expect, test } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';
import type { GrantRecord } from '../src/lib/grant-scope';

let storage: typeof import('../src/core/storage');

beforeEach(async () => {
  installChromeStub();
  storage = await import('../src/core/storage?t=' + Date.now());
});

const g: GrantRecord = {
  id: '4663:0xabc:1',
  kind: 'session',
  chainId: 4663,
  account: '0xdead',
  target: '0xabc',
  createdAt: 1,
  expiry: 0,
};

describe('grant registry', () => {
  test('listGrants on empty store → []', async () => {
    expect(await storage.listGrants(4663, '0xdead')).toEqual([]);
  });

  test('add + list per chain/account', async () => {
    await storage.addGrant(g);
    const list = await storage.listGrants(4663, '0xdead');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('4663:0xabc:1');
  });

  test('listGrants is case-insensitive on account', async () => {
    await storage.addGrant(g);
    const list = await storage.listGrants(4663, '0xDEAD');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('4663:0xabc:1');
  });

  test('addGrant lowercases the account it stores under', async () => {
    await storage.addGrant({ ...g, id: 'X', account: '0xDeAdBeEf' });
    // Read back with a differently-cased account — must still resolve.
    const list = await storage.listGrants(4663, '0XDEADBEEF');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('X');
  });

  test('addGrant appends without clobbering existing grants', async () => {
    await storage.addGrant(g);
    await storage.addGrant({ ...g, id: '4663:0xabc:2' });
    const list = await storage.listGrants(4663, '0xdead');
    expect(list.map((x) => x.id)).toEqual(['4663:0xabc:1', '4663:0xabc:2']);
  });

  test('grants are isolated per chain and per account', async () => {
    await storage.addGrant(g); // chain 4663, 0xdead
    await storage.addGrant({ ...g, id: 'other-chain', chainId: 1 });
    await storage.addGrant({ ...g, id: 'other-acct', account: '0xbeef' });
    expect(await storage.listGrants(4663, '0xdead')).toHaveLength(1);
    expect(await storage.listGrants(1, '0xdead')).toHaveLength(1);
    expect(await storage.listGrants(4663, '0xbeef')).toHaveLength(1);
    expect(await storage.listGrants(137, '0xdead')).toEqual([]);
  });

  test('revoke stamps revokedAt on the matching grant', async () => {
    await storage.addGrant(g);
    await storage.revokeGrant('4663:0xabc:1', 999);
    const list = await storage.listGrants(4663, '0xdead');
    expect(list[0]!.revokedAt).toBe(999);
  });

  test('revokeGrant finds the grant regardless of chain/account bucket', async () => {
    await storage.addGrant(g); // chain 4663, 0xdead
    await storage.addGrant({ ...g, id: 'buried', chainId: 1, account: '0xbeef' });
    await storage.revokeGrant('buried', 555);
    const list = await storage.listGrants(1, '0xbeef');
    expect(list[0]!.revokedAt).toBe(555);
    // Untouched grant keeps no revokedAt.
    expect((await storage.listGrants(4663, '0xdead'))[0]!.revokedAt).toBeUndefined();
  });

  test('revokeGrant on unknown id is a no-op (does not throw)', async () => {
    await storage.addGrant(g);
    await storage.revokeGrant('nope', 1);
    expect((await storage.listGrants(4663, '0xdead'))[0]!.revokedAt).toBeUndefined();
  });
});
