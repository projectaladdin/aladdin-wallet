// Open-source verification gate for EIP-7702 delegation targets.
//
// Per the wallet's audit, delegating an EOA to an unverified contract
// is one of the highest-leverage attacks (the delegate gets full
// control over every asset the EOA holds). Block the slide-to-confirm
// gesture in the popup whenever the target contract isn't open-source.
//
// Implementation: Sourcify V2 lookup. Sourcify is Ethereum Foundation-
// sponsored, decentralised, no API key, no signup, multichain. Both
// `exact_match` and `match` statuses are accepted — they differ only
// in whether the metadata IPFS hash is embedded in the deployed
// bytecode, NOT in whether the runtime code matches the source. For
// the "is the deployed contract auditable?" question we ask here,
// both are equivalent.
//
// Fail-closed policy: any non-200 response from Sourcify (404, 400
// `unsupported_chain`, 429 rate-limit, 500, network error, timeout)
// resolves to `status: 'error'`. Caller treats `error` the same as
// `unverified` for safety, but the UI surfaces the distinction so the
// user knows whether to retry or accept the gate as final.

import { isRobinhoodChain, blockscoutApiBaseFor } from '../shared/rh-chains';
import {
  verifyContractBlockscout,
  fetchContractAbiBlockscout,
  type FetchFn,
} from './blockscout-verify';

/** Result of a verification lookup against Sourcify V2.
 *
 *  Map of status → caller semantics:
 *    verified   → allow the 7702 sign gesture
 *    unverified → block (contract has NO source on Sourcify for this chain)
 *    error      → block (verifier unreachable / chain unsupported / rate-limited)
 */
export type VerificationStatus = 'verified' | 'unverified' | 'error';

export type VerificationResult = {
  status: VerificationStatus;
  /** Sourcify's match grade — `exact_match` is byte-identical including
   *  metadata; `match` is byte-identical executable code, metadata may
   *  differ. Either is fine for our purposes (the runtime EVM behaviour
   *  is determined by the executable bytes, not the metadata tail). */
  match?: 'exact_match' | 'match';
  /** ISO timestamp from Sourcify when the contract was verified. Only
   *  set on `status: 'verified'`. UI shows this as a small badge so
   *  the user knows the source has existed for a while (vs. just-
   *  verified, which could be a fresh attacker prep). */
  verifiedAt?: string;
};

const SOURCIFY_BASE = 'https://sourcify.dev/server/v2/contract';

/** Fetch the ABI (function/event/error definitions) of a verified
 *  contract from Sourcify V2. Returns null on any failure — caller
 *  decides whether to fall back to raw-selector display.
 *
 *  Sourcify V2's `?fields=abi` query asks for just the ABI without
 *  pulling the full source bundle, keeping the response small.
 *
 *  Used by the calldata decoder's fallback path: when the bundled
 *  selector table (selector-table.ts) doesn't match a tx's function
 *  selector, the SW fetches the destination contract's ABI from here
 *  and tries to decode again with `decodeTxDataWithAbi`. */
export async function fetchContractAbi(
  chainId: number,
  address: string,
  fetchFn: FetchFn = fetch,
): Promise<unknown[] | null> {
  // Robinhood Chain isn't on Sourcify — its contracts are verified on the
  // chain's Blockscout instance. Route RH ids there; all other chains keep
  // using the Sourcify path below.
  if (isRobinhoodChain(chainId)) {
    const base = blockscoutApiBaseFor(chainId)!;
    return fetchContractAbiBlockscout(base, address, fetchFn);
  }

  const url = `${SOURCIFY_BASE}/${chainId}/${address.toLowerCase()}?fields=abi`;
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (res.status !== 200) return null;
    const body = await res.json() as { abi?: unknown };
    if (!Array.isArray(body.abi)) return null;
    return body.abi;
  } catch {
    return null;
  }
}

/** Look up a contract's verification status on Sourcify V2.
 *
 *  Never throws — every failure mode resolves to a `VerificationResult`.
 *  Callers don't need a try/catch wrapper.
 *
 *  @param chainId  EIP-155 chain ID (e.g. 1 mainnet, 11155111 sepolia).
 *  @param address  0x-prefixed 20-byte address. Caller should lowercase
 *                  beforehand or pass mixed-case; Sourcify accepts both.
 */
export async function verifyContract(
  chainId: number,
  address: string,
  fetchFn: FetchFn = fetch,
): Promise<VerificationResult> {
  // Robinhood Chain isn't on Sourcify — its contracts are verified on the
  // chain's Blockscout instance. Route RH ids there; all other chains keep
  // using the Sourcify path below.
  if (isRobinhoodChain(chainId)) {
    const base = blockscoutApiBaseFor(chainId)!;
    return verifyContractBlockscout(base, address, fetchFn);
  }

  // Sourcify's address validator is strict: mixed-case input that
  // isn't a valid EIP-55 checksum (e.g. `0xdEAD…bEEF` style vanity
  // addresses) is rejected with HTTP 400 invalid_parameter, which
  // we'd otherwise misclassify as "verifier unreachable". Lowercase
  // is always accepted, so normalise before the fetch. The dapp
  // signing this auth will see whatever case it submitted — we only
  // lowercase the query, not the user's actual delegate target.
  const url = `${SOURCIFY_BASE}/${chainId}/${address.toLowerCase()}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch {
    return { status: 'error' };
  }

  if (res.status === 404) return { status: 'unverified' };
  if (res.status !== 200) {
    // 400 unsupported_chain, 429 too-many, 500 server. Documented in
    // Sourcify's OpenAPI. Treated as ambiguous → fail-closed at the
    // caller, but distinct from 'unverified' so the UI can say
    // "verifier unreachable, try again" instead of misleadingly
    // claiming the contract isn't on Sourcify.
    return { status: 'error' };
  }

  let body: { match?: string | null; verifiedAt?: string };
  try {
    body = await res.json() as { match?: string | null; verifiedAt?: string };
  } catch {
    return { status: 'error' };
  }

  if (body.match === 'exact_match' || body.match === 'match') {
    return {
      status: 'verified',
      match: body.match,
      verifiedAt: body.verifiedAt,
    };
  }
  return { status: 'unverified' };
}
