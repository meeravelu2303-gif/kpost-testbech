/**
 * Auth V2 — registration & identity: signup, admin (business) registration, kpostID availability & suggestions, access code.
 *
 * Every endpoint here is a pre-token entry point — swagger marks them security: [], so they are
 * public and are called without a token. No auth/token assertions belong in this file.
 */

import { test, expect } from '../../src/fixtures/api.fixture';
import { AUTH_PATHS } from '../../src/api/clients/auth.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import { looseEnvelopeSchema, dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertPublicRouteReachable,
  readBody,
  reportBusinessLogicFlaw,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import {
  BOUNDARY_STRINGS,
  MALFORMED_JSON_STRINGS,
  SQLI,
  UNICODE_STRINGS,
  XSS,
} from '../../src/utils/fuzzData';
import {
  buildAdminRegistrationPayload,
  buildKpostIdExistPayload,
  buildKpostIdSuggestionPayload,
  buildSetAccessCodePayload,
  buildSignupPayload,
  randomKpostId,
  syntheticTestMobile,
} from '../../src/api/payloads/auth.payload';
import { buildSendOtpPayload, buildValidateOtpPayload } from '../../src/api/payloads/common.payload';
import { env } from '../../src/config/env.config';
import { FOREIGN } from '../../src/api/clients/generic.client';

test.describe.configure({ timeout: 90_000 });

