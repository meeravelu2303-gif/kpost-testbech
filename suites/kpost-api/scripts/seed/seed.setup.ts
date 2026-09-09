import { test, expect } from '@playwright/test';
import { seedUser } from '../../src/fixtures/seedUser';

/**
 * Entry point for `npm run seed`.
 *
 * The seeding logic lives in `src/fixtures/seedUser.ts`; this file only drives it. Playwright
 * is used as the runner because it already transpiles TypeScript for this project — adding a
 * separate TS runner just to execute one script would be a dependency with no other purpose.
 *
 * This is a setup task, not a test of the API, so it lives in its own `seed` project and is
 * excluded from `npm test`. It fails only when a token could not be obtained, and the console
 * output explains which step blocked it.
 */
test('seed a test user and persist QA_AUTH_TOKEN into .env', async () => {
  test.setTimeout(120_000);

  const exitCode = await seedUser();

  expect(
    exitCode,
    'Seeding could not obtain a usable access token — see the step-by-step output above for which call blocked it, and set QA_AUTH_TOKEN or QA_KPOST_ID/QA_PASSWORD in .env manually.'
  ).toBe(0);
});
