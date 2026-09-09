import { defineConfig } from '@playwright/test';
import { env } from './src/config/env.config';

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./src/config/global-setup'),
  fullyParallel: true,
  forbidOnly: env.isCI,
  retries: env.isCI ? 1 : 0,
  workers: env.isCI ? 2 : env.workers,
  timeout: env.apiTimeout,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    // TIER 1 — diagnostic report for developers and QA engineers. Playwright's own HTML
    // report owns the trace viewer, which is the only way to replay a failed request and
    // response; the executive report links to it.
    ['html', { outputFolder: 'reports/diagnostic', open: 'never' }],
    ['junit', { outputFile: 'reports/junit-results.xml' }],
    /*
     * Files a ledger record for every failing test that did not file one itself (a plain
     * `expect()` rather than an assertion helper). Must stay FIRST of the bug-aware reporters:
     * onEnd hooks run in array order, and the three below all read the ledger this one
     * finishes populating — kpost-master-reporter to build the run model, bugReporter to
     * compile BUG_REPORT.md/.json before deleting .bug-cache/, and the two publishers to read
     * what bugReporter wrote.
     */
    ['./reporters/bug-safety-net.ts'],
    // TIERS 2-4 — executive HTML, trend history and the structured bug stream.
    // Must stay AHEAD of bugReporter: reporters' onEnd hooks run in this order, and
    // bugReporter deletes .bug-cache/ — the defect ledger both of them read — once done.
    ['./reporters/kpost-master-reporter.ts'],
    // Compiles BUG_REPORT.md; a reporter (not globalTeardown) because the executive
    // dashboard needs the run's pass/fail/skip counts and duration.
    ['./src/reporters/bugReporter.ts'],
    /*
     * Publishes the run to the external QA Dashboard (application slug `kpost-admin`) —
     * must stay LAST. It reads BUG_REPORT.json, which the reporter directly above only
     * writes in its own onEnd; anywhere earlier and it would upload the *previous* run.
     * Skips cleanly with one log line when DASHBOARD_INGEST_URL / DASHBOARD_API_KEY are
     * unset, and can never change the run's exit code.
     */
    ['./reporters/dashboard-ingest.ts'],
    /*
     * Files each defect into Bugzilla over its REST API — also reads BUG_REPORT.json, so it
     * stays alongside dashboard-ingest.ts at the tail of this array. A pure REST producer,
     * never a database client. Deduped against Bugzilla itself (a live summary-tag search,
     * not a local ledger), assignment left to each component's Bugzilla default assignee.
     * Skips cleanly with one log line when BUGZILLA_URL / BUGZILLA_API_KEY are unset, and
     * `BUGZILLA_DRY_RUN=true` (the shipped default) maps every defect without calling out.
     */
    ['./reporters/dashboard-bugzilla.ts'],
  ],
  use: {
    baseURL: env.baseURL,
    extraHTTPHeaders: { Accept: 'application/json' },
    ignoreHTTPSErrors: true,
    /*
     * Tier 1 keeps everything a developer needs to reconstruct a failure: the trace records
     * every API request and response body, `sources` embeds the spec code that issued it, and
     * `attachments` carries the error-context notes Playwright writes alongside. Retained on
     * failure only — recording every passing API call would cost gigabytes per run.
     */
    trace: {
      mode: 'retain-on-failure',
      snapshots: true,
      screenshots: true,
      sources: true,
      attachments: true,
    },
  },
  projects: [
    /*
     * Seeding writes real MongoDB rows to a live tenant, so it is opt-in and never runs on a
     * bare `npm test`: the project is registered only when `npm run seed` sets KPOST_RUN_SEED.
     * Spreading an empty array is how a project is conditionally absent from the list.
     */
    ...(process.env.KPOST_RUN_SEED
      ? [{ name: 'seed', testDir: './scripts/seed', testMatch: /.*\.setup\.ts/ }]
      : []),
    // One Playwright project per Swagger tag. Every suite is hand-written under tests/<tag>/.
    { name: 'users', testDir: './tests/users' },
    { name: 'departments', testDir: './tests/departments' },
    { name: 'designations', testDir: './tests/designations' },
    { name: 'rolePostings', testDir: './tests/rolePostings' },
    { name: 'workplaceLocations', testDir: './tests/workplaceLocations' },
    { name: 'employeeMaster', testDir: './tests/employeeMaster' },
    { name: 'holidayCalendar', testDir: './tests/holidayCalendar' },
    { name: 'productLicensing', testDir: './tests/productLicensing' },
    { name: 'workplaceHierarchy', testDir: './tests/workplaceHierarchy' },
    { name: 'hrHierarchy', testDir: './tests/hrHierarchy' },
    { name: 'referenceData', testDir: './tests/referenceData' },
    // All 24 Swagger tags now have coverage across these projects.
  ],
});
