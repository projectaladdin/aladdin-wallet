// Pin the approve-amount formatting rules. User-reported bug we're
// guarding: the Permit2 sentinel `2^160 - 1` was rendering as
// "1,461,501,637,330,903,000,000,000,000,000 SHIT" instead of ∞.
// Also covers the K/M/B/T/Q humanization for legitimate large-but-
// finite allowances.

import { describe, it, expect } from 'bun:test';
import { compactNumber, isInfinityAllowance } from '../src/lib/approve-format';

const UINT256_MAX = (1n << 256n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n; // Permit2
const UINT128_MAX = (1n << 128n) - 1n;
const UINT96_MAX  = (1n << 96n)  - 1n; // compact Permit lower bound

describe('isInfinityAllowance', () => {
  it('classifies uint256.max as infinity', () => {
    expect(isInfinityAllowance(UINT256_MAX)).toBe(true);
  });
  it('classifies uint160.max (Permit2 sentinel) as infinity', () => {
    // The exact value the user reported.
    expect(UINT160_MAX.toString()).toBe('1461501637330902918203684832716283019655932542975');
    expect(isInfinityAllowance(UINT160_MAX)).toBe(true);
  });
  it('classifies uint128.max as infinity', () => {
    expect(isInfinityAllowance(UINT128_MAX)).toBe(true);
  });
  it('classifies uint96.max as infinity (lower bound)', () => {
    expect(isInfinityAllowance(UINT96_MAX)).toBe(true);
  });
  it('rejects 2^95 - 1 (just below the sentinel-pattern threshold)', () => {
    expect(isInfinityAllowance((1n << 95n) - 1n)).toBe(false);
  });
  it('rejects realistic large allowances that are NOT 2^k - 1', () => {
    expect(isInfinityAllowance(1_000_000_000_000_000_000n)).toBe(false); // 1 ETH worth
    expect(isInfinityAllowance(1234567890n)).toBe(false);
    expect(isInfinityAllowance(UINT160_MAX - 1n)).toBe(false); // one off
    expect(isInfinityAllowance(UINT160_MAX + 1n)).toBe(false); // power of two itself
  });
  it('rejects zero and negative', () => {
    expect(isInfinityAllowance(0n)).toBe(false);
    expect(isInfinityAllowance(-1n)).toBe(false);
  });
});

describe('compactNumber', () => {
  it('renders small numbers literally with thousands separator', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(1)).toBe('1');
    expect(compactNumber(1234)).toBe('1,234');
    expect(compactNumber(9999)).toBe('9,999');
  });
  it('switches to K at 10,000+', () => {
    expect(compactNumber(10_000)).toBe('10K');
    expect(compactNumber(99_999)).toBe('100K');
    expect(compactNumber(123_456)).toBe('123K');
  });
  it('switches to M at 1 million', () => {
    expect(compactNumber(1_000_000)).toBe('1M');
    expect(compactNumber(1_500_000)).toBe('1.5M');
    expect(compactNumber(123_400_000)).toBe('123M');
  });
  it('switches to B at 1 billion', () => {
    expect(compactNumber(1_000_000_000)).toBe('1B');
    expect(compactNumber(2_500_000_000)).toBe('2.5B');
  });
  it('switches to T at 1 trillion', () => {
    expect(compactNumber(1_000_000_000_000)).toBe('1T');
  });
  it('switches to Q at 1 quadrillion', () => {
    expect(compactNumber(1_000_000_000_000_000)).toBe('1Q');
  });
  it('handles fractional small numbers', () => {
    expect(compactNumber(0.5)).toBe('0.5');
    expect(compactNumber(0.000001)).toBe('0.000001');
  });
});
