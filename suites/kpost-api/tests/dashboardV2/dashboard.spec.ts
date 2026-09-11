import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { DASHBOARD_V2_PATHS } from '../../src/api/clients/dashboardV2.client';
import {
  homeDashboardResponseSchema,
  kallDashboardResponseSchema,
  katchupDashboardResponseSchema,
  kmailDashboardResponseSchema,
} from '../../src/api/schemas/dashboardV2.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertStatusCodeParity,
  comparableBody,
  assertUnauthorized,
  expectValidContract,
  readBody,
  assertStatus,
} from '../../src/utils/apiAssertions';
import {
  buildHomeDashboardPayload,
  buildKallDashboardPayload,
  buildKatchupDashboardPayload,
  buildKmailDashboardPayload,
} from '../../src/api/payloads/dashboardV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Dashboard V2 — every route aggregates a user's messages, calls or mail, scoped to the
 * authenticated token. Per the Excel these are pagination lookups keyed by `serverTime` /
 * message ids / `kmailID` — they carry NO participant identity in the body. So each endpoint's
 * IDOR case smuggles an identity field and asserts it is ignored (the feed is derived from the
 * token, never the payload), checked on reflection since the caller's own feed may hold rows.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/dashboard/katchupDashboardMsg
 * ====================================================================================== */
test.describe('POST /v2/dashboard/katchupDashboardMsg', () => {
  const META = {
    method: 'POST',
    path: DASHBOARD_V2_PATHS.katchupDashboardMsg,
    repro: `await dashboardV2Client.katchupDashboardMsg(buildKatchupDashboardPayload(), { token });`,
  };

  test('[1] happy path: a valid request satisfies the Zod envelope contract', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupDashboardResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[2] boundary: an int32-overflow message id must be rejected, not crash the handler', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({
      firstMsgID: INT32_OVERFLOW,
      lastMsgID: INT32_OVERFLOW,
    });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `firstMsgID=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. An out-of-range identifier must be refused as a client error, never surface as a server fault.`,
    ).toBeLessThan(500);
  });

  test('[2b] type: a non-numeric serverTime cursor is handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: MAX_LENGTH_STRING });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `an oversized non-numeric serverTime cursor produced HTTP ${response.status()}. A pagination cursor must be validated, not passed to the database driver.`,
    ).toBeLessThan(500);
  });

  test('[3] a missing serverTime cursor returns the latest page (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload();
    delete (payload as Record<string, unknown>).serverTime;

    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4] a null serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: null });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4b] a blank serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: '' });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[5] type mismatch: a string message id must be rejected as HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ firstMsgID: 'not-a-number' });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `firstMsgID was sent as a string and produced HTTP ${response.status()}. A type mismatch must be caught by deserialisation and answered as a client error.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where a serverTime string is expected must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: ['someone'] });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `serverTime was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "serverTime" must not be reflected unescaped', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: XSS_PAYLOAD });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await dashboardV2Client.katchupDashboardMsg(buildKatchupDashboardPayload({ serverTime: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD,
    );
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: SQLI_PAYLOAD });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        body: payload,
        repro: `await dashboardV2Client.katchupDashboardMsg(buildKatchupDashboardPayload({ serverTime: ${JSON.stringify(SQLI_PAYLOAD)} }), { token });`,
      },
      SQLI_PAYLOAD,
    );
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload({ serverTime: SQLI_DROP_PAYLOAD });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await dashboardV2Client.katchupDashboardMsg(payload, { token: null });`,
    });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ dashboardV2Client }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none forged token must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: a smuggled participant identity must be ignored, not honoured', async ({
    dashboardV2Client,
    staticToken,
    authSession,
  }) => {
    /*
     * The feed is resolved from the token; the Excel body carries no participant field, so
     * smuggling one must be inert.
     *
     * Asserted COMPARATIVELY — does the smuggled id change the feed? — not on whether the id
     * appears in the body. The victim is a QA account the shared user genuinely exchanges
     * messages with throughout this suite, so its identifier is legitimately all over the feed.
     * The substring form reported a Critical leak against a feed that was **byte-identical** with
     * and without the smuggled id (21,091 bytes both ways, verified 2026-09-10).
     *
     * Server-stamped cursors differ between any two calls, so they are stripped before comparing;
     * see `comparableBody`.
     */
    const own = await readBody(
      await dashboardV2Client.katchupDashboardMsg(buildKatchupDashboardPayload(), {
        token: staticToken,
      }),
    );
    // Positive control: two empty feeds are equal no matter what the server honoured.
    test.skip(comparableBody(own.text).length < 64, 'the caller has no feed to compare against');

    const payload = buildKatchupDashboardPayload({ kpostUser: VICTIM_KPOST_ID });
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      comparableBody(text),
      `the smuggled participant ("${VICTIM_KPOST_ID}") changed the katchup feed returned to ${authSession.kpostID ?? 'an unrelated identity'} — the feed must be scoped to the token, never a caller-supplied id. Body: ${text.slice(0, 200)}`,
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const response = await dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body returns the latest feed (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.katchupDashboardMsg({}, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: {},
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.sendRaw(
      DASHBOARD_V2_PATHS.katchupDashboardMsg,
      '{invalid json',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}. A parse failure is a client error and must surface as 400, never as a 5xx.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical reads must agree', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKatchupDashboardPayload();
    const [first, second, third] = await Promise.all([
      dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken }),
      dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken }),
      dashboardV2Client.katchupDashboardMsg(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}). A read-only feed must be deterministic under concurrency.`,
    ).toBe(1);
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
 * POST /v2/dashboard/kallDashboard
 * ====================================================================================== */
