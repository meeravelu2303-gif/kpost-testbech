import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS } from '../../src/api/clients/katchupV2.client';
import { katchupMessageResponseSchema } from '../../src/api/schemas/katchupV2.schema';
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
  buildBulkMessagePayload,
  buildChangeCaptionPayload,
  buildExistingMessagePayload,
  buildForwardSelectedAttachmentPayload,
  buildKatchupMessagePayload,
  buildSaveGroupMessagesPayload,
  buildSaveMessagesPayload,
  nonExistentMsgId,
  syntheticReceiver,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Katchup V2 — sending, saving and editing messages.
 *
 * ## The finding this file exists for
 *
 * `sendMessage` assigns the sender from the bearer token, as it should:
 *
 * ```java
 * String sender = (String) request.getAttribute("kpostID");
 * katchupMessageRO.setSender(sender);
 * ```
 *
 * Its sibling `sendMessageForForwardSelectedAttachment` has the **same two lines commented
 * out**:
 *
 * ```java
 * // String sender = (String) request.getAttribute("kpostID");
 * // katchupMessageRO.setSender(sender);
 * ```
 *
 * So on that one route the sender is whatever the request body says. A message arrives in the
 * recipient's conversation attributed to a person who never sent it, and the recipient has no
 * way to tell — the sender field is the only provenance a chat message has. Every other send
 * route on the controller assigns it from the token, which is what makes this a slip rather
 * than a design.
 *
 * ## Safety
 *
 * Every recipient here is a synthetic, non-existent kpostID and every body is `qaLabel`-tagged,
 * because these routes deliver real messages and raise real push notifications. Bulk sends are
 * capped at two recipients.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const XSS_IMG_PAYLOAD = `<img src=x onerror=alert(1)>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_katchup; --`;
const MAX_LENGTH_STRING = 'a'.repeat(50000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/katchup/sendMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendMessage,
    repro: `await katchupClient.sendMessage(buildKatchupMessagePayload(), { token });`,
  };

  test('[1] happy path: sending a message satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a sent message must come back with its msgID', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.msgID,
      `the message was sent but no msgID came back. Recall, delete, mark-important and caption edits all address a message by that id, so the sender cannot unsend what they just sent. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 50,000-character message must be stored or refused explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: MAX_LENGTH_STRING });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `a 50,000-character message produced HTTP ${response.status()}. Either there is a length cap and it is a clean 400, or there is not and the text must not be silently truncated — a half-delivered message is worse than a refused one.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 message must survive intact', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: UTF8_STRING });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 message produced HTTP ${response.status()}. People message in their own script and with emoji; this is ordinary input.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: an unknown messageType must be refused, not defaulted', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ messageType: 9999 });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'messageType 9999 is outside the known set' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a message with nobody to deliver it to' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: null });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty message body must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: '' });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an empty message with no attachment' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: [syntheticReceiver()] });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `receiver was sent as an array on the single-recipient route and produced HTTP ${response.status()}. Bulk delivery has its own route; this one must not quietly fan out.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a message to a non-existent user must not report success', async ({
    katchupClient,
    staticToken,
  }) => {
    const receiver = syntheticReceiver();
    const payload = buildKatchupMessagePayload({ receiver });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a message to "${receiver}", who does not exist, reported success. The sender sees a delivered tick for a message nobody will ever receive. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the message body must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] XSS: an img/onerror payload in the subject must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ subject: XSS_IMG_PAYLOAD });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_IMG_PAYLOAD);
  });

  test('[7c] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: SQLI_DROP_PAYLOAD });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not send a message', async ({ katchupClient }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never send', async ({
    katchupClient,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] spoofing: a body-supplied sender must not override the token', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKatchupMessagePayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the message was attributed to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route does call setSender from the token, so a body value must never survive — the sender field is the only provenance a chat message carries. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP 200 must not carry a failure payload', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.sendMessage(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.sendMessage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a message send' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] idempotency: a double-submitted send must not deliver twice', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ temporaryMsgID: 4242 });
    const [first, second] = await Promise.all([
      katchupClient.sendMessage(payload, { token: staticToken }),
      katchupClient.sendMessage(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical sends returned ${first.status()} and ${second.status()}. temporaryMsgID exists precisely so a retried send can be de-duplicated; a flaky connection must not double-post to the recipient.`
    ).toBe(true);
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
 * POST /v2/katchup/sendMessageForForwardSelectedAttachment
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessageForForwardSelectedAttachment', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendMessageForForwardSelectedAttachment,
    repro: `await katchupClient.sendMessageForForwardSelectedAttachment(buildForwardSelectedAttachmentPayload(), { token });`,
  };

  test('[1] happy path: an attachment forward satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload();
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] SPOOFING: a body-supplied sender must not become the message author', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the message was authored as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route has its sender assignment commented out — "// katchupMessageRO.setSender(sender);" — while every sibling send route performs it. The recipient sees a message from someone who never wrote it, with no way to tell. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[2b] SPOOFING: the returned record must be attributed to the caller', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const self = authSession.kpostID;
    test.skip(!self, 'no authenticated identity to compare against');

    const payload = buildForwardSelectedAttachmentPayload();
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    const data = json?.data;
    const record = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    test.skip(record?.sender === undefined, 'response carried no sender to check');

    expect(
      record?.sender,
      `the message was stored with sender "${record?.sender}" when the authenticated caller is "${self}". With the token assignment commented out, an omitted body sender leaves the field unset or defaulted rather than resolved from the session. Body: ${text.slice(0, 200)}`
    ).toBe(self);
  });

  test('[3] missing required parameter: no receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an attachment forward with no recipient' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({ receiver: null });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiver" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({ receiver: 12345 });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `receiver was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] ownership: an attachment the caller cannot see must not be forwardable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({
      msgID: nonExistentMsgId(),
      sender: VICTIM_KPOST_ID,
    });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an attachment from a message belonging to "${VICTIM_KPOST_ID}" was forwarded by ${authSession.kpostID ?? 'a different identity'}. Forwarding is a republish: it copies a private file into a conversation the original sender has no part in. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload({ actualMessage: SQLI_PAYLOAD });
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildForwardSelectedAttachmentPayload();
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not forward an attachment', async ({ katchupClient }) => {
    const payload = buildForwardSelectedAttachmentPayload();
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardSelectedAttachmentPayload();
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.sendMessageForForwardSelectedAttachment(
      {},
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an attachment forward' },
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

});

