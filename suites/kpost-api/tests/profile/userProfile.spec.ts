import { test, expect, EXPIRED_TOKEN, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import {} from '../../src/api/schemas/profile.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  assertPublicRouteReachable,
  readBody,
  comparableBody,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { MALFORMED_JSON_STRINGS, SQLI, XSS } from '../../src/utils/fuzzData';
import {
  buildChangeAccessCodePayload,
  buildChangePasswordPayload,
  buildDeactivateAccountPayload,
  buildDigitalCardPayload,
  buildKpostIdLookupPayload,
  pngFileBuffer,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

const FORGED_ALG_NONE_JWT =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';

/* ========================================================================================
 * GET /v2/profile/getUserProfile — the caller's own profile.
 * ===================================================================================== */
test.describe('Profile - GET /v2/profile/getUserProfile', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.getUserProfile,
    repro: `await profileClient.getUserProfile({ token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getUserProfile({ token: staticToken });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. contract: an authenticated read matches the envelope schema', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.getUserProfile({ token: authToken });
    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('3. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getUserProfile({ token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getUserProfile({ token: null });`,
    });
  });

  test('4. expired token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getUserProfile({ token: EXPIRED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getUserProfile({ token: EXPIRED_TOKEN });`,
    });
  });

  test('5. malformed token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getUserProfile({ token: MALFORMED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getUserProfile({ token: MALFORMED_TOKEN });`,
    });
  });

  test('6. an alg=none forged token must not return a profile', async ({ profileClient }) => {
    const response = await profileClient.getUserProfile({ token: FORGED_ALG_NONE_JWT });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getUserProfile({ token: '<alg=none JWT>' });`,
    });
  });

  test('7. IDOR: a query-supplied kpostID must not switch identity', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const own = await readBody(await profileClient.getUserProfile({ token: authToken }));
    const impersonated = await readBody(
      await profileClient.getUserProfile({ token: authToken, params: { kpostID: 'admin' } })
    );

    expect(
      comparableBody(impersonated.text),
      'a query-supplied kpostID changed whose profile was returned — the profile is not scoped to the token identity'
    ).toBe(comparableBody(own.text));
  });

  test('8. the profile must not expose password or token material', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const { text } = await readBody(await profileClient.getUserProfile({ token: authToken }));

    expect(text, 'the profile response exposed password material').not.toMatch(
      /"(password|kmailPassword|accessCode)"\s*:\s*"[^"]+"/i
    );
  });

  test('9. unexpected query params do not cause a 5xx', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getUserProfile({
      token: staticToken,
      params: { expand: 'all', limit: -1 },
    });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('10. SQL injection in query params does not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.getUserProfile({
        token: staticToken,
        params: { kpostID: payload },
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.getUserProfile({ token, params: { kpostID: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('11. concurrent reads are consistent', async ({ profileClient, staticToken }) => {
    const responses = await Promise.all([
      profileClient.getUserProfile({ token: staticToken }),
      profileClient.getUserProfile({ token: staticToken }),
    ]);
    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent profile reads returned different statuses'
    ).toBe(1);
  });

  test('12. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(await profileClient.getUserProfile({ token: staticToken }), META);
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

/* ========================================================================================
 * The profile update family shares a payload shape and an auth contract, so the common
 * cases are generated once per endpoint and the endpoint-specific business rules are
 * asserted separately below.
 * ===================================================================================== */
/* ========================================================================================
 * The five self-service profile writes (updateBasicInformation, updateContactInformation,
 * updateDesignation, setProfilePrivacy, updatePrivacySettingDetails) and the work-experience
 * pair (saveOrUpdateExperienceDetails, deleteExperienceDetail) are covered in
 * tests/profile/profileUpdates.spec.ts and tests/profile/searchAndExperience.spec.ts.
 *
 * The table-driven block that used to live here asserted the same ten categories against the
 * same signatures. The canonical files supersede it because they also carry the per-endpoint
 * business rules a shared template cannot express - an out-of-range privacyStatus that fails
 * open and widens a member's audience, a designationID with no row behind it, an experience
 * entry that ends before it starts.
 * ===================================================================================== */

/* ========================================================================================
 * POST /v2/profile/changePassword — credential change, throwaway identities only.
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/changePassword', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.changePassword,
    repro: `await profileClient.changePassword(buildChangePasswordPayload(), { token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This is a *successful* credential change, not a refusal path: the payload carries the
     * throwaway password as `currentPassword` and a new one as `forgotPassword`, and the API
     * applies it. Aimed at `staticToken` — the shared session — it rewrote the bench's own
     * login password on every run, and the account was then unusable: `.env` still held the
     * old value, so the next run reported "Invalid Credential", which is indistinguishable
     * from a wrong password.
     *
     * That is not hypothetical. Ten QA identities had been burned this way by 2026-08-24 -
     * qauser9165, qabgwy0a50, qa8jx2hth0, qa94txf81d, qafresh58421, qabench01, qabench620,
     * qavf91dlmz, meera and qa4an2yn3j - each the bench's identity in turn, each left with a
     * password nothing on this side knew. The runs in between survived only because a cached
     * token outlived the credential that minted it.
     *
     * Same rule, and same reason, as `deactivateAccount` below.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a credential change at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    const response = await profileClient.changePassword(buildChangePasswordPayload(), {
      token: disposableToken,
    });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.changePassword(buildChangePasswordPayload(), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.changePassword(buildChangePasswordPayload(), { token: null });`,
    });
  });

  test('3. expired/malformed token: must be 401/403', async ({ profileClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN, FORGED_ALG_NONE_JWT]) {
      const response = await profileClient.changePassword(buildChangePasswordPayload(), { token });
      await assertUnauthorized(response, {
        ...META,
        repro: `await profileClient.changePassword(buildChangePasswordPayload(), { token: '<invalid>' });`,
      });
    }
  });

  test('4. a wrong current password must never allow the change', async ({
    profileClient,
    disposableToken,
  }) => {
    // Safety: changePassword keys off the TOKEN identity, so this must never run on the shared
    // session — a successful change would rewrite the bench's own credential. Throwaway identity
    // only. `oldPassword` is the REAL current-password field (not `currentPassword`); sending a
    // wrong value here is what actually exercises the refusal path.
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a credential change at the shared QA identity'
    );
    const response = await profileClient.changePassword(
      buildChangePasswordPayload({ oldPassword: 'definitely-not-the-password' }),
      { token: disposableToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'the password was changed without presenting the correct current password — session theft becomes full account takeover'
    ).toBeFalsy();
  });

  test('5. missing current password must be rejected', async ({ profileClient, disposableToken }) => {
    /*
     * Throwaway identity: the payload still carries `forgotPassword`, so if the API does not
     * reject it - which is exactly what this asserts, and exactly what it does - the password
     * is changed regardless. Aimed at the shared session that silently rewrote the bench's
     * own credential.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a credential change at the shared QA identity'
    );
    const payload = buildChangePasswordPayload();
    delete (payload as Record<string, unknown>).currentPassword;
    delete (payload as Record<string, unknown>).oldPassword;

    const response = await profileClient.changePassword(payload, { token: disposableToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'changePassword without the current password',
        repro: `const p = buildChangePasswordPayload(); delete p.currentPassword; await profileClient.changePassword(p, { token });`,
      },
      [400, 401, 403, 422]
    );
  });

  test('6. a blank new password must be rejected', async ({ profileClient, disposableToken }) => {
    // The DTO is `{ oldPassword, confirmPassword }` — `confirmPassword` IS the new password, so
    // there is no separate confirmation to "mismatch". The real risk here is a BLANK new
    // password being accepted (an empty credential). Throwaway identity only — a successful
    // change rewrites the token's own credential.
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a credential change at the shared QA identity'
    );
    const response = await profileClient.changePassword(
      buildChangePasswordPayload({ confirmPassword: '' }),
      { token: disposableToken }
    );
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'changePassword with a blank new password',
        repro: `await profileClient.changePassword(buildChangePasswordPayload({ confirmPassword: '' }), { token });`,
      },
      [400, 401, 403, 422]
    );
  });

  test('7. weak passwords must be refused by the password policy', async ({
    profileClient,
    staticToken,
  }) => {
    for (const weak of ['1', 'a', '123456', 'password']) {
      const response = await profileClient.changePassword(
        buildChangePasswordPayload({ forgotPassword: weak, confirmPassword: weak }),
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `changePassword with the weak password "${weak}"`,
          repro: `await profileClient.changePassword(buildChangePasswordPayload({ forgotPassword: '${weak}' }), { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('8. null/empty new password must be rejected', async ({ profileClient, staticToken }) => {
    for (const value of [null, '', ' ']) {
      const response = await profileClient.changePassword(
        buildChangePasswordPayload({ forgotPassword: value, confirmPassword: value }),
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `changePassword with forgotPassword=${JSON.stringify(value)}`,
          repro: `await profileClient.changePassword(buildChangePasswordPayload({ forgotPassword: ${JSON.stringify(value)} }), { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('9. IDOR: a body-supplied kpostID must not change another account\'s password', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.changePassword(
      buildChangePasswordPayload({ kpostID: 'admin' }),
      { token: authToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      "a body-supplied kpostID changed another account's password — critical account takeover"
    ).toBeFalsy();
  });

  test('10. no password material is echoed back', async ({ profileClient, staticToken }) => {
    const response = await profileClient.changePassword(
      buildChangePasswordPayload({
        forgotPassword: 'Qa@Uniqu3Echo!',
        confirmPassword: 'Qa@Uniqu3Echo!',
      }),
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(text, 'the submitted password was echoed in the response').not.toContain(
      'Qa@Uniqu3Echo!'
    );
  });

  test('11. SQL injection does not leak internals', async ({ profileClient, staticToken }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.changePassword(
        buildChangePasswordPayload({ currentPassword: payload }),
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.changePassword(buildChangePasswordPayload({ currentPassword: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('12. brute force: repeated wrong current passwords should be throttled', async ({
    profileClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        profileClient.changePassword(
          buildChangePasswordPayload({ currentPassword: `wrong-${i}` }),
          { token: staticToken }
        )
      )
    );

    expect(
      responses.some((r) => r.status() === 429),
      '10 rapid wrong-password attempts were all processed with no 429 — the current password can be brute-forced through this endpoint'
    ).toBe(true);
  });

  test('13. envelope parity', async ({ profileClient, disposableToken }) => {
    /*
     * Throwaway identity: this sends a complete, valid change - correct current password, new
     * password - so it succeeds. Pointed at the shared session it was not a parity check at
     * all but a credential rotation the bench performed on itself once per run.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a credential change at the shared QA identity'
    );
    await assertStatusCodeParity(
      await profileClient.changePassword(buildChangePasswordPayload(), { token: disposableToken }),
      META
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


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/profile/changeOrForgotAccessCode
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/changeOrForgotAccessCode', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.changeOrForgotAccessCode,
    repro: `await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload(), { token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload(), {
      token: staticToken,
    });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload(), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.changeOrForgotAccessCode(payload, { token: null });`,
    });
  });

  test('3. expired/forged token: must be 401/403', async ({ profileClient }) => {
    for (const token of [EXPIRED_TOKEN, FORGED_ALG_NONE_JWT]) {
      const response = await profileClient.changeOrForgotAccessCode(
        buildChangeAccessCodePayload(),
        { token }
      );
      await assertUnauthorized(response, {
        ...META,
        repro: `await profileClient.changeOrForgotAccessCode(payload, { token: '<invalid>' });`,
      });
    }
  });

  test('4. a wrong current password must never allow the change', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.changeOrForgotAccessCode(
      buildChangeAccessCodePayload({ currentPassword: 'definitely-not-the-password' }),
      { token: authToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'the access code was changed without the correct current password'
    ).toBeFalsy();
  });

  test('5. missing access code must be rejected', async ({ profileClient, staticToken }) => {
    const payload = buildChangeAccessCodePayload();
    delete (payload as Record<string, unknown>).accessCode;

    const response = await profileClient.changeOrForgotAccessCode(payload, { token: staticToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'changeOrForgotAccessCode without an accessCode',
        repro: `const p = buildChangeAccessCodePayload(); delete p.accessCode; await profileClient.changeOrForgotAccessCode(p, { token });`,
      },
      [400, 401, 403, 422]
    );
  });

  test('6. null/empty access code must be rejected', async ({ profileClient, staticToken }) => {
    for (const value of [null, '', ' ']) {
      const response = await profileClient.changeOrForgotAccessCode(
        buildChangeAccessCodePayload({ accessCode: value }),
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `changeOrForgotAccessCode with accessCode=${JSON.stringify(value)}`,
          repro: `await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload({ accessCode: ${JSON.stringify(value)} }), { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('7. a trivially weak access code should be refused', async ({
    profileClient,
    staticToken,
  }) => {
    for (const accessCode of ['1', '0000', '000000', '123456']) {
      const response = await profileClient.changeOrForgotAccessCode(
        buildChangeAccessCodePayload({ accessCode }),
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `changeOrForgotAccessCode with the weak code "${accessCode}"`,
          repro: `await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload({ accessCode: '${accessCode}' }), { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('8. type mismatch does not cause a 5xx', async ({ profileClient, staticToken }) => {
    for (const value of [123456, ['123456'], {}]) {
      const response = await profileClient.changeOrForgotAccessCode(
        buildChangeAccessCodePayload({ accessCode: value }),
        { token: staticToken }
      );
      expect(
        response.status(),
        `accessCode=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('9. IDOR: a body-supplied kpostID must not change another account\'s code', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.changeOrForgotAccessCode(
      buildChangeAccessCodePayload({ kpostID: 'admin' }),
      { token: authToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      "a body-supplied kpostID changed another account's access code"
    ).toBeFalsy();
  });

  test('10. the access code is never echoed back', async ({ profileClient, staticToken }) => {
    const response = await profileClient.changeOrForgotAccessCode(
      buildChangeAccessCodePayload({ accessCode: '918273' }),
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(text, 'the submitted access code was echoed in the response').not.toContain('918273');
  });

  test('11. SQL injection does not leak internals', async ({ profileClient, staticToken }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.changeOrForgotAccessCode(
        buildChangeAccessCodePayload({ accessCode: payload }),
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload({ accessCode: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('12. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(
      await profileClient.changeOrForgotAccessCode(buildChangeAccessCodePayload(), {
        token: staticToken,
      }),
      META
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


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/profile/deactivateAccount — destructive; happy path is deliberately never run
 * against a real identity. Only refusal paths are exercised.
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/deactivateAccount', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deactivateAccount,
    repro: `await profileClient.deactivateAccount(buildDeactivateAccountPayload(), { token });`,
  };

  test('1. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.deactivateAccount(payload, { token: null });`,
    });
  });

  test('2. expired token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
      token: EXPIRED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.deactivateAccount(payload, { token: EXPIRED_TOKEN });`,
    });
  });

  test('3. malformed token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
      token: MALFORMED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.deactivateAccount(payload, { token: MALFORMED_TOKEN });`,
    });
  });

  test('4. an alg=none forged token must never deactivate an account', async ({
    profileClient,
  }) => {
    const response = await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
      token: FORGED_ALG_NONE_JWT,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.deactivateAccount(payload, { token: '<alg=none JWT>' });`,
    });
  });

  test('5. deactivation without an OTP must be refused', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    const response = await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
      token: disposableToken,
    });
    const { json, text } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      `an account was deactivated with no OTP confirmation — a stolen session could destroy the account outright. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('6. an invalid OTP must be refused', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    // Non-mock OTPs only: 000000/123456 are the developers' test-bench bypass (accepting them is
    // expected), so testing them here would false-fire. A NON-mock OTP completing a deactivation
    // is the real defect this asserts against.
    for (const otp of ['999999', '111111']) {
      const response = await profileClient.deactivateAccount(
        buildDeactivateAccountPayload({ otp }),
        { token: disposableToken }
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `deactivation succeeded with an unissued OTP "${otp}"`
      ).toBeFalsy();
    }
  });

  test('7. IDOR: a body-supplied kpostID must not deactivate another account', async ({
    profileClient,
    disposableToken,
  }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    const response = await profileClient.deactivateAccount(
      buildDeactivateAccountPayload({ kpostID: 'admin' }),
      { token: disposableToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a body-supplied kpostID deactivated another account — destructive IDOR'
    ).toBeFalsy();
  });

  test('8. a caller-supplied record id must not deactivate an arbitrary row', async ({
    profileClient,
    disposableToken,
  }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    const response = await profileClient.deactivateAccount(
      buildDeactivateAccountPayload({ id: 1 }),
      { token: disposableToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a caller-supplied row id was honoured on a destructive operation'
    ).toBeFalsy();
  });

  test('9. null/empty and type-mismatched payloads do not cause a 5xx', async ({
    profileClient,
    disposableToken,
  }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    for (const payload of [{}, { reason: null }, { reason: 12345 }, { id: 'not-a-number' }]) {
      const response = await profileClient.deactivateAccount(payload, { token: disposableToken });
      expect(
        response.status(),
        `payload ${JSON.stringify(payload)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('10. SQL injection does not leak internals', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.deactivateAccount(
        buildDeactivateAccountPayload({ reason: payload, kpostID: payload }),
        { token: disposableToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.deactivateAccount(buildDeactivateAccountPayload({ reason: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('11. malformed JSON is rejected cleanly', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    for (const body of MALFORMED_JSON_STRINGS.slice(0, 2)) {
      const response = await profileClient.postRawTo(PROFILE_PATHS.deactivateAccount, body, {
        token: disposableToken,
      });
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('12. envelope parity', async ({ profileClient, disposableToken }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    await assertStatusCodeParity(
      await profileClient.deactivateAccount(buildDeactivateAccountPayload(), {
        token: disposableToken,
      }),
      META
    );
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    disposableToken,
  }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: disposableToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });


  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    disposableToken,
  }) => {
    /*
     * Fired at a THROWAWAY account, never the shared QA identity.
     *
     * This block asserts that deactivation is refused. The whole point of the bench is to
     * find the case where it is not refused - and the first time that happens against the
     * shared identity, the account every other suite depends on is destroyed, and every run
     * afterwards reports "Invalid Credential", which reads as a wrong password.
     */
    test.skip(
      disposableToken === null,
      'no disposable account could be registered - refusing to aim a destructive call at the ' +
        'shared QA identity (see the signup suite for why registration failed)'
    );
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: disposableToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/profile/getUserProfileUsingKpostID — the primary IDOR / privacy surface.
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/getUserProfileUsingKpostID', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.getUserProfileUsingKpostID,
    repro: `await profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload(kpostID), { token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getUserProfileUsingKpostID(
      buildKpostIdLookupPayload('someuser'),
      { token: staticToken }
    );
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getUserProfileUsingKpostID(
      buildKpostIdLookupPayload('someuser'),
      { token: null }
    );
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getUserProfileUsingKpostID(payload, { token: null });`,
    });
  });

  test('3. expired/forged token: must be 401/403', async ({ profileClient }) => {
    for (const token of [EXPIRED_TOKEN, FORGED_ALG_NONE_JWT]) {
      const response = await profileClient.getUserProfileUsingKpostID(
        buildKpostIdLookupPayload('someuser'),
        { token }
      );
      await assertUnauthorized(response, {
        ...META,
        repro: `await profileClient.getUserProfileUsingKpostID(payload, { token: '<invalid>' });`,
      });
    }
  });

  test('4. privacy: a lookup must not return another user\'s private contact details', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const { text } = await readBody(
      await profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload('admin'), {
        token: authToken,
      })
    );

    expect(
      text,
      "another user's profile lookup exposed private contact fields (aadhaar/PAN/password) — privacy settings are not enforced"
    ).not.toMatch(/"(aadhaarNumber|panNumber|password|kmailPassword|accessCode)"\s*:\s*"[^"]+"/i);
  });

  test('5. missing kpostID must be rejected', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getUserProfileUsingKpostID({}, { token: staticToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'getUserProfileUsingKpostID with an empty body',
        repro: `await profileClient.getUserProfileUsingKpostID({}, { token });`,
      },
      [400, 401, 403, 422]
    );
  });

  test('6. null/empty kpostID must be rejected', async ({ profileClient, staticToken }) => {
    for (const value of [null, '', ' ']) {
      const response = await profileClient.getUserProfileUsingKpostID(
        { kpostID: value },
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `getUserProfileUsingKpostID with kpostID=${JSON.stringify(value)}`,
          repro: `await profileClient.getUserProfileUsingKpostID({ kpostID: ${JSON.stringify(value)} }, { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('7. type mismatch does not cause a 5xx', async ({ profileClient, staticToken }) => {
    for (const value of [12345, ['a'], {}]) {
      const response = await profileClient.getUserProfileUsingKpostID(
        { kpostID: value },
        { token: staticToken }
      );
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. a wildcard must not dump the whole directory', async ({
    profileClient,
    staticToken,
  }) => {
    for (const wildcard of ['%', '*', '_']) {
      const response = await profileClient.getUserProfileUsingKpostID(
        buildKpostIdLookupPayload(wildcard),
        { token: staticToken }
      );
      const { json } = await readBody(response);
      const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

      expect(
        rows.length,
        `a "${wildcard}" lookup returned ${rows.length} profiles — a wildcard is reaching the query unescaped and dumps the directory`
      ).toBeLessThan(50);
    }
  });

  test('9. SQL injection does not leak internals', async ({ profileClient, staticToken }) => {
    for (const payload of SQLI) {
      const response = await profileClient.getUserProfileUsingKpostID(
        buildKpostIdLookupPayload(payload),
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload(${JSON.stringify(payload)}), { token });`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ profileClient, staticToken }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await profileClient.getUserProfileUsingKpostID(
        buildKpostIdLookupPayload(payload),
        { token: staticToken }
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload(${JSON.stringify(payload)}), { token });`,
        },
        payload
      );
    }
  });

  test('11. enumeration: bulk lookups should be rate limited', async ({
    profileClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload(`probe${i}`), {
          token: staticToken,
        })
      )
    );

    expect(
      responses.some((r) => r.status() === 429),
      '15 rapid directory lookups were all served with no 429 — the user directory can be scraped'
    ).toBe(true);
  });

  test('12. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(
      await profileClient.getUserProfileUsingKpostID(buildKpostIdLookupPayload('someuser'), {
        token: staticToken,
      }),
      META
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


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * Directory search: advancedSearch and autoSearchWithName.
 * ===================================================================================== */
/* ========================================================================================
 * Directory search (advancedSearch, autoSearchWithName) is covered in
 * tests/profile/searchAndExperience.spec.ts, which is the canonical home for the search and
 * work-experience endpoints. The generic block that used to live here duplicated those
 * signatures exactly; the canonical file additionally asserts the enumeration and contact
 * field-projection rules that make a directory search a data-exposure surface rather than
 * just a query feature.
 * ===================================================================================== */

/* ========================================================================================
 * Profile image: POST updateProfileImage (multipart) and GET removeProfileImage.
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/updateProfileImage', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateProfileImage,
    repro: `await profileClient.updateProfileImage({ name: 'avatar.png', mimeType: 'image/png', buffer: pngFileBuffer() }, { token });`,
  };

  const pngFile = () => ({ name: 'avatar.png', mimeType: 'image/png', buffer: pngFileBuffer() });

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.updateProfileImage(pngFile(), { token: staticToken });
    await assertStatus(response, [200, 400, 401, 403, 415], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.updateProfileImage(pngFile(), { token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.updateProfileImage(file, { token: null });`,
    });
  });

  test('3. expired/forged token: must be 401/403', async ({ profileClient }) => {
    for (const token of [EXPIRED_TOKEN, FORGED_ALG_NONE_JWT]) {
      const response = await profileClient.updateProfileImage(pngFile(), { token });
      await assertUnauthorized(response, {
        ...META,
        repro: `await profileClient.updateProfileImage(file, { token: '<invalid>' });`,
      });
    }
  });

  test('4. a missing file must be rejected', async ({ profileClient, staticToken }) => {
    const response = await profileClient.updateProfileImageJson({}, { token: staticToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'updateProfileImage with no file part',
        repro: `await profileClient.updateProfileImageJson({}, { token });`,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('5. an executable disguised as an image must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateProfileImage(
      {
        name: 'payload.png',
        mimeType: 'image/png',
        // PE executable magic bytes wearing a .png name and image/png content type.
        buffer: Buffer.from('4d5a90000300000004000000ffff0000', 'hex'),
      },
      { token: staticToken }
    );
    const { json, text } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      `an executable payload was accepted as a profile image — content type is trusted without inspecting the bytes. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('6. an HTML/SVG payload must not be stored as an image', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateProfileImage(
      {
        name: 'xss.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      },
      { token: staticToken }
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a scriptable SVG was accepted as a profile image — stored XSS for anyone viewing the avatar'
    ).toBeFalsy();
  });

  test('7. a path-traversal filename must not be honoured', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateProfileImage(
      {
        name: '../../../../etc/passwd.png',
        mimeType: 'image/png',
        buffer: pngFileBuffer(),
      },
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(
      text,
      'the traversal filename was echoed back unsanitised — files may be written outside the upload directory'
    ).not.toContain('../../../../etc/passwd');
  });

  test('8. an oversized upload must be refused, not accepted or 5xx', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateProfileImage(
      { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(12 * 1024 * 1024, 1) },
      { token: staticToken }
    );

    expect(
      response.status(),
      'a 12MB upload caused a server error instead of a clean size-limit rejection'
    ).toBeLessThan(500);
  });

  test('9. a zero-byte file must be rejected', async ({ profileClient, staticToken }) => {
    const response = await profileClient.updateProfileImage(
      { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
      { token: staticToken }
    );
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'updateProfileImage with a zero-byte file',
        repro: `await profileClient.updateProfileImage({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, { token });`,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('10. SQL injection in the filename does not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.updateProfileImage(
        { name: `${payload}.png`, mimeType: 'image/png', buffer: pngFileBuffer() },
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.updateProfileImage({ name: ${JSON.stringify(`${payload}.png`)}, ... }, { token });`,
        },
        payload
      );
    }
  });

  test('11. concurrent uploads behave consistently', async ({ profileClient, staticToken }) => {
    const responses = await Promise.all([
      profileClient.updateProfileImage(pngFile(), { token: staticToken }),
      profileClient.updateProfileImage(pngFile(), { token: staticToken }),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent identical uploads returned different statuses'
    ).toBe(1);
  });

  test('12. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(
      await profileClient.updateProfileImage(pngFile(), { token: staticToken }),
      META
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


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

test.describe('Profile - GET /v2/profile/removeProfileImage', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.removeProfileImage,
    repro: `await profileClient.removeProfileImage({ token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.removeProfileImage({ token: staticToken });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.removeProfileImage({ token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.removeProfileImage({ token: null });`,
    });
  });

  test('3. expired token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.removeProfileImage({ token: EXPIRED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.removeProfileImage({ token: EXPIRED_TOKEN });`,
    });
  });

  test('4. malformed token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.removeProfileImage({ token: MALFORMED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.removeProfileImage({ token: MALFORMED_TOKEN });`,
    });
  });

  test('5. an alg=none forged token must not delete an image', async ({ profileClient }) => {
    const response = await profileClient.removeProfileImage({ token: FORGED_ALG_NONE_JWT });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.removeProfileImage({ token: '<alg=none JWT>' });`,
    });
  });

  test('6. IDOR: a query-supplied kpostID must not delete another user\'s image', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.removeProfileImage({
      token: authToken,
      params: { kpostID: 'admin' },
    });
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      "a query-supplied kpostID deleted another user's profile image — destructive IDOR"
    ).toBeFalsy();
  });

  test('7. idempotency: repeated removal is safe', async ({ profileClient, staticToken }) => {
    const responses = await Promise.all([
      profileClient.removeProfileImage({ token: staticToken }),
      profileClient.removeProfileImage({ token: staticToken }),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent removals returned different statuses — the operation is not idempotent'
    ).toBe(1);
  });

  test('8. unexpected query params do not cause a 5xx', async ({ profileClient, staticToken }) => {
    const response = await profileClient.removeProfileImage({
      token: staticToken,
      params: { all: true, id: -1 },
    });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('9. SQL injection in query params does not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.removeProfileImage({
        token: staticToken,
        params: { kpostID: payload },
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.removeProfileImage({ token, params: { kpostID: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('10. XSS payload in query params is not reflected', async ({
    profileClient,
    staticToken,
  }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await profileClient.removeProfileImage({
        token: staticToken,
        params: { cb: payload },
      });
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await profileClient.removeProfileImage({ token, params: { cb: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(
      await profileClient.removeProfileImage({ token: staticToken }),
      META
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
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });


  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('GET', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/profile/getDigitalCard
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/getDigitalCard', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.getDigitalCard,
    repro: `await profileClient.getDigitalCard(buildDigitalCardPayload(contactID), { token });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getDigitalCard(buildDigitalCardPayload('contact-1'), {
      token: staticToken,
    });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getDigitalCard(buildDigitalCardPayload('contact-1'), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await profileClient.getDigitalCard(payload, { token: null });`,
    });
  });

  test('3. expired/forged token: must be 401/403', async ({ profileClient }) => {
    for (const token of [EXPIRED_TOKEN, FORGED_ALG_NONE_JWT]) {
      const response = await profileClient.getDigitalCard(buildDigitalCardPayload('contact-1'), {
        token,
      });
      await assertUnauthorized(response, {
        ...META,
        repro: `await profileClient.getDigitalCard(payload, { token: '<invalid>' });`,
      });
    }
  });

  test('4. IDOR: cards must only be returned for the caller\'s own contacts', async ({
    profileClient,
    authToken,
    requireAuthToken,
  }) => {
    requireAuthToken();
    const response = await profileClient.getDigitalCard(
      buildDigitalCardPayload('contact-1', { kpostID: 'admin' }),
      { token: authToken }
    );
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `digital cards were returned for a body-supplied kpostID ("admin") — another user's contact book is exposed. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('5. missing contactID must be rejected', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getDigitalCard({}, { token: staticToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'getDigitalCard with an empty body',
        repro: `await profileClient.getDigitalCard({}, { token });`,
      },
      [400, 401, 403, 422]
    );
  });

  test('6. null/empty contactID must be rejected', async ({ profileClient, staticToken }) => {
    for (const value of [null, '', ' ']) {
      const response = await profileClient.getDigitalCard(
        { contactID: value },
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `getDigitalCard with contactID=${JSON.stringify(value)}`,
          repro: `await profileClient.getDigitalCard({ contactID: ${JSON.stringify(value)} }, { token });`,
        },
        [400, 401, 403, 422]
      );
    }
  });

  test('7. type mismatch does not cause a 5xx', async ({ profileClient, staticToken }) => {
    for (const value of [12345, ['a'], {}]) {
      const response = await profileClient.getDigitalCard(
        { contactID: value },
        { token: staticToken }
      );
      expect(
        response.status(),
        `contactID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. a wildcard must not dump every card', async ({ profileClient, staticToken }) => {
    const response = await profileClient.getDigitalCard(buildDigitalCardPayload('%'), {
      token: staticToken,
    });
    const { json } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `a "%" contactID returned ${rows.length} cards — a wildcard is reaching the query unescaped`
    ).toBeLessThan(50);
  });

  test('9. SQL injection does not leak internals', async ({ profileClient, staticToken }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await profileClient.getDigitalCard(buildDigitalCardPayload(payload), {
        token: staticToken,
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.getDigitalCard(buildDigitalCardPayload(${JSON.stringify(payload)}), { token });`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ profileClient, staticToken }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await profileClient.getDigitalCard(buildDigitalCardPayload(payload), {
        token: staticToken,
      });
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await profileClient.getDigitalCard(buildDigitalCardPayload(${JSON.stringify(payload)}), { token });`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ profileClient, staticToken }) => {
    await assertStatusCodeParity(
      await profileClient.getDigitalCard(buildDigitalCardPayload('contact-1'), {
        token: staticToken,
      }),
      META
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


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/profile/shareUserDetails — public (security: []), a public profile link.
 * ===================================================================================== */
test.describe('Profile - POST /v2/profile/shareUserDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.shareUserDetails,
    repro: `await profileClient.shareUserDetails({ kpostID });`,
  };

  test('1. baseline returns a documented status', async ({ profileClient }) => {
    const response = await profileClient.shareUserDetails({ kpostID: 'someuser' });
    await assertStatus(response, [200, 400], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('2. public endpoint: must not be gated behind a token', async ({ profileClient }) => {
    // security: [] — a public profile share link is opened by people with no KPost account,
    // so a token gate turns every shared link into a 401 for its intended audience.
    const response = await profileClient.shareUserDetails(
      { kpostID: 'someuser' },
      { token: null }
    );
    await assertPublicRouteReachable(response, {
      ...META,
      body: { kpostID: 'someuser' },
      repro: `await profileClient.shareUserDetails({ kpostID: 'someuser' }, { token: null });`,
    });
  });

  test('3. a public share link must not expose private identity fields', async ({
    profileClient,
  }) => {
    const { text } = await readBody(
      await profileClient.shareUserDetails({ kpostID: 'admin' }, { token: null })
    );

    expect(
      text,
      'the public share endpoint exposed private identity fields (aadhaar/PAN/password) to an unauthenticated caller'
    ).not.toMatch(/"(aadhaarNumber|panNumber|password|kmailPassword|accessCode)"\s*:\s*"[^"]+"/i);
  });

  test('4. missing identifier must be rejected', async ({ profileClient }) => {
    const response = await profileClient.shareUserDetails({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'shareUserDetails with an empty body',
      repro: `await profileClient.shareUserDetails({});`,
    });
  });

  test('5. null/empty identifier must be rejected', async ({ profileClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await profileClient.shareUserDetails({ kpostID: value });
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `shareUserDetails with kpostID=${JSON.stringify(value)}`,
        repro: `await profileClient.shareUserDetails({ kpostID: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('6. type mismatch does not cause a 5xx', async ({ profileClient }) => {
    for (const value of [12345, ['a'], {}]) {
      const response = await profileClient.shareUserDetails({ kpostID: value });
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. a wildcard must not dump the directory to the public', async ({ profileClient }) => {
    for (const wildcard of ['%', '*']) {
      const response = await profileClient.shareUserDetails({ kpostID: wildcard });
      const { json } = await readBody(response);
      const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

      expect(
        rows.length,
        `a "${wildcard}" share lookup returned ${rows.length} profiles to an unauthenticated caller`
      ).toBeLessThan(50);
    }
  });

  test('8. SQL injection does not leak internals', async ({ profileClient }) => {
    for (const payload of SQLI) {
      const response = await profileClient.shareUserDetails({ kpostID: payload });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await profileClient.shareUserDetails({ kpostID: ${JSON.stringify(payload)} });`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ profileClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await profileClient.shareUserDetails({ kpostID: payload });
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await profileClient.shareUserDetails({ kpostID: ${JSON.stringify(payload)} });`,
        },
        payload
      );
    }
  });

  test('10. enumeration: unauthenticated bulk lookups should be rate limited', async ({
    profileClient,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, i) => profileClient.shareUserDetails({ kpostID: `probe${i}` }))
    );

    expect(
      responses.some((r) => r.status() === 429),
      '15 rapid unauthenticated share lookups were all served with no 429 — the directory can be scraped without an account'
    ).toBe(true);
  });

  test('11. malformed JSON is rejected cleanly', async ({ profileClient }) => {
    for (const body of MALFORMED_JSON_STRINGS.slice(0, 2)) {
      const response = await profileClient.postRawTo(PROFILE_PATHS.shareUserDetails, body);
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('12. envelope parity', async ({ profileClient }) => {
    await assertStatusCodeParity(
      await profileClient.shareUserDetails({ kpostID: 'someuser' }),
      META
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
