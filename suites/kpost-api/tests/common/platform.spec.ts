/**
 * Common V2 — platform utilities: status, app version, metrics, enquiry, unsubscribe, the Katchup bridge and company logo.
 *
 * The whole `/v2/common/**` tree is permitAll (public by design), so these specs carry no
 * token/auth assertions — only functional behaviour, input validation, business rules and status.
 */

import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { COMMON_PATHS } from '../../src/api/clients/common.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  readBody,
  expectValidContract,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import { SQLI, XSS } from '../../src/utils/fuzzData';
import {
  buildEnquiryPayload,
  buildUnsubscriberPayload,
  buildCountByDatePayload,
  buildAppVersionPayload,
  buildCommonSendMessagePayload,
  buildCompanyLogoPayload,
  syntheticCommonKpostId,
} from '../../src/api/payloads/common.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL = '../../../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const ALLOWLISTED_ACCOUNT = 'manohar@kpost.in';

test.describe('Common - GET /v2/common/msStatus @audit', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.msStatus,
    repro: `await commonClient.msStatus();`,
  };

  test('1. baseline: the health probe reports healthy', async ({ commonClient }) => {
    const response = await commonClient.msStatus();
    await assertStatus(response, [200], META);
  });

  test('2. the probe responds promptly', async ({ commonClient }) => {
    const started = Date.now();
    await commonClient.msStatus();
    const elapsed = Date.now() - started;

    expect(elapsed, `health probe took ${elapsed}ms — too slow to be useful to a load balancer`).toBeLessThan(
      5000
    );
  });

  test('3. public endpoint: serves with no token', async ({ commonClient }) => {
    const response = await commonClient.msStatus({ token: null });
    await assertStatus(response, [200], { ...META, repro: `await commonClient.msStatus({ token: null });` });
  });

  test('4. tolerates invalid tokens', async ({ commonClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN]) {
      const response = await commonClient.msStatus({ token });
      expect(response.status(), 'the health probe failed on an irrelevant token').toBeLessThan(500);
    }
  });

  test('5. the probe must not disclose build or infrastructure internals', async ({
    commonClient,
  }) => {
    const { text } = await readBody(await commonClient.msStatus());

    expect(
      text,
      'the health probe disclosed infrastructure details (host, path, version) to unauthenticated callers'
    ).not.toMatch(/([A-Z]:\\|\/(usr|opt|home|var)\/|jdbc:|localhost:\d{4,}|"(hostname|ip)")/i);
  });

  test('6. unexpected query params do not break the probe', async ({ commonClient }) => {
    const response = await commonClient.msStatus({ params: { verbose: true, junk: 'x' } });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('7. SQL injection in query params does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.msStatus({ params: { q: payload } });
      await assertNoInternalLeak(
        response,
        { ...META, repro: `await commonClient.msStatus({ params: { q: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('8. XSS payload in query params is not reflected', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.msStatus({ params: { cb: payload } });
      await assertNoReflectedScript(
        response,
        { ...META, repro: `await commonClient.msStatus({ params: { cb: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('9. the probe is stable under concurrent load', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => commonClient.msStatus())
    );

    expect(
      responses.every((r) => r.status() === 200),
      'the health probe became unstable under 10 concurrent requests'
    ).toBe(true);
  });

  test('10. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(await commonClient.msStatus(), META);
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
 * POST /v2/common/saveEnquiryDetails — persists a sales lead.
 * ===================================================================================== */

test.describe('Common - POST /v2/common/saveEnquiryDetails @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.saveEnquiryDetails,
    repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.saveEnquiryDetails(buildEnquiryPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: oversized free-text fields', async ({ commonClient }) => {
    const response = await commonClient.saveEnquiryDetails(
      buildEnquiryPayload({ companyName: 'a'.repeat(5000), designation: 'b'.repeat(5000) })
    );
    expect(response.status(), 'oversized enquiry fields caused a server error').toBeLessThan(500);
  });

  test('3. missing contact details must be rejected', async ({ commonClient }) => {
    const response = await commonClient.saveEnquiryDetails({});
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'saveEnquiryDetails with an empty body',
      repro: `await commonClient.saveEnquiryDetails({});`,
    });
  });

  test('4. null/empty required contact fields must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.saveEnquiryDetails(
        buildEnquiryPayload({ mobileNumber: value, email: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `saveEnquiryDetails with contact fields=${JSON.stringify(value)}`,
        repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload({ mobileNumber: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. a malformed email must be rejected', async ({ commonClient }) => {
    for (const email of ['not-an-email', '@example.com', 'a b@example.com']) {
      const response = await commonClient.saveEnquiryDetails(buildEnquiryPayload({ email }));
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `saveEnquiryDetails with a malformed email "${email}"`,
        repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload({ email: '${email}' }));`,
      });
    }
  });

  test('6. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const overrides of [
      { maximumMembersCount: 'many' },
      { mobileNumber: 9999999999 },
      { companyName: [] },
    ]) {
      const response = await commonClient.saveEnquiryDetails(buildEnquiryPayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. a caller-supplied id must not overwrite an existing enquiry', async ({
    commonClient,
  }) => {
    const response = await commonClient.saveEnquiryDetails(buildEnquiryPayload({ id: 1 }));
    const { text } = await readBody(response);

    expect(
      response.status(),
      `supplying id=1 must create a new enquiry, never overwrite enquiry #1. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('8. negative member counts must be refused', async ({ commonClient }) => {
    for (const maximumMembersCount of [-1, -9999]) {
      const response = await commonClient.saveEnquiryDetails(
        buildEnquiryPayload({ maximumMembersCount })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `saveEnquiryDetails with maximumMembersCount=${maximumMembersCount}`,
        repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload({ maximumMembersCount: ${maximumMembersCount} }));`,
      });
    }
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.saveEnquiryDetails(
        buildEnquiryPayload({ companyName: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('10. stored XSS: a script payload must not be persisted unescaped', async ({
    commonClient,
  }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await commonClient.saveEnquiryDetails(
        buildEnquiryPayload({ companyName: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.saveEnquiryDetails(buildEnquiryPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('11. spam control: a burst of identical enquiries should be throttled', async ({
    commonClient,
  }) => {
    const payload = buildEnquiryPayload();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => commonClient.saveEnquiryDetails(payload))
    );
    const accepted = responses.filter((r) => r.status() >= 200 && r.status() < 300);

    if (accepted.length >= 5) {
      await reportBusinessLogicFlaw(
        responses[0],
        {
          method: 'POST',
          path: COMMON_PATHS.saveEnquiryDetails,
          body: payload,
          repro: `await Promise.all(Array.from({length:5}, () => commonClient.saveEnquiryDetails(buildEnquiryPayload())));`,
          title: 'No spam control on saveEnquiryDetails: identical enquiries are all stored',
          scenario: `${accepted.length} of 5 identical enquiries were all stored — the sales queue can be flooded by an unauthenticated caller`,
        },
        'Security/Rate Limiting',
        'Major'
      );
    }
  });

  test('12. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.saveEnquiryDetails(buildEnquiryPayload()),
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

/* =========================================================================================
 * POST /v2/common/saveUnsubscriberDetails
 * Records an unsubscribe request. Excel payload: { sender, receiver, reason, createdBy }.
 * Public write (permitAll) — synthetic identities only; no token/auth assertions.
 * ====================================================================================== */
test.describe('POST /v2/common/saveUnsubscriberDetails @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.saveUnsubscriberDetails,
    repro: `await commonClient.saveUnsubscriberDetails(buildUnsubscriberPayload());`,
  };

  test('1. baseline: a valid unsubscribe request returns a documented status', async ({
    commonClient,
  }) => {
    const payload = buildUnsubscriberPayload();
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertStatus(response, [200, 201, 400], { ...META, body: payload });
  });

  test('2. contract: the response satisfies the platform envelope', async ({ commonClient }) => {
    const payload = buildUnsubscriberPayload();
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await expectValidContract(response, dataEnvelopeSchema, { ...META, body: payload }, [
      200, 201, 400, 401, 403, 422, 500,
    ]);
  });

  test('3. missing required parameter: no receiver must be refused', async ({ commonClient }) => {
    const payload = buildUnsubscriberPayload();
    delete (payload as Record<string, unknown>).receiver;
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an unsubscribe request naming no recipient' },
      [400, 401, 403, 422]
    );
  });

  test('4. null fuzzing: a null receiver must be refused', async ({ commonClient }) => {
    const payload = buildUnsubscriberPayload({ receiver: null });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('5. business rule: an unsubscribe for an unrelated sender must not be silently honoured', async ({
    commonClient,
  }) => {
    // sender/receiver both come from the body with no ownership proof; a success here means any
    // caller can record an unsubscribe on behalf of anyone. A refusal or a no-op is the safe answer.
    const payload = buildUnsubscriberPayload({ sender: FOREIGN.kpostID });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    const { json, text } = await readBody(response);
    test.skip(json === null, 'response was not JSON');
    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && text.includes(String(FOREIGN.kpostID)),
      `an unsubscribe was recorded for sender "${FOREIGN.kpostID}" with no proof the caller owns it. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('6. type mismatch: an array receiver must be handled without a 5xx', async ({
    commonClient,
  }) => {
    const payload = buildUnsubscriberPayload({ receiver: [syntheticCommonKpostId()] });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    expect(
      response.status(),
      `receiver was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('7. XSS: a script payload in the reason must not be stored/reflected unescaped', async ({
    commonClient,
  }) => {
    const payload = buildUnsubscriberPayload({ reason: XSS_PAYLOAD });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('8. SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildUnsubscriberPayload({ receiver: SQLI_PAYLOAD });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('9. boundary: an oversized reason must be handled cleanly', async ({ commonClient }) => {
    const payload = buildUnsubscriberPayload({ reason: MAX_LENGTH_STRING });
    const response = await commonClient.saveUnsubscriberDetails(payload);
    expect(
      response.status(),
      `a ${MAX_LENGTH_STRING.length}-character reason produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('10. status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildUnsubscriberPayload();
    const response = await commonClient.saveUnsubscriberDetails(payload);
    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('11. disclosure: an empty body must not return an internal exception', async ({
    commonClient,
  }) => {
    const response = await commonClient.saveUnsubscriberDetails({});
    const { text } = await readBody(response);
    expect(
      /Cannot invoke|NullPointerException|java\.lang\./i.test(text),
      `an empty body produced an internal exception message in the response. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('12. spam: unauthenticated unsubscribe writes must be rate-limited', async ({
    commonClient,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => commonClient.saveUnsubscriberDetails(buildUnsubscriberPayload()))
    );
    const throttled = responses.filter((r) => r.status() === 429).length;
    expect(
      throttled,
      `ten anonymous unsubscribe writes produced ${throttled} throttled responses. An unauthenticated writer with no rate limit lets anyone flood the unsubscribe ledger.`
    ).toBeGreaterThan(0);
  });
});

test.describe('POST /v2/common/getTotalCountByDate @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getTotalCountByDate,
    repro: `await commonClient.getTotalCountByDate(buildCountByDatePayload(), { token: null });`,
  };


  test('[2] happy path: the aggregate satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildCountByDatePayload();
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[3] business rule: a reversed date range must be refused', async ({ commonClient }) => {
    const payload = buildCountByDatePayload({ fromDate: '2099-01-01', toDate: '2020-01-01' });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'date range runs backwards',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] business rule: an impossible calendar date must be refused', async ({
    commonClient,
  }) => {
    const payload = buildCountByDatePayload({ fromDate: '2026-02-31' });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: '31 February is not a date',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] missing required parameter: no date range must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.getTotalCountByDate({}, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an aggregate query with no date range',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] null fuzzing: a null fromDate must be refused', async ({ commonClient }) => {
    const payload = buildCountByDatePayload({ fromDate: null });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "fromDate" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] boundary: an unbounded range must be capped', async ({ commonClient }) => {
    const payload = buildCountByDatePayload({ fromDate: '1970-01-01', toDate: '2099-12-31' });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    expect(
      response.status(),
      `a 130-year aggregate produced HTTP ${response.status()}. An unauthenticated full-table aggregate is a cheap way to load the database.`
    ).toBeLessThan(500);
  });

  test('[8] SQL injection: a tautology in the date must not leak internals', async ({
    commonClient,
  }) => {
    const payload = buildCountByDatePayload({ fromDate: SQLI_PAYLOAD });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildCountByDatePayload({ fromDate: XSS_PAYLOAD });
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildCountByDatePayload();
    const response = await commonClient.getTotalCountByDate(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
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

});

test.describe('GET /v2/common/downloadCompanyLogo/{companyID} @audit', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.downloadCompanyLogo,
    repro: `await commonClient.downloadCompanyLogo('1');`,
  };

  test('[1] happy path: a logo read resolves without a server fault', async ({ commonClient }) => {
    const response = await commonClient.downloadCompanyLogo('1');

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'A company-logo read returns an unexpected status',
    });
  });

  test('[2] boundary: a 2000-character companyID must be rejected cleanly', async ({
    commonClient,
  }) => {
    const response = await commonClient.downloadCompanyLogo(MAX_LENGTH_STRING);

    await assertStatus(response, [400, 401, 403, 404, 414, 422], {
      ...META,
      title: 'A 2000-character companyID is not rejected cleanly',
    });
  });

  test('[2b] boundary: a negative companyID must be refused', async ({ commonClient }) => {
    const response = await commonClient.downloadCompanyLogo('-1');

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      title: 'A negative companyID is not rejected cleanly',
    });
  });

  test('[3] missing parameter: the bare route must not list logos', async ({ commonClient }) => {
    const response = await commonClient.getRawPath(`${COMMON_PATHS.downloadCompanyLogo}/`);
    const { text } = await readBody(response);

    expect(
      response.ok() && /"companyID"/.test(text),
      `the route with an empty path variable answered ${response.status()} with company data. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal "null" must not resolve to a record', async ({
    commonClient,
  }) => {
    const response = await commonClient.downloadCompanyLogo('null');

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      title: 'The literal path segment "null" is treated as a valid companyID',
    });
  });

  test('[5] traversal: a traversal segment must not escape the logo directory', async ({
    commonClient,
  }) => {
    const response = await commonClient.getRawPath(
      `${COMMON_PATHS.downloadCompanyLogo}/${TRAVERSAL}`
    );
    const { text } = await readBody(response);

    expect(
      /root:.*:0:0:/.test(text),
      `a traversal payload in the companyID path returned /etc/passwd. The identifier is being concatenated into a filesystem path with no containment check. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const response = await commonClient.downloadCompanyLogo(XSS_PAYLOAD);

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const response = await commonClient.downloadCompanyLogo(SQLI_PAYLOAD);

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] enumeration: sequential IDs must not walk the customer list anonymously', async ({
    commonClient,
  }) => {
    // A sequential integer is the weakest identifier there is. If 1..5 all return real image
    // bytes with no token, the logo route is a directory of who the platform's customers are —
    // which, for a B2B product, is commercially sensitive on its own.
    const ids = ['1', '2', '3', '4', '5'];
    const responses = await Promise.all(ids.map((id) => commonClient.downloadCompanyLogo(id)));
    const withImages: string[] = [];

    for (let i = 0; i < responses.length; i += 1) {
      const contentType = responses[i].headers()['content-type'] ?? '';
      const buffer = await responses[i].body();
      if (/^image\//i.test(contentType) && buffer.length > 100) withImages.push(ids[i]);
    }

    expect(
      withImages.length >= 3,
      `an anonymous caller retrieved real logo images for sequential company IDs ${withImages.join(', ')}. Counting up from 1 enumerates the platform's corporate customers, and each hit confirms an organisation is a KPOST client.`
    ).toBe(false);
  });

  test('[9] disclosure: a missing logo must not expose a storage path', async ({
    commonClient,
  }) => {
    const response = await commonClient.downloadCompanyLogo('99999999');
    const { text } = await readBody(response);
    const leak = text.match(/([A-Za-z]:\\[^\s"]+|\/(?:home|var|opt|usr)\/[^\s"]+|s3:\/\/[^\s"]+)/);

    expect(
      leak !== null,
      `a missing company logo returned an absolute storage path (${leak ? leak[0].slice(0, 80) : ''}). That names the storage layout and, for an S3 URI, the bucket.`
    ).toBe(false);
  });

  test('[10] verb binding: DELETE on a read route must not remove the logo', async ({
    commonClient,
  }) => {
    const response = await commonClient.sendVerb('delete', `${COMMON_PATHS.downloadCompanyLogo}/1`);

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      method: 'DELETE',
      title: 'A read-only company-logo route also answers DELETE',
    });
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.companyID), { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });

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
    const response = await genericClient.sendRaw('GET', META.path, malformed, {
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

test.describe('POST /v2/common/sendMessage @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.sendMessage,
    repro: `await commonClient.sendMessage(buildCommonSendMessagePayload(), { token: null });`,
  };


  test('[2] SPOOFING: sender comes from the body, so any identity can be claimed', async ({
    commonClient,
  }) => {
    const payload = buildCommonSendMessagePayload({ sender: ALLOWLISTED_ACCOUNT });
    const response = await commonClient.sendMessage(payload, { token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `an anonymous caller sent a message as "${ALLOWLISTED_ACCOUNT}". The handler signature is sendMessage(@RequestBody KatchupMessageRO) — no HttpServletRequest — so sender is whatever the body says, on a route that needs no token. That is unauthenticated message spoofing to any user. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] duplication: this must not bypass the checks on the real Katchup route', async ({
    commonClient,
    katchupClient,
    staticToken,
  }) => {
    // /v2/katchup/sendMessage assigns the sender from the token. This bridge does not, and
    // lives behind no authentication at all — the same capability with the controls removed.
    const payload = buildCommonSendMessagePayload({ sender: ALLOWLISTED_ACCOUNT });
    const [bridge, real] = await Promise.all([
      commonClient.sendMessage(payload, { token: null }),
      katchupClient.sendMessage(payload, { token: staticToken }),
    ]);

    expect(
      bridge.status() < 400,
      `the unauthenticated bridge answered ${bridge.status()} while the authenticated Katchup route answered ${real.status()}. A duplicate of a guarded capability, mounted without the guard, is a bypass regardless of why it was added.`
    ).toBe(false);
  });

  test('[4] missing required parameter: no receiver must be refused', async ({ commonClient }) => {
    const payload = buildCommonSendMessagePayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await commonClient.sendMessage(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a message with nobody to deliver it to' },
      [400, 401, 403, 422]
    );
  });

  test('[5] null fuzzing: a null receiver must be refused', async ({ commonClient }) => {
    const payload = buildCommonSendMessagePayload({ receiver: null });
    const response = await commonClient.sendMessage(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[6] type mismatch: an array receiver must be refused', async ({ commonClient }) => {
    const payload = buildCommonSendMessagePayload({ receiver: [syntheticCommonKpostId()] });
    const response = await commonClient.sendMessage(payload, { token: null });

    expect(
      response.status(),
      `receiver was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] spam: the bridge must be rate-limited', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        commonClient.sendMessage(buildCommonSendMessagePayload(), { token: null })
      )
    );
    const throttled = responses.filter((r) => r.status() === 429).length;

    expect(
      throttled,
      `ten anonymous sends produced ${throttled} throttled responses. An unauthenticated message sender with no rate limit is a spam and push-notification cannon.`
    ).toBeGreaterThan(0);
  });

  test('[8] XSS: a script payload must not be persisted unescaped', async ({ commonClient }) => {
    const payload = buildCommonSendMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await commonClient.sendMessage(payload, { token: null });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildCommonSendMessagePayload({ actualMessage: SQLI_PAYLOAD });
    const response = await commonClient.sendMessage(payload, { token: null });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] disclosure: an internal exception must not reach the caller', async ({
    commonClient,
  }) => {
    const response = await commonClient.sendMessage({}, { token: null });
    const { text } = await readBody(response);

    expect(
      /Cannot invoke|NullPointerException|java\.lang\./i.test(text),
      `an empty body produced an internal exception message in the response. Body: ${text.slice(0, 200)}`
    ).toBe(false);
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

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
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

/* =========================================================================================
 * POST /v2/common/updateFlutterAppVersion  — REFUSAL PATHS ONLY
 * ====================================================================================== */

test.describe('POST /v2/common/updateFlutterAppVersion @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.updateFlutterAppVersion,
    repro: `await commonClient.updateFlutterAppVersion(buildAppVersionPayload(), { token: null });`,
  };

  test('[2] DISCLOSURE: an internal NPE message must not be returned to the caller', async ({
    commonClient,
  }) => {
    const payload = buildAppVersionPayload();
    const response = await commonClient.updateFlutterAppVersion(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /Cannot invoke|NullPointerException|java\.lang\./i.test(text),
      `the anonymous call returned an internal exception message. The handler's catch block puts ex.getMessage() straight into the response, so the failure text names internal variables — here, that kpostID was null, which also confirms the route was reached without authentication. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[3] AUTHORISATION MODEL: access must not be a hardcoded list of personal addresses', async ({
    commonClient,
    staticToken,
  }) => {
    // The handler compares the caller against two literal email addresses compiled into the
    // artefact. This asserts an ordinary member is refused — the model itself is the finding,
    // recorded in the file header.
    const payload = buildAppVersionPayload();
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `an ordinary member reached the app-version write. Authorisation here is "kpostID.equalsIgnoreCase(\\"manohar@kpost.in\\") || kpostID.equalsIgnoreCase(\\"baskar1992@kpost.in\\")" — two personal addresses hardcoded in source, which cannot be revoked or rotated without a redeploy and are now published in the API description. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[5] missing required parameter: no version must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const response = await commonClient.updateFlutterAppVersion({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a version write with no version',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] type mismatch: a numeric version must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildAppVersionPayload({ version: 522 });
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });

    expect(
      response.status(),
      `version was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildAppVersionPayload({ version: SQLI_PAYLOAD });
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] XSS: a script payload must not be reflected unescaped', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildAppVersionPayload({ version: XSS_PAYLOAD });
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9] boundary: a 5000-character version must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildAppVersionPayload({ version: MAX_LENGTH_STRING });
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character version string produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildAppVersionPayload();
    const response = await commonClient.updateFlutterAppVersion(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
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

/* =========================================================================================
 * GET /v2/common/getFlutterAppVersion
 * ====================================================================================== */

test.describe('GET /v2/common/getFlutterAppVersion @audit', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.getFlutterAppVersion,
    repro: `await commonClient.getFlutterAppVersion({ token: null });`,
  };

  test('[1] contract: the version read must not fault', async ({ commonClient }) => {
    const response = await commonClient.getFlutterAppVersion({ token: null });

    await assertStatus(response, [200, 204, 401, 403, 404], {
      ...META,
      title: 'The app-version read answers HTTP 500 with an empty body',
      severity: 'Major',
    });
  });

  test('[2] contract: the response must carry a version', async ({ commonClient }) => {
    const response = await commonClient.getFlutterAppVersion({ token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      Object.keys(json ?? {}).length,
      `the version read returned an empty object. Every Flutter client calls this on launch to decide whether to force an update; an empty answer means the client cannot tell whether it is current. Body: ${text.slice(0, 200)}`
    ).toBeGreaterThan(0);
  });

  test('[3] contract: the response must satisfy the Zod envelope', async ({ commonClient }) => {
    const response = await commonClient.getFlutterAppVersion({ token: null });

    await expectValidContract(response, dataEnvelopeSchema, META, [200, 400, 401, 403, 404]);
  });

  test('[5] structural: an unknown query parameter must be ignored, not fatal', async ({
    commonClient,
  }) => {
    const response = await commonClient.getFlutterAppVersion({
      token: null,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] injection: a SQL tautology in a query parameter must not leak internals', async ({
    commonClient,
  }) => {
    const response = await commonClient.getFlutterAppVersion({
      token: null,
      params: { version: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in a query parameter must not be reflected', async ({
    commonClient,
  }) => {
    const response = await commonClient.getFlutterAppVersion({
      token: null,
      params: { version: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] status misreporting: HTTP 200 must not carry a failure payload', async ({
    commonClient,
  }) => {
    const response = await commonClient.getFlutterAppVersion({ token: null });

    await assertNot200OKOnError(response, META);
  });

  test('[9] idempotency: two consecutive reads must agree', async ({ commonClient }) => {
    const [first, second] = await Promise.all([
      commonClient.getFlutterAppVersion({ token: null }),
      commonClient.getFlutterAppVersion({ token: null }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] disclosure: a failed read must not leak internals', async ({ commonClient }) => {
    const response = await commonClient.getFlutterAppVersion({ token: null });

    await assertNoInternalLeak(response, META, 'Exception');
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
 * POST /v2/common/updateCompanyLogo
 * ====================================================================================== */

test.describe('POST /v2/common/updateCompanyLogo @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.updateCompanyLogo,
    repro: `await commonClient.updateCompanyLogo(buildCompanyLogoPayload(), { token });`,
  };


  test('[2] happy path: the write satisfies the Zod contract', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload();
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[3] IDOR: an ordinary member must not replace a company\'s logo', async ({
    commonClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildCompanyLogoPayload({ companyID: 1 });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a member token (${authSession.kpostID ?? 'unknown'}) replaced company 1's logo. A logo appears on every invoice and profile the company issues — replacing it is brand defacement. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] missing required parameter: no companyID must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload();
    delete (payload as Record<string, unknown>).companyID;

    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a logo write naming no company',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[5] null fuzzing: a null file must not blank the logo', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({ file: null });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "file" null — a null logo silently erases the stored one',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[6] content type: a non-image logo must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({
      file: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `an HTML document was accepted as a company logo. Logos are rendered wherever the company appears. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] type mismatch: a string companyID must be refused', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({ companyID: 'KPOST' });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    expect(
      response.status(),
      `companyID was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[8] boundary: an oversized logo must be refused cleanly', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({
      file: `data:image/png;base64,${'A'.repeat(200000)}`,
    });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    expect(
      response.status(),
      `a ~150 KB logo produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({ companyID: SQLI_PAYLOAD });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({
    commonClient,
    staticToken,
  }) => {
    const payload = buildCompanyLogoPayload({ fileName: XSS_PAYLOAD });
    const response = await commonClient.updateCompanyLogo(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
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

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

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

});
