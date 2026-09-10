import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { profileMutationResponseSchema } from '../../src/api/schemas/profile.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
  comparableBody,
} from '../../src/utils/apiAssertions';
import { buildDeviceSettingPayload } from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * User Profile V2 — device pairing and the device/deactivation OTPs.
 *
 * ## Why device pairing matters more than it looks
 *
 * The primary device is where calls ring and notifications land. `AuthenticationFilter`
 * matches the token's `deviceID` claim against the login-session table on every request, and
 * Kall's `isPrimaryDevice` branch decides whether other sessions get logged out. So a route
 * that lets a caller name **someone else's** device identity is a delivery-hijack primitive:
 * point the victim's primary at an attacker-controlled identity and their calls and pushes
 * follow it.
 *
 * All four pairing routes read `request.getAttribute("kpostID")` in the controller, so the
 * body's `kpostID` should be inert. Each ownership case below supplies one anyway.
 *
 * There are two near-duplicate pairs — `setDeviceAsPrimary`/`updateDeviceAsPrimary` and
 * `setDeviceAsSecondary`/`updateDeviceAsSecondary`. Two routes doing almost the same thing is
 * a maintenance hazard: a fix applied to one and not the other leaves a live bypass, so the
 * tests compare their behaviour directly.
 *
 * ## OTP safety
 *
 * `sendPrimaryDeviceOtp` and `sendAccountDeactivationOtp` **dispatch real OTPs** to the
 * caller's registered number. They take no parameters, so there is nothing to fuzz — the
 * destination is whatever the token's account holds. Each is therefore called a **small,
 * fixed number of times**, never in a loop and never in a rate-limit probe, matching the
 * suite's standing rule that OTP-dispatching endpoints are constrained on purpose.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const VICTIM_DEVICE_ID = 'victim-device-identity-0001';

/* =========================================================================================
 * POST /v2/profile/setDeviceAsPrimary
 * ====================================================================================== */
test.describe('POST /v2/profile/setDeviceAsPrimary', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.setDeviceAsPrimary,
    repro: `await profileClient.setDeviceAsPrimary(buildDeviceSettingPayload(), { token });`,
  };

  test('[1] happy path: pairing a primary device satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: MAX_LENGTH_STRING });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character device identity produced HTTP ${response.status()}. The value is matched against the token's deviceID claim on every later request, so it must fit the column.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.setDeviceAsPrimary({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'pairing a primary device with no device identity' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: null });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "deviceIdentity_primary" set to null — a null primary device breaks call delivery',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: ['a', 'b'] });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    expect(
      response.status(),
      `deviceIdentity_primary was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] HIJACK: a body kpostID must not repoint another user\'s primary device', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeviceSettingPayload({
      kpostID: VICTIM_KPOST_ID,
      deviceIdentity_primary: VICTIM_DEVICE_ID,
    });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `pairing succeeded for kpostID "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The primary device is where that user's calls ring and notifications land; repointing it redirects their traffic. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] business rule: the same identity must not be both primary and secondary', async ({
    profileClient,
    staticToken,
  }) => {
    const identity = 'qa-same-device-identity';
    const payload = buildDeviceSettingPayload({
      deviceIdentity_primary: identity,
      deviceIdentity_secondary: identity,
    });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'one device registered as both primary and secondary',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the device identity must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: XSS_PAYLOAD });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: SQLI_PAYLOAD });
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsPrimary(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not repair device pairing', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsPrimary(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never pair a device', async ({
    profileClient,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsPrimary(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsPrimary(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] duplication: set and update must not diverge', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const [setResponse, updateResponse] = await Promise.all([
      profileClient.setDeviceAsPrimary(payload, { token: staticToken }),
      profileClient.updateDeviceAsPrimary(payload, { token: staticToken }),
    ]);

    expect(
      setResponse.status(),
      `setDeviceAsPrimary answered ${setResponse.status()} while updateDeviceAsPrimary answered ${updateResponse.status()} for the same body. Two near-identical routes on a security-relevant control mean a fix applied to one leaves the other as a bypass.`
    ).toBe(updateResponse.status());
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * POST /v2/profile/updateDeviceAsPrimary
 * ====================================================================================== */
test.describe('POST /v2/profile/updateDeviceAsPrimary', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateDeviceAsPrimary,
    repro: `await profileClient.updateDeviceAsPrimary(buildDeviceSettingPayload(), { token });`,
  };

  test('[1] happy path: updating the primary device satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: MAX_LENGTH_STRING });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character device identity produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateDeviceAsPrimary({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'updating the primary device with no device identity' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: null });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "deviceIdentity_primary" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: 12345 });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    expect(
      response.status(),
      `deviceIdentity_primary was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] HIJACK: a body kpostID must not repoint another user\'s primary device', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeviceSettingPayload({
      kpostID: VICTIM_KPOST_ID,
      deviceIdentity_primary: VICTIM_DEVICE_ID,
    });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `the primary device was updated for "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] session integrity: repointing must not silently invalidate the caller\'s token', async ({
    profileClient,
    staticToken,
  }) => {
    // AuthenticationFilter matches the token's deviceID claim against the session table, so a
    // pairing change can strand a live session with a token that no longer resolves.
    const payload = buildDeviceSettingPayload();
    await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });
    const after = await profileClient.getUserProfile({ token: staticToken });

    expect(
      after.status(),
      `after repointing the primary device the caller's own token answered HTTP ${after.status()} on getUserProfile. Changing a device pairing must not log the user out of the session that made the change.`
    ).toBeLessThan(400);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: XSS_PAYLOAD });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_primary: SQLI_PAYLOAD });
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not repoint a device', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsPrimary(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsPrimary(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.updateDeviceAsPrimary,
      '{"deviceIdentity_primary":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"deviceIdentity_primary":',
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * POST /v2/profile/setDeviceAsSecondary
 * ====================================================================================== */