test.describe('POST /v2/dashboard/kallDashboard', () => {
  const META = {
    method: 'POST',
    path: DASHBOARD_V2_PATHS.kallDashboard,
    repro: `await dashboardV2Client.kallDashboard(buildKallDashboardPayload(), { token });`,
  };

  test('[1] happy path: a valid request satisfies the Zod envelope contract', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallDashboardResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[2] boundary: a far-future selected date must be handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: '2999-12-31' });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `a call history request for the year 2999 produced HTTP ${response.status()}. An out-of-range date must return an empty result or a client error, not a server fault.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 5000-character participant name is handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ serverTime: MAX_LENGTH_STRING });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `an oversized serverTime produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] a missing serverTime cursor returns the latest page (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    delete (payload as Record<string, unknown>).serverTime;

    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4] a null serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ serverTime: null });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4b] empty fuzzing: an empty object where a date is expected must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: {} });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `selectedDate was sent as an empty object and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string repeatType must be rejected as HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ repeatType: 'weekly' });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `repeatType is an integer in the contract but was sent as a string, producing HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a scalar where an id list is expected must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ idsList: 'not-an-array' });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `idsList is an array in the contract but was sent as a string, producing HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "serverTime" must not be reflected unescaped', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ serverTime: XSS_PAYLOAD });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ serverTime: SQLI_PAYLOAD });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: an injected date field must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: SQLI_DROP_PAYLOAD });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await dashboardV2Client.kallDashboard(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ dashboardV2Client }) => {
    const payload = buildKallDashboardPayload();
    const response = await dashboardV2Client.kallDashboard(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a smuggled participant identity must be ignored, not honoured', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // Call history is token-scoped; the Excel body carries no participant field. A smuggled one
    // must be inert — asserted on reflection, since the caller's own history may hold rows.
    const payload = buildKallDashboardPayload({ kpostUser: VICTIM_KPOST_ID });
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the call history echoed a smuggled participant ("${VICTIM_KPOST_ID}") — this sensitive metadata must be scoped to the authenticated identity, never a caller-supplied id. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await dashboardV2Client.kallDashboard(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body returns the latest feed (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.kallDashboard({}, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: {},
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.sendRaw(DASHBOARD_V2_PATHS.kallDashboard, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical reads must agree', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const [first, second, third] = await Promise.all([
      dashboardV2Client.kallDashboard(payload, { token: staticToken }),
      dashboardV2Client.kallDashboard(payload, { token: staticToken }),
      dashboardV2Client.kallDashboard(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`,
    ).toBe(1);
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
 * POST /v2/dashboard/homeDashboardMsgs
 * ====================================================================================== */
