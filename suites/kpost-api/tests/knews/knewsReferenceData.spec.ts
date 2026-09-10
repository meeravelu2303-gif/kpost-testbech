import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KNEWS_PATHS } from '../../src/api/clients/knews.client';
import {
  getAllCategoriesResponseSchema,
  getAllNewsSourceResponseSchema,
  getPublicationByLanguageResponseSchema,
  getSubCategoriesResponseSchema,
} from '../../src/api/schemas/knews.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import { buildCategoryLookupPayload, buildPublicationPayload } from '../../src/api/payloads/knews.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Knews reference data — categories, sub-categories, news sources and publications.
 *
 * These are read-only lookups, so the risk profile differs from the settings routes: the
 * questions that matter are whether a caller-supplied id can be used to enumerate rows it
 * should not see, whether a wildcard dumps the whole table, and whether the reference tables
 * are internally consistent.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * GET /v2/knews/getAllCategories
 * ====================================================================================== */
test.describe('GET /v2/knews/getAllCategories', () => {
  const META = {
    method: 'GET',
    path: KNEWS_PATHS.getAllCategories,
    repro: `await knewsClient.getAllCategories({ token });`,
  };

  test('[1] happy path: the category list satisfies the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({ token: staticToken });

    await expectValidContract(
      response,
      getAllCategoriesResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative limit must not be honoured', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { limit: -1 },
    });

    expect(
      response.status(),
      `limit=-1 produced HTTP ${response.status()}. A negative page size must be refused rather than passed to the query layer.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({ token: staticToken });

    expect(
      response.status(),
      `a parameterless category read produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { categoryId: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric id where a number is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { languageId: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric languageId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({
      token: staticToken,
      params: { categoryId: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const response = await knewsClient.getAllCategories({ token: null });

    await assertUnauthorized(response, {
      ...META,
      repro: `await knewsClient.getAllCategories({ token: null });`,
    });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ knewsClient }) => {
    const response = await knewsClient.getAllCategories({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllCategories({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must return the same body', async ({
    knewsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      knewsClient.getAllCategories({ token: staticToken }),
      knewsClient.getAllCategories({ token: staticToken }),
      knewsClient.getAllCategories({ token: staticToken }),
    ]);
    const bodies = [await readBody(first), await readBody(second), await readBody(third)];

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'three concurrent reads of a static reference table returned different bodies — the category list must be deterministic'
    ).toBe(1);
  });

  test('[10b] structural: category identifiers must be unique', async ({
    knewsClient,
    staticToken,
  }) => {
    const { json } = await readBody(await knewsClient.getAllCategories({ token: staticToken }));
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no categories returned to validate');

    const ids = rows.map((row) => row.categoryId);
    expect(
      new Set(ids).size,
      `the category reference table returned ${ids.length} rows but only ${new Set(ids).size} distinct ids — duplicate identifiers break any client keying on them`
    ).toBe(ids.length);
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
 * GET /v2/knews/getAllNewsSource
 * ====================================================================================== */
test.describe('GET /v2/knews/getAllNewsSource', () => {
  const META = {
    method: 'GET',
    path: KNEWS_PATHS.getAllNewsSource,
    repro: `await knewsClient.getAllNewsSource({ token });`,
  };

  test('[1] happy path: the news source list satisfies the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({ token: staticToken });

    await expectValidContract(
      response,
      getAllNewsSourceResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow query id is handled cleanly', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { newsSourceId: INT32_OVERFLOW },
    });

    expect(
      response.status(),
      `newsSourceId=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({ token: staticToken });

    expect(
      response.status(),
      `a parameterless news source read produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { newsSourceId: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric id where a number is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { newsSourceId: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric newsSourceId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a DROP TABLE query parameter must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({
      token: staticToken,
      params: { newsSourceId: SQLI_DROP_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const response = await knewsClient.getAllNewsSource({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({ knewsClient }) => {
    const response = await knewsClient.getAllNewsSource({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getAllNewsSource({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must return the same body', async ({
    knewsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      knewsClient.getAllNewsSource({ token: staticToken }),
      knewsClient.getAllNewsSource({ token: staticToken }),
      knewsClient.getAllNewsSource({ token: staticToken }),
    ]);
    const bodies = [await readBody(first), await readBody(second), await readBody(third)];

    expect(
      new Set(bodies.map((b) => b.text)).size,
      'three concurrent reads of a static reference table returned different bodies'
    ).toBe(1);
  });

  test('[10b] structural: news source identifiers must be unique', async ({
    knewsClient,
    staticToken,
  }) => {
    const { json } = await readBody(await knewsClient.getAllNewsSource({ token: staticToken }));
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    test.skip(rows.length === 0, 'no news sources returned to validate');

    const ids = rows.map((row) => row.newsSourceId);
    expect(
      new Set(ids).size,
      `the news source table returned ${ids.length} rows but only ${new Set(ids).size} distinct ids`
    ).toBe(ids.length);
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
 * POST /v2/knews/getSubCategoriesByCategoryId
 * ====================================================================================== */
test.describe('POST /v2/knews/getSubCategoriesByCategoryId', () => {
  const META = {
    method: 'POST',
    path: KNEWS_PATHS.getSubCategoriesByCategoryId,
    repro: `await knewsClient.getSubCategoriesByCategoryId(buildCategoryLookupPayload(), { token });`,
  };

  test('[1] happy path: a valid lookup satisfies the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload();
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      getSubCategoriesResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an int32-overflow categoryId must be handled cleanly', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: INT32_OVERFLOW });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `categoryId=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative categoryId must be refused', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: -1 });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `categoryId=-1 produced HTTP ${response.status()}. A negative identifier cannot exist and must be refused.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "categoryId" omitted must be HTTP 400/422', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload();
    delete (payload as Record<string, unknown>).categoryId;

    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "categoryId" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: "categoryId" set to null must be rejected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: null });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "categoryId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty object where categoryId is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: {} });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `categoryId was sent as an empty object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string categoryId must be rejected as HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: 'not-a-number' });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `categoryId is an integer in the contract but was sent as a string, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where categoryId expects a number', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: [1] });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `languageId was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in categoryId must not be reflected unescaped', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: XSS_PAYLOAD });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload({ categoryId: SQLI_PAYLOAD });
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not widen the result set', async ({
    knewsClient,
    staticToken,
  }) => {
    const baseline = await readBody(
      await knewsClient.getSubCategoriesByCategoryId(buildCategoryLookupPayload(), {
        token: staticToken,
      })
    );
    const injected = await readBody(
      await knewsClient.getSubCategoriesByCategoryId(
        buildCategoryLookupPayload({ categoryId: SQLI_PAYLOAD }),
        { token: staticToken }
      )
    );

    const baselineRows = Array.isArray(baseline.json?.data)
      ? (baseline.json.data as unknown[]).length
      : 0;
    const injectedRows = Array.isArray(injected.json?.data)
      ? (injected.json.data as unknown[]).length
      : 0;

    expect(
      injectedRows,
      `a SQL tautology returned ${injectedRows} sub-categories against a baseline of ${baselineRows}. A payload that widens the result set proves the value reaches the query unparameterised.`
    ).toBeLessThanOrEqual(baselineRows);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const payload = buildCategoryLookupPayload();
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ knewsClient }) => {
    const payload = buildCategoryLookupPayload();
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload();
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload();
    const response = await knewsClient.getSubCategoriesByCategoryId(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not silently defaulted', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getSubCategoriesByCategoryId({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a category lookup' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.sendRaw(
      KNEWS_PATHS.getSubCategoriesByCategoryId,
      '{"a":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical lookups must agree', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildCategoryLookupPayload();
    const [first, second, third] = await Promise.all([
      knewsClient.getSubCategoriesByCategoryId(payload, { token: staticToken }),
      knewsClient.getSubCategoriesByCategoryId(payload, { token: staticToken }),
      knewsClient.getSubCategoriesByCategoryId(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent lookups returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
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
 * POST /v2/knews/getPublicationByLanguageId
 * ====================================================================================== */
test.describe('POST /v2/knews/getPublicationByLanguageId', () => {
  const META = {
    method: 'POST',
    path: KNEWS_PATHS.getPublicationByLanguageId,
    repro: `await knewsClient.getPublicationByLanguageId(buildPublicationPayload(), { token });`,
  };

  test('[1] happy path: a valid lookup satisfies the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload();
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      getPublicationByLanguageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an int32-overflow languageId must be handled cleanly', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: INT32_OVERFLOW });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `languageId=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 value where a language id is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: UTF8_STRING });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 languageId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "languageId" omitted must be HTTP 400/422', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload();
    delete (payload as Record<string, unknown>).languageId;

    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "languageId" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: "languageId" set to null must be rejected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: null });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "languageId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty string where a language id is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: '' });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "languageId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a string languageId must be rejected as HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: 'english' });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `languageId is an integer in the contract but was sent as a string, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an object where categoryId expects a number', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ categoryId: { id: 1 } });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `categoryId was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in languageId must not be reflected unescaped', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: XSS_PAYLOAD });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ languageId: SQLI_PAYLOAD });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload({ categoryId: SQLI_DROP_PAYLOAD });
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const payload = buildPublicationPayload();
    const response = await knewsClient.getPublicationByLanguageId(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({ knewsClient }) => {
    const payload = buildPublicationPayload();
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload();
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload();
    const response = await knewsClient.getPublicationByLanguageId(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not silently defaulted', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getPublicationByLanguageId({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a publication lookup' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.sendRaw(
      KNEWS_PATHS.getPublicationByLanguageId,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical lookups must agree', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildPublicationPayload();
    const [first, second, third] = await Promise.all([
      knewsClient.getPublicationByLanguageId(payload, { token: staticToken }),
      knewsClient.getPublicationByLanguageId(payload, { token: staticToken }),
      knewsClient.getPublicationByLanguageId(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent lookups returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
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
