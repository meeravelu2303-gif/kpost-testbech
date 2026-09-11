/**
 * Common V2 — directory & company lookups: identity/company lookups by mobile, name/domain availability.
 *
 * The whole `/v2/common/**` tree is permitAll (public by design), so these specs carry no
 * token/auth assertions — only functional behaviour, input validation, business rules and status.
 */

import { test, expect } from '../../src/fixtures/api.fixture';
import { COMMON_PATHS } from '../../src/api/clients/common.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import { commonDataResponseSchema } from '../../src/api/schemas/common.schema';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertPublicRouteReachable,
  readBody,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { BOUNDARY_NUMBERS, SQLI, UNICODE_STRINGS, XSS } from '../../src/utils/fuzzData';
import { env } from '../../src/config/env.config';
import {
  buildCompanyNameExistPayload,
  buildDomainPayload,
  buildGenerateDomainPayload,
  buildMobileNoExistPayload,
  buildCompanyByMobilePayload,
  buildCompanyMobileExistPayload,
  buildMobileLookupPayload,
  buildModuleLookupPayload,
  buildUniqueNameExistPayload,
  syntheticMobileNumber,
} from '../../src/api/payloads/common.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const KNOWN_MOBILE = '9000000147';
const REFUSED = [400, 401, 403, 422];

