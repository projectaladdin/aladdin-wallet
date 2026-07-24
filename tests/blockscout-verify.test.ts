// tests/blockscout-verify.test.ts
import { test, expect } from "bun:test";
import { verifyContractBlockscout, fetchContractAbiBlockscout } from "../src/lib/blockscout-verify";

const ok = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const notFound = async () => new Response("", { status: 404 });
const boom = async () => new Response("", { status: 500 });

const BASE = "https://robinhoodchain.blockscout.com/api";
const ADDR = "0x1111111111111111111111111111111111111111";

test("verified contract → status verified", async () => {
  const r = await verifyContractBlockscout(BASE, ADDR, ok({ is_verified: true, abi: [] }) as any);
  expect(r.status).toBe("verified");
});
test("404 → unverified", async () => {
  const r = await verifyContractBlockscout(BASE, ADDR, notFound as any);
  expect(r.status).toBe("unverified");
});
test("5xx → error", async () => {
  const r = await verifyContractBlockscout(BASE, ADDR, boom as any);
  expect(r.status).toBe("error");
});
test("abi fetch returns array on verified", async () => {
  const abi = await fetchContractAbiBlockscout(BASE, ADDR, ok({ is_verified: true, abi: [{ type: "function", name: "mint" }] }) as any);
  expect(abi?.[0]).toMatchObject({ name: "mint" });
});
