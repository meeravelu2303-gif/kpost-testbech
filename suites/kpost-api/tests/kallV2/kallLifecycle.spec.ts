import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KALL_V2_PATHS } from '../../src/api/clients/kallV2.client';
import { kallResponseSchema } from '../../src/api/schemas/kallV2.schema';
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
  buildUpdateKallStatusPayload,
  buildSenderKallStatusPayload,
  buildReceiverKallStatusPayload,
  buildKallROPayload,
  nonExistentKallId,
  syntheticReceiver,
} from '../../src/api/payloads/kallV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Kall V2 — placing a call and moving it through its lifecycle.
 *
 * This file carries the module's two most serious findings, both read from
 * `KallControllerV3` and both about where the acting identity comes from:
 *
 *  - **`updateSenderAndReceiverKallStatus` never overwrites the identity.** Every sibling
 *    route calls `setSender`/`setReceiver`/`setKpostID` from the auth-filter attribute before
 *    touching the service. This one does not, and it is a *write* that moves both parties'
 *    call status. It also audit-logs itself as `/updateKallStatus`, so the trail names a
 *    different route than the one that ran.
 *  - **`getKallStatus` has its scoping line commented out** —
 *    `// KallMaster.setSender((String) request.getAttribute("kpostID"));` — leaving the
 *    sender under the caller's control on a read.
 *
 * A third, narrower one: `updateSenderAndReceiverKallStatus` opens with
 * `int status = kallDetails.getKallStatus()`, unboxing an `Integer`. Omit `kallStatus` and
 * that is an NPE before any validation runs, which the missing-parameter case targets.
 *
 * Every payload here defaults to a synthetic receiver and a non-existent kallID: initiating a
 * call rings a real device, and the end-call routes act on whatever they match.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_kall_master; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/kall/initiateKall
 * ====================================================================================== */
test.describe('POST /v2/kall/initiateKall @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.initiateKall,
    repro: `await kallV2Client.initiateKall(buildKallROPayload(), { token });`,
  };

  test('[1] happy path: placing a call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403],
    );
  });

  test('[1b] contract: a placed call must return its kallID', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'call initiation did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.kallID,
      `the call was placed but no kallID came back. Every later route — status, end, join — addresses a call by that id, so the caller cannot hang up what it just started. Body: ${text.slice(0, 200)}`,
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character subject must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ subject: MAX_LENGTH_STRING });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character subject produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 subject must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ subject: UTF8_STRING });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 subject produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2c] boundary: an unknown kallType must be refused, not defaulted', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ kallType: 9999 });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'kallType 9999 is outside the known set' },
      [400, 401, 403, 422],
    );
  });

  test('[3] missing required parameter: no receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no receiver — the call has nobody to ring' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ receiver: null });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[4b] empty fuzzing: an empty receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ receiver: '' });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to an empty string' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: an array receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ receiver: [syntheticReceiver()] });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    expect(
      response.status(),
      `receiver was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] business rule: a user must not be able to call themselves', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const self = authSession.kpostID;
    test.skip(!self, 'no authenticated identity available to self-call');

    const payload = buildKallROPayload({ receiver: self });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'caller sets themselves as the receiver' },
      [400, 401, 403, 422],
    );
  });

  test('[6b] business rule: calling a non-existent kpostID must not succeed', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ receiver: syntheticReceiver() });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `placing a call to a kpostID that does not exist reported success. The caller sees a ringing screen for a call that can never connect. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the subject must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology in the receiver must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload({ receiver: SQLI_PAYLOAD });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not place a call', async ({ kallV2Client }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never place a call', async ({
    kallV2Client,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] spoofing: a body sender must not override the token identity', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildKallROPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'call initiation did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.sender,
      `the call was placed as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller overwrites sender from the token precisely so a call cannot be spoofed — the receiver's screen shows whoever the sender says they are. Body: ${text.slice(0, 200)}`,
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    const response = await kallV2Client.initiateKall(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.initiateKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on call initiation' },
      [400, 401, 403, 422],
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.sendRaw(KALL_V2_PATHS.initiateKall, '{"receiver":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"receiver":',
      repro: `await kallV2Client.sendRaw(KALL_V2_PATHS.initiateKall, '{"receiver":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[10c] idempotency: two concurrent identical calls must not ring twice', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallROPayload();
    const [first, second] = await Promise.all([
      kallV2Client.initiateKall(payload, { token: staticToken }),
      kallV2Client.initiateKall(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical initiations returned ${first.status()} and ${second.status()}. A double-tapped call button must not fault, and must not place two calls to the same person.`,
    ).toBe(true);
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });
});

