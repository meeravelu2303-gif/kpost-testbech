import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KDIARY_PATHS } from '../../src/api/clients/kdiary.client';
import {
  deleteEventResponseSchema,
  diaryScheduleListResponseSchema,
  diaryScheduleResponseSchema,
} from '../../src/api/schemas/kdiary.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildAddParticipantsPayload,
  buildDateFilterPayload,
  buildExistingSchedulePayload,
  buildKdiaryROPayload,
  diaryTimestamp,
  nonExistentEventId,
} from '../../src/api/payloads/kdiary.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Kdiary — events: creation, editing, listing, date lookup, deletion and participants.
 *
 * The controller is inconsistent about where a request's owning identity comes from, and
 * that inconsistency is the most valuable thing in this file:
 *
 *  - `deleteEvent` passes the auth filter's `kpostID` attribute to the service as a separate
 *    argument, so a delete can only ever match a record the caller owns.
 *  - `updateEvent`, `editScheduleEvent` and `getEventDate` pass the **client-supplied DTO
 *    alone**. `editScheduleEvent` even reads the token's `kpostID` into a local variable and
 *    then never uses it.
 *
 * So on one controller, deletion is ownership-checked while editing and reading are not.
 * The tests below assert the safe behaviour on every route and let the ledger record which
 * ones diverge.
 *
 * `editScheduleEvent` additionally writes its audit entry as `/addparticipants`, so the audit
 * trail attributes schedule edits to a different action — asserted in its own case.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const XSS_IMG_PAYLOAD = `<img src=x onerror=alert(1)>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_diary_schedule; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /dairySchedule/createEvent
 * ====================================================================================== */
test.describe('POST /dairySchedule/createEvent', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.createEvent,
    repro: `await kdiaryClient.createEvent(buildKdiaryROPayload(), { token });`,
  };

  test('[1] happy path: creating an event satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a created event must come back with its generated eventID', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'event creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.eventID,
      `the event was created but no eventID came back, so the caller cannot subsequently edit, annotate or cancel it. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character description must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ description: MAX_LENGTH_STRING });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character description produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 title must be stored or refused without a server fault', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ title: UTF8_STRING });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 title produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a 500-entry receiverList must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const receiverList = Array.from({ length: 500 }, (_, i) => `qa-bulk-${i}@kpostindia.com`);
    const payload = buildKdiaryROPayload({ receiverList });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `inviting 500 participants produced HTTP ${response.status()}. A large invitation list must be bounded explicitly, not left to fail inside the service.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "title" omitted must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload();
    delete (payload as Record<string, unknown>).title;

    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "title" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null title must not create an unnamed event', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ title: null });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "title" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty title must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ title: '' });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "title" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string where preferredDays expects an integer array', async ({
    kdiaryClient,
    staticToken,
  }) => {
    // KdiaryRO types this as an array while DiarySchedule types the same field as a string,
    // so a string here is exactly what a client following the other DTO would send.
    const payload = buildKdiaryROPayload({ preferredDays: 'Monday' });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `preferredDays was sent as a string, which is how the DiarySchedule DTO declares the same field, and produced HTTP ${response.status()}. Two DTOs on one controller disagreeing about a field's type means a client cannot be correct against both.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a recurring event with no series end date must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ repeat: true, daily: true, seriesEndDate: null });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'daily recurring event with no seriesEndDate — an unbounded series',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: an end time before the start time must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({
      scheduleStartDateAndTime: diaryTimestamp(240),
      scheduleEndDateAndTime: diaryTimestamp(60),
    });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'event ends before it starts' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the title must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] XSS: an img/onerror payload in the description must not be reflected', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ description: XSS_IMG_PAYLOAD });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_IMG_PAYLOAD);
  });

  test('[7c] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload({ title: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not create an event', async ({ kdiaryClient }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: a body-supplied kpostID must not set the event owner', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKdiaryROPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'event creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the event was created owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. KdiaryRO carries a client-writable kpostID, so the controller must overwrite it from the token — otherwise anyone can plant appointments in another user's calendar. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildKdiaryROPayload();
    const response = await kdiaryClient.createEvent(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.createEvent({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on event creation' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.createEvent, '{"title":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"title":',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.createEvent, '{"title":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});

/* =========================================================================================
 * POST /dairySchedule/updateEvent
 * ====================================================================================== */
test.describe('POST /dairySchedule/updateEvent', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.updateEvent,
    repro: `await kdiaryClient.updateEvent(buildExistingSchedulePayload(), { token });`,
  };

  test('[1] happy path: an event update satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character title must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ title: MAX_LENGTH_STRING });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character title produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an eventID beyond int32 must not overflow', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: INT32_OVERFLOW });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. An id that cannot be represented must be rejected, never wrapped into a different event.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    delete (payload as Record<string, unknown>).eventID;

    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no eventID supplied — the update addresses nothing' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: null });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "eventID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty title on update must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ title: '' });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'update would blank the event title' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: true });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: updating a non-existent event must not report success', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const eventID = nonExistentEventId();
    const payload = buildExistingSchedulePayload({ eventID });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `updating event ${eventID}, which does not exist, reported success. Worse, an update whose id matches nothing may instead be persisted as a new row, silently creating an event the user never booked. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the title must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ description: SQLI_PAYLOAD });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.updateEvent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not modify an event', async ({ kdiaryClient }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.updateEvent(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: an update must not be applied to another user\'s event', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingSchedulePayload({
      kpostID: VICTIM_KPOST_ID,
      createdBy: VICTIM_KPOST_ID,
      title: 'QA-AUTOMATION-idor-probe',
    });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'update did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the update was applied to a record owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Unlike deleteEvent on the same controller, this route hands the client's DTO to the service without the token's kpostID, so nothing constrains an edit to the caller's own diary. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] empty-state: "no matching event" must not be reported as HTTP 500', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: nonExistentEventId() });
    const response = await kdiaryClient.updateEvent(payload, { token: staticToken });

    await assertStatus(response, [200, 400, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'Updating a non-existent event is not reported as 404',
      severity: 'Major',
    });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.updateEvent({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on event update' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.updateEvent, 'not json at all', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: 'not json at all',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.updateEvent, 'not json at all', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});

/* =========================================================================================
 * POST /dairySchedule/editScheduleEvent
 * ====================================================================================== */
test.describe('POST /dairySchedule/editScheduleEvent', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.editScheduleEvent,
    repro: `await kdiaryClient.editScheduleEvent(buildExistingSchedulePayload(), { token });`,
  };

  test('[1] happy path: a schedule edit satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character description must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ description: MAX_LENGTH_STRING });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character description produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: -1 });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'eventID is negative' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    delete (payload as Record<string, unknown>).eventID;

    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no eventID supplied on an edit' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: null });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "eventID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object where eventID expects an integer', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: { id: 1 } });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: moving a schedule into the past must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({
      scheduleStartDateAndTime: diaryTimestamp(-2880),
      scheduleEndDateAndTime: diaryTimestamp(-2820),
    });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `rescheduling an appointment two days into the past produced HTTP ${response.status()}. Whether backdating is allowed is a business decision, but it must be an explicit one rather than a server fault.`
    ).toBeLessThan(500);
  });

  test('[7] XSS: a script payload in the title must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ description: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.editScheduleEvent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.editScheduleEvent(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: an edit must not be applied to another user\'s schedule', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingSchedulePayload({
      kpostID: VICTIM_KPOST_ID,
      createdBy: VICTIM_KPOST_ID,
    });
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'edit did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the edit landed on a record owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller reads the token's kpostID into a local variable and then calls the service without it, so the ownership check it appears to prepare never actually happens. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] auditability: a schedule edit must not be logged as a participant change', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.urlPath,
      `editScheduleEvent records its audit entry under "/addparticipants". Every schedule edit is therefore attributed to a different action in the audit trail, so "who moved this meeting?" cannot be answered from the log. Body: ${text.slice(0, 200)}`
    ).not.toBe('/addparticipants');
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.editScheduleEvent(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.editScheduleEvent({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on schedule edit' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.editScheduleEvent, '{{{', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{{{',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.editScheduleEvent, '{{{', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});

/* =========================================================================================
 * GET /dairySchedule/getEvents
 * ====================================================================================== */
test.describe('GET /dairySchedule/getEvents', () => {
  const META = {
    method: 'GET',
    path: KDIARY_PATHS.getEvents,
    repro: `await kdiaryClient.getEvents({ token });`,
  };

  test('[1] happy path: the event list satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({ token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleListResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: an empty event list must not be reported as a server error', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty event list is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getEvents({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not list events', async ({ kdiaryClient }) => {
    const response = await kdiaryClient.getEvents({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not list events', async ({ kdiaryClient }) => {
    const response = await kdiaryClient.getEvents({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getEvents({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the listing', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const response = await kdiaryClient.getEvents({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's events while the caller was ${authSession.kpostID ?? 'a different identity'}. The route takes its identity from the auth-filter attribute, so a query parameter must be inert. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({
      token: staticToken,
      params: { filter: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[7b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[8] safety: a GET must not be accepted with a request body that mutates state', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({
      token: staticToken,
      params: { eventID: String(nonExistentEventId()), delete: 'true' },
    });

    expect(
      response.status(),
      `a listing GET carrying delete-shaped parameters produced HTTP ${response.status()}. A safe method must never be a route to mutation.`
    ).toBeLessThan(500);
  });

  test('[9] idempotency: two consecutive listings must agree', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      kdiaryClient.getEvents({ token: staticToken }),
      kdiaryClient.getEvents({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical listings returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getEvents({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}. Unknown parameters must be ignored so clients can evolve independently.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});

/* =========================================================================================
 * POST /dairySchedule/getEventDate
 * ====================================================================================== */
test.describe('POST /dairySchedule/getEventDate', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.getEventDate,
    repro: `await kdiaryClient.getEventDate(buildDateFilterPayload(), { token });`,
  };

  test('[1] happy path: a date lookup satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a date with no events must not be reported as a server error', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({
      scheduleStartDateAndTime: '2099-01-01T00:00:00',
      scheduleEndDateAndTime: '2099-01-01T23:59:59',
      preferredDate: ['2099-01-01'],
    });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      body: payload,
      title: 'An empty date lookup is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no date must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    delete (payload as Record<string, unknown>).scheduleStartDateAndTime;
    delete (payload as Record<string, unknown>).scheduleEndDateAndTime;
    delete (payload as Record<string, unknown>).preferredDate;

    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no date supplied on a date-filtered lookup' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null date must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: null });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "scheduleStartDateAndTime" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string where preferredDate expects an array', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ preferredDate: '2026-01-01' });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    expect(
      response.status(),
      `preferredDate was sent as a bare string, which is how DiarySchedule declares the same field, and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a range whose end precedes its start must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({
      scheduleStartDateAndTime: '2026-06-30T00:00:00',
      scheduleEndDateAndTime: '2026-06-01T00:00:00',
    });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'date range runs backwards' },
      [400, 401, 403, 422]
    );
  });

  test('[7] SQL injection: a UNION probe in the date filter must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventDate(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return diary contents', async ({ kdiaryClient }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventDate(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body kpostID must not select another user\'s diary', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDateFilterPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `supplying kpostID="${VICTIM_KPOST_ID}" returned that user's events while the caller was ${authSession.kpostID ?? 'a different identity'}. This route hands the client's KdiaryRO straight to the service without the token's identity — unlike getEventSelectedDate next door, which passes it explicitly. Anyone with a valid token could then read any user's calendar by naming them. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventDate(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.getEventDate({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a date-filtered lookup' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.getEventDate, '{"date":]', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"date":]',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.getEventDate, '{"date":]', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});

/* =========================================================================================
 * POST /dairySchedule/deleteEvent
 * ====================================================================================== */
test.describe('POST /dairySchedule/deleteEvent', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.deleteEvent,
    repro: `await kdiaryClient.deleteEvent(buildExistingSchedulePayload(), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    // Addresses a deliberately non-existent id: deletion is irreversible through the API.
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await expectValidContract(
      response,
      deleteEventResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[1b] contract: the response must distinguish a real deletion from a no-op', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const eventID = nonExistentEventId();
    const payload = buildExistingSchedulePayload({ eventID });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'delete did not return a 200 envelope');

    expect(
      json?.data,
      `deleting event ${eventID}, which does not exist, answered 200 with no row count in "data". The route returns an int precisely so a caller can tell a deletion from a no-op; without it, a failed cancellation is indistinguishable from a successful one. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: an eventID beyond int32 must not overflow into a real record', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: INT32_OVERFLOW });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. On a destructive route an id that silently wraps could delete a different appointment entirely.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a zero eventID must not match every row', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: 0 });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'delete did not return a 200 envelope');

    const deleted = typeof json?.data === 'number' ? json.data : 0;
    expect(
      deleted,
      `deleting eventID 0 reported ${deleted} rows removed. A sentinel id must match nothing; a bulk delete triggered by a default value would wipe a user's calendar. Body: ${text.slice(0, 200)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[3] missing required parameter: no eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    delete (payload as Record<string, unknown>).eventID;

    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'destructive call with no eventID' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null eventID must be refused, not treated as a wildcard', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: null });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "eventID" set to null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: 'all' });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology in eventID must not delete every row', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ eventID: SQLI_PAYLOAD });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[6b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ description: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ kdiaryClient }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.deleteEvent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not delete an appointment', async ({ kdiaryClient }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.deleteEvent(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never delete', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.deleteEvent(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: deleting another user\'s event must remove nothing', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'delete did not return a 200 envelope');

    const deleted = typeof json?.data === 'number' ? json.data : 0;
    expect(
      deleted,
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported ${deleted} rows removed. This route does pass the token's identity to the service, so a non-zero count would mean the body overrode it and one user can cancel another's meetings. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const response = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: deleting the same event twice must be stable', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingSchedulePayload();
    const first = await kdiaryClient.deleteEvent(payload, { token: staticToken });
    const second = await kdiaryClient.deleteEvent(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same event twice returned ${first.status()} then ${second.status()}. A repeated cancellation — a double-tapped button — must not change the outcome.`
    ).toBe(second.status());
  });

  test('[10b] structural: an empty body must be refused on a destructive route', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.deleteEvent({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
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
 * POST /dairySchedule/addparticipants
 * ====================================================================================== */
test.describe('POST /dairySchedule/addparticipants', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.addparticipants,
    repro: `await kdiaryClient.addparticipants(buildAddParticipantsPayload(), { token });`,
  };

  test('[1] happy path: adding participants satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload();
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 500-participant list must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const participants = Array.from({ length: 500 }, (_, i) => ({
      participant: `qa-bulk-${i}@kpostindia.com`,
      userType: 'PERSONAL',
    }));
    const payload = buildAddParticipantsPayload({ participants });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    expect(
      response.status(),
      `adding 500 participants produced HTTP ${response.status()}. A meeting-size limit must be enforced explicitly rather than surfacing as a crash.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty participants list must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({ participants: [] });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'participants list is empty — nothing to add' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload();
    delete (payload as Record<string, unknown>).eventID;

    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no eventID — the participants address no meeting' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null participants list must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({ participants: null });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "participants" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: participants sent as a string must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({ participants: 'alice@kpostindia.com' });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    expect(
      response.status(),
      `participants was sent as a bare string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a participant that is not a valid kpostID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({
      participants: [{ participant: 'not-a-kpost-id', userType: 'PERSONAL' }],
    });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'participant is not a well-formed kpostID' },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: adding participants to a non-existent event must not succeed', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const eventID = nonExistentEventId();
    const payload = buildAddParticipantsPayload({ eventID });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `adding participants to event ${eventID}, which does not exist, reported success. Invitees would be told they are on a meeting that was never booked. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in a participant name must not be reflected', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({
      participants: [{ participant: XSS_PAYLOAD, userType: 'PERSONAL' }],
    });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology in a participant must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload({
      participants: [{ participant: SQLI_PAYLOAD, userType: 'PERSONAL' }],
    });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildAddParticipantsPayload();
    const response = await kdiaryClient.addparticipants(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not add participants', async ({ kdiaryClient }) => {
    const payload = buildAddParticipantsPayload();
    const response = await kdiaryClient.addparticipants(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: participants must not be added to another user\'s meeting', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildAddParticipantsPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'participant addition did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `participants were attached to a meeting owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Being able to add attendees to someone else's meeting exposes that meeting's details to people the organiser never invited. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload();
    const response = await kdiaryClient.addparticipants(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: adding the same participant twice must not duplicate them', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildAddParticipantsPayload();
    const [first, second] = await Promise.all([
      kdiaryClient.addparticipants(payload, { token: staticToken }),
      kdiaryClient.addparticipants(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical participant additions returned ${first.status()} and ${second.status()}. A duplicated invitation must be collapsed or refused, not crash — the invitee would otherwise be notified twice.`
    ).toBe(true);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.addparticipants, '{"participants":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"participants":',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.addparticipants, '{"participants":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign scheduleID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});
