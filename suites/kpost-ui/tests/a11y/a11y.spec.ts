/**
 * Accessibility conformance — WCAG 2.1 A/AA via axe-core.
 *
 * These scans have run against the live app and they are red on purpose: the
 * login screen returns 3 WCAG A/AA violations and the Home pane 4. Every one is
 * registered — KPOST-A11Y-001 … -006 — from direct observation on 2026-08-16.
 *
 * That red is signal, not debt. A violation here is an APPLICATION defect:
 * register it in `known-defects.ts` once observed and attach it with
 * `noteKnownDefect()`. Never widen `disableRules` or drop a tag to reach green.
 *
 * These scans are also self-serving in the best way — the rail's missing
 * accessible names are exactly why `AppShellPage` needs a CSS selector, so
 * every fix here removes brittleness from the suite.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { LoginPage } from '../../src/pages/LoginPage';
import { formatViolations, scanA11y } from '../../src/utils/a11y';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

test.describe('Accessibility — signed out @regression @a11y', () => {
  // The login screen is reachable without a session, so this file's first block
  // opts out of the shared authenticated state rather than using a fixture.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the login screen has no WCAG A/AA violations', async ({ page }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_UNLABELLED_FORM_CONTROLS);
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_ZOOM_DISABLED);
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    const violations = await scanA11y(page);

    expect(violations, formatViolations(violations, 'the login screen')).toEqual([]);
  });
});

test.describe('Accessibility — signed in @regression @a11y', () => {
  test('the Home pane has no WCAG A/AA violations', async ({ homePage, page }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_UNLABELLED_FORM_CONTROLS);
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_ZOOM_DISABLED);
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_INSUFFICIENT_CONTRAST);
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_SCROLL_REGION_NOT_FOCUSABLE);
    await homePage.open();
    await homePage.expectLoaded();

    const violations = await scanA11y(page);

    expect(violations, formatViolations(violations, 'the Home pane')).toEqual([]);
  });

  test('the app exposes a navigation landmark', async ({ homePage, page }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_NO_NAVIGATION_LANDMARK);
    /*
     * This test originally tried to scan `nav, [role="navigation"]` and errored
     * with "No elements found for include in page Context" — axe cannot scope a
     * scan to something that does not exist. That error WAS the finding: KPost
     * has no navigation landmark at all. The icon rail is a stack of
     * `div.icon-KP_03-KMail` elements with no text, no aria-label, no title and
     * no landmark role, which is why `AppShellPage.openModuleFromRail()` has to
     * fall back to a CSS class — the one place in this codebase that does.
     *
     * Rewritten to assert the contract directly, so it fails with a readable
     * statement of what is missing instead of an axe internal error.
     */
    await homePage.open();
    await homePage.expectLoaded();

    const landmarks = page.locator('nav, [role="navigation"]');

    expect(
      await landmarks.count(),
      'KPost renders no <nav> and no [role="navigation"]. Screen-reader users cannot ' +
        'jump to navigation, and the icon rail is unreachable by any accessible locator.',
    ).toBeGreaterThan(0);
  });

  test('the Quick Access launcher has no WCAG A/AA violations', async ({ homePage, page }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_INSUFFICIENT_CONTRAST);
    noteKnownDefect(KNOWN_APP_DEFECTS.A11Y_NESTED_INTERACTIVE_CONTROLS);
    /*
     * The launcher is the accessible navigation path the whole suite depends
     * on — a real ARIA dialog whose entries are real buttons with real names.
     * If it ever regresses, module navigation has no accessible route left at
     * all, so it is worth its own scan while it is open.
     */
    await homePage.open();
    await homePage.expectLoaded();
    await homePage.openQuickAccess();

    const violations = await scanA11y(page, { include: '[role="dialog"]' });

    expect(violations, formatViolations(violations, 'the Quick Access launcher')).toEqual([]);
  });
});
