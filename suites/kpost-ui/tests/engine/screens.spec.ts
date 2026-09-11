import { test, expect } from '../../src/fixtures/fixtures';
import { screenEngine, describeFailures, describeStages } from '../../src/engine';
import { ALL_SCREENS } from '../../src/screens';
import { env } from '../../src/config/env';

/**
 * Generic screen driver — no per-screen code, and none should be added here.
 *
 * A screen needing something specific declares it in `src/screens/`; a check applying to more
 * than one screen belongs in a validator. This file only iterates.
 *
 * It does not replace the journey specs under `tests/`: those carry multi-step flows (sign in,
 * compose, send, verify) that no declaration can express.
 */
test.describe('Screen engine — centralized UI validation @regression', () => {
  for (const screen of ALL_SCREENS) {
    test(`[screen] ${screen.name} (${screen.path})`, async ({ page }) => {
      const result = await screenEngine.run(screen, {
        page,
        baseURL: env.baseURL,
        consoleErrors: [],
        failedRequests: [],
      });

      expect(
        result.passed,
        `${screen.name} failed centralized validation.\n` +
          `${describeFailures(result)}\n\nstages: ${describeStages(result)}`
      ).toBe(true);
    });
  }
});
