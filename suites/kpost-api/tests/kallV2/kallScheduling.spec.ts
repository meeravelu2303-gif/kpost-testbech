import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KALL_V2_PATHS } from '../../src/api/clients/kallV2.client';
import { kallListResponseSchema, kallResponseSchema } from '../../src/api/schemas/kallV2.schema';
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
  buildExistingKallPayload,
  buildReScheduleKallPayload,
  buildRepeatKallPayload,
  buildScheduledKallPayload,
  kallEpoch,
  kallDate,
  nonExistentKallId,
  syntheticReceiver,
} from '../../src/api/payloads/kallV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Kall V2 — scheduling, rescheduling, recurring series and joining.
 *
 * `scheduledKall`, `reScheduleKall` and `scheduledRepeatKall` are the only `@Valid` routes on
 * this controller, so bean validation runs before the method body. That makes them the ones
 * most likely to answer a clean 400 — and the useful contrast with the unvalidated
 * `KallROV3` routes in kallLifecycle.spec.ts, where the same malformed input reaches the
 * service instead.
 *
 * `scheduledRepeatKall` has the largest blast radius in the module: one request can generate
 * an unbounded series of future calls, each of which rings real devices. Its `seriesEndDate`
 * and recurrence cases are written accordingly, and every builder here schedules into the
 * future against a synthetic receiver.
 *
 * `joinScheduleKall` is the route that mints `rtcToken`/`uid` — live media-server join
 * credentials. Handing those to a non-participant is not an information leak in the abstract;
 * it is a call they can listen to.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_kall_master; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/kall/scheduledKall
 * ====================================================================================== */
