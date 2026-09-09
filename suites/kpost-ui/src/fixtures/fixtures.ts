/**
 * Custom Playwright fixtures — the composition root of the framework.
 *
 * This is where page objects are injected and session state is managed so that
 * individual spec files stay declarative: a test just asks for `homePage` or
 * `kdirectoryPage` and receives a ready-to-use instance bound to the correct
 * (authenticated or anonymous) browser context.
 *
 * Two worlds are exposed:
 *   - `test`         → authenticated by default (loads the shared storageState),
 *                      for the bulk of the suite that assumes a logged-in user.
 *   - `test.use({ storageState: undefined })` on a describe block, or the
 *     `anonymousPage` fixture, gives a clean, logged-out context for auth tests.
 *
 * Import `test` and `expect` from here instead of `@playwright/test` throughout
 * the specs.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { KMailPage } from '../pages/KMailPage';
import { WriteMailPage } from '../pages/WriteMailPage';
import { KDirectoryPage } from '../pages/KDirectoryPage';
import { KatchupPage } from '../pages/KatchupPage';
import { SettingsPage } from '../pages/SettingsPage';
import { KEcommercePage } from '../pages/KEcommercePage';
import { KNewsPage } from '../pages/KNewsPage';
import { KPayPage } from '../pages/KPayPage';
import { STANDARD_STORAGE_STATE } from '../config/global-setup';
import { env, type Credentials } from '../config/env';
import { apiLogin, apiCreatePost, apiDeletePost, type AuthResult } from '../utils/api-helpers';
import type { Post } from '../types';
import { looksLikeLostSession, repairStandardSession } from '../utils/session-repair';

/** Test-scoped fixtures — recreated per test. */
interface KPostFixtures {
  loginPage: LoginPage;
  homePage: HomePage;
  kmailPage: KMailPage;
  writeMailPage: WriteMailPage;
  kdirectoryPage: KDirectoryPage;
  katchupPage: KatchupPage;
  settingsPage: SettingsPage;
  kecommercePage: KEcommercePage;
  knewsPage: KNewsPage;
  kpayPage: KPayPage;
  /** A page in a fresh, unauthenticated context (for login/logout tests). */
  anonymousPage: Page;
  /** Convenience accessor for the seeded standard-user credentials. */
  standardUser: Credentials;
  adminUser: Credentials;
  /**
   * The account the auth journeys sign in and out as.
   *
   * Deliberately NOT `standardUser`. KPost allows one active session per
   * account, so a spec that logs in (or out) as the standard user destroys the
   * shared `storageState` global setup captured for that same account, and
   * every authenticated test after it fails as a silently-logged-out session.
   * Verified 2026-08-27: the stored session passed global setup's own check,
   * the auth specs then ran, and `/home` afterwards redirected to `/login`.
   */
  authUser: Credentials;
  /**
   * The account the KDirectory specs run as: the pre-onboarded directory user
   * when `DIRECTORY_USER_EMAIL` is configured, otherwise the standard user.
   * Pair with the `storageState` those specs select.
   */
  directoryUser: Credentials;
  /**
   * Seed a post via the API and get its id back. Every post seeded through this
   * fixture is automatically deleted in teardown, so tests stay atomic and
   * leave no residue in a shared backend.
   *
   * LEGACY: no current spec uses this — it targets the blog-style `/posts` API
   * that the removed scaffold specs assumed. Kept as the worked example of the
   * arrange-via-API / assert-via-UI pattern to copy when a real KPost module
   * API is wired up.
   */
  seedPost: (post: Post) => Promise<string>;
}

/** Worker-scoped fixtures — created once per worker and reused across its tests. */
interface KPostWorkerFixtures {
  /** Standard-user API auth (token + cookies), obtained once per worker. */
  apiAuth: AuthResult;
}

export const test = base.extend<KPostFixtures, KPostWorkerFixtures>({
  /**
   * Authenticated context by default. `storageState` from global setup is
   * applied to every test's context unless a describe block overrides it.
   */
  storageState: STANDARD_STORAGE_STATE,

  /**
   * The page, plus one piece of after-the-fact housekeeping.
   *
   * When a test fails because the app dropped the shared session, the session
   * file on disk is dead and EVERY remaining test in the run would fail the same
   * way — a single drop turning into two hundred meaningless failures. So the
   * session is re-seeded here, after the test.
   *
   * The test that hit it still fails. Only the cascade is removed; the drop
   * itself is real signal (KPOST-AUTH-002) and is annotated so the report can
   * count how often it happened. See `session-repair.ts` for the full rationale
   * and why this is limited to serial runs.
   */
  page: async ({ page }, use, testInfo) => {
    await use(page);

    if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
    if (!looksLikeLostSession(testInfo.errors)) return;
    // Concurrent repairs would each claim the one session KPost allows per
    // account and evict each other, so only the serial mode repairs.
    if (testInfo.config.workers !== 1) return;

    testInfo.annotations.push({
      type: 'session-lost',
      description:
        'The app dropped the shared authenticated session during this test. The session was ' +
        're-seeded afterwards so the rest of the run is not affected; this test still failed.',
    });
    await repairStandardSession();
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  homePage: async ({ page }, use) => {
    await use(new HomePage(page));
  },

  kmailPage: async ({ page }, use) => {
    await use(new KMailPage(page));
  },

  writeMailPage: async ({ page }, use) => {
    await use(new WriteMailPage(page));
  },

  kdirectoryPage: async ({ page }, use) => {
    await use(new KDirectoryPage(page));
  },

  katchupPage: async ({ page }, use) => {
    await use(new KatchupPage(page));
  },

  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },

  kecommercePage: async ({ page }, use) => {
    await use(new KEcommercePage(page));
  },

  knewsPage: async ({ page }, use) => {
    await use(new KNewsPage(page));
  },

  kpayPage: async ({ page }, use) => {
    await use(new KPayPage(page));
  },

  /**
   * A throwaway, logged-out page. Created in its own context so it never
   * inherits the shared authenticated storageState — essential for tests that
   * drive the real login flow. Automatically torn down after the test.
   */
  anonymousPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  standardUser: async ({}, use) => {
    await use(env.users.standard);
  },

  adminUser: async ({}, use) => {
    await use(env.users.admin);
  },

  authUser: async ({}, use) => {
    await use(env.users.auth);
  },

  directoryUser: async ({}, use) => {
    await use(env.users.directory ?? env.users.standard);
  },

  // Worker-scoped: one API login per worker, shared by all its tests.
  apiAuth: [
    async ({}, use) => {
      const auth = await apiLogin(env.users.standard);
      await use(auth);
    },
    { scope: 'worker' },
  ],

  // Test-scoped: seed posts via the API and clean them up afterwards.
  seedPost: async ({ apiAuth }, use) => {
    const createdIds: string[] = [];
    const seed = async (post: Post): Promise<string> => {
      const id = await apiCreatePost(apiAuth, post);
      createdIds.push(id);
      return id;
    };
    await use(seed);
    // Teardown: best-effort delete so seeded data never leaks between tests.
    for (const id of createdIds) {
      await apiDeletePost(apiAuth, id).catch(() => undefined);
    }
  },
});

export { expect };
