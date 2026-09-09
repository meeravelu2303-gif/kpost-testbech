/**
 * Global setup — runs once before the entire test run.
 *
 * Authenticates the standard test user a single time and persists the resulting
 * session (cookies + localStorage token) to disk. Tests then start already
 * logged-in by loading that storage state, which:
 *   - eliminates dozens of redundant, slow login flows,
 *   - removes login from the critical path of unrelated tests, and
 *   - keeps each test independent (they share auth *state*, not *runtime*).
 *
 * Two strategies, selected by `AUTH_MODE`:
 *   - 'api' (default) — POST to the API, then inject the returned token into
 *     localStorage and cookies into the context. Fast and deterministic.
 *   - 'ui'            — drive the real login form. Slower, but a good smoke of
 *     the auth path if the API contract isn't wired yet.
 *
 * Dedicated UI auth specs still exercise the login form regardless (they opt out
 * of this shared state). The `.auth/` dir is gitignored — never commit sessions.
 */
import { chromium, type Browser, type FullConfig } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env, type Credentials } from './env';
import { logger } from '../utils/logger';
import { apiLogin } from '../utils/api-helpers';
import { waitForLoginFormReady, watchCountryList } from '../utils/login-preflight';

export const AUTH_DIR = path.resolve('.auth');
export const STANDARD_STORAGE_STATE = path.join(AUTH_DIR, 'standard.json');
/** Session for the optional pre-onboarded KDirectory account (see `seedDirectoryUser`). */
export const DIRECTORY_STORAGE_STATE = path.join(AUTH_DIR, 'directory.json');

/**
 * Seed a session by calling the API and injecting the result into localStorage.
 *
 * KPost does not use auth cookies at all — a signed-in session is a set of
 * localStorage keys, observed on the live app as:
 *   accessToken, refreshToken, isAuthenticated, Authuser,
 *   deviceIdentity_primary, persist:persist:localhost
 *
 * So injecting a single bearer token is not enough; we write every key the API
 * gives us back. `persist:persist:localhost` is an encrypted redux-persist blob
 * that cannot be synthesised, which is why `AUTH_MODE` defaults to `ui`. This
 * path stays for when the API contract is wired up — and `verifySession()`
 * below is what stops it silently producing a half-authenticated state.
 */
async function seedViaApi(browser: Browser): Promise<void> {
  const { token, refreshToken, cookies } = await apiLogin(env.users.standard);

  const context = await browser.newContext({
    baseURL: env.baseURL,
    ignoreHTTPSErrors: true,
  });
  // Cookies, in case the deployment ever uses session-cookie auth.
  if (cookies.length > 0) await context.addCookies(cookies);

  if (token) {
    const entries: [string, string][] = [
      [env.auth.tokenStorageKey, token],
      ['isAuthenticated', 'true'],
    ];
    if (refreshToken) entries.push(['refreshToken', refreshToken]);

    // Seed before any app code runs so the SPA boots already-authenticated.
    await context.addInitScript((pairs: [string, string][]) => {
      for (const [key, value] of pairs) window.localStorage.setItem(key, value);
    }, entries);

    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.close();
  }

  await context.storageState({ path: STANDARD_STORAGE_STATE });
  await context.close();
}

/**
 * Prove the persisted session actually authenticates before any test uses it.
 *
 * Without this, a session that fails to propagate shows up as every
 * authenticated test failing on a confusing "element not found" — the storage
 * state looks fine on disk, so the real cause is several layers away. Here we
 * load the saved state into a clean context exactly as the fixtures do, open
 * `/home`, and require the authenticated shell to render.
 */
async function verifySession(
  browser: Browser,
  storageStatePath: string = STANDARD_STORAGE_STATE,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: env.baseURL,
    ignoreHTTPSErrors: true,
    storageState: storageStatePath,
  });
  const page = await context.newPage();
  try {
    await page.goto('/home', { waitUntil: 'domcontentloaded', timeout: LOGIN_RENDER_TIMEOUT });
    await page
      .getByRole('button', { name: /quick access/i })
      .waitFor({ state: 'visible', timeout: LOGIN_RENDER_TIMEOUT });

    if (/\/login/i.test(page.url())) {
      throw new Error(`Session did not propagate — /home redirected to ${page.url()}`);
    }
    logger.info('Global setup: verified the persisted session authenticates against /home');
  } catch (error) {
    throw new Error(
      'The stored session does not authenticate. The app under test is reachable, but loading ' +
        `${storageStatePath} into a fresh context does not produce a signed-in /home.\n` +
        `Cause: ${(error as Error).message}`,
    );
  } finally {
    await context.close();
  }
}

/**
 * Drive the real two-step login form once and persist the resulting session.
 *
 * This deliberately re-implements the flow instead of reusing `LoginPage`: the
 * page objects wrap their methods in `test.step()`, which is only legal inside a
 * running test, and global setup is not one. Keep the two in sync — in
 * particular the Submit workaround below, which mirrors `LoginPage.submitId()`.
 *
 * Timeouts are deliberately generous. Measured against the live app, the login
 * screen's first paint can exceed the 30s Playwright default, and global setup
 * failing here takes the entire run down with it.
 */
