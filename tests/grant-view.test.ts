// tests/grant-view.test.ts
//
// Display-logic tests for the sign-confirm grant-review screen (Task 4.2).
// `describeGrantCan` turns a NormalizedScope into the human "CAN" lines the
// popup renders under "This permission CAN:". The negative-space "CANNOT"
// list is already covered by grant-scope.test.ts via `deriveCannotList`, so
// this file only exercises the new CAN helper.
import { test, expect } from "bun:test";
import { normalizeScope, describeGrantCan, type PermissionRequest } from "../src/lib/grant-scope";

const full: PermissionRequest = {
  chainId: 4663,
  target: "0x2222222222222222222222222222222222222222",
  allowedFunctions: ["mint(uint256)", "activate(uint256,uint8)"],
  nativeCapWei: 1_000_000_000_000_000_000n, // 1 ETH
  erc20Caps: [{ token: "0x3333333333333333333333333333333333333333", cap: 500_000_000n }],
  gasCapWei: 50_000_000_000_000_000n, // 0.05 ETH
  expiry: 1_800_000_000,
};

const bare: PermissionRequest = {
  chainId: 4663,
  target: "0x2222222222222222222222222222222222222222",
  allowedFunctions: ["mint(uint256)"],
  nativeCapWei: 0n,
  erc20Caps: [],
  gasCapWei: 0n,
  expiry: 1_800_000_000,
};

test("describeGrantCan names the target contract", () => {
  const lines = describeGrantCan(normalizeScope(full));
  expect(lines.join("\n")).toContain("0x2222222222222222222222222222222222222222");
});

test("describeGrantCan lists each functionName and full signature", () => {
  const joined = describeGrantCan(normalizeScope(full)).join("\n");
  expect(joined).toContain("mint");
  expect(joined).toContain("mint(uint256)");
  expect(joined).toContain("activate");
  expect(joined).toContain("activate(uint256,uint8)");
});

test("describeGrantCan includes caps when non-zero", () => {
  const joined = describeGrantCan(normalizeScope(full)).join("\n");
  // native cap
  expect(joined).toContain("1000000000000000000");
  // erc20 cap: value + token address
  expect(joined).toContain("500000000");
  expect(joined).toContain("0x3333333333333333333333333333333333333333");
  // gas cap
  expect(joined).toContain("50000000000000000");
});

test("describeGrantCan omits caps when zero", () => {
  const lines = describeGrantCan(normalizeScope(bare));
  const joined = joinLower(lines);
  expect(joined).not.toContain("native");
  expect(joined).not.toContain("token");
  expect(joined).not.toContain("gas");
});

test("describeGrantCan always renders an expiry line", () => {
  const joined = describeGrantCan(normalizeScope(bare)).join("\n");
  expect(joined).toContain("1800000000");
});

test("describeGrantCan omits a zero-value erc20 cap entry but keeps non-zero ones", () => {
  const mixed: PermissionRequest = {
    chainId: 4663,
    target: "0x2222222222222222222222222222222222222222",
    allowedFunctions: ["mint(uint256)"],
    nativeCapWei: 0n,
    erc20Caps: [
      // zero-value entry — must NOT produce a "Spend up to 0 units …" line
      { token: "0x4444444444444444444444444444444444444444", cap: 0n },
      // non-zero entry — must still render
      { token: "0x5555555555555555555555555555555555555555", cap: 123n },
    ],
    gasCapWei: 0n,
    expiry: 1_800_000_000,
  };
  const lines = describeGrantCan(normalizeScope(mixed));
  const erc20Lines = lines.filter((l) => l.startsWith("Spend up to") && l.includes("units of token"));
  // exactly one erc20 CAN line — the non-zero one
  expect(erc20Lines.length).toBe(1);
  expect(erc20Lines[0]).toContain("123");
  expect(erc20Lines[0]).toContain("0x5555555555555555555555555555555555555555");
  // the zero-cap token address never appears in any CAN line
  expect(lines.join("\n")).not.toContain("0x4444444444444444444444444444444444444444");
});

test("describeGrantCan renders a GENERIC grant neutrally (no per-call lines; caps + expiry kept)", () => {
  const generic: PermissionRequest = {
    chainId: 4663,
    generic: true,
    target: "0x0000000000000000000000000000000000000000",
    allowedFunctions: [],
    nativeCapWei: 0n,
    erc20Caps: [],
    gasCapWei: 0n,
    expiry: 1_800_000_000,
  };
  const lines = describeGrantCan(normalizeScope(generic));
  const joined = lines.join("\n");
  // neutral, on-your-behalf framing; expiry always present
  expect(joined.toLowerCase()).toContain("act on your behalf");
  expect(joined).toContain("1800000000");
  // a generic grant has no per-function "Call ...()" lines
  expect(lines.some((l) => l.startsWith("Call "))).toBe(false);
});

function joinLower(lines: string[]): string {
  return lines.join("\n").toLowerCase();
}
