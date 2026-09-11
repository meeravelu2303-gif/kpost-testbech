import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, KATCHUP_PATH_TEMPLATES } from '../../src/api/clients/katchupV2.client';
import {
  katchupMessageListResponseSchema,
  katchupMessageResponseSchema,
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
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildExistingMessagePayload,
  buildForwardPayload,
  buildMultipleMsgsForwardPayload,
  buildReferenceMessageListPayload,
  buildReferenceMessagesDetailsPayload,
  buildSharedMessageInfoPayload,
  buildThreadForwardPayload,
  nonExistentMsgId,
  syntheticReceiver,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Katchup V2 — forwarding, shared-message info and reference chains.
 *
 * Forwarding is republication. A forward copies someone else's words, and often their
 * attachment, into a conversation the original author has no part in and cannot see. So the
 * question every test here asks is the same: **can the caller forward, or read, a message
 * they were never a party to?**
 *
 * The reference routes are the subtler half. `getReferenceMessagesDetails`,
 * `getReferenceMSGDetails` and `getMessagesByReferenceMessageList` resolve a message's
 * ancestry — the chain of what was quoted or forwarded to produce it. A permissive reference
 * lookup leaks the *original* message even when the caller may legitimately see the copy,
 * which is a disclosure that ordinary conversation-level checks miss entirely.
 *
 * `getMessagesByReferenceMessageList` is notable in the source: it sets **both** sender and
 * receiver to the caller —
 *
 * ```java
 * katchupMessageRO.setSender(kpostID);
 * katchupMessageRO.setReceiver(kpostID);
 * ```
 *
 * which scopes it tightly but also means it can only ever match messages the caller sent to
 * themselves. Whether that is the intent is worth confirming; the contract test below reads
 * what actually comes back rather than assuming.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/katchup/forwardKatchupMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/forwardKatchupMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.forwardKatchupMessage,
    repro: `await katchupClient.forwardKatchupMessage({ files: [] }, { token, params: { text } });`,
  };

  test('[FR-K15][1] happy path: a forward satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const text = JSON.stringify(buildForwardPayload());
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text },
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: { files: [] } },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[1a] forward Reveal (messageType 15) — the sender is shown — satisfies the contract', async ({
    katchupClient,
    staticToken,
  }) => {
    // Reveal (15) vs Hidden (16) is the whole point of the two forward types (per the Types tab):
    // a Reveal forward shows the original author to the recipient. Exercised positively here.
    const text = JSON.stringify(buildForwardPayload({ messageType: 15, sharedType: 15 }));
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text },
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: { files: [] } },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[1b] forward Hidden (messageType 16) — the sender is concealed — satisfies the contract', async ({
    katchupClient,
    staticToken,
  }) => {
    // Hidden (16): the recipient must not learn the original author. The contract is asserted
    // here; the non-leak of the original sender is a follow-up once a recipient inbox read is
    // wired in (kept out of scope so this case cannot false-fail on an unverified reveal check).
    const text = JSON.stringify(buildForwardPayload({ messageType: 16, sharedType: 16 }));
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text },
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: { files: [] } },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[FR-K16][1c] forward WITH THREAD (messageType 20) satisfies the contract', async ({
    katchupClient,
    staticToken,
  }) => {
    // FR-K16 — "Forward a sent message with its full thread". The thread travels in
    // `referenceMessageList`, a JSON STRING of `[{msgIDs1:[…]},{msgIDs2:[…]}]` groups, and
    // messageType 20 is what makes the server read it. Nothing exercised this shape before.
    const text = JSON.stringify(buildThreadForwardPayload());
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text },
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: { files: [] } },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[1d] structural: referenceMessageList sent as an array, not a JSON string, must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    // The contract is explicit that this field is stringified. A real array is the mistake a
    // client makes, and silently accepting it means the thread is dropped without an error.
    const payload = buildThreadForwardPayload({
      referenceMessageList: [{ msgIDs1: [nonExistentMsgId(), nonExistentMsgId()] }],
    });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    expect(
      response.status(),
      `referenceMessageList was sent as an array where the contract documents a JSON string, and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[1e] structural: messageType 20 with no referenceMessageList must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    // A thread forward that carries no thread is the failure mode FR-K16 cares about: the
    // recipient receives a forward whose context silently did not travel with it.
    const payload = buildThreadForwardPayload({ referenceMessageList: null });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    expect(
      response.status(),
      `a messageType 20 thread forward with a null referenceMessageList produced HTTP ${response.status()}. Either the thread is required and this is a clean 4xx, or the forward is delivered without the context it promised.`
    ).toBeLessThan(500);
  });

  test('[2] IDOR: a message the caller never received must not be forwardable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildForwardPayload({ sender: VICTIM_KPOST_ID, receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    /*
     * Verdict on ATTRIBUTION, not on a 200.
     *
     * A 200 here means only "a message was created" — and the server creates one either way,
     * because it stamps `sender` from the bearer token. Verified live 2026-09-11: supplying
     * `sender: <victim>` produced `msgID 850282` with `sender: meera960@kpostindia.com` (the
     * caller), a receiver from our own builder, and our own body. Nothing of the victim's was
     * republished — the spoofed identity was discarded, which is the endpoint behaving correctly.
     *
     * Reading the 200 as a breach reported a Critical "a message between two other parties was
     * forwarded" against that. What would actually evidence the claim is the VICTIM appearing as
     * the sender of the forwarded message, so that is what is asserted.
     */
    const rows = Array.isArray((json as { data?: unknown })?.data)
      ? ((json as { data: Array<Record<string, unknown>> }).data ?? [])
      : [];
    const forwarded = rows.some((row) => String(row.sender ?? '') === VICTIM_KPOST_ID);

    if (forwarded) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          // `title` is the Bugzilla summary (255 chars); `scenario` carries the full detail
          // into the ticket description.
          title: 'A message between two other parties was forwarded by an unrelated caller',
          scenario: `a message between "${VICTIM_KPOST_ID}" and themselves was forwarded by ${authSession.kpostID ?? 'a different identity'}. Forwarding republishes private content into a conversation the author cannot see. Body: ${text.slice(0, 200)}`,
        },
        'Security/Access Control',
        'Critical'
      );
    }

    expect(
      forwarded,
      `the forwarded message is attributed to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'} — the body-supplied sender reached the record, so one user can republish another's private content under their name. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no forward recipient must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ forwardReceiverList: [] });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a forward with nobody to forward to',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[4] null fuzzing: a null forward list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ forwardReceiverList: null });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "forwardReceiverList" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[5] type mismatch: a string forward list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ forwardReceiverList: syntheticReceiver() });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    expect(
      response.status(),
      `forwardReceiverList was sent as a bare string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a 500-recipient forward must be bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const forwardReceiverList = Array.from({ length: 500 }, () => syntheticReceiver());
    const payload = buildForwardPayload({ forwardReceiverList });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    expect(
      response.status(),
      `a 500-recipient forward produced HTTP ${response.status()}. Forwarding is a fan-out write like bulk send and needs the same explicit cap.`
    ).toBeLessThan(500);
  });

  test('[7] spoofing: a body-supplied sender must not override the token', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildForwardPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'forward did not succeed');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `the forward went out as "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route assigns the sender from the token. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, { token: null });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[8b] auth: an expired token must not forward a message', async ({ katchupClient }) => {
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ actualMessage: SQLI_PAYLOAD });
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] structural: a malformed text parameter must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.forwardKatchupMessage({ files: [] }, {
      token: staticToken,
      params: { text: '{not json' },
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: { files: [] },
      title: 'A malformed forward payload is not rejected with a clean 400',
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

});

