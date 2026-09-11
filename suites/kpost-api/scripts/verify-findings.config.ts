import { defineConfig } from '@playwright/test';
import baseConfig from '../playwright.config';

/**
 * Config for the finding-verification harness.
 *
 * Deliberately bare: no reporters, no defect ledger, one worker. This run must not write to the
 * ledger or the report — it exists to LOOK at findings, and a verification pass that files its
 * own tickets would be its own kind of noise.
 */
export default defineConfig({
  ...baseConfig,
  testDir: '.',
  testMatch: /verify-findings\.spec\.ts/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: undefined,
});
