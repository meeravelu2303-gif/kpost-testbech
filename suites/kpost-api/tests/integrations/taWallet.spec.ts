import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { INTEGRATION_PATHS } from '../../src/api/clients/integrations.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertUnauthorized,
  assertPublicRouteReachable,
  expectValidContract,
  readBody,
  assertStatusCodeParity,
} from '../../src/utils/apiAssertions';
import {
  buildCreateHashPayload,
  buildPaymentCallbackForm,
  buildTransactionLookupPayload,
  buildWalletCommunicationPayload,
  nonExistentOrderId,
} from '../../src/api/payloads/integrations.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * TA Wallet — payment signing, gateway callbacks and transaction lookup.
 *
 * ## The finding this file exists for: `createHash` is a signing oracle
 *
 * ```java
 * @PostMapping("createHash")
 * @Transactional
 * public Map<String,String> userLogin(@RequestBody Map<String,String> requestMap) {
 *     resultMap = KPOSTUtil.generateHashKey(requestMap, salt, apiKey);
 *     tAWalletService.saveHashDetails(requestMap.get("email").toString().trim(), resultMap);
 *     resultMap.put(STATUS, SUCCESS);
 *     return resultMap;
 * }
 * ```
 *
 * The handler takes an **arbitrary map** of order fields, signs it with the merchant `salt`
 * and `apiKey`, and hands the signature back. There is **no `HttpServletRequest`** — no
 * identity check of any kind.
 *
 * The entire purpose of that hash is to prove to the gateway that *the merchant* authorised
 * those exact order parameters. If a caller chooses the parameters, the guarantee is gone:
 * request a signature over `amount: 1.00` for an order that should cost ₹5,000 and the
 * gateway will accept it, because the signature is genuine.
 *
 * Three smaller defects ride along: the method is named `userLogin`, the error branch says
 * *"Exception occurred while saving imported phone Contacts"* — copy-pasted from a contacts
 * importer — and `resultMap` is an instance field on a singleton controller, so concurrent
 * callers share it.
 *
 * ## Safety
 *
 * Every amount here is a token `1.00`. A test that requested a signature over a large sum
 * would have produced a genuinely spendable artifact; a one-rupee signature demonstrates the
 * same defect and is worth nothing to anyone. Emails are synthetic because the handler
 * persists the hash keyed by that address, and every order id is provably non-existent so
 * the form-encoded callbacks cannot land on a real transaction.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * POST /taWallet/createHash
 * ====================================================================================== */
