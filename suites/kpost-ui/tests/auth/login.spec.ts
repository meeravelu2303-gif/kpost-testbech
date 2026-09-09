/**
 * Login journey — KPost two-step flow (ID → Submit → password → Login).
 *
 * These tests drive the *real* login flow, so they must run in a clean,
 * unauthenticated context. We override the shared authenticated storageState
 * for this whole file. Every test is atomic: navigate fresh, act, assert.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { LoginPage } from '../../src/pages/LoginPage';
import { HomePage } from '../../src/pages/HomePage';
import invalidData from '../../src/data/users.json';

// Run this file logged-out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login @smoke @auth', () => {
  test('a user can log in with valid credentials', async ({ page, authUser }) => {
    const loginPage = new LoginPage(page);
    const homePage = new HomePage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    await loginPage.loginExpectingSuccess(authUser);

    await homePage.expectLoaded();
    await expect(page).toHaveURL(/\/home/i);
  });

  test('the login flow advances from the ID step to the password step', async ({
    page,
    authUser,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.open();
    await loginPage.expectLoaded();

    await loginPage.enterId(authUser.email);
    await loginPage.submitId();

    await loginPage.expectPasswordStep();
  });
});

test.describe('Login — invalid credentials @regression @auth', () => {
  test('a valid ID with the wrong password does not authenticate', async ({ page, authUser }) => {
    const loginPage = new LoginPage(page);
    await loginPage.open();

    await loginPage.attemptLogin(authUser.email, 'definitely-the-wrong-password');

    await expect(page).not.toHaveURL(/\/home/i);
  });

  // Data-driven: one atomic test per invalid-ID scenario from the fixture.
  for (const scenario of invalidData.invalidIds) {
    test(`rejects login: ${scenario.description}`, async ({ page }) => {
      const loginPage = new LoginPage(page);

      await loginPage.open();
      await loginPage.attemptLogin(scenario.id, scenario.password);

      // However the app rejects it (step-1 or step-2), it must not authenticate.
      await expect(page).not.toHaveURL(/\/home/i);
    });
  }

  /**
   * Not authenticating is only half the contract — a rejected login must also
   * TELL the user. It does: an unknown KPOST ID makes the backend answer 500
   * from `fetchUserDetails`, and the form raises the alert "Enter a Valid
   * KpostID / Mobile Number".
   *
   * ⚠ That alert is **transient**. Measured 2026-08-28 by polling from the
   * moment of submit: it is present at t=250ms and gone well before t=9s. A
   * check that navigates, waits, and then looks sees an empty page and concludes
   * the app says nothing — which is exactly the wrong conclusion, and how this
   * nearly became a filed bug against working behaviour. `expectLoginFeedback()`
   * uses a web-first assertion that starts polling immediately, so it catches
   * the toast rather than the silence after it. Never "fix" a failure here by
   * adding a wait before the assertion.
   */
  test('a rejected login tells the user why @regression', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.open();
    await loginPage.expectLoaded();

    await loginPage.attemptLogin('no-such-user-987654@kpostindia.com', 'Whatever-Passw0rd!');

    await expect(page).not.toHaveURL(/\/home/i);
    await loginPage.expectLoginFeedback();
  });
});
