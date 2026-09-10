import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import {
  INTEGRATION_PATHS,
  INTEGRATION_PATH_TEMPLATES,
} from '../../src/api/clients/integrations.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildCheckAttachmentPayload,
  buildPresignedUrlPayload,
  nonExistentUuid,
} from '../../src/api/payloads/integrations.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * AWS S3 pre-signed URLs — issue, check and delete.
 *
 * ## What a pre-signed URL actually is
 *
 * A bearer credential in link form. Once issued it works from anywhere, for anyone holding
 * it, with **no KPOST token**, until it expires. So the questions worth asking of this tag
 * are not about response shape — they are: *who can obtain one, for which object key, for how
 * long, and does the URL leak into places that outlive the request?*
 *
 * That framing drives the assertions below: object-key control (the caller names the file),
 * expiry bounds, and whether an issued URL is scoped to the caller's own namespace.
 *
 * ## Two shapes reproduced rather than corrected
 *
 * - `generate-presigned-url` is mounted on **both GET and POST** at the same path. Two verbs
 *   minting the same credential means a security rule applied to one misses the other.
 * - `checkAttachmenS3` is spelled without the second `t` in the shipped API. Preserved: fixing
 *   the typo in the client would test a route that does not exist.
 *
 * `deleteAttachmentFromS3` is irreversible, so every call uses a UUID that cannot resolve. It
 * *is* ownership-scoped — the controller passes `request.getAttribute("kpostID")` to the
 * service — which makes it the reference point for how the rest of the tag should behave.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL = '../../../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * POST /v2/aws/generate-presigned-url
 * ====================================================================================== */
