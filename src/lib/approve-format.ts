// Helpers for formatting ERC-20 approve amounts in the sign-confirm
// modal. Extracted from sign-confirm.tsx so the rules can be unit-
// tested in isolation — these are the kind of small predicates that
// rot under future "let me just tweak the threshold" edits.

/** Detect "infinity-grade" allowance sentinels. Common values seen
 *  in the wild that should all read as ∞:
 *    2^256 - 1     MetaMask default, OpenSea, etc.
 *    2^160 - 1     Permit2 (Uniswap V3 + V4)
 *    2^128 - 1     compact Permit variants
 *    2^96  - 1     extra-compact Permit variants
 *  Pattern: any `2^k - 1` with k ≥ 96. Below that, the value is small
 *  enough to be a legitimate finite cap (2^96 ≈ 79 octillion — orders
 *  of magnitude larger than any real-world per-tx approval). */
export function isInfinityAllowance(n: bigint): boolean {
  if (n <= 0n) return false;
  // n is `2^k - 1` iff (n + 1) is a power of two iff popcount(n+1) == 1.
  const plusOne = n + 1n;
  if ((plusOne & (plusOne - 1n)) !== 0n) return false;
  return plusOne >= (1n << 96n);
}

/** Render a number with K / M / B / T / Q suffixes so a huge token
 *  allowance reads as "1.46 Q" instead of "1,461,501,637,330,903,000".
 *  Values under 10,000 stay literal (still a sensible cap to inspect).
 *  Anything above 1e18 (quintillion) renders in scientific notation —
 *  there's no commonly-used suffix beyond that, and at that magnitude
 *  the value is likely a sentinel that `isInfinityAllowance` missed. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1e4) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  const TIERS: { v: number; sfx: string }[] = [
    { v: 1e15, sfx: 'Q' },
    { v: 1e12, sfx: 'T' },
    { v: 1e9,  sfx: 'B' },
    { v: 1e6,  sfx: 'M' },
    { v: 1e3,  sfx: 'K' },
  ];
  for (const { v, sfx } of TIERS) {
    if (abs >= v) {
      const scaled = n / v;
      // 2 fraction digits at small magnitudes, 0 at large — keeps the
      // string compact ("1.46Q") at scale without losing precision
      // for "1,234" style values.
      const frac = abs >= 100 * v ? 0 : 2;
      return `${scaled.toLocaleString('en-US', { maximumFractionDigits: frac })}${sfx}`;
    }
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