const LOGIN_RENDER_TIMEOUT = 90_000;

async function seedViaUi(
  browser: Browser,
  credentials: Credentials = env.users.standard,
  storageStatePath: string = STANDARD_STORAGE_STATE,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: env.baseURL,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // Armed before navigating: a request the browser blocks outright leaves
  // nothing behind to inspect, and the diagnosis below depends on seeing it.
  watchCountryList(page);

  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: LOGIN_RENDER_TIMEOUT });

  // Step 1 — KPOST ID.
  const idInput = page.getByRole('textbox', { name: 'Enter KPOST ID / Mobile number' });
  await idInput.waitFor({ state: 'visible', timeout: LOGIN_RENDER_TIMEOUT });

  // The field ships disabled until the app resolves a country for itself. If that
  // never happens nobody can sign in, and global setup failing here takes the whole
  // run down — so fail with the diagnosis rather than with a bare fill timeout.
  await waitForLoginFormReady(page, idInput, LOGIN_RENDER_TIMEOUT);

  await idInput.fill(credentials.email);

  // The domain-suggestion overlay covers Submit and cannot be dismissed, and a
  // forced click still lands on the overlay. Activate by keyboard instead —
  // see the long-form explanation in `LoginPage.submitId()`.
  const submitButton = page.getByRole('button', { name: 'Submit' });
  await submitButton.focus();
  await page.keyboard.press('Enter');

  // Step 2 — password.
  const passwordInput = page.getByRole('textbox', { name: 'Enter your password' });
  await passwordInput.waitFor({ state: 'visible', timeout: LOGIN_RENDER_TIMEOUT });
  await passwordInput.fill(credentials.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await page.waitForURL(/\/home/i, { timeout: LOGIN_RENDER_TIMEOUT });
  await context.storageState({ path: storageStatePath });
  await context.close();
}

/**
 * Seed the optional pre-onboarded KDirectory account.
 *
 * Opt-in: only runs when DIRECTORY_USER_EMAIL / DIRECTORY_USER_PASSWORD are set.
 * Always uses the UI flow — this account exists precisely because it has state
 * the API shortcut cannot reproduce.
 *
 * Failure here is fatal rather than a warning: setting those variables is an
 * explicit statement that the account exists, so a broken one should be fixed,
 * not silently downgraded into skipped tests that look like they never ran.
 */
async function seedDirectoryUser(browser: Browser): Promise<void> {
  const credentials = env.users.directory;
  if (!credentials) {
    logger.info(
      'Global setup: no DIRECTORY_USER_EMAIL configured — KDirectory search/filter specs ' +
        'will skip. Set DIRECTORY_USER_EMAIL and DIRECTORY_USER_PASSWORD to enable them.',
    );
    return;
  }

  logger.info(`Global setup: authenticating pre-onboarded directory user (${credentials.email})`);
  try {
    await seedViaUi(browser, credentials, DIRECTORY_STORAGE_STATE);
    await verifySession(browser, DIRECTORY_STORAGE_STATE);
    logger.info(`Global setup: stored directory state at ${DIRECTORY_STORAGE_STATE}`);
  } catch (error) {
    throw new Error(
      'A directory user is configured (DIRECTORY_USER_EMAIL) but could not be signed in. ' +
        'Fix the credentials or unset both variables to fall back to skipping the gated ' +
        `KDirectory specs.\nCause: ${(error as Error).message}`,
    );
  }
}

async function globalSetup(_config: FullConfig): Promise<void> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  logger.info(`Global setup: authenticating standard user (mode=${env.auth.mode})`);

  const browser = await chromium.launch(
    process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  );
  try {
    if (env.auth.mode === 'api') {
      try {
        await seedViaApi(browser);
      } catch (apiError) {
        // If the API contract isn't wired up yet, fall back to the UI so the
        // suite still runs. Surface the reason so it's fixable.
        logger.warn('API auth failed; falling back to UI login', {
          error: (apiError as Error).message,
        });
        await seedViaUi(browser);
      }
    } else {
      await seedViaUi(browser);
    }
    logger.info(`Global setup: stored authenticated state at ${STANDARD_STORAGE_STATE}`);

    // Never hand the suite a session we have not proven works.
    await verifySession(browser);

    // Optional second account, for the KDirectory specs gated behind onboarding.
    await seedDirectoryUser(browser);
  } catch (error) {
    logger.error('Global setup failed to authenticate. Is the KPost app running and seeded?', {
      baseURL: env.baseURL,
      apiBaseURL: env.apiBaseURL,
      error: (error as Error).message,
    });
    throw error;
  } finally {
    await browser.close();
  }
}

export default globalSetup;
