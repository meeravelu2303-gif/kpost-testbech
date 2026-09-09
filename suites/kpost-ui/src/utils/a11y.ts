/**
 * Accessibility scanning (axe-core).
 *
 * ## Why this exists here specifically
 *
 * KPost's two hardest automation problems are both accessibility defects:
 * the login domain-list overlay that swallows the Submit click, and the icon
 * rail whose entries carry no accessible name at all — which is why
 * `AppShellPage` needs the one sanctioned CSS selector in the codebase and why
 * navigation has to go through the Quick Access launcher. Every accessible name
 * the product gains is one fewer brittle selector here, so a11y coverage and
 * suite stability are the same work.
 *
 * ## Verification status
 *
 * VERIFIED against the live app. The scans have run, and they found real
 * conformance failures: KPOST-A11Y-001 through -006 in `known-defects.ts` are
 * all sightings from these scans (2026-08-16, chromium, WCAG 2.1 A/AA), not
 * predictions. The login screen returns 3 violations and the Home pane 4, so
 * the specs that assert zero are legitimately red.
 *
 * Violations found here are APPLICATION defects, not test debt. Register each
 * in `known-defects.ts` — only after observing it directly; that registry's
 * entries are confirmed sightings, never predictions — and attach it with
 * `noteKnownDefect()`. Do not relax `RULE_TAGS` or `disableRules` to get to
 * green; that is the one move this bench forbids.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * WCAG 2.1 A and AA. Deliberately not `best-practice`: that tag mixes advisory
 * style opinions in with conformance failures, and a gate whose failures are
 * arguable gets switched off rather than fixed.
 */
export const RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** One axe finding, flattened to what a developer needs to act on it. */
export interface A11yViolation {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly helpUrl: string;
  readonly nodeCount: number;
  /** The offending selectors, capped — a broken pattern repeats, it doesn't vary. */
  readonly targets: readonly string[];
}

const MAX_TARGETS_PER_VIOLATION = 5;
const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

function impactRank(impact: string): number {
  const index = IMPACT_ORDER.indexOf(impact);
  return index === -1 ? IMPACT_ORDER.length : index;
}

/**
 * Scan the current page, optionally narrowed to a region.
 *
 * `include` scopes the scan to one part of the DOM — useful for asserting that
 * a specific component is clean without being blocked by unrelated violations
 * elsewhere on the page.
 */
export async function scanA11y(
  page: Page,
  options: { include?: string; disableRules?: readonly string[] } = {},
): Promise<A11yViolation[]> {
  let builder = new AxeBuilder({ page }).withTags([...RULE_TAGS]);

  if (options.include) builder = builder.include(options.include);
  if (options.disableRules?.length) builder = builder.disableRules([...options.disableRules]);

  const results = await builder.analyze();

  return results.violations
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? 'unknown',
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodeCount: violation.nodes.length,
      targets: violation.nodes
        .slice(0, MAX_TARGETS_PER_VIOLATION)
        .map((node) => node.target.join(' ')),
    }))
    .sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || a.id.localeCompare(b.id));
}

/**
 * Render violations as something a developer can act on directly.
 *
 * A bare count ("expected 0, got 7") tells nobody what to fix, so the message
 * carries the rule, its impact, the offending selectors and axe's own help URL.
 */
export function formatViolations(violations: readonly A11yViolation[], context: string): string {
  if (violations.length === 0) return `No accessibility violations on ${context}.`;

  const lines = violations.map((violation) => {
    const targets = violation.targets.map((target) => `        - ${target}`).join('\n');
    const more =
      violation.nodeCount > violation.targets.length
        ? `\n        …and ${violation.nodeCount - violation.targets.length} more element(s)`
        : '';
    return (
      `  [${violation.impact.toUpperCase()}] ${violation.id} — ${violation.help}\n` +
      `      ${violation.helpUrl}\n` +
      `      ${violation.nodeCount} element(s):\n${targets}${more}`
    );
  });

  return (
    `${violations.length} accessibility violation(s) on ${context} ` +
    `(WCAG 2.1 A/AA):\n${lines.join('\n\n')}`
  );
}
