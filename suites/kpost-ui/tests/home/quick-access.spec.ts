/**
 * The Quick Access launcher, exercised as a user actually uses it.
 *
 * ## Why this file exists
 *
 * Quick Access is not one feature among many — it is **the only accessible
 * navigation KPost has**. The icon rail exposes no accessible names at all
 * (KPOST-A11Y-006), so every keyboard and screen-reader user reaches every
 * module through this dialog. `tests/home/home.spec.ts` proves it opens and
 * lists the modules; nothing drove its **search box**, which is how anyone with
 * more than a handful of modules actually navigates.
 *
 * The launcher's own search field was verified live (placeholder "Search pages,
 * contacts, messages") and `AppShellPage.searchQuickAccess()` has existed all
 * along — no test called it. That is the gap these cases close.
 *
 * ## Verification status
 *
 * ⚠ NEW — built from locators already verified against the live app
 * (`quickAccessDialog`, `quickAccessSearch`, the module cards), but these
 * journeys have never executed. The first run verifies them; confirm any
 * failure by hand before treating it as a defect.
 */
import { test, expect } from '../../src/fixtures/fixtures';

test.describe('Quick Access search @regression @home', () => {
  /**
   * Typing a module's name should leave that module offered. Asserted as
   * "KMail is still there after searching for it" rather than "only KMail is
   * there": the launcher also matches contacts and messages, so an exact-count
   * assertion would encode this account's data rather than the search contract.
   */
  test('searching the launcher still offers the matching module', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.searchQuickAccess('KMail');

    await homePage.expectModuleAvailable('KMail');
  });

  /**
   * A term that cannot match anything must not leave the previous result
   * standing. This is the filtering half of the contract — without it, a search
   * box that ignores its input would pass the test above.
   */
  test('a term that matches nothing removes the module from the results', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.searchQuickAccess(`zzz-no-such-module-${Date.now()}`);

    await expect(homePage.launcherEntry('KMail')).toBeHidden();
  });

  /**
   * Search, then launch what you found — the whole point of the feature, and
   * the path a keyboard user takes to reach any module.
   */
  test('a module found by search can be launched from the results', async ({
    homePage,
    kdirectoryPage,
    page,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.searchQuickAccess('KDirectory');
    await homePage.launchModule('KDirectory');

    await expect(page).toHaveURL(/\/kdirectory/i);
    await kdirectoryPage.expectLoaded();
  });

  /**
   * Escape must close it. The launcher is a modal over the whole app, so a
   * dialog that traps the user is worse than one that never opens — and this is
   * the one dismissal path a keyboard user has.
   */
  test('Escape closes the launcher and returns the user to Home', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.searchQuickAccess('KNews');
    await homePage.closeQuickAccess();

    await homePage.expectLoaded();
  });
});

test.describe('Signed-in identity @regression @home', () => {
  /**
   * The shell should show who is signed in, cross-checked against the session
   * record rather than a hard-coded name — the same technique
   * `SettingsPage.expectProfileMatchesSession()` uses, so it holds for whatever
   * account the suite runs as.
   *
   * Worth asserting because "logged in as the wrong user" is invisible to every
   * other test in the suite: they all just check that *a* shell rendered.
   */
  test('the shell names the account the session belongs to', async ({
    homePage,
    settingsPage,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    const identity = await settingsPage.sessionIdentity();
    const firstName = identity.firstName?.trim();
    test.skip(
      !firstName,
      'The session record carries no firstName, so there is no name to cross-check against.',
    );

    await homePage.expectSignedInAs(new RegExp(firstName as string, 'i'));
  });
});