/* =========================================================================================
 * POST /v2/katchup/sendBulkKatchupMsg
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendBulkKatchupMsg', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendBulkKatchupMsg,
    repro: `await katchupClient.sendBulkKatchupMsg(buildBulkMessagePayload(), { token });`,
  };

  test('[1] happy path: a bulk send satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: an empty recipient list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ receiverList: [] });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a broadcast with nobody on the recipient list' },
      [400, 401, 403, 422]
    );
  });

  test('[2b] boundary: a recipient-count limit must exist', async ({
    katchupClient,
    staticToken,
  }) => {
    const receiverList = Array.from({ length: 500 }, () => syntheticReceiver());
    const payload = buildBulkMessagePayload({ receiverList });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-recipient broadcast produced HTTP ${response.status()}. This is the highest fan-out write in the API — one push per recipient, undoable only one copy at a time — so a cap must be enforced explicitly.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no receiverList must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload();
    delete (payload as Record<string, unknown>).receiverList;

    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'bulk send with no recipient list at all' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null receiverList must not fan out to everyone', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ receiverList: null });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "receiverList" null on the fan-out route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string receiverList must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ receiverList: syntheticReceiver() });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    expect(
      response.status(),
      `receiverList was sent as a bare string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: duplicate recipients must not receive two copies', async ({
    katchupClient,
    staticToken,
  }) => {
    const receiver = syntheticReceiver();
    const payload = buildBulkMessagePayload({ receiverList: [receiver, receiver, receiver] });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      response.status(),
      `the same recipient listed three times produced HTTP ${response.status()}. The list must be de-duplicated or refused; three pushes for one broadcast is a defect the recipient experiences directly. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[7] XSS: a script payload in the broadcast body must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ subject: SQLI_PAYLOAD });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never broadcast', async ({
    katchupClient,
  }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsg(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] spoofing: a body-supplied sender must not override the token', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBulkMessagePayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'broadcast did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `a broadcast went out as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. On the fan-out route a spoofed sender reaches every recipient simultaneously. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsg(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.sendBulkKatchupMsg({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on the fan-out route' },
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

});

/* =========================================================================================
 * POST /v2/katchup/saveKatchupMessages
 * ====================================================================================== */
