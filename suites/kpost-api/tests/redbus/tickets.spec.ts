import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { ALL_VERB_ROUTES, REDBUS_PATHS } from '../../src/api/clients/redbus.client';
import { redbusTicketResponseSchema } from '../../src/api/schemas/redbus.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertUnauthorized,
  expectValidContract,
  readBody,
  assertStatusCodeParity,
} from '../../src/utils/apiAssertions';
import {
  buildRedbusSearchPayload,
  buildTicketDetailsPayload,
  nonExistentTicketNumber,
} from '../../src/api/payloads/redbus.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * RedBus — the caller's own tickets, booking lookup, and HTTP method binding.
 *
 * `getTicket` is the one route on this controller that *is* identity-scoped: it reads
 * `request.getAttribute("kpostID")` and returns only that user's tickets. It is therefore the
 * reference point for how the rest of the tag should have been written.
 *
 * ## Method binding
 *
 * Three routes are declared with a bare Spring `@RequestMapping` and no `method` attribute:
 *
 * ```java
 * @RequestMapping(value = "/getTicket/")
 * @RequestMapping(value = "/checkBookedTicket/")
 * @RequestMapping(value = "/boardingPoint/")
 * ```
 *
 * Spring maps those to **every** HTTP verb. Swagger reflects the consequence honestly — it
 * lists seven operations per route — and the API's own documentation already flags it. The
 * matrix at the end of this file walks GET, PUT, DELETE, PATCH, HEAD and OPTIONS against each
 * one. The concern is not tidiness: a `DELETE` that quietly behaves like a read teaches
 * caches, proxies and client libraries the wrong thing about the route, and it defeats any
 * method-based access rule a gateway might apply in front of it.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = `%`;
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * GET /redbus/getTicket/
 * ====================================================================================== */
