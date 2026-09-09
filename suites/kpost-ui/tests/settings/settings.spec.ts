/**
 * Settings module — navigation, sections, and profile details.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * Verified against the live app on 2026-08-12. Two things differ from a
 * conventional settings screen, and the tests below reflect the app as it is:
 *
 *  1. The sections are **Profile Creation, Digital Card Settings, General
 *     Settings, KMail Settings, KNews Settings, My Account** — there is no
 *     Profile / Preferences / Security split, and they are plain clickable text
 *     rather than ARIA tabs. Selecting one does not change the URL.
 *  2. Settings ships **no preference toggles and no theme controls** — zero
 *     switch/checkbox/radio elements. The product's only preference control is
 *     the language picker in the app-shell header, so that is what the
 *     preference test asserts, and it does so without mutating it.
 */
import { test } from '../../src/fixtures/fixtures';
import { SETTINGS_SECTIONS } from '../../src/pages/SettingsPage';

test.describe('Settings navigation @smoke @settings', () => {
  test('opening Settings from Quick Access loads the module', async ({ homePage, settingsPage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await settingsPage.openFromLauncher();

    await settingsPage.expectLoaded();
  });

  test('Settings is also reachable from the icon rail', async ({ homePage, settingsPage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await settingsPage.openFromRail();

    await settingsPage.expectLoaded();
  });

  test('every settings section is offered', async ({ homePage, settingsPage }) => {
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    await settingsPage.expectAllSectionsAvailable();
  });
});

test.describe('Settings sections @regression @settings', () => {
  test('each section can be selected and keeps the module loaded', async ({
    homePage,
    settingsPage,
  }) => {
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    for (const section of SETTINGS_SECTIONS) {
      await settingsPage.openSection(section);
      // Selecting a section does not navigate, so the proof it worked is that
      // the module is still coherent and the app did not raise.
      await settingsPage.expectNoAppError();
      await settingsPage.expectSectionAvailable(section);
    }
  });

  test('the KNews Settings section exposes a Submit action', async ({
    homePage,
    settingsPage,
  }) => {
    // KNews Settings is the section verified to carry its own controls (a
    // react-select plus Submit). "My Account" opened directly renders no
    // controls of its own — an earlier probe that suggested otherwise was
    // seeing the previous section's leftover state.
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    await settingsPage.openSection('KNews Settings');

    await settingsPage.expectSubmitAvailable();
  });
});

test.describe('Settings profile @regression @settings', () => {
  test('the profile shown matches the signed-in account', async ({ homePage, settingsPage }) => {
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    // Cross-checks the rendered name against the session record rather than
    // hard-coding a name that only holds for one test user.
    await settingsPage.expectProfileMatchesSession();
    await settingsPage.expectProfileImage();
  });

  test('the profile section offers a cover photo control', async ({ homePage, settingsPage }) => {
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    await settingsPage.openSection('Profile Creation');

    await settingsPage.expectCoverPhotoControl();
  });
});

test.describe('Settings preferences @regression @settings', () => {
  /**
   * The only preference control in the product. Asserted read-only: switching
   * language writes `i18nextLng` and would re-render the whole shell in another
   * language, which is not this test's business.
   */
  test('the interface language picker offers the supported languages', async ({
    homePage,
    settingsPage,
  }) => {
    await homePage.open();
    await settingsPage.openFromLauncher();
    await settingsPage.expectLoaded();

    await settingsPage.expectLanguageOptions(['English', 'Russian', 'Japanese']);
  });
});