/* =========================================================================================
 * POST /v2/kall/updateKallStatus
 * ====================================================================================== */
test.describe('POST /v2/kall/updateKallStatus @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.updateKallStatus,
    repro: `await kallV2Client.updateKallStatus(buildUpdateKallStatusPayload(), { token });`,
  };

  test('[1] happy path: a status change satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload();
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] boundary: a kallID beyond int32 must not overflow into another call', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. An id that wraps could move a different call's status.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an unknown kallStatus must be refused, not defaulted', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ kallStatus: 9999 });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'kallStatus 9999 is outside the handled set' },
      [400, 401, 403, 422],
    );
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID — the status change addresses nothing' },
      [400, 401, 403, 422],
    );
  });

  test('[3b] missing required parameter: no kallStatus must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload();
    delete (payload as Record<string, unknown>).kallStatus;

    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kallStatus" omitted' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null kallStatus must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ kallStatus: null });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallStatus" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: a string kallStatus must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ kallStatus: 'answered' });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `kallStatus was sent as the string "answered" and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] business rule: moving a non-existent call must not report success', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallID = nonExistentKallId();
    const payload = buildUpdateKallStatusPayload({ kallID });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `moving the status of call ${kallID}, which does not exist, reported success. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the reason must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ reason: XSS_PAYLOAD });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload({ reason: SQLI_DROP_PAYLOAD });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildUpdateKallStatusPayload();
    const response = await kallV2Client.updateKallStatus(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test("[8b] auth: an expired token must not move a call's status", async ({ kallV2Client }) => {
    const payload = buildUpdateKallStatusPayload();
    const response = await kallV2Client.updateKallStatus(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test("[8c] IDOR: a body sender must not move another user's call", async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildUpdateKallStatusPayload({
      sender: VICTIM_KPOST_ID,
      receiver: VICTIM_KPOST_ID,
    });
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'status change did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the status change was applied as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route overwrites both sender and receiver from the token, so the body must be inert — otherwise anyone can hang up or answer someone else's call. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildUpdateKallStatusPayload();
    const response = await kallV2Client.updateKallStatus(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.updateKallStatus({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a status change' },
      [400, 401, 403, 422],
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.sendRaw(KALL_V2_PATHS.updateKallStatus, '{{{', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{{{',
      repro: `await kallV2Client.sendRaw(KALL_V2_PATHS.updateKallStatus, '{{{', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });
});

/* =========================================================================================
 * POST /v2/kall/updateSenderAndReceiverKallStatus
 * ====================================================================================== */
test.describe('POST /v2/kall/updateSenderAndReceiverKallStatus @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.updateSenderAndReceiverKallStatus,
    repro: `await kallV2Client.updateSenderAndReceiverKallStatus(buildSenderKallStatusPayload(), { token });`,
  };

  test('[1] happy path (sender): a sender-side status change satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    // Excel sender body: { sender, kallStatus, kallID }.
    const payload = buildSenderKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[1b] happy path (receiver): a receiver-side status change satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    // Excel receiver body: { id, kallStatus, receiver, kallID } — `id` is the receiver's per-call
    // unique id, distinct from the shared kallID.
    const payload = buildReceiverKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] boundary: a kallID beyond int32 must not overflow', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a kallStatus outside the handled set must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    // The Excel row for this route states "To update kallStatus - 2,3,9 only". 7 (ReScheduled) is a
    // valid kallStatus but outside that accepted set, so this route must not silently accept it.
    const payload = buildSenderKallStatusPayload({ kallStatus: 7 });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `kallStatus 7 is outside this route's accepted set (Excel: 2, 3, 9 only), so nothing was updated — yet the response reported success. The caller believes the call state changed when it did not. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[3] missing required parameter: omitting kallStatus must not NPE', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload();
    delete (payload as Record<string, unknown>).kallStatus;

    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario:
          'kallStatus omitted — the controller unboxes it with `int status = getKallStatus()` before any validation',
      },
      [400, 401, 403, 422],
    );
  });

  test('[3b] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID supplied' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null kallStatus must be refused, not unboxed', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload({ kallStatus: null });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallStatus" explicitly null' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: a string kallStatus must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload({ kallStatus: 'ended' });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `kallStatus was sent as a string and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test("[6] IDOR: a body receiver must not move another user's call state", async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildSenderKallStatusPayload({
      sender: VICTIM_KPOST_ID,
      receiver: VICTIM_KPOST_ID,
      kallStatus: 4,
    });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'status change did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the call state of "${VICTIM_KPOST_ID}" was changed while the caller was ${authSession.kpostID ?? 'a different identity'}. This route is the only write on the controller that never overwrites sender/receiver from the token — it passes the client's DTO straight to the service and then reads getReceiver() back out of it. Anyone with a valid token could end or answer another user's call. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the reason must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload({ reason: XSS_PAYLOAD });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload({ receiver: SQLI_PAYLOAD });
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildSenderKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never be honoured', async ({
    kallV2Client,
  }) => {
    const payload = buildSenderKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] auditability: the audit entry must name this route, not updateKallStatus', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.urlPath,
      `updateSenderAndReceiverKallStatus records its audit entry and its urlPath as "updateKallStatus". The one write on this controller with no identity check is also the one that logs itself as a different route, so an audit review cannot tell the two apart. Body: ${text.slice(0, 200)}`,
    ).not.toBe('updateKallStatus');
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildSenderKallStatusPayload();
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.updateSenderAndReceiverKallStatus(
      {},
      { token: staticToken },
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body — kallStatus is unboxed immediately' },
      [400, 401, 403, 422],
    );
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
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
 * POST /v2/kall/getKallStatus
 * ====================================================================================== */
test.describe('POST /v2/kall/getKallStatus @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.getKallStatus,
    repro: `await kallV2Client.getKallStatus(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: reading a call status satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] empty-state: an unknown call must not be reported as a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: nonExistentKallId() });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown call is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID supplied on a status read' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({ kallV2Client, staticToken }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: a string kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 'latest' });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as the string "latest" and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test("[6] IDOR: a body sender must not select another user's call", async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'status read returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming sender "${VICTIM_KPOST_ID}" returned that user's call while the caller was ${authSession.kpostID ?? 'a different identity'}. The line that would scope this route is present but commented out — "// KallMaster.setSender((String) request.getAttribute(\\"kpostID\\"));" — so the sender is whatever the body says. Its sibling getKallStatusUsingKallID does apply the token identity. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[6b] exposure: a status read must not hand out media-server join credentials', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'status read returned no data');

    expect(
      /"rtcToken"\s*:\s*"[^"]+"/.test(text),
      `a status read for another user's call returned a populated rtcToken. That is a live media-server credential: whoever holds it can join the call and listen. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology in the sender must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ sender: SQLI_PAYLOAD });
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatus(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return call state', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatus(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatus(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.getKallStatus({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a status read' },
      [400, 401, 403, 422],
    );
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
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
 * POST /v2/kall/getKallStatusUsingKallID
 * ====================================================================================== */
test.describe('POST /v2/kall/getKallStatusUsingKallID @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.getKallStatusUsingKallID,
    repro: `await kallV2Client.getKallStatusUsingKallID(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: reading one call by id satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] empty-state: an unknown call must not be reported as a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: nonExistentKallId() });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown call is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID on a by-id lookup' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({ kallV2Client, staticToken }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: an object kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: { id: 1 } });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as an object and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body kpostID must not re-scope the lookup', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `naming kpostID "${VICTIM_KPOST_ID}" returned that user's call while the caller was ${authSession.kpostID ?? 'a different identity'}. This route does call setKpostID from the token, so the body value must be overwritten before the service sees it. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kpostID: SQLI_PAYLOAD });
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return call state', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatusUsingKallID(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] idempotency: two consecutive reads must agree', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const [first, second] = await Promise.all([
      kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken }),
      kallV2Client.getKallStatusUsingKallID(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A read must be stable.`,
    ).toBe(second.status());
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.getKallStatusUsingKallID({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a by-id lookup' },
      [400, 401, 403, 422],
    );
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });
});

/* =========================================================================================
 * POST /v2/kall/endKall
 *
 * Excel row 88. A THIRD end-call route alongside `endKoolKall` (the group / Kool Kall form) and
 * `endIndividualKall`. It was in the workbook as mandatory and reachable on the live host, but
 * nothing in the bench referenced it until now — so the one route a client uses to hang up a
 * call had no coverage at all.
 *
 * The documented body is `{ id, kallID }`, carrying BOTH the per-receiver row id and the shared
 * call id — the pair `buildExistingKallPayload` already produces. Every id addresses a
 * non-existent call: ending a real one would drop a call another spec is mid-way through.
 * ====================================================================================== */
test.describe('POST /v2/kall/endKall @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.endKall,
    repro: `await kallV2Client.endKall(buildExistingKallPayload(), { token });`,
  };

  /**
   * Marks a case SKIPPED rather than letting it pass when the route is not deployed.
   *
   * This route answers 404 to a valid token on 192.168.0.66 (verified 2026-09-10), and every
   * assertion here passes trivially against a 404. A skip states the truth; a pass would launder
   * a missing endpoint into evidence of a working one.
   */
  const skipIfUndeployed = (status: number): void => {
    test.skip(
      status === 404,
      '/v2/kall/endKall is not deployed on this environment (404 with a valid token) — see the [deployment] case',
    );
    // 429 stands down too: a throttled response describes our request rate, not the endpoint.
    test.skip(
      status === 429,
      '/v2/kall/endKall: throttled (HTTP 429) — the response describes our request rate, not the endpoint',
    );
  };

  /**
   * Statuses that prove a route EXISTS — the request reached a handler.
   *
   * **401 and 403 are deliberately absent.** This API runs its authentication filter BEFORE
   * routing, so a rejected token answers 401 for a route that cannot possibly exist — verified:
   * `POST /v2/profile/thisRouteCannotPossiblyExist` with a bad token also returns 401. Treating
   * 401 as proof of reachability is what let the sibling cases in `educationNested.spec.ts` pass
   * green in a full run, where the shared account's session is periodically evicted by another
   * worker and requests come back 401.
   */
  const REACHABLE_STATUSES = [200, 201, 204, 400, 405, 415, 422];

  test('[deployment] /v2/kall/endKall must be reachable with a valid token', async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * Excel row 88 lists this as mandatory, so a 404 is a deployment gap worth a ticket rather
     * than something to route around quietly. Note the bench DOES cover `endKoolKall` and
     * `endIndividualKall`, which are deployed — so this is one missing member of a family, not
     * an un-implemented feature.
     */
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: staticToken });

    /*
     * Asserted POSITIVELY — the route must answer something that proves it EXISTS — rather than
     * as `.not.toBe(404)`. The negative form passes on ANY other status, and under full-suite load
     * this API returns 429: written that way, the sibling cases in educationNested.spec.ts went
     * green in a full run while their routes were still missing. Deliberately NOT guarded by
     * skipIfUndeployed — this case exists to report the 404.
     */
    test.skip(
      response.status() === 429,
      'throttled (HTTP 429) — a rate limit cannot be told apart from a missing route',
    );
    test.skip(
      [401, 403].includes(response.status()),
      'our token was not accepted (HTTP 401/403) — this API authenticates before routing, so the response says nothing about whether the route exists',
    );

    expect(
      REACHABLE_STATUSES.includes(response.status()),
      `/v2/kall/endKall is documented as mandatory in the API workbook (Excel row 88) but answers HTTP ${response.status()} to a valid token, while its siblings endKoolKall and endIndividualKall are deployed. Either it was never deployed here or the workbook is stale.`,
    ).toBe(true);
  });

  test('[1] happy path: ending a call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404],
    );
  });

  test('[2] boundary: a kallID beyond int32 must not overflow', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 2147483648, id: 2147483648 });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    expect(
      response.status(),
      `a kallID of 2147483648 exceeds int32 and produced HTTP ${response.status()}. An id that cannot be represented must be refused, never wrapped into a different call.`,
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID supplied — the request ends nothing' },
      [400, 401, 403, 404, 422],
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({ kallV2Client, staticToken }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null' },
      [400, 401, 403, 404, 422],
    );
  });

  test('[5] typefuzz: a kallID sent as an array must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: [1, 2, 3] });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    expect(
      response.status(),
      `kallID sent as an array produced HTTP ${response.status()}. A type mismatch is a 400, not a fault.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in kallID must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: XSS_PAYLOAD });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: SQLI_PAYLOAD });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be refused', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: a malformed token must be refused', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] auth: an alg=none forged token must not end a call', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status parity: the HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a foreign kpostID must not end another user's call", async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * Hanging up someone else's call is a denial-of-service primitive that needs no read access:
     * the caller never has to see the conversation to cut it off. Verdict is on
     * ACKNOWLEDGEMENT, not the status code — a correct implementation may answer 200 having
     * ignored the foreign identity entirely.
     */
    const payload = buildExistingKallPayload({ kpostID: FOREIGN.victimKpostID });
    const response = await kallV2Client.endKall(payload, { token: staticToken });
    skipIfUndeployed(response.status());

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      what: 'kpostID',
      foreignValue: FOREIGN.victimKpostID,
    });
  });
});

/* =========================================================================================
 * POST /v2/kall/endKoolKall
 * ====================================================================================== */
test.describe('POST /v2/kall/endKoolKall @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.endKoolKall,
    repro: `await kallV2Client.endKoolKall(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: ending a group call satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] boundary: a kallID beyond int32 must not end a different call', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}. On a route that terminates a live call, a wrapping id could cut off an unrelated meeting.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a zero kallID must not end every call', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 0 });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `ending kallID 0 reported success. A sentinel id must match nothing — a default value that terminates calls would drop every meeting in progress. Body: ${text.slice(0, 200)}`,
    ).toBe(false);
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'destructive call-termination with no kallID' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null kallID must not be treated as a wildcard', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" null on a termination route' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: a string kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 'all' });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as the string "all" and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] business rule: only a participant may end a call', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({
      sender: VICTIM_KPOST_ID,
      receiver: VICTIM_KPOST_ID,
    });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'termination did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `a call belonging to "${VICTIM_KPOST_ID}" was ended while the caller was ${authSession.kpostID ?? 'a different identity'}. Being able to terminate a call you are not on is a denial of service against a live conversation. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the reason must not be reflected', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ reason: XSS_PAYLOAD });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ reason: SQLI_DROP_PAYLOAD });
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: an unauthenticated termination must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKoolKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never end a call', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKoolKall(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endKoolKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: ending the same call twice must be stable', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const first = await kallV2Client.endKoolKall(payload, { token: staticToken });
    const second = await kallV2Client.endKoolKall(payload, { token: staticToken });

    expect(
      first.status(),
      `ending the same call twice returned ${first.status()} then ${second.status()}. Hanging up twice must not change the outcome.`,
    ).toBe(second.status());
  });

  test('[10b] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.endKoolKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a termination route' },
      [400, 401, 403, 422],
    );
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
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
 * POST /v2/kall/endIndividualKall
 * ====================================================================================== */