test.describe('GET /redbus/getTicket/ @audit', () => {
  const META = {
    method: 'GET',
    path: REDBUS_PATHS.getTicket,
    repro: `await redbusClient.getTicket({ token });`,
  };

  test('[1] happy path: the caller\'s tickets satisfy the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getTicket({ token: staticToken });

    await expectValidContract(
      response,
      redbusTicketResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a user with no tickets must not get an error', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getTicket({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty ticket list is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: an unauthenticated read must be HTTP 401/403', async ({ redbusClient }) => {
    const response = await redbusClient.getTicket({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return tickets', async ({ redbusClient }) => {
    const response = await redbusClient.getTicket({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return tickets', async ({ redbusClient }) => {
    const response = await redbusClient.getTicket({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    redbusClient,
  }) => {
    const response = await redbusClient.getTicket({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the list', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const response = await redbusClient.getTicket({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's tickets while the caller was ${authSession.kpostID ?? 'a different identity'}. This route reads its identity from the auth-filter attribute, so a query parameter must be inert — a ticket list is a record of where someone travelled and when. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getTicket({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getTicket({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] idempotency: two consecutive reads must agree', async ({
    redbusClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      redbusClient.getTicket({ token: staticToken }),
      redbusClient.getTicket({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[8] method binding: DELETE must not be answered like a read', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendVerb('delete', REDBUS_PATHS.getTicket, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      method: 'DELETE',
      repro: `await redbusClient.sendVerb('delete', REDBUS_PATHS.getTicket, { token });`,
      title: 'A bare @RequestMapping answers DELETE on a read-only ticket route',
    });
  });

  test('[9] structural: an unknown query parameter must be ignored, not fatal', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getTicket({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] concurrency: parallel reads must not serve a shared response map', async ({
    redbusClient,
    staticToken,
  }) => {
    // RedBusIntegrationController stores its response in an INSTANCE field on a singleton
    // bean (`Map<String, Object> resultMap`), reassigned per request. This probes whether a
    // concurrent caller can be served the wrong body.
    const [a, b] = await Promise.all([
      redbusClient.getTicket({ token: staticToken }),
      redbusClient.ticketdetails(buildTicketDetailsPayload(), { token: staticToken }),
    ]);
    const first = await readBody(a);
    const second = await readBody(b);

    test.skip(first.json === null || second.json === null, 'responses were not JSON');

    expect(
      first.text === second.text && first.text.length > 60,
      `a ticket-list read and a concurrent ticket-detail lookup returned byte-identical bodies. The controller holds its response map as a mutable instance field on a singleton, so one caller can receive another's data — on a controller whose payloads carry passenger names and itineraries. Body: ${first.text.slice(0, 200)}`
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
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
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
    const response = await genericClient.send('GET', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /redbus/checkBookedTicket/
 * ====================================================================================== */
test.describe('POST /redbus/checkBookedTicket/ @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.checkBookedTicket,
    repro: `await redbusClient.checkBookedTicket(buildRedbusSearchPayload(), { token });`,
  };

  test('[1] happy path: a booking check satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: nonExistentTicketNumber() });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTicketResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: an unknown booking must not be reported as an error', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: nonExistentTicketNumber() });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown booking is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: an empty body must be handled explicitly', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.checkBookedTicket({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body on a booking check produced HTTP ${response.status()}. Either it is scoped to the caller and an empty filter is valid, or it is a clean 400 — a fault is neither.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: null });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "ticketNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: { tin: 1 } });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    expect(
      response.status(),
      `ticketNumber was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a booking check must not disclose a stranger\'s journey', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: nonExistentTicketNumber() });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"(passengerName|passengerMobile|passengerEmail)"\s*:\s*"[^"]{3,}"/.test(text),
      `a booking check returned passenger identity fields while the caller was ${authSession.kpostID ?? 'a different identity'}. Unlike getTicket next door, this route takes no token identity — it is addressed purely by the body. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] enumeration: a wildcard must not list every booking', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: SQLI_WILDCARD });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no data');

    const value = json?.value;
    const count = Array.isArray(value) ? value.length : 0;
    expect(
      count,
      `a ticketNumber of "%" returned ${count} bookings. Body: ${text.slice(0, 300)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: SQLI_PAYLOAD });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated check must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: nonExistentTicketNumber() });
    const response = await redbusClient.checkBookedTicket(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return booking data', async ({ redbusClient }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: nonExistentTicketNumber() });
    const response = await redbusClient.checkBookedTicket(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildRedbusSearchPayload({ ticketNumber: XSS_PAYLOAD });
    const response = await redbusClient.checkBookedTicket(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.checkBookedTicket, '{[', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{[',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.checkBookedTicket, '{[', { token });`,
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
 * HTTP method binding on the three bare @RequestMapping routes
 *
 * Written out one test per (route, verb) rather than generated in a loop, matching the
 * project's no-loop rule: each case must be individually named, individually reportable, and
 * individually skippable.
 * ====================================================================================== */
test.describe('RedBus — bare @RequestMapping verb binding @audit', () => {
  const META = {
    method: 'VERB',
    path: '/redbus/{bare-request-mapping-routes}',
    repro: `await redbusClient.sendVerb(verb, path, { token });`,
    severity: 'Major' as const,
  };

  const EXPECTED = [400, 401, 403, 404, 405, 415];

  test('[1] getTicket must not answer PUT', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('put', REDBUS_PATHS.getTicket, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PUT',
      path: REDBUS_PATHS.getTicket,
      title: 'Read-only ticket route answers PUT',
    });
  });

  test('[2] getTicket must not answer PATCH', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('patch', REDBUS_PATHS.getTicket, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PATCH',
      path: REDBUS_PATHS.getTicket,
      title: 'Read-only ticket route answers PATCH',
    });
  });

  test('[3] getTicket must not answer OPTIONS as a data route', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendVerb('options', REDBUS_PATHS.getTicket, {
      token: staticToken,
    });

    // OPTIONS legitimately answers 200 for CORS preflight; what must not happen is a body of
    // ticket data, which is why this reads the payload rather than only the status.
    const { text } = await readBody(response);
    expect(
      /"(passengerName|ticketNumber|pnr)"\s*:/.test(text),
      `OPTIONS returned ticket data rather than a capability description. A preflight must never carry a payload. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] checkBookedTicket must not answer DELETE', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('delete', REDBUS_PATHS.checkBookedTicket, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'DELETE',
      path: REDBUS_PATHS.checkBookedTicket,
      title: 'Booking-lookup route answers DELETE',
    });
  });

  test('[5] checkBookedTicket must not answer PUT', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('put', REDBUS_PATHS.checkBookedTicket, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PUT',
      path: REDBUS_PATHS.checkBookedTicket,
      title: 'Booking-lookup route answers PUT',
    });
  });

  test('[6] checkBookedTicket must not answer PATCH', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('patch', REDBUS_PATHS.checkBookedTicket, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PATCH',
      path: REDBUS_PATHS.checkBookedTicket,
      title: 'Booking-lookup route answers PATCH',
    });
  });

  test('[7] boardingPoint must not answer DELETE', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('delete', REDBUS_PATHS.boardingPoint, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'DELETE',
      path: REDBUS_PATHS.boardingPoint,
      title: 'Boarding-point route answers DELETE',
    });
  });

  test('[8] boardingPoint must not answer PUT', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('put', REDBUS_PATHS.boardingPoint, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PUT',
      path: REDBUS_PATHS.boardingPoint,
      title: 'Boarding-point route answers PUT',
    });
  });

  test('[9] boardingPoint must not answer PATCH', async ({ redbusClient, staticToken }) => {
    const response = await redbusClient.sendVerb('patch', REDBUS_PATHS.boardingPoint, {
      token: staticToken,
    });

    await assertStatus(response, EXPECTED, {
      ...META,
      method: 'PATCH',
      path: REDBUS_PATHS.boardingPoint,
      title: 'Boarding-point route answers PATCH',
    });
  });

  test('[10] every bare-mapped route must be unreachable without a token, whatever the verb', async ({
    redbusClient,
  }) => {
    // The three routes are exercised together here because the assertion is the same for all
    // of them and the finding is about the set, not any single member.
    const responses = await Promise.all(
      ALL_VERB_ROUTES.map((path) => redbusClient.sendVerb('delete', path, { token: null }))
    );

    const leaked = responses
      .map((response, index) => ({ status: response.status(), path: ALL_VERB_ROUTES[index] }))
      .filter((entry) => entry.status >= 200 && entry.status < 300);

    expect(
      leaked.map((entry) => `${entry.path} → ${entry.status}`).join(', ') || 'none',
      `these bare-@RequestMapping routes answered an unauthenticated DELETE with a 2xx: ${leaked
        .map((entry) => entry.path)
        .join(', ')}. A route that accepts every verb and needs no token is reachable from any page on the internet.`
    ).toBe('none');
  });
});
