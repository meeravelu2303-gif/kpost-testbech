import { defineConfig } from '@playwright/test';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

/**
 * Standalone config for `npm run auth:check`.
 *
 * Deliberately separate from `playwright.config.ts`: this must not register a project there,
 * because Playwright runs every registered project by default and a preflight probe has no
 * business executing during `npm test` (the same mistake the seed task once made — see the
 * projects[] comment in the main config).
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /auth-check\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:8989' },
});
