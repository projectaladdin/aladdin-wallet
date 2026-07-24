// Security-checks panel — renders the SecurityEngine's full Signal[]
// in one place so the sign-confirm body doesn't have to layer
// per-mode danger banners / warning chips. Signals are sorted by
// severity (danger → warning → info → safe) so the highest-impact
// item is always on top.
//
// Visual language reuses the wallet's existing alert/chip classes
// (`aw-alert aw-alert-danger`, `aw-alert`) — no new CSS surface
// added; this component is just structured rendering for the engine's
// signals so each sign-confirm body stays focused on its own layout.

import type { Signal, Severity } from '../../lib/security-engine';

const SEVERITY_ORDER: Record<Severity, number> = {
  danger: 0, warning: 1, info: 2, safe: 3,
};

const SEVERITY_ICON: Record<Severity, string> = {
  danger: '🚫', warning: '⚡', info: 'ⓘ', safe: '✓',
};

const SEVERITY_CLASS: Record<Severity, string> = {
  danger: 'aw-alert aw-alert-danger',
  warning: 'aw-alert',
  info: 'aw-alert',
  safe: 'aw-alert',
};

export function SecurityChecks({ signals }: { signals: readonly Signal[] }) {
  // Drop `silent: true` signals — those are emitted to drive the
  // ack-checkbox / danger-level machinery but have their own
  // dedicated banner elsewhere in sign-confirm (e.g. the 7702
  // aw-big-banner). Rendering them here would duplicate the warning.
  const visible = signals.filter((s) => !s.silent);
  if (visible.length === 0) return null;
  // Stable sort: severity first, then preserve registration order.
  const sorted = [...visible].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <div className="aw-security-checks">
      {sorted.map((s) => (
        <div key={s.id} className={SEVERITY_CLASS[s.severity]} data-signal-id={s.id}>
          <span aria-hidden style={{ marginRight: 6 }}>{SEVERITY_ICON[s.severity]}</span>
          {s.message}
        </div>
      ))}
    </div>
  );
}
