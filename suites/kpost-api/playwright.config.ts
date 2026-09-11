import { defineConfig } from '@playwright/test';
import { env } from './src/config/env.config';

export default defineConfig({
  testDir: './tests',
  // The seed task lives in `scripts/seed/`, outside `testDir`, and is only registered as a
  // project when KPOST_RUN_SEED is set — that conditional below is what keeps a bare
  // `npx playwright test` from re-registering users. A `testIgnore` for a `tests/seed` glob
  // used to sit here claiming that job; the path has never existed, so it protected nothing.
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
    // CI consumers expect the conventional path; `reports/` is where every other artifact
    // lives, so both are emitted rather than forcing one convention onto the other.
    ['junit', { outputFile: 'test-results/results.xml' }],
    /*
     * Allure was registered here and has been removed for the second time.
     *
     * It is a second generic per-test viewer that overlaps tier 1, and rendering it needs the
     * Java-based `allure` CLI — a run produces `allure-results/` (raw JSON), not a readable
     * report. The one thing it added over tier 1 was request/response attachments, and those
     * now come from `attachExchange()` in base.client.ts, which emits standard Playwright
     * attachments that the native HTML report already renders.
     *
     * It also cost 1,353 tracked files in git before the results directory was ignored. If it
     * is ever wanted again, prefer running the CLI over a run's JUnit/trace output to adding a
     * reporter back to this array.
     */
    /*
     * Files a ledger record for every failing test that did not file one itself (a plain
     * `expect()` rather than an assertion helper). Must stay FIRST of the bug-aware reporters:
     * onEnd hooks run in array order, and both reporters below read the ledger this one
     * finishes populating — kpost-master-reporter to build the run model, bugReporter to
     * compile BUG_REPORT.md/.json before deleting .bug-cache/.
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
     * Publishes the run to the external QA Dashboard — must stay LAST.
     *
     * It reads BUG_REPORT.json, which the reporter directly above only writes in
     * its own onEnd; anywhere earlier in this array and it would upload the
     * *previous* run. Same ordering constraint that keeps kpost-master-reporter
     * ahead of bugReporter, for the same reason.
     *
     * One HTTP POST, no database driver — the dashboard is a separate product in
     * its own repository and owns its own storage. Leaves the file reports
     * untouched and skips cleanly with a single log line when
     * DASHBOARD_INGEST_URL / DASHBOARD_API_KEY are unset, so it is safe for
     * everyone including anyone who never configures a dashboard.
     */
    ['./reporters/dashboard-ingest.ts'],
    /*
     * Files each defect into Bugzilla over its REST API — also reads BUG_REPORT.json, so it
     * stays alongside dashboard-ingest.ts at the tail of this array. A pure REST producer,
     * never a database client. Deduped against Bugzilla itself (a live summary-tag search,
     * not a local ledger), assignment left to each component's Bugzilla default assignee.
     * Skips cleanly with one log line when BUGZILLA_URL / BUGZILLA_API_KEY are unset.
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
     * failure only — recording ~4,500 passing API calls would cost gigabytes per run.
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
     * Setup task, not API coverage — opt-in via KPOST_RUN_SEED (`npm run seed` sets it).
     *
     * It was previously registered unconditionally, with a comment claiming a bare
     * `npx playwright test` "can never pick it up". That was wrong: Playwright runs every
     * registered project by default, so the seed ran on every full run. Three costs:
     *
     *   1. an extra account registered per run;
     *   2. no benefit to that run — `.env` is read once at config load, so a token written
     *      mid-run cannot reach tests that are already executing;
     *   3. a race — `fullyParallel` with no `dependencies`, so it ran *alongside* the suite
     *      rather than before it.
     *
     * Seeding is therefore an explicit step: `npm run seed` when the token is stale, then
     * `npm test`. One account per seed, not per run, and the ordering guarantee is real
     * rather than implied.
     */
    ...(process.env.KPOST_RUN_SEED
      ? [{ name: 'seed', testDir: './scripts/seed', testMatch: /.*\.setup\.ts/ }]
      : []),
    /*
     * Offline unit tests for bench code live in `playwright.unit.config.ts` (`npm run
     * test:unit`), NOT as a project here: this config's globalSetup resets the bug ledger and
     * its reporter chain publishes the run, neither of which a reporter unit test should do.
     */
    { name: 'auth', testDir: './tests/auth' },
    { name: 'profile', testDir: './tests/profile' },
    { name: 'common', testDir: './tests/common' },
    { name: 'integrations', testDir: './tests/integrations' },
    // One project per controller tag. Every suite is hand-written under tests/<tag>/.
    { name: 'dashboardV2', testDir: './tests/dashboardV2' },
    { name: 'knews', testDir: './tests/knews' },
    { name: 'generalSettings', testDir: './tests/generalSettings' },
    { name: 'groupsV2', testDir: './tests/groupsV2' },
    { name: 'companyAdministration', testDir: './tests/companyAdministration' },
    { name: 'contactsDirectoryV2', testDir: './tests/contactsDirectoryV2' },
    { name: 'kwordDocuments', testDir: './tests/kwordDocuments' },
    { name: 'kpresentation', testDir: './tests/kpresentation' },
    { name: 'kdiary', testDir: './tests/kdiary' },
    { name: 'kallV2', testDir: './tests/kallV2' },
    { name: 'redbus', testDir: './tests/redbus' },
    { name: 'katchupV2', testDir: './tests/katchupV2' },
    /*
     * Not a controller tag — the platform-wide requirements that belong to no single controller
     * (NFR-SEC01, BR-X02, NFR-R02). Every other project above maps one-to-one to a swagger tag;
     * this one deliberately does not, because the rules it proves are properties of the platform
     * rather than of an endpoint. See tests/crossModule/platformRules.spec.ts.
     */
    { name: 'crossModule', testDir: './tests/crossModule' },
    /*
     * The generic engine driver — not a controller tag either. It runs the centralized validation
     * pipeline against every endpoint registered in `src/engine/definitions/`, so its coverage
     * grows by declaration rather than by new spec files.
     */
    { name: 'engine', testDir: './tests/engine' },
  ],
});
