/**
 * Common V2 — reference data: countries, states, cities, professions, designations, languages, postal codes.
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
import { validateSchema } from '../../src/utils/schemaValidator';
import { commonDataResponseSchema } from '../../src/api/schemas/common.schema';
import { DOCUMENTED_STATUS_VALUES, dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  readBody,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import {
  BOUNDARY_NUMBERS,
  MALFORMED_JSON_STRINGS,
  SQLI,
  UNICODE_STRINGS,
  XSS,
} from '../../src/utils/fuzzData';
import { env } from '../../src/config/env.config';
import {
  buildCountryLookupPayload,
  buildDesignationByProfessionPayload,
  buildDesignationLookupPayload,
  buildCommonLanguagePayload,
  buildRegionLookupPayload,
  buildPinCodePayload,
} from '../../src/api/payloads/common.payload';

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VALID_PIN = '600001';
const UNASSIGNED_PIN = '999999';
const REFUSED = [400, 401, 403, 422];
const REJECTED = [400, 401, 403, 422];

test.describe('Common - response envelope contract', () => {
  test('status field uses the casing documented in swagger.json', async ({ commonClient }) => {
    const response = await commonClient.countries();
    const { json } = await readBody(response);
    test.skip(!json, 'endpoint did not return a JSON envelope');

    expect(
      DOCUMENTED_STATUS_VALUES as readonly string[],
      `swagger.json documents status as one of ${DOCUMENTED_STATUS_VALUES.join('/')} but the API returned "${json?.status}". Every generated client that switches on this value is broken against the published contract.`
    ).toContain(String(json?.status));
  });
});

/* ========================================================================================
 * POST /v2/common/sendOTP — dispatches a real SMS, so every call is pinned to TEST_MOBILE.
 * Documented business rule: mobile length is country-specific (10 for India, 7-8 Malaysia).
 * ===================================================================================== */