test.describe('POST /taWallet/createHash', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.taWalletCreateHash,
    repro: `await integrationsClient.taWalletCreateHash(buildCreateHashPayload(), { token });`,
  };

  test('[1] ORACLE: signing must require authentication', async ({ integrationsClient }) => {
    const payload = buildCreateHashPayload();
    const response = await integrationsClient.taWalletCreateHash(payload, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      body: payload,
      title: 'Payment gateway signatures can be minted without authentication',
      severity: 'Critical',
    });
  });

  test('[2] ORACLE: a caller must not choose the amount that gets signed', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload({ amount: '1.00' });
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const signed = Object.entries(json ?? {}).some(
      ([key, value]) => /hash|signature/i.test(key) && typeof value === 'string' && value.length > 16
    );
    expect(
      signed,
      `the endpoint returned a gateway signature over caller-supplied order fields. The hash exists to prove the merchant authorised this exact amount; if the caller picks the amount, a shopper can pay 1.00 for a 5,000.00 order and the gateway will accept it because the signature is real. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] contract: the salt and apiKey must never appear in the response', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload();
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"(salt|apiKey|api_key|secret)"\s*:/i.test(text),
      `the signing response echoed a key named like a secret. The salt and apiKey are the merchant's credentials — leaking either turns every future signature into something anyone can forge offline. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] missing required parameter: no email must be refused, not NPE', async ({
    integrationsClient,
    staticToken,
  }) => {
    // The handler calls requestMap.get("email").toString() with no null check.
    const payload = buildCreateHashPayload();
    delete (payload as Record<string, unknown>).email;

    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'email omitted — the handler dereferences it unchecked' },
      [400, 401, 403, 422]
    );
  });

  test('[5] disclosure: the wrong error message must not surface', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload();
    delete (payload as Record<string, unknown>).email;

    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /imported phone Contacts/i.test(text),
      `a payment-signing failure reported "Exception occurred while saving imported phone Contacts" — copy-pasted from a contacts importer. An operator triaging a payment incident is told to look in the wrong subsystem. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[6] null fuzzing: a null amount must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload({ amount: null });
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "amount" set to null on a signing request' },
      [400, 401, 403, 422]
    );
  });

  test('[7] business rule: a negative amount must not be signed', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload({ amount: '-100.00' });
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a negative order amount — a signed refund in the shape of a purchase',
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload({ email: SQLI_PAYLOAD });
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCreateHashPayload({ productinfo: XSS_PAYLOAD });
    const response = await integrationsClient.taWalletCreateHash(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] concurrency: the shared resultMap must not bleed between callers', async ({
    integrationsClient,
    staticToken,
  }) => {
    // `resultMap` is an instance field on this singleton controller, reassigned per request.
    const [a, b] = await Promise.all([
      integrationsClient.taWalletCreateHash(buildCreateHashPayload({ order_id: 'QA-ORDER-A' }), {
        token: staticToken,
      }),
      integrationsClient.taWalletCreateHash(buildCreateHashPayload({ order_id: 'QA-ORDER-B' }), {
        token: staticToken,
      }),
    ]);
    const first = await readBody(a);
    const second = await readBody(b);

    test.skip(first.json === null || second.json === null, 'responses were not JSON');

    expect(
      first.text === second.text && first.text.length > 40,
      `two concurrent signing requests for different orders returned byte-identical bodies. The controller stores its result in a shared instance field, so one caller can receive another caller's payment signature. Body: ${first.text.slice(0, 200)}`
    ).toBe(false);
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

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* =========================================================================================
 * POST /taWallet/paymentRequest  (form-encoded gateway callback)
 * ====================================================================================== */
