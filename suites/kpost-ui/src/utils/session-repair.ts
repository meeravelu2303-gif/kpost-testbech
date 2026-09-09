/**
 * Re-seed the shared authenticated session after the app drops it.
 *
 * ## The problem this solves
 *
 * Global setup signs the standard user in ONCE and saves the session to
 * `.auth/standard.json`; every authenticated test then loads that file. That is
 * the right design — until the app invalidates the session mid-run. From that
 * moment the file on disk is a dead session, and **every remaining test in the
 * run fails**, all of them landing on `/login`. One drop 40 tests into a 256-test
 * run produces 200+ failures that say nothing about the 200 features they were
 * supposed to be testing.
 *
 * Measured on this app: a session that global setup verified working was dead
 * later the same run, and everything after it went red in exactly that shape.
 *
 * ## What this does — and deliberately does not do
 *
 * When a test fails because the session was gone, the shared state is re-seeded
 * so the NEXT test starts from a working session. **The failing test still
 * fails.** That is the whole point: the drop is real, it is what KPOST-AUTH-002
 * is about, and hiding it by silently retrying would turn an app defect into a
 * green run. What gets removed is only the cascade — the 200 innocent tests that
 * failed for a reason that had nothing to do with them.
 *
 * Each repair annotates the test that triggered it, so the report says how many
 * times the app dropped the session during the run rather than leaving that
 * buried in a pile of identical failures.
 *
 * ## Scope
 *
 * Written for the serial mode this bench mandates (`npm run test:serial`, and
 * `--workers=1` for anything app-dependent — see CLAUDE.md → Known constraints).
 * With several workers, two of them repairing at once would each take the single
 * session KPost allows per account and evict the other, so repair is skipped
 * unless the run is serial. It is best-effort throughout: a repair that fails is
 * logged and swallowed, never surfaced as a second, confusing failure on a test
 * that already has a real one.
 */
import { chromium } from '@playwright/test';
import { env } from '../config/env';
import { logger } from './logger';
import { STANDARD_STORAGE_STATE } from '../config/global-setup';

/**
 * The phrase `waitForAppReady` raises when a navigation lands on `/login`.
 * Matching on it keeps repair tied to the one condition it can actually fix,
 * instead of firing on every failed test.
 */
export const SESSION_LOST_MARKER = 'The session is no longer authenticated';

/** Cheap guard so one bad patch of the run cannot turn into a re-login loop. */
const MAX_REPAIRS_PER_WORKER = 5;
let repairsDone = 0;

/**
 * Playwright colourises assertion messages, so the raw text is peppered with
 * ANSI escapes — `Received string:  [31m"…/login"[39m`. Any pattern
 * matched against it must strip them first or it silently never matches, which
 * is exactly the kind of quiet no-op that makes a safety net look like it works.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/** Whether a test's failure is the shared session having gone away. */
export function looksLikeLostSession(errors: readonly { message?: string }[]): boolean {
  return errors.some((error) => {
    const message = (error.message ?? '').replace(ANSI, '');
    return (
      message.includes(SESSION_LOST_MARKER) ||
      // `expect(page).toHaveURL(/\/kmail/)` receiving `/login` is the same event
      // seen through a different assertion.
      /Received string:\s*"[^"]*\/login"/.test(message)
    );
  });
}

/**
 * Sign the standard user back in and overwrite `.auth/standard.json`.
 *
 * Mirrors `global-setup.ts`'s `seedViaUi()` step for step, including the
 * keyboard activation of Submit that the domain-suggestion overlay forces. Kept
 * separate rather than imported because global setup's copy exists to run before
 * any test and is not exported; if you change the login flow, change both (the
 * same note is on `seedViaUi`).
 */
export async function repairStandardSession(): Promise<boolean> {
  if (repairsDone >= MAX_REPAIRS_PER_WORKER) {
    logger.warn(
      `Session repair skipped: already re-seeded ${repairsDone} time(s) this worker. The app is ` +
        'dropping sessions faster than they can be replaced — that is the finding, not a reason ' +
        'to keep logging in.',
    );
    return false;
  }
  repairsDone += 1;

  const browser = await chromium.launch(
    process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  );
  try {
    const context = await browser.newContext({ baseURL: env.baseURL, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const idInput = page.getByRole('textbox', { name: 'Enter KPOST ID / Mobile number' });
    await idInput.waitFor({ state: 'visible', timeout: 60_000 });
    await idInput.fill(env.users.standard.email);

    // The domain-suggestion overlay covers Submit; activate by keyboard.
    await page.getByRole('button', { name: 'Submit' }).focus();
    await page.keyboard.press('Enter');

    const passwordInput = page.getByRole('textbox', { name: 'Enter your password' });
    await passwordInput.waitFor({ state: 'visible', timeout: 60_000 });
    await passwordInput.fill(env.users.standard.password);
    await page.getByRole('button', { name: 'Login' }).click();

    await page.waitForURL(/\/home/i, { timeout: 60_000 });
    await context.storageState({ path: STANDARD_STORAGE_STATE });
    await context.close();

    logger.warn(
      `Session repair: the app had dropped the shared session, so it was re-seeded to ` +
        `${STANDARD_STORAGE_STATE}. The test that hit it still failed — only the cascade is gone.`,
    );
    return true;
  } catch (error) {
    logger.warn('Session repair failed; later tests may still see a dead session', {
      error: (error as Error).message,
    });
    return false;
  } finally {
    await browser.close();
  }
}
