import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KDIARY_PATHS } from '../../src/api/clients/kdiary.client';
import {
  diaryScheduleListResponseSchema,
  diaryScheduleResponseSchema,
  todaySchedulesResponseSchema,
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
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildDateFilterPayload,
  buildRemarksPayload,
  buildSchedulePayload,
  diaryTimestamp,
  nonExistentEventId,
} from '../../src/api/payloads/kdiary.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Kdiary — schedule creation, the day view, remarks and date lookup.
 *
 * Two controller behaviours drive most of the assertions in this file.
 *
 * 1. **An empty result is reported as HTTP 500.** Every list route decides its status with
 *    `KPOSTValidation.isEmpty(responseObject)`: non-empty is 200, empty is 500 with
 *    `status: FAILURE`. A user with a clear calendar is not an error, so any client that
 *    treats 5xx as "the diary is broken" will show a fault on an ordinary quiet day. This is
 *    asserted rather than accommodated.
 *
 * 2. **Identity scoping is inconsistent across the controller.** `updateScheduleRemarks`
 *    overwrites the body's `kpostID` from the bearer token, and `getEventSelectedDate` passes
 *    the token's identity to the service — but `getEventDate` (see events.spec.ts) does
 *    neither. Routes on the same controller, bound to DTOs that both carry `kpostID`,
 *    disagree about who owns the request.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null,null--`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /dairySchedule/createSchedule
 * ====================================================================================== */
test.describe('POST /dairySchedule/createSchedule', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.createSchedule,
    repro: `await kdiaryClient.createSchedule(buildSchedulePayload(), { token });`,
  };

  test('[1] happy path: creating a schedule satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a created schedule must come back with its generated eventID', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'schedule creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    if (data?.eventID === undefined) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: payload,
          title: 'createSchedule succeeds but returns no eventID — the schedule cannot be edited or cancelled',
          scenario: `the schedule was created but no eventID came back. Every later route — updateEvent, deleteEvent, addparticipants — addresses a schedule by that id, so the caller cannot edit or cancel what it just booked. Body: ${text.slice(0, 200)}`,
        },
        'Business Logic Flaw',
        'Major'
      );
    }
  });

  test('[2] boundary: a 5000-character title must be handled without a server fault', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ title: MAX_LENGTH_STRING });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character title produced HTTP ${response.status()}. An over-long title must be refused with a clear 400, not crash the diary.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 title must survive storage without a server fault', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ title: UTF8_STRING });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 title produced HTTP ${response.status()}. Users book meetings in their own script, so this is ordinary input.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: priority beyond int32 must not overflow', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ priority: INT32_OVERFLOW });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    expect(
      response.status(),
      `priority ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. A value that cannot be stored must be rejected, not wrapped into a different priority.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "title" omitted must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    delete (payload as Record<string, unknown>).title;

    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "title" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no start time must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    delete (payload as Record<string, unknown>).scheduleStartDateAndTime;

    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "scheduleStartDateAndTime" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null title must not create an unnamed schedule', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ title: null });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

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
    const payload = buildSchedulePayload({ title: '' });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "title" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string priority where the contract expects a number', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ priority: 'urgent' });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    expect(
      response.status(),
      `priority was sent as the string "urgent" and produced HTTP ${response.status()}. A binding failure is a client error, not a server fault.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where participants expects objects', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ participants: ['not-an-object'] });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    expect(
      response.status(),
      `participants was sent as an array of bare strings and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: an end time before the start time must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({
      scheduleStartDateAndTime: diaryTimestamp(240),
      scheduleEndDateAndTime: diaryTimestamp(60),
    });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'schedule ends three hours before it starts',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: a malformed timestamp must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ scheduleStartDateAndTime: 'not-a-timestamp' });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'scheduleStartDateAndTime is not a parseable date' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the title must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await kdiaryClient.createSchedule(buildSchedulePayload({ title: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7b] SQL injection: a tautology in the title must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload({ title: SQLI_PAYLOAD });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not book a schedule', async ({ kdiaryClient }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] ownership: a body-supplied kpostID must not set the schedule owner', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSchedulePayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'schedule creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the schedule was created owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller reads kpostID from the request attribute set by the auth filter, so a body value must be ignored — otherwise any user can write appointments into anyone's diary. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.createSchedule({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on schedule creation' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.createSchedule, '{invalid json', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{invalid json',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.createSchedule, '{invalid json', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[10c] idempotency: two identical concurrent creations must not both silently book', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildSchedulePayload();
    const [first, second] = await Promise.all([
      kdiaryClient.createSchedule(payload, { token: staticToken }),
      kdiaryClient.createSchedule(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical creations returned ${first.status()} and ${second.status()}. A double-submitted booking form must not produce a server fault; duplicate handling is a business decision the API has to make explicitly.`
    ).toBe(true);
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
 * GET /dairySchedule/getTodaySchedules
 * ====================================================================================== */
test.describe('GET /dairySchedule/getTodaySchedules', () => {
  const META = {
    method: 'GET',
    path: KDIARY_PATHS.getTodaySchedules,
    repro: `await kdiaryClient.getTodaySchedules({ token });`,
  };

  test('[1] happy path: the day view satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: staticToken });

    await expectValidContract(
      response,
      todaySchedulesResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[1b] contract: the day view must merge the schedule list with the day report', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'day view did not return data');

    if (json?.data === undefined) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          title: 'getTodaySchedules answered 200 but carried no data',
          scenario: `getTodaySchedules answered 200 but carried no data. The controller composes the schedule list and the day's report into one payload precisely so the diary screen needs a single call. Body: ${text.slice(0, 200)}`,
        },
        'Business Logic Flaw',
        'Major'
      );
    }

    expect(
      json?.data,
      `getTodaySchedules answered 200 but carried no data. The controller composes the schedule list and the day's report into one payload precisely so the diary screen needs a single call. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] empty-state: an empty diary must not be reported as a server error', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty day view is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return diary contents', async ({ kdiaryClient }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return diary contents', async ({ kdiaryClient }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the day view', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'day view did not return data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned records owned by that user while the caller was ${authSession.kpostID ?? 'a different identity'}. The route derives identity from the token, so a query parameter must not widen the scope — a diary is private. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[5b] injection: a UNION SELECT probe must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({
      token: staticToken,
      params: { date: SQLI_UNION_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_UNION_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[7b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodaySchedules({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[8] idempotency: two consecutive reads must agree', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      kdiaryClient.getTodaySchedules({ token: staticToken }),
      kdiaryClient.getTodaySchedules({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads of the day view returned ${first.status()} and ${second.status()}. A safe GET must be stable; a diary screen that refreshes cannot show a different outcome each time.`
    ).toBe(second.status());
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
 * POST /dairySchedule/updateScheduleRemarks
 * ====================================================================================== */
test.describe('POST /dairySchedule/updateScheduleRemarks', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.updateScheduleRemarks,
    repro: `await kdiaryClient.updateScheduleRemarks(buildRemarksPayload(), { token });`,
  };

  test('[1] happy path: a remarks update satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload();
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await expectValidContract(
      response,
      diaryScheduleResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character remarks description must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ remarksDescription: MAX_LENGTH_STRING });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character remarksDescription produced HTTP ${response.status()}. An over-long note must be refused explicitly, not crash the update.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty eventIds list must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ eventIds: [] });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'eventIds is an empty list — nothing to update' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no eventID at all must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload();
    delete (payload as Record<string, unknown>).eventID;
    delete (payload as Record<string, unknown>).eventIds;

    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'neither eventID nor eventIds supplied' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null eventID must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ eventID: null });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "eventID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string eventID where the contract expects an integer', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ eventID: 'not-a-number' });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID was sent as a non-numeric string and produced HTTP ${response.status()}. A binding failure is a client error.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: remarks against a non-existent event must not report success', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const eventID = nonExistentEventId();
    const payload = buildRemarksPayload({ eventID, eventIds: [eventID] });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `updating remarks on event ${eventID}, which does not exist, reported success. A caller cannot tell a real update from a write that matched nothing, so a failed edit looks saved. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in remarksDescription must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ remarksDescription: XSS_PAYLOAD });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload({ remarksDescription: SQLI_PAYLOAD });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildRemarksPayload();
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not update remarks', async ({ kdiaryClient }) => {
    const payload = buildRemarksPayload();
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: the body kpostID must be overridden by the token identity', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildRemarksPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'remarks update did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the remarks update was attributed to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This controller explicitly calls setKpostID from the auth-filter attribute, so a body value reaching the service would mean annotations can be written into another user's diary. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload();
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildRemarksPayload();
    const response = await kdiaryClient.updateScheduleRemarks(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.updateScheduleRemarks({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on remarks update' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(
      KDIARY_PATHS.updateScheduleRemarks,
      '{"eventID":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"eventID":',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.updateScheduleRemarks, '{"eventID":', { token });`,
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
 * POST /dairySchedule/getEventSelectedDate
 * ====================================================================================== */
test.describe('POST /dairySchedule/getEventSelectedDate', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.getEventSelectedDate,
    repro: `await kdiaryClient.getEventSelectedDate(buildDateFilterPayload(), { token });`,
  };

  test('[1] happy path: a date lookup satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

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
    // A date far in the future cannot legitimately hold appointments for a QA account.
    const payload = buildDateFilterPayload({
      scheduleStartDateAndTime: '2099-01-01T00:00:00',
      scheduleEndDateAndTime: '2099-01-01T23:59:59',
      preferredDate: ['2099-01-01'],
    });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      body: payload,
      title: 'An empty date lookup is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no date at all must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    delete (payload as Record<string, unknown>).scheduleStartDateAndTime;
    delete (payload as Record<string, unknown>).scheduleEndDateAndTime;
    delete (payload as Record<string, unknown>).preferredDate;

    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no date supplied on a date-filtered lookup' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null date must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: null });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "scheduleStartDateAndTime" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric date must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: 20990101 });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    expect(
      response.status(),
      `scheduleStartDateAndTime was sent as the number 20990101 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a malformed date string must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: '31-02-2026 99:99:99' });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an impossible date/time is supplied' },
      [400, 401, 403, 422]
    );
  });

  test('[7] SQL injection: a tautology in the date filter must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ scheduleStartDateAndTime: SQLI_UNION_PAYLOAD });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload({ title: XSS_PAYLOAD });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return diary contents', async ({ kdiaryClient }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body kpostID must not re-scope the lookup to another diary', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDateFilterPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `supplying kpostID="${VICTIM_KPOST_ID}" in the body returned that user's events while the caller was ${authSession.kpostID ?? 'a different identity'}. This route passes the token identity to the service as a separate argument specifically so the body cannot choose whose diary is read. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildDateFilterPayload();
    const response = await kdiaryClient.getEventSelectedDate(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.getEventSelectedDate({}, { token: staticToken });

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
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.getEventSelectedDate, '[[[', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '[[[',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.getEventSelectedDate, '[[[', { token });`,
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