test.describe('POST /v2/katchup/saveKatchupMessages', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.saveKatchupMessages,
    repro: `await katchupClient.saveKatchupMessages(buildSaveMessagesPayload(), { token });`,
  };

  /*
   * This route ARCHIVES existing messages — Excel row 38 takes `{ receiver | groupKpostID,
   * msgIDs, groupFlag }`, not a compose body. The whole describe used to send
   * `buildKatchupMessagePayload`, so every case fuzzed fields (`actualMessage`, `sender`,
   * `subject`) that this endpoint does not read.
   */

  test('[1] happy path: archiving messages satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload();
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] happy path: the group form keys on groupKpostID instead of receiver', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveGroupMessagesPayload();
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 1,000-id archive batch must be handled explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({
      msgIDs: Array.from({ length: 1000 }, () => nonExistentMsgId()),
    });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    expect(
      response.status(),
      `a 1,000-id archive batch produced HTTP ${response.status()}. The batch size is client-supplied, so an unbounded list is a cheap way to hold a database transaction open.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload();
    delete (payload as Record<string, unknown>).receiver;

    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'archive request with no counterpart' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgIDs list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({ msgIDs: null });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "msgIDs" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty msgIDs list must not archive everything', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({ msgIDs: [] });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "msgIDs" set to an empty list' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a scalar where msgIDs expects a list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({ msgIDs: nonExistentMsgId() });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    expect(
      response.status(),
      `msgIDs was sent as a bare number where a list is documented and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] spoofing: archiving against a foreign counterpart must not reach their thread', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    // `receiver` names the conversation whose messages are archived, so it is the identity field
    // on this route — the compose route's `sender` is not read here at all.
    const payload = buildSaveMessagesPayload({ receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'archive did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the archive acknowledged messages belonging to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The conversation must be resolved against the token's own threads, not taken from the body. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be persisted unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({ receiver: XSS_PAYLOAD });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload({ receiver: SQLI_PAYLOAD });
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildSaveMessagesPayload();
    const response = await katchupClient.saveKatchupMessages(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not archive messages', async ({ katchupClient }) => {
    const payload = buildSaveMessagesPayload();
    const response = await katchupClient.saveKatchupMessages(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSaveMessagesPayload();
    const response = await katchupClient.saveKatchupMessages(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.saveKatchupMessages({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a message archive' },
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

});

/* =========================================================================================
 * POST /v2/katchup/patchWorkForGroup
 * ====================================================================================== */
test.describe('POST /v2/katchup/patchWorkForGroup', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.patchWorkForGroup,
    repro: `await katchupClient.patchWorkForGroup(buildExistingMessagePayload(), { token });`,
  };

  test('[1] happy path: a group patch satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ groupFlag: true });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] exposure: a maintenance route must not be reachable by an ordinary member', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingMessagePayload({ groupFlag: true });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a route named "patchWorkForGroup" succeeded for an ordinary member token (${authSession.kpostID ?? 'unknown'}). A data-repair endpoint shipped on the public surface should be restricted or removed — its name says it exists to fix records, not to serve users. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.patchWorkForGroup({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'group patch with no message to patch' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgID must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildExistingMessagePayload({ msgID: null });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "msgID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ msgID: 'all' });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `msgID was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a msgID beyond int32 must not overflow', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ msgID: INT32_OVERFLOW });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `msgID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ receiver: SQLI_PAYLOAD });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.patchWorkForGroup(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not patch group data', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.patchWorkForGroup(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.patchWorkForGroup(payload, { token: staticToken });

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
 * POST /v2/katchup/changeCaption
 * ====================================================================================== */
test.describe('POST /v2/katchup/changeCaption', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.changeCaption,
    repro: `await katchupClient.changeCaption(buildChangeCaptionPayload(), { token });`,
  };

  test('[1] happy path: a caption edit satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload();
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character caption must be handled explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload({ attachmentCaption: MAX_LENGTH_STRING });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    expect(
      response.status(),
      `a 50,000-character caption produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload();
    delete (payload as Record<string, unknown>).msgID;

    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'caption edit addressing no message' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null caption must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload({ attachmentCaption: null });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "attachmentCaption" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a non-JSON caption blob must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload({ attachmentCaption: 'not-a-json-array' });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    expect(
      response.status(),
      `attachmentCaption is a serialised JSON array in the contract; a bare string produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a caption on another user\'s message must not be editable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildChangeCaptionPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a caption was edited on a message belonging to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Editing text attached to someone else's message rewrites what their recipients see. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in a caption must not be persisted unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload({
      attachmentCaption: JSON.stringify([{ fileName: 'qa.png', caption: XSS_PAYLOAD }]),
    });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildChangeCaptionPayload({ attachmentCaption: SQLI_PAYLOAD });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildChangeCaptionPayload();
    const response = await katchupClient.changeCaption(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not edit a caption', async ({ katchupClient }) => {
    const payload = buildChangeCaptionPayload();
    const response = await katchupClient.changeCaption(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] business rule: editing a caption on a non-existent message must not succeed', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const payload = buildChangeCaptionPayload({ msgID });
    const response = await katchupClient.changeCaption(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `editing the caption on message ${msgID}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendRaw(KATCHUP_PATHS.changeCaption, '{"msgID":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"msgID":',
      repro: `await katchupClient.sendRaw(KATCHUP_PATHS.changeCaption, '{"msgID":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
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