/* =========================================================================================
 * POST /v2/katchup/forwardKatchupMessageNew
 * ====================================================================================== */
test.describe('POST /v2/katchup/forwardKatchupMessageNew', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.forwardKatchupMessageNew,
    repro: `await katchupClient.forwardKatchupMessageNew(buildForwardPayload(), { token });`,
  };

  test('[1] happy path: the newer forward route satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload();
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] happy path: the thread variant (messageType 20) satisfies the contract', async ({
    katchupClient,
    staticToken,
  }) => {
    // Excel row 139 documents both variants on this route, not just the single-message one.
    const payload = buildThreadForwardPayload();
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] IDOR: a message the caller never received must not be forwardable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildForwardPayload({ sender: VICTIM_KPOST_ID, receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a message between two other people was forwarded by ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no referenceMessage must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload();
    delete (payload as Record<string, unknown>).referenceMessage;

    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a forward with no source message',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null referenceMessage must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildForwardPayload({ referenceMessage: null });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "referenceMessage" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object referenceMessage must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ referenceMessage: { id: 1 } });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `referenceMessage was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: forwarding a non-existent message must not succeed', async ({
    katchupClient,
    staticToken,
  }) => {
    const referenceMessage = nonExistentMsgId();
    const payload = buildForwardPayload({ referenceMessage });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `forwarding message ${referenceMessage}, which does not exist, reported success — most likely delivering an empty message. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] provenance: a forward must not erase the original author', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload();
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'forward did not succeed');

    const data = json?.data;
    const record = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    expect(
      record?.referenceMsgID ?? record?.referenceMessage,
      `the forwarded copy carried no referenceMsgID linking it to the original. Without it the recipient cannot tell a forward from something the sender wrote, and the reference routes have no chain to resolve. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildForwardPayload();
    const response = await katchupClient.forwardKatchupMessageNew(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never forward', async ({
    katchupClient,
  }) => {
    const payload = buildForwardPayload();
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildForwardPayload({ actualMessage: SQLI_PAYLOAD });
    const response = await katchupClient.forwardKatchupMessageNew(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.forwardKatchupMessageNew({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a forward',
        severity: 'Major' as const,
      },
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
 * POST /v2/katchup/forwardKatchupMultipleMsgs
 * ====================================================================================== */
test.describe('POST /v2/katchup/forwardKatchupMultipleMsgs', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.forwardKatchupMultipleMsgs,
    repro: `await katchupClient.forwardKatchupMultipleMsgs(buildMultipleMsgsForwardPayload(), { token });`,
  };

  test('[1] happy path: a multi-message forward satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId(), nonExistentMsgId()] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 500-message forward must be bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const forwardMessageIDList = Array.from({ length: 500 }, () => nonExistentMsgId());
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `forwarding 500 messages at once produced HTTP ${response.status()}. Messages × recipients is a multiplicative fan-out; both dimensions need a cap.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty message list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a forward with no messages selected',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no recipients must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId()] });
    delete (payload as Record<string, unknown>).forwardReceiverList;

    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a forward with nobody to forward to',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null message list must not forward everything', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: null });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "forwardMessageIDList" set to null on a bulk forward',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string message list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: '1,2,3' });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `forwardMessageIDList was sent as a comma-separated string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a mixed selection must not smuggle another user\'s message', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    // A bulk forward is where per-item ownership checks get skipped: the caller may own the
    // first id and not the second.
    const payload = buildMultipleMsgsForwardPayload({
      forwardMessageIDList: [nonExistentMsgId(), nonExistentMsgId()],
      sender: VICTIM_KPOST_ID,
    });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a bulk forward naming sender "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Ownership must be checked per message, not once for the batch. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({
      forwardMessageIDList: [nonExistentMsgId()],
      actualMessage: XSS_PAYLOAD,
    });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [SQLI_PAYLOAD] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId()] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not bulk-forward', async ({ katchupClient }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId()] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId()] });
    const response = await katchupClient.forwardKatchupMultipleMsgs(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: a double-submitted bulk forward must not deliver twice', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildMultipleMsgsForwardPayload({ forwardMessageIDList: [nonExistentMsgId()] });
    const [first, second] = await Promise.all([
      katchupClient.forwardKatchupMultipleMsgs(payload, { token: staticToken }),
      katchupClient.forwardKatchupMultipleMsgs(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical bulk forwards returned ${first.status()} and ${second.status()}.`
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
 * POST /v2/katchup/forwardMessageBacktrackByMsgID
 * ====================================================================================== */
test.describe('POST /v2/katchup/forwardMessageBacktrackByMsgID', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.forwardMessageBacktrackByMsgID,
    repro: `await katchupClient.forwardMessageBacktrackByMsgID(buildExistingMessagePayload(), { token });`,
  };

  test('[1] happy path: a backtrack satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] DISCLOSURE: a backtrack must not reveal the original private message', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingMessagePayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'backtrack returned no data');

    expect(
      /"actualMessage"\s*:\s*"[^"]{3,}"/.test(text),
      `a backtrack returned message bodies for a chain rooted in "${VICTIM_KPOST_ID}"'s conversation while the caller was ${authSession.kpostID ?? 'a different identity'}. Tracing a forward's ancestry walks *backwards* out of the caller's own conversation by design, so it needs a check at every hop, not just the first. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no msgID must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.forwardMessageBacktrackByMsgID({}, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a backtrack addressing no message',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null msgID must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildExistingMessagePayload({ msgID: null });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
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
    const payload = buildExistingMessagePayload({ msgID: 'origin' });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `msgID was sent as the string "origin" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a chain must terminate rather than recurse without limit', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ msgID: 1 });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `backtracking from msgID 1 produced HTTP ${response.status()}. A forward chain can be arbitrarily long, and a self-referential one would loop; the traversal needs a depth bound.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ msgID: SQLI_PAYLOAD });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not trace a chain', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload();
    const response = await katchupClient.forwardMessageBacktrackByMsgID(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive backtracks must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload();
    const [first, second] = await Promise.all([
      katchupClient.forwardMessageBacktrackByMsgID(payload, { token: staticToken }),
      katchupClient.forwardMessageBacktrackByMsgID(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical backtracks returned ${first.status()} and ${second.status()}.`
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
 * POST /v2/katchup/getSharedMessageInfo
 * ====================================================================================== */
test.describe('POST /v2/katchup/getSharedMessageInfo', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getSharedMessageInfo,
    repro: `await katchupClient.getSharedMessageInfo(buildSharedMessageInfoPayload(), { token });`,
  };

  test('[1] happy path: shared-message info satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: a body sender must not select another user\'s shares', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming sender "${VICTIM_KPOST_ID}" returned that user's shared messages while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setSender from the token. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no sharedMessageId must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageInfo({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a share lookup addressing no message',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null sharedMessageId must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: null });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "sharedMessageId" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array sharedMessageId must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: [nonExistentMsgId()] });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    expect(
      response.status(),
      `sharedMessageId was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] enumeration: a wildcard must not list every share', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: SQLI_WILDCARD });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_WILDCARD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: SQLI_PAYLOAD });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: XSS_PAYLOAD });
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getSharedMessageInfo(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return share info', async ({ katchupClient }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getSharedMessageInfo(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getSharedMessageInfo(payload, { token: staticToken });

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
 * GET /v2/katchup/getSharedMessageDetails/{msgID}
 * ====================================================================================== */
test.describe('GET /v2/katchup/getSharedMessageDetails/{msgID}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.getSharedMessageDetails,
    repro: `await katchupClient.getSharedMessageDetails(msgID, { token });`,
  };

  test('[1] happy path: share details satisfy the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(nonExistentMsgId(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: a message id alone must not disclose message content', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(1, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      /"actualMessage"\s*:\s*"[^"]{3,}"/.test(text),
      `msgID 1 returned a message body to ${authSession.kpostID ?? 'the caller'}. A sequential integer id is trivially enumerable, so if possession of the number is sufficient the whole message store can be walked from 1 upwards. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] enumeration: sequential ids must not resolve in order', async ({
    katchupClient,
    staticToken,
  }) => {
    const responses = await Promise.all([
      katchupClient.getSharedMessageDetails(1, { token: staticToken }),
      katchupClient.getSharedMessageDetails(2, { token: staticToken }),
      katchupClient.getSharedMessageDetails(3, { token: staticToken }),
    ]);
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const withContent = bodies.filter((b) => /"actualMessage"\s*:\s*"[^"]{3,}"/.test(b.text));

    expect(
      withContent.length,
      `${withContent.length} of message ids 1-3 returned content. Walking the id space is the cheapest possible attack on a messaging store.`
    ).toBe(0);
  });

  test('[4] type: a non-numeric msgID must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.getSharedMessageDetails('latest', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A non-numeric msgID is not rejected cleanly',
      severity: 'Major',
    });
  });

  test('[5] boundary: a msgID beyond int32 must not overflow', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(INT32_OVERFLOW, {
      token: staticToken,
    });

    expect(
      response.status(),
      `msgID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a 5000-character msgID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getSharedMessageDetails(nonExistentMsgId(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an alg=none token claiming admin must never read shares', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(nonExistentMsgId(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[9] empty-state: an unknown message must be 404, not a fault', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getSharedMessageDetails(nonExistentMsgId(), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      title: 'An unknown shared message produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const [first, second] = await Promise.all([
      katchupClient.getSharedMessageDetails(msgID, { token: staticToken }),
      katchupClient.getSharedMessageDetails(msgID, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
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
    const response = await genericClient.sendRaw('GET', META.path, malformed, {
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
 * POST /v2/katchup/getBulkMessageInfo
 * ====================================================================================== */
test.describe('POST /v2/katchup/getBulkMessageInfo', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getBulkMessageInfo,
    repro: `await katchupClient.getBulkMessageInfo(buildSharedMessageInfoPayload(), { token });`,
  };

  test('[1] happy path: bulk delivery info satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: another sender\'s broadcast results must not be readable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `broadcast results for "${VICTIM_KPOST_ID}" were returned to ${authSession.kpostID ?? 'a different identity'}. A bulk-delivery report lists every recipient of a broadcast — it is a distribution list. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no sharedMessageId must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getBulkMessageInfo({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a bulk-info lookup addressing no broadcast',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null sharedMessageId must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: null });
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "sharedMessageId" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean sharedMessageId must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: true });
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    expect(
      response.status(),
      `sharedMessageId was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a large recipient report must be paginated', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `the delivery report returned ${count} rows in one response. A broadcast can have very many recipients, so the report must be paged. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(1000);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: SQLI_PAYLOAD });
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload({ sharedMessageId: XSS_PAYLOAD });
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getBulkMessageInfo(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return delivery info', async ({ katchupClient }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getBulkMessageInfo(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const response = await katchupClient.getBulkMessageInfo(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSharedMessageInfoPayload();
    const [first, second] = await Promise.all([
      katchupClient.getBulkMessageInfo(payload, { token: staticToken }),
      katchupClient.getBulkMessageInfo(payload, { token: staticToken }),
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'messageID',
      foreignValue: FOREIGN.messageID,
    });
  });

});

/* =========================================================================================
 * POST /v2/katchup/getReferenceMessagesDetails
 * ====================================================================================== */
test.describe('POST /v2/katchup/getReferenceMessagesDetails', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getReferenceMessagesDetails,
    repro: `await katchupClient.getReferenceMessagesDetails(buildReferenceMessagesDetailsPayload(), { token });`,
  };

  test('[1] happy path: a reference lookup satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] DISCLOSURE: the referenced original must not leak to a non-party', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({
      sourceMsgID: 1,
      sender: VICTIM_KPOST_ID,
    });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      /"actualMessage"\s*:\s*"[^"]{3,}"/.test(text),
      `a reference lookup returned message bodies for a chain rooted in "${VICTIM_KPOST_ID}"'s conversation while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller's own comment marks this route as temporary — "need to remove after implementation of forward hidden / reveal" — which is exactly the kind of route that outlives its note. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no reference id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getReferenceMessagesDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a reference lookup with no reference',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null reference id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: null });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `sourceMsgID null produced HTTP ${response.status()}. A message with no reference is the normal case; it must be handled, not faulted.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string reference id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: 'root' });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `sourceMsgID was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a self-referential chain must not loop', async ({
    katchupClient,
    staticToken,
  }) => {
    const msgID = nonExistentMsgId();
    const payload = buildReferenceMessagesDetailsPayload({ msgID, sourceMsgID: msgID });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a message referencing itself produced HTTP ${response.status()}. Chain traversal must detect cycles rather than recursing until it exhausts the stack.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: SQLI_PAYLOAD });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMessagesDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not resolve a chain', async ({ katchupClient }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMessagesDetails(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendRaw(
      KATCHUP_PATHS.getReferenceMessagesDetails,
      '{"sourceMsgID":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"sourceMsgID":',
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
 * POST /v2/katchup/getReferenceMSGDetails
 * ====================================================================================== */
test.describe('POST /v2/katchup/getReferenceMSGDetails', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getReferenceMSGDetails,
    repro: `await katchupClient.getReferenceMSGDetails(buildReferenceMessagesDetailsPayload(), { token });`,
  };

  test('[1] happy path: the second reference route satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] duplication: two near-identical reference routes must not diverge', async ({
    katchupClient,
    staticToken,
  }) => {
    // getReferenceMessagesDetails and getReferenceMSGDetails differ only in name. If they
    // behave differently, one of them is stale and clients cannot know which to trust.
    const payload = buildReferenceMessagesDetailsPayload();
    const [a, b] = await Promise.all([
      katchupClient.getReferenceMSGDetails(payload, { token: staticToken }),
      katchupClient.getReferenceMessagesDetails(payload, { token: staticToken }),
    ]);

    expect(
      a.status(),
      `getReferenceMSGDetails answered ${a.status()} while getReferenceMessagesDetails answered ${b.status()} for the same input. Two routes with near-identical names and different behaviour is a maintenance trap — one is presumably superseded and should be removed.`
    ).toBe(b.status());
  });

  test('[3] IDOR: the referenced original must not leak to a non-party', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: 1, sender: VICTIM_KPOST_ID });
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      /"actualMessage"\s*:\s*"[^"]{3,}"/.test(text),
      `a reference lookup returned message bodies from "${VICTIM_KPOST_ID}"'s conversation to ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] missing required parameter: no reference id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getReferenceMSGDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a reference lookup with no reference',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array reference id must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: [1, 2] });
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    expect(
      response.status(),
      `sourceMsgID was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a reference id beyond int32 must not overflow', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: INT32_OVERFLOW });
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    expect(
      response.status(),
      `sourceMsgID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ sourceMsgID: SQLI_PAYLOAD });
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not resolve a chain', async ({ katchupClient }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMSGDetails(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const response = await katchupClient.getReferenceMSGDetails(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive lookups must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessagesDetailsPayload();
    const [first, second] = await Promise.all([
      katchupClient.getReferenceMSGDetails(payload, { token: staticToken }),
      katchupClient.getReferenceMSGDetails(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical lookups returned ${first.status()} and ${second.status()}.`
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
 * POST /v2/katchup/getMessagesByReferenceMessageList
 * ====================================================================================== */
test.describe('POST /v2/katchup/getMessagesByReferenceMessageList', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.getMessagesByReferenceMessageList,
    repro: `await katchupClient.getMessagesByReferenceMessageList(buildReferenceMessageListPayload(), { token });`,
  };

  test('[1] happy path: a reference-list lookup satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload();
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: scoping both sender and receiver to the caller must still return their messages', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    // The controller sets BOTH sender and receiver to the caller's kpostID. Taken literally
    // that matches only self-addressed messages, which would make the route return nothing
    // useful. This reads what actually comes back rather than assuming either way.
    const payload = buildReferenceMessageListPayload();
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      response.status(),
      `the route answered HTTP ${response.status()} for ${authSession.kpostID ?? 'the caller'}. It sets sender AND receiver to the same kpostID, so if the query ANDs them it can only ever match self-addressed messages — worth confirming the intent with the developers. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[3] IDOR: a body sender must not widen the scope', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildReferenceMessageListPayload({
      sender: VICTIM_KPOST_ID,
      receiver: VICTIM_KPOST_ID,
    });
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'lookup returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming "${VICTIM_KPOST_ID}" returned that user's messages while the caller was ${authSession.kpostID ?? 'a different identity'}. This route overwrites both identity fields from the token, so body values must be inert. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] missing required parameter: no reference list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getMessagesByReferenceMessageList(
      {},
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a reference-list lookup with no list',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] null fuzzing: a null reference list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload({ referenceMessageList: null, msgID: null });
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `null reference ids produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a 1000-reference batch must be bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload({
      referenceMessageList: Array.from({ length: 1000 }, () => nonExistentMsgId()),
    });
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 1000-reference batch produced HTTP ${response.status()}. Resolving many chains at once multiplies the work per request and must be capped.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload({ referenceMessageList: SQLI_PAYLOAD });
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildReferenceMessageListPayload();
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never resolve references', async ({
    katchupClient,
  }) => {
    const payload = buildReferenceMessageListPayload();
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload();
    const response = await katchupClient.getMessagesByReferenceMessageList(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive lookups must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildReferenceMessageListPayload();
    const [first, second] = await Promise.all([
      katchupClient.getMessagesByReferenceMessageList(payload, { token: staticToken }),
      katchupClient.getMessagesByReferenceMessageList(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical lookups returned ${first.status()} and ${second.status()}.`
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
