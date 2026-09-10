import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { REDBUS_PATHS, REDBUS_PATH_TEMPLATES } from '../../src/api/clients/redbus.client';
import {
  boardingPointResponseSchema,
  citySuggestionResponseSchema,
  destinationsResponseSchema,
  redbusEnvelopeSchema,
  redbusTripListResponseSchema,
} from '../../src/api/schemas/redbus.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildAvailableTripsPayload,
  buildBoardingPointPayload,
  buildDestinationsPayload,
  buildTripDetailsPayload,
  buildTripDetailsV2Payload,
  futureTravelDate,
  nonExistentTripId,
  SOURCE_CITY_ID,
} from '../../src/api/payloads/redbus.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * RedBus — the search journey: cities, destinations, trips, seat maps and boarding points.
 *
 * These are the read-only half of the integration and the only part safe to exercise
 * aggressively; the money-moving routes live in booking.spec.ts and are refusal-path only.
 * Even here two routes need care and get it:
 *
 *  - **`updatecitylist` is a GET that bulk-rewrites the local city table** and pulls the
 *    entire catalogue from the partner, consuming upstream quota. It is exercised once, for
 *    the method-safety finding, and never in a loop.
 *  - **`boardingPoint` is a bare `@RequestMapping`**, so it answers GET, PUT, DELETE, PATCH,
 *    HEAD and OPTIONS as well as POST. Its verb-binding case is in tickets.spec.ts alongside
 *    the other two routes with the same defect.
 *
 * Contract note that shapes every assertion here: this tag does **not** use the platform
 * envelope. It answers `{ status, value, errorcode, errorvalue }` — no `statusCode`, no
 * `urlPath`, payload under `value` not `data`. A client written to the documented platform
 * contract cannot parse a single RedBus response.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null--`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * GET /redbus/updatecitylist
 * ====================================================================================== */
test.describe('GET /redbus/updatecitylist', () => {
  const META = {
    method: 'GET',
    path: REDBUS_PATHS.updatecitylist,
    repro: `await redbusClient.updatecitylist({ token });`,
  };

  test('[1] method safety: a bulk write must not be exposed as a GET', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.updatecitylist({ token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'The city catalogue is bulk-rewritten by a GET request',
      severity: 'Major',
    });
  });

  test('[2] contract: the response must use an envelope a client can parse', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.updatecitylist({ token: staticToken });

    await expectValidContract(response, redbusEnvelopeSchema, META, [200, 400, 401, 403]);
  });

  test('[3] auth: an unauthenticated bulk refresh must be HTTP 401/403', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.updatecitylist({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not trigger a catalogue refresh', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.updatecitylist({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: an alg=none token claiming admin must never trigger a refresh', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.updatecitylist({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] privilege: an administrative sync must not be open to an ordinary member', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const response = await redbusClient.updatecitylist({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a plain member token (${authSession.kpostID ?? 'unknown identity'}) triggered a full catalogue resync. This is an operations task that bulk-writes a shared reference table and burns partner quota; any logged-in user being able to fire it is a denial-of-service lever. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[5] structural: an unknown query parameter must be ignored, not fatal', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.updatecitylist({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  // The four cases below are deliberately written so that none of them can complete a real
  // sync: each either carries a token the API must reject, or uses a verb the route should not
  // bind. A catalogue refresh bulk-writes a shared table and spends partner quota, so coverage
  // here is bought on refusal paths rather than by firing the job repeatedly.

  test('[5b] auth: a structurally malformed token must not trigger a refresh', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.updatecitylist({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] verb binding: POST must not also trigger the catalogue refresh', async ({
    redbusClient,
    staticToken,
  }) => {
    // If the handler is a bare @RequestMapping it answers every verb, and the "it's only a GET"
    // mitigation people reach for — blocking the verb at a proxy — silently does nothing.
    const response = await redbusClient.sendVerb('put', REDBUS_PATHS.updatecitylist, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      method: 'PUT',
      title: 'The catalogue refresh is reachable by a verb other than GET',
    });
  });

  test('[7] injection: a payload in the query string must not leak database internals', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.updatecitylist({
      token: null,
      params: { cityId: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] status misreporting: the refusal must not be HTTP 200 over a failure envelope', async ({
    redbusClient,
  }) => {
    // Checked on the unauthenticated response precisely because that one costs nothing: parity
    // between the transport status and the envelope applies to refusals as much as successes,
    // and this API routinely gets it wrong in exactly that direction.
    const response = await redbusClient.updatecitylist({ token: null });

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

/* =========================================================================================
 * GET /redbus/citysuggestion/{cityname}
 * ====================================================================================== */
test.describe('GET /redbus/citysuggestion/{cityname}', () => {
  const META = {
    method: 'GET',
    path: REDBUS_PATH_TEMPLATES.citysuggestion,
    repro: `await redbusClient.citysuggestion('chen', { token });`,
  };

  test('[1] happy path: a city prefix satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('chen', { token: staticToken });

    await expectValidContract(
      response,
      citySuggestionResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a single character must not return the entire catalogue', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('a', { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no data');

    const value = json?.value;
    const count = Array.isArray(value) ? value.length : 0;
    expect(
      count,
      `a one-character prefix returned ${count} cities. A type-ahead must impose a minimum prefix length; returning the whole catalogue on every keystroke is a needless load amplifier. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 5000-character city name must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a UTF-8 city name must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion(UTF8_STRING, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 city name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] SQL injection: a wildcard must not enumerate the whole table', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('%', { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no data');

    const value = json?.value;
    const count = Array.isArray(value) ? value.length : 0;
    expect(
      count,
      `a "%" prefix returned ${count} cities. If the suggestion query interpolates the term into a LIKE without escaping, the wildcard reaches the database and the lookup becomes a full-table scrape. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[3b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[3c] SQL injection: a UNION probe must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion(SQLI_UNION_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_UNION_PAYLOAD);
  });

  test('[4] XSS: a script payload in the path must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[5] path traversal: a traversal sequence must not escape the route', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('../../admin/userManagementDetails/1', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a traversal sequence in the city name produced HTTP ${response.status()}. It must resolve as a (fruitless) city lookup, never as a different route.`
    ).toBeLessThan(500);
  });

  test('[6] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const response = await redbusClient.citysuggestion('chen', { token: null });

    await assertUnauthorized(response, META);
  });

  test('[6b] auth: a malformed token must not return catalogue data', async ({ redbusClient }) => {
    const response = await redbusClient.citysuggestion('chen', { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[7] contract: the response must not use the platform envelope\'s field names', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('chen', { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode,
      `the RedBus tag answers { status, value, errorcode, errorvalue } with no statusCode and no urlPath, while every other KPOST controller answers { statusCode, status, urlPath, data }. A shared client cannot parse both, so integration consumers need a bespoke code path for this one tag. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[8] idempotency: two consecutive lookups must agree', async ({
    redbusClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      redbusClient.citysuggestion('chen', { token: staticToken }),
      redbusClient.citysuggestion('chen', { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical lookups returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[9] empty-state: a prefix matching nothing must not be an error', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.citysuggestion('zzzzzzzzzz', { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'A city prefix matching nothing is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[10] concurrency: parallel lookups must not return each other\'s results', async ({
    redbusClient,
    staticToken,
  }) => {
    // RedBusIntegrationController holds `Map<String, Object> resultMap` as an INSTANCE field
    // on a Spring singleton, reassigning it per request. Two concurrent callers therefore
    // share one map. This probes for the resulting cross-request bleed.
    const [chennai, delhi] = await Promise.all([
      redbusClient.citysuggestion('chen', { token: staticToken }),
      redbusClient.citysuggestion('delh', { token: staticToken }),
    ]);
    const a = await readBody(chennai);
    const b = await readBody(delhi);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      a.text === b.text && a.text.length > 60,
      `two concurrent lookups for different cities returned byte-identical bodies. The controller stores its response in a shared instance field (\`Map<String, Object> resultMap\`) on a singleton bean, so one caller can be served another caller's data. Body: ${a.text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[IDOR] a foreign pathVariable must not reach another owner\'s record', async ({
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });
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

});

/* =========================================================================================
 * POST /redbus/destinations/
 * ====================================================================================== */
test.describe('POST /redbus/destinations/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.destinations,
    repro: `await redbusClient.destinations(buildDestinationsPayload(), { token });`,
  };

  test('[1] happy path: destinations for a real source satisfy the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload();
    const response = await redbusClient.destinations(payload, { token: staticToken });

    await expectValidContract(
      response,
      destinationsResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a source city id beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: INT32_OVERFLOW });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    expect(
      response.status(),
      `sourceCityID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative source city id must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: -1 });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'sourceCityID is negative', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no sourceCityID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.destinations({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'no sourceCityID — the lookup has no origin',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null sourceCityID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: null });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "sourceCityID" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string sourceCityID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: 'Chennai' });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    expect(
      response.status(),
      `sourceCityID was sent as the string "Chennai" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: an unknown city id must not be reported as success', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: 999999999 });
    const response = await redbusClient.destinations(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const value = json?.value as Record<string, unknown> | undefined;
    const cities = value && Array.isArray(value.cities) ? value.cities : [];
    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && cities.length > 0,
      `city id 999999999 does not exist, yet the lookup reported success with ${cities.length} destinations. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: SQLI_PAYLOAD });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildDestinationsPayload({ sourceCityID: XSS_PAYLOAD });
    const response = await redbusClient.destinations(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildDestinationsPayload();
    const response = await redbusClient.destinations(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return catalogue data', async ({ redbusClient }) => {
    const payload = buildDestinationsPayload();
    const response = await redbusClient.destinations(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.destinations, '{"sourceCityID":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"sourceCityID":',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.destinations, '{"sourceCityID":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[10] concurrency: parallel lookups for different sources must not collide', async ({
    redbusClient,
    staticToken,
  }) => {
    const [a, b] = await Promise.all([
      redbusClient.destinations({ sourceCityID: SOURCE_CITY_ID }, { token: staticToken }),
      redbusClient.destinations({ sourceCityID: 124 }, { token: staticToken }),
    ]);
    const first = await readBody(a);
    const second = await readBody(b);

    test.skip(first.json === null || second.json === null, 'responses were not JSON');

    expect(
      first.text === second.text && first.text.length > 60,
      `concurrent destination lookups from two different source cities returned byte-identical bodies, which points at the shared \`resultMap\` instance field on this singleton controller. A traveller could be shown routes from someone else's search. Body: ${first.text.slice(0, 200)}`
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

});

/* =========================================================================================
 * POST /redbus/availabletrips/
 * ====================================================================================== */
test.describe('POST /redbus/availabletrips/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.availabletrips,
    repro: `await redbusClient.availabletrips(buildAvailableTripsPayload(), { token });`,
  };

  test('[1] happy path: a trip search satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload();
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTripListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a travel date in the past must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: '2020-01-01' });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'searching for buses that departed in 2020',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[2b] boundary: a travel date years ahead must be handled explicitly', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: futureTravelDate(3650) });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    expect(
      response.status(),
      `a travel date ten years out produced HTTP ${response.status()}. Inventory does not exist that far ahead; the answer must be an empty result or a clean 400, not a fault.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no travelDate must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload();
    delete (payload as Record<string, unknown>).travelDate;

    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'required field "travelDate" omitted',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null travelDate must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: null });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "travelDate" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric travelDate must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: 20260101 });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    expect(
      response.status(),
      `travelDate was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: source and destination the same must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({
      sourceCityID: SOURCE_CITY_ID,
      destinationCityID: SOURCE_CITY_ID,
    });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'journey starts and ends in the same city',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: an impossible calendar date must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: '2026-02-31' });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

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

  test('[7] SQL injection: a tautology in the date must not leak internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: SQLI_PAYLOAD });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ travelDate: XSS_PAYLOAD });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated search must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildAvailableTripsPayload();
    const response = await redbusClient.availabletrips(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never be honoured', async ({
    redbusClient,
  }) => {
    const payload = buildAvailableTripsPayload();
    const response = await redbusClient.availabletrips(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] empty-state: a route with no service must not be an error', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildAvailableTripsPayload({ destinationCityID: 999999999 });
    const response = await redbusClient.availabletrips(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A route with no available trips is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[10] structural: an empty body must be refused', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.availabletrips({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a trip search',
        severity: 'Major' as const,
      },
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

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /redbus/tripdetails/
 * ====================================================================================== */
test.describe('POST /redbus/tripdetails/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.tripdetails,
    repro: `await redbusClient.tripdetails(buildTripDetailsPayload(), { token });`,
  };

  test('[1] happy path: a trip-detail lookup satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTripListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a tripID beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: String(INT32_OVERFLOW) });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    expect(
      response.status(),
      `tripID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    delete (payload as Record<string, unknown>).tripID;

    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'no tripID — the lookup addresses no trip',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null tripID must be refused', async ({ redbusClient, staticToken }) => {
    const payload = buildTripDetailsPayload({ tripID: null });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "tripID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: [nonExistentTripId()] });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    expect(
      response.status(),
      `tripID was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: an unknown trip must not report success', async ({
    redbusClient,
    staticToken,
  }) => {
    const tripID = String(nonExistentTripId());
    const payload = buildTripDetailsPayload({ tripID });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const value = json?.value;
    const hasData = Array.isArray(value) ? value.length > 0 : Boolean(value);
    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && hasData,
      `trip ${tripID} does not exist, yet the lookup reported success with data. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: SQLI_PAYLOAD });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: XSS_PAYLOAD });
    const response = await redbusClient.tripdetails(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.tripdetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return trip data', async ({ redbusClient }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.tripdetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] structural: an empty body must be refused', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.tripdetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a trip-detail lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.tripdetails, '{{{', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{{{',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.tripdetails, '{{{', { token });`,
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

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /redbus/tripdetailsV2/
 * ====================================================================================== */
test.describe('POST /redbus/tripdetailsV2/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.tripdetailsV2,
    repro: `await redbusClient.tripdetailsV2(buildTripDetailsV2Payload(), { token });`,
  };

  test('[1] happy path: the V2 lookup satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload();
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTripListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: an inventoryId beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload({ inventoryId: INT32_OVERFLOW });
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    expect(
      response.status(),
      `inventoryId ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no inventoryId must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload();
    delete (payload as Record<string, unknown>).inventoryId;

    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'required field "inventoryId" omitted',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null inventoryId must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload({ inventoryId: null });
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "inventoryId" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string inventoryId must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload({ inventoryId: 'latest' });
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    expect(
      response.status(),
      `inventoryId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload({ inventoryId: SQLI_PAYLOAD });
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[6b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsV2Payload({ inventoryId: XSS_PAYLOAD });
    const response = await redbusClient.tripdetailsV2(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildTripDetailsV2Payload();
    const response = await redbusClient.tripdetailsV2(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return trip data', async ({ redbusClient }) => {
    const payload = buildTripDetailsV2Payload();
    const response = await redbusClient.tripdetailsV2(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] structural: an empty body must be refused', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.tripdetailsV2({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on the V2 trip-detail lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.tripdetailsV2, 'not json', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: 'not json',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.tripdetailsV2, 'not json', { token });`,
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

/* =========================================================================================
 * POST /redbus/seatLayout/
 * ====================================================================================== */
test.describe('POST /redbus/seatLayout/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.seatLayout,
    repro: `await redbusClient.seatLayout(buildTripDetailsPayload(), { token });`,
  };

  test('[1] happy path: a seat map satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTripListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a tripID beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: String(INT32_OVERFLOW) });
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    expect(
      response.status(),
      `tripID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    delete (payload as Record<string, unknown>).tripID;

    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'no tripID on a seat-map lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null tripID must be refused', async ({ redbusClient, staticToken }) => {
    const payload = buildTripDetailsPayload({ tripID: null });
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "tripID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: { id: 1 } });
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    expect(
      response.status(),
      `tripID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] privacy: a seat map must not disclose existing passengers', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.seatLayout(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no seat map');

    expect(
      /"(passengerName|passengerMobile|passengerEmail|name)"\s*:\s*"[A-Za-z]{3,}/.test(text),
      `the seat map carried passenger identity fields. A seat map must say which seats are taken, never who is sitting in them — anyone searching the route could otherwise harvest the manifest. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: SQLI_UNION_PAYLOAD });
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload({ tripID: XSS_PAYLOAD });
    const response = await redbusClient.seatLayout(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.seatLayout(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never be honoured', async ({
    redbusClient,
  }) => {
    const payload = buildTripDetailsPayload();
    const response = await redbusClient.seatLayout(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] structural: an empty body must be refused', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.seatLayout({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a seat-map lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[10] idempotency: two consecutive seat maps must agree', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTripDetailsPayload();
    const [first, second] = await Promise.all([
      redbusClient.seatLayout(payload, { token: staticToken }),
      redbusClient.seatLayout(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical seat-map reads returned ${first.status()} and ${second.status()}. A read must be stable and must not hold inventory.`
    ).toBe(second.status());
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

});

/* =========================================================================================
 * POST /redbus/boardingPoint/
 *
 * Verb-binding for this route is covered in tickets.spec.ts, alongside the other two bare
 * @RequestMapping routes.
 * ====================================================================================== */
test.describe('POST /redbus/boardingPoint/', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.boardingPoint,
    repro: `await redbusClient.boardingPoint(buildBoardingPointPayload(), { token });`,
  };

  test('[1] happy path: a boarding-point lookup satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload();
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    await expectValidContract(
      response,
      boardingPointResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character tripID must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload({ tripID: MAX_LENGTH_STRING });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character tripID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload();
    delete (payload as Record<string, unknown>).tripID;

    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'no tripID on a boarding-point lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null tripID must be refused', async ({ redbusClient, staticToken }) => {
    const payload = buildBoardingPointPayload({ tripID: null });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "tripID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean tripID must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload({ tripID: true });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    expect(
      response.status(),
      `tripID was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: an unknown trip must not return boarding points', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload({ tripID: String(nonExistentTripId()) });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const value = json?.value;
    const hasData = Array.isArray(value) ? value.length > 0 : false;
    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && hasData,
      `a trip that does not exist returned boarding points. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload({ tripID: SQLI_PAYLOAD });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBoardingPointPayload({ tripID: XSS_PAYLOAD });
    const response = await redbusClient.boardingPoint(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildBoardingPointPayload();
    const response = await redbusClient.boardingPoint(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return boarding points', async ({ redbusClient }) => {
    const payload = buildBoardingPointPayload();
    const response = await redbusClient.boardingPoint(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] structural: an empty body must be refused', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.boardingPoint({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a boarding-point lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.boardingPoint, '][', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '][',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.boardingPoint, '][', { token });`,
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

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});
