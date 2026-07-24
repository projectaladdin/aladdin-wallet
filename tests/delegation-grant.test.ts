// tests/delegation-grant.test.ts
// Pure helpers backing Task 4.1 — recording every successful 7702
// authorization into the generic grant registry, and treating a delegation
// to the zero address as a REVOCATION of the newest active 7702 grant.
import { test, expect, describe } from "bun:test";
import {
  isZeroDelegate,
  buildDelegationGrantRecord,
  pickNewestActive7702GrantId,
} from "../src/lib/delegation-grant";
import type { GrantRecord } from "../src/lib/grant-scope";

const ZERO = "0x0000000000000000000000000000000000000000";
const DELEGATE = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

describe("isZeroDelegate", () => {
  test("canonical 40-zero form is zero", () => {
    expect(isZeroDelegate(ZERO)).toBe(true);
  });

  test("case-insensitive / uppercase 0X prefix still zero", () => {
    expect(isZeroDelegate("0X0000000000000000000000000000000000000000")).toBe(true);
  });

  test("short 0x0 form is zero", () => {
    expect(isZeroDelegate("0x0")).toBe(true);
  });

  test("a real delegate address is NOT zero", () => {
    expect(isZeroDelegate(DELEGATE)).toBe(false);
  });

  test("an address that merely starts with zeros is NOT zero", () => {
    expect(isZeroDelegate("0x0000000000000000000000000000000000000001")).toBe(false);
  });

  test("garbage / non-hex is NOT zero", () => {
    expect(isZeroDelegate("0x")).toBe(false);
    expect(isZeroDelegate("not-an-address")).toBe(false);
    expect(isZeroDelegate("")).toBe(false);
  });
});

describe("buildDelegationGrantRecord", () => {
  const rec = buildDelegationGrantRecord({
    delegate: DELEGATE,
    chainId: 4663,
    account: "0xDeAdBeEf00000000000000000000000000000000",
    createdAt: 1_700_000_000,
    txHash: "0xhash",
  });

  test("kind is 7702", () => {
    expect(rec.kind).toBe("7702");
  });

  test("target is the delegate", () => {
    expect(rec.target).toBe(DELEGATE);
  });

  test("account is lowercased", () => {
    expect(rec.account).toBe("0xdeadbeef00000000000000000000000000000000");
  });

  test("id is 7702:chainId:delegateLower:createdAt", () => {
    expect(rec.id).toBe(`7702:4663:${DELEGATE.toLowerCase()}:1700000000`);
  });

  test("expiry is 0 (never) and scope is undefined", () => {
    expect(rec.expiry).toBe(0);
    expect(rec.scope).toBeUndefined();
  });

  test("chainId / createdAt / txHash are carried through", () => {
    expect(rec.chainId).toBe(4663);
    expect(rec.createdAt).toBe(1_700_000_000);
    expect(rec.txHash).toBe("0xhash");
  });

  test("txHash is omitted when not provided", () => {
    const r = buildDelegationGrantRecord({
      delegate: DELEGATE,
      chainId: 1,
      account: "0xabc",
      createdAt: 5,
    });
    expect(r.txHash).toBeUndefined();
  });
});

describe("pickNewestActive7702GrantId", () => {
  const base: Omit<GrantRecord, "id" | "createdAt"> = {
    kind: "7702",
    chainId: 4663,
    account: "0xdead",
    target: DELEGATE,
    expiry: 0,
  };

  test("empty list → null", () => {
    expect(pickNewestActive7702GrantId([])).toBeNull();
  });

  test("picks the greatest createdAt among active 7702 grants", () => {
    const grants: GrantRecord[] = [
      { ...base, id: "a", createdAt: 10 },
      { ...base, id: "b", createdAt: 30 },
      { ...base, id: "c", createdAt: 20 },
    ];
    expect(pickNewestActive7702GrantId(grants)).toBe("b");
  });

  test("ignores revoked grants (even if newest)", () => {
    const grants: GrantRecord[] = [
      { ...base, id: "old", createdAt: 10 },
      { ...base, id: "revoked-newest", createdAt: 99, revokedAt: 100 },
    ];
    expect(pickNewestActive7702GrantId(grants)).toBe("old");
  });

  test("ignores non-7702 (session) grants", () => {
    const grants: GrantRecord[] = [
      { ...base, kind: "session", id: "sess", createdAt: 99 },
      { ...base, id: "7702", createdAt: 10 },
    ];
    expect(pickNewestActive7702GrantId(grants)).toBe("7702");
  });

  test("null when every 7702 grant is revoked", () => {
    const grants: GrantRecord[] = [
      { ...base, id: "r1", createdAt: 10, revokedAt: 11 },
      { ...base, id: "r2", createdAt: 20, revokedAt: 21 },
    ];
    expect(pickNewestActive7702GrantId(grants)).toBeNull();
  });
});
