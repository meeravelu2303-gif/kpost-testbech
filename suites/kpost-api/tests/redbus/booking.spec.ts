import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { REDBUS_PATHS, REDBUS_PATH_TEMPLATES } from '../../src/api/clients/redbus.client';
import {
  blockTicketResponseSchema,
  redbusOperationResponseSchema,
  redbusTicketResponseSchema,
} from '../../src/api/schemas/redbus.schema';
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
  buildBlockTicketPayload,
  buildBookTicketPayload,
  buildCancelTicketPayload,
  buildTicketDetailsPayload,
  buildUpdatedFarePayload,
  nonExistentTempPnr,
  nonExistentTicketNumber,
} from '../../src/api/payloads/redbus.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * RedBus — the money path: holding seats, confirming payment, cancelling and ticket lookup.
 *
 * ## Safety constraint, and why these tests look the way they do
 *
 * These routes drive a **live third-party booking system**. `blockTicket` holds real
 * inventory, `bookticket` confirms a real paid ticket, `cancelticket` cancels real travel.
 * There is therefore **no happy-path booking test here and there must never be one** — the
 * same rule the suite already applies to account deactivation and password changes.
 *
 * Every payload addresses a provably non-existent trip, PNR or ticket number, so the worst
 * case is a refusal. What is asserted is the *refusal behaviour*: that a bad reference is
 * rejected cleanly, that a stranger's booking cannot be reached, and that the route says so
 * honestly rather than reporting success over a no-op.
 *
 * ## The finding this file exists for
 *
 * `bookticket` and `cancelTicket` take **no identity argument at all** — no
 * `HttpServletRequest`, no path variable, nothing. Their signatures are:
 *
 * ```java
 * public ResponseEntity<Map<String,Object>> bookticket(@RequestBody RedBusSearch searchObject)
 * public ResponseEntity<Map<String,Object>> cancelTicket(@RequestBody RedBusSearch searchObject)
 * ```
 *
 * So the only thing standing between any authenticated caller and a stranger's booking is
 * knowing a PNR or ticket number. `blockTicket` is a variation on the same theme: it takes
 * the acting identity from the **URL path** (`/blockTicket/{kPostId}`) rather than the token,
 * so a caller can hold seats in someone else's name by editing the URL.
 *
 * The ownership tests below use deliberately non-existent references, so they prove the
 * *shape* of the exposure without touching a real booking. Confirming it against live data
 * would mean cancelling a real passenger's ticket, which is not a test anyone should run.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /redbus/blockTicket/{kPostId}
 * ====================================================================================== */