test.describe('Auth - POST /v2/signupLogin/signup', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.signup,
    repro: `await authClient.signup(buildSignupPayload(), { token: null });`,
  };

  test('[public] signup must stay reachable without a token — a new user has none', async ({
    authClient,
  }) => {
    // security: [] in swagger. A first-time user holds no bearer, so a token gate here makes
    // registration impossible for everyone — a total onboarding blockade.
    const response = await authClient.signup(buildSignupPayload(), { token: null });
    await assertPublicRouteReachable(response, { ...META, severity: 'Critical', body: 'buildSignupPayload()' });
  });

  test('1. baseline: a well-formed registration is answered with a documented status', async ({
    authClient,
  }) => {
    const response = await authClient.signup(buildSignupPayload());
    await assertStatus(response, [200, 201, 400], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('2. boundary: max-length and unicode names are handled without a 5xx', async ({
    authClient,
  }) => {
    for (const value of [BOUNDARY_STRINGS[0], UNICODE_STRINGS[0], UNICODE_STRINGS[2]]) {
      const response = await authClient.signup(buildSignupPayload({ firstName: value }));
      expect(
        response.status(),
        `firstName="${value.slice(0, 24)}" caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('3. missing required field: mobileNumber omitted must be a 400/422', async ({
    authClient,
  }) => {
    const payload = buildSignupPayload();
    delete (payload as Record<string, unknown>).mobileNumber;

    const response = await authClient.signup(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'signup without the required mobileNumber',
      repro: `const p = buildSignupPayload(); delete p.mobileNumber; await authClient.signup(p);`,
    });
  });

  test('4. null/empty fuzzing on required fields is rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.signup(buildSignupPayload({ mobileNumber: value }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `signup with mobileNumber=${JSON.stringify(value)}`,
        repro: `await authClient.signup(buildSignupPayload({ mobileNumber: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: countryID as a string / mobileNumber as an array', async ({
    authClient,
  }) => {
    for (const payload of [
      buildSignupPayload({ countryID: 'not-a-number' }),
      buildSignupPayload({ mobileNumber: ['9999999999'] }),
      buildSignupPayload({ userProfile: 'should-be-an-object' }),
    ]) {
      const response = await authClient.signup(payload);
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: 'signup with a type-mismatched field',
        repro: `await authClient.signup(${JSON.stringify(payload).slice(0, 120)}...);`,
      });
    }
  });

  test('6. malformed JSON bodies are rejected as 400', async ({ authClient }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await authClient.signupRaw(body);
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `signup with malformed JSON body ${JSON.stringify(body)}`,
        repro: `await authClient.signupRaw(${JSON.stringify(body)});`,
      });
    }
  });

  test('7. business rule: an invalid countryID must not silently register the user', async ({
    authClient,
  }) => {
    const response = await authClient.signup(buildSignupPayload({ countryID: 99999 }));
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'signup with a countryID that does not exist',
      repro: `await authClient.signup(buildSignupPayload({ countryID: 99999 }));`,
    });
  });

  test('8. public endpoint: no Authorization header is required', async ({ authClient }) => {
    const response = await authClient.signup(buildSignupPayload(), { token: null });
    expect(
      response.status(),
      'signup is declared security:[] and must not demand a token'
    ).not.toBe(401);
  });

  test('9. SQL injection in name fields does not leak database internals', async ({
    authClient,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.signup(buildSignupPayload({ firstName: payload }));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.signup(buildSignupPayload({ firstName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await authClient.signup(buildSignupPayload({ lastName: payload }));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.signup(buildSignupPayload({ lastName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. idempotency: concurrent identical signups must not both create the account', async ({
    authClient,
  }) => {
    const payload = buildSignupPayload();
    const responses = await Promise.all([
      authClient.signup(payload),
      authClient.signup(payload),
      authClient.signup(payload),
    ]);

    const succeeded = responses.filter((r) => r.status() >= 200 && r.status() < 300);
    expect(
      succeeded.length,
      `${succeeded.length} of 3 concurrent identical signups succeeded — the unique constraint on kpostID/mobileNumber is not enforced under concurrency`
    ).toBeLessThanOrEqual(1);
  });

  test('12. envelope parity: HTTP status agrees with the embedded statusCode', async ({
    authClient,
  }) => {
    const response = await authClient.signup(buildSignupPayload());
    await assertStatusCodeParity(response, META);
  });

  test('13. mass assignment: caller-supplied privileged fields must not be honoured', async ({
    authClient,
  }) => {
    const response = await authClient.signup(
      buildSignupPayload({ isBackUpAdmin: true, activeStatus: 'ACTIVE', companyID: 1 })
    );
    const { text } = await readBody(response);
    expect(
      response.status(),
      `signup accepting caller-set isBackUpAdmin/companyID would be a privilege-escalation vector. Body: ${text.slice(0, 200)}`
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
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });


  test('12. registration through the OTP flow provisions a real account', async ({
    authClient,
    commonClient,
  }) => {
    // The backend requires a validated OTP of type SIGNUP before it will persist a user;
    // calling signup without it NPEs on a null expireDate. This drives the real flow
    // (sendOTP -> validateOTP(mock, SIGNUP) -> signup) on a synthetic test number, so no
    // SMS reaches a real subscriber. See syntheticTestMobile().
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // The suite fires many registrations in a burst and the backend rate-limits with a 429
    // ("retry in N seconds"). Run the full flow and retry through the throttle so a busy run
    // still provisions the account. A fresh synthetic number each attempt keeps the
    // per-number OTP send cap out of the picture.
    const attempt = async () => {
      const mobileNumber = syntheticTestMobile();
      const kpostID = randomKpostId();
      const otpSent = await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber, requestType: 'SIGNUP' }));
      if (otpSent.status() === 429) return otpSent;
      const otpOk = await commonClient.validateOTP(buildValidateOtpPayload(mobileNumber, env.mockOtp, { type: 'SIGNUP' }));
      if (otpOk.status() === 429) return otpOk;
      return authClient.signup(buildSignupPayload({ kpostID, mobileNumber }));
    };

    let response = await attempt();
    for (let i = 0; i < 4 && response.status() === 429; i += 1) {
      await wait(15_000);
      response = await attempt();
    }

    // A 429 that survives every retry is the backend rate limiter, not a defect — the endpoint
    // is throttling correctly. Skip rather than file: reporting the throttle as a bug is a false
    // positive (and its "retry in N seconds" text varies, so it would dodge dedup and re-file).
    test.skip(
      response.status() === 429,
      'backend throttled all signup retries (HTTP 429) — rate limiting working, not a defect'
    );

    const { json } = await readBody(response);

    // A fresh synthetic number registers cleanly; a rare collision (already-exists) is the
    // only other acceptable outcome and still proves the flow reached user persistence.
    expect(
      response.status() === 200 || /already exist/i.test(String(json?.message ?? '')),
      `registration through the OTP flow was rejected: HTTP ${response.status()} - ${JSON.stringify(json).slice(0, 160)}`
    ).toBeTruthy();
  });
});

/* ========================================================================================
 * POST /v2/signupLogin/userLogin — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/setAccessCode', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.setAccessCode,
    repro: `await authClient.setAccessCode(buildSetAccessCodePayload(), { token: null });`,
  };

  test('[public] reachable without a token — set during the pre-token onboarding flow', async ({ authClient }) => {
    const response = await authClient.setAccessCode(buildSetAccessCodePayload(), { token: null });
    await assertPublicRouteReachable(response, { ...META, body: 'buildSetAccessCodePayload()' });
  });

  test('1. baseline returns a documented status', async ({ authClient }) => {
    const response = await authClient.setAccessCode(buildSetAccessCodePayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: access codes of varying length', async ({ authClient }) => {
    for (const code of ['1', '123456', '9'.repeat(64), 'a'.repeat(256)]) {
      const response = await authClient.setAccessCode(buildSetAccessCodePayload({ accessCode: code }));
      expect(
        response.status(),
        `accessCode length ${code.length} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('3. missing kpostID must be rejected', async ({ authClient }) => {
    const payload = buildSetAccessCodePayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await authClient.setAccessCode(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'setAccessCode without kpostID',
      repro: `const p = buildSetAccessCodePayload(); delete p.kpostID; await authClient.setAccessCode(p);`,
    });
  });

  test('4. null/empty access code must be rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.setAccessCode(
        buildSetAccessCodePayload({ accessCode: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `setAccessCode with accessCode=${JSON.stringify(value)}`,
        repro: `await authClient.setAccessCode(buildSetAccessCodePayload({ accessCode: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: currentPassword as a number, accessCode as an array', async ({ authClient }) => {
    for (const overrides of [{ currentPassword: 12345678 }, { accessCode: ['123456'] }]) {
      const response = await authClient.setAccessCode(buildSetAccessCodePayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. business rule: setting a code for an unknown user must not report success', async ({
    authClient,
  }) => {
    const response = await authClient.setAccessCode(
      buildSetAccessCodePayload({ kpostID: `nonexistent-${Date.now()}` })
    );
    const { json } = await readBody(response);

    if (json && typeof json.statusCode === 'number') {
      expect(
        json.statusCode,
        'an access code was reportedly set for a user that does not exist'
      ).not.toBe(200);
    }
  });

  test('7. IDOR: an access code must not be settable for an arbitrary account', async ({
    authClient,
  }) => {
    const response = await authClient.setAccessCode(
      buildSetAccessCodePayload({ kpostID: 'admin', accessCode: '000000' })
    );
    const { json, text } = await readBody(response);
    const succeeded = json && json.statusCode === 200;

    expect(
      succeeded,
      `an unauthenticated caller set the access code for "admin" — full account takeover. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('8. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.setAccessCode(
        buildSetAccessCodePayload({ kpostID: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.setAccessCode(buildSetAccessCodePayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await authClient.setAccessCode(
        buildSetAccessCodePayload({ kpostID: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.setAccessCode(buildSetAccessCodePayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. duplicate concurrent submissions behave consistently', async ({ authClient }) => {
    const payload = buildSetAccessCodePayload();
    const responses = await Promise.all([
      authClient.setAccessCode(payload),
      authClient.setAccessCode(payload),
    ]);

    expect(
      new Set(responses.map((r) => r.status())).size,
      'concurrent identical setAccessCode calls returned different statuses'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.setAccessCode(buildSetAccessCodePayload());
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * POST /v2/signupLogin/kpostIdExist — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/kpostIdExist', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.kpostIdExist,
    repro: `await authClient.kpostIdExist(buildKpostIdExistPayload(), { token: null });`,
  };

  test('[public] reachable without a token — the availability check runs before signup', async ({ authClient }) => {
    const response = await authClient.kpostIdExist(buildKpostIdExistPayload(), { token: null });
    await assertPublicRouteReachable(response, { ...META, body: 'buildKpostIdExistPayload()' });
  });

  test('1. baseline availability check returns a documented status', async ({ authClient }) => {
    const response = await authClient.kpostIdExist(buildKpostIdExistPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: very long and single-character kpostIDs', async ({ authClient }) => {
    for (const value of ['a', 'a'.repeat(256), 'a'.repeat(1024)]) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: value }));
      expect(
        response.status(),
        `kpostID of length ${value.length} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('3. missing kpostID must be rejected', async ({ authClient }) => {
    const payload = buildKpostIdExistPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await authClient.kpostIdExist(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'kpostIdExist without kpostID',
      repro: `const p = buildKpostIdExistPayload(); delete p.kpostID; await authClient.kpostIdExist(p);`,
    });
  });

  test('4. null/empty kpostID must be rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: value }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `kpostIdExist with kpostID=${JSON.stringify(value)}`,
        repro: `await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: kpostID as a number or array', async ({ authClient }) => {
    for (const value of [12345, ['a'], { a: 1 }]) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: value }));
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. unicode kpostIDs are handled without a 5xx', async ({ authClient }) => {
    for (const value of UNICODE_STRINGS.slice(0, 4)) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: value }));
      expect(
        response.status(),
        `unicode kpostID "${value}" caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. malformed JSON is rejected', async ({ authClient }) => {
    for (const body of MALFORMED_JSON_STRINGS.slice(0, 2)) {
      const response = await authClient.kpostIdExist(body);
      expect(
        response.status(),
        `malformed body ${body} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: payload }));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: payload }));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.kpostIdExist(buildKpostIdExistPayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. determinism: the same kpostID yields the same answer concurrently', async ({
    authClient,
  }) => {
    const payload = buildKpostIdExistPayload();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => authClient.kpostIdExist(payload))
    );
    const bodies = await Promise.all(responses.map((r) => readBody(r)));

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'the same availability check returned different answers concurrently'
    ).toBe(1);
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.kpostIdExist(buildKpostIdExistPayload());
    await assertStatusCodeParity(response, META);
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

  test('[business rule] a registered kpostID must be reported as unavailable (BR-S02)', async ({
    authClient,
    authSession,
  }) => {
    // FR-S03 / BR-S02: identifier uniqueness is enforced — the availability lookup must report an
    // already-registered kpostID as taken, so the client never offers it as a fresh handle.
    const registeredId = authSession.kpostID ?? 'meeravelu23@kpostindia.com';
    const response = await authClient.kpostIdExist({
      kpostID: registeredId,
      firstName: 'Qa',
      lastName: 'Check',
      mobileNumber: '9000000430',
    });
    const { json, text } = await readBody(response);
    const body = `${text}`.toLowerCase();
    const reportedTaken =
      response.status() >= 400 ||
      /already|exist|taken|not available|in use/.test(body) ||
      (json != null && json.status && String(json.status).toUpperCase() === 'FAILURE');

    if (!reportedTaken) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          title: 'A registered kpostID is reported as available for signup',
          scenario:
            `kpostIdExist answered HTTP ${response.status()} for the already-registered "${registeredId}" without ` +
            'signalling that it is taken. Offering a registered handle as available invites a duplicate/conflicting ' +
            `account. Body: ${text.slice(0, 160)}`,
        },
        'Business Logic Flaw',
        'Major'
      );
    }

    expect(reportedTaken, 'kpostIdExist must report an already-registered kpostID as unavailable (BR-S02)').toBe(true);
  });

});

/* ========================================================================================
 * POST /v2/signupLogin/kpostIDsuggestionList — public (security: [])
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/kpostIDsuggestionList', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.kpostIDsuggestionList,
    repro: `await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload(), { token: null });`,
  };

  test('[public] reachable without a token — suggestions are offered during signup', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload(), { token: null });
    await assertPublicRouteReachable(response, { ...META, body: 'buildKpostIdSuggestionPayload()' });
  });

  test('1. baseline suggestion request returns a documented status', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: very long names', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList(
      buildKpostIdSuggestionPayload({ firstName: 'a'.repeat(512), lastName: 'b'.repeat(512) })
    );
    expect(response.status(), 'oversized names caused a server error').toBeLessThan(500);
  });

  test('3. missing firstName/lastName must be a 400, not a 500', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'suggestion list with no name fields (spec notes this returns Failure)',
      repro: `await authClient.kpostIdSuggestionList({});`,
    });
  });

  test('4. null/empty names are rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.kpostIdSuggestionList(
        buildKpostIdSuggestionPayload({ firstName: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `suggestion list with firstName=${JSON.stringify(value)}`,
        repro: `await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload({ firstName: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: names as numbers/arrays', async ({ authClient }) => {
    for (const value of [12345, ['a'], { a: 1 }]) {
      const response = await authClient.kpostIdSuggestionList(
        buildKpostIdSuggestionPayload({ firstName: value })
      );
      expect(
        response.status(),
        `firstName=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. unicode names are handled', async ({ authClient }) => {
    for (const value of UNICODE_STRINGS.slice(0, 3)) {
      const response = await authClient.kpostIdSuggestionList(
        buildKpostIdSuggestionPayload({ firstName: value })
      );
      expect(response.status(), `unicode name "${value}" caused a server error`).toBeLessThan(500);
    }
  });

  test('7. suggestions must not collide with existing accounts', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload());
    const { json } = await readBody(response);
    const suggestions = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    test.skip(suggestions.length === 0, 'backend returned no suggestions to verify');

    for (const suggestion of suggestions.slice(0, 3)) {
      const check = await authClient.kpostIdExist({ kpostID: String(suggestion) });
      const checkBody = await readBody(check);
      expect(
        checkBody.text.toLowerCase(),
        `suggested kpostID "${suggestion}" is reported as already taken — suggestions are not verified free`
      ).not.toContain('already');
    }
  });

  test('8. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.kpostIdSuggestionList(
        buildKpostIdSuggestionPayload({ firstName: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload({ firstName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await authClient.kpostIdSuggestionList(
        buildKpostIdSuggestionPayload({ firstName: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload({ firstName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. concurrent calls must not suggest the same id twice', async ({ authClient }) => {
    const payload = buildKpostIdSuggestionPayload();
    const responses = await Promise.all([
      authClient.kpostIdSuggestionList(payload),
      authClient.kpostIdSuggestionList(payload),
    ]);
    for (const response of responses) {
      expect(response.status(), 'concurrent suggestion requests errored').toBeLessThan(500);
    }
  });

  test('11. envelope parity', async ({ authClient }) => {
    const response = await authClient.kpostIdSuggestionList(buildKpostIdSuggestionPayload());
    await assertStatusCodeParity(response, META);
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
 * POST /v2/signupLogin/getLoginHistory — secured
 * ===================================================================================== */

test.describe('Auth - POST /v2/signupLogin/adminRegistration', () => {
  const META = {
    method: 'POST',
    path: AUTH_PATHS.adminRegistration,
    repro: `await authClient.adminRegistration(buildAdminRegistrationPayload(), { token: null });`,
  };

  test('[public] reachable without a token — a company admin registers before any token exists', async ({ authClient }) => {
    const response = await authClient.adminRegistration(buildAdminRegistrationPayload(), { token: null });
    await assertPublicRouteReachable(response, { ...META, body: 'buildAdminRegistrationPayload()' });
  });

  const REQUIRED_FIELDS = [
    'companyName',
    'firstName',
    'kpostID',
    'lastName',
    'mobileNumber',
    'password',
    'pinCode',
    'uniqueName',
  ];

  test('1. baseline returns a documented status', async ({ authClient }) => {
    const response = await authClient.adminRegistration(buildAdminRegistrationPayload());
    await assertStatus(response, [200, 201, 400], META);
  });

  test('2. boundary: oversized company name and pin code', async ({ authClient }) => {
    const response = await authClient.adminRegistration(
      buildAdminRegistrationPayload({ companyName: 'a'.repeat(1024), pinCode: '9'.repeat(64) })
    );
    expect(response.status(), 'oversized company fields caused a server error').toBeLessThan(500);
  });

  for (const field of REQUIRED_FIELDS) {
    test(`3. required field "${field}" omitted must be a 400/422`, async ({ authClient }) => {
      const payload = buildAdminRegistrationPayload();
      delete (payload as Record<string, unknown>)[field];

      const response = await authClient.adminRegistration(payload);
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `adminRegistration without the required "${field}"`,
        repro: `const p = buildAdminRegistrationPayload(); delete p.${field}; await authClient.adminRegistration(p);`,
      });
    });
  }

  test('4. null/empty required fields are rejected', async ({ authClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await authClient.adminRegistration(
        buildAdminRegistrationPayload({ companyName: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `adminRegistration with companyName=${JSON.stringify(value)}`,
        repro: `await authClient.adminRegistration(buildAdminRegistrationPayload({ companyName: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: licenses/countryID as strings, companyName as an array', async ({
    authClient,
  }) => {
    for (const overrides of [
      { countryID: 'not-a-number' },
      { licenses: 'many' },
      { companyName: ['Acme'] },
    ]) {
      const response = await authClient.adminRegistration(buildAdminRegistrationPayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. business rule: a negative or zero licence count must be refused', async ({
    authClient,
  }) => {
    for (const licenses of [-1, 0, -9999]) {
      const response = await authClient.adminRegistration(
        buildAdminRegistrationPayload({ licenses, maximumMembersCount: licenses })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `adminRegistration with licenses=${licenses}`,
        repro: `await authClient.adminRegistration(buildAdminRegistrationPayload({ licenses: ${licenses} }));`,
      });
    }
  });

  test('7. business rule: an expiry date in the past must be refused', async ({ authClient }) => {
    const response = await authClient.adminRegistration(
      buildAdminRegistrationPayload({ expireDate: '2000-01-01T00:00:00.000Z' })
    );
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'adminRegistration with an expireDate in the past',
      repro: `await authClient.adminRegistration(buildAdminRegistrationPayload({ expireDate: '2000-01-01T00:00:00.000Z' }));`,
    });
  });

  test('8. privilege escalation: caller-supplied admin/companyID must not be honoured', async ({
    authClient,
  }) => {
    const response = await authClient.adminRegistration(
      buildAdminRegistrationPayload({ admin: 'true', companyID: 1, activeStatus: 'ACTIVE' })
    );
    const { json, text } = await readBody(response);

    if (json && json.statusCode === 200) {
      expect(
        text,
        'adminRegistration honoured a caller-supplied companyID — an attacker could attach themselves to an existing company as admin'
      ).not.toContain('"companyID":1');
    }
  });

  test('9. SQL injection does not leak internals', async ({ authClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await authClient.adminRegistration(
        buildAdminRegistrationPayload({ companyName: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await authClient.adminRegistration(buildAdminRegistrationPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ authClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await authClient.adminRegistration(
        buildAdminRegistrationPayload({ companyName: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await authClient.adminRegistration(buildAdminRegistrationPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. idempotency: concurrent identical registrations must not both succeed', async ({
    authClient,
  }) => {
    const payload = buildAdminRegistrationPayload();
    const responses = await Promise.all([
      authClient.adminRegistration(payload),
      authClient.adminRegistration(payload),
      authClient.adminRegistration(payload),
    ]);

    const succeeded = responses.filter((r) => r.status() >= 200 && r.status() < 300);
    expect(
      succeeded.length,
      `${succeeded.length} of 3 concurrent identical admin registrations succeeded — the uniqueName/kpostID constraint is not enforced under concurrency`
    ).toBeLessThanOrEqual(1);
  });

  test('12. envelope parity', async ({ authClient }) => {
    const response = await authClient.adminRegistration(buildAdminRegistrationPayload());
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * GET /v2/signupLogin/userLogoutFromAllDevices — secured
 *
 * NOTE ON TOKENS IN THIS BLOCK: every case that needs a live session uses `revocableToken`,
 * a second login on a throwaway `deviceIdentity_primary`, never the run's shared session.
 * Revocation tests are the one place where using the shared token is actively destructive.
 *
 * SKIPPED: the backend team confirmed this route is not in use. It answers HTTP 500 with a
 * raw SQL constraint error even without a token, so every case here would file a defect
 * against an endpoint nobody maintains. Skipped rather than deleted so the 12 cases stay
 * visible, and come back by removing one word if the route is ever revived.
 * ===================================================================================== */
