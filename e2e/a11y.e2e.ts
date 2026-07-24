// Accessibility regression baseline. Axe-core scans the rendered
// popup against WCAG rules; we assert ZERO violations of the
// `critical` / `serious` impact tiers. `moderate` / `minor`
// violations are surfaced via console.log but don't fail the test —
// they're style nits a personal wallet can defer.
//
// Why bother for a wallet?
//   - Keyboard nav: power users (and screen-reader users) live in
//     keyboard-only mode. Missing focus ring / aria labels make
//     Settings unusable for them.
//   - Color contrast: black-on-cream + yellow chunky borders is
//     load-bearing for branding, but a few rows accidentally drop
//     below 4.5:1 contrast — easy fix once spotted.
//
// When a violation IS found here, the fix is usually one of:
//   - add `aria-label` to an emoji-only button
//   - bump a font-weight or color-contrast on a faint label
//   - add a `<label>` association on a settings input
// — small, local edits.

import { test, expect } from './_setup/extension';
import { unlock, openSettings } from './_setup/helpers';
import AxeBuilder from '@axe-core/playwright';
import type { Result as AxeResult } from 'axe-core';
import type { Page } from '@playwright/test';

/** Run axe on the given page, fail the test on critical/serious
 *  violations, log the rest. Keeps the bar high without flooding CI
 *  with style nits. */
async function scanAccessibility(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // The popup uses chrome-extension:// URLs which axe sometimes
    // mishandles in document-level rules. Tag-filter to the WCAG
    // core that's actually meaningful here.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter(
    (v: AxeResult) => v.impact === 'critical' || v.impact === 'serious',
  );
  const advisory = results.violations.filter(
    (v: AxeResult) => v.impact === 'moderate' || v.impact === 'minor',
  );

  if (advisory.length > 0) {
    console.log(`[a11y/${label}] ${advisory.length} advisory issue(s):`);
    for (const v of advisory) {
      console.log(`  - ${v.id} (${v.impact}): ${v.help}`);
    }
  }
  if (blocking.length > 0) {
    const detail = blocking.map((v: AxeResult) =>
      `  ${v.id} (${v.impact}): ${v.help}\n` +
      `    affects ${v.nodes.length} node(s); first: ${v.nodes[0]?.target.join(' ')}`,
    ).join('\n');
    throw new Error(`[a11y/${label}] ${blocking.length} blocking violation(s):\n${detail}`);
  }
  // Always assert at least one rule was checked — otherwise a silent
  // axe misconfig would make this test green by mistake.
  expect(results.passes.length).toBeGreaterThan(0);
}

test('a11y: unlock screen', async ({ popup }) => {
  await expect(popup.locator('.aw-unlock-title')).toBeVisible();
  await scanAccessibility(popup, 'unlock');
});

test('a11y: dashboard (unlocked)', async ({ popup }) => {
  await unlock(popup);
  await scanAccessibility(popup, 'dashboard');
});

test('a11y: settings screen', async ({ popup }) => {
  await unlock(popup);
  await openSettings(popup);
  await scanAccessibility(popup, 'settings');
});

test('a11y: welcome screen (pre-onboarding)', async ({ pristinePopup: popup }) => {
  await expect(popup.locator('.aw-welcome-title')).toHaveText('ALADDIN');
  await scanAccessibility(popup, 'welcome');
});