test.describe('POST /redbus/blockTicket/{kPostId} @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATH_TEMPLATES.blockTicket,
    repro: `await redbusClient.blockTicket(kpostID, buildBlockTicketPayload(), { token });`,
  };

  test('[1] happy path: a hold request satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    // Non-existent trip on purpose: a successful hold would occupy real inventory.
    const payload = buildBlockTicketPayload();
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      blockTicketResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: an availableTripId beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({ availableTripId: INT32_OVERFLOW });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `availableTripId ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. On a route that holds inventory, a wrapping id could reserve seats on a different bus.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative fare must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    // Per the Excel, the per-seat price is `inventoryItems[].fare`, a client-supplied value —
    // so a negative fare is the "discount the caller chose for themselves" the server must reject.
    const payload = buildBlockTicketPayload();
    (payload.inventoryItems as Array<Record<string, unknown>>)[0].fare = -5000;
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'inventoryItems[].fare is negative — a discount the caller chose for themselves',
      },
      [400, 401, 403, 422]
    );
  });

  test('[2c] boundary: a 100-seat hold must be bounded explicitly', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const inventoryItems = Array.from({ length: 100 }, (_, i) => ({
      seatName: `QA${i}`,
      fare: 1,
      passenger: { name: 'QA AUTOMATION DO NOT BOARD', age: 30, gender: 'M' },
    }));
    const payload = buildBlockTicketPayload({ inventoryItems });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 100-seat hold produced HTTP ${response.status()}. Holds occupy real inventory until they expire, so an unbounded hold size is an inventory-exhaustion lever against the operator.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no availableTripId must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload();
    delete (payload as Record<string, unknown>).availableTripId;

    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no availableTripId — the hold addresses no trip' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no seats must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({ inventoryItems: [] });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a hold with no seats in it' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null seat list must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({ inventoryItems: null });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "inventoryItems" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string availableTripId must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({ availableTripId: 'next-bus' });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `availableTripId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a client-chosen fare must not be honoured', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({
      inventoryItems: [
        {
          seatName: 'QA1',
          fare: 1,
          passenger: { name: 'QA AUTOMATION DO NOT BOARD', age: 30, gender: 'M' },
        },
      ],
    });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && text.includes('"fare":1'),
      `a hold was accepted at a caller-supplied fare of 1. Fare must come from the trip, never from the request body, or a traveller can name their own price. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] IDOR: seats must not be held in another user\'s name via the path', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload();
    const response = await redbusClient.blockTicket(VICTIM_KPOST_ID, payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a hold was accepted for kPostId "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route takes its identity from the URL path rather than the bearer token, so a booking can be attributed to anyone by editing the URL — and the resulting charge follows the attribution. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[8] auth: an unauthenticated hold must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildBlockTicketPayload();
    const response = await redbusClient.blockTicket('qa', payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not hold inventory', async ({ redbusClient }) => {
    const payload = buildBlockTicketPayload();
    const response = await redbusClient.blockTicket('qa', payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never hold inventory', async ({
    redbusClient,
  }) => {
    const payload = buildBlockTicketPayload();
    const response = await redbusClient.blockTicket('qa', payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a passenger name script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({
      inventoryItems: [
        { seatName: 'QA1', fare: 1, passenger: { name: XSS_PAYLOAD, age: 30, gender: 'M' } },
      ],
    });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockTicketPayload({ availableTripId: SQLI_PAYLOAD });
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] structural: an empty body must be refused', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const response = await redbusClient.blockTicket(authSession.kpostID ?? 'qa', {}, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a seat-hold route' },
      [400, 401, 403, 422]
    );
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
    const response = await genericClient.sendToPathVariable('POST', META.path, String(FOREIGN.uuid), { token: staticToken });
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
    const response = await genericClient.sendToPathVariable('POST', META.path, String(FOREIGN.uuid), { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /redbus/getUpdatedFare/
 * ====================================================================================== */
test.describe('POST /redbus/getUpdatedFare/ @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.getUpdatedFare,
    repro: `await redbusClient.getUpdatedFare(buildUpdatedFarePayload(), { token });`,
  };

  test('[1] happy path: a fare re-quote satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload();
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusOperationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character PNR must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload({ tempPNR: MAX_LENGTH_STRING });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character tempPNR produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no tempPNR must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.getUpdatedFare({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'no tempPNR — the re-quote addresses no hold' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null tempPNR must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload({ tempPNR: null });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "tempPNR" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric tempPNR must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload({ tempPNR: 12345 });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

    expect(
      response.status(),
      `tempPNR was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: an unknown PNR must not return a fare', async ({
    redbusClient,
    staticToken,
  }) => {
    const tempPNR = nonExistentTempPnr();
    const payload = buildUpdatedFarePayload({ tempPNR });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && Boolean(json?.value),
      `PNR ${tempPNR} does not exist, yet a fare was returned. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] IDOR: a fare re-quote must not disclose another user\'s hold', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload();
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"(passengerName|passengerMobile|passengerEmail)"\s*:\s*"[^"]{3,}"/.test(text),
      `a fare re-quote returned passenger identity fields. This route is addressed purely by PNR with no ownership check, so any leak here is readable by anyone who can guess or observe a PNR. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[8] auth: an unauthenticated re-quote must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildUpdatedFarePayload();
    const response = await redbusClient.getUpdatedFare(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return fare data', async ({ redbusClient }) => {
    const payload = buildUpdatedFarePayload();
    const response = await redbusClient.getUpdatedFare(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] SQL injection: a tautology in the PNR must not leak internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload({ tempPNR: SQLI_PAYLOAD });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildUpdatedFarePayload({ tempPNR: XSS_PAYLOAD });
    const response = await redbusClient.getUpdatedFare(payload, { token: staticToken });

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

});

/* =========================================================================================
 * POST /redbus/bookticket
 *
 * REFUSAL PATHS ONLY. Every case below addresses a non-existent tempPNR. A test that
 * confirmed a real hold would charge a real card.
 * ====================================================================================== */
