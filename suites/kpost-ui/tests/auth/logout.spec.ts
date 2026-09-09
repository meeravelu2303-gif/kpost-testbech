/**
 * Logout journey.
 *
 * ── Why this file signs in for itself instead of using the shared session ──
 *
 * It used to start from the shared authenticated `storageState` and log THAT
 * session out. KPost allows one active session per account, so logging out the
 * standard user server-side invalidated the very session every other spec in
 * the suite relies on — and every authenticated test that ran afterwards failed
 * as a silently-logged-out session, several layers from the cause. Measured on
 * 2026-08-27: global setup verified the stored session, this file ran, and
 * `/home` afterwards redirected to `/login` for everything downstream.
 *
 * So this file runs logged-OUT, signs in as the dedicated auth account
 * (`env.users.auth`, defaulting to the admin user — never the standard user),
 * and logs that session out. The standard user's shared session is left
 * untouched, which is the whole point.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { LoginPage } from '../../src/pages/LoginPage';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

// Log out of a session this file owns, not the one the suite shares.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Logout @regression @auth', () => {
  test('a signed-in user can log out and is returned to login', async ({
    homePage,
    page,
    authUser,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.open();
    await loginPage.loginExpectingSuccess(authUser);
    await homePage.expectLoaded();

    await homePage.logout();

    await expect(page).toHaveURL(/\/login/i);
  });

  test('after logout, protected routes redirect back to login', async ({
    homePage,
    page,
    authUser,
  }) => {
    const defect = noteKnownDefect(KNOWN_APP_DEFECTS.LOGOUT_NO_ROUTE_GUARD);

    const loginPage = new LoginPage(page);
    await loginPage.open();
    await loginPage.loginExpectingSuccess(authUser);
    await homePage.expectLoaded();

    await homePage.logout();

    // Attempting to revisit a protected route must not restore the session.
    await page.goto('/home');
    await expect(page, defect).toHaveURL(/\/login/i);
  });
});
