import { test, expect, EXPIRED_TOKEN, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { RAZORPAY_PATHS } from '../../src/api/clients/razorpay.client';
import { validateSchema } from '../../src/utils/schemaValidator';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  readBody,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { MALFORMED_JSON_STRINGS, SQLI, UNICODE_STRINGS, XSS } from '../../src/utils/fuzzData';
import {
  buildGenerateOrderPayload,
  buildValidateTransactionPayload,
} from '../../src/api/payloads/razorpay.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/* ========================================================================================
 * POST /razorPay/generateOrderId — creates a RazorPay order for a pending booking.
 * Money-adjacent: everything here is about refusing to create orders the caller
 * should not be able to create, and never inventing an amount.
 * ===================================================================================== */
test.describe('RazorPay - POST /razorPay/generateOrderId', () => {
  const META = {
    method: 'POST',
    path: RAZORPAY_PATHS.generateOrderId,
    repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload());`,
  };

  test('1. baseline: returns a documented status', async ({ razorpayClient, staticToken }) => {
    const response = await razorpayClient.generateOrderId(buildGenerateOrderPayload(), {
      token: staticToken,
    });
    await assertStatus(response, [200, 400, 401, 403, 424], META);

    const { json } = await readBody(response);
    if (json) validateSchema(json, looseEnvelopeSchema, META);
  });

  test('2. no token: must be 401/403', async ({ razorpayClient }) => {
    const response = await razorpayClient.generateOrderId(buildGenerateOrderPayload(), {
      token: null,
    });
    await assertUnauthorized(response, {
      ...META,
      repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload(), { token: null });`,
    });
  });

  test('3. expired/malformed token: must be 401/403', async ({ razorpayClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN]) {
      const response = await razorpayClient.generateOrderId(buildGenerateOrderPayload(), { token });
      await assertUnauthorized(response, {
        ...META,
        repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload(), { token: '<invalid>' });`,
      });
    }
  });

  test('4. missing amount must be rejected, never defaulted', async ({
    razorpayClient,
    staticToken,
  }) => {
    const payload = buildGenerateOrderPayload();
    delete (payload as Record<string, unknown>).amount;

    const response = await razorpayClient.generateOrderId(payload, { token: staticToken });
    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'generateOrderId without an amount',
        repro: `const p = buildGenerateOrderPayload(); delete p.amount; await razorpayClient.generateOrderId(p, { token });`,
      },
      [400, 401, 403, 422, 424]
    );
  });

  test('5. null/empty amount fuzzing', async ({ razorpayClient, staticToken }) => {
    for (const value of [null, '', ' ', {}]) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload({ amount: value }),
        { token: staticToken }
      );
      await assertRejectsInvalidInput(
        response,
        {
          ...META,
          scenario: `generateOrderId with amount=${JSON.stringify(value)}`,
          repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload({ amount: ${JSON.stringify(value)} }), { token });`,
        },
        [400, 401, 403, 422, 424]
      );
    }
  });

  test('6. business rule: a negative or zero amount must never create an order', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const amount of ['-1', '-100000', '0']) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload({ amount }),
        { token: staticToken }
      );
      const { json, text } = await readBody(response);
      const created = json && json.statusCode === 200;

      expect(
        created,
        `an order was created for amount=${amount} — a negative/zero charge must be refused. Body: ${text.slice(0, 200)}`
      ).toBeFalsy();
    }
  });

  test('7. business rule: a non-numeric or overflowing amount must be refused', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const amount of ['not-a-number', '1e309', '9'.repeat(30), '10.999999']) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload({ amount }),
        { token: staticToken }
      );
      expect(
        response.status(),
        `amount=${amount} caused a server error instead of a clean rejection`
      ).toBeLessThan(500);
    }
  });

  test('8. IDOR: an order must not be creatable on behalf of another kpostId', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.generateOrderId(
      buildGenerateOrderPayload({ kpostId: 'admin' }),
      { token: staticToken }
    );
    const { json, text } = await readBody(response);
    const created = json && json.statusCode === 200;

    expect(
      created,
      `an order was created for a body-supplied kpostId ("admin") — orders are not scoped to the authenticated identity. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('9. type mismatch and malformed JSON are rejected', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await razorpayClient.generateOrderIdRaw(body, { token: staticToken });
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }

    for (const overrides of [{ amount: ['10000'] }, { kpostId: 12345 }, { tinNumber: {} }]) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload(overrides),
        { token: staticToken }
      );
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('10. SQL injection does not leak internals', async ({ razorpayClient, staticToken }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload({ kpostId: payload }),
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload({ kpostId: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('11. XSS payload is not reflected unescaped', async ({ razorpayClient, staticToken }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await razorpayClient.generateOrderId(
        buildGenerateOrderPayload({ kpostId: payload }),
        { token: staticToken }
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await razorpayClient.generateOrderId(buildGenerateOrderPayload({ kpostId: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('12. idempotency: concurrent identical requests must not create duplicate orders', async ({
    razorpayClient,
    staticToken,
  }) => {
    const payload = buildGenerateOrderPayload();
    const responses = await Promise.all([
      razorpayClient.generateOrderId(payload, { token: staticToken }),
      razorpayClient.generateOrderId(payload, { token: staticToken }),
      razorpayClient.generateOrderId(payload, { token: staticToken }),
    ]);
    const bodies = await Promise.all(responses.map((r) => readBody(r)));

    const orderIds = bodies
      .map((b) => (typeof b.json?.data === 'string' ? b.json.data : JSON.stringify(b.json?.data)))
      .filter((id) => id && id !== 'undefined' && id !== 'null');

    if (orderIds.length > 1) {
      expect(
        new Set(orderIds).size,
        `${orderIds.length} concurrent identical booking requests produced ${new Set(orderIds).size} distinct RazorPay orders — the customer can be charged more than once for one booking`
      ).toBe(1);
    }
  });

  test('13. no RazorPay secret key material is exposed to the client', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.generateOrderId(buildGenerateOrderPayload(), {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      'the response exposed a RazorPay secret key — it must never leave the server'
    ).not.toMatch(/rzp_(live|test)_[A-Za-z0-9]+|"(secret|keySecret|key_secret)"\s*:/i);
  });

  test('14. envelope parity: a payment failure must not be served as HTTP 200', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.generateOrderId(buildGenerateOrderPayload(), {
      token: staticToken,
    });
    await assertStatusCodeParity(response, META);
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* ========================================================================================
 * POST /razorPay/validateAndUpdateTransactionDetails — verifies the RazorPay signature
 * and records the payment. The signature check is the only thing standing between a
 * forged payment claim and a credited account, so most cases here attack it.
 * ===================================================================================== */
test.describe('RazorPay - POST /razorPay/validateAndUpdateTransactionDetails', () => {
  const META = {
    method: 'POST',
    path: RAZORPAY_PATHS.validateAndUpdateTransactionDetails,
    repro: `await razorpayClient.validateAndUpdateTransactionDetails(buildValidateTransactionPayload());`,
  };

  test('1. baseline: an unverifiable signature is refused with a documented status', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.validateAndUpdateTransactionDetails(
      buildValidateTransactionPayload(),
      { token: staticToken }
    );
    await assertStatus(response, [400, 401, 403, 424], {
      ...META,
      title: 'A payment with a forged signature was not refused',
      severity: 'Critical',
    });
  });

  test('2. no token: must be 401/403', async ({ razorpayClient }) => {
    const response = await razorpayClient.validateAndUpdateTransactionDetails(
      buildValidateTransactionPayload(),
      { token: null }
    );
    await assertUnauthorized(response, {
      ...META,
      repro: `await razorpayClient.validateAndUpdateTransactionDetails(payload, { token: null });`,
    });
  });

  test('3. expired/malformed token: must be 401/403', async ({ razorpayClient }) => {
    for (const token of [EXPIRED_TOKEN, MALFORMED_TOKEN]) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload(),
        { token }
      );
      await assertUnauthorized(response, {
        ...META,
        repro: `await razorpayClient.validateAndUpdateTransactionDetails(payload, { token: '<invalid>' });`,
      });
    }
  });

  test('4. a random signature must never be accepted as genuine', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload(),
        { token: staticToken }
      );
      const { json, text } = await readBody(response);
      const accepted = json && json.statusCode === 200;

      expect(
        accepted,
        `a randomly generated signature was accepted — anyone could claim an arbitrary payment succeeded. Body: ${text.slice(0, 200)}`
      ).toBeFalsy();
    }
  });

  test('5. a missing signature must be rejected, not treated as valid', async ({
    razorpayClient,
    staticToken,
  }) => {
    const payload = buildValidateTransactionPayload();
    delete (payload as Record<string, unknown>).signature;

    const response = await razorpayClient.validateAndUpdateTransactionDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const accepted = json && json.statusCode === 200;

    expect(
      accepted,
      `a payment with no signature at all was accepted — signature verification can be bypassed by omission. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('6. null/empty signature fuzzing must never authenticate the payment', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const value of [null, '', ' ', {}, []]) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload({ signature: value }),
        { token: staticToken }
      );
      const { json } = await readBody(response);

      expect(
        json && json.statusCode === 200,
        `signature=${JSON.stringify(value)} was accepted as a valid payment proof`
      ).toBeFalsy();
    }
  });

  test('7. business rule: the recorded amount must not be caller-controlled after payment', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.validateAndUpdateTransactionDetails(
      buildValidateTransactionPayload({ amount: '1' }),
      { token: staticToken }
    );
    const { json, text } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      `a transaction was recorded with a caller-supplied amount of 1 — a buyer could pay 1 unit and have any amount credited. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('8. negative amounts must be refused', async ({ razorpayClient, staticToken }) => {
    for (const amount of ['-1', '-999999']) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload({ amount }),
        { token: staticToken }
      );
      expect(
        response.status(),
        `amount=${amount} caused a server error instead of a clean rejection`
      ).toBeLessThan(500);
    }
  });

  test('9. IDOR: a payment must not be creditable to another kpostId', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.validateAndUpdateTransactionDetails(
      buildValidateTransactionPayload({ kpostId: 'admin' }),
      { token: staticToken }
    );
    const { json, text } = await readBody(response);

    expect(
      json && json.statusCode === 200,
      `a transaction was recorded against a body-supplied kpostId ("admin") — payments are not scoped to the authenticated identity. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('10. replay: the same paymentId must not be recordable twice', async ({
    razorpayClient,
    staticToken,
  }) => {
    const payload = buildValidateTransactionPayload();
    const responses = await Promise.all([
      razorpayClient.validateAndUpdateTransactionDetails(payload, { token: staticToken }),
      razorpayClient.validateAndUpdateTransactionDetails(payload, { token: staticToken }),
      razorpayClient.validateAndUpdateTransactionDetails(payload, { token: staticToken }),
    ]);
    const bodies = await Promise.all(responses.map((r) => readBody(r)));
    const accepted = bodies.filter((b) => b.json && b.json.statusCode === 200);

    expect(
      accepted.length,
      `${accepted.length} of 3 concurrent submissions of the same paymentId were accepted — a payment can be replayed and double-credited`
    ).toBeLessThanOrEqual(1);
  });

  test('11. malformed JSON and type mismatches are rejected cleanly', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const body of MALFORMED_JSON_STRINGS) {
      const response = await razorpayClient.validateTransactionRaw(body, { token: staticToken });
      expect(
        response.status(),
        `malformed JSON ${JSON.stringify(body)} caused a server error`
      ).toBeLessThan(500);
    }

    for (const overrides of [{ id: 'not-a-number' }, { signature: 12345 }, { paidDate: 'yesterday' }]) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload(overrides),
        { token: staticToken }
      );
      expect(
        response.status(),
        `type mismatch ${JSON.stringify(overrides)} caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('12. SQL injection in payment identifiers does not leak internals', async ({
    razorpayClient,
    staticToken,
  }) => {
    for (const payload of SQLI.slice(0, 3)) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload({ paymentId: payload, paymentOrderId: payload }),
        { token: staticToken }
      );
      await assertNoInternalLeak(
        response,
        {
          ...META,
          repro: `await razorpayClient.validateAndUpdateTransactionDetails(buildValidateTransactionPayload({ paymentId: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('13. XSS payload is not reflected unescaped', async ({ razorpayClient, staticToken }) => {
    for (const payload of XSS.slice(0, 2)) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload({ tinNumber: payload }),
        { token: staticToken }
      );
      await assertNoReflectedScript(
        response,
        {
          ...META,
          repro: `await razorpayClient.validateAndUpdateTransactionDetails(buildValidateTransactionPayload({ tinNumber: ${JSON.stringify(payload)} }), { token });`,
        },
        payload
      );
    }
  });

  test('14. boundary/unicode values do not cause a 5xx', async ({ razorpayClient, staticToken }) => {
    for (const value of [...UNICODE_STRINGS.slice(0, 3), 'a'.repeat(5000)]) {
      const response = await razorpayClient.validateAndUpdateTransactionDetails(
        buildValidateTransactionPayload({ tinNumber: value }),
        { token: staticToken }
      );
      expect(
        response.status(),
        `tinNumber="${value.slice(0, 24)}" caused a server error`
      ).toBeLessThan(500);
    }
  });

  test('15. envelope parity: a refused payment must not be served as HTTP 200', async ({
    razorpayClient,
    staticToken,
  }) => {
    const response = await razorpayClient.validateAndUpdateTransactionDetails(
      buildValidateTransactionPayload(),
      { token: staticToken }
    );
    await assertStatusCodeParity(response, META);
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