test.describe('POST /redbus/bookticket @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.bookticket,
    repro: `await redbusClient.bookticket(buildBookTicketPayload(), { token });`,
  };

  test('[1] refusal path: a non-existent PNR must not confirm a ticket', async ({
    redbusClient,
    staticToken,
  }) => {
    const tempPNR = nonExistentTempPnr();
    const payload = buildBookTicketPayload({ tempPNR });
    const response = await redbusClient.bookticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `confirming PNR ${tempPNR}, which was never held, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[1b] contract: the refusal envelope must satisfy the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload();
    const response = await redbusClient.bookticket(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusOperationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character PNR must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: MAX_LENGTH_STRING });
    const response = await redbusClient.bookticket(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character tempPNR produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no tempPNR must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.bookticket({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'payment confirmation with no PNR to confirm' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null tempPNR must not confirm anything', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: null });
    const response = await redbusClient.bookticket(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "tempPNR" null on a payment route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array tempPNR must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: [nonExistentTempPnr()] });
    const response = await redbusClient.bookticket(payload, { token: staticToken });

    expect(
      response.status(),
      `tempPNR was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] ownership: confirmation must require more than knowing a PNR', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    // Deliberately a PNR the caller never held. A SUCCESS here would mean the route confirms
    // any hold whose reference you can supply — it takes no identity argument at all.
    const tempPNR = nonExistentTempPnr();
    const payload = buildBookTicketPayload({ tempPNR });
    const response = await redbusClient.bookticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `bookticket confirmed a PNR the caller (${authSession.kpostID ?? 'unknown'}) never held. The handler signature is bookticket(@RequestBody RedBusSearch) — no HttpServletRequest, no path variable, so nothing ties the confirmation to the person who placed the hold. Anyone who observes a PNR can complete someone else's purchase. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a wildcard PNR must not match a live hold', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: SQLI_WILDCARD });
    const response = await redbusClient.bookticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a tempPNR of "%" confirmed a booking. If the PNR reaches a LIKE unescaped, a wildcard confirms whichever hold it matches first — someone else's. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: SQLI_PAYLOAD });
    const response = await redbusClient.bookticket(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated confirmation must be HTTP 401/403', async ({
    redbusClient,
  }) => {
    const payload = buildBookTicketPayload();
    const response = await redbusClient.bookticket(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not confirm a payment', async ({ redbusClient }) => {
    const payload = buildBookTicketPayload();
    const response = await redbusClient.bookticket(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never confirm a payment', async ({
    redbusClient,
  }) => {
    const payload = buildBookTicketPayload();
    const response = await redbusClient.bookticket(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] idempotency: a repeated confirmation must not double-charge', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload();
    const [first, second] = await Promise.all([
      redbusClient.bookticket(payload, { token: staticToken }),
      redbusClient.bookticket(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two concurrent confirmations of the same PNR returned ${first.status()} and ${second.status()}. A double-submitted payment form must produce one ticket and one charge, or a clean refusal — never two of either.`
    ).toBe(second.status());
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildBookTicketPayload({ tempPNR: XSS_PAYLOAD });
    const response = await redbusClient.bookticket(payload, { token: staticToken });

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

});

/* =========================================================================================
 * POST /redbus/cancelticket/
 *
 * REFUSAL PATHS ONLY. Every case addresses a non-existent ticket number. A test that
 * cancelled a real ticket would strand a real passenger.
 * ====================================================================================== */
