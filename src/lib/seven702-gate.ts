// EIP-7702 delegate gate decision — pure function extracted from
// sign-confirm.tsx so the slide-to-confirm gate's state machine can be
// unit-tested without React. The runtime composition is:
//
//   verifyContract() + eth_getCode + dev-flags  →  SevenSevenZeroTwoGate
//   SevenSevenZeroTwoGate                       →  decideSeven702Gate()
//
// decideSeven702Gate is the second arrow — given a resolved gate, what
// does the slide look like? Three outputs: whether the slide unlocks at
// all, the hint text above the track, and the label inside the thumb.

export type SevenSevenZeroTwoGate = {
  verification: 'pending' | 'revoke' | 'no-code' | 'verified' | 'unverified' | 'error' | 'chain-mismatch';
  match?: 'exact_match' | 'match';
  verifiedAt?: string;
  allowOverride: boolean;
};

export type Seven702Slide = {
  /** Slide track is draggable when true. False ⇒ visually locked. */
  slideOpen: boolean;
  /** Caption shown above the track. Explains why the slide is locked /
   *  warns about the consequence of unlocking. */
  hint: string;
  /** Text rendered inside the slide thumb. Different copy for each
   *  blocking state so the locked track itself explains the block. */
  label: string;
};

/** Map a resolved gate state to the slide's visual contract.
 *
 *  Unlock paths (slideOpen=true):
 *    - 'verified'  — Sourcify says source is auditable
 *    - 'revoke'    — delegate is the zero address (EIP-7702 spec way to
 *                    clear a delegation). Safe by definition, no
 *                    Sourcify check needed.
 *    - allowOverride flag is on — user has explicitly turned off the
 *                    Sourcify gate in dev-settings.
 *
 *  Lock paths (slideOpen=false): all surface as 🚫-prefixed thumb labels
 *  so the user understands which check failed without reading the hint.
 *
 *  `gate=null` means lookup hasn't started yet — treat as pending.
 */
export function decideSeven702Gate(gate: SevenSevenZeroTwoGate | null): Seven702Slide {
  if (!gate || gate.verification === 'pending') {
    return {
      slideOpen: false,
      hint: 'verifying delegate on Sourcify…',
      label: 'verifying…',
    };
  }

  if (gate.verification === 'revoke') {
    return {
      slideOpen: true,
      hint: 'EIP-7702 revoke — slide to clear any existing delegation.',
      label: 'slide to revoke',
    };
  }

  // Chain mismatch — the dapp's claimed chainId in the authorization
  // doesn't match the wallet's active chain. Hard block at the same
  // severity as 'no-code': don't even check Sourcify (a delegate's
  // code on chain A is irrelevant when we're signing for chain B).
  // The user must switch chains first OR the dapp must re-issue the
  // authorization on the correct chainId. The dev override does NOT
  // bypass this — overriding a wrong-chain signature is meaningless,
  // not just dangerous.
  if (gate.verification === 'chain-mismatch') {
    return {
      slideOpen: false,
      hint: '',
      label: '🚫 wrong chain — refusing',
    };
  }

  if (gate.verification === 'verified' || gate.allowOverride) {
    return {
      slideOpen: true,
      hint: 'slide to unlock — delegates your account to this contract',
      label: 'slide to unlock',
    };
  }

  // Blocked states leave `hint` empty — the SignConfirm body already
  // renders a full red aw-verify-block banner with the same content
  // above the slide, and duplicating the copy here was the bug user
  // reported ("BLOCKED... appears twice"). The slide's own label
  // ('🚫 no contract — refusing' etc.) keeps the inline "this is
  // locked" cue. SlideToConfirm skips rendering an empty hint so
  // the layout collapses cleanly.
  if (gate.verification === 'no-code') {
    return {
      slideOpen: false,
      hint: '',
      label: '🚫 no contract — refusing',
    };
  }

  if (gate.verification === 'unverified') {
    return {
      slideOpen: false,
      hint: '',
      label: '🚫 unverified — refusing',
    };
  }

  // gate.verification === 'error' — verifier unreachable.
  return {
    slideOpen: false,
    hint: '',
    label: '🚫 verifier unreachable',
  };
}