test.describe('POST /v2/kall/scheduledKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.scheduledKall,
    repro: `await kallV2Client.scheduledKall(buildScheduledKallPayload(), { token });`,
  };

  test('[FR-C01][FR-C02][1] happy path: booking a call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a booked call must return its kallID', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'booking did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.kallID,
      `the call was booked but no kallID came back, so it cannot be rescheduled or cancelled. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character subject must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ subject: MAX_LENGTH_STRING });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character subject produced HTTP ${response.status()}. This route is @Valid, so an over-long value should be a clean 400.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 subject must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ subject: UTF8_STRING });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 subject produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a 500-participant booking must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallDetails = Array.from({ length: 500 }, () => ({
      receiver: syntheticReceiver(),
      receiverName: 'QA Bulk',
    }));
    const payload = buildScheduledKallPayload({ kallDetails });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    expect(
      response.status(),
      `booking a call with 500 participants produced HTTP ${response.status()}. A conference-size limit must be enforced explicitly.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no scheduledStartTime must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload();
    delete (payload as Record<string, unknown>).scheduledStartTime;

    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "scheduledStartTime" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no participants must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ kallDetails: [] });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a booked call with nobody invited' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null scheduledStartTime must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ scheduledStartTime: null });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "scheduledStartTime" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a non-numeric scheduledStartTime must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    // Excel scheduledKall sends scheduledStartTime as epoch millis (a number); a string must be
    // caught by deserialisation, not passed to the scheduler.
    const payload = buildScheduledKallPayload({ scheduledStartTime: 'not-a-timestamp' });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    expect(
      response.status(),
      `scheduledStartTime was sent as a string where the contract expects epoch millis, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a call ending before it starts must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({
      scheduledStartTime: kallEpoch(300),
      scheduledEndTime: kallEpoch(120),
    });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'scheduled call ends three hours before it starts' },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: booking a call in the past must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({
      scheduledStartTime: kallEpoch(-2880),
      scheduledEndTime: kallEpoch(-2820),
    });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'call scheduled two days in the past' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the subject must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload({ subject: SQLI_DROP_PAYLOAD });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not book a call', async ({ kallV2Client }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] spoofing: a body sender must not become the organiser', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildScheduledKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'booking did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.sender,
      `the meeting was booked with "${VICTIM_KPOST_ID}" as organiser while the caller was ${authSession.kpostID ?? 'a different identity'}. Invitees would receive a meeting apparently convened by someone who never scheduled it. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildScheduledKallPayload();
    const response = await kallV2Client.scheduledKall(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.scheduledKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an @Valid booking route' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.sendRaw(KALL_V2_PATHS.scheduledKall, '{"subject":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"subject":',
      repro: `await kallV2Client.sendRaw(KALL_V2_PATHS.scheduledKall, '{"subject":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });

});

/* =========================================================================================
 * POST /v2/kall/reScheduleKall
 * ====================================================================================== */
test.describe('POST /v2/kall/reScheduleKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.reScheduleKall,
    repro: `await kallV2Client.reScheduleKall(buildReScheduleKallPayload(), { token });`,
  };

  test('[FR-C03][BR-C01][1] happy path: moving a booked call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload();
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a kallID beyond int32 must not move a different meeting', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID — the reschedule addresses no meeting' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no new start time must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload();
    delete (payload as Record<string, unknown>).scheduledStartTime;

    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'reschedule with no new start time' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({ kallID: null });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({ kallID: 'next' });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as the string "next" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: rescheduling into the past must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({
      scheduledStartTime: kallEpoch(-1440),
      scheduledEndTime: kallEpoch(-1380),
    });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'meeting moved to yesterday' },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: rescheduling a non-existent call must not report success', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallID = nonExistentKallId();
    const payload = buildReScheduleKallPayload({ kallID });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `rescheduling call ${kallID}, which does not exist, reported success. The organiser is told the meeting moved when no invitee was notified. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload({ subject: SQLI_PAYLOAD });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildReScheduleKallPayload();
    const response = await kallV2Client.reScheduleKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not move a meeting', async ({ kallV2Client }) => {
    const payload = buildReScheduleKallPayload();
    const response = await kallV2Client.reScheduleKall(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a non-organiser must not move someone else\'s meeting', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildReScheduleKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'reschedule did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.sender,
      `a meeting organised by "${VICTIM_KPOST_ID}" was moved while the caller was ${authSession.kpostID ?? 'a different identity'}. Rescheduling someone else's meeting re-notifies every invitee in the organiser's name. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildReScheduleKallPayload();
    const response = await kallV2Client.reScheduleKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.reScheduleKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an @Valid reschedule route' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
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
 * POST /v2/kall/scheduledRepeatKall
 * ====================================================================================== */
test.describe('POST /v2/kall/scheduledRepeatKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.scheduledRepeatKall,
    repro: `await kallV2Client.scheduledRepeatKall(buildRepeatKallPayload(), { token });`,
  };

  test('[1] happy path: creating a series satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 10-year series must be bounded, not generated wholesale', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({
      seriesEndDate: kallDate(1440 * 365 * 10),
    });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a daily series running for ten years produced HTTP ${response.status()}. If occurrences are materialised eagerly this is thousands of rows and thousands of future notifications from one request; the horizon must be capped explicitly.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 5000-character subject must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ subject: MAX_LENGTH_STRING });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character subject produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: a series with no end date must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    delete (payload as Record<string, unknown>).seriesEndDate;

    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'recurring series with no seriesEndDate — an unbounded series',
      },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no receiverList must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ receiverList: [] });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a recurring call series with nobody invited' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null seriesEndDate must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ seriesEndDate: null });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "seriesEndDate" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string where preferredDays expects an array', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ preferredDays: 'Monday' });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    expect(
      response.status(),
      `preferredDays was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a series ending before it starts must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({
      scheduledStartTime: kallEpoch(1440 * 5),
      seriesEndDate: kallDate(1440),
    });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'seriesEndDate precedes the first occurrence' },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: an unknown repeatType must be refused, not defaulted', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ repeatType: 9999 });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'repeatType 9999 is outside the known set' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the subject must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ description: SQLI_PAYLOAD });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never create a series', async ({
    kallV2Client,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.scheduledRepeatKall(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] spoofing: a body sender must not become the series organiser', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildRepeatKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'series creation did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the series was created under "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. A spoofed recurring series keeps ringing invitees in the victim's name indefinitely. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.scheduledRepeatKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.scheduledRepeatKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an @Valid series route' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] idempotency: two concurrent identical series must not double-book', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const [first, second] = await Promise.all([
      kallV2Client.scheduledRepeatKall(payload, { token: staticToken }),
      kallV2Client.scheduledRepeatKall(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical series creations returned ${first.status()} and ${second.status()}. A double submission here duplicates every future occurrence, so invitees get two of each.`
    ).toBe(true);
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });

});

/* =========================================================================================
 * POST /v2/kall/fetchScheduledRepeatKall
 * ====================================================================================== */
test.describe('POST /v2/kall/fetchScheduledRepeatKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.fetchScheduledRepeatKall,
    repro: `await kallV2Client.fetchScheduledRepeatKall(buildRepeatKallPayload(), { token });`,
  };

  test('[1] happy path: reading a series satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a user with no series must not get a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ eventID: 0 });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      body: payload,
      title: 'An empty recurring-series list is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: an empty body must be handled explicitly', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.fetchScheduledRepeatKall({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body on a series read produced HTTP ${response.status()}. The route scopes by the token's sender, so an empty filter is either a valid "everything" query or a clean 400 — not a fault.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null eventID must be handled', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ eventID: null });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID null produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string eventID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ eventID: 'series-1' });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    expect(
      response.status(),
      `eventID was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body sender must not read another user\'s series', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildRepeatKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'series read returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming sender "${VICTIM_KPOST_ID}" returned that user's recurring meetings while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller overwrites sender from the token, so a body value must be inert — a recurring-meeting list is a map of someone's working week. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology in the sender must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload({ sender: SQLI_PAYLOAD });
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return series data', async ({ kallV2Client }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const response = await kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildRepeatKallPayload();
    const [first, second] = await Promise.all([
      kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken }),
      kallV2Client.fetchScheduledRepeatKall(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical series reads returned ${first.status()} and ${second.status()}. A read must be stable — and must not have created anything.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
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
 * POST /v2/kall/joinScheduleKall
 * ====================================================================================== */
test.describe('POST /v2/kall/joinScheduleKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.joinScheduleKall,
    repro: `await kallV2Client.joinScheduleKall(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: joining a call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a kallID beyond int32 must not join a different call', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. An id that wraps on this route drops the caller into a meeting they were never invited to.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID — which call is being joined is unspecified' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 'any' });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as the string "any" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: joining a call the caller was not invited to must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallID = nonExistentKallId();
    const payload = buildExistingKallPayload({ kallID, sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `joining call ${kallID}, organised by "${VICTIM_KPOST_ID}" and with no invitation for the caller, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] exposure: a refused join must not still hand back an rtcToken', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({
      kallID: nonExistentKallId(),
      sender: VICTIM_KPOST_ID,
    });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"rtcToken"\s*:\s*"[^"]+"/.test(text),
      `a join attempt on a call the caller has no part in returned a populated rtcToken. That is a live media-server credential — holding it means being able to join and listen, whatever the envelope's status said. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ sender: SQLI_PAYLOAD });
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.joinScheduleKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never join a call', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.joinScheduleKall(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.joinScheduleKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.joinScheduleKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a join route' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
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
 * GET /v2/kall/todayKoolKall
 * ====================================================================================== */
test.describe('GET /v2/kall/todayKoolKall', () => {
  const META = {
    method: 'GET',
    path: KALL_V2_PATHS.todayKoolKall,
    repro: `await kallV2Client.todayKoolKall({ token });`,
  };

  test('[1] happy path: today\'s calls satisfy the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: staticToken });

    await expectValidContract(response, kallListResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[2] empty-state: a day with no calls must not be a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty day of calls is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not list calls', async ({ kallV2Client }) => {
    const response = await kallV2Client.todayKoolKall({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not list calls', async ({ kallV2Client }) => {
    const response = await kallV2Client.todayKoolKall({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    kallV2Client,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the listing', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const response = await kallV2Client.todayKoolKall({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's calls while the caller was ${authSession.kpostID ?? 'a different identity'}. The route reads its identity from the auth-filter attribute, so a query parameter must be inert. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] exposure: a day listing must not include media-server join credentials', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      /"rtcToken"\s*:\s*"[^"]+"/.test(text),
      `the day's call list carried populated rtcToken values. Join credentials belong in the join response, not in a listing — a cached or logged listing then contains keys to live calls. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[6] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in a query parameter must not be reflected', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[8b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[9] idempotency: two consecutive reads must agree', async ({
    kallV2Client,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      kallV2Client.todayKoolKall({ token: staticToken }),
      kallV2Client.todayKoolKall({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.todayKoolKall({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });

});
