// Legacy risk-check shim — kept as a stable surface for the
// `sign-confirm.tsx` UI and the existing `tests/risk.test.ts` suite.
// The actual rule logic lives in `security-engine.ts`; this file
// just adapts the engine's `Signal[]` output back to the
// two-function shape the wallet's renderer + tests expect.
//
// New code that wants richer information (multiple primary signals,
// severity colours, dismissal state, etc.) should import from
// `./security-engine` directly. This shim is unchanged so the
// Phase 1 engine refactor doesn't churn sign-confirm.tsx.

import type { Address } from 'viem';
import type { PendingRequest } from '../shared/protocol';
import { runEngine, primarySignal } from './security-engine';

/** Red-banner danger classification. `high` triggers the forced ack
 *  checkbox in SignConfirm; `medium` is just a banner. `null` = routine. */
export type Danger = { message: string; level: 'medium' | 'high' };

/** Return a danger note if the request type warrants a red banner.
 *  Adapter over the security engine: surfaces the highest-severity
 *  primary signal as a `{message, level}` shape compatible with the
 *  pre-engine callsites that haven't been migrated to consume Signals
 *  directly. */
export function isDangerous(req: PendingRequest): Danger | null {
  // The engine's signer/chain rules need a context to do their
  // comparison; for `isDangerous`'s purpose we only care about
  // PRIMARY signals which are request-shape-only (don't depend on
  // ctx). A dummy ctx is safe — non-primary signals get filtered
  // out below regardless.
  const signals = runEngine(req, { address: ZERO_ADDR, chainId: 0 });
  const top = primarySignal(signals);
  if (!top) return null;
  return {
    message: top.message,
    level: top.requiresAck ? 'high' : 'medium',
  };
}

/** Inconsistencies between the dapp's payload and the wallet's
 *  current state. Adapter over the engine: yellow-chip warnings
 *  that aren't the primary banner. */
export function inconsistencies(
  req: PendingRequest,
  current: { address: Address; chainId: number },
): string[] {
  const signals = runEngine(req, current);
  return signals
    .filter((s) => !s.primary && s.severity === 'warning')
    .map((s) => s.message);
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
