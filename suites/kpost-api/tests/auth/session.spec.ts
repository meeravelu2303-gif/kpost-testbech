/**
 * Auth V2 — login & session lifecycle: login, token refresh (generateJWTokens), logout (single + all devices), active session, login history, user-detail reads.
 *
 * Per swagger, the pre-token entry points here are public (security: []) and are called
 * without a token; the session-management endpoints require a bearer token and assert 401/403 when absent.
 */

import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { AUTH_PATHS } from '../../src/api/clients/auth.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import { userLoginResponseSchema } from '../../src/api/schemas/auth.schema';
import { looseEnvelopeSchema, dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
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
  reportBusinessLogicFlaw,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { MALFORMED_JSON_STRINGS, SQLI, XSS } from '../../src/utils/fuzzData';
import {
  buildFetchUserDetailsPayload,
  buildGenerateJWTokensPayload,
  buildGetLoginHistoryPayload,
  buildLoginPayload,
  buildLogoutPayload,
  randomKpostId,
} from '../../src/api/payloads/auth.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

test.describe.configure({ timeout: 90_000 });

test.describe('Auth - POST /v2/signupLogin/userLogin @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.userLogin,
    repro: `await authClient.userLogin(buildLoginPayload(kpostID, password), { token: null });`,
  };

  test('[FR-S09][NFR-R01][public] login must stay reachable without a token — no one holds one yet', async ({
    authClient,
  }) => {
    // security: [] in swagger. A token gate here is a total login blockade: a returning user
    // has no bearer until this very call succeeds, so a 401/403 locks everyone out.
    const response = await authClient.userLogin(
      buildLoginPayload(randomKpostId(), 'Qa@Passw0rd123'),
      { token: null }
    );
    await assertPublicRouteReachable(response, { ...META, severity: 'Critical', body: 'buildLoginPayload()' });
  });

  test('1. baseline: response conforms to the documented login envelope', async ({
    authClient,
  }) => {
    const response = await authClient.userLogin(buildLoginPayload(randomKpostId(), 'Qa@Passw0rd123'));
    const { json } = await readBody(response);
    if (json) validateSchema(json, userLoginResponseSchema, META);
  });

  test('2. envelope parity: a login failure must not be served as HTTP 200', async ({
    authClient,
  }) => {
    const response = await authClient.userLogin(buildLoginPayload(randomKpostId(), 'Qa@Passw0rd123'));
    await assertStatusCodeParity(response, META);
  });

  test('3. missing credentials: an empty body must be a 400/422', async ({ authClient }) => {
    const response = await authClient.userLogin({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'login with an empty body',
      repro: `await authClient.userLogin({});`,
    });
  });

  test('4. missing required password inside loginRO', async ({ authClient }) => {
    const payload = buildLoginPayload(randomKpostId(), 'Qa@Passw0rd123');
    delete (payload.loginRO as Record<string, unknown>).password;

    const response = await authClient.userLogin(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'login without loginRO.password',
      repro: `const p = buildLoginPayload(id, pwd); delete p.loginRO.password; await authClient.userLogin(p);`,
    });
  });

  test('5. null/empty credential fuzzing', async ({ authClient }) => {
    for (const value of [null, '', {}]) {
      const response = await authClient.userLogin({
        kpostID: randomKpostId(),
        loginRO: { password: value },
      });
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `login with password=${JSON.stringify(value)}`,
        repro: `await authClient.userLogin({ kpostID, loginRO: { password: ${JSON.stringify(value)} } });`,
      });
    }
  });

  test('6. type mismatch: loginRO sent as an array instead of an object', async ({ authClient }) => {
    const response = await authClient.userLogin({ kpostID: randomKpostId(), loginRO: [] });
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'login with loginRO as an array',
      repro: `await authClient.userLogin({ kpostID, loginRO: [] });`,
    });
  });

  test('7. malformed JSON is rejected as 400', async ({ authClient }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await authClient.userLoginRaw(body);
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `login with malformed JSON ${JSON.stringify(body)}`,
        repro: `await authClient.userLoginRaw(${JSON.stringify(body)});`,
      });
    }
  });

  test('8. unknown account must not be distinguishable from a wrong password', async ({
    authClient,
  }) => {
    const unknown = await authClient.userLogin(
      buildLoginPayload(randomKpostId(), 'Qa@Passw0rd123')
    );
    const wrongPassword = await authClient.userLogin(
      buildLoginPayload(randomKpostId(), 'definitely-wrong-password')
    );

    const a = await readBody(unknown);
    const b = await readBody(wrongPassword);
    const messageOf = (body: typeof a) =>
      body.json && typeof body.json.message === 'string' ? body.json.message : body.text.slice(0, 80);

    expect(
      messageOf(a),
      'login distinguishes "no such user" from "wrong password", enabling account enumeration'
    ).toBe(messageOf(b));
  });

  test('9. no credential material is echoed back to the caller', async ({ authClient }) => {
    const password = 'Qa@Sup3rSecret!';
    const response = await authClient.userLogin(buildLoginPayload(randomKpostId(), password));
    const { text } = await readBody(response);

    expect(text, 'the submitted password was echoed in the login response').not.toContain(password);
  });

  test('10. SQL injection in kpostID does not leak database internals', async ({ authClient }) => {
    for (const payload of SQLI) {
      const response = await authClient.userLogin(buildLoginPayload(payload, 'Qa@Passw0rd123'));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.userLogin(buildLoginPayload(${JSON.stringify(payload)}, 'Qa@Passw0rd123'));`,
        },
        payload
      );
    }
  });

  test('11. SQL injection must never authenticate the caller', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.userLogin(buildLoginPayload(payload, `' OR '1'='1`));
      const { json } = await readBody(response);
      const token = json?.accessToken;

      expect(
        token,
        `SQL injection payload "${payload}" produced an access token — authentication bypass`
      ).toBeFalsy();
    }
  });

  test('12. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await authClient.userLogin(buildLoginPayload(payload, 'Qa@Passw0rd123'));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.userLogin(buildLoginPayload(${JSON.stringify(payload)}, 'Qa@Passw0rd123'));`,
        },
        payload
      );
    }
  });

  test('13. boundary: oversized credentials are rejected without a 5xx', async ({ authClient }) => {
    const response = await authClient.userLogin(
      buildLoginPayload('a'.repeat(5000), 'b'.repeat(5000))
    );
    expect(response.status(), 'oversized credentials caused a server error').toBeLessThan(500);
  });

  test('14. brute force: repeated failed logins should be throttled', async ({ authClient }) => {
    const kpostID = randomKpostId();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => authClient.userLogin(buildLoginPayload(kpostID, 'wrong-password')))
    );

    const throttled = responses.some((r) => r.status() === 429);
    expect(
      throttled,
      '10 rapid failed logins were all processed with no 429 — no brute-force protection is evident on this endpoint'
    ).toBe(true);
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

  test('[FR-S10][business rule] a rejected login must not reveal whether the id or the password was wrong', async ({
    authClient,
    authSession,
  }) => {
    // FSD 2.3: a failed login returns a clear error without revealing whether the username or the
    // password was the problem — the standard anti-enumeration precaution.
    const knownId = authSession.kpostID ?? 'meeravelu23@kpostindia.com';
    const wrongPassword = await authClient.userLogin(buildLoginPayload(knownId, 'DefinitelyWrong!123'));
    const unknownAccount = await authClient.userLogin(
      buildLoginPayload(`qa-does-not-exist-${Date.now()}@kpostindia.com`, 'DefinitelyWrong!123')
    );
    const a = await readBody(wrongPassword);
    const b = await readBody(unknownAccount);
    const msgA = a.json && typeof a.json.message === 'string' ? a.json.message : a.text;
    const msgB = b.json && typeof b.json.message === 'string' ? b.json.message : b.text;
    const distinguishable = msgA !== msgB;

    if (distinguishable) {
      await reportBusinessLogicFlaw(
        unknownAccount,
        {
          ...META,
          title: 'Login error distinguishes an unknown account from a wrong password (account enumeration)',
          scenario:
            'FSD 2.3 requires a rejected login to be indistinguishable between "no such account" and "wrong password". ' +
            `A wrong password for an existing account answered "${msgA}" while an unknown account answered "${msgB}" — ` +
            'the difference lets an attacker enumerate which identifiers are registered.',
        },
        'Security/Information Disclosure',
        'Major'
      );
    }

    expect(
      distinguishable,
      'a wrong password and an unknown account must return the same login error (anti-enumeration, FSD 2.3)'
    ).toBe(false);
  });

});