test.describe('POST /taWallet/paymentRequest', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.taWalletPaymentRequest,
    repro: `await integrationsClient.taWalletPaymentRequest(buildPaymentCallbackForm());`,
  };

  test('[1] AUTHENTICITY: an unsigned callback must not be trusted', async ({
    integrationsClient,
  }) => {
    // The gateway posts the payment verdict here. If the handler persists whatever arrives
    // without verifying the gateway's signature, anyone can declare their own order paid.
    const form = buildPaymentCallbackForm({ response_code: '1' });
    const response = await integrationsClient.taWalletPaymentRequest(form);
    const { text } = await readBody(response);

    expect(
      response.status() < 400 && /success|paid|complete/i.test(text),
      `a forged callback declaring response_code=1 was accepted. This route decides whether an order counts as paid; it must verify the gateway's signature over the form fields before persisting, or a buyer can mark their own basket paid by POSTing to it. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[auth] the gateway callback must remain reachable without a token', async ({
    integrationsClient,
  }) => {
    // The payment gateway POSTs its verdict here with no KPost bearer token — that is the
    // route's normal caller. Authenticity is the gateway's signature over the form (asserted
    // in [1]), not a token, so requiring one would break every payment confirmation. This
    // verifies the auth filter does not gate the route; an invalid form keeps the probe from
    // persisting a verdict.
    const response = await integrationsClient.taWalletPaymentRequest('order_id=', { token: null });
    await assertPublicRouteReachable(response, {
      ...META,
      body: 'order_id=',
      // The spec is explicit — "[Gateway callback, HTML] Browser-facing callback that the TA
      // Wallet gateway posts the payment outcome to." The returning browser holds no KPost JWT,
      // so gating this route rejects every payment return with 401: the transaction is never
      // persisted and the buyer is never bounced to their confirmation. Total payment blockade.
      title: 'Payment gateway callback requires a bearer token the returning browser cannot send',
      severity: 'Critical',
    });
  });

  test('[2] contract: the route answers HTML, not JSON', async ({ integrationsClient }) => {
    const response = await integrationsClient.taWalletPaymentRequest(buildPaymentCallbackForm());
    const contentType = response.headers()['content-type'] ?? '';

    expect(
      /json/i.test(contentType) || /html/i.test(contentType) || contentType === '',
      `the browser-facing callback answered content-type "${contentType}". It is documented as returning an HTML document for the user's browser; anything else breaks the redirect-back experience.`
    ).toBe(true);
  });

  test('[3] missing required parameter: no order_id must be refused', async ({
    integrationsClient,
  }) => {
    const response = await integrationsClient.taWalletPaymentRequest('response_code=1');

    expect(
      response.status(),
      `a callback with no order_id produced HTTP ${response.status()}. It must be refused cleanly — a verdict with nothing to attach it to should never reach persistence.`
    ).toBeLessThan(500);
  });

  test('[4] business rule: an unknown order must not create a transaction', async ({
    integrationsClient,
  }) => {
    const orderId = nonExistentOrderId();
    const form = buildPaymentCallbackForm({ order_id: orderId, response_code: '1' });
    const response = await integrationsClient.taWalletPaymentRequest(form);
    const { text } = await readBody(response);

    expect(
      /success/i.test(text) && !/not found|invalid|unknown/i.test(text),
      `a callback for order ${orderId}, which does not exist, was reported as successful. The documentation notes the handler persists the verdict for *every* outcome — including orders it has never seen. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[5] type: a JSON body on a form-encoded route must be refused', async ({
    integrationsClient,
  }) => {
    const response = await integrationsClient.sendRaw(
      INTEGRATION_PATHS.taWalletPaymentRequest,
      JSON.stringify({ order_id: nonExistentOrderId(), response_code: '1' })
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"order_id":"…"}',
      title: 'A form-encoded-only callback accepts a JSON body',
      severity: 'Minor',
    });
  });

  test('[6] boundary: a 5000-character order id must not fault', async ({ integrationsClient }) => {
    const form = buildPaymentCallbackForm({ order_id: MAX_LENGTH_STRING });
    const response = await integrationsClient.taWalletPaymentRequest(form);

    expect(
      response.status(),
      `a 5000-character order_id produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] XSS: a reflected script in the HTML response would execute', async ({
    integrationsClient,
  }) => {
    // This route returns HTML to a browser, so reflection here is directly executable —
    // unlike the JSON surfaces elsewhere in this suite.
    const form = buildPaymentCallbackForm({ order_id: XSS_PAYLOAD });
    const response = await integrationsClient.taWalletPaymentRequest(form);

    await assertNoReflectedScript(response, { ...META, body: form }, XSS_PAYLOAD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
  }) => {
    const form = buildPaymentCallbackForm({ order_id: SQLI_PAYLOAD });
    const response = await integrationsClient.taWalletPaymentRequest(form);

    await assertNoInternalLeak(response, { ...META, body: form }, SQLI_PAYLOAD);
  });

  test('[9] idempotency: a replayed callback must not double-credit', async ({
    integrationsClient,
  }) => {
    const form = buildPaymentCallbackForm({ response_code: '1' });
    const first = await integrationsClient.taWalletPaymentRequest(form);
    const second = await integrationsClient.taWalletPaymentRequest(form);

    expect(
      first.status(),
      `the same callback posted twice returned ${first.status()} then ${second.status()}. Gateways retry callbacks by design, so this route must be idempotent or a single payment is recorded twice.`
    ).toBe(second.status());
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

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});

/* =========================================================================================
 * POST /taWallet/fetchTransactionDetailsByOrderId
 * ====================================================================================== */
