import { test, expect } from "bun:test";
import { checkCallWithinScope, scopeExceedsRequest } from "../src/lib/scope-guard";
import { normalizeScope } from "../src/lib/grant-scope";

const scope = normalizeScope({
  chainId: 4663, target: "0x2222222222222222222222222222222222222222",
  allowedFunctions: ["mint(uint256)"], nativeCapWei: 1000n, gasCapWei: 0n, expiry: 9e9,
});
const mintSelector = scope.calls[0].selector;

test("in-scope call passes", () => {
  expect(checkCallWithinScope(scope, scope.target, `${mintSelector}0000`, 500n)).toBeNull();
});
test("out-of-scope target blocked", () => {
  expect(checkCallWithinScope(scope, "0x3333333333333333333333333333333333333333", `${mintSelector}00`, 0n)?.reason).toContain("outside");
});
test("out-of-scope selector blocked", () => {
  expect(checkCallWithinScope(scope, scope.target, "0xdeadbeef", 0n)?.reason).toContain("not in the granted scope");
});
test("value over cap blocked", () => {
  expect(checkCallWithinScope(scope, scope.target, `${mintSelector}00`, 2000n)?.reason).toContain("exceeds native cap");
});
test("scopeExceedsRequest catches a raised cap", () => {
  const wider = normalizeScope({ chainId: 4663, target: scope.target, allowedFunctions: ["mint(uint256)"], nativeCapWei: 5000n, gasCapWei: 0n, expiry: 9e9 });
  expect(scopeExceedsRequest(scope, wider)?.reason).toContain("native cap");
});