/* ========================================================================================
 * POST /v2/signupLogin/userLogout — secured
 *
 * NOTE ON TOKENS IN THIS BLOCK: every case that needs a live session uses `revocableToken`,
 * a second login on a throwaway `deviceIdentity_primary`, never the run's shared session.
 * Revocation tests are the one place where using the shared token is actively destructive.
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/userLogout @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.userLogout,
    repro: `await authClient.userLogout(buildLogoutPayload(kpostID), { token });`,
  };

  test('[FR-S12] 1. baseline: a logout attempt returns a documented status', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogout(buildLogoutPayload(randomKpostId()), {
      token: revocableToken,
    });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogout(buildLogoutPayload(randomKpostId()), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogout(buildLogoutPayload(kpostID), { token: null });`,
    });
  });

  test('3. expired token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogout(buildLogoutPayload(randomKpostId()), {
      token: EXPIRED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogout(buildLogoutPayload(kpostID), { token: EXPIRED_TOKEN });`,
    });
  });

  test('4. malformed token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogout(buildLogoutPayload(randomKpostId()), {
      token: MALFORMED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogout(buildLogoutPayload(kpostID), { token: MALFORMED_TOKEN });`,
    });
  });

  test('5. IDOR: must not end another user\'s session', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const victimKpostId = randomKpostId();
    const response = await authClient.userLogout(buildLogoutPayload(victimKpostId), {
      token: revocableToken,
    });

    expect(
      response.status(),
      `logging out an arbitrary kpostID (${victimKpostId}) succeeded — session termination is not scoped to the token identity`
    ).not.toBe(200);
  });

  test('6. empty body without a token is still an auth failure, not a 400', async ({
    authClient,
  }) => {
    const response = await authClient.userLogout({}, { token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogout({}, { token: null });`,
    });
  });

  test('7. null/empty kpostID fuzzing', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    for (const value of [null, '', {}]) {
      const response = await authClient.userLogout(
        { kpostID: value, deviceType: 'WEB' },
        { token: revocableToken }
      );
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. type mismatch: module as a string', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogout(
      buildLogoutPayload(randomKpostId(), { module: 'not-a-number' }),
      { token: revocableToken }
    );
    expect(response.status(), 'module type mismatch caused a server error').toBeLessThan(500);
  });

  test('9. SQL injection in kpostID does not leak internals', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.userLogout(buildLogoutPayload(payload), {
        token: revocableToken,
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.userLogout(buildLogoutPayload(${JSON.stringify(payload)}), { token });`,
        },
        payload
      );
    }
  });

  test('10. idempotency: a duplicate logout must not fail differently', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const payload = buildLogoutPayload(randomKpostId());
    const [first, second] = await Promise.all([
      authClient.userLogout(payload, { token: revocableToken }),
      authClient.userLogout(payload, { token: revocableToken }),
    ]);

    expect(
      Math.abs(first.status() - second.status()),
      'concurrent duplicate logouts produced divergent statuses — logout is not idempotent'
    ).toBeLessThanOrEqual(100);
  });

  test('11. envelope parity on the logout response', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogout(buildLogoutPayload(randomKpostId()), {
      token: revocableToken,
    });
    await assertStatusCodeParity(response, META);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: revocableToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
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
      token: revocableToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: revocableToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* ========================================================================================
 * POST /v2/signupLogin/setAccessCode — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/getLoginHistory @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.getLoginHistory,
    repro: `await authClient.getLoginHistory(buildGetLoginHistoryPayload(), { token });`,
  };

  test('1. baseline returns a documented status', async ({ authClient, staticToken }) => {
    const response = await authClient.getLoginHistory(buildGetLoginHistoryPayload(), {
      token: staticToken,
    });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.getLoginHistory(buildGetLoginHistoryPayload(), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getLoginHistory(buildGetLoginHistoryPayload(), { token: null });`,
    });
  });

  test('3. expired token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.getLoginHistory(buildGetLoginHistoryPayload(), {
      token: EXPIRED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getLoginHistory(buildGetLoginHistoryPayload(), { token: EXPIRED_TOKEN });`,
    });
  });

  test('4. malformed token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.getLoginHistory(buildGetLoginHistoryPayload(), {
      token: MALFORMED_TOKEN,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getLoginHistory(buildGetLoginHistoryPayload(), { token: MALFORMED_TOKEN });`,
    });
  });

  test('5. missing selectedDate must not produce a 5xx', async ({ authClient, staticToken }) => {
    /*
     * Asserts the absence of a server fault, NOT rejection — and that distinction was bought
     * with a false Critical.
     *
     * This previously called `assertRejectsInvalidInput` and demanded 400/401/403/422. Omitting
     * `selectedDate` is not invalid input on this route: the request schema declares no required
     * fields (a free-form object), and the spec states plainly that "omitting the key entirely
     * passes null through to the service". A 200 is the documented contract, so the assertion
     * was contradicting the specification it exists to enforce.
     *
     * The grading made it worse. `assertRejectsInvalidInput` reads an accepted 2xx as invalid
     * data persisted, which is how this reached P0 — on an endpoint the spec describes as
     * "Side effects. None - read-only", whose identity comes from the token, and which returned
     * the caller their own sessions. Nothing was written and nothing was exposed.
     *
     * What is genuinely worth guarding here is the 500. The spec's own QA notes record that a
     * non-string `selectedDate` raises a ClassCastException surfaced as a generic 500, and that
     * `userSessionList.isEmpty()` is called with no null check — so a null date reaching the
     * service is precisely the path that could fault. That is what this now watches, and case 6
     * below covers the type-mismatch variants.
     */
    const response = await authClient.getLoginHistory({}, { token: staticToken });
    await assertStatus(response, [200, 400, 401, 403, 404, 422], {
      ...META,
      body: {},
      title: 'A login-history request with no selectedDate produces a server fault',
      repro: `await authClient.getLoginHistory({}, { token });`,
    });
  });

  test('6. invalid date formats are rejected cleanly', async ({ authClient, staticToken }) => {
    for (const value of ['not-a-date', '2026-13-45', 12345, null, []]) {
      const response = await authClient.getLoginHistory(
        { selectedDate: value },
        { token: staticToken }
      );
      expect(
        response.status(),
        `selectedDate=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. IDOR: history must be scoped to the token identity, not a body-supplied id', async ({
    authClient,
    staticToken,
  }) => {
    const response = await authClient.getLoginHistory(
      buildGetLoginHistoryPayload({ kpostID: 'admin' }),
      { token: staticToken }
    );
    const { json, text } = await readBody(response);
    const returnedData = json?.data;
    const hasData = Array.isArray(returnedData) && returnedData.length > 0;

    expect(
      hasData,
      `login history was returned for a body-supplied kpostID ("admin") — history is not scoped to the authenticated identity. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('8. future dates return an empty result, not an error', async ({
    authClient,
    staticToken,
  }) => {
    const response = await authClient.getLoginHistory(
      buildGetLoginHistoryPayload({ selectedDate: '2099-12-31' }),
      { token: staticToken }
    );
    expect(response.status(), 'a future date caused a server error').toBeLessThan(500);
  });

  test('9. SQL injection in selectedDate does not leak internals', async ({
    authClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.getLoginHistory(
        { selectedDate: payload },
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.getLoginHistory({ selectedDate: ${JSON.stringify(payload)} }, { token });`,
        },
        payload
      );
    }
  });

  test('10. concurrent reads are consistent', async ({ authClient, staticToken }) => {
    const payload = buildGetLoginHistoryPayload();
    const responses = await Promise.all([
      authClient.getLoginHistory(payload, { token: staticToken }),
      authClient.getLoginHistory(payload, { token: staticToken }),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent identical history reads returned different statuses'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient, staticToken }) => {
    const response = await authClient.getLoginHistory(buildGetLoginHistoryPayload(), {
      token: staticToken,
    });
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
 * POST /v2/signupLogin/generateJWTokens — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/generateJWTokens @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.generateJWTokens,
    repro: `await authClient.generateJWTokens(buildGenerateJWTokensPayload(kpostID, refreshToken), { token: null });`,
  };

  test('[public] token refresh must stay reachable without a bearer token', async ({ authClient }) => {
    // security: [] — refresh runs off the refresh token in the body, not a bearer header. A
    // bearer gate here means an expired session can never be renewed and every user is forced
    // back to a full login.
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload(randomKpostId(), EXPIRED_TOKEN),
      { token: null }
    );
    await assertPublicRouteReachable(response, { ...META, body: 'buildGenerateJWTokensPayload()' });
  });

  test('1. baseline refresh attempt returns a documented status', async ({ authClient }) => {
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload(randomKpostId(), EXPIRED_TOKEN)
    );
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. an invalid refresh token must never mint an access token', async ({ authClient }) => {
    for (const token of [MALFORMED_TOKEN, EXPIRED_TOKEN, 'null', '']) {
      const response = await authClient.generateJWTokens(
        buildGenerateJWTokensPayload(randomKpostId(), token)
      );
      const { json } = await readBody(response);

      expect(
        json?.accessToken,
        `refresh token ${JSON.stringify(token.slice(0, 20))} produced an access token — token forgery`
      ).toBeFalsy();
    }
  });

  test('3. missing refreshToken must be rejected', async ({ authClient }) => {
    const response = await authClient.generateJWTokens({ kpostID: randomKpostId() });
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'generateJWTokens without a refreshToken',
      repro: `await authClient.generateJWTokens({ kpostID });`,
    });
  });

  test('4. null/empty token fuzzing', async ({ authClient }) => {
    for (const value of [null, '', {}]) {
      const response = await authClient.generateJWTokens({
        kpostID: randomKpostId(),
        refreshToken: value,
      });
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `generateJWTokens with refreshToken=${JSON.stringify(value)}`,
        repro: `await authClient.generateJWTokens({ kpostID, refreshToken: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('5. type mismatch: refreshToken as an array/number', async ({ authClient }) => {
    for (const value of [12345, ['token'], { token: 'x' }]) {
      const response = await authClient.generateJWTokens({
        kpostID: randomKpostId(),
        refreshToken: value,
      });
      expect(
        response.status(),
        `refreshToken=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. an algorithm-none forged JWT must be refused', async ({ authClient }) => {
    // {"alg":"none","typ":"JWT"}.{"sub":"admin","deviceID":"x"} with an empty signature.
    const forged =
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload('admin', forged)
    );
    const { json } = await readBody(response);

    expect(
      json?.accessToken,
      'an alg=none forged JWT was accepted and exchanged for an access token — critical authentication bypass'
    ).toBeFalsy();
  });

  test('7. a refresh token must not be exchangeable for a different kpostID', async ({
    authClient,
  }) => {
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload('admin', EXPIRED_TOKEN)
    );
    const { json } = await readBody(response);

    expect(
      json?.accessToken,
      'a token was issued for a caller-specified kpostID — cross-account token minting'
    ).toBeFalsy();
  });

  test('8. no credential material is echoed back', async ({ authClient }) => {
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload(randomKpostId(), EXPIRED_TOKEN, { password: 'Qa@Secret123' })
    );
    const { text } = await readBody(response);

    expect(text, 'the submitted password was echoed in the refresh response').not.toContain(
      'Qa@Secret123'
    );
  });

  test('9. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.generateJWTokens(
        buildGenerateJWTokensPayload(payload, EXPIRED_TOKEN)
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.generateJWTokens(buildGenerateJWTokensPayload(${JSON.stringify(payload)}, EXPIRED_TOKEN));`,
        },
        payload
      );
    }
  });

  test('10. replay: the same refresh token used concurrently must not mint two tokens', async ({
    authClient,
  }) => {
    const payload = buildGenerateJWTokensPayload(randomKpostId(), EXPIRED_TOKEN);
    const responses = await Promise.all([
      authClient.generateJWTokens(payload),
      authClient.generateJWTokens(payload),
    ]);
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const issued = bodies.filter((b) => Boolean(b.json?.accessToken));

    expect(
      issued.length,
      'a single refresh token was concurrently exchanged for multiple access tokens — replay is possible'
    ).toBeLessThanOrEqual(1);
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload(randomKpostId(), EXPIRED_TOKEN)
    );
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
 * POST /v2/signupLogin/fetchUserDetails — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/fetchUserDetails @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.fetchUserDetails,
    repro: `await authClient.fetchUserDetails(buildFetchUserDetailsPayload(kpostID));`,
  };

  test('1. baseline returns a documented status', async ({ authClient }) => {
    const response = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload(randomKpostId())
    );
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: oversized kpostID', async ({ authClient }) => {
    const response = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload('a'.repeat(2000))
    );
    expect(response.status(), 'oversized kpostID caused a server error').toBeLessThan(500);
  });

  test('3. missing kpostID must be rejected', async ({ authClient }) => {
    const response = await authClient.fetchUserDetails({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'fetchUserDetails with an empty body',
      repro: `await authClient.fetchUserDetails({});`,
    });
  });

  test('4. null/empty kpostID must be rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.fetchUserDetails({ kpostID: value });
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `fetchUserDetails with kpostID=${JSON.stringify(value)}`,
        repro: `await authClient.fetchUserDetails({ kpostID: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ authClient }) => {
    for (const value of [12345, ['a'], { a: 1 }]) {
      const response = await authClient.fetchUserDetails({ kpostID: value });
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. PII exposure: an unauthenticated lookup must not return contact details', async ({
    authClient,
  }) => {
    const response = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload('admin'),
      { token: null }
    );
    const { text } = await readBody(response);

    expect(
      text,
      'an unauthenticated caller received a mobile number from fetchUserDetails — PII disclosure'
    ).not.toMatch(/"mobileNumber"\s*:\s*"\d{6,}"/);
  });

  test('7. enumeration: unknown users must not be distinguishable by status code', async ({
    authClient,
  }) => {
    const unknownA = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload(`missing-${Date.now()}a`)
    );
    const unknownB = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload(`missing-${Date.now()}b`)
    );

    const scenario = `unknown-user lookups are not answered consistently: two ids that both do not exist returned HTTP ${unknownA.status()} and HTTP ${unknownB.status()}. A caller can tell one absent account from another by the status alone, which is the signal account enumeration needs.`;

    if (unknownA.status() !== unknownB.status()) {
      await reportBusinessLogicFlaw(
        unknownA,
        {
          ...META,
          title: 'Unknown-user lookups are distinguishable by status code',
          scenario,
        },
        'Security/Information Disclosure',
        'Major'
      );
    }

    expect(unknownA.status(), scenario).toBe(unknownB.status());
  });

  test('8. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI) {
      const response = await authClient.fetchUserDetails(buildFetchUserDetailsPayload(payload));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.fetchUserDetails(buildFetchUserDetailsPayload(${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await authClient.fetchUserDetails(buildFetchUserDetailsPayload(payload));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.fetchUserDetails(buildFetchUserDetailsPayload(${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('10. concurrent identical lookups are consistent', async ({ authClient }) => {
    const payload = buildFetchUserDetailsPayload(randomKpostId());
    const bodies = await Promise.all(
      (
        await Promise.all([
          authClient.fetchUserDetails(payload),
          authClient.fetchUserDetails(payload),
        ])
      ).map((r) => readBody(r))
    );

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'concurrent identical lookups returned different bodies'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.fetchUserDetails(
      buildFetchUserDetailsPayload(randomKpostId())
    );
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
 * POST /v2/signupLogin/fetchPersonalUserDetails — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/fetchPersonalUserDetails @audit', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.fetchPersonalUserDetails,
    repro: `await authClient.fetchPersonalUserDetails({ kpostID });`,
  };

  test('1. baseline returns a documented status', async ({ authClient }) => {
    const response = await authClient.fetchPersonalUserDetails({ kpostID: randomKpostId() });
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: oversized identifier', async ({ authClient }) => {
    const response = await authClient.fetchPersonalUserDetails({ kpostID: 'a'.repeat(2000) });
    expect(response.status(), 'oversized kpostID caused a server error').toBeLessThan(500);
  });

  test('3. empty body must be rejected', async ({ authClient }) => {
    const response = await authClient.fetchPersonalUserDetails({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'fetchPersonalUserDetails with an empty body',
      repro: `await authClient.fetchPersonalUserDetails({});`,
    });
  });

  test('4. null/empty identifier must be rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.fetchPersonalUserDetails({ kpostID: value });
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `fetchPersonalUserDetails with kpostID=${JSON.stringify(value)}`,
        repro: `await authClient.fetchPersonalUserDetails({ kpostID: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ authClient }) => {
    for (const value of [12345, ['a'], { a: 1 }]) {
      const response = await authClient.fetchPersonalUserDetails({ kpostID: value });
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. business rule: a business-tier account must not be returned by the personal lookup', async ({
    authClient,
  }) => {
    const response = await authClient.fetchPersonalUserDetails({
      kpostID: randomKpostId(),
      userType: 'Business',
    });
    const { text } = await readBody(response);

    expect(
      text,
      'the personal-tier lookup returned a Business account — tier scoping is not enforced'
    ).not.toContain('"userType":"Business"');
  });

  test('7. PII exposure: unauthenticated callers must not receive contact details', async ({
    authClient,
  }) => {
    const response = await authClient.fetchPersonalUserDetails(
      { kpostID: 'admin' },
      { token: null }
    );
    const { text } = await readBody(response);

    expect(
      text,
      'an unauthenticated caller received a mobile number — PII disclosure'
    ).not.toMatch(/"mobileNumber"\s*:\s*"\d{6,}"/);
  });

  test('8. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.fetchPersonalUserDetails({ kpostID: payload });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.fetchPersonalUserDetails({ kpostID: ${JSON.stringify(payload)} });`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await authClient.fetchPersonalUserDetails({ kpostID: payload });
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.fetchPersonalUserDetails({ kpostID: ${JSON.stringify(payload)} });`,
        },
        payload
      );
    }
  });

  test('10. concurrent identical lookups are consistent', async ({ authClient }) => {
    const payload = { kpostID: randomKpostId() };
    const responses = await Promise.all([
      authClient.fetchPersonalUserDetails(payload),
      authClient.fetchPersonalUserDetails(payload),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent identical lookups returned different statuses'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.fetchPersonalUserDetails({ kpostID: randomKpostId() });
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
 * POST /v2/signupLogin/adminRegistration — public (security: [])
 * 8 required fields per swagger: companyName, firstName, kpostID, lastName, mobileNumber,
 * password, pinCode, uniqueName.
 * ===================================================================================== */

test.describe('Auth - GET /v2/signupLogin/userLogoutFromAllDevices @audit', () => {
  const META = {
    method: 'GET',
    path: AUTH_PATHS.userLogoutFromAllDevices,
    repro: `await authClient.userLogoutFromAllDevices({ token });`,
  };

  test('1. baseline returns a documented status', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogoutFromAllDevices({ token: revocableToken });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogoutFromAllDevices({ token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogoutFromAllDevices({ token: null });`,
    });
  });

  test('3. expired token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogoutFromAllDevices({ token: EXPIRED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogoutFromAllDevices({ token: EXPIRED_TOKEN });`,
    });
  });

  test('4. malformed token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.userLogoutFromAllDevices({ token: MALFORMED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogoutFromAllDevices({ token: MALFORMED_TOKEN });`,
    });
  });

  test('5. an alg=none forged token must not revoke sessions', async ({ authClient }) => {
    const forged =
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';
    const response = await authClient.userLogoutFromAllDevices({ token: forged });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.userLogoutFromAllDevices({ token: '<alg=none JWT>' });`,
    });
  });

  test('6. IDOR: a query-supplied kpostID must not revoke another user\'s sessions', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogoutFromAllDevices({
      token: revocableToken,
      params: { kpostID: 'admin' },
    });
    expect(
      response.status(),
      'sessions were revoked for a query-supplied kpostID — a caller could force-logout arbitrary users'
    ).not.toBe(200);
  });

  test('7. unexpected query parameters do not cause a 5xx', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogoutFromAllDevices({
      token: revocableToken,
      params: { debug: true, all: 'yes' },
    });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('8. SQL injection in query params does not leak internals', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.userLogoutFromAllDevices({
        token: revocableToken,
        params: { kpostID: payload },
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.userLogoutFromAllDevices({ token, params: { kpostID: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('9. idempotency: repeated revocation is safe', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const responses = await Promise.all([
      authClient.userLogoutFromAllDevices({ token: revocableToken }),
      authClient.userLogoutFromAllDevices({ token: revocableToken }),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent revoke-all calls returned different statuses — the operation is not idempotent'
    ).toBe(1);
  });

  test('10. envelope parity', async ({ authClient, revocableToken }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogoutFromAllDevices({ token: revocableToken });
    await assertStatusCodeParity(response, META);
  });

  test('11. contract: response body parses as the documented envelope', async ({
    authClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    const response = await authClient.userLogoutFromAllDevices({ token: revocableToken });
    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    revocableToken,
  }) => {
    /*
     * This test DESTROYS the session it authenticates with, so it runs on a sacrificial one.
     *
     * It used to pass `staticToken` - the run's shared session. `AuthenticationFilter` matches
     * a token's `deviceID` claim against the login-session table on every request, so revoking
     * that session took every other worker's authentication down with it, mid-run, on every
     * run. The 401s that followed were then filed as defects against unrelated modules.
     */
    test.skip(
      revocableToken === null,
      'no disposable session could be minted (set QA_KPOST_ID / QA_PASSWORD) - refusing to ' +
        'revoke the shared run session to test revocation'
    );
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: revocableToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* ========================================================================================
 * GET /v2/signupLogin/getActiveSession — secured
 * ===================================================================================== */

test.describe('Auth - GET /v2/signupLogin/getActiveSession @audit', () => {
  const META = {
    method: 'GET',
    path: AUTH_PATHS.getActiveSession,
    repro: `await authClient.getActiveSession({ token });`,
  };

  test('[FR-S11] 1. baseline returns a documented status', async ({ authClient, staticToken }) => {
    const response = await authClient.getActiveSession({ token: staticToken });
    await assertStatus(response, [200, 400, 401, 403], META);
  });

  test('2. no token: must be 401/403, not 400', async ({ authClient }) => {
    const response = await authClient.getActiveSession({ token: null });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getActiveSession({ token: null });`,
    });
  });

  test('3. expired token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.getActiveSession({ token: EXPIRED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getActiveSession({ token: EXPIRED_TOKEN });`,
    });
  });

  test('4. malformed token: must be 401/403', async ({ authClient }) => {
    const response = await authClient.getActiveSession({ token: MALFORMED_TOKEN });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getActiveSession({ token: MALFORMED_TOKEN });`,
    });
  });

  test('5. an alg=none forged token must not list sessions', async ({ authClient }) => {
    const forged =
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';
    const response = await authClient.getActiveSession({ token: forged });
    await assertUnauthorized(response, {
      ...META,
      repro: `await authClient.getActiveSession({ token: '<alg=none JWT>' });`,
    });
  });

  test('6. IDOR: a query-supplied kpostID must not expose another user\'s sessions', async ({
    authClient,
    staticToken,
  }) => {
    const INJECTED_KPOST_ID = 'admin';
    const response = await authClient.getActiveSession({
      token: staticToken,
      params: { kpostID: INJECTED_KPOST_ID },
    });
    const { json, text } = await readBody(response);
    // A 200 with sessions is NOT proof of IDOR: getActiveSession legitimately
    // returns the *caller's own* sessions. A breach is only proven if a returned
    // session actually belongs to the injected identity — i.e. the API honoured
    // the query kpostID over the token. Checking presence alone (length > 0)
    // flagged the safe, correctly-scoped response as a leak.
    const sessions = Array.isArray(json?.data) ? (json.data as Array<{ kpostID?: unknown }>) : [];
    const leakedForeignIdentity = sessions.some(
      (s) => String(s?.kpostID ?? '').toLowerCase() === INJECTED_KPOST_ID
    );

    expect(
      leakedForeignIdentity,
      `active sessions belonging to the injected kpostID "${INJECTED_KPOST_ID}" were returned — session data is not scoped to the token. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('7. session records must not expose raw tokens', async ({ authClient, staticToken }) => {
    const response = await authClient.getActiveSession({ token: staticToken });
    const { text } = await readBody(response);

    expect(
      text,
      'the active-session listing exposed raw JWT material — stolen listings would enable session hijacking'
    ).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });

  test('8. unexpected query parameters do not cause a 5xx', async ({ authClient, staticToken }) => {
    const response = await authClient.getActiveSession({
      token: staticToken,
      params: { limit: -1, offset: 'abc' },
    });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('9. SQL injection in query params does not leak internals', async ({
    authClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.getActiveSession({
        token: staticToken,
        params: { kpostID: payload },
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.getActiveSession({ token, params: { kpostID: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('10. concurrent reads are consistent', async ({ authClient, staticToken }) => {
    const responses = await Promise.all([
      authClient.getActiveSession({ token: staticToken }),
      authClient.getActiveSession({ token: staticToken }),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent session reads returned different statuses'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient, staticToken }) => {
    const response = await authClient.getActiveSession({ token: staticToken });
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
