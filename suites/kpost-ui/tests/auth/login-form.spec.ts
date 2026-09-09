/**
 * The login form's own preconditions.
 *
 * Everything else in this suite — and every real user — depends on being able
 * to type a KPOST ID. That field is `disabled={!country}`, so the country list
 * loading successfully IS the precondition for the product being usable at all.
 * These tests assert it directly, so a failure names the cause instead of
 * surfacing as every other spec timing out somewhere further downstream.
 *
 * Runs logged-out: this is the sign-in screen.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { LoginPage } from '../../src/pages/LoginPage';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';
import { countryStatusText } from '../../src/utils/login-preflight';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login form readiness @smoke @auth', () => {
  test('the login form is usable — the KPOST ID field accepts input', async ({ page }) => {
    const message = noteKnownDefect(KNOWN_APP_DEFECTS.LOGIN_COUNTRY_LIST_NEVER_POPULATES);
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    // The single assertion that decides whether anyone can sign in today.
    await expect(loginPage.idInputLocator, message).toBeEnabled({ timeout: 45_000 });
  });

  test('the country list offers a country to sign in with', async ({ page }) => {
    const message = noteKnownDefect(KNOWN_APP_DEFECTS.LOGIN_COUNTRY_LIST_NEVER_POPULATES);
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    // The app fetches the list and defaults to India, so a healthy screen shows
    // a chosen country. "No options" is react-select's empty state and is the
    // exact symptom of KPOST-AUTH-004.
    await expect(async () => {
      const country = await countryStatusText(page);
      expect(country, message).not.toMatch(/no options/i);
      expect(country, message).toMatch(/\+\d/);
    }).toPass({ timeout: 45_000 });
  });
});