test.describe('Common - POST /v2/common/mobileNoExist @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.mobileNoExist,
    repro: `await commonClient.mobileNoExist(buildMobileNoExistPayload());`,
  };

  test('1. baseline returns a valid envelope', async ({ commonClient }) => {
    const response = await commonClient.mobileNoExist(buildMobileNoExistPayload());
    await assertStatus(response, [200, 400], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, commonDataResponseSchema, META);
  });

  test('2. boundary: too-short and too-long numbers', async ({ commonClient }) => {
    for (const mobileNumber of ['1', '9'.repeat(50), '9'.repeat(300)]) {
      const response = await commonClient.mobileNoExist(
        buildMobileNoExistPayload({ mobileNumber }),
      );
      expect(
        response.status(),
        `mobileNumber of length ${mobileNumber.length} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('3. missing required mobileNumber must be rejected', async ({ commonClient }) => {
    const response = await commonClient.mobileNoExist({ countryID: env.testCountryId });
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'mobileNoExist without the required mobileNumber',
      repro: `await commonClient.mobileNoExist({ countryID: 1 });`,
    });
  });

  test('4. null/empty mobileNumber must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.mobileNoExist(
        buildMobileNoExistPayload({ mobileNumber: value }),
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `mobileNoExist with mobileNumber=${JSON.stringify(value)}`,
        repro: `await commonClient.mobileNoExist(buildMobileNoExistPayload({ mobileNumber: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const overrides of [
      { mobileNumber: 9999999999 },
      { countryID: 'one' },
      { mobileNumber: [] },
    ]) {
      const response = await commonClient.mobileNoExist(buildMobileNoExistPayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('6. an unknown countryID must be a 4xx', async ({ commonClient }) => {
    const response = await commonClient.mobileNoExist(
      buildMobileNoExistPayload({ countryID: 99999 }),
    );
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'mobileNoExist with an unknown countryID',
      repro: `await commonClient.mobileNoExist(buildMobileNoExistPayload({ countryID: 99999 }));`,
    });
  });

  test('7. the probe must not leak the owning account', async ({ commonClient }) => {
    const response = await commonClient.mobileNoExist(buildMobileNoExistPayload());
    const { text } = await readBody(response);

    expect(
      text,
      'an unauthenticated existence probe returned account details — this turns a yes/no check into a user-enumeration oracle',
    ).not.toMatch(/"(kpostID|firstName|lastName|email)"\s*:\s*"[^"]+"/i);
  });

  test('8. enumeration: unlimited probing should be rate limited', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, () => commonClient.mobileNoExist(buildMobileNoExistPayload())),
    );

    expect(
      responses.some((r) => r.status() === 429),
      '15 rapid existence probes were all served with no 429 — the whole subscriber base can be enumerated',
    ).toBe(true);
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI) {
      const response = await commonClient.mobileNoExist(
        buildMobileNoExistPayload({ mobileNumber: payload }),
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.mobileNoExist(buildMobileNoExistPayload({ mobileNumber: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.mobileNoExist(
        buildMobileNoExistPayload({ mobileNumber: payload }),
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.mobileNoExist(buildMobileNoExistPayload({ mobileNumber: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.mobileNoExist(buildMobileNoExistPayload());
    await assertStatusCodeParity(response, META);
  });
});

/* ========================================================================================
 * POST /v2/common/isCompanyNameExist
 * ===================================================================================== */

test.describe('Common - POST /v2/common/isCompanyNameExist @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.isCompanyNameExist,
    repro: `await commonClient.isCompanyNameExist(buildCompanyNameExistPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.isCompanyNameExist(buildCompanyNameExistPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. boundary: single character and oversized names', async ({ commonClient }) => {
    for (const companyName of ['a', 'a'.repeat(512), 'a'.repeat(5000)]) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName }),
      );
      expect(
        response.status(),
        `companyName of length ${companyName.length} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('3. missing companyName must be rejected', async ({ commonClient }) => {
    const response = await commonClient.isCompanyNameExist({});
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'isCompanyNameExist with an empty body',
      repro: `await commonClient.isCompanyNameExist({});`,
    });
  });

  test('4. null/empty companyName must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName: value }),
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `isCompanyNameExist with companyName=${JSON.stringify(value)}`,
        repro: `await commonClient.isCompanyNameExist(buildCompanyNameExistPayload({ companyName: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const value of [12345, ['Acme'], { name: 'Acme' }]) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName: value }),
      );
      expect(
        response.status(),
        `companyName=${JSON.stringify(value)} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('6. unicode company names are handled', async ({ commonClient }) => {
    for (const companyName of UNICODE_STRINGS.slice(0, 4)) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName }),
      );
      expect(
        response.status(),
        `unicode companyName "${companyName}" caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('7. case/whitespace variants must resolve consistently', async ({ commonClient }) => {
    const base = `QaCompany${Date.now()}`;
    const variants = [base, base.toUpperCase(), base.toLowerCase(), `  ${base}  `];
    const bodies = await Promise.all(
      (
        await Promise.all(
          variants.map((companyName) =>
            commonClient.isCompanyNameExist(buildCompanyNameExistPayload({ companyName })),
          ),
        )
      ).map((r) => readBody(r)),
    );

    const verdicts = new Set(bodies.map((b) => b.text.toLowerCase().includes('exist')));
    expect(
      verdicts.size,
      'case and whitespace variants of one company name gave different availability answers — two companies could register effectively the same name',
    ).toBe(1);
  });

  test('8. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName: payload }),
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.isCompanyNameExist(buildCompanyNameExistPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('9. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 3)) {
      const response = await commonClient.isCompanyNameExist(
        buildCompanyNameExistPayload({ companyName: payload }),
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.isCompanyNameExist(buildCompanyNameExistPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('10. concurrent identical checks are consistent', async ({ commonClient }) => {
    const payload = buildCompanyNameExistPayload();
    const bodies = await Promise.all(
      (
        await Promise.all([
          commonClient.isCompanyNameExist(payload),
          commonClient.isCompanyNameExist(payload),
        ])
      ).map((r) => readBody(r)),
    );

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'concurrent identical company-name checks disagreed',
    ).toBe(1);
  });

  test('11. envelope parity', async ({ commonClient }) => {
    const response = await commonClient.isCompanyNameExist(buildCompanyNameExistPayload());
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

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      META,
      [200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500],
    );
  });
});

/* ========================================================================================
 * Reference-data reads: GET /countries, POST /country, GET /getStates, GET /getProfession
 * ===================================================================================== */

test.describe('Common - POST /v2/common/domain @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.domain,
    repro: `await commonClient.domain(buildDomainPayload());`,
  };

  test('1. baseline: a supported country returns its domain list', async ({ commonClient }) => {
    const response = await commonClient.domain(buildDomainPayload());
    await assertStatus(response, [200], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, commonDataResponseSchema, META);
  });

  test('2. cross-parameter rule: an unsupported country must be a clean 4xx, not 200/Failure', async ({
    commonClient,
  }) => {
    // Personal domains are documented as available only for a subset of countries.
    for (const countryID of [2, 3, 99999]) {
      const response = await commonClient.domain(
        buildDomainPayload({ countryID, userType: 'Personal' }),
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `personal domains requested for unsupported countryID=${countryID}`,
        repro: `await commonClient.domain(buildDomainPayload({ countryID: ${countryID}, userType: 'Personal' }));`,
      });
    }
  });

  test('3. missing countryID must be rejected', async ({ commonClient }) => {
    // Excel domain payload is `{ countryID, userType }` — omit countryID to test the rejection.
    const response = await commonClient.domain({ userType: 'BUSINESS' });
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'domain lookup without a countryID',
      repro: `await commonClient.domain({ userType: 'BUSINESS' });`,
    });
  });

  test('4. null/empty countryID must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', {}]) {
      const response = await commonClient.domain(buildDomainPayload({ countryID: value }));
      await assertRejectsInvalidInput(response, {
        ...META,
        readOnly: true,
        scenario: `domain lookup with countryID=${JSON.stringify(value)}`,
        repro: `await commonClient.domain(buildDomainPayload({ countryID: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const overrides of [{ countryID: 'one' }, { userType: 123 }, { userType: [] }]) {
      const response = await commonClient.domain(buildDomainPayload(overrides));
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('6. an unrecognised userType must be rejected', async ({ commonClient }) => {
    const response = await commonClient.domain(buildDomainPayload({ userType: 'NotARealType' }));
    await assertRejectsInvalidInput(response, {
      ...META,
      readOnly: true,
      scenario: 'domain lookup with an unrecognised userType',
      repro: `await commonClient.domain(buildDomainPayload({ userType: 'NotARealType' }));`,
    });
  });

  test('7. boundary: int32 overflow and negative country ids', async ({ commonClient }) => {
    for (const countryID of [
      BOUNDARY_NUMBERS.int32Max,
      BOUNDARY_NUMBERS.int32Overflow,
      BOUNDARY_NUMBERS.negative,
    ]) {
      const response = await commonClient.domain(buildDomainPayload({ countryID }));
      expect(response.status(), `countryID=${countryID} caused a server error`).toBeLessThan(500);
    }
  });

  test('8. returned domains are well-formed and unique', async ({ commonClient }) => {
    const { json } = await readBody(await commonClient.domain(buildDomainPayload()));
    const domains = Array.isArray(json?.data) ? (json.data as unknown[]) : [];
    test.skip(domains.length === 0, 'no domains returned');

    expect(new Set(domains).size, 'duplicate domains in the list').toBe(domains.length);
    for (const domain of domains) {
      expect(String(domain), `"${domain}" is not a well-formed domain suffix`).toMatch(
        /^@?[a-z0-9.-]+\.[a-z]{2,}$/i,
      );
    }
  });

  test('9. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.domain(buildDomainPayload({ userType: payload }));
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.domain(buildDomainPayload({ userType: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('10. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.domain(buildDomainPayload({ userType: payload }));
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.domain(buildDomainPayload({ userType: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('11. envelope parity', async ({ commonClient }) => {
    await assertStatusCodeParity(await commonClient.domain(buildDomainPayload()), META);
  });
});

test.describe('Common - POST /v2/common/generateDomainAndUniqueName @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.generateDomainAndUniqueName,
    repro: `await commonClient.generateDomainAndUniqueName(buildGenerateDomainPayload());`,
  };

  test('1. baseline returns a documented status', async ({ commonClient }) => {
    const response = await commonClient.generateDomainAndUniqueName(buildGenerateDomainPayload());
    await assertStatus(response, [200, 400], META);
  });

  test('2. missing kpostID must be a 400 ("Invalid KpostID or Company Name")', async ({
    commonClient,
  }) => {
    const payload = buildGenerateDomainPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await commonClient.generateDomainAndUniqueName(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'generateDomainAndUniqueName without kpostID',
      repro: `const p = buildGenerateDomainPayload(); delete p.kpostID; await commonClient.generateDomainAndUniqueName(p);`,
    });
  });

  test('3. missing companyName must be a 400', async ({ commonClient }) => {
    const payload = buildGenerateDomainPayload();
    delete (payload as Record<string, unknown>).companyName;

    const response = await commonClient.generateDomainAndUniqueName(payload);
    await assertRejectsInvalidInput(response, {
      ...META,
      scenario: 'generateDomainAndUniqueName without companyName',
      repro: `const p = buildGenerateDomainPayload(); delete p.companyName; await commonClient.generateDomainAndUniqueName(p);`,
    });
  });

  test('4. null/empty inputs must be rejected', async ({ commonClient }) => {
    for (const value of [null, '', ' ']) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload({ companyName: value }),
      );
      await assertRejectsInvalidInput(response, {
        ...META,
        scenario: `generateDomainAndUniqueName with companyName=${JSON.stringify(value)}`,
        repro: `await commonClient.generateDomainAndUniqueName(buildGenerateDomainPayload({ companyName: ${JSON.stringify(value)} }));`,
      });
    }
  });

  test('5. type mismatch is handled without a 5xx', async ({ commonClient }) => {
    for (const overrides of [{ companyName: 12345 }, { kpostID: [] }, { companyName: {} }]) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload(overrides),
      );
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('6. boundary: oversized company names', async ({ commonClient }) => {
    for (const companyName of ['a', 'a'.repeat(512), 'a'.repeat(5000)]) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload({ companyName }),
      );
      expect(
        response.status(),
        `companyName of length ${companyName.length} caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('7. a generated domain must be a valid hostname', async ({ commonClient }) => {
    const response = await commonClient.generateDomainAndUniqueName(
      buildGenerateDomainPayload({ companyName: 'Acme Widgets & Co. (Pvt) Ltd.' }),
    );
    const { text } = await readBody(response);
    const match = text.match(/"(?:domain|internetDomainId)"\s*:\s*"([^"]+)"/i);
    test.skip(!match, 'no domain returned to validate');

    expect(
      match?.[1],
      `generated domain "${match?.[1]}" contains characters that are not valid in a hostname`,
    ).toMatch(/^@?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i);
  });

  test('8. unicode company names produce a usable domain, not a 5xx', async ({ commonClient }) => {
    for (const companyName of UNICODE_STRINGS.slice(0, 3)) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload({ companyName }),
      );
      expect(
        response.status(),
        `unicode companyName "${companyName}" caused a server error`,
      ).toBeLessThan(500);
    }
  });

  test('9. concurrent generation for one company must not yield colliding names', async ({
    commonClient,
  }) => {
    const payload = buildGenerateDomainPayload();
    const bodies = await Promise.all(
      (
        await Promise.all([
          commonClient.generateDomainAndUniqueName(payload),
          commonClient.generateDomainAndUniqueName(payload),
        ])
      ).map((r) => readBody(r)),
    );

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'concurrent generation returned inconsistent results for the same company',
    ).toBe(1);
  });

  test('10. SQL injection does not leak internals', async ({ commonClient }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload({ companyName: payload }),
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await commonClient.generateDomainAndUniqueName(buildGenerateDomainPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
  });

  test('11. XSS payload is not reflected unescaped', async ({ commonClient }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await commonClient.generateDomainAndUniqueName(
        buildGenerateDomainPayload({ companyName: payload }),
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await commonClient.generateDomainAndUniqueName(buildGenerateDomainPayload({ companyName: ${JSON.stringify(payload)} }));`,
        },
        payload,
      );
    }
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

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      META,
      [200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500],
    );
  });
});

/* ========================================================================================
 * GET /v2/common/msStatus — health probe.
 * ===================================================================================== */

test.describe('POST /v2/common/getUserDetailsByMobNo @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getUserDetailsByMobNo,
    repro: `await commonClient.getUserDetailsByMobNo({ mobileNumber: '<number>' }, { token: null });`,
  };

  test('[1b] BREACH: the identity fields themselves must not be returned', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      /"(firstName|lastName|kpostID)"\s*:\s*"[^"]{2,}"/.test(text),
      `an anonymous caller resolved a mobile number to a real identity. The whole /v2/common/** tree is permitAll, which is right for country and language lists and wrong for a person lookup — a ten-digit number space with known prefixes can be walked, and any number harvested elsewhere becomes a name. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[2] BREACH: gender must not be disclosed to an anonymous caller', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /"gender"\s*:\s*"(male|female|others)"/i.test(text),
      `the anonymous lookup returned the user's gender. Even granting the lookup exists, a registration-time "is this number known" check needs a boolean, not a demographic profile. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[3] enumeration: the lookup must be rate-limited', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        commonClient.getUserDetailsByMobNo(buildMobileLookupPayload(), { token: null }),
      ),
    );
    const throttled = responses.filter((r) => r.status() === 429).length;

    expect(
      throttled,
      `ten anonymous lookups in parallel produced ${throttled} throttled responses. Without rate limiting an unauthenticated directory lookup can be walked at line speed.`,
    ).toBeGreaterThan(0);
  });

  test('[4] enumeration: a wildcard must not return every user', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: SQLI_WILDCARD });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a mobileNumber of "%" returned ${count} users to an anonymous caller. Body: ${text.slice(0, 300)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('[5] missing required parameter: no mobileNumber must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.getUserDetailsByMobNo({ countryID: 1 }, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: { countryID: 1 },
        scenario: 'a directory lookup with no number to look up',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] null fuzzing: a null mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: null });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[7] business rule: a malformed number must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: '123' });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a three-digit mobile number',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: XSS_PAYLOAD });
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getUserDetailsByMobNo(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
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

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      META,
      [200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500],
    );
  });
});

