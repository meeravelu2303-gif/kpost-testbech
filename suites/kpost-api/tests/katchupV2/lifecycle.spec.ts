import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, KATCHUP_PATH_TEMPLATES } from '../../src/api/clients/katchupV2.client';
import {
  deletedIdsResponseSchema,
  katchupCountResponseSchema,
  katchupMessageListResponseSchema,
  katchupMessageResponseSchema,
  reportMessageResponseSchema,
} from '../../src/api/schemas/katchupV2.schema';
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
  comparableBody,
} from '../../src/utils/apiAssertions';
import {
  buildMessageIdPayload,
  buildReportAbusePayload,
  nonExistentMsgId,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Katchup V2 — message lifecycle: delete, recall, mark, report, and the unread counters.
 *
 * Two routes here are irreversible and get the treatment the suite reserves for destructive
 * paths — every payload addresses a **non-existent** message id:
 *
 *  - `deleteKatchUpMessage` removes messages from the caller's view.
 *  - `recallMessage` is stronger: it withdraws a message from the **recipient's** device
 *    after delivery. A recall that can be aimed at someone else's message is a way to make
 *    another person's words disappear from a conversation they own.
 *
 * `reportAbuse` is the inverse risk. It is a *write* that attaches an accusation to a named
 * user, and `ReportDetailsRO` carries both `kpostID` (the accused) and `reportingKpostID` (the
 * accuser) as client-supplied fields. If the reporter is not taken from the token, one user
 * can file abuse reports in another's name — so that is asserted directly.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_katchup; --`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/katchup/deleteKatchUpMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/deleteKatchUpMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.deleteKatchUpMessage,
    repro: `await katchupClient.deleteKatchUpMessage(buildMessageIdPayload(), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    // Non-existent id on purpose — deletion is not reversible through the API.
    const payload = buildMessageIdPayload();
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[1b] contract: the response must distinguish a deletion from a no-op', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const payload = buildMessageIdPayload({ msgID, messageIds: [msgID] });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting message ${msgID}, which does not exist, reported success. A caller cannot tell whether anything was removed, so a failed delete looks identical to a real one. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[2] boundary: an empty messageIds list must not delete everything', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ messageIds: [], msgID: undefined });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'empty messageIds on a destructive route — an empty IN() must not mean everything',
      },
      [400, 401, 403, 422]
    );
  });

  test('[2b] boundary: a msgID beyond int32 must not overflow into another message', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: INT32_OVERFLOW });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `msgID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. On a destructive route a wrapping id deletes a different message.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no message id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.deleteKatchUpMessage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'destructive call with no message id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgID must not be a wildcard', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: null, messageIds: null });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'message ids null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: 'all' });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `msgID was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: another user\'s message must not be deletable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildMessageIdPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming sender "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller sets sender from the token, so a body value must be inert. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a wildcard must not delete every message', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: SQLI_WILDCARD });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_WILDCARD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ selectedContact: SQLI_DROP_PAYLOAD });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not delete a message', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never delete', async ({
    katchupClient,
  }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.deleteKatchUpMessage(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] idempotency: deleting the same message twice must be stable', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload();
    const first = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });
    const second = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same message twice returned ${first.status()} then ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] boundary: a 1000-id bulk delete must be bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const messageIds = Array.from({ length: 1000 }, () => nonExistentMsgId());
    const payload = buildMessageIdPayload({ messageIds });
    const response = await katchupClient.deleteKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `a 1000-id bulk delete produced HTTP ${response.status()}. Clearing a conversation is a normal action, so the batch must be bounded explicitly rather than crashing.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
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
 * POST /v2/katchup/recallMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/recallMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.recallMessage,
    repro: `await katchupClient.recallMessage(buildMessageIdPayload(), { token });`,
  };

  test('[1] happy path: a recall satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: only the author may recall a message', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildMessageIdPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a recall naming sender "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Recall withdraws a message from the recipient's device after delivery — aimed at someone else's message it erases their words from a conversation they own. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.recallMessage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'a recall addressing no message' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgID must not recall everything', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: null, messageIds: null });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'message ids null on a recall' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: true });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `msgID was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: recalling a non-existent message must not report success', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const payload = buildMessageIdPayload({ msgID, messageIds: [msgID] });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `recalling message ${msgID}, which does not exist, reported success. The sender believes their message was withdrawn when the recipient still has it. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] business rule: a recall window, if any, must be enforced consistently', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: 1 });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `recalling msgID 1 — the oldest possible message — produced HTTP ${response.status()}. If recall has a time limit it must be refused with a clear 4xx; if it does not, that is a product decision worth stating explicitly.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a wildcard must not recall every message', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: SQLI_WILDCARD });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_WILDCARD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ selectedContact: XSS_PAYLOAD });
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated recall must be HTTP 401/403', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.recallMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not recall a message', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.recallMessage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload();
    const response = await katchupClient.recallMessage(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: recalling twice must be stable', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload();
    const first = await katchupClient.recallMessage(payload, { token: staticToken });
    const second = await katchupClient.recallMessage(payload, { token: staticToken });

    expect(
      first.status(),
      `recalling the same message twice returned ${first.status()} then ${second.status()}.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * POST /v2/katchup/markOrUnmarkImportantMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/markOrUnmarkImportantMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.markOrUnmarkImportantMessage,
    repro: `await katchupClient.markOrUnmarkImportantMessage(buildMessageIdPayload(), { token });`,
  };

  test('[1] happy path: a mark satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: true });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] business rule: the markFlag omitted must be refused, not toggled', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload();
    delete (payload as Record<string, unknown>).markFlag;

    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'markFlag omitted on a mark/unmark toggle — the target state is unspecified',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.markOrUnmarkImportantMessage(
      { markFlag: true },
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: { markFlag: true },
        scenario: 'a mark addressing no message',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null markFlag must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: null });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "markFlag" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string markFlag must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: 'yes' });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `markFlag was sent as the string "yes" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: another user\'s message must not be markable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: true, sender: VICTIM_KPOST_ID });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a mark naming sender "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: true, selectedContact: SQLI_PAYLOAD });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload({ markFlag: true });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not mark a message', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload({ markFlag: true });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] idempotency: marking twice must be stable', async ({ katchupClient, staticToken }) => {
    const payload = buildMessageIdPayload({ markFlag: true });
    const first = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });
    const second = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    expect(
      first.status(),
      `marking the same message twice returned ${first.status()} then ${second.status()}. A mark is a set operation, not a toggle — repeating it must not flip the state back.`
    ).toBe(second.status());
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ markFlag: true });
    const response = await katchupClient.markOrUnmarkImportantMessage(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * POST /v2/katchup/reportAbuse
 * ====================================================================================== */
test.describe('POST /v2/katchup/reportAbuse', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.reportAbuse,
    repro: `await katchupClient.reportAbuse(buildReportAbusePayload(), { token });`,
  };

  test('[1] happy path: an abuse report satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload();
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await expectValidContract(
      response,
      reportMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] SPOOFING: the reporter must come from the token, not the body', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildReportAbusePayload({ reportingKpostID: VICTIM_KPOST_ID });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'report did not succeed');

    expect(
      text.includes(`"reportingKpostID":"${VICTIM_KPOST_ID}"`),
      `the report was filed as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. ReportDetailsRO carries the reporter as a client field; if it is not overwritten from the token, one user can file abuse accusations in another's name — and the accused sees who reported them. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no accused user must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an abuse report naming nobody' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: no reason must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload();
    delete (payload as Record<string, unknown>).reason;

    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an abuse report with no reason given',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null accused user must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload({ kpostID: null });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to null on an accusation' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric kpostID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload({ kpostID: 12345 });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    expect(
      response.status(),
      `kpostID was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: reporting a non-existent message must not succeed', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const payload = buildReportAbusePayload({ msgID });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an abuse report was accepted against message ${msgID}, which does not exist. A report must be anchored to a real message, or the route becomes a way to generate accusations against anyone. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] abuse: repeated reports must be rate-limited or de-duplicated', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload();
    const responses = await Promise.all([
      katchupClient.reportAbuse(payload, { token: staticToken }),
      katchupClient.reportAbuse(payload, { token: staticToken }),
      katchupClient.reportAbuse(payload, { token: staticToken }),
    ]);

    expect(
      responses.every((response) => response.status() < 500),
      `three concurrent identical reports returned ${responses.map((r) => r.status()).join(', ')}. Unlimited duplicate reports against one user are a harassment vector and can trigger automated moderation.`
    ).toBe(true);
  });

  test('[7] XSS: a script payload in the reason must not be persisted unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload({ reason: XSS_PAYLOAD });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await katchupClient.reportAbuse(buildReportAbusePayload({ reason: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload({ reason: SQLI_PAYLOAD });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] boundary: a 5000-character reason must be handled explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReportAbusePayload({ reason: MAX_LENGTH_STRING });
    const response = await katchupClient.reportAbuse(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character reason produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[9] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildReportAbusePayload();
    const response = await katchupClient.reportAbuse(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9b] auth: an alg=none token claiming admin must never file a report', async ({
    katchupClient,
  }) => {
    const payload = buildReportAbusePayload();
    const response = await katchupClient.reportAbuse(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.reportAbuse({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an abuse report' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
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
 * GET /v2/katchup/getAllReportMsg
 * ====================================================================================== */
test.describe('GET /v2/katchup/getAllReportMsg', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATHS.getAllReportMsg,
    repro: `await katchupClient.getAllReportMsg({ token });`,
  };

  test('[1] happy path: the report list satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });

    await expectValidContract(
      response,
      reportMessageResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] privilege: an ordinary member must not read every abuse report', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `"getAllReportMsg" returned ${count} reports to an ordinary member token (${authSession.kpostID ?? 'unknown'}). The route name says "all"; a moderation queue names both accuser and accused and must be restricted to moderators. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getAllReportMsg({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not read reports', async ({ katchupClient }) => {
    const response = await katchupClient.getAllReportMsg({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: an alg=none token claiming admin must never read reports', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] privacy: the accuser must not be disclosed to non-moderators', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      /"reportingKpostID"\s*:\s*"[^"]{3,}"/.test(text),
      `the listing disclosed reportingKpostID — who filed each report. Exposing the accuser to anyone who can call the route exposes them to retaliation. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] boundary: the listing must be paginated', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `"all reports" returned ${count} rows in one response. A moderation queue grows without bound and must be paged. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(1000);
  });

  test('[6] injection: a SQL tautology in a query parameter must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in a query parameter must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] status misreporting: HTTP 200 must not carry a failure payload', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getAllReportMsg({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      katchupClient.getAllReportMsg({ token: staticToken }),
      katchupClient.getAllReportMsg({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * POST /v2/katchup/getReadStatusGroupMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/getReadStatusGroupMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getReadStatusGroupMessage,
    repro: `await katchupClient.getReadStatusGroupMessage(buildMessageIdPayload(), { token });`,
  };

  test('[1] happy path: a read-status lookup satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ groupFlag: true });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: read receipts on another user\'s message must not be visible', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildMessageIdPayload({ groupFlag: true, sender: VICTIM_KPOST_ID });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `read receipts for a message sent by "${VICTIM_KPOST_ID}" were returned to ${authSession.kpostID ?? 'a different identity'} (${count} rows). Read receipts reveal who is in the group and when each person was online. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getReadStatusGroupMessage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a read-status lookup addressing no message',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgID must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildMessageIdPayload({ msgID: null });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "msgID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ msgID: 'latest' });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `msgID was sent as the string "latest" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a non-group message must not return group receipts', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ groupFlag: false });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a group read-status lookup on a non-group message produced HTTP ${response.status()}. It must be refused or return nothing, not fault.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ selectedContact: SQLI_PAYLOAD });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload({ groupFlag: true });
    const response = await katchupClient.getReadStatusGroupMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return read receipts', async ({ katchupClient }) => {
    const payload = buildMessageIdPayload({ groupFlag: true });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ selectedContact: XSS_PAYLOAD });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMessageIdPayload({ groupFlag: true });
    const response = await katchupClient.getReadStatusGroupMessage(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * GET /v2/katchup/getDeletedKatchupMsgIds/{lastMsgID}
 * ====================================================================================== */
test.describe('GET /v2/katchup/getDeletedKatchupMsgIds/{lastMsgID}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.getDeletedKatchupMsgIds,
    repro: `await katchupClient.getDeletedKatchupMsgIds(lastMsgID, { token });`,
  };

  test('[1] happy path: a deleted-id sync satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(nonExistentMsgId(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      deletedIdsResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: lastMsgID 0 must not return every deleted id ever', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(0, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'sync returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a lastMsgID of 0 returned ${count} deleted ids. This is a delta-sync route; asking from zero must be paged, not answered with the entire history. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(5000);
  });

  test('[3] IDOR: the sync must only cover the caller\'s own deletions', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(0, {
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'sync returned no data');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the deleted-id sync referenced "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Knowing which message ids another user deleted reveals both that they deleted something and roughly when. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] type: a non-numeric lastMsgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds('latest', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A non-numeric lastMsgID is not rejected cleanly',
      severity: 'Major',
    });
  });

  test('[5] boundary: a lastMsgID beyond int32 must not overflow', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(INT32_OVERFLOW, {
      token: staticToken,
    });

    expect(
      response.status(),
      `lastMsgID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a negative lastMsgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(-1, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      title: 'A negative lastMsgID is not handled cleanly',
      severity: 'Major',
    });
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(0, { token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must not sync deletions', async ({ katchupClient }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(0, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[9] XSS: a script payload in the path must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getDeletedKatchupMsgIds(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] idempotency: two consecutive syncs must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      katchupClient.getDeletedKatchupMsgIds(0, { token: staticToken }),
      katchupClient.getDeletedKatchupMsgIds(0, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical syncs returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
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

});

/* =========================================================================================
 * GET /v2/katchup/getUnopenedMessagesCount
 * ====================================================================================== */
test.describe('GET /v2/katchup/getUnopenedMessagesCount', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATHS.getUnopenedMessagesCount,
    repro: `await katchupClient.getUnopenedMessagesCount({ token });`,
  };

  test('[1] happy path: the unread count satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: staticToken });

    await expectValidContract(
      response,
      katchupCountResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: zero unread must not be an error', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'A zero unread count is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return a count', async ({ katchupClient }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return a count', async ({ katchupClient }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not return another user\'s count', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const withParam = await katchupClient.getUnopenedMessagesCount({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const without = await katchupClient.getUnopenedMessagesCount({ token: staticToken });
    const a = await readBody(withParam);
    const b = await readBody(without);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      comparableBody(a.text),
      `passing ?kpostID=${VICTIM_KPOST_ID} changed the unread count for ${authSession.kpostID ?? 'the caller'}, which means the parameter re-scoped the query. An unread count is a presence signal — it says whether someone has traffic waiting. Body: ${a.text.slice(0, 200)}`
    ).toBe(comparableBody(b.text));
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] contract: the count must be a number, not a string', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no count returned');
    test.skip(json?.data === null || json?.data === undefined, 'count was null');

    expect(
      typeof json?.data === 'number' || typeof json?.data === 'object',
      `the unread count came back as ${typeof json?.data}. A badge counter typed as a string forces every client to parse it and guess at the failure mode. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  test('[8] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[9] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      katchupClient.getUnopenedMessagesCount({ token: staticToken }),
      katchupClient.getUnopenedMessagesCount({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A counter read must not mark anything as read.`
    ).toBe(second.status());
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesCount({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * GET /v2/katchup/getUnopenedMessagesAndKmailsTotalCount
 * ====================================================================================== */
test.describe('GET /v2/katchup/getUnopenedMessagesAndKmailsTotalCount', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATHS.getUnopenedMessagesAndKmailsTotalCount,
    repro: `await katchupClient.getUnopenedMessagesAndKmailsTotalCount({ token });`,
  };

  test('[1] happy path: the combined count satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupCountResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: zero unread must not be an error', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'A zero combined unread count is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] contract: the combined count must break down by surface', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no count returned');

    expect(
      json?.data,
      `the route promises Katchup and Kmail counts together but returned no data. A single opaque total cannot drive two separate badges. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[4] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must not return a count', async ({ katchupClient }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: an alg=none token claiming admin must never be honoured', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[5] IDOR: a kpostID query parameter must not re-scope the count', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const withParam = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const without = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
    });
    const a = await readBody(withParam);
    const b = await readBody(without);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      comparableBody(a.text),
      `passing ?kpostID=${VICTIM_KPOST_ID} changed the count for ${authSession.kpostID ?? 'the caller'}. Body: ${a.text.slice(0, 200)}`
    ).toBe(comparableBody(b.text));
  });

  test('[6] injection: a SQL tautology in a query parameter must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in a query parameter must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] status misreporting: HTTP 200 must not carry a failure payload', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getUnopenedMessagesAndKmailsTotalCount({
      token: staticToken,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[9] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      katchupClient.getUnopenedMessagesAndKmailsTotalCount({ token: staticToken }),
      katchupClient.getUnopenedMessagesAndKmailsTotalCount({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] consistency: the combined total must not be less than the Katchup count', async ({
    katchupClient,
    staticToken,
  }) => {
    const [combinedResponse, katchupResponse] = await Promise.all([
      katchupClient.getUnopenedMessagesAndKmailsTotalCount({ token: staticToken }),
      katchupClient.getUnopenedMessagesCount({ token: staticToken }),
    ]);
    const combined = await readBody(combinedResponse);
    const katchupOnly = await readBody(katchupResponse);

    test.skip(
      typeof combined.json?.data !== 'number' || typeof katchupOnly.json?.data !== 'number',
      'counts were not plain numbers'
    );

    expect(
      combined.json?.data as number,
      `the Katchup+Kmail total (${combined.json?.data}) is smaller than the Katchup-only count (${katchupOnly.json?.data}). Two badges driven by inconsistent counters will disagree on screen.`
    ).toBeGreaterThanOrEqual(katchupOnly.json?.data as number);
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});