test.describe('POST /v2/dashboard/homeDashboardMsgs', () => {
  const META = {
    method: 'POST',
    path: DASHBOARD_V2_PATHS.homeDashboardMsgs,
    repro: `await dashboardV2Client.homeDashboardMsgs(buildHomeDashboardPayload(), { token });`,
  };

  test('[1] happy path: a valid request satisfies the Zod envelope contract', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await expectValidContract(
      response,
      homeDashboardResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[2] boundary: a negative paging window must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ firstMsgID: -1, lastMsgID: -100 });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    expect(
      response.status(),
      `a negative paging window produced HTTP ${response.status()}. Negative offsets must be refused rather than passed to the query layer.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 serverTime is handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: UTF8_STRING });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 serverTime produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] a missing serverTime cursor returns the latest page (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    delete (payload as Record<string, unknown>).serverTime;

    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4] a null serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: null });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4b] empty fuzzing: an empty array where a serverTime string is expected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: [] });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    expect(
      response.status(),
      `serverTime was sent as an empty array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string message id must be rejected as HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ firstMsgID: 'zero' });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    expect(
      response.status(),
      `firstMsgID was sent as a string and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric serverTime must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: 42 });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    expect(
      response.status(),
      `serverTime was sent as a number and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "serverTime" must not be reflected unescaped', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: XSS_PAYLOAD });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: SQLI_PAYLOAD });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ dashboardV2Client }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a smuggled participant identity must be ignored, not honoured', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // The home dashboard is token-scoped; a smuggled body identity must be inert — asserted on
    // reflection, since the caller's own dashboard may legitimately hold rows.
    const payload = buildHomeDashboardPayload({ kpostUser: VICTIM_KPOST_ID });
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the home dashboard echoed a smuggled participant ("${VICTIM_KPOST_ID}") — it must be derived from the token identity, never a caller-supplied id. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body returns the latest feed (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.homeDashboardMsgs({}, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: {},
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.sendRaw(
      DASHBOARD_V2_PATHS.homeDashboardMsgs,
      'not json at all',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical reads must agree', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const [first, second, third] = await Promise.all([
      dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken }),
      dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken }),
      dashboardV2Client.homeDashboardMsgs(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`,
    ).toBe(1);
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
 * POST /v2/dashboard/homeDashboardNewMsgs
 * ====================================================================================== */
test.describe('POST /v2/dashboard/homeDashboardNewMsgs', () => {
  const META = {
    method: 'POST',
    path: DASHBOARD_V2_PATHS.homeDashboardNewMsgs,
    repro: `await dashboardV2Client.homeDashboardNewMsgs(buildHomeDashboardPayload(), { token });`,
  };

  test('[1] happy path: a valid request satisfies the Zod envelope contract', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, { token: staticToken });

    await expectValidContract(
      response,
      homeDashboardResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[2] boundary: an int32-overflow unread window must be handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ lastMsgID: INT32_OVERFLOW });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `lastMsgID=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 5000-character serverTime is handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: MAX_LENGTH_STRING });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `an oversized serverTime produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] a missing serverTime cursor returns the latest page (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    delete (payload as Record<string, unknown>).serverTime;

    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4] a null serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: null });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[4b] a blank serverTime cursor must not fault', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: '' });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[5] type mismatch: a string message id must be rejected as HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ lastMsgID: 'many' });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `lastMsgID was sent as a string and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric deviceID must be rejected', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ deviceID: 12345 });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `deviceID was sent as a number and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "serverTime" must not be reflected unescaped', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: XSS_PAYLOAD });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload({ serverTime: SQLI_PAYLOAD });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a smuggled participant identity must be ignored, not honoured', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // Unread state is token-scoped; a smuggled body identity must be inert — asserted on
    // reflection, since the caller's own unread state may legitimately hold rows.
    const payload = buildHomeDashboardPayload({ kpostUser: VICTIM_KPOST_ID });
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the unread feed echoed a smuggled participant ("${VICTIM_KPOST_ID}") — unread state must be scoped to the authenticated identity. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const response = await dashboardV2Client.homeDashboardNewMsgs(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body returns the latest feed (must not fault)', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.homeDashboardNewMsgs({}, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 422], {
      ...META,
      body: {},
      title: 'a missing or blank serverTime cursor must return the latest page, not fault',
    });
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.sendRaw(
      DASHBOARD_V2_PATHS.homeDashboardNewMsgs,
      '[1,2,',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical reads must agree', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildHomeDashboardPayload();
    const [first, second, third] = await Promise.all([
      dashboardV2Client.homeDashboardNewMsgs(payload, { token: staticToken }),
      dashboardV2Client.homeDashboardNewMsgs(payload, { token: staticToken }),
      dashboardV2Client.homeDashboardNewMsgs(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`,
    ).toBe(1);
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
 * POST /v2/dashboard/getKmailDashboardMsg
 * ====================================================================================== */
test.describe('POST /v2/dashboard/getKmailDashboardMsg', () => {
  const META = {
    method: 'POST',
    path: DASHBOARD_V2_PATHS.getKmailDashboardMsg,
    repro: `await dashboardV2Client.getKmailDashboardMsg(buildKmailDashboardPayload(), { token });`,
  };

  test('[1] happy path: a valid request satisfies the Zod envelope contract', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload();
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await expectValidContract(
      response,
      kmailDashboardResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[2] type: a numeric kmailID must be refused', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // Excel getKmailDashboardMsg body is `{ kmailID }` (a string cursor); a number is a type
    // error the deserialiser must catch rather than pass to the lookup.
    const payload = buildKmailDashboardPayload({ kmailID: -1 });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `kmailID sent as a number produced HTTP ${response.status()}. A type mismatch must be answered as a client error, never a server fault.`,
    ).toBeLessThan(500);
  });

  test('[2b] type: an object where a kmailID string is expected is handled cleanly', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ kmailID: { bad: true } });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `kmailID sent as an object produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] structural: an empty body must not fault the handler', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // kmailID is an optional cursor (its builder default is an empty string), so a body without
    // it must be handled gracefully, not faulted.
    const response = await dashboardV2Client.getKmailDashboardMsg({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}. A kmailID-less request must be handled, not fault the handler.`,
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null kmailID must not fault the handler', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ kmailID: null });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `kmailID set to null produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a scalar where kmailIDs expects an array', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ kmailIDs: 'not-an-array' });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `kmailIDs is an array in the contract but was sent as a string, producing HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a string where groupFlag expects a boolean', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ groupFlag: 'yes' });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `groupFlag is a boolean in the contract but was sent as a string, producing HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "kpostUser" must not be reflected unescaped', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ kmailID: XSS_PAYLOAD });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ kmailID: SQLI_PAYLOAD });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: an injected contact filter must not leak database internals', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ selectedContact: SQLI_DROP_PAYLOAD });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    dashboardV2Client,
  }) => {
    const payload = buildKmailDashboardPayload();
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ dashboardV2Client }) => {
    const payload = buildKmailDashboardPayload();
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a smuggled kpostUser must be ignored, not honoured', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    // The mailbox is token-scoped; the Excel body carries no identity field. A smuggled kpostUser
    // must be inert — asserted on reflection, since the caller's own mailbox may hold rows.
    const payload = buildKmailDashboardPayload({ kpostUser: VICTIM_KPOST_ID });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the mailbox feed echoed a smuggled kpostUser ("${VICTIM_KPOST_ID}") — a mailbox is among the most sensitive resources on the platform and must be resolved from the token, never the body. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload();
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload();
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an unknown field must be ignored, not fatal', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload({ unexpectedField: 'value' });
    const response = await dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `an unrecognised field produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const response = await dashboardV2Client.sendRaw(
      DASHBOARD_V2_PATHS.getKmailDashboardMsg,
      '{invalid json',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical reads must agree', async ({
    dashboardV2Client,
    staticToken,
  }) => {
    const payload = buildKmailDashboardPayload();
    const [first, second, third] = await Promise.all([
      dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken }),
      dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken }),
      dashboardV2Client.getKmailDashboardMsg(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`,
    ).toBe(1);
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
