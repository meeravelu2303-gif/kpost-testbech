import { defineConfig, devices } from '@playwright/test';
import { env } from './src/config/env';

/**
 * Playwright configuration for the KPost UI automation framework.
 *
 * Design goals:
 *  - One config, many environments. Everything environment-specific comes from
 *    `src/config/env.ts` (which reads .env / CI secrets), never hard-coded here.
 *  - Deterministic CI runs: fully parallel, retries only where they add signal,
 *    forbid `.only`, and fail fast on accidental leftover focus.
 *  - Rich failure diagnostics: trace + screenshot + video retained on failure.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  /* Per-test timeout and assertion timeout. Measured against the live app:
     KPost's initial document load routinely approaches 30s (large bundle plus
     third-party news/Firebase fetches, several of which fail slowly), so the
     navigation budget below is 60s and the per-test budget accommodates a full
     navigation plus the work that follows it. */
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },

  /* Run tests within a file in parallel — combined with per-worker isolation
     this keeps the suite fast and independent. */
  fullyParallel: true,

  /* Fail the CI build if a `test.only` was committed by mistake. */
  forbidOnly: env.isCI,

  /* Retry flaky tests on CI only; locally a failure should be a failure so
     flakiness surfaces immediately during development. Overridable via RETRIES. */
  retries: env.retries ?? (env.isCI ? 2 : 0),

  /* Cap workers on CI for stable, reproducible timing; use all cores locally. */
  workers: env.workers ?? (env.isCI ? 2 : undefined),

  /* Stop a CI run once it is obviously not going to tell us anything new.
     When the app fails to boot, all 236 tests fail one after another and the
     build spends ~25 minutes proving the same point; 25 failures is already a
     conclusive answer. Zero means "no limit", which stays the local default —
     developers debugging a module want the whole picture, not an early exit.

     The run model already handles the consequence honestly: an aborted run
     leaves planned > accounted, so it is reported as INCOMPLETE rather than as
     a small clean run. That is the intended reading, not a side effect. */
  maxFailures: env.isCI ? 25 : 0,

  /* Reporters: HTML for humans (the deep-trace reference — `npm run report`),
     list for the terminal, JSON + JUnit for CI systems, and the bench's own
     reporting engine.

     That last one builds ONE run model and projects it four ways: the
     committed BUG_REPORT.md/.json deliverable, the DEV_DIGEST.md/.json triage
     summary, a POST to the external QA Dashboard (slug `kpost-ui`), and known
     defects filed into the "KPost UI" Bugzilla product. It runs alongside —
     never instead of — the reporters above, no-ops when DASHBOARD_INGEST_URL
     / BUGZILLA_URL are unset, and never fails a run over reporting.
     Because everything derives from one model, its position in this array
     carries no ordering constraint. */
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report', port: 9324 }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['./src/reporting/dashboard-reporter.ts'],
    ...(env.isCI ? [['github'] as const] : []),
  ],

  /* Shared settings for all projects. */
  use: {
    baseURL: env.baseURL,

    /* KPost runs on https://localhost:3000 with a self-signed dev cert. */
    ignoreHTTPSErrors: true,

    /* Diagnostics retained only on failure to keep artifacts small. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    /* Sensible interaction defaults. */
    actionTimeout: 15_000,
    navigationTimeout: 60_000,

    headless: env.headless,
    launchOptions: {
      slowMo: env.slowMo,
      // Opt-in override for images that ship a browser at a fixed path instead
      // of a Playwright-downloaded build (set PW_EXECUTABLE_PATH). Ignored when
      // unset, so normal local/CI installs behave as usual.
      ...(process.env.PW_EXECUTABLE_PATH
        ? { executablePath: process.env.PW_EXECUTABLE_PATH }
        : {}),
    },

    /* Locale/timezone pinned for deterministic date/number rendering. */
    locale: 'en-US',
    timezoneId: 'UTC',

    /* Tag every request so app logs can distinguish automation traffic. */
    extraHTTPHeaders: {
      'x-automated-test': 'kpost-playwright',
    },
  },

  /* Global setup performs a one-time authentication and stores session state
     so the vast majority of tests can start already-logged-in. */
  globalSetup: './src/config/global-setup.ts',

  /* Cross-browser matrix. The `setup` project is not needed because auth is
     handled in globalSetup, but per-project storageState is applied via fixtures. */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    /* Optional mobile emulation project — enable in CI matrix when needed. */
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
    },
  ],

  /* Folder for artifacts (screenshots, videos, traces) from failed tests. */
  outputDir: 'test-results',

  /* Automatically boot the KPost dev server before the suite when running
     locally. On CI the app is typically started by a separate workflow step,
     so we reuse an already-running server. Comment out if the app is always
     started externally. */
  webServer: env.isCI
    ? undefined
    : {
        command: 'echo "Assuming KPost dev server is already running on ' + env.baseURL + '"',
        url: env.baseURL,
        reuseExistingServer: true,
        ignoreHTTPSErrors: true,
        timeout: 120_000,
      },
});
