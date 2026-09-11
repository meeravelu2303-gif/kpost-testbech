import type { ScreenValidator } from '../types';

/**
 * An authenticated screen must refuse a signed-out visitor — the check that catches a route
 * someone forgot to guard.
 *
 * Judged on the required elements, not the URL: a client-side router can leave the URL intact
 * while rendering a dead shell, which this app has actually done (KPOST-AUTH-001 — after logout,
 * navigating back to /home stayed on /home and rendered a shell-less page).
 */
export const sessionValidator: ScreenValidator = {
  stage: 'session',
  appliesTo: (screen) => screen.auth === 'authenticated',

  async run({ page, screen, baseURL }) {
    await page.context().clearCookies();
    await page
      .evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          // Storage can be blocked; the cookie clear above still applies.
        }
      })
      .catch(() => undefined);

    await page.goto(new URL(screen.path, baseURL).toString(), { waitUntil: 'domcontentloaded' });

    const stillRendered = await page
      .locator(screen.requiredElements[0])
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    return stillRendered
      ? {
          outcome: 'failed',
          detail: `the screen still renders "${screen.requiredElements[0]}" with no session — an unguarded route`,
        }
      : { outcome: 'passed' };
  },
};