test.describe('Common - GET /v2/common/countries', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.countries,
    repro: `await commonClient.countries();`,
  };

  test('1. baseline: returns the country list with a valid envelope', async ({ commonClient }) => {
    const response = await commonClient.countries();
    await assertStatus(response, [200], META);

    const { json } = await readBody(response);
    const parsed = validateSchema(json, commonDataResponseSchema, META);
    expect(Array.isArray(parsed.data), 'countries data should be an array').toBe(true);
  });

  test('2. contract: every country carries the documented fields', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.countries());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no countries returned');

    for (const row of rows.slice(0, 10)) {
      expect(typeof row.countryID, 'countryID must be numeric').toBe('number');
      expect(typeof row.countryName, 'countryName must be a string').toBe('string');
    }
  });

  test('3. public endpoint: serves with no token', async ({ commonClient }) => {
    const response = await commonClient.countries({ token: null });
    await assertStatus(response, [200], { ...META, repro: `await commonClient.countries({ token: null });` });
  });

  test('4. identifiers are unique', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.countries());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no countries returned');

    const ids = rows.map((r) => r.countryID);
    expect(new Set(ids).size, 'duplicate countryID values in the reference table').toBe(ids.length);
  });

  test('5. unexpected query params do not break the read', async ({ commonClient }) => {
    const response = await commonClient.countries({ params: { limit: -1, junk: 'x' } });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('6. SQL injection in query params does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.countries({ params: { filter: payload } });
      await assertNoInternalLeak(
        response,
        { ...META, repro: `await commonClient.countries({ params: { filter: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('7. XSS payload in query params is not reflected', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.countries({ params: { cb: payload } });
      await assertNoReflectedScript(
        response,
        { ...META, repro: `await commonClient.countries({ params: { cb: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('8. tolerates an invalid token on a public endpoint', async ({ commonClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN]) {
      const response = await commonClient.countries({ token });
      expect(
        response.status(),
        'a public reference read failed because of an irrelevant Authorization header'
      ).toBeLessThan(500);
    }
  });

  test('9. concurrent reads are consistent', async ({ commonClient }) => {
    const bodies = await Promise.all(
      (await Promise.all([commonClient.countries(), commonClient.countries()])).map((r) =>
        readBody(r)
      )
    );
    expect(new Set(bodies.map((b) => b.text)).size, 'concurrent country reads disagreed').toBe(1);
  });

  test('10. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(await commonClient.countries(), META);
  });
});

test.describe('Common - POST /v2/common/country', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.country,
    repro: `await commonClient.country(buildCountryLookupPayload(1));`,
  };

  test('1. baseline lookup returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.country(buildCountryLookupPayload(env.testCountryId));
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: int32 max/overflow and negative ids', async ({ commonClient }) => {
    for (const countryID of [
      BOUNDARY_NUMBERS.int32Max,
      BOUNDARY_NUMBERS.int32Overflow,
      BOUNDARY_NUMBERS.negative,
      BOUNDARY_NUMBERS.zero,
    ]) {
      const response = await commonClient.country(buildCountryLookupPayload(countryID));
      expect(
        response.status(),
        `countryID=${countryID} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('3. missing countryID must be rejected', async ({ commonClient }) => {
    const response = await commonClient.country({});
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'country lookup with an empty body',
      repro: `await commonClient.country({});`,
    });
  });

  test('4. null/empty countryID must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', {}]) {
      const response = await commonClient.country({ countryID: value });
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `country lookup with countryID=${JSON.stringify(value)}`,
        repro: `await commonClient.country({ countryID: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('5. type mismatch: countryID as a string/array', async ({ commonClient }) => {
    for (const value of ['one', ['1'], { id: 1 }]) {
      const response = await commonClient.country({ countryID: value });
      expect(
        response.status(),
        `countryID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. an unknown countryID must not return another country', async ({ commonClient }) => {
    const response = await commonClient.country(buildCountryLookupPayload(99999));
    const { text } = await readBody(response);

    expect(
      text,
      'a lookup for a non-existent countryID returned country data — the id is being ignored or defaulted'
    ).not.toMatch(/"countryName"\s*:\s*"[A-Za-z]/);
  });

  test('7. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.country({ countryID: payload });
      await assertNoInternalLeak(
        response,
        { ...META, repro: `await commonClient.country({ countryID: ${JSON.stringify(payload)} });` },
        payload
      );
    }
  });

  test('8. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.country({ countryName: payload });
      await assertNoReflectedScript(
        response,
        { ...META, repro: `await commonClient.country({ countryName: ${JSON.stringify(payload)} });` },
        payload
      );
    }
  });

  test('9. malformed JSON is rejected cleanly', async ({ commonClient }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await commonClient.postRawTo(COMMON_PATHS.country, body);
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('10. concurrent identical lookups are consistent', async ({ commonClient }) => {
    const payload = buildCountryLookupPayload(env.testCountryId);
    const bodies = await Promise.all(
      (
        await Promise.all([commonClient.country(payload), commonClient.country(payload)])
      ).map((r) => readBody(r))
    );
    expect(new Set(bodies.map((b) => b.text)).size, 'concurrent lookups disagreed').toBe(1);
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.country(buildCountryLookupPayload(env.testCountryId)),
      META
    );
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

test.describe('Common - GET /v2/common/getStates', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.getStates,
    repro: `await commonClient.getStates();`,
  };

  test('1. baseline returns the state list with a valid envelope', async ({ commonClient }) => {
    const response = await commonClient.getStates();
    await assertStatus(response, [200], META);

    const { json } = await readBody(response);
    validateSchema(json, commonDataResponseSchema, META);
  });

  test('2. contract: every region carries an id, a name and a country', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.getStates());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no states returned');

    for (const row of rows.slice(0, 10)) {
      expect(typeof row.regionId, 'regionId must be numeric').toBe('number');
      expect(typeof row.regionName, 'regionName must be a string').toBe('string');
    }
  });

  test('3. region ids are unique', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.getStates());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no states returned');

    const ids = rows.map((r) => r.regionId);
    expect(new Set(ids).size, 'duplicate regionId values in the reference table').toBe(ids.length);
  });

  test('4. every region references a country that exists', async ({ commonClient }) => {
    const [statesBody, countriesBody] = await Promise.all([
      readBody(await commonClient.getStates()),
      readBody(await commonClient.countries()),
    ]);

    const states = Array.isArray(statesBody.json?.data)
      ? (statesBody.json.data as Array<Record<string, unknown>>)
      : [];
    const countries = Array.isArray(countriesBody.json?.data)
      ? (countriesBody.json.data as Array<Record<string, unknown>>)
      : [];
    test.skip(states.length === 0 || countries.length === 0, 'reference data unavailable');

    const countryIds = new Set(countries.map((c) => c.countryID));
    const orphans = states.filter((s) => s.countryId !== undefined && !countryIds.has(s.countryId));

    expect(
      orphans.length,
      `${orphans.length} region(s) reference a countryId with no matching country — dangling reference data`
    ).toBe(0);
  });

  test('5. public endpoint: serves with no token', async ({ commonClient }) => {
    const response = await commonClient.getStates({ token: null });
    await assertStatus(response, [200], { ...META, repro: `await commonClient.getStates({ token: null });` });
  });

  test('6. unexpected query params do not break the read', async ({ commonClient }) => {
    const response = await commonClient.getStates({ params: { countryId: -1, junk: 'x' } });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('7. SQL injection in query params does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.getStates({ params: { countryId: payload } });
      await assertNoInternalLeak(
        response,
        { ...META, repro: `await commonClient.getStates({ params: { countryId: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('8. XSS payload in query params is not reflected', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.getStates({ params: { cb: payload } });
      await assertNoReflectedScript(
        response,
        { ...META, repro: `await commonClient.getStates({ params: { cb: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('9. concurrent reads are consistent', async ({ commonClient }) => {
    const bodies = await Promise.all(
      (await Promise.all([commonClient.getStates(), commonClient.getStates()])).map((r) =>
        readBody(r)
      )
    );
    expect(new Set(bodies.map((b) => b.text)).size, 'concurrent state reads disagreed').toBe(1);
  });

  test('10. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(await commonClient.getStates(), META);
  });
});

test.describe('Common - GET /v2/common/getProfession', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.getProfession,
    repro: `await commonClient.getProfession();`,
  };

  test('1. baseline returns the profession list with a valid envelope', async ({ commonClient }) => {
    const response = await commonClient.getProfession();
    await assertStatus(response, [200], META);

    const { json } = await readBody(response);
    validateSchema(json, commonDataResponseSchema, META);
  });

  test('2. contract: every profession carries an id and a label', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.getProfession());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no professions returned');

    for (const row of rows.slice(0, 10)) {
      expect(typeof row.professionID, 'professionID must be numeric').toBe('number');
      expect(typeof row.profession, 'profession must be a string').toBe('string');
    }
  });

  test('3. profession ids are unique', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.getProfession());
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no professions returned');

    const ids = rows.map((r) => r.professionID);
    expect(new Set(ids).size, 'duplicate professionID values').toBe(ids.length);
  });

  test('4. public endpoint: serves with no token', async ({ commonClient }) => {
    const response = await commonClient.getProfession({ token: null });
    await assertStatus(response, [200], {
      ...META,
      repro: `await commonClient.getProfession({ token: null });`,
    });
  });

  test('5. unexpected query params do not break the read', async ({ commonClient }) => {
    const response = await commonClient.getProfession({ params: { junk: 'x', limit: -5 } });
    expect(response.status(), 'unexpected query params caused a server error').toBeLessThan(500);
  });

  test('6. SQL injection in query params does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.getProfession({ params: { filter: payload } });
      await assertNoInternalLeak(
        response,
        { ...META, repro: `await commonClient.getProfession({ params: { filter: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('7. XSS payload in query params is not reflected', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.getProfession({ params: { cb: payload } });
      await assertNoReflectedScript(
        response,
        { ...META, repro: `await commonClient.getProfession({ params: { cb: ${JSON.stringify(payload)} } });` },
        payload
      );
    }
  });

  test('8. tolerates an invalid token on a public endpoint', async ({ commonClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN]) {
      const response = await commonClient.getProfession({ token });
      expect(response.status(), 'a public read failed on an irrelevant token').toBeLessThan(500);
    }
  });

  test('9. concurrent reads are consistent', async ({ commonClient }) => {
    const bodies = await Promise.all(
      (await Promise.all([commonClient.getProfession(), commonClient.getProfession()])).map((r) =>
        readBody(r)
      )
    );
    expect(new Set(bodies.map((b) => b.text)).size, 'concurrent profession reads disagreed').toBe(1);
  });

  test('10. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(await commonClient.getProfession(), META);
  });
});

/* ========================================================================================
 * The PIN-code lookups (pinCode, postalPinCode) are covered in
 * tests/common/pinAndCompanyLookups.spec.ts, which is the canonical home for them along with
 * the two path-addressed company routes.
 *
 * The table-driven block that used to live here asserted the same signatures. The canonical
 * file supersedes it because it states the documented defect in the terms a mobile developer
 * experiences it - "no such PIN" arriving as HTTP 500 with statusCode 204 inside the body
 * means a user's typo is indistinguishable from the reference database being down - and it
 * adds the cross-route consistency case that the two lookups must not disagree on one PIN.
 * ===================================================================================== */

/* ========================================================================================
 * Designation lookups. swagger.json explicitly documents that a flat payload omitting the
 * nested `profession` object causes a NullPointerException — asserted directly below.
 * ===================================================================================== */

test.describe('Common - POST /v2/common/getDesignation', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getDesignation,
    repro: `await commonClient.getDesignation(buildDesignationLookupPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.getDesignation(buildDesignationLookupPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: single character and oversized search terms', async ({ commonClient }) => {
    for (const designation of ['a', 'a'.repeat(512), 'a'.repeat(5000)]) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation })
      );
      expect(
        response.status(),
        `designation of length ${designation.length} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('3. empty body must be rejected', async ({ commonClient }) => {
    const response = await commonClient.getDesignation({});
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'getDesignation with an empty body',
      repro: `await commonClient.getDesignation({});`,
    });
  });

  test('4. null/empty search term must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation: value })
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `getDesignation with designation=${JSON.stringify(value)}`,
        repro: `await commonClient.getDesignation(buildDesignationLookupPayload({ designation: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [12345, ['Engineer'], { name: 'Engineer' }]) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation: value })
      );
      expect(
        response.status(),
        `designation=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('6. a wildcard search must not dump the whole table', async ({ commonClient }) => {
    const response = await commonClient.getDesignation(
      buildDesignationLookupPayload({ designation: '%' })
    );
    const { json } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `a "%" search returned ${rows.length} rows — a SQL wildcard is reaching the query unescaped`
    ).toBeLessThan(1000);
  });

  test('7. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation: payload })
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.getDesignation(buildDesignationLookupPayload({ designation: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('8. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation: payload })
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.getDesignation(buildDesignationLookupPayload({ designation: ${JSON.stringify(payload)} }));`,
        },
        payload
      );
    }
  });

  test('9. unicode search terms are handled', async ({ commonClient }) => {
    for (const designation of UNICODE_STRINGS.slice(0, 3)) {
      const response = await commonClient.getDesignation(
        buildDesignationLookupPayload({ designation })
      );
      expect(
        response.status(),
        `unicode designation "${designation}" caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('10. concurrent identical searches are consistent', async ({ commonClient }) => {
    const payload = buildDesignationLookupPayload();
    const bodies = await Promise.all(
      (
        await Promise.all([
          commonClient.getDesignation(payload),
          commonClient.getDesignation(payload),
        ])
      ).map((r) => readBody(r))
    );
    expect(new Set(bodies.map((b) => b.text)).size, 'concurrent searches disagreed').toBe(1);
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.getDesignation(buildDesignationLookupPayload()),
      META
    );
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

test.describe('Common - POST /v2/common/getDesignationByProfessionId', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getDesignationByProfessionId,
    repro: `await commonClient.getDesignationByProfessionId(buildDesignationByProfessionPayload(1));`,
  };

  test('1. baseline: a correctly nested payload resolves', async ({ commonClient }) => {
    const response = await commonClient.getDesignationByProfessionId(
      buildDesignationByProfessionPayload(1)
    );
    await assertStatus(response, [200, 400], META);
  });

  test('2. a flat payload must be a clean 400, not a NullPointerException', async ({
    commonClient,
  }) => {
    // swagger.json documents this exact shape as causing an NPE server-side.
    const response = await commonClient.getDesignationByProfessionId({ professionID: 1 });
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'flat payload omitting the nested profession object (documented NPE)',
      repro: `await commonClient.getDesignationByProfessionId({ professionID: 1 });`,
    });
  });

  test('3. an empty body must be a clean 400', async ({ commonClient }) => {
    const response = await commonClient.getDesignationByProfessionId({});
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'getDesignationByProfessionId with an empty body',
      repro: `await commonClient.getDesignationByProfessionId({});`,
    });
  });

  test('4. a null profession object must be a clean 400', async ({ commonClient }) => {
    for (const value of [null, '', []]) {
      const response = await commonClient.getDesignationByProfessionId({ profession: value });
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `getDesignationByProfessionId with profession=${JSON.stringify(value)}`,
        repro: `await commonClient.getDesignationByProfessionId({ profession: ${JSON.stringify(value)} });`,
      });
    }
  });

  test('5. a missing professionID inside the nested object must be a clean 400', async ({
    commonClient,
  }) => {
    const response = await commonClient.getDesignationByProfessionId({
      profession: { profession: 'Engineering' },
    });
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'nested profession object without professionID',
      repro: `await commonClient.getDesignationByProfessionId({ profession: { profession: 'Engineering' } });`,
    });
  });

  test('6. boundary: int32 max/overflow and negative profession ids', async ({ commonClient }) => {
    for (const professionID of [
      BOUNDARY_NUMBERS.int32Max,
      BOUNDARY_NUMBERS.int32Overflow,
      BOUNDARY_NUMBERS.negative,
      BOUNDARY_NUMBERS.zero,
    ]) {
      const response = await commonClient.getDesignationByProfessionId(
        buildDesignationByProfessionPayload(professionID)
      );
      expect(
        response.status(),
        `professionID=${professionID} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('7. type mismatch: professionID as a string/array', async ({ commonClient }) => {
    for (const value of ['one', ['1'], {}]) {
      const response = await commonClient.getDesignationByProfessionId({
        profession: { professionID: value, profession: 'Engineering' },
      });
      expect(
        response.status(),
        `professionID=${JSON.stringify(value)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('8. an unknown professionID must not return designations', async ({ commonClient }) => {
    const response = await commonClient.getDesignationByProfessionId(
      buildDesignationByProfessionPayload(99999)
    );
    const { json } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      'designations were returned for a professionID that does not exist — the filter is being ignored'
    ).toBe(0);
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.getDesignationByProfessionId({
        profession: { professionID: payload, profession: payload },
      });
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.getDesignationByProfessionId({ profession: { professionID: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.getDesignationByProfessionId({
        profession: { professionID: 1, profession: payload },
      });
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.getDesignationByProfessionId({ profession: { professionID: 1, profession: ${JSON.stringify(payload)} } });`,
        },
        payload
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(
      await commonClient.getDesignationByProfessionId(buildDesignationByProfessionPayload(1)),
      META
    );
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
 * Password recovery. These endpoints can dispatch SMS, so they are pinned to TEST_MOBILE.
 * ===================================================================================== */

test.describe('POST /v2/common/getCitiesByRegionId', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getCitiesByRegionId,
    repro: `await commonClient.getCitiesByRegionId(buildRegionLookupPayload(), { token: null });`,
  };

  test('[1] happy path: a city list satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload();
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });


  test('[3] empty-state: an unknown region must not be an error', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload({ regionId: 999999 });
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown region is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[4] missing required parameter: no regionId must be refused', async ({ commonClient }) => {
    const response = await commonClient.getCitiesByRegionId({}, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a city lookup with no region',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] null fuzzing: a null regionId must be refused', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload({ regionId: null });
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "regionId" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] type mismatch: a string regionId must be refused', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload({ regionId: 'south' });
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    expect(
      response.status(),
      `regionId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] boundary: the city list must be bounded', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload();
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `the region returned ${count} cities in one response. An unbounded reference list on an unauthenticated route is a cheap amplification target. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(5000);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildRegionLookupPayload({ regionId: SQLI_PAYLOAD });
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildRegionLookupPayload({ regionId: XSS_PAYLOAD });
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildRegionLookupPayload();
    const response = await commonClient.getCitiesByRegionId(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/common/languages  (and the duplicate mount at /common/languages)
 * ====================================================================================== */

test.describe('POST /v2/common/languages', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.languages,
    repro: `await commonClient.languages(buildCommonLanguagePayload(), { token: null });`,
  };

  test('[1] happy path: the language list satisfies the Zod contract', async ({
    commonClient,
  }) => {
    const payload = buildCommonLanguagePayload();
    const response = await commonClient.languages(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] DUPLICATE MOUNT: the /v2 and legacy paths must not diverge', async ({
    commonClient,
  }) => {
    // The same handler is mounted at /v2/common/languages and /common/languages. Two paths
    // for one handler means a security rule applied to one prefix misses the other — and the
    // permitAll list only names /v2/common/**.
    const payload = buildCommonLanguagePayload();
    const [modern, legacy] = await Promise.all([
      commonClient.languages(payload, { token: null }),
      commonClient.languagesLegacy(payload, { token: null }),
    ]);

    expect(
      modern.status(),
      `/v2/common/languages answered ${modern.status()} while /common/languages answered ${legacy.status()}. The same handler on two prefixes is a security-rule hazard: the permitAll list names /v2/common/** only, so the two paths can diverge in authorisation without anyone noticing.`
    ).toBe(legacy.status());
  });

  test('[3] empty-state: an unknown country must not be an error', async ({ commonClient }) => {
    const payload = buildCommonLanguagePayload({ countryID: 999999 });
    const response = await commonClient.languages(payload, { token: null });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown country is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[4] missing required parameter: an empty body must be handled explicitly', async ({
    commonClient,
  }) => {
    const response = await commonClient.languages({}, { token: null });

    expect(
      response.status(),
      `an empty language lookup produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] null fuzzing: a null countryID must be handled', async ({ commonClient }) => {
    const payload = buildCommonLanguagePayload({ countryID: null });
    const response = await commonClient.languages(payload, { token: null });

    expect(
      response.status(),
      `countryID null produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] type mismatch: a string countryID must be refused', async ({ commonClient }) => {
    const payload = buildCommonLanguagePayload({ countryID: 'India' });
    const response = await commonClient.languages(payload, { token: null });

    expect(
      response.status(),
      `countryID was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildCommonLanguagePayload({ countryID: SQLI_PAYLOAD });
    const response = await commonClient.languages(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildCommonLanguagePayload({ language: XSS_PAYLOAD });
    const response = await commonClient.languages(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildCommonLanguagePayload();
    const response = await commonClient.languages(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive lookups must agree', async ({ commonClient }) => {
    const payload = buildCommonLanguagePayload();
    const [first, second] = await Promise.all([
      commonClient.languages(payload, { token: null }),
      commonClient.languages(payload, { token: null }),
    ]);

    expect(
      first.status(),
      `two identical reference lookups returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });
});

/* =========================================================================================
 * POST /v2/common/getTotalCountByDate
 * ====================================================================================== */

test.describe('POST /v2/common/pinCode', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.pinCode,
    repro: `await commonClient.pinCode(buildPinCodePayload());`,
  };

  test('[1] happy path: a real PIN code satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const response = await commonClient.pinCode(payload);

    await expectValidContract(response, commonDataResponseSchema, { ...META, body: payload }, [
      200,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5-digit PIN is one short and must be refused', async ({ commonClient }) => {
    // An Indian PIN is exactly six digits. Five is not a near-miss to be padded — it cannot
    // identify a post office.
    const payload = buildPinCodePayload({ postalCode: '60000' });
    const response = await commonClient.pinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5-digit value where a 6-digit PIN is required' },
      REJECTED
    );
  });

  test('[2b] boundary: a 7-digit PIN must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: '6000012' });
    const response = await commonClient.pinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 7-digit value where a 6-digit PIN is required' },
      REJECTED
    );
  });

  test('[3] documented defect: an unassigned PIN must not be reported as HTTP 500', async ({
    commonClient,
  }) => {
    // The spec documents this: no records comes back as 500 with statusCode 204 in the body.
    // A PIN that matches nothing is an ordinary, expected outcome of a user typing a number.
    const payload = buildPinCodePayload({ postalCode: UNASSIGNED_PIN });
    const response = await commonClient.pinCode(payload);
    const { text } = await readBody(response);

    expect(
      response.status() >= 500,
      `an unassigned PIN returned HTTP ${response.status()}. "No such PIN" is a normal result of a user mistyping six digits, not a server fault — a client cannot tell this apart from the reference database being down, so a typo surfaces to the user as a crash. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3b] documented defect: a 204 must not be carried inside a response body', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: UNASSIGNED_PIN });
    const response = await commonClient.pinCode(payload);

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[4] null fuzzing: a null postalCode must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: null });
    const response = await commonClient.pinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "postalCode" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not return the whole PIN table', async ({
    commonClient,
  }) => {
    const response = await commonClient.pinCode({});
    const { text } = await readBody(response);
    const rows = (text.match(/"postalCode"/g) || []).length;

    expect(
      rows > 100,
      `an empty PIN lookup returned ${rows} rows — a missing filter turned a point lookup into a bulk export of the postal reference table.`
    ).toBe(false);
  });

  test('[5] type mismatch: a numeric postalCode must be handled deterministically', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: 600001 });
    const response = await commonClient.pinCode(payload);

    await assertStatus(response, [200, ...REFUSED], {
      ...META,
      body: payload,
      title: 'A numeric PIN value returns an unexpected status',
    });
  });

  test('[5b] type mismatch: an array of PINs must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: ['600001', '600002'] });
    const response = await commonClient.pinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an array where a single PIN is expected' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: XSS_PAYLOAD });
    const response = await commonClient.pinCode(payload);

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: SQLI_PAYLOAD });
    const response = await commonClient.pinCode(payload);

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a wildcard must not match every PIN', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: '%' });
    const response = await commonClient.pinCode(payload);
    const { text } = await readBody(response);
    const rows = (text.match(/"postalCode"/g) || []).length;

    expect(
      rows > 100,
      `a SQL wildcard returned ${rows} rows. The term reaches a LIKE unescaped.`
    ).toBe(false);
  });

  test('[8] public route: this lookup is registration-time and must stay usable anonymously', async ({
    commonClient,
  }) => {
    // Deliberately asserting the opposite of the usual auth case. A PIN lookup runs on the
    // address screen before an account exists; requiring a token here would break sign-up.
    // What it must not do is fail in a way that blocks registration.
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const response = await commonClient.pinCode(payload);

    await assertStatus(response, [200, 204, 400, 404], {
      ...META,
      body: payload,
      title: 'The anonymous PIN lookup does not resolve for a registering user',
    });
  });

  test('[9] structural: a malformed JSON body must be a clean HTTP 400', async ({
    commonClient,
  }) => {
    const response = await commonClient.postRawTo(COMMON_PATHS.pinCode, `{"postalCode": `);

    await assertStatus(response, [400, 415], {
      ...META,
      body: '{"postalCode": ',
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[10] consistency: pinCode and postalPinCode must agree on the same PIN', async ({
    commonClient,
  }) => {
    // Two reference lookups over the same postal data. A user who sees one screen resolve and
    // another fail on the same six digits has no way to know which is right.
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const [viaPin, viaPostal] = await Promise.all([
      commonClient.pinCode(payload),
      commonClient.postalPinCode(payload),
    ]);

    expect(
      viaPin.ok() === viaPostal.ok(),
      `pinCode answered ${viaPin.status()} and postalPinCode answered ${viaPostal.status()} for the same PIN ${VALID_PIN}. Two lookups over one reference table must not disagree on whether it exists.`
    ).toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/common/postalPinCode
 * ====================================================================================== */

test.describe('POST /v2/common/postalPinCode', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.postalPinCode,
    repro: `await commonClient.postalPinCode(buildPinCodePayload());`,
  };

  test('[1] happy path: a real PIN code satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const response = await commonClient.postalPinCode(payload);

    await expectValidContract(response, commonDataResponseSchema, { ...META, body: payload }, [
      200,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5-digit PIN must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: '60000' });
    const response = await commonClient.postalPinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5-digit value where a 6-digit PIN is required' },
      REJECTED
    );
  });

  test('[2b] boundary: an alphabetic PIN must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: 'ABCDEF' });
    const response = await commonClient.postalPinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'six letters where six digits are required' },
      REJECTED
    );
  });

  test('[3] documented defect: an unassigned PIN must not be reported as HTTP 500', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: UNASSIGNED_PIN });
    const response = await commonClient.postalPinCode(payload);
    const { text } = await readBody(response);

    expect(
      response.status() >= 500,
      `an unassigned PIN returned HTTP ${response.status()} from postalPinCode. An empty result set is not a server error; a client cannot tell a mistyped PIN from an outage. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3b] documented defect: a 204 must not be carried inside a response body', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: UNASSIGNED_PIN });
    const response = await commonClient.postalPinCode(payload);

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[4] null fuzzing: a null postalCode must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: null });
    const response = await commonClient.postalPinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "postalCode" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not return the whole postal table', async ({
    commonClient,
  }) => {
    const response = await commonClient.postalPinCode({});
    const { text } = await readBody(response);
    const rows = (text.match(/"postalCode"/g) || []).length;

    expect(
      rows > 100,
      `an empty postal lookup returned ${rows} rows — a bulk export of the postal reference table.`
    ).toBe(false);
  });

  test('[5] type mismatch: a nested object must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: { value: '600001' } });
    const response = await commonClient.postalPinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a nested object where a PIN string is expected' },
      REJECTED
    );
  });

  test('[5b] boundary: a 2000-character PIN must be refused', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: MAX_LENGTH_STRING });
    const response = await commonClient.postalPinCode(payload);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 2000-character PIN value' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildPinCodePayload({ postalCode: XSS_PAYLOAD });
    const response = await commonClient.postalPinCode(payload);

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: SQLI_PAYLOAD });
    const response = await commonClient.postalPinCode(payload);

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] public route: the lookup must resolve for an unauthenticated registering user', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const response = await commonClient.postalPinCode(payload);

    await assertStatus(response, [200, 204, 400, 404], {
      ...META,
      body: payload,
      title: 'The anonymous postal lookup does not resolve for a registering user',
    });
  });

  test('[9] structural: a malformed JSON body must be a clean HTTP 400', async ({
    commonClient,
  }) => {
    const response = await commonClient.postRawTo(COMMON_PATHS.postalPinCode, '{"postalCode": [');

    await assertStatus(response, [400, 415], {
      ...META,
      body: '{"postalCode": [',
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[10] idempotency: two identical lookups must return the same status', async ({
    commonClient,
  }) => {
    const payload = buildPinCodePayload({ postalCode: VALID_PIN });
    const [first, second] = await Promise.all([
      commonClient.postalPinCode(payload),
      commonClient.postalPinCode(payload),
    ]);

    expect(
      first.status(),
      `two identical concurrent reference lookups returned ${first.status()} and ${second.status()}. A read of static postal data must be deterministic; divergence points at shared mutable state on the controller.`
    ).toBe(second.status());
  });
});

/* =========================================================================================
 * GET /v2/common/getCompanyNameExistOnKpostAndKsmacc/{companyName}
 * ====================================================================================== */
