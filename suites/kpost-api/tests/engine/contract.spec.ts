import { test, expect } from '../../src/fixtures/api.fixture';
import { apiEngine, describeFailures, describeStages, registryCoverage } from '../../src/engine';
import { ALL_ENDPOINTS } from '../../src/endpoints';
import type { Role } from '../../src/engine';

/**
 * Generic engine driver — no per-endpoint code, and none should ever be added here.
 *
 * An endpoint needing something specific declares it in `src/endpoints/`; a check applying to more
 * than one endpoint belongs in a validator. This file only iterates.
 *
 * It does not replace the module specs: those carry the business rules a contract cannot express.
 */
test.describe('API engine — centralized validation', () => {
  test('[registry] engine coverage of the Excel contract', async () => {
    const coverage = registryCoverage();
    // eslint-disable-next-line no-console
    console.log(
      `\n[engine] ${coverage.registered}/${coverage.mandatory} mandatory endpoints declared ` +
        `(${coverage.percent.toFixed(1)}%); the rest are covered by module specs.\n`
    );
    expect(coverage.mandatory, 'the Excel contract must be readable').toBeGreaterThan(0);
  });

  for (const endpoint of ALL_ENDPOINTS) {
    test(`[engine] ${endpoint.method} ${endpoint.path}`, async ({
      apiContext,
      staticToken,
      adminToken,
    }) => {
      // A role with no token reports "matrix partially unexercised" rather than passing silently.
      const roleTokens: Partial<Record<Role, string>> = {};
      if (staticToken) roleTokens.USER = staticToken;
      if (adminToken) roleTokens.ADMIN = adminToken;

      const result = await apiEngine.run(endpoint, {
        request: apiContext,
        token: staticToken ?? null,
        roleTokens,
      });

      expect(
        result.passed,
        `${endpoint.method} ${endpoint.path} failed centralized validation.\n` +
          `${describeFailures(result)}\n\nstages: ${describeStages(result)}`
      ).toBe(true);
    });
  }
});
