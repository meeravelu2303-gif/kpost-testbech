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
import { countryStatusText } from '../../src/utils/login-preflight';

test.use({ storageState: { cookies: [], origins: [] } });

/*
 * These carried a KPOST-AUTH-004 annotation ("country list never populates"). That defect was
 * FIXED and verified on 2026-09-10 — the list now populates and defaults to +91 India even though
 * the backend still answers `"status":"Success"`, so the app-side comparison was made
 * case-insensitive. Proved by interception: rewriting the casing in flight changes nothing now.
 * The annotation is gone per the rule in known-defects.ts — a stale entry excuses a real
 * regression. The assertions stay: they are the precondition for the product being usable.
 */
test.describe('Login form readiness @smoke @auth', () => {
  const WHY =
    'The KPOST ID field is disabled={!country}, so the country list loading IS the precondition ' +
    'for anyone signing in. If this fails, check the country-list request before anything else.';

  test('[FR-S09] the login form is usable — the KPOST ID field accepts input', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    // The single assertion that decides whether anyone can sign in today.
    await expect(loginPage.idInputLocator, WHY).toBeEnabled({ timeout: 45_000 });
  });

  test('the country list offers a country to sign in with', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    // The app fetches the list and defaults to India, so a healthy screen shows a chosen
    // country. "No options" is react-select's empty state.
    await expect(async () => {
      const country = await countryStatusText(page);
      expect(country, WHY).not.toMatch(/no options/i);
      expect(country, WHY).toMatch(/\+\d/);
    }).toPass({ timeout: 45_000 });
  });
});
