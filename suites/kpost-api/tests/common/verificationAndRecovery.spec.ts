/**
 * Common V2 — verification & recovery: OTP send/validate (mobile + email) and password recovery.
 *
 * The whole `/v2/common/**` tree is permitAll (public by design), so these specs carry no
 * token/auth assertions — only functional behaviour, input validation, business rules and status.
 */

import { test, expect } from '../../src/fixtures/api.fixture';
import { COMMON_PATHS } from '../../src/api/clients/common.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import { commonDataResponseSchema } from '../../src/api/schemas/common.schema';
import { looseEnvelopeSchema, dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  readBody,
  expectValidContract,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  BOUNDARY_NUMBERS,
  MALFORMED_JSON_STRINGS,
  SQLI,
  XSS,
} from '../../src/utils/fuzzData';
import { env, MOCK_OTP_CANDIDATES } from '../../src/config/env.config';
import {
  buildForgotPasswordPayload,
  buildForgotPasswordUpdatePayload,
  buildSendMailOtpPayload,
  buildSendOtpPayload,
  buildValidateMailOtpPayload,
  buildValidateOtpPayload,
} from '../../src/api/payloads/common.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

test.describe('Common - POST /v2/common/sendOTP', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.sendOTP,
    repro: `await commonClient.sendOTP(buildSendOtpPayload());`,
  };

  test('1. baseline: a valid request is accepted and matches the envelope contract', async ({
    commonClient,
  }) => {
    const response = await commonClient.sendOTP(buildSendOtpPayload());
    await assertStatus(response, [200], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, commonDataResponseSchema, META);
  });

  test('2. boundary: mobile numbers just inside and outside the country length rule', async ({
    commonClient,
  }) => {
    // India (countryID 1) requires exactly 10 digits.
    for (const mobileNumber of ['9'.repeat(9), '9'.repeat(11), '9'.repeat(20)]) {
      const response = await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `sendOTP with a ${mobileNumber.length}-digit number for countryID=1 (rule: exactly 10)`,
        repro: `await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: '${mobileNumber}' }));`,
      });
    }
  });

  test('3. missing required mobileNumber must be a 400/422, not a 500', async ({
    commonClient,
  }) => {
    const response = await commonClient.sendOTP({ countryID: env.testCountryId });
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'sendOTP without the required mobileNumber',
      repro: `await commonClient.sendOTP({ countryID: 1 });`,
    });
  });

  test('4. null/empty mobileNumber must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: value }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `sendOTP with mobileNumber=${JSON.stringify(value)}`,
        repro: `await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch: mobileNumber as a number/array, countryID as a string', async ({
    commonClient,
  }) => {
    for (const overrides of [
      { mobileNumber: 9999999999 },
      { mobileNumber: ['9999999999'] },
      { countryID: 'one' },
    ]) {
      const response = await commonClient.sendOTP(buildSendOtpPayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. cross-parameter rule: an unknown countryID must be a 4xx, not a 500', async ({
    commonClient,
  }) => {
    for (const countryID of [99999, -1, BOUNDARY_NUMBERS.int32Overflow]) {
      const response = await commonClient.sendOTP(buildSendOtpPayload({ countryID }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `sendOTP with a countryID that does not exist (${countryID})`,
        repro: `await commonClient.sendOTP(buildSendOtpPayload({ countryID: ${countryID} }));`,
      });
    }
  });

  test('7. the OTP itself must never be returned to the caller', async ({ commonClient }) => {
    const response = await commonClient.sendOTP(buildSendOtpPayload());
    const { text } = await readBody(response);

    expect(
      text,
      'the response body contains what looks like the dispatched OTP — anyone able to call sendOTP could take over the account without receiving the SMS'
    ).not.toMatch(/"(otp|otpCode|code)"\s*:\s*"?\d{4,8}"?/i);
  });

  test('8. rate limiting: a burst for one number should be throttled', async ({ commonClient }) => {
    const payload = buildSendOtpPayload();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => commonClient.sendOTP(payload))
    );
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const dispatched = bodies.filter((b) => b.json && b.json.statusCode === 200);

    expect(
      dispatched.length,
      `${dispatched.length} of 6 concurrent OTP requests for the same number were all dispatched with no throttling — this is an SMS-flooding and cost-abuse vector`
    ).toBeLessThan(6);
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: payload }));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: payload }));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.sendOTP(buildSendOtpPayload({ mobileNumber: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.sendOTP(buildSendOtpPayload());
    await assertStatusCodeParity(response, META);
  });
});

/* ========================================================================================
 * POST /v2/common/validateOTP
 * ===================================================================================== */

test.describe('Common - POST /v2/common/validateOTP', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.validateOTP,
    repro: `await commonClient.validateOTP(buildValidateOtpPayload());`,
  };

  test('1. baseline: a wrong code is refused with a documented status', async ({ commonClient }) => {
    const response = await commonClient.validateOTP(buildValidateOtpPayload());
    await assertStatus(response, [200, 400], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('2. an incorrect OTP must never validate', async ({ commonClient }) => {
    // 123456 / 000000 are the mock OTPs the developers DELIBERATELY bypass for this test bench,
    // so accepting them is EXPECTED and must NOT be filed. Only a genuinely un-issued, NON-mock
    // OTP being accepted is a real authentication-bypass defect.
    const wrongOtps = ['999999', '111111', '424242'].filter((o) => !MOCK_OTP_CANDIDATES.includes(o));
    for (const otp of wrongOtps) {
      const payload = buildValidateOtpPayload(env.testMobile, otp);
      const response = await commonClient.validateOTP(payload);
      const { json } = await readBody(response);

      if (json && json.statusCode === 200) {
        await reportBusinessLogicFlaw(
          response,
          {
            method: 'POST',
            path: COMMON_PATHS.validateOTP,
            body: payload,
            repro: `await commonClient.validateOTP(buildValidateOtpPayload(TEST_MOBILE, '${otp}'));`,
            title: 'OTP validation bypass: a non-mock un-issued OTP is accepted (authentication bypass)',
            scenario: `mobile OTP "${otp}" (not a test-bench mock value) was accepted without having been issued — authentication bypass`,
          },
          'Security/Access Control',
          'Critical'
        );
      }
    }
  });

  test('3. missing OTP must be rejected', async ({ commonClient }) => {
    const payload = buildValidateOtpPayload();
    delete (payload as Record<string, unknown>).otp;

    const response = await commonClient.validateOTP(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'validateOTP without an otp',
      repro: `const p = buildValidateOtpPayload(); delete p.otp; await commonClient.validateOTP(p);`,
    });
  });

  test('4. null/empty OTP must never be treated as a match', async ({ commonClient }) => {
    for (const value of [null, '', ' ', {}]) {
      const response = await commonClient.validateOTP(
        buildValidateOtpPayload(env.testMobile, '000000', { otp: value })
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `otp=${JSON.stringify(value)} validated successfully — an empty code must never match`
      ).toBeFalsy();
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [123456, ['123456'], { otp: '123456' }]) {
      const response = await commonClient.validateOTP(
        buildValidateOtpPayload(env.testMobile, '000000', { otp: value })
      );
      expect(
        response.status(),
        `otp=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. SQL injection in the OTP field must not bypass validation', async ({ commonClient }) => {
    for (const payload of SQLI) {
      const response = await commonClient.validateOTP(
        buildValidateOtpPayload(env.testMobile, payload)
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `SQL injection payload "${payload}" validated successfully — OTP verification can be bypassed`
      ).toBeFalsy();

      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.validateOTP(buildValidateOtpPayload(mobile, ${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('7. brute force: repeated wrong codes should lock or throttle', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        commonClient.validateOTP(
          buildValidateOtpPayload(env.testMobile, String(100000 + i).padStart(6, '0'))
        )
      )
    );

    const throttled = responses.some((r) => r.status() === 429);
    expect(
      throttled,
      '10 rapid OTP guesses were all processed with no 429 — a 6-digit code can be brute-forced'
    ).toBe(true);
  });

  test('8. an OTP must not be validatable for a different mobile number', async ({
    commonClient,
  }) => {
    // Use a NON-mock OTP: 000000/123456 are the test-bench bypass and would validate for any
    // target, masking the target-binding this case checks.
    const response = await commonClient.validateOTP(
      buildValidateOtpPayload('1234567890', '999999')
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'an OTP validated against a mobile number it was never issued for'
    ).toBeFalsy();
  });

  test('9. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.validateOTP(
        buildValidateOtpPayload(env.testMobile, payload)
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.validateOTP(buildValidateOtpPayload(mobile, ${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('10. malformed JSON is rejected cleanly', async ({ commonClient }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await commonClient.postRawTo(COMMON_PATHS.validateOTP, body);
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.validateOTP(buildValidateOtpPayload());
    await assertStatusCodeParity(response, META);
  });
});

/* ========================================================================================
 * POST /v2/common/sendOTPtoMail  &  POST /v2/common/validateMailOTP
 * ===================================================================================== */

test.describe('Common - POST /v2/common/sendOTPtoMail', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.sendOTPtoMail,
    repro: `await commonClient.sendOTPtoMail(buildSendMailOtpPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.sendOTPtoMail(buildSendMailOtpPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: oversized local part and domain', async ({ commonClient }) => {
    for (const otherEmail of [`${'a'.repeat(300)}@example.com`, `qa@${'b'.repeat(300)}.com`]) {
      const response = await commonClient.sendOTPtoMail(buildSendMailOtpPayload({ otherEmail }));
      expect(response.status(), 'oversized email caused a server error').toBeLessThan(500);
    }
  });

  test('3. missing email must be rejected', async ({ commonClient }) => {
    const response = await commonClient.sendOTPtoMail({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'sendOTPtoMail with an empty body',
      repro: `await commonClient.sendOTPtoMail({});`,
    });
  });

  test('4. null/empty email must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.sendOTPtoMail(
        buildSendMailOtpPayload({ otherEmail: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `sendOTPtoMail with otherEmail=${JSON.stringify(value)}`,
        repro: `await commonClient.sendOTPtoMail(buildSendMailOtpPayload({ otherEmail: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. malformed email addresses must be rejected', async ({ commonClient }) => {
    for (const otherEmail of ['not-an-email', 'missing@tld', '@example.com', 'a b@example.com']) {
      const response = await commonClient.sendOTPtoMail(buildSendMailOtpPayload({ otherEmail }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `sendOTPtoMail with a malformed address "${otherEmail}"`,
        repro: `await commonClient.sendOTPtoMail(buildSendMailOtpPayload({ otherEmail: '${otherEmail}' }));`,
      });
    }
  });

  test('6. header injection via the email field must not be accepted', async ({ commonClient }) => {
    const injected = 'qa@example.com\r\nBcc: attacker@evil.test';
    const response = await commonClient.sendOTPtoMail(
      buildSendMailOtpPayload({ otherEmail: injected })
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a CRLF-injected recipient was accepted — the mail gateway can be used to send to arbitrary Bcc recipients'
    ).toBeFalsy();
  });

  test('7. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [12345, ['a@b.com'], { email: 'a@b.com' }]) {
      const response = await commonClient.sendOTPtoMail(
        buildSendMailOtpPayload({ otherEmail: value })
      );
      expect(
        response.status(),
        `otherEmail=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. the OTP must not be returned in the response', async ({ commonClient }) => {
    const response = await commonClient.sendOTPtoMail(buildSendMailOtpPayload());
    const { text } = await readBody(response);

    expect(text, 'the emailed OTP was disclosed in the API response').not.toMatch(
      /"(otp|otpCode|code)"\s*:\s*"?\d{4,8}"?/i
    );
  });

  test('9. rate limiting: a burst to one address should be throttled', async ({ commonClient }) => {
    const payload = buildSendMailOtpPayload();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => commonClient.sendOTPtoMail(payload))
    );
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const dispatched = bodies.filter((b) => b.json && b.json.statusCode === 200);

    expect(
      dispatched.length,
      `${dispatched.length} of 6 concurrent mail-OTP requests were all dispatched — email-flooding vector`
    ).toBeLessThan(6);
  });

  test('10. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.sendOTPtoMail(
        buildSendMailOtpPayload({ otherEmail: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.sendOTPtoMail(buildSendMailOtpPayload({ otherEmail: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.sendOTPtoMail(buildSendMailOtpPayload());
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

test.describe('Common - POST /v2/common/validateMailOTP', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.validateMailOTP,
    repro: `await commonClient.validateMailOTP(buildValidateMailOtpPayload());`,
  };

  test('1. baseline: a wrong code is refused', async ({ commonClient }) => {
    const response = await commonClient.validateMailOTP(buildValidateMailOtpPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. an incorrect OTP must never validate', async ({ commonClient }) => {
    // Same as the mobile OTP path: 123456 / 000000 are the developers' intentional test-bench
    // bypass and must not be filed. Only a NON-mock un-issued OTP being accepted is a real defect.
    const wrongOtps = ['999999', '111111', '424242'].filter((o) => !MOCK_OTP_CANDIDATES.includes(o));
    for (const otp of wrongOtps) {
      const payload = buildValidateMailOtpPayload(env.testEmail, otp);
      const response = await commonClient.validateMailOTP(payload);
      const { json } = await readBody(response);

      if (json && json.statusCode === 200) {
        await reportBusinessLogicFlaw(
          response,
          {
            method: 'POST',
            path: COMMON_PATHS.validateMailOTP,
            body: payload,
            repro: `await commonClient.validateMailOTP(buildValidateMailOtpPayload(TEST_EMAIL, '${otp}'));`,
            title: 'Mail OTP validation bypass: a non-mock un-issued OTP is accepted (authentication bypass)',
            scenario: `mail OTP "${otp}" (not a test-bench mock value) was accepted without having been issued — authentication bypass`,
          },
          'Security/Access Control',
          'Critical'
        );
      }
    }
  });

  test('3. missing otp must be rejected', async ({ commonClient }) => {
    const payload = buildValidateMailOtpPayload();
    delete (payload as Record<string, unknown>).otp;

    const response = await commonClient.validateMailOTP(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'validateMailOTP without an otp',
      repro: `const p = buildValidateMailOtpPayload(); delete p.otp; await commonClient.validateMailOTP(p);`,
    });
  });

  test('4. null/empty otp must never match', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.validateMailOTP(
        buildValidateMailOtpPayload(env.testEmail, '000000', { otp: value })
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `otp=${JSON.stringify(value)} validated successfully`
      ).toBeFalsy();
    }
  });

  test('5. missing email must be rejected', async ({ commonClient }) => {
    const payload = buildValidateMailOtpPayload();
    delete (payload as Record<string, unknown>).email;

    const response = await commonClient.validateMailOTP(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'validateMailOTP without an email',
      repro: `const p = buildValidateMailOtpPayload(); delete p.email; await commonClient.validateMailOTP(p);`,
    });
  });

  test('6. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [123456, ['1'], {}]) {
      const response = await commonClient.validateMailOTP(
        buildValidateMailOtpPayload(env.testEmail, '000000', { otp: value })
      );
      expect(
        response.status(),
        `otp=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. SQL injection must not bypass validation', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.validateMailOTP(
        buildValidateMailOtpPayload(env.testEmail, payload)
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `SQL injection payload "${payload}" validated successfully`
      ).toBeFalsy();
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.validateMailOTP(buildValidateMailOtpPayload(email, ${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('8. an OTP must not validate against a different address', async ({ commonClient }) => {
    // Non-mock OTP: the mock values bypass and would validate for any address.
    const response = await commonClient.validateMailOTP(
      buildValidateMailOtpPayload('someone-else@example.com', '999999')
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a mail OTP validated for an address it was never issued to'
    ).toBeFalsy();
  });

  test('9. brute force should be throttled', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        commonClient.validateMailOTP(
          buildValidateMailOtpPayload(env.testEmail, String(200000 + i))
        )
      )
    );

    expect(
      responses.some((r) => r.status() === 429),
      '10 rapid mail-OTP guesses were all processed with no 429'
    ).toBe(true);
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.validateMailOTP(
        buildValidateMailOtpPayload(env.testEmail, payload)
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.validateMailOTP(buildValidateMailOtpPayload(email, ${JSON.stringify(payload)}));`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.validateMailOTP(buildValidateMailOtpPayload());
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
 * POST /v2/common/mobileNoExist — read-only existence probe.
 * ===================================================================================== */

test.describe('Common - POST /v2/common/forgotPasswordOTPOrSentKpostIDSms', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.forgotPasswordOTPOrSentKpostIDSms,
    repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
      buildForgotPasswordPayload()
    );
    await assertStatus(response, [200, 400], META);
  });

  test('2. account enumeration: known and unknown numbers must respond identically', async ({
    commonClient,
  }) => {
    const knownResponse = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
      buildForgotPasswordPayload()
    );
    const known = await readBody(knownResponse);
    const unknown = await readBody(
      await commonClient.forgotPasswordOTPOrSentKpostIDSms(
        buildForgotPasswordPayload({ kpostID: '1000000001' })
      )
    );

    const messageOf = (body: typeof known) =>
      body.json && typeof body.json.message === 'string'
        ? body.json.message
        : body.text.slice(0, 80);

    if (messageOf(known) !== messageOf(unknown)) {
      await reportBusinessLogicFlaw(
        knownResponse,
        {
          ...META,
          body: buildForgotPasswordPayload(),
          title: 'User enumeration: password recovery reveals whether an account exists',
          scenario: `password recovery returned different messages for a known ("${messageOf(known)}") vs unknown ("${messageOf(unknown)}") account — a user-enumeration oracle`,
        },
        'Security/Access Control',
        'Major'
      );
    }
  });

  test('3. missing kpostID must be rejected', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'password recovery with an empty body',
      repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms({});`,
    });
  });

  test('4. null/empty kpostID must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
        buildForgotPasswordPayload({ kpostID: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `password recovery with kpostID=${JSON.stringify(value)}`,
        repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload({ kpostID: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [9999999999, ['9999999999'], {}]) {
      const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
        buildForgotPasswordPayload({ kpostID: value })
      );
      expect(
        response.status(),
        `kpostID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. no credential or OTP material is returned to the caller', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
      buildForgotPasswordPayload()
    );
    const { text } = await readBody(response);

    expect(
      text,
      'the recovery response disclosed OTP or password material — recovery could be completed without access to the phone'
    ).not.toMatch(/"(otp|password|accessCode|kmailPassword)"\s*:\s*"?[^",}]{3,}/i);
  });

  test('7. rate limiting: repeated recovery requests should be throttled', async ({
    commonClient,
  }) => {
    const payload = buildForgotPasswordPayload();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => commonClient.forgotPasswordOTPOrSentKpostIDSms(payload))
    );
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const dispatched = bodies.filter((b) => b.json && b.json.statusCode === 200);

    expect(
      dispatched.length,
      `${dispatched.length} of 6 concurrent recovery requests were dispatched with no throttling — SMS-flooding vector`
    ).toBeLessThan(6);
  });

  test('8. an invalid requestType must be rejected', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
      buildForgotPasswordPayload({ requestType: 'NOT_A_REAL_TYPE' })
    );
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'password recovery with an unrecognised requestType',
      repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload({ requestType: 'NOT_A_REAL_TYPE' }));`,
    });
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
        buildForgotPasswordPayload({ kpostID: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.forgotPasswordOTPOrSentKpostIDSms(
        buildForgotPasswordPayload({ kpostID: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.forgotPasswordOTPOrSentKpostIDSms(buildForgotPasswordPayload()),
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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

test.describe('Common - POST /v2/common/forgotPasswordUpdate', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.forgotPasswordUpdate,
    repro: `await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload());`,
  };

  test('1. baseline: a reset without a valid OTP is refused', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload());
    const { json, text } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      `a password reset succeeded without presenting a valid OTP — any account could be taken over. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('2. an invalid OTP must never complete the reset', async ({ commonClient }) => {
    // 123456 / 000000 are the developers' test-bench mock OTPs (deliberately bypassed), so a reset
    // completing with them is EXPECTED — not filed. Only a NON-mock unissued OTP completing the
    // reset is a real account-takeover defect.
    const wrongOtps = ['999999', '111111', '424242'].filter((o) => !MOCK_OTP_CANDIDATES.includes(o));
    for (const otp of wrongOtps) {
      const payload = buildForgotPasswordUpdatePayload({ otp });
      const response = await commonClient.forgotPasswordUpdate(payload);
      const { json } = await readBody(response);

      if (json && json.statusCode === 200) {
        await reportBusinessLogicFlaw(
          response,
          {
            ...META,
            body: payload,
            title: 'Password reset completes with a non-mock unissued OTP — account takeover',
            scenario: `the reset completed with an unissued non-mock OTP "${otp}" — any account could be taken over`,
          },
          'Security/Access Control',
          'Critical'
        );
      }
    }
  });

  test('3. missing new password must be rejected', async ({ commonClient }) => {
    const payload = buildForgotPasswordUpdatePayload();
    delete (payload as Record<string, unknown>).forgotPassword;

    const response = await commonClient.forgotPasswordUpdate(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'forgotPasswordUpdate without a new password',
      repro: `const p = buildForgotPasswordUpdatePayload(); delete p.forgotPassword; await commonClient.forgotPasswordUpdate(p);`,
    });
  });

  test('4. null/empty new password must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.forgotPasswordUpdate(
        buildForgotPasswordUpdatePayload({ forgotPassword: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `forgotPasswordUpdate with forgotPassword=${JSON.stringify(value)}`,
        repro: `await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload({ forgotPassword: ${JSON.stringify(value)} }));`,
      });
    }
  });

  // No confirmation-mismatch case: the contract is `{ kpostID, forgotPassword }`, with no
  // `confirmPassword` field to validate.

  test('6. weak passwords must be refused by the password policy', async ({ commonClient }) => {
    for (const weak of ['1', 'a', '123456', 'password']) {
      const response = await commonClient.forgotPasswordUpdate(
        buildForgotPasswordUpdatePayload({ forgotPassword: weak })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `forgotPasswordUpdate with the weak password "${weak}"`,
        repro: `await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload({ forgotPassword: '${weak}' }));`,
      });
    }
  });

  test('7. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [12345, ['pw'], {}]) {
      const response = await commonClient.forgotPasswordUpdate(
        buildForgotPasswordUpdatePayload({ forgotPassword: value })
      );
      expect(
        response.status(),
        `forgotPassword=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. a reset must not be applicable to an arbitrary account', async ({
    commonClient,
  }) => {
    // Excel contract keys the reset by `kpostID`; a caller-supplied account must not be reset
    // without proof of ownership (an OTP verified for that account).
    const response = await commonClient.forgotPasswordUpdate(
      buildForgotPasswordUpdatePayload({ kpostID: 'admin' })
    );
    const { json } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      'a password reset was applied to a caller-supplied account without proof of ownership'
    ).toBeFalsy();
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.forgotPasswordUpdate(
        buildForgotPasswordUpdatePayload({ kpostID: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload({ kpostID: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. the new password is never echoed back', async ({ commonClient }) => {
    const response = await commonClient.forgotPasswordUpdate(
      buildForgotPasswordUpdatePayload({ forgotPassword: 'Qa@Uniqu3Echo!' })
    );
    const { text } = await readBody(response);

    expect(text, 'the submitted new password was echoed in the response').not.toContain(
      'Qa@Uniqu3Echo!'
    );
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.forgotPasswordUpdate(buildForgotPasswordUpdatePayload()),
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * Domain endpoints. The documented cross-parameter rule: personal domains are only
 * available for certain countries, and the spec warns the failure is a generic
 * "Data Not Available" rather than a clean business error.
 * ===================================================================================== */
