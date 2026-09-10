import jwt from 'jsonwebtoken';
import { test, expect } from '../../src/fixtures/api.fixture';
import { env } from '../../src/config/env.config';
import { REFERENCE_PATHS } from '../../src/api/clients/referenceData.client';
import { assertUnauthorized, readBody } from '../../src/utils/apiAssertions';

/**
 * Token-trust canaries for the Admin Module.
 *
 * ## Why this file exists
 *
 * This bench has no login route to drive — the Admin Module's `userDetails/login` returns
 * identity fields and never a token — so every one of the suite's ~1,560 tests runs on a JWT
 * this bench **mints itself** from `ADMIN_JWT_SECRET`. That is a reasonable workaround, and it
 * has one dangerous property: the suite never exercises real token issuance, so if the shared
 * secret drifts out of sync with the deployed service, every authenticated call quietly drops
 * to unauthenticated.
 *
 * That failure does not look like a failure. It looks like a *better* run: refusals are
 * expected on the negative cases, contract cases skip, and the defect count goes DOWN. The
 * authSession docstring records the same trap for the base64-vs-ASCII signing key.
 *
 * So the two cases below assert the trust boundary itself, in both directions:
 *
 *   1. the secret this bench holds is still the one the service verifies with — if not, say so
 *      once and loudly, instead of letting 1,560 tests report a misleadingly clean run;
 *   2. a token signed with the WRONG key is refused — if the service ever accepts one, the
 *      signature is not being verified at all, which is a total authentication bypass.
 *
 * Case 2 is the security assertion; case 1 is the honesty assertion. Both are cheap.
 */

/** A structurally perfect token signed with a key the service must not recognise. */
function tokenSignedWithWrongKey(): string {
  return jwt.sign(
    { companyID: env.qaCompanyId },
    Buffer.from('bm90LXRoZS1yZWFsLXNpZ25pbmcta2V5LWF0LWFsbA==', 'base64'),
    { algorithm: 'HS256', subject: env.qaKpostId, expiresIn: env.adminJwtTtlSeconds }
  );
}

test.describe('Admin token trust', () => {
  const META = {
    method: 'GET',
    path: REFERENCE_PATHS.countryList,
    repro: `await referenceDataClient.countryList({ token: <token signed with a foreign key> });`,
  };

  test('[1] the locally minted token is still accepted — ADMIN_JWT_SECRET has not drifted', async ({ referenceDataClient, authToken }) => {
    test.skip(!authToken, 'the suite is running unauthenticated; nothing to verify');

    const response = await referenceDataClient.countryList({ token: authToken });
    const { text } = await readBody(response);

    // Asserted with a bare expect ON PURPOSE. This is a bench-configuration problem, not a
    // product defect — filing it as a Bugzilla ticket against the Admin Module would be wrong.
    // It has to fail the run loudly so nobody reads the result as a clean pass.
    expect(
      response.status(),
      `the token this suite mints from ADMIN_JWT_SECRET was refused (HTTP ${response.status()}). ` +
        `Every authenticated test in this suite is therefore running unauthenticated, and the run's ` +
        `low defect count is meaningless. Check ADMIN_JWT_SECRET against the deployed service, and ` +
        `remember the secret is base64-DECODED before signing (see authSession.mintToken). ` +
        `Body: ${text.slice(0, 200)}`
    ).not.toBe(401);
  });

  test('[2] a token signed with a foreign key must be refused', async ({ referenceDataClient }) => {
    // If this passes back a 200 the service is not verifying the signature, and any party who
    // can guess the claim shape holds an admin session.
    const response = await referenceDataClient.countryList({ token: tokenSignedWithWrongKey() });

    await assertUnauthorized(response, {
      ...META,
      title: 'A JWT signed with an unknown key is accepted',
      severity: 'Critical' as const,
    });
  });
});