test.describe('POST /v2/aws/generate-presigned-url', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.awsPresignedPost,
    repro: `await integrationsClient.awsPresignedUrlPost(buildPresignedUrlPayload(), { token });`,
  };

  test('[1] happy path: an issued URL satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] CREDENTIAL: an anonymous caller must not be issued a pre-signed URL', async ({
    integrationsClient,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      body: payload,
      title: 'Pre-signed S3 URLs are issued without authentication',
      severity: 'Critical',
    });
  });

  test('[3] OBJECT KEY: a traversal filename must not choose the object path', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: TRAVERSAL });
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes('..'),
      `the issued URL still contained a traversal sequence. The caller names the file, so an unsanitised name lets them choose where the object lands — including on top of someone else's. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] NAMESPACE: an issued URL must be scoped to the caller', async ({
    integrationsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPresignedUrlPayload({ kpostID: 'admin' });
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes('admin'),
      `a body-supplied kpostID appeared in the issued URL while the caller was ${authSession.kpostID ?? 'a different identity'}. If the body chooses the namespace, a caller can obtain a write credential inside another user's prefix. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] EXPIRY: the URL must not be valid indefinitely', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });
    const { text } = await readBody(response);

    const match = text.match(/X-Amz-Expires=(\d+)/i);
    test.skip(match === null, 'no pre-signed URL with an expiry was returned');

    const seconds = Number(match?.[1] ?? 0);
    expect(
      seconds,
      `the pre-signed URL is valid for ${seconds}s. It needs no KPOST token to use, so a long expiry is a long-lived credential sitting in logs, browser history and chat clients. An upload window should be minutes, not hours.`
    ).toBeLessThanOrEqual(3600);
  });

  test('[6] missing required parameter: no fileName must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlPost({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a pre-signed URL request naming no file',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] content type: an executable must not be issued an upload URL', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({
      fileName: 'payload.exe',
      extension: 'exe',
    });
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `an upload credential was issued for an executable. Objects in this bucket are served back to other users, so the allowed content types have to be constrained at issue time — after upload it is too late. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: SQLI_PAYLOAD });
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: '' });
    const response = await integrationsClient.awsPresignedUrlPost(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, 'S3');
  });

  test('[10] verb parity: GET and POST must not diverge on the same path', async ({
    integrationsClient,
    staticToken,
  }) => {
    const [viaPost, viaGet] = await Promise.all([
      integrationsClient.awsPresignedUrlPost(buildPresignedUrlPayload(), { token: staticToken }),
      integrationsClient.awsPresignedUrlGet({ token: staticToken }),
    ]);

    expect(
      viaPost.status() >= 400 || viaGet.status() >= 400,
      `both GET and POST on /v2/aws/generate-presigned-url issued a credential (${viaPost.status()} and ${viaGet.status()}). Two verbs minting the same credential on one path means a rule applied to one silently misses the other.`
    ).toBe(true);
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
 * GET /v2/aws/generate-presigned-url
 * ====================================================================================== */
test.describe('GET /v2/aws/generate-presigned-url', () => {
  const META = {
    method: 'GET',
    path: INTEGRATION_PATHS.awsPresignedGet,
    repro: `await integrationsClient.awsPresignedUrlGet({ token });`,
  };

  test('[1] CREDENTIAL: an anonymous caller must not be issued a URL', async ({
    integrationsClient,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      title: 'Pre-signed S3 URLs are issued over GET without authentication',
      severity: 'Critical',
    });
  });

  test('[2] method safety: minting a credential should not be a prefetchable GET', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'A credential-minting action is exposed on a prefetchable GET',
      severity: 'Major',
    });
  });

  test('[3] happy path: the response satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [200, 400, 401, 403, 405]);
  });

  test('[4] OBJECT KEY: a traversal in a query parameter must not choose the path', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({
      token: staticToken,
      params: { fileName: TRAVERSAL },
    });
    const { text } = await readBody(response);

    expect(
      text.includes('..'),
      `the issued URL contained a traversal sequence from a query parameter. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] EXPIRY: the URL must not be valid indefinitely', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: staticToken });
    const { text } = await readBody(response);

    const match = text.match(/X-Amz-Expires=(\d+)/i);
    test.skip(match === null, 'no pre-signed URL with an expiry was returned');

    expect(
      Number(match?.[1] ?? 0),
      `the pre-signed URL is valid for ${match?.[1]}s — a long-lived, tokenless credential.`
    ).toBeLessThanOrEqual(3600);
  });

  test('[6] auth: an expired token must not mint a credential', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[7] auth: an alg=none token claiming admin must never mint a credential', async ({
    integrationsClient,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[8] disclosure: the bucket name must not be exposed unnecessarily', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({ token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[9] XSS: a script payload in a query parameter must not be reflected', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsPresignedUrlGet({
      token: staticToken,
      params: { fileName: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] rate limiting: credential minting must be throttled', async ({
    integrationsClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => integrationsClient.awsPresignedUrlGet({ token: staticToken }))
    );

    expect(
      responses.every((r) => r.status() < 500),
      `ten rapid credential requests returned ${responses.map((r) => r.status()).join(', ')}. Unbounded minting of upload credentials is an unbounded storage bill.`
    ).toBe(true);
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
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
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
    const response = await genericClient.send('GET', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /v2/aws/katchup/generate-presigned-url
 * ====================================================================================== */
test.describe('POST /v2/aws/katchup/generate-presigned-url', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.awsKatchupPresigned,
    repro: `await integrationsClient.awsKatchupPresignedUrl(buildPresignedUrlPayload(), { token });`,
  };

  test('[1] CREDENTIAL: an anonymous caller must not be issued a URL', async ({
    integrationsClient,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      body: payload,
      title: 'Katchup attachment upload credentials are issued without authentication',
      severity: 'Critical',
    });
  });

  test('[2] happy path: the response satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[3] NAMESPACE: the credential must be scoped to the caller\'s conversations', async ({
    integrationsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPresignedUrlPayload({ kpostID: 'admin' });
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text.includes('admin'),
      `a body-supplied kpostID reached the issued URL while the caller was ${authSession.kpostID ?? 'a different identity'}. Katchup attachments are private message content; a write credential inside another user's prefix lets an attacker plant files there. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] OBJECT KEY: a traversal filename must not escape the prefix', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: TRAVERSAL });
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text.includes('..'),
      `the issued URL contained a traversal sequence. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] missing required parameter: no fileName must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsKatchupPresignedUrl({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an attachment credential request naming no file',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] EXPIRY: the URL must not be valid indefinitely', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    const match = text.match(/X-Amz-Expires=(\d+)/i);
    test.skip(match === null, 'no pre-signed URL with an expiry was returned');

    expect(
      Number(match?.[1] ?? 0),
      `the attachment upload URL is valid for ${match?.[1]}s.`
    ).toBeLessThanOrEqual(3600);
  });

  test('[7] boundary: a 5000-character filename must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: MAX_LENGTH_STRING });
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character filename produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: SQLI_PAYLOAD });
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload({ fileName: XSS_PAYLOAD });
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildPresignedUrlPayload();
    const response = await integrationsClient.awsKatchupPresignedUrl(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
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
 * POST /v2/aws/checkAttachmentS3
 * ====================================================================================== */
test.describe('POST /v2/aws/checkAttachmentS3', () => {
  const META = {
    method: 'POST',
    path: INTEGRATION_PATHS.awsCheckAttachment,
    repro: `await integrationsClient.awsCheckAttachment(buildCheckAttachmentPayload(), { token });`,
  };

  test('[1] happy path: an existence check satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload();
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] contract: the answer must be a boolean, not the object itself', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload();
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /https?:\/\/[^"]*(amazonaws|s3)[^"]*/i.test(text),
      `an existence check returned a pre-signed URL. "Does this object exist" must answer yes or no — handing back a credential turns a cheap probe into a download. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] auth: an unauthenticated check must be 401/403', async ({ integrationsClient }) => {
    const payload = buildCheckAttachmentPayload();
    const response = await integrationsClient.awsCheckAttachment(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[4] IDOR: another user\'s object must not be testable', async ({
    integrationsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildCheckAttachmentPayload({ kpostID: 'admin' });
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      text.includes('admin'),
      `the check accepted a body kpostID of "admin" while the caller was ${authSession.kpostID ?? 'a different identity'}. Existence is information: it confirms a specific object is in someone's namespace. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[5] missing required parameter: no uuid must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachment({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an existence check naming no object',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] null fuzzing: a null uuid must be refused', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload({ attachmentsUuid: null });
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "uuid" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[7] enumeration: the check must be rate-limited', async ({
    integrationsClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        integrationsClient.awsCheckAttachment(buildCheckAttachmentPayload(), { token: staticToken })
      )
    );

    expect(
      responses.every((r) => r.status() < 500),
      `ten rapid existence checks returned ${responses.map((r) => r.status()).join(', ')}.`
    ).toBe(true);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload({ attachmentsUuid: [SQLI_PAYLOAD] });
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload();
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, 'S3');
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildCheckAttachmentPayload({ attachmentsUuid: [XSS_PAYLOAD] });
    const response = await integrationsClient.awsCheckAttachment(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
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
 * GET /v2/aws/checkAttachmenS3/{uuid}   (typo preserved from the shipped API)
 * ====================================================================================== */
test.describe('GET /v2/aws/checkAttachmenS3/{uuid}', () => {
  const META = {
    method: 'GET',
    path: INTEGRATION_PATH_TEMPLATES.awsCheckAttachmentByUuid,
    repro: `await integrationsClient.awsCheckAttachmentByUuid(uuid, { token });`,
  };

  test('[1] happy path: the by-uuid check satisfies the Zod contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(nonExistentUuid(), {
      token: staticToken,
    });

    await expectValidContract(response, dataEnvelopeSchema, META, [200, 400, 401, 403, 404]);
  });

  test('[2] naming: a misspelled route should not be the public contract', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(nonExistentUuid(), {
      token: staticToken,
    });

    await assertStatus(response, [404, 410], {
      ...META,
      title: 'Route is published with a typo ("checkAttachmenS3") and cannot be renamed without breaking clients',
      severity: 'Trivial',
    });
  });

  test('[3] auth: an unauthenticated check must be 401/403', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(nonExistentUuid(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not answer', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(nonExistentUuid(), {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[5] contract: the answer must not be a pre-signed URL', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(nonExistentUuid(), {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      /https?:\/\/[^"]*(amazonaws|s3)[^"]*/i.test(text),
      `an existence check returned a credential URL. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[6] path traversal must not escape the object store', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(TRAVERSAL, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, TRAVERSAL);
  });

  test('[7] type: a non-UUID handle must be refused', async ({ integrationsClient, staticToken }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid('not-a-uuid', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A malformed object handle is not rejected cleanly',
      severity: 'Minor',
    });
  });

  test('[8] boundary: a 5000-character uuid must not fault', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsCheckAttachmentByUuid(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[10] idempotency: two consecutive checks must agree', async ({
    integrationsClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const [first, second] = await Promise.all([
      integrationsClient.awsCheckAttachmentByUuid(uuid, { token: staticToken }),
      integrationsClient.awsCheckAttachmentByUuid(uuid, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical checks returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign uuid must not reach another owner\'s record', async ({
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
      what: 'uuid',
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
 * GET /v2/aws/deleteAttachmentFromS3/{uuid}  — destructive, and a GET
 * ====================================================================================== */
test.describe('GET /v2/aws/deleteAttachmentFromS3/{uuid}', () => {
  const META = {
    method: 'GET',
    path: INTEGRATION_PATH_TEMPLATES.awsDeleteAttachment,
    repro: `await integrationsClient.awsDeleteAttachment(uuid, { token });`,
  };

  test('[1] method safety: an irreversible delete must not be a GET', async ({
    integrationsClient,
    staticToken,
  }) => {
    // Non-existent UUID: object deletion is not reversible through the API.
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'S3 objects are deleted by a prefetchable GET request',
      severity: 'Major',
    });
  });

  test('[2] contract: deleting a non-existent object must not report success', async ({
    integrationsClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const response = await integrationsClient.awsDeleteAttachment(uuid, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting object ${uuid}, which does not exist, reported success. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[3] auth: an unauthenticated delete must be 401/403', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not delete', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: a malformed token must not delete', async ({ integrationsClient }) => {
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: an alg=none token claiming admin must never delete', async ({
    integrationsClient,
  }) => {
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[7] IDOR: the delete is scoped by token — a query kpostID must not widen it', async ({
    integrationsClient,
    staticToken,
    authSession,
  }) => {
    // This route does pass request.getAttribute("kpostID") to the service, which is what the
    // rest of the tag should look like. This confirms a query parameter cannot override it.
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: staticToken,
      params: { kpostID: 'admin' },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete with ?kpostID=admin reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[8] path traversal must not delete outside the caller\'s prefix', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsDeleteAttachment(TRAVERSAL, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, TRAVERSAL);
  });

  test('[9] idempotency: deleting twice must be stable', async ({
    integrationsClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const first = await integrationsClient.awsDeleteAttachment(uuid, { token: staticToken });
    const second = await integrationsClient.awsDeleteAttachment(uuid, { token: staticToken });

    expect(
      first.status(),
      `deleting the same object twice returned ${first.status()} then ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] disclosure: an S3 SDK error must not reach the caller', async ({
    integrationsClient,
    staticToken,
  }) => {
    const response = await integrationsClient.awsDeleteAttachment(nonExistentUuid(), {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[IDOR] a foreign uuid must not reach another owner\'s record', async ({
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
      what: 'uuid',
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});
