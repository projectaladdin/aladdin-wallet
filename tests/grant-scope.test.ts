// tests/grant-scope.test.ts
import { test, expect } from "bun:test";
import { normalizeScope, deriveCannotList, serializeScope, deserializeScope, type PermissionRequest } from "../src/lib/grant-scope";

const req: PermissionRequest = {
  chainId: 4663,
  target: "0x2222222222222222222222222222222222222222",
  allowedFunctions: ["mint(uint256)", "activate(uint256,uint8)"],
  nativeCapWei: 0n,
  gasCapWei: 50000000000000000n, // 0.05 ETH
  expiry: 1_800_000_000,
};

test("normalizeScope derives selectors from signatures", () => {
  const s = normalizeScope(req);
  expect(s.target).toBe("0x2222222222222222222222222222222222222222");
  expect(s.calls.map(c => c.functionName)).toEqual(["mint", "activate"]);
  expect(s.calls[0].selector).toMatch(/^0x[0-9a-f]{8}$/);
});

test("deriveCannotList names the target and functions", () => {
  const list = deriveCannotList(normalizeScope(req)).join(" ");
  expect(list).toContain("mint, activate");
  expect(list).toContain("token-bound account");
});

test("serialize/deserialize round-trips bigints via strings", () => {
  const s = normalizeScope(req);
  const back = deserializeScope(serializeScope(s));
  expect(back.gasCapWei).toBe(50000000000000000n);
  expect(typeof serializeScope(s).gasCapWei).toBe("string");
});

test("normalizeScope handles a generic grant (any-target sentinel, no calls)", () => {
  const s = normalizeScope({ ...req, generic: true });
  expect(s.generic).toBe(true);
  expect(s.calls).toEqual([]);
  expect(s.target).toBe("0x0000000000000000000000000000000000000000");
});

test("deriveCannotList for a generic grant is honest, not a false reassurance", () => {
  const joined = deriveCannotList(normalizeScope({ ...req, generic: true })).join(" ").toLowerCase();
  // it DOES say it expires and can't extend/raise itself
  expect(joined).toContain("expires");
  expect(joined).toMatch(/more time|raise/);
  // it must NOT claim it can't move assets / touch NFTs / TBAs — a generic key CAN
  expect(joined).not.toContain("nft");
  expect(joined).not.toContain("token-bound");
});

test("serialize/deserialize carries the generic flag", () => {
  const stored = serializeScope(normalizeScope({ ...req, generic: true }));
  expect(stored.generic).toBe(true);
  expect(deserializeScope(stored).generic).toBe(true);
});
