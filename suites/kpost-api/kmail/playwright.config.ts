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
    /*
     * The native HTML report is the deliverable.
     *
     * It renders the request/response attachments that `base.client.ts` emits on every call,
     * and the finding annotations that `findings.ts` records — so a reviewer opening a failure
     * sees the payload, the headers, the status, the timing, and the graded finding, without
     * the suite needing a bespoke reporter of its own.
     */
    ['html', { outputFolder: 'reports/diagnostic', open: 'never' }],
    // CI consumers expect the conventional JUnit path.
    ['junit', { outputFile: 'test-results/results.xml' }],
    /*
     * Compiles the run's findings into BUG_REPORT.json/.md, then — only when configured —
     * files them into the Bugzilla `KMail API` product (auto-assigned to Jitendra Kumar via
     * each component's default assignee) and ingests the run into the QA Dashboard. Skips
     * cleanly with one log line when the tracker env is unset, so it is safe for every run.
     */
    ['./reporters/publish.reporter.ts'],
  ],

  use: {
    /*
     * The KMail host. Note that `src/fixtures/api.fixture.ts` builds its own contexts rather
     * than relying on this — the auth fixture needs a context on a *different* host — but the
     * value is set here too so that any ad-hoc `request` use in a spec cannot silently default
     * to nothing.
     */
    baseURL: env.kmailBaseURL,
    extraHTTPHeaders: { Accept: 'application/json' },
    ignoreHTTPSErrors: true,
    /*
     * Retained on failure only. The trace records every request and response body and embeds
     * the spec source that issued it, which is everything needed to reconstruct a failure —
     * but recording it for several thousand passing API calls costs gigabytes per run.
     */
    trace: {
      mode: 'retain-on-failure',
      snapshots: true,
      screenshots: false,
      sources: true,
      attachments: true,
    },
  },

  /*
   * One project per domain module, matching the directory layout.
   *
   * Named projects rather than a single flat run because the modules have genuinely different
   * risk profiles and are worth running independently: `compose` sends real mail, `settings`
   * mutates one shared row per account, and `folders` is read-only. `npm run test:folders`
   * against a production-like environment is a reasonable thing to want; `npm run test:compose`
   * against one is not.
   */
  projects: [
    { name: 'auth', testDir: './tests/auth' },
    { name: 'compose', testDir: './tests/compose' },
    { name: 'drafts', testDir: './tests/drafts' },
    { name: 'read', testDir: './tests/read' },
    { name: 'attachments', testDir: './tests/attachments' },
    { name: 'folders', testDir: './tests/folders' },
    { name: 'actions', testDir: './tests/actions' },
    { name: 'search', testDir: './tests/search' },
    { name: 'contacts', testDir: './tests/contacts' },
    { name: 'settings', testDir: './tests/settings' },
    { name: 'translator', testDir: './tests/translator' },
  ],
});
