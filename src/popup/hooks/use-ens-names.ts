// Reverse-ENS hook. Given a list of addresses, returns a map of
// address → primary ENS name (or null when none / lookup failed).
// Lookups are batched per render-cycle, cached SW-side (5 min TTL),
// and de-duped by address so an Activity screen with 50 rows pointing
// at the same recipient only fires one `resolve-ens-name` RPC.

import { useEffect, useState } from 'react';
import { send } from '../shared';

export type EnsNameMap = Record<string, string | null>;

/** Resolve every passed address in parallel; React re-renders as
 *  each lookup completes (so partial results show ASAP without
 *  waiting for the slowest one). Addresses already in `cache` aren't
 *  re-fetched. Returns the union of cache + resolved values. */
export function useEnsNames(addresses: string[]): EnsNameMap {
  const [resolved, setResolved] = useState<EnsNameMap>({});

  useEffect(() => {
    const needLookup = Array.from(
      new Set(
        addresses
          .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
          .map((a) => a.toLowerCase()),
      ),
    ).filter((a) => !(a in resolved));
    if (needLookup.length === 0) return;
    let cancelled = false;
    // Fire-and-forget; each resolution updates state independently.
    for (const addr of needLookup) {
      void (async () => {
        try {
          const name = await send<string | null>({ kind: 'resolve-ens-name', address: addr });
          if (cancelled) return;
          setResolved((cur) => ({ ...cur, [addr]: name ?? null }));
        } catch {
          if (cancelled) return;
          setResolved((cur) => ({ ...cur, [addr]: null }));
        }
      })();
    }
    return () => { cancelled = true; };
    // We intentionally depend only on the address list (join'd) — the
    // resolved-cache is read inside the effect but doesn't drive
    // re-runs (otherwise every set would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.join('|')]);

  return resolved;
}
