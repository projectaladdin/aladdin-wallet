import { test, expect } from "bun:test";
import { KNOWN_WALLET_METHODS } from "../src/shared/protocol";

test("wallet_grantPermissions is a known wallet method", () => {
  expect(KNOWN_WALLET_METHODS.has("wallet_grantPermissions")).toBe(true);
});