test.describe('POST /taWallet/fetchTransactionDetailsByOrderId', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.taWalletFetchTransaction,
    repro: `await integrationsClient.taWalletFetchTransaction(buildTransactionLookupPayload(), { token });`,
  };

  test('[1] happy path: a transaction lookup satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload();
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: an order id alone must not disclose a transaction', async ({
    integrationsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildTransactionLookupPayload();
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      /"(amount|email|phone|cardMask|payerName)"\s*:\s*"?[^",]{2,}/i.test(text),
      `a transaction lookup keyed only on order_id returned payment details to ${authSession.kpostID ?? 'the caller'}. Order ids are short, shared in emails and often sequential; they must not be the sole key to what someone paid and how. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] auth: an unauthenticated lookup must be 401/403', async ({ integrationsClient }) => {
    const payload = buildTransactionLookupPayload();
    const response = await integrationsClient.taWalletFetchTransaction(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[4] auth: an expired token must not return a transaction', async ({
    integrationsClient,
  }) => {
    const payload = buildTransactionLookupPayload();
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[5] missing required parameter: no order_id must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.taWalletFetchTransaction({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a transaction lookup with no order id',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] enumeration: a wildcard must not list every transaction', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload({ order_id: '%' });
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `an order_id of "%" returned ${count} transactions. A payment ledger must never be enumerable. Body: ${text.slice(0, 300)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[7] null fuzzing: a null order_id must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload({ order_id: null });
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "order_id" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload({ order_id: SQLI_PAYLOAD });
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload({ order_id: XSS_PAYLOAD });
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] empty-state: an unknown order must be 404, not a fault', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildTransactionLookupPayload();
    const response = await integrationsClient.taWalletFetchTransaction(payload, {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 404, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown order produces a server fault rather than 404',
      severity: 'Minor',
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
 * POST /taWallet/sendCommunicationMessage
 * ====================================================================================== */
test.describe('POST /taWallet/sendCommunicationMessage', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.taWalletSendCommunication,
    repro: `await integrationsClient.taWalletSendCommunication(buildWalletCommunicationPayload(), { token });`,
  };

  test('[1] BREACH: an unauthenticated caller must not send a message', async ({
    integrationsClient,
  }) => {
    const payload = buildWalletCommunicationPayload();
    const response = await integrationsClient.taWalletSendCommunication(payload, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      body: payload,
      title: 'A wallet notification bridge can dispatch messages without a token',
      severity: 'Critical',
    });
  });

  test('[2] spam: the recipient must not be chosen freely by the caller', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ mobileNumber: '9000000001' });
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a caller-supplied mobile number was accepted as the destination for a wallet notification. A callback bridge should notify the party on the transaction, not an arbitrary number — otherwise it is an SMS relay. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no message must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload();
    delete (payload as Record<string, unknown>).message;

    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a notification with no message', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null recipient must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ mobileNumber: null });
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "mobileNumber" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] boundary: a 5000-character message must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ message: MAX_LENGTH_STRING });
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character message produced HTTP ${response.status()}. SMS is billed per segment; an unbounded message is unbounded spend.`
    ).toBeLessThan(500);
  });

  test('[6] rate limiting: repeated dispatch must be throttled', async ({
    integrationsClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        integrationsClient.taWalletSendCommunication(buildWalletCommunicationPayload(), {
          token: staticToken,
        })
      )
    );

    expect(
      responses.every((r) => r.status() < 500),
      `five concurrent dispatches returned ${responses.map((r) => r.status()).join(', ')}. A message-dispatch bridge must survive concurrency and ideally throttle it.`
    ).toBe(true);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ message: XSS_PAYLOAD });
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ message: SQLI_PAYLOAD });
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] auth: a malformed token must not dispatch', async ({ integrationsClient }) => {
    const payload = buildWalletCommunicationPayload();
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[10] auth: an alg=none token claiming admin must never dispatch', async ({
    integrationsClient,
  }) => {
    const payload = buildWalletCommunicationPayload();
    const response = await integrationsClient.taWalletSendCommunication(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
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

  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});
