// tests/contract-verify-routing.test.ts
import { test, expect } from "bun:test";
import { verifyContract, fetchContractAbi } from "../src/lib/contract-verify";

test("RH chain routes to Blockscout host, not Sourcify", async () => {
  let calledUrl = "";
  const spy = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ is_verified: true }), { status: 200 });
  }) as any;
  const r = await verifyContract(4663, "0x1111111111111111111111111111111111111111", spy);
  expect(calledUrl).toContain("robinhoodchain.blockscout.com");
  expect(calledUrl).not.toContain("sourcify");
  expect(r.status).toBe("verified");
});

test("RH testnet chain routes to Blockscout host for verifyContract", async () => {
  let calledUrl = "";
  const spy = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ is_verified: true }), { status: 200 });
  }) as any;
  const r = await verifyContract(46630, "0x2222222222222222222222222222222222222222", spy);
  expect(calledUrl).toContain("robinhoodchain.blockscout.com");
  expect(calledUrl).not.toContain("sourcify");
  expect(r.status).toBe("verified");
});

test("RH chain routes fetchContractAbi to Blockscout host, not Sourcify", async () => {
  let calledUrl = "";
  const spy = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ abi: [{ type: "function", name: "foo" }] }), { status: 200 });
  }) as any;
  const abi = await fetchContractAbi(4663, "0x3333333333333333333333333333333333333333", spy);
  expect(calledUrl).toContain("robinhoodchain.blockscout.com");
  expect(calledUrl).not.toContain("sourcify");
  expect(Array.isArray(abi)).toBe(true);
});

test("non-RH chain still hits Sourcify via injected fetchFn", async () => {
  let calledUrl = "";
  const spy = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ match: "exact_match" }), { status: 200 });
  }) as any;
  const r = await verifyContract(1, "0x4444444444444444444444444444444444444444", spy);
  expect(calledUrl).toContain("sourcify");
  expect(calledUrl).not.toContain("blockscout");
  expect(r.status).toBe("verified");
});
