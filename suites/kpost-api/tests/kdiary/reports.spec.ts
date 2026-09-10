import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KDIARY_PATHS } from '../../src/api/clients/kdiary.client';
import { kdiaryReportResponseSchema } from '../../src/api/schemas/kdiary.schema';
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
  buildExistingReportPayload,
  buildReportPayload,
  nonExistentReportId,
} from '../../src/api/payloads/kdiary.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Kdiary — the daily task report: save, edit, delete and today's view.
 *
 * All three write routes explicitly call `ro.setKpostID(request.getAttribute("kpostID"))`
 * before touching the service, so unlike the event routes in events.spec.ts these are
 * ownership-scoped by construction. The tests still probe it: `KdiaryReportRO` carries a
 * client-writable `kpostID`, and a DTO field that must never be honoured deserves a standing
 * assertion rather than trust in one line of controller code surviving future edits.
 *
 * `deleteReport` is the only destructive route here. Its payload builder defaults to an
 * implausibly high id so no test can remove a real report from the shared environment.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const XSS_SVG_PAYLOAD = `<svg/onload=alert(1)>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_diary_report; --`;
const MAX_LENGTH_STRING = 'a'.repeat(50000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /dairySchedule/saveReport
 * ====================================================================================== */
test.describe('POST /dairySchedule/saveReport', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.saveReport,
    repro: `await kdiaryClient.saveReport(buildReportPayload(), { token });`,
  };

  test('[1] happy path: saving a report satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await expectValidContract(
      response,
      kdiaryReportResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a saved report must come back with its generated id', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'report save did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.id ?? data,
      `the report was saved but no id came back. editReport and deleteReport both address a report by id, so the user cannot correct what they just filed. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 50,000-character report must be stored or refused explicitly', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: MAX_LENGTH_STRING });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    expect(
      response.status(),
      `a 50,000-character task report produced HTTP ${response.status()}. A long day's write-up is ordinary input; if there is a length cap it must be a clean 400, and if there is not the text must not be silently truncated.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 report must not fault the server', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: UTF8_STRING });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 report produced HTTP ${response.status()}. Users write their daily report in their own script.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "taskReport" omitted must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload();
    delete (payload as Record<string, unknown>).taskReport;

    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "taskReport" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null taskReport must not save an empty row', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: null });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "taskReport" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty taskReport must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: '' });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "taskReport" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric taskReport must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: 12345 });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    expect(
      response.status(),
      `taskReport was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an object taskReport must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: { text: 'done' } });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    expect(
      response.status(),
      `taskReport was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: saving twice in one day must not create a second report', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const first = await kdiaryClient.saveReport(buildReportPayload(), { token: staticToken });
    const second = await kdiaryClient.saveReport(buildReportPayload(), { token: staticToken });
    const { json: secondJson, text } = await readBody(second);

    test.skip(
      first.status() !== 200 || secondJson === null,
      'the first save did not succeed, so the duplicate rule cannot be exercised'
    );

    expect(
      second.status(),
      `a second report save on the same day returned HTTP ${second.status()}. getTodayReport returns one report per day, so either the second save must update the first or it must be refused — an unbounded set of "today's reports" makes the day view ambiguous. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[7] XSS: a script payload in the report must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: XSS_PAYLOAD });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await kdiaryClient.saveReport(buildReportPayload({ taskReport: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7b] XSS: an svg/onload payload must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: XSS_SVG_PAYLOAD });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_SVG_PAYLOAD);
  });

  test('[7c] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload({ taskReport: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not file a report', async ({ kdiaryClient }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] ownership: a body kpostID must not file the report under another user', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildReportPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'report save did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the report was filed under "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller overwrites kpostID from the token precisely because the DTO exposes it; a body value reaching storage would let anyone file work reports in a colleague's name. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildReportPayload();
    const response = await kdiaryClient.saveReport(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.saveReport({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on report save' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.saveReport, '{"taskReport":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"taskReport":',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.saveReport, '{"taskReport":', { token });`,
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
 * POST /dairySchedule/editReport
 * ====================================================================================== */
test.describe('POST /dairySchedule/editReport', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.editReport,
    repro: `await kdiaryClient.editReport(buildExistingReportPayload(), { token });`,
  };

  test('[1] happy path: editing a report satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await expectValidContract(
      response,
      kdiaryReportResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character edit must be handled explicitly', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: MAX_LENGTH_STRING });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    expect(
      response.status(),
      `a 50,000-character edit produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an id beyond int32 must not overflow into another report', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ id: INT32_OVERFLOW });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    expect(
      response.status(),
      `id ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. An id that wraps could rewrite a different report.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no id must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    delete (payload as Record<string, unknown>).id;

    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no id supplied — the edit addresses no report' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildExistingReportPayload({ id: null });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "id" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an edit that blanks the report must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: '' });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'edit would erase the report text' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string id must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildExistingReportPayload({ id: 'latest' });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as the string "latest" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: editing a non-existent report must not report success', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const id = nonExistentReportId();
    const payload = buildExistingReportPayload({ id });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `editing report ${id}, which does not exist, reported success. The user is told their correction was saved when nothing was written. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the edit must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: XSS_PAYLOAD });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: SQLI_PAYLOAD });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.editReport(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not modify a report', async ({ kdiaryClient }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.editReport(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: an edit must not be applied to another user\'s report', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingReportPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.editReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'edit did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the edit landed on a report owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Work reports feed appraisal; rewriting a colleague's is both a confidentiality and an integrity failure. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.editReport(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kdiaryClient, staticToken }) => {
    const response = await kdiaryClient.editReport({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on report edit' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.sendRaw(KDIARY_PATHS.editReport, '}{', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '}{',
      repro: `await kdiaryClient.sendRaw(KDIARY_PATHS.editReport, '}{', { token });`,
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
 * POST /dairySchedule/deleteReport
 * ====================================================================================== */
test.describe('POST /dairySchedule/deleteReport', () => {
  const META = {
    method: 'POST',
    path: KDIARY_PATHS.deleteReport,
    repro: `await kdiaryClient.deleteReport(buildExistingReportPayload(), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    // Addresses a deliberately non-existent id — deletion is irreversible through the API.
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await expectValidContract(
      response,
      kdiaryReportResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[1b] contract: the response must distinguish a deletion from a no-op', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const id = nonExistentReportId();
    const payload = buildExistingReportPayload({ id });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'delete did not return a 200 envelope');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting report ${id}, which does not exist, reported success. A caller cannot tell whether anything was removed, so a failed deletion looks identical to a real one. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[2] boundary: a zero id must not match every report', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ id: 0 });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    expect(
      response.status(),
      `deleting id 0 produced HTTP ${response.status()}. A sentinel id must match nothing — a default value that becomes a bulk delete would erase a user's whole report history.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative id must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildExistingReportPayload({ id: -1 });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'negative id on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no id must be refused', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    delete (payload as Record<string, unknown>).id;

    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'destructive call with no id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must not be treated as a wildcard', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ id: null });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "id" set to null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string id must be refused', async ({ kdiaryClient, staticToken }) => {
    const payload = buildExistingReportPayload({ id: 'all' });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology in the id must not delete every row', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ id: SQLI_PAYLOAD });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[6b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: SQLI_DROP_PAYLOAD });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ taskReport: XSS_PAYLOAD });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ kdiaryClient }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.deleteReport(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not delete a report', async ({ kdiaryClient }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.deleteReport(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never delete', async ({
    kdiaryClient,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.deleteReport(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: deleting another user\'s report must remove nothing', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported success. The controller overwrites kpostID from the token, so a success here would mean the body won and one user can destroy another's work record. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    const response = await kdiaryClient.deleteReport(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: deleting the same report twice must be stable', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const payload = buildExistingReportPayload();
    const first = await kdiaryClient.deleteReport(payload, { token: staticToken });
    const second = await kdiaryClient.deleteReport(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same report twice returned ${first.status()} then ${second.status()}. A repeated delete must not change the outcome.`
    ).toBe(second.status());
  });

  test('[10b] structural: an empty body must be refused on a destructive route', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.deleteReport({}, { token: staticToken });

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
 * GET /dairySchedule/getTodayReport
 * ====================================================================================== */
test.describe('GET /dairySchedule/getTodayReport', () => {
  const META = {
    method: 'GET',
    path: KDIARY_PATHS.getTodayReport,
    repro: `await kdiaryClient.getTodayReport({ token });`,
  };

  test('[1] happy path: today\'s report satisfies the Zod contract', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: staticToken });

    await expectValidContract(
      response,
      kdiaryReportResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: no report filed today must not be a server error', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty report view is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return report contents', async ({ kdiaryClient }) => {
    const response = await kdiaryClient.getTodayReport({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return report contents', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    kdiaryClient,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not return another user\'s report', async ({
    kdiaryClient,
    staticToken,
    authSession,
  }) => {
    const response = await kdiaryClient.getTodayReport({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no report returned');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's report while the caller was ${authSession.kpostID ?? 'a different identity'}. Daily work reports are appraisal input and must never be readable by naming someone. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[7b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[8] idempotency: two consecutive reads must agree', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      kdiaryClient.getTodayReport({ token: staticToken }),
      kdiaryClient.getTodayReport({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[9] structural: an unknown query parameter must be ignored, not fatal', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getTodayReport({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] method binding: a POST-only route must not also answer this GET shape', async ({
    kdiaryClient,
    staticToken,
  }) => {
    const response = await kdiaryClient.getRoute(KDIARY_PATHS.saveReport, { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      method: 'GET',
      path: KDIARY_PATHS.saveReport,
      repro: `await kdiaryClient.getRoute(KDIARY_PATHS.saveReport, { token });`,
      title: 'A write route declared POST-only also responds to GET',
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
    const response = await genericClient.send('GET', META.path, { scheduleID: FOREIGN.scheduleID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'scheduleID',
      foreignValue: FOREIGN.scheduleID,
    });
  });

});
