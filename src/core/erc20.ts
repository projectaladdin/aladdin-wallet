// ERC-20 + Multicall3 read helpers. Token list / metadata reads use
// Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) so a dashboard
// load is one RPC instead of N. Falls back to parallel `readContract` if
// the chain doesn't have Multicall3 (rare — most EVM chains do).

import { createPublicClient, formatUnits, http, type Address, type Chain } from 'viem';

export const ERC20_ABI = [
  { type: 'function', name: 'name',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'  }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address', name: 'owner' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Multicall3 — same address on every EVM chain that has it deployed.
 *  Used here for one-RPC native + ERC-20 balance fetches. */
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const MULTICALL3_ABI = [
  {
    type: 'function', name: 'getEthBalance', stateMutability: 'view',
    inputs: [{ type: 'address', name: 'addr' }],
    outputs: [{ type: 'uint256', name: 'balance' }],
  },
] as const;

export type TokenMeta = {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
};

function client(chain: Chain, rpcUrl: string) {
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
}

/** Per-RPC cache of "is Multicall3 deployed at the canonical address" — a
 *  one-shot eth_getCode probe per chain. Saves us from re-trying multicall
 *  on every dashboard load on chains that don't have it (Anvil from genesis,
 *  local devnets, some smaller L2s). Stores the in-flight Promise for
 *  positive results so concurrent callers share one probe; transient
 *  failures (network blip) are NOT cached so the next call retries. */
const multicallSupport = new Map<string, boolean>();
const multicallProbes = new Map<string, Promise<boolean>>();

// Structural typing on `c` — only `getCode` is needed here, so we accept any
// public client shape. Lets callers pass clients from a shared cache without
// fighting viem's heavily-generic inferred return type of createPublicClient.
export async function detectMulticallSupport(
  c: { getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined> },
  rpcUrl: string,
): Promise<boolean> {
  const cached = multicallSupport.get(rpcUrl);
  if (cached !== undefined) return cached;
  // De-dupe concurrent probes — without this, two parallel readTokenBalances
  // calls on a fresh RPC each fire eth_getCode and race to set the cache,
  // doubling the round-trip cost on first load.
  const inflight = multicallProbes.get(rpcUrl);
  if (inflight) return inflight;
  const probe = (async (): Promise<boolean> => {
    try {
      const code = await c.getCode({ address: MULTICALL3_ADDRESS });
      const supported = typeof code === 'string' && code.length > 2; // > '0x'
      // Cache only DEFINITIVE answers. Transient errors (timeout, 5xx) leave
      // the cache untouched so the next call gets a fresh shot — without this
      // a single network blip permanently downgraded that RPC to fanout for
      // the rest of the SW lifetime.
      multicallSupport.set(rpcUrl, supported);
      return supported;
    } catch {
      // Transient — caller falls through to fanout fallback for THIS call,
      // next call re-probes from scratch (cache stays empty).
      return false;
    } finally {
      multicallProbes.delete(rpcUrl);
    }
  })();
  multicallProbes.set(rpcUrl, probe);
  return probe;
}

/** Fetch name + symbol + decimals from a contract address.
 *  Multicall3 (1 RPC) when supported, parallel reads (3 RPC) when not. */
export async function fetchTokenMeta(
  chain: Chain,
  rpcUrl: string,
  address: Address,
): Promise<TokenMeta> {
  const c = client(chain, rpcUrl);
  const fanout = async (): Promise<TokenMeta> => {
    const [name, symbol, decimals] = await Promise.all([
      c.readContract({ address, abi: ERC20_ABI, functionName: 'name' })     as Promise<string>,
      c.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' })   as Promise<string>,
      c.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
    ]);
    return { address, name, symbol, decimals: Number(decimals) };
  };

  if (!(await detectMulticallSupport(c, rpcUrl))) return fanout();

  try {
    const [name, symbol, decimals] = (await c.multicall({
      contracts: [
        { address, abi: ERC20_ABI, functionName: 'name' },
        { address, abi: ERC20_ABI, functionName: 'symbol' },
        { address, abi: ERC20_ABI, functionName: 'decimals' },
      ],
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: false,
    })) as [string, string, number];
    return { address, name, symbol, decimals: Number(decimals) };
  } catch {
    // Multicall reported as supported but call failed — flip cache + fan out.
    multicallSupport.set(rpcUrl, false);
    return fanout();
  }
}

/** Bulk balance fetch via Multicall3. Returns formatted balances aligned
 *  with the input order. Native row uses Multicall3's `getEthBalance`; each
 *  ERC-20 calls `balanceOf`. Failures (per-row) become "0" instead of poisoning
 *  the whole batch. Falls back to parallel individual reads if multicall fails. */
export async function fetchTokenBalancesBatch(
  chain: Chain,
  rpcUrl: string,
  owner: Address,
  rows: { address: string; decimals: number; isNative?: boolean }[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const c = client(chain, rpcUrl);

  const fanout = (): Promise<string[]> =>
    Promise.all(
      rows.map(async (r) => {
        try {
          const raw = r.isNative
            ? await c.getBalance({ address: owner })
            : ((await c.readContract({
                address: r.address as Address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [owner],
              })) as bigint);
          return formatUnits(raw, r.decimals);
        } catch {
          return '0';
        }
      }),
    );

  // Pre-check via cached eth_getCode probe — chains without Multicall3
  // (anvil from genesis, some L2s) skip the doomed batch attempt.
  if (!(await detectMulticallSupport(c, rpcUrl))) return fanout();

  // Mixed-ABI calls — viem's multicall accepts heterogeneous contracts when
  // typed as `any[]`. allowFailure:true gives per-row Result<status, result>
  // so a single bad token doesn't sink the whole batch.
  const calls = rows.map((r) =>
    r.isNative
      ? {
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionName: 'getEthBalance' as const,
          args: [owner] as const,
        }
      : {
          address: r.address as Address,
          abi: ERC20_ABI,
          functionName: 'balanceOf' as const,
          args: [owner] as const,
        }
  );

  try {
    const results = await c.multicall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contracts: calls as any,
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
    });
    return results.map((res, i) => {
      const decimals = rows[i]!.decimals;
      if (res.status === 'success' && typeof res.result === 'bigint') {
        return formatUnits(res.result, decimals);
      }
      return '0';
    });
  } catch {
    // Detection said supported but call failed (RPC hiccup, multicall reverted
    // for an unexpected reason) — flip cache so future loads skip directly,
    // and serve this load with the fan-out path.
    multicallSupport.set(rpcUrl, false);
    return fanout();
  }
}