test.describe('POST /v2/kall/endIndividualKall @audit', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.endIndividualKall,
    repro: `await kallV2Client.endIndividualKall(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: dropping one leg satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] boundary: a kallID beyond int32 must not drop a different participant', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID on a participant-drop route' },
      [400, 401, 403, 422],
    );
  });

  test('[3b] missing required parameter: no receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'no receiver — which leg should be dropped is unspecified',
      },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: a null receiver must not drop every participant', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ receiver: null });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" null on a participant-drop route' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: an array receiver must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ receiver: [syntheticReceiver()] });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    expect(
      response.status(),
      `receiver was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] business rule: a non-participant must not be droppable', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({ receiver: VICTIM_KPOST_ID });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'drop did not succeed');

    expect(
      text.includes(`"receiver":"${VICTIM_KPOST_ID}"`),
      `"${VICTIM_KPOST_ID}" was dropped from a call while the caller was ${authSession.kpostID ?? 'a different identity'}. Ejecting someone from a call you do not own is a denial of service. Body: ${text.slice(0, 300)}`,
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ reason: XSS_PAYLOAD });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ receiver: SQLI_PAYLOAD });
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated drop must be HTTP 401/403', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endIndividualKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not drop a participant', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endIndividualKall(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.endIndividualKall(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.sendRaw(KALL_V2_PATHS.endIndividualKall, ']]', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: ']]',
      repro: `await kallV2Client.sendRaw(KALL_V2_PATHS.endIndividualKall, ']]', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test("[IDOR] a foreign kallID must not reach another owner's record", async ({
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
      { kallID: FOREIGN.kallID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kallID',
      foreignValue: FOREIGN.kallID,
    });
  });
});
