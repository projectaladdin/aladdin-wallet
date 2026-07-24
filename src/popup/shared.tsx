// Cross-screen primitives extracted from popup.tsx during the modularisation
// pass. Three things live here, in order of how often they're used:
//
//   send()             — promise-wrapped chrome.runtime.sendMessage with the
//                         project's FromBackground/ToBackground envelope. Used
//                         by every screen that talks to the SW.
//   useToast / Toast   — the shared yellow/green/red toast (App provides the
//                         context; screens consume via useToast).
//   AccountGlyph       — deterministic SVG avatar derived from a 0x address.
//                         Used in the dashboard, account picker, sign confirm.
//
// No behaviour change in this file vs. the inline definitions it replaced.

import { createContext, useContext } from 'react';
import type { FromBackground, ToBackground } from '../shared/protocol';

export type TokenMeta = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** True for builtins (USDC/USDT/DAI on mainnet). UI hides the remove button
   *  on these — they're considered part of the chain's default token set. */
  builtin: boolean;
  /** True only on the synthetic native row (ETH on mainnet, BNB on BSC etc.)
   *  Dashboard puts this row first and uses `getBalance` instead of `balanceOf`. */
  isNative?: boolean;
};

/** Token row with a defaulted balance string. Dashboard pre-fills every row
 *  with `balance: '0'` so users see a concrete number instantly; once the
 *  RPC read lands the real value overwrites. `loaded` tracks whether we've
 *  had at least one successful balance read for this row, used only for a
 *  subtle "not yet confirmed" visual hint. */
export type TokenRow = TokenMeta & {
  balance: string;
  loaded: boolean;
  /** USD price per unit, or null if no price feed for this token/chain. */
  priceUsd: number | null;
};

export async function send<R = unknown>(msg: ToBackground): Promise<R> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp: FromBackground) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp.ok) return reject(new Error(resp.error));
      resolve(resp.data as R);
    });
  });
}

export type ToastTone = 'yellow' | 'green' | 'red';
export type ToastInput = { tone?: ToastTone; icon?: string; text: string };
export type ToastFn = (t: ToastInput) => void;

export const ToastContext = createContext<ToastFn>(() => {});
export function useToast(): ToastFn { return useContext(ToastContext); }

/** Deterministic pixel-art identicon for an EVM address — a two-colour
 *  concentric-square glyph on the Aladdin palette, framed with a 2 px ink
 *  border. Same address → same glyph. Mirrors the design bundle's `glyph()`
 *  (djb2 hash → two palette picks). Keeps the identical
 *  `{ address, size, className }` signature so every call site (dashboard,
 *  account picker, connected sites, sign-confirm) is unchanged. */
export function AccountGlyph({ address, size = 32, className }: { address: string; size?: number; className?: string }) {
  const seed = (address || '0x0').toLowerCase();
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;

  const pal = ['#FFC53D', '#B26CFF', '#33E0D0', '#33E06A', '#FF6A3D', '#FF7AA2'];
  const g = pal[h % pal.length]!;             // primary cell colour
  const g2 = pal[(h >> 5) % pal.length]!;     // background + inner accent

  // 6×6 frame: 'o' = ink, 'g' = primary colour, '.' = show background (g2).
  const px = ['.oooo.', 'o....o', 'o.gg.o', 'o.gg.o', 'o....o', '.oooo.'];

  return (
    <svg
      viewBox="0 0 6 6"
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
      style={{ border: '2px solid #000', imageRendering: 'pixelated', display: 'block' }}
      aria-hidden
    >
      <rect width={6} height={6} fill={g2} />
      {px.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === '.' ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c === 'g' ? g : '#000'} />
          ),
        ),
      )}
      <rect x={1} y={1} width={4} height={4} fill={g2} />
      <rect x={2} y={2} width={2} height={2} fill={g} />
    </svg>
  );
}

/** The Aladdin brand mark — an 18×14 pixel-art lamp rendered crisp at any
 *  size. Mirrors the design bundle's `lamp()`. `size` is the width in px;
 *  height keeps the 18:14 aspect ratio. Used in the header chrome, the
 *  onboarding hero, and the dashboard balance row. */
export function Lamp({ size = 34, className }: { size?: number; className?: string }) {
  const P: Record<string, string> = {
    o: '#000000', g: '#FFC53D', d: '#B9821A', h: '#FFE9A8', f: '#FF6A3D', s: '#33E0D0',
  };
  const rows = [
    '..............s...',
    '..........f...s...',
    '..........f.......',
    '.......ooo........',
    '......oghgo.......',
    '.....oghhggo......',
    '...oooggggooo.....',
    '.oohgggggggddo....',
    'oghhgggggggggddo..',
    'ohgggggggggggggdo.',
    '.ohgggggggggddo...',
    '..oogggggggddo....',
    '....ooooooooooo...',
    '...oddddddddddo...',
  ];
  const W = 18, H = rows.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={size}
      height={Math.round((size * H) / W)}
      className={className}
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated', display: 'block' }}
      aria-hidden
    >
      {rows.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === '.' || !P[c] ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={P[c]} />
          ),
        ),
      )}
    </svg>
  );
}
