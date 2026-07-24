// tests/tx-scope.test.ts
// evaluateTxAgainstGrants — the sign-time, defense-in-depth check. Given an
// eth_sendTransaction and the active grant registry, it flags a call that
// lands on a live SESSION grant's target but falls outside that grant's
// recorded selectors / caps. Only session grants with a stored scope that
// match tx.to are considered; everything else (no match, 7702, revoked,
// expired) is "not our concern" → null.
import { test, expect } from "bun:test";
import { evaluateTxAgainstGrants } from "../src/lib/scope-guard";
import { normalizeScope, serializeScope, type GrantRecord } from "../src/lib/grant-scope";

const TARGET = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000;

const scope = normalizeScope({
  chainId: 4663,
  target: TARGET,
  allowedFunctions: ["mint(uint256)"],
  nativeCapWei: 1000n,
  gasCapWei: 0n,
  expiry: 9e9,
});
const mintSelector = scope.calls[0].selector;

function sessionGrant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    id: "4663:session:1",
    kind: "session",
    chainId: 4663,
    account: "0xabc",
    target: TARGET,
    scope: serializeScope(scope),
    createdAt: 1,
    expiry: 0,
    ...over,
  };
}

const inScopeData = `${mintSelector}${"0".repeat(64)}` as `0x${string}`;
const inScopeTx = { to: TARGET, data: inScopeData, value: 500n };

test("matching active session grant + out-of-scope selector → violation", () => {
  const v = evaluateTxAgainstGrants(
    { to: TARGET, data: "0xdeadbeef" as `0x${string}`, value: 0n },
    [sessionGrant()],
    NOW,
  );
  expect(v?.reason).toContain("not in the granted scope");
});

test("matching grant + in-scope call within cap → null", () => {
  expect(evaluateTxAgainstGrants(inScopeTx, [sessionGrant()], NOW)).toBeNull();
});

test("value over the grant's native cap → violation", () => {
  const v = evaluateTxAgainstGrants(
    { to: TARGET, data: inScopeData, value: 2000n },
    [sessionGrant()],
    NOW,
  );
  expect(v?.reason).toContain("exceeds native cap");
});

test("no session grant matches tx.to → null", () => {
  // grant is for OTHER; tx.to is TARGET → nothing to compare against.
  expect(evaluateTxAgainstGrants(inScopeTx, [sessionGrant({ target: OTHER })], NOW)).toBeNull();
});

test("tx to an address with no grant at all → null", () => {
  expect(
    evaluateTxAgainstGrants(
      { to: OTHER, data: inScopeData, value: 0n },
      [sessionGrant()],
      NOW,
    ),
  ).toBeNull();
});

test("revoked grant ignored → null even for an out-of-scope call", () => {
  expect(
    evaluateTxAgainstGrants(
      { to: TARGET, data: "0xdeadbeef" as `0x${string}`, value: 0n },
      [sessionGrant({ revokedAt: NOW - 10 })],
      NOW,
    ),
  ).toBeNull();
});

test("expired grant ignored → null even for an out-of-scope call", () => {
  expect(
    evaluateTxAgainstGrants(
      { to: TARGET, data: "0xdeadbeef" as `0x${string}`, value: 0n },
      [sessionGrant({ expiry: NOW - 1 })],
      NOW,
    ),
  ).toBeNull();
});

test("non-session (7702) grant ignored → null", () => {
  expect(
    evaluateTxAgainstGrants(
      { to: TARGET, data: "0xdeadbeef" as `0x${string}`, value: 0n },
      [sessionGrant({ kind: "7702", scope: undefined })],
      NOW,
    ),
  ).toBeNull();
});

test("first matching session grant is the one evaluated", () => {
  // A revoked grant sits before the live one — it must be skipped, and the
  // live grant's scope decides (in-scope call → null).
  const grants = [sessionGrant({ revokedAt: NOW - 1 }), sessionGrant()];
  expect(evaluateTxAgainstGrants(inScopeTx, grants, NOW)).toBeNull();
});