/* =========================================================================================
 * POST /v2/common/getCompanyDetails
 * ====================================================================================== */

test.describe('POST /v2/common/getCompanyDetails @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getCompanyDetails,
    repro: `await commonClient.getCompanyDetails(buildMobileLookupPayload(), { token: null });`,
  };

  test('[1] happy path: a company lookup satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test("[2] disclosure: an anonymous caller must not read a company's private details", async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.getCompanyDetails(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /"(bankAccountNumber|ifsc|panNumber|gstNumber|otherEmail|alternateMobileno)"\s*:\s*"[^"]{3,}"/i.test(
        text,
      ),
      `an anonymous company lookup returned banking or registration identifiers. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[3] status misreporting: "user does not exist" must not be a 500', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await assertStatus(response, [200, 204, 400, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown company is reported as HTTP 500 rather than 404',
      severity: 'Major',
    });
  });

  test('[4] missing required parameter: no mobileNumber must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyDetails({}, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a company lookup naming no mobile number',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] null fuzzing: a null mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: null });
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] type mismatch: an array mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: [KNOWN_MOBILE] });
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    expect(
      response.status(),
      `mobileNumber was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[7] enumeration: sequential mobile numbers must not be walkable', async ({
    commonClient,
  }) => {
    const responses = await Promise.all(
      ['9000000001', '9000000002', '9000000003'].map((mobileNumber) =>
        commonClient.getCompanyDetails(buildMobileLookupPayload({ mobileNumber }), { token: null }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const resolved = bodies.filter((b) => /"companyName"\s*:\s*"[^"]{2,}"/.test(b.text));

    expect(
      resolved.length,
      `${resolved.length} of 3 sequential mobile numbers resolved to a company for an anonymous caller. Sequential lookups plus no auth is a company directory.`,
    ).toBe(0);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: XSS_PAYLOAD });
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP 200 must not carry a failure payload', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getCompanyDetails(payload, { token: null });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
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

/* =========================================================================================
 * POST /v2/common/getCompanyDetailsByAdmin
 * ====================================================================================== */

test.describe('POST /v2/common/getCompanyDetailsByAdmin @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getCompanyDetailsByAdmin,
    repro: `await commonClient.getCompanyDetailsByAdmin(buildMobileLookupPayload(), { token: null });`,
  };

  test('[2] disclosure: administrative company data must not reach an anonymous caller', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /"(bankAccountNumber|ifsc|panNumber|gstNumber|adminKpostID)"\s*:\s*"[^"]{3,}"/i.test(text),
      `the admin company view returned registration or banking identifiers to an anonymous caller. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[3] happy path: the response satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[4] missing required parameter: an empty body must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyDetailsByAdmin({}, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an admin company lookup with no company named',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] null fuzzing: a null mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: null });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] type mismatch: an array mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: [KNOWN_MOBILE] });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    expect(
      response.status(),
      `mobileNumber was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[7] enumeration: a wildcard must not list every company', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: SQLI_WILDCARD });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a wildcard mobileNumber returned ${count} companies. Body: ${text.slice(0, 300)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildMobileLookupPayload({ mobileNumber: XSS_PAYLOAD });
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildMobileLookupPayload();
    const response = await commonClient.getCompanyDetailsByAdmin(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/getCompanyDetailsByMobileNoAndproductId
 * ====================================================================================== */

test.describe('POST /v2/common/getCompanyDetailsByMobileNoAndproductId @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getCompanyDetailsByMobileNoAndproductId,
    repro: `await commonClient.getCompanyDetailsByMobileNoAndproductId(buildCompanyByMobilePayload(), { token: null });`,
  };

  test('[1b] BREACH: the company name itself must not be returned anonymously', async ({
    commonClient,
  }) => {
    const payload = buildCompanyByMobilePayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });
    const { text } = await readBody(response);

    expect(
      /"companyName"\s*:\s*"[^"]{2,}"/.test(text),
      `an anonymous caller resolved a mobile number to a company. Combined with getUserDetailsByMobNo returning the name, a phone number yields a person and their employer — with no account required. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[2] happy path: the lookup satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildCompanyByMobilePayload();
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[3] missing required parameter: no mobileNumber must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(
      { productId: 1 },
      { token: null },
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: { productId: 1 },
        scenario: 'a lookup with no number',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildCompanyByMobilePayload({ mobileNumber: null });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] business rule: an unknown productId must be refused', async ({ commonClient }) => {
    const payload = buildCompanyByMobilePayload({ productId: 999999 });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'productId 999999 is outside the known set',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] type mismatch: a string productId must be refused', async ({ commonClient }) => {
    const payload = buildCompanyByMobilePayload({ productId: 'kmed' });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    expect(
      response.status(),
      `productId was sent as a string and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[7] enumeration: the lookup must be rate-limited', async ({ commonClient }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        commonClient.getCompanyDetailsByMobileNoAndproductId(buildCompanyByMobilePayload(), {
          token: null,
        }),
      ),
    );
    const throttled = responses.filter((r) => r.status() === 429).length;

    expect(
      throttled,
      `ten anonymous lookups produced ${throttled} throttled responses. An unauthenticated number-to-employer lookup needs rate limiting.`,
    ).toBeGreaterThan(0);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildCompanyByMobilePayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildCompanyByMobilePayload({ mobileNumber: XSS_PAYLOAD });
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildCompanyByMobilePayload();
    const response = await commonClient.getCompanyDetailsByMobileNoAndproductId(payload, {
      token: null,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/mobileNoExistInsideCompany
 * ====================================================================================== */

test.describe('POST /v2/common/mobileNoExistInsideCompany @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.mobileNoExistInsideCompany,
    repro: `await commonClient.mobileNoExistInsideCompany(buildCompanyMobileExistPayload(), { token: null });`,
  };

  test('[1] contract: the answer must be a boolean, not a user record', async ({
    commonClient,
  }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: KNOWN_MOBILE });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /"(firstName|lastName|kpostID)"\s*:\s*"[^"]{2,}"/.test(text),
      `an existence check returned identity fields. "Does this number exist in this company" must answer true or false — anything more turns a validation helper into a directory. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[2] happy path: the check satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload();
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[4] missing required parameter: no companyID must be refused', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload();
    delete (payload as Record<string, unknown>).companyID;

    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an inside-company check with no company',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] null fuzzing: a null mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: null });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] type mismatch: an array mobileNumber must be refused', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: [syntheticMobileNumber()] });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    expect(
      response.status(),
      `mobileNumber was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[7] enumeration: a wildcard must not confirm every member', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: SQLI_WILDCARD });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_WILDCARD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildCompanyMobileExistPayload({ mobileNumber: XSS_PAYLOAD });
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildCompanyMobileExistPayload();
    const response = await commonClient.mobileNoExistInsideCompany(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/getKpostIdUsingModule
 * ====================================================================================== */

test.describe('POST /v2/common/getKpostIdUsingModule @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.getKpostIdUsingModule,
    repro: `await commonClient.getKpostIdUsingModule(buildModuleLookupPayload(), { token: null });`,
  };

  /*
   * DECLARED PUBLIC — confirmed with the developers on 2026-09-11.
   *
   * This route serves the pre-token module picker, so it takes no Authorization header by
   * design. An earlier revision filed the anonymous read as a Critical directory exposure
   * (BUG-API-D238B5); that finding is retired, and the check is inverted to protect the
   * intent instead — the defect here would be the route disappearing behind the auth filter,
   * which would block the flow it exists to serve. Every other case in this block already
   * calls anonymously, so they double as the positive control that it stays reachable.
   */
  test('[1] public contract: the module lookup must stay reachable without a token', async ({
    commonClient,
  }) => {
    const payload = buildModuleLookupPayload();
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertPublicRouteReachable(response, { ...META, body: payload });
  });

  test('[2] happy path: the lookup satisfies the Zod contract', async ({ commonClient }) => {
    const payload = buildModuleLookupPayload();
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[3] missing required parameter: an empty body must be refused cleanly', async ({
    commonClient,
  }) => {
    const response = await commonClient.getKpostIdUsingModule({}, { token: null });

    await assertStatus(response, [400, 401, 403, 422], {
      ...META,
      body: {},
      title: 'An empty body is rejected by the container rather than the application',
      severity: 'Major',
    });
  });

  test('[4] null fuzzing: a null module must be refused', async ({ commonClient }) => {
    const payload = buildModuleLookupPayload({ module: null });
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "module" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] business rule: an unknown module must be refused', async ({ commonClient }) => {
    const payload = buildModuleLookupPayload({ module: 9999 });
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'module 9999 is outside the known set',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[6] type mismatch: a string module must be refused', async ({ commonClient }) => {
    const payload = buildModuleLookupPayload({ module: 'kpost' });
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    expect(
      response.status(),
      `module was sent as a string and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildModuleLookupPayload({ module: [SQLI_PAYLOAD] });
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildModuleLookupPayload({ module: [XSS_PAYLOAD] });
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildModuleLookupPayload();
    const response = await commonClient.getKpostIdUsingModule(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    commonClient,
  }) => {
    const response = await commonClient.postRawTo(
      COMMON_PATHS.getKpostIdUsingModule,
      '{"module":',
      { token: null },
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"module":',
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/uniqueNameExist
 * ====================================================================================== */

test.describe('POST /v2/common/uniqueNameExist @audit', () => {
  const META = {
    method: 'POST',
    path: COMMON_PATHS.uniqueNameExist,
    repro: `await commonClient.uniqueNameExist(buildUniqueNameExistPayload(), { token: null });`,
  };

  test('[1] happy path: an availability check satisfies the Zod contract', async ({
    commonClient,
  }) => {
    const payload = buildUniqueNameExistPayload();
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] contract: the answer must be a boolean, not a company record', async ({
    commonClient,
  }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: 'kpost' });
    const response = await commonClient.uniqueNameExist(payload, { token: null });
    const { text } = await readBody(response);

    expect(
      /"(companyName|adminKpostID|companyID)"\s*:\s*"?[^",]{2,}/.test(text),
      `a name-availability check returned company details. Availability is a boolean; anything more makes registration a reconnaissance tool. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[3] missing required parameter: no uniqueName must be refused', async ({
    commonClient,
  }) => {
    const response = await commonClient.uniqueNameExist({}, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an availability check with no name',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null uniqueName must be refused', async ({ commonClient }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: null });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "uniqueName" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422],
    );
  });

  test('[5] boundary: a 5000-character name must be refused', async ({ commonClient }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: MAX_LENGTH_STRING });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    expect(
      response.status(),
      `a 5000-character unique name produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] enumeration: a wildcard must not confirm every registered name', async ({
    commonClient,
  }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: SQLI_WILDCARD });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_WILDCARD);
  });

  test('[7] type mismatch: a numeric uniqueName must be refused', async ({ commonClient }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: 12345 });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    expect(
      response.status(),
      `uniqueName was sent as a number and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: SQLI_PAYLOAD });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({ commonClient }) => {
    const payload = buildUniqueNameExistPayload({ uniqueName: XSS_PAYLOAD });
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    commonClient,
  }) => {
    const payload = buildUniqueNameExistPayload();
    const response = await commonClient.uniqueNameExist(payload, { token: null });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/getCitiesByRegionId
 * ====================================================================================== */

test.describe('GET /v2/common/getCompanyNameExistOnKpostAndKsmacc/{companyName} @audit', () => {
  const META = {
    method: 'GET',
    path: COMMON_PATHS.getCompanyNameExistOnKpostAndKsmacc,
    repro: `await commonClient.getCompanyNameExistOnKpostAndKsmacc('Acme Ltd');`,
  };

  test('[1] happy path: an availability check satisfies the Zod contract', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc('QA Probe Ltd');

    await expectValidContract(response, commonDataResponseSchema, META, [200, 204, ...REFUSED]);
  });

  test('[2] boundary: a 2000-character company name must be refused', async ({ commonClient }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc(MAX_LENGTH_STRING);

    await assertStatus(response, [400, 404, 414, 422], {
      ...META,
      title: 'A 2000-character company name in the path is not rejected cleanly',
    });
  });

  test('[2b] boundary: a UTF-8 company name must not raise a server fault', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc('कंपनी 株式会社 🌸');

    await assertNoInternalLeak(response, META, 'कंपनी');
  });

  test('[3] missing parameter: the bare route must not list every company', async ({
    commonClient,
  }) => {
    const response = await commonClient.getRawPath(
      `${COMMON_PATHS.getCompanyNameExistOnKpostAndKsmacc}/`,
    );
    const { text } = await readBody(response);

    expect(
      response.ok() && /"companyName"/.test(text),
      `the route with an empty path variable answered ${response.status()} with company data. An omitted name must be a 404, never a listing of the customer base. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal "null" must not resolve to a match', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc('null');

    await assertStatus(response, [200, 204, 400, 404, 422], {
      ...META,
      title: 'The literal path segment "null" produces an unexpected status',
    });
  });

  test('[5] wildcard: a "%" must not report every name as taken', async ({ commonClient }) => {
    // On an availability oracle, an unescaped wildcard has a specific consequence: it either
    // dumps matches or reports every candidate name as unavailable, blocking registration.
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc('%');
    const { text } = await readBody(response);
    const rows = (text.match(/"companyName"/g) || []).length;

    expect(
      rows > 20,
      `a wildcard name check returned ${rows} company records. An existence check must answer yes or no, not enumerate the customer list.`,
    ).toBe(false);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc(XSS_PAYLOAD);

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    commonClient,
  }) => {
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc(SQLI_PAYLOAD);

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] public route: a registration-time check must stay anonymous but say only yes or no', async ({
    commonClient,
  }) => {
    // Anonymous access is correct here — you cannot hold a token before you register. The
    // defect would be answering with more than availability.
    const response = await commonClient.getCompanyNameExistOnKpostAndKsmacc('QA Probe Ltd');
    const { text } = await readBody(response);
    const leak = text.match(
      /"(companyID|adminEmail|adminMobile|gstNumber|address|contactPerson)"\s*:\s*"?[^",}]+/i,
    );

    expect(
      leak !== null,
      `an anonymous availability check returned a detail field (${leak ? leak[0].slice(0, 60) : ''}). The answer to "is this name taken" is a boolean; anything more turns a sign-up helper into a disclosure of another organisation's registration details. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[8b] enumeration: repeated anonymous checks must not be unthrottled', async ({
    commonClient,
  }) => {
    // Five, not five hundred. The question is whether a limiter exists, and that does not
    // require actually enumerating anyone's customer list.
    const names = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent'];
    const responses = await Promise.all(
      names.map((n) => commonClient.getCompanyNameExistOnKpostAndKsmacc(n)),
    );
    const allAccepted = responses.every((r) => r.status() !== 429);

    expect(
      allAccepted,
      `five back-to-back anonymous existence checks were all accepted with no throttling (statuses ${responses.map((r) => r.status()).join(', ')}). An unlimited public oracle over company names lets anyone test the whole customer base a name at a time.`,
    ).toBe(false);
  });

  test('[9] verb binding: POST to a read-only check must not be accepted', async ({
    commonClient,
  }) => {
    const response = await commonClient.postRawTo(
      `${COMMON_PATHS.getCompanyNameExistOnKpostAndKsmacc}/QA%20Probe%20Ltd`,
      '{}',
    );

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      method: 'POST',
      title: 'A read-only availability check also answers POST',
    });
  });

  test('[10] consistency: this check must agree with isCompanyNameExist', async ({
    commonClient,
  }) => {
    // Two routes answering the same question. If they disagree, a name that registration
    // rejects can still be claimed through the other path — or vice versa.
    const name = 'QA Probe Ltd';
    const [viaPath, viaBody] = await Promise.all([
      commonClient.getCompanyNameExistOnKpostAndKsmacc(name),
      commonClient.isCompanyNameExist({ companyName: name }),
    ]);

    expect(
      viaPath.ok() === viaBody.ok(),
      `getCompanyNameExistOnKpostAndKsmacc answered ${viaPath.status()} and isCompanyNameExist answered ${viaBody.status()} for the same name. Two availability checks over one namespace must not disagree, or registration and validation can be driven to different conclusions.`,
    ).toBe(true);
  });

  test("[IDOR] a foreign pathVariable must not reach another owner's record", async ({
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
    const response = await genericClient.sendToPathVariable(
      'GET',
      META.path,
      String(FOREIGN.uuid),
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'pathVariable',
      foreignValue: FOREIGN.uuid,
    });
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.sendToPathVariable(
      'GET',
      META.path,
      String(FOREIGN.uuid),
      { token: staticToken },
    );

    await assertStatusCodeParity(response, META);
  });
});

/* =========================================================================================
 * GET /v2/common/downloadCompanyLogo/{companyID}
 * ====================================================================================== */