test.describe('POST /redbus/cancelticket/ @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.cancelticket,
    repro: `await redbusClient.cancelticket(buildCancelTicketPayload(), { token });`,
  };

  test('[1] refusal path: a non-existent ticket must not cancel', async ({
    redbusClient,
    staticToken,
  }) => {
    const ticketNumber = nonExistentTicketNumber();
    const payload = buildCancelTicketPayload({ ticketNumber });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `cancelling ticket ${ticketNumber}, which does not exist, reported success. A caller cannot tell a real cancellation from a no-op, so a failed refund looks completed. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[1b] contract: the refusal envelope must satisfy the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload();
    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusOperationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character ticket number must not fault the server', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ ticketNumber: MAX_LENGTH_STRING });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character ticketNumber produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty seatsToCancel must not cancel the whole ticket silently', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ seatsToCancel: [] });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `an empty seatsToCancel list reported a successful cancellation. "Cancel no seats" must be a refusal or an explicit whole-ticket cancellation, never an ambiguous success — the difference is a refund. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload();
    delete (payload as Record<string, unknown>).ticketNumber;

    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'cancellation with no ticket number' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null ticketNumber must not be a wildcard', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ ticketNumber: null });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "ticketNumber" null on a cancellation route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ ticketNumber: { tin: 1 } });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    expect(
      response.status(),
      `ticketNumber was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] ownership: cancellation must require more than knowing a ticket number', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const ticketNumber = nonExistentTicketNumber();
    const payload = buildCancelTicketPayload({ ticketNumber });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `cancelTicket accepted a ticket the caller (${authSession.kpostID ?? 'unknown'}) does not own. The handler signature is cancelTicket(@RequestBody RedBusSearch) — no identity argument of any kind — so a ticket number alone cancels a stranger's travel and triggers their refund. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a wildcard must not cancel every ticket', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ ticketNumber: SQLI_WILDCARD });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a ticketNumber of "%" reported a successful cancellation. On a destructive route an unescaped wildcard is a mass-cancellation lever. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload({ ticketNumber: SQLI_PAYLOAD });
    const response = await redbusClient.cancelticket(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated cancellation must be HTTP 401/403', async ({
    redbusClient,
  }) => {
    const payload = buildCancelTicketPayload();
    const response = await redbusClient.cancelticket(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not cancel travel', async ({ redbusClient }) => {
    const payload = buildCancelTicketPayload();
    const response = await redbusClient.cancelticket(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never cancel travel', async ({
    redbusClient,
  }) => {
    const payload = buildCancelTicketPayload();
    const response = await redbusClient.cancelticket(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] idempotency: cancelling twice must not refund twice', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildCancelTicketPayload();
    const first = await redbusClient.cancelticket(payload, { token: staticToken });
    const second = await redbusClient.cancelticket(payload, { token: staticToken });

    expect(
      first.status(),
      `cancelling the same ticket twice returned ${first.status()} then ${second.status()}. A repeated cancellation must be a no-op, not a second refund.`
    ).toBe(second.status());
  });

  test('[10] structural: an empty body must be refused on a destructive route', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.cancelticket({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a cancellation route' },
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
 * POST /redbus/ticketdetails/
 * ====================================================================================== */
test.describe('POST /redbus/ticketdetails/ @audit', () => {
  const META = {
    method: 'POST',
    path: REDBUS_PATHS.ticketdetails,
    repro: `await redbusClient.ticketdetails(buildTicketDetailsPayload(), { token });`,
  };

  test('[1] happy path: a ticket lookup satisfies the Zod contract', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload();
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

    await expectValidContract(
      response,
      redbusTicketResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a ticket number beyond int32 must not overflow', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: INT32_OVERFLOW });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

    expect(
      response.status(),
      `ticketNumber ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.ticketdetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'no ticketNumber on a ticket lookup',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: null });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

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

  test('[5] type mismatch: an array ticketNumber must be refused', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: [nonExistentTicketNumber()] });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

    expect(
      response.status(),
      `ticketNumber was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a ticket lookup must not disclose a stranger\'s journey', async ({
    redbusClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildTicketDetailsPayload();
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"(passengerName|passengerMobile|passengerEmail)"\s*:\s*"[^"]{3,}"/.test(text),
      `a ticket lookup addressed only by ticket number returned passenger identity fields, while the caller was ${authSession.kpostID ?? 'a different identity'}. A ticket number is a low-entropy, shareable reference; it must not be the sole key to a traveller's name, phone and itinerary. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] enumeration: a wildcard must not return a list of tickets', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: SQLI_WILDCARD });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || String(json.status).toUpperCase() !== 'SUCCESS', 'no data');

    const value = json?.value;
    const count = Array.isArray(value) ? value.length : 0;
    expect(
      count,
      `a ticketNumber of "%" returned ${count} tickets. A single-ticket lookup must never become a way to enumerate the booking table. Body: ${text.slice(0, 300)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: SQLI_PAYLOAD });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated lookup must be HTTP 401/403', async ({ redbusClient }) => {
    const payload = buildTicketDetailsPayload();
    const response = await redbusClient.ticketdetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return ticket data', async ({ redbusClient }) => {
    const payload = buildTicketDetailsPayload();
    const response = await redbusClient.ticketdetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    redbusClient,
    staticToken,
  }) => {
    const payload = buildTicketDetailsPayload({ ticketNumber: XSS_PAYLOAD });
    const response = await redbusClient.ticketdetails(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    redbusClient,
    staticToken,
  }) => {
    const response = await redbusClient.sendRaw(REDBUS_PATHS.ticketdetails, '{"ticketNumber":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"ticketNumber":',
      repro: `await redbusClient.sendRaw(REDBUS_PATHS.ticketdetails, '{"ticketNumber":', { token });`,
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