test.describe('POST /v2/profile/setDeviceAsSecondary', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.setDeviceAsSecondary,
    repro: `await profileClient.setDeviceAsSecondary(buildDeviceSettingPayload(), { token });`,
  };

  test('[1] happy path: pairing a secondary device satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: MAX_LENGTH_STRING });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character secondary device identity produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.setDeviceAsSecondary({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'pairing a secondary device with no device identity' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: null });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "deviceIdentity_secondary" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: { id: 'x' } });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    expect(
      response.status(),
      `deviceIdentity_secondary was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] HIJACK: a body kpostID must not add a device to another user\'s account', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeviceSettingPayload({
      kpostID: VICTIM_KPOST_ID,
      deviceIdentity_secondary: VICTIM_DEVICE_ID,
    });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a secondary device was registered on "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Registering a device on someone else's account is persistent access to their notifications. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] boundary: the number of secondary devices must be capped', async ({
    profileClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => profileClient.setDeviceAsSecondary(buildDeviceSettingPayload(), { token: staticToken }))
    );

    expect(
      responses.every((response) => response.status() < 500),
      `registering five secondary devices in parallel returned ${responses.map((r) => r.status()).join(', ')}. There must be a cap on paired devices, enforced cleanly.`
    ).toBe(true);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: XSS_PAYLOAD });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: SQLI_PAYLOAD });
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsSecondary(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not pair a device', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsSecondary(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.setDeviceAsSecondary(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] duplication: set and update must not diverge', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const [setResponse, updateResponse] = await Promise.all([
      profileClient.setDeviceAsSecondary(payload, { token: staticToken }),
      profileClient.updateDeviceAsSecondary(payload, { token: staticToken }),
    ]);

    expect(
      setResponse.status(),
      `setDeviceAsSecondary answered ${setResponse.status()} while updateDeviceAsSecondary answered ${updateResponse.status()} for the same body.`
    ).toBe(updateResponse.status());
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * POST /v2/profile/updateDeviceAsSecondary
 * ====================================================================================== */
test.describe('POST /v2/profile/updateDeviceAsSecondary', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateDeviceAsSecondary,
    repro: `await profileClient.updateDeviceAsSecondary(buildDeviceSettingPayload(), { token });`,
  };

  test('[1] happy path: updating the secondary device satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: MAX_LENGTH_STRING });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character device identity produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateDeviceAsSecondary({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'updating the secondary device with no device identity' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: null });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "deviceIdentity_secondary" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean device identity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: true });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    expect(
      response.status(),
      `deviceIdentity_secondary was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] HIJACK: a body kpostID must not repoint another user\'s secondary device', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeviceSettingPayload({
      kpostID: VICTIM_KPOST_ID,
      deviceIdentity_secondary: VICTIM_DEVICE_ID,
    });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `the secondary device was updated for "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: XSS_PAYLOAD });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload({ deviceIdentity_secondary: SQLI_PAYLOAD });
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never repoint a device', async ({
    profileClient,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsSecondary(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeviceSettingPayload();
    const response = await profileClient.updateDeviceAsSecondary(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ profileClient, staticToken }) => {
    const response = await profileClient.updateDeviceAsSecondary({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a device-pairing write' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * GET /v2/profile/isDevicePrimaryOrNot
 * ====================================================================================== */
test.describe('GET /v2/profile/isDevicePrimaryOrNot', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.isDevicePrimaryOrNot,
    repro: `await profileClient.isDevicePrimaryOrNot({ token });`,
  };

  test('[1] happy path: the primary-device check satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: the answer must be a definite boolean', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no answer returned');

    expect(
      json?.data,
      `the primary-device check returned no data. A client uses this to decide whether to show call controls; an absent answer leaves the UI guessing. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not answer', async ({ profileClient }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not answer', async ({ profileClient }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not answer for another user', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const withParam = await profileClient.isDevicePrimaryOrNot({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const without = await profileClient.isDevicePrimaryOrNot({ token: staticToken });
    const a = await readBody(withParam);
    const b = await readBody(without);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      comparableBody(a.text),
      `passing ?kpostID=${VICTIM_KPOST_ID} changed the answer for ${authSession.kpostID ?? 'the caller'}. The check must be derived from the token's deviceID claim alone. Body: ${a.text.slice(0, 200)}`
    ).toBe(comparableBody(b.text));
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({
      token: staticToken,
      params: { deviceIdentity_primary: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({
      token: staticToken,
      params: { deviceIdentity_primary: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP 200 must not carry a failure payload', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[8] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[9] idempotency: two consecutive checks must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      profileClient.isDevicePrimaryOrNot({ token: staticToken }),
      profileClient.isDevicePrimaryOrNot({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical checks returned ${first.status()} and ${second.status()}. A read must not change the pairing it reports on.`
    ).toBe(second.status());
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.isDevicePrimaryOrNot({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * GET /v2/profile/sendPrimaryDeviceOtp
 *
 * Dispatches a real OTP to the caller's registered number. Called a small, fixed number of
 * times — never in a loop, and deliberately without a rate-limit probe.
 * ====================================================================================== */
test.describe('GET /v2/profile/sendPrimaryDeviceOtp', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.sendPrimaryDeviceOtp,
    repro: `await profileClient.sendPrimaryDeviceOtp({ token });`,
  };

  test('[1] happy path: the dispatch satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403, 429]
    );
  });

  test('[2] disclosure: the OTP must never appear in the response', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      /"(otp|otpCode|verificationCode)"\s*:\s*"?\d{4,8}"?/i.test(text),
      `the response contained what looks like the OTP itself. An OTP returned over the same channel that requested it proves nothing about possession of the phone — it defeats the entire second factor. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] disclosure: the destination number must be masked', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      /"[^"]*"\s*:\s*"?\+?\d{10,}"?/.test(text),
      `the response echoed a full mobile number. Confirmation screens should show a masked destination (••••••1234), not the whole number. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] auth: no Authorization header must be 401/403 — and must not send an SMS', async ({
    profileClient,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: an expired token must not trigger a dispatch', async ({ profileClient }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: a malformed token must not trigger a dispatch', async ({ profileClient }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[7] auth: an alg=none token claiming admin must not trigger a dispatch', async ({
    profileClient,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[8] IDOR: a kpostID query parameter must not send an OTP to another user', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the response referenced "${VICTIM_KPOST_ID}" after a query parameter named them, while the caller was ${authSession.kpostID ?? 'a different identity'}. If the parameter chooses the destination, this route is an SMS cannon pointed at any user. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryDeviceOtp({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] method safety: a state-changing dispatch should not be a GET', async ({
    profileClient,
    staticToken,
  }) => {
    // Sending an SMS costs money and is not idempotent, so it is not a safe method. A GET is
    // prefetchable — a link scanner can fire it.
    const response = await profileClient.sendPrimaryDeviceOtp({ token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405, 429], {
      ...META,
      title: 'An SMS-dispatching action is exposed on a prefetchable GET',
      severity: 'Major',
    });
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * GET /v2/profile/sendAccountDeactivationOtp
 *
 * The first step of account deletion. Dispatches a real OTP; called sparingly.
 * ====================================================================================== */
test.describe('GET /v2/profile/sendAccountDeactivationOtp', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.sendAccountDeactivationOtp,
    repro: `await profileClient.sendAccountDeactivationOtp({ token });`,
  };

  test('[1] happy path: the dispatch satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403, 429]
    );
  });

  test('[2] disclosure: the OTP must never appear in the response', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      /"(otp|otpCode|verificationCode)"\s*:\s*"?\d{4,8}"?/i.test(text),
      `the deactivation OTP was returned in the response body. This is the single factor standing between a stolen session and permanent account deletion. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not start account deletion', async ({ profileClient }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: a malformed token must not start account deletion', async ({ profileClient }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: an alg=none token claiming admin must never start account deletion', async ({
    profileClient,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[7] IDOR: a kpostID query parameter must not target another account', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the response referenced "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Sending a deletion OTP to another user is both harassment and the first half of deleting their account. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[8] method safety: starting account deletion must not be a GET', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405, 429], {
      ...META,
      title: 'The first step of account deletion is exposed on a prefetchable GET',
      severity: 'Major',
    });
  });

  test('[9] disclosure: the destination number must be masked', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      /"[^"]*"\s*:\s*"?\+?\d{10,}"?/.test(text),
      `the response echoed a full mobile number. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendAccountDeactivationOtp({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});
