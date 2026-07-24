// src/lib/blockscout-verify.ts
import type { VerificationResult } from "./contract-verify";

export type FetchFn = typeof fetch;

function smartContractUrl(apiBase: string, address: string): string {
  // apiBase looks like ".../api"; the v2 REST lives at ".../api/v2/smart-contracts/{addr}".
  return `${apiBase}/v2/smart-contracts/${address.toLowerCase()}`;
}

export async function verifyContractBlockscout(
  apiBase: string, address: string, fetchFn: FetchFn = fetch,
): Promise<VerificationResult> {
  try {
    const res = await fetchFn(smartContractUrl(apiBase, address));
    if (res.status === 404) return { status: "unverified" };
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { is_verified?: boolean };
    return body?.is_verified ? { status: "verified", match: "match" } : { status: "unverified" };
  } catch {
    return { status: "error" };
  }
}

export async function fetchContractAbiBlockscout(
  apiBase: string, address: string, fetchFn: FetchFn = fetch,
): Promise<unknown[] | null> {
  try {
    const res = await fetchFn(smartContractUrl(apiBase, address));
    if (!res.ok) return null;
    const body = (await res.json()) as { abi?: unknown[] };
    return Array.isArray(body?.abi) ? body.abi : null;
  } catch {
    return null;
  }
}
