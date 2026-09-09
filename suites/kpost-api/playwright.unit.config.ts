import { defineConfig } from '@playwright/test';

/**
 * Offline unit tests for bench code (reporters, utilities) — deliberately a SEPARATE config
 * from `playwright.config.ts`, not just a separate project inside it.
 *
 * Sharing the main config would make every unit run a destructive act on the real run
 * artifacts, because two things there fire regardless of which project is selected:
 *
 *   - `globalSetup` -> `resetBugLedger()` clears `.bug-cache/` and overwrites `BUG_REPORT.md`
 *     with the "run in progress" stub. `--reporter=line` does not prevent this.
 *   - the tier 2-4 reporter chain then rewrites `BUG_REPORT.json` with the unit run's
 *     0 defects, appends a point to the trend history, and POSTs the run to the external QA
 *     Dashboard — publishing a reporter unit test as though it were an API test run.
 *
 * So: no `globalSetup`, no reporter chain, no `baseURL`. These tests touch no network and no
 * artifact; the suite they cover is the bench itself, not the product under test.
 */
export default defineConfig({
  testDir: './reporters/__tests__',
  fullyParallel: true,
  timeout: 10_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  projects: [{ name: 'unit' }],
});
