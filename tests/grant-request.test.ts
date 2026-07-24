// tests/grant-request.test.ts
import { test, expect } from "bun:test";
import { parseGrantPermissionsRequest } from "../src/lib/grant-request";
import { normalizeScope } from "../src/lib/grant-scope";

const CHAIN = 4663;
const TARGET = "0x2222222222222222222222222222222222222222";

/** A fresh, well-formed ERC-7715 `wallet_grantPermissions` params array. */
function validParams() {
  return [
    {
      chainId: `0x${CHAIN.toString(16)}`,
      expiry: 1_800_000_000,
      permissions: [
        {
          type: "contract-call",
          data: {
            target: TARGET,
            allowedFunctions: ["mint(uint256)", "activate(uint256,uint8)"],
          },
        },
      ],
    },
  ] as any[];
}

test("parses a valid ERC-7715 request into a PermissionRequest", () => {
  const req = parseGrantPermissionsRequest(validParams(), CHAIN);
  expect(req.chainId).toBe(CHAIN);
  expect(req.target).toBe(TARGET);
  expect(req.allowedFunctions).toEqual(["mint(uint256)", "activate(uint256,uint8)"]);
  expect(req.expiry).toBe(1_800_000_000);
  // Round-trips cleanly through the scope normaliser (selectors derived).
  const scope = normalizeScope(req);
  expect(scope.calls.map((c) => c.functionName)).toEqual(["mint", "activate"]);
});

test("throws when the target is a wildcard ('*')", () => {
  const p = validParams();
  p[0].permissions[0].data.target = "*";
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/target/i);
});

test("throws when the target is missing", () => {
  const p = validParams();
  delete p[0].permissions[0].data.target;
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/target/i);
});

test("throws when the target is the zero address (wildcard)", () => {
  const p = validParams();
  p[0].permissions[0].data.target = "0x0000000000000000000000000000000000000000";
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/target/i);
});

test("throws when allowedFunctions is empty", () => {
  const p = validParams();
  p[0].permissions[0].data.allowedFunctions = [];
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/function/i);
});

test("throws when expiry is missing", () => {
  const p = validParams();
  delete p[0].expiry;
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/expiry/i);
});

test("throws when expiry is non-positive", () => {
  const p = validParams();
  p[0].expiry = 0;
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/expiry/i);
});

test("parses a GENERIC request (generic:true) with no target/functions", () => {
  const p = [
    { chainId: `0x${CHAIN.toString(16)}`, expiry: 1_800_000_000, permissions: [{ data: { generic: true } }] },
  ] as any[];
  const req = parseGrantPermissionsRequest(p, CHAIN);
  expect(req.generic).toBe(true);
  expect(req.allowedFunctions).toEqual([]);
  const scope = normalizeScope(req);
  expect(scope.generic).toBe(true);
  expect(scope.calls).toEqual([]);
});

test("accepts generic:true at the top level too", () => {
  const p = [{ chainId: `0x${CHAIN.toString(16)}`, expiry: 1_800_000_000, generic: true }] as any[];
  expect(parseGrantPermissionsRequest(p, CHAIN).generic).toBe(true);
});

test("a generic request STILL requires a valid expiry", () => {
  const p = [{ generic: true }] as any[];
  expect(() => parseGrantPermissionsRequest(p, CHAIN)).toThrow(/expiry/i);
});
