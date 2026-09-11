import { test, expect, EXPIRED_TOKEN, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { CRYPTO_PATHS } from '../../src/api/clients/crypto.client';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertStatusCodeParity,
  assertPublicRouteReachable,
  readBody,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { SQLI, XSS, UNICODE_STRINGS } from '../../src/utils/fuzzData';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

const META = {
  method: 'GET',
  path: CRYPTO_PATHS.publicKey,
  repro: `await cryptoClient.getPublicKey();`,
};

/**
 * GET /crypto/public-key — the RSA key clients use to encrypt request payloads.
 * Declared `security: []` in swagger.json, so it must serve without a token.
 */
test.describe('Crypto - GET /crypto/public-key @audit', () => {
  test('1. baseline: returns 200 with a usable public key', async ({ cryptoClient }) => {
    const response = await cryptoClient.getPublicKey();
    await assertStatus(response, [200], META);

    const { text } = await readBody(response);
    expect(text.length, 'public key body must not be empty').toBeGreaterThan(0);
  });

  test('2. contract: key material is valid base64 of a plausible RSA key length', async ({
    cryptoClient,
  }) => {
    const response = await cryptoClient.getPublicKey();
    await assertStatus(response, [200], META);

    const { text } = await readBody(response);
    const key = text.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

    expect(key, 'key must be base64').toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // A 2048-bit SPKI RSA key is ~294 bytes -> ~392 base64 chars. Anything far smaller
    // would indicate a truncated or downgraded key.
    expect(
      Buffer.from(key, 'base64').length,
      'key shorter than 128 bytes suggests a weak or truncated key'
    ).toBeGreaterThanOrEqual(128);
  });

  test('3. public endpoint: must not be gated behind a token', async ({ cryptoClient }) => {
    // Clients call this to encrypt their very first request, before any login — a token gate
    // here breaks encryption bootstrapping for every unauthenticated client.
    const response = await cryptoClient.getPublicKey({ token: null });
    await assertPublicRouteReachable(response, {
      ...META,
      repro: `await cryptoClient.getPublicKey({ token: null });`,
    });
  });

  test('4. tolerates a malformed bearer token (documented as public)', async ({ cryptoClient }) => {
    const response = await cryptoClient.getPublicKey({ token: MALFORMED_TOKEN });
    await assertStatus(response, [200], {
      ...META,
      repro: `await cryptoClient.getPublicKey({ token: MALFORMED_TOKEN });`,
    });
  });

  test('5. tolerates an expired bearer token (documented as public)', async ({ cryptoClient }) => {
    const response = await cryptoClient.getPublicKey({ token: EXPIRED_TOKEN });
    await assertStatus(response, [200], {
      ...META,
      repro: `await cryptoClient.getPublicKey({ token: EXPIRED_TOKEN });`,
    });
  });

  test('6. idempotency: repeated reads return a stable key', async ({ cryptoClient }) => {
    const [first, second, third] = await Promise.all([
      cryptoClient.getPublicKey(),
      cryptoClient.getPublicKey(),
      cryptoClient.getPublicKey(),
    ]);

    const bodies = await Promise.all([readBody(first), readBody(second), readBody(third)]);
    expect(
      new Set(bodies.map((b) => b.text.trim())).size,
      'concurrent reads returned different keys — payload encryption would break intermittently'
    ).toBe(1);
  });

  test('7. rejects an unsupported method (POST) rather than mutating key state', async ({
    cryptoClient,
  }) => {
    const response = await cryptoClient.postPublicKey({ key: 'attacker-supplied' });
    await assertStatus(response, [401, 403, 404, 405], {
      ...META,
      method: 'POST',
      repro: `await cryptoClient.postPublicKey({ key: 'attacker-supplied' });`,
      title: 'POST accepted on a read-only key endpoint',
      severity: 'Critical',
    });
  });

  test('8. ignores unexpected query parameters instead of erroring', async ({ cryptoClient }) => {
    const response = await cryptoClient.getPublicKey({
      params: { keySize: 512, format: 'raw', debug: true },
    });
    await assertStatus(response, [200], {
      ...META,
      repro: `await cryptoClient.getPublicKey({ params: { keySize: 512, format: 'raw', debug: true } });`,
      title: 'Unexpected query params changed or broke public-key retrieval',
    });
  });

  test('9. does not honour a key-size downgrade via query parameter', async ({ cryptoClient }) => {
    const baseline = await readBody(await cryptoClient.getPublicKey());
    const downgraded = await readBody(
      await cryptoClient.getPublicKey({ params: { keySize: 256 } })
    );

    expect(
      downgraded.text.trim(),
      'query parameter altered the served key — a client could be pushed onto weaker crypto'
    ).toBe(baseline.text.trim());
  });

  for (const payload of SQLI.slice(0, 2)) {
    test(`10. SQL injection in query params is not reflected as a DB error :: ${payload.slice(0, 20)}`, async ({
      cryptoClient,
    }) => {
      const response = await cryptoClient.getPublicKey({ params: { id: payload } });
      const meta = {
        ...META,
        repro: `await cryptoClient.getPublicKey({ params: { id: ${JSON.stringify(payload)} } });`,
      };
      await assertNoInternalLeak(response, meta, payload);
    });
  }

  for (const payload of XSS.slice(0, 2)) {
    test(`11. XSS payload in query params is not reflected :: ${payload.slice(0, 20)}`, async ({
      cryptoClient,
    }) => {
      const response = await cryptoClient.getPublicKey({ params: { cb: payload } });
      const meta = {
        ...META,
        repro: `await cryptoClient.getPublicKey({ params: { cb: ${JSON.stringify(payload)} } });`,
      };
      await assertNoReflectedScript(response, meta, payload);
    });
  }

  test('12. handles unicode/oversized query values without a 5xx', async ({ cryptoClient }) => {
    for (const value of [...UNICODE_STRINGS.slice(0, 3), 'a'.repeat(2000)]) {
      const response = await cryptoClient.getPublicKey({ params: { tag: value } });
      expect(
        response.status(),
        `unicode/oversized query value caused a server error: ${value.slice(0, 30)}`
      ).toBeLessThan(500);
    }
  });

  test('13. envelope parity: HTTP status matches any embedded statusCode', async ({
    cryptoClient,
  }) => {
    const response = await cryptoClient.getPublicKey();
    await assertStatusCodeParity(response, META);
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
    const response = await genericClient.send('GET', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});
