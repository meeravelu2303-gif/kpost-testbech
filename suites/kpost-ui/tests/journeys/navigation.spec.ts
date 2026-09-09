/**
 * Cross-cutting navigation journeys — the paths a real user takes that no
 * single module's spec covers.
 *
 * ## Why this file exists
 *
 * The per-module specs all follow one shape: sign in, open the module through
 * Quick Access or the rail, assert it rendered. That proves each module can be
 * *launched*, and it is genuinely a third of the suite — but it leaves three
 * things a user does every day completely untested:
 *
 *   1. **Reloading the page.** KPost keeps its session in localStorage plus an
 *      encrypted redux blob (CLAUDE.md → "Auth lives in localStorage"), so a
 *      refresh is a real rehydration path, not a no-op. Nothing verified it.
 *   2. **Opening a URL directly.** Every existing test reaches a module by
 *      clicking. Nobody had checked that `/settings` works when it is typed,
 *      bookmarked, or refreshed — which is a different code path (cold boot and
 *      route resolution, rather than an in-app transition).
 *   3. **Browser back and forward.** An SPA that pushes history without
 *      handling popstate looks fine until someone presses Back. No test pressed
 *      it.
 *
 * ## Verification status
 *
 * ⚠ NEW — written from locators and page-object methods already verified
 * against the live app, but these *combinations* have never executed. The
 * primitives are safe (every `expectLoaded()` used here is exercised by an
 * existing passing test); the journeys are not yet proven. Treat the first run
 * as their verification, and read any failure as a finding to confirm by hand
 * before registering it as a defect.
 *
 * KMail is deliberately absent: opening it currently signs the user out
 * (KPOST-KMAIL-003), so a deep-link test there would re-report a defect
 * `tests/kmail/` already covers, on every browser, for no new information.
 */
import { test, expect } from '../../src/fixtures/fixtures';

test.describe('Session continuity @regression @journeys', () => {
  /**
   * The session is several localStorage keys and an encrypted redux blob, so a
   * reload genuinely re-hydrates it. If that ever breaks, every user is logged
   * out by pressing F5 — and nothing else in the suite would notice.
   */
  test('the session survives a page reload', async ({ homePage, page }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/home/i);
    await homePage.expectLoaded();
  });

  /**
   * A refreshed deep link is the bookmark path: cold boot straight onto a
   * module route, rather than transitioning into it from /home.
   */
  test('a bookmarked module URL still works after a reload', async ({ settingsPage, page }) => {
    await settingsPage.open();
    await settingsPage.expectLoaded();

    await page.reload({ waitUntil: 'domcontentloaded' });

    await settingsPage.expectLoaded();
  });
});

test.describe('Direct URL access @regression @journeys', () => {
  /**
   * Each module opened by typing its address rather than clicking to it.
   *
   * Separate tests rather than one loop: a loop stops at the first failure and
   * reports one red test, which would hide whether the other four modules are
   * fine. Five tests give five answers.
   */
  test('KDirectory opens from its own URL', async ({ kdirectoryPage }) => {
    await kdirectoryPage.open();
    await kdirectoryPage.expectLoaded();
  });

  test('Katchup opens from its own URL', async ({ katchupPage }) => {
    await katchupPage.open();
    await katchupPage.expectLoaded();
  });

  test('KEcommerce opens from its own URL', async ({ kecommercePage }) => {
    await kecommercePage.open();
    await kecommercePage.expectLoaded();
  });

  test('KNews opens from its own URL', async ({ knewsPage }) => {
    await knewsPage.open();
    await knewsPage.expectLoaded();
  });

  test('Settings opens from its own URL', async ({ settingsPage }) => {
    await settingsPage.open();
    await settingsPage.expectLoaded();
  });
});

test.describe('Browser history @regression @journeys', () => {
  /**
   * Back and forward across an in-app transition. An SPA that pushes history
   * without handling `popstate` passes every other test in this suite and still
   * strands the user on a blank route the moment they press Back.
   */
  test('back returns to Home and forward returns to the module', async ({
    homePage,
    kdirectoryPage,
    page,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kdirectoryPage.openFromLauncher();
    await kdirectoryPage.expectLoaded();

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/home/i);
    await homePage.expectLoaded();

    await page.goForward({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/kdirectory/i);
    await kdirectoryPage.expectLoaded();
  });

  /**
   * Two hops before going back, so this covers the history *stack* rather than
   * a single entry — the case where an SPA collapses several pushes into one.
   */
  test('back steps through a multi-module history one entry at a time', async ({
    homePage,
    kdirectoryPage,
    knewsPage,
    page,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kdirectoryPage.openFromLauncher();
    await kdirectoryPage.expectLoaded();

    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/kdirectory/i);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/home/i);
  });
});
