// decideSeven702Gate — state machine that maps the resolved Sourcify +
// eth_getCode + dev-flag result into the slide-to-confirm's visual
// contract (open/locked + hint + label). Pure function, no React, no
// network. Goal: pin every branch so a future "tiny" copy edit can't
// silently swap "slide to unlock" onto a locked unverified delegate.

import { describe, expect, test } from 'bun:test';
import { decideSeven702Gate, type SevenSevenZeroTwoGate } from '../src/lib/seven702-gate';

const mk = (g: Partial<SevenSevenZeroTwoGate>): SevenSevenZeroTwoGate => ({
  verification: 'pending',
  allowOverride: false,
  ...g,
});

describe('decideSeven702Gate', () => {
  test('null gate (lookup not started) → locked + verifying copy', () => {
    const s = decideSeven702Gate(null);
    expect(s.slideOpen).toBe(false);
    expect(s.label).toBe('verifying…');
    expect(s.hint).toContain('verifying');
  });

  test('pending → locked + verifying copy', () => {
    const s = decideSeven702Gate(mk({ verification: 'pending' }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toBe('verifying…');
  });

  test('revoke (zero address) → unlocked, label says "revoke" not "unlock"', () => {
    const s = decideSeven702Gate(mk({ verification: 'revoke' }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to revoke');
    expect(s.hint).toContain('revoke');
    // Sanity: must NOT carry the wallet-takeover warning (revoke is the
    // OPPOSITE of taking over the wallet — it clears delegation).
    expect(s.hint).not.toContain('full control');
  });

  test('verified → unlocked + neutral delegate hint', () => {
    const s = decideSeven702Gate(mk({ verification: 'verified', match: 'exact_match' }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to unlock');
    expect(s.hint).toContain('delegates');
  });

  // Blocked-state hint is intentionally EMPTY — the SignConfirm
  // body renders the full red aw-verify-block banner above the
  // slide with the same content. Duplicating the copy in the slide
  // hint produced visible duplicate text (user-reported bug). The
  // slide's own `label` still carries the inline "🚫 refusing" cue.
  test('unverified → locked, empty hint, "🚫 unverified" label', () => {
    const s = decideSeven702Gate(mk({ verification: 'unverified' }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toContain('unverified');
    expect(s.label).toContain('🚫');
    expect(s.hint).toBe('');
  });

  test('no-code → locked, empty hint, "🚫 no contract" label', () => {
    const s = decideSeven702Gate(mk({ verification: 'no-code' }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toContain('no contract');
    expect(s.label).toContain('🚫');
    expect(s.hint).toBe('');
  });

  test('error (verifier unreachable) → locked, empty hint, "🚫 verifier unreachable" label', () => {
    const s = decideSeven702Gate(mk({ verification: 'error' }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toContain('verifier unreachable');
    expect(s.hint).toBe('');
  });

  test('chain-mismatch → locked, empty hint, "🚫 wrong chain" label', () => {
    const s = decideSeven702Gate(mk({ verification: 'chain-mismatch' }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toContain('wrong chain');
    expect(s.hint).toBe('');
  });

  test('dev override does NOT bypass chain-mismatch (unlike unverified)', () => {
    // The dev override is for "I know the contract is fine, let me
    // sign anyway". Chain mismatch is a different category — there's
    // no defensible value in signing a delegation for a chain the
    // wallet isn't on. Even with the override flag set, the slide
    // stays locked.
    const s = decideSeven702Gate(mk({ verification: 'chain-mismatch', allowOverride: true }));
    expect(s.slideOpen).toBe(false);
    expect(s.label).toContain('wrong chain');
  });

  test('dev override on + unverified → unlocked + wallet-takeover copy', () => {
    // Power-user opt-in: the dev-settings flag bypasses the Sourcify
    // gate. The slide unlocks, but the body's separate "DEV OVERRIDE
    // ACTIVE" banner still warns. The slide itself reverts to the
    // generic wallet-takeover hint.
    const s = decideSeven702Gate(mk({ verification: 'unverified', allowOverride: true }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to unlock');
    expect(s.hint).toContain('delegates');
  });

  test('dev override on + no-code → unlocked (user explicitly accepts brick risk)', () => {
    // Same opt-in covers no-code. The body banner adapts to mention
    // "no bytecode" but the slide itself just reads as "slide to
    // unlock" — the warning is the override banner's job.
    const s = decideSeven702Gate(mk({ verification: 'no-code', allowOverride: true }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to unlock');
  });

  test('dev override on + error → unlocked', () => {
    const s = decideSeven702Gate(mk({ verification: 'error', allowOverride: true }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to unlock');
  });

  test('revoke ignores the dev override (no override needed)', () => {
    // Revoke is already an unlock path; allowOverride shouldn't change
    // the label to "slide to unlock" — the "slide to revoke" label is
    // semantically more accurate.
    const s = decideSeven702Gate(mk({ verification: 'revoke', allowOverride: true }));
    expect(s.slideOpen).toBe(true);
    expect(s.label).toBe('slide to revoke');
  });

  test('label always carries a 🚫 prefix when slide is locked (post-pending)', () => {
    // pending uses the "verifying…" spinner copy, not 🚫. All other
    // locked states should communicate the block in the label itself
    // so the locked track explains the block without the hint.
    const lockedStates: SevenSevenZeroTwoGate['verification'][] = ['unverified', 'no-code', 'error'];
    for (const v of lockedStates) {
      const s = decideSeven702Gate(mk({ verification: v }));
      expect(s.slideOpen).toBe(false);
      expect(s.label.startsWith('🚫')).toBe(true);
    }
  });
});
