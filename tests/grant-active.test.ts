// tests/grant-active.test.ts
// isGrantActive — the Safety Panel's "is this grant still live?" predicate.
// A grant is active iff it hasn't been revoked AND hasn't expired.
//   • revokedAt set        → dead (regardless of expiry)
//   • expiry === 0         → never expires → live (unless revoked)
//   • expiry > now         → still in window → live
//   • expiry <= now        → expired → dead
import { test, expect } from "bun:test";
import { isGrantActive, type GrantRecord } from "../src/lib/grant-scope";

const NOW = 1_800_000_000;

const base: GrantRecord = {
  id: "4663:0xabc:1",
  kind: "session",
  chainId: 4663,
  account: "0xdead",
  target: "0xabc",
  createdAt: 1,
  expiry: 0,
};

test("active: no revoke, no expiry → true", () => {
  expect(isGrantActive(base, NOW)).toBe(true);
});

test("revoked → false (even with no expiry)", () => {
  expect(isGrantActive({ ...base, revokedAt: NOW - 10 }, NOW)).toBe(false);
});

test("expired (expiry <= now) → false", () => {
  expect(isGrantActive({ ...base, expiry: NOW - 1 }, NOW)).toBe(false);
});

test("expiry exactly now → false (strictly-greater window)", () => {
  expect(isGrantActive({ ...base, expiry: NOW }, NOW)).toBe(false);
});

test("future expiry → true", () => {
  expect(isGrantActive({ ...base, expiry: NOW + 1 }, NOW)).toBe(true);
});

test("revoked AND future expiry → false (revoke wins)", () => {
  expect(isGrantActive({ ...base, expiry: NOW + 10_000, revokedAt: NOW - 5 }, NOW)).toBe(false);
});
