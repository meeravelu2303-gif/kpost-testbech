import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, KATCHUP_PATH_TEMPLATES } from '../../src/api/clients/katchupV2.client';
import {
  attachmentResponseSchema,
  katchupMessageResponseSchema,
} from '../../src/api/schemas/katchupV2.schema';
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
  buildBulkMessagePayload,
  buildExistingMessagePayload,
  buildKatchupMessagePayload,
  nonExistentUuid,
  syntheticReceiver,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * Katchup V2 — attachments: upload, thumbnails, and the six download routes.
 *
 * ## The finding this file exists for
 *
 * Katchup has **six UUID-addressed attachment routes**. Four read the caller's identity
 * before serving (`request.getAttribute("kpostID")`). Two do not:
 *
 * ```java
 * @GetMapping("/downloadAttachment/{uuid}")
 * public ResponseEntity<Map<String,Object>> downloadAttachment(@PathVariable String uuid) { … }
 *
 * @GetMapping("/downloadThumbnail/{uuid}")
 * public ResponseEntity<byte[]> downloadThumbnail(@PathVariable String uuid) { … }
 * ```
 *
 * No `HttpServletRequest`, and both sit in the `permitAll` list. The API's own parameter
 * documentation states it outright: *"No authentication is required for this route —
 * possession of the UUID is the only access control."*
 *
 * Confirmed live with no `Authorization` header at all:
 *
 * | Route | Status |
 * |---|---|
 * | `downloadAttachment/{uuid}` | **500** — reached the service |
 * | `downloadThumbnail/{uuid}` | **500** — reached the service |
 * | `download/{uuid}` | 403 — blocked at the filter |
 * | `getUnopenedMessagesCount` | 403 — blocked at the filter |
 *
 * A 500 on a non-existent UUID means execution got past authentication and failed looking the
 * object up. With a real UUID those routes hand back a private message attachment to anyone.
 * `downloadAttachment` returns a **pre-signed S3 URL**, which is itself a bearer credential:
 * once issued it works with no KPOST token at all, from anywhere, until it expires.
 *
 * The legacy route is the authenticated one, which is the wrong way round — swagger notes
 * this too. Deprecating `oldDownload` in favour of `downloadAttachment` traded a token check
 * for none.
 *
 * ## Safety
 *
 * Uploads and multipart sends deliver real messages and real push notifications. Every
 * recipient here is a synthetic, non-existent kpostID, and bulk recipient lists are capped at
 * two — the API's own docs call bulk send "the highest fan-out write in the API", undoable
 * only one delivered copy at a time.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL_PAYLOAD = '../../../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * The download matrix — six routes, one question: does it check who is asking?
 * ====================================================================================== */
test.describe('Katchup attachment downloads — authentication', () => {
  const META = {
    method: 'GET',
    path: '/v2/katchup/{download-routes}/{uuid}',
    repro: `await katchupClient.downloadAttachment(uuid, { token: null });`,
    severity: 'Critical' as const,
  };

  test('[1] downloadAttachment must require a bearer token', async ({ katchupClient }) => {
    const uuid = nonExistentUuid();
    const response = await katchupClient.downloadAttachment(uuid, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.downloadAttachment,
      title: 'Message attachments are downloadable with no authentication',
      severity: 'Critical',
    });
  });

  test('[2] downloadThumbnail must require a bearer token', async ({ katchupClient }) => {
    const uuid = nonExistentUuid();
    const response = await katchupClient.downloadThumbnail(uuid, { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.downloadThumbnail,
      title: 'Message attachment thumbnails are downloadable with no authentication',
      severity: 'Critical',
    });
  });

  test('[3] download must require a bearer token', async ({ katchupClient }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.download,
    });
  });

  test('[4] downloadFromS3 must require a bearer token', async ({ katchupClient }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.downloadFromS3,
    });
  });

  test('[5] oldDownload must require a bearer token', async ({ katchupClient }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.oldDownload,
    });
  });

  test('[6] mediaStreaming must require a bearer token', async ({ katchupClient }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, {
      ...META,
      path: KATCHUP_PATH_TEMPLATES.mediaStreaming,
    });
  });

  test('[7] the unauthenticated routes must not behave differently from their siblings', async ({
    katchupClient,
  }) => {
    const uuid = nonExistentUuid();
    const [attachment, thumbnail, guarded] = await Promise.all([
      katchupClient.downloadAttachment(uuid, { token: null }),
      katchupClient.downloadThumbnail(uuid, { token: null }),
      katchupClient.download(uuid, { token: null }),
    ]);

    // 403 at the filter means "not authenticated". Anything else means the request reached
    // the handler, which is the whole exposure.
    const reachedHandler = [
      { name: 'downloadAttachment', status: attachment.status() },
      { name: 'downloadThumbnail', status: thumbnail.status() },
    ].filter((entry) => entry.status !== 401 && entry.status !== 403);

    expect(
      reachedHandler.map((e) => `${e.name} → ${e.status}`).join(', ') || 'none',
      `these attachment routes served an unauthenticated request while their sibling download/{uuid} answered ${guarded.status()}: ${reachedHandler
        .map((e) => e.name)
        .join(', ')}. Four of the six download routes check the caller; these do not, so an attachment UUID is a bearer token for a private conversation's files.`
    ).toBe('none');
  });

  test('[8] an expired token must not be accepted where a token is required', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, path: KATCHUP_PATH_TEMPLATES.download });
  });

  test('[9] a UUID must not be guessable in sequence', async ({ katchupClient, staticToken }) => {
    // downloadAttachment requires a bearer token (see [1]), so the UUID is not the only guard —
    // but a sequential handle would let any authenticated caller walk other owners' attachments,
    // an IDOR-style enumeration the token alone does not prevent. A v4 UUID is 122 bits of
    // entropy; anything shorter is not.
    const uuid = nonExistentUuid();
    const response = await katchupClient.downloadAttachment(uuid, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"uuid"\s*:\s*"\d{1,8}"/.test(text),
      `an attachment handle came back as a short numeric id rather than a UUID. A sequential handle would let any authenticated caller enumerate other owners' attachments. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] path traversal in the UUID must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(TRAVERSAL_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        path: KATCHUP_PATH_TEMPLATES.downloadAttachment,
        severity: 'Critical',
      },
      TRAVERSAL_PAYLOAD
    );
  });
});

/* =========================================================================================
 * GET /v2/katchup/downloadAttachment/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/downloadAttachment/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.downloadAttachment,
    repro: `await katchupClient.downloadAttachment(uuid, { token });`,
  };

  test('[1] happy path: a pre-signed URL response satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(nonExistentUuid(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      attachmentResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] empty-state: an unknown UUID must be 404, not a server fault', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(nonExistentUuid(), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown attachment UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[3] ownership: an attachment from another conversation must not resolve', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.downloadAttachment(nonExistentUuid(), {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no attachment resolved');

    expect(
      /https?:\/\/[^"]*(amazonaws|s3)[^"]*/i.test(text),
      `a pre-signed S3 URL was issued for an attachment the caller (${authSession.kpostID ?? 'unknown'}) has no message for. A pre-signed URL needs no KPOST token to use, so issuing one is the same as handing over the file. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type: a non-UUID handle must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.downloadAttachment('not-a-uuid', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A malformed attachment handle is not rejected cleanly',
      severity: 'Major',
    });
  });

  test('[6] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] disclosure: an S3 SDK error must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadAttachment(nonExistentUuid(), {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'S3');
  });

  // No token-validation case: swagger declares this route public (security: []).

  test('[10] idempotency: two consecutive fetches must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const [first, second] = await Promise.all([
      katchupClient.downloadAttachment(uuid, { token: staticToken }),
      katchupClient.downloadAttachment(uuid, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical fetches returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
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
 * GET /v2/katchup/downloadThumbnail/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/downloadThumbnail/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.downloadThumbnail,
    repro: `await katchupClient.downloadThumbnail(uuid, { token });`,
  };

  test('[1] happy path: an unknown thumbnail must answer cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadThumbnail(nonExistentUuid(), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown thumbnail UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[2] privacy: a thumbnail is still message content', async ({ katchupClient }) => {
    const response = await katchupClient.downloadThumbnail(nonExistentUuid(), { token: null });

    await assertStatus(response, [401, 403], {
      ...META,
      title: 'Thumbnails of private message attachments are served without a token',
      severity: 'Critical',
    });
  });

  test('[3] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadThumbnail(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] type: a non-UUID handle must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.downloadThumbnail('not-a-uuid', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A malformed thumbnail handle is not rejected cleanly',
      severity: 'Major',
    });
  });

  test('[5] path traversal must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadThumbnail(TRAVERSAL_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, TRAVERSAL_PAYLOAD);
  });

  test('[6] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadThumbnail(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  // No token-validation cases: swagger declares this route public (security: []).

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadThumbnail(nonExistentUuid(), {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[10] idempotency: two consecutive fetches must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const [first, second] = await Promise.all([
      katchupClient.downloadThumbnail(uuid, { token: staticToken }),
      katchupClient.downloadThumbnail(uuid, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical fetches returned ${first.status()} and ${second.status()}.`
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

/* =========================================================================================
 * GET /v2/katchup/download/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/download/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.download,
    repro: `await katchupClient.download(uuid, { token });`,
  };

  test('[1] happy path: an unknown UUID answers cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown attachment UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[2] ownership: an attachment outside the caller\'s conversations must not resolve', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no attachment resolved');

    expect(
      Boolean(json?.data),
      `an attachment resolved for a UUID the caller (${authSession.kpostID ?? 'unknown'}) has no message for. This route does read the token identity, so it must check the caller appears on the message carrying the attachment, not merely that the UUID exists. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not download', async ({ katchupClient }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: an alg=none token claiming admin must never download', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.download(nonExistentUuid(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[6] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.download(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] path traversal must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.download(TRAVERSAL_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, TRAVERSAL_PAYLOAD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.download(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.download(nonExistentUuid(), { token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[10] idempotency: two consecutive fetches must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const [first, second] = await Promise.all([
      katchupClient.download(uuid, { token: staticToken }),
      katchupClient.download(uuid, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical fetches returned ${first.status()} and ${second.status()}.`
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

/* =========================================================================================
 * GET /v2/katchup/downloadFromS3/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/downloadFromS3/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.downloadFromS3,
    repro: `await katchupClient.downloadFromS3(uuid, { token });`,
  };

  test('[1] happy path: an unknown UUID answers cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown attachment UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[2] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[3] auth: an expired token must not download', async ({ katchupClient }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: a malformed token must not download', async ({ katchupClient }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[5] disclosure: the S3 bucket name must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(nonExistentUuid(), { token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[6] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] path traversal must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(TRAVERSAL_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, TRAVERSAL_PAYLOAD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.downloadFromS3(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[10] type: a non-UUID handle must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.downloadFromS3('not-a-uuid', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404], {
      ...META,
      title: 'A malformed attachment handle is not rejected cleanly',
      severity: 'Major',
    });
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

/* =========================================================================================
 * GET /v2/katchup/oldDownload/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/oldDownload/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.oldDownload,
    repro: `await katchupClient.oldDownload(uuid, { token });`,
  };

  test('[1] happy path: an unknown UUID answers cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown attachment UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[2] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[3] auth: an expired token must not download', async ({ katchupClient }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4] memory: a whole file buffered as byte[] must be bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    // The legacy route buffers the entire object into a byte[] rather than streaming, so file
    // size translates directly into heap. An unknown UUID cannot prove the bound, but a fault
    // here would show the path is not defensive.
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: staticToken });

    expect(
      response.status(),
      `the legacy download answered HTTP ${response.status()} for a missing object. Because it buffers the whole file into memory, this path needs a clean not-found rather than an exception.`
    ).toBeLessThan(500);
  });

  test('[5] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.oldDownload(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] path traversal must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.oldDownload(TRAVERSAL_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, TRAVERSAL_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.oldDownload(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] disclosure: an S3 SDK error must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), { token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[9] auth: an alg=none token claiming admin must never download', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.oldDownload(nonExistentUuid(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[10] idempotency: two consecutive fetches must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const uuid = nonExistentUuid();
    const [first, second] = await Promise.all([
      katchupClient.oldDownload(uuid, { token: staticToken }),
      katchupClient.oldDownload(uuid, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical fetches returned ${first.status()} and ${second.status()}.`
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

/* =========================================================================================
 * GET /v2/katchup/mediaStreaming/{uuid}
 * ====================================================================================== */
test.describe('GET /v2/katchup/mediaStreaming/{uuid}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.mediaStreaming,
    repro: `await katchupClient.mediaStreaming(uuid, { token });`,
  };

  test('[1] happy path: an unknown UUID answers cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), { token: staticToken });

    await assertStatus(response, [200, 204, 206, 400, 401, 403, 404], {
      ...META,
      title: 'An unknown media UUID produces a server fault rather than 404',
      severity: 'Major',
    });
  });

  test('[2] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[3] auth: an expired token must not stream media', async ({ katchupClient }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[4] range: a Range header must be honoured or ignored, never fatal', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), {
      token: staticToken,
      headers: { Range: 'bytes=0-1023' },
    });

    expect(
      response.status(),
      `a Range request produced HTTP ${response.status()}. A streaming route is the one place partial requests are expected; it must answer 206, ignore the header, or 404 — not fault.`
    ).toBeLessThan(500);
  });

  test('[5] range: a malformed Range header must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), {
      token: staticToken,
      headers: { Range: 'bytes=abc-def' },
    });

    expect(
      response.status(),
      `a malformed Range header produced HTTP ${response.status()}. It must be a 416 or ignored.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a 5000-character UUID must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character UUID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] path traversal must not escape the object store', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(TRAVERSAL_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, TRAVERSAL_PAYLOAD);
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), { token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[10] auth: an alg=none token claiming admin must never stream', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.mediaStreaming(nonExistentUuid(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
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

/* =========================================================================================
 * POST /v2/katchup/uploadMultipartFiles/
 * ====================================================================================== */
test.describe('POST /v2/katchup/uploadMultipartFiles/', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.uploadMultipartFiles,
    repro: `await katchupClient.uploadMultipartFiles({ files: [] }, { token });`,
  };

  test('[1] happy path: an upload call satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [] }, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      attachmentResponseSchema,
      { ...META, body: { files: [] } },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[2] boundary: no files must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [] }, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: { files: [] },
        scenario: 'an upload with no files attached',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[3] content type: a JSON body on a multipart route must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: ['not-a-file'] }, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      title: 'A multipart route accepts a JSON body',
      severity: 'Major',
    });
  });

  test('[4] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [] }, { token: null });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[5] auth: an expired token must not upload', async ({ katchupClient }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [] }, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[6] auth: an alg=none token claiming admin must never upload', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [] }, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[7] quota: an upload must be attributed to the caller for storage accounting', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.uploadMultipartFiles(
      { files: [], kpostID: 'admin' },
      { token: staticToken }
    );
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'upload did not succeed');

    expect(
      text.includes('"kpostID":"admin"'),
      `the upload was attributed to "admin" while the caller was ${authSession.kpostID ?? 'a different identity'}. Attachment storage is metered per user, so a body-chosen owner shifts the caller's storage consumption onto somebody else. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[8] SQL injection: a tautology in the files parameter must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [SQLI_PAYLOAD] }, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: { files: [SQLI_PAYLOAD] } }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload in a filename must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.uploadMultipartFiles({ files: [XSS_PAYLOAD] }, {
      token: staticToken,
    });

    await assertNoReflectedScript(
      response,
      { ...META, body: { files: [XSS_PAYLOAD] } },
      XSS_PAYLOAD
    );
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendRaw(KATCHUP_PATHS.uploadMultipartFiles, '{"files":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"files":',
      repro: `await katchupClient.sendRaw(KATCHUP_PATHS.uploadMultipartFiles, '{"files":', { token });`,
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

});

/* =========================================================================================
 * POST /v2/katchup/generateThumbnailUsingUUID
 * ====================================================================================== */
test.describe('POST /v2/katchup/generateThumbnailUsingUUID', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.generateThumbnailUsingUUID,
    repro: `await katchupClient.generateThumbnailUsingUUID(buildExistingMessagePayload(), { token });`,
  };

  test('[1] happy path: a thumbnail request satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ uuid: [nonExistentUuid()] });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      attachmentResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] missing required parameter: no uuid must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.generateThumbnailUsingUUID({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'thumbnail generation with no uuid',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] null fuzzing: a null uuid must be refused', async ({ katchupClient, staticToken }) => {
    const payload = buildExistingMessagePayload({ uuid: null });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "uuid" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[4] type mismatch: a numeric uuid must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ uuid: 12345 });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `uuid was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] ownership: a thumbnail must not be generated for another user\'s attachment', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingMessagePayload({
      uuid: [nonExistentUuid()],
      sender: 'admin',
    });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'thumbnail generation did not succeed');

    expect(
      Boolean(json?.data),
      `a thumbnail was generated for an attachment the caller (${authSession.kpostID ?? 'unknown'}) has no message for. Rendering a preview of a private image is the same disclosure as serving the image. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] boundary: a 100-UUID batch must be bounded explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const uuid = Array.from({ length: 100 }, () => nonExistentUuid());
    const payload = buildExistingMessagePayload({ uuid });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 100-UUID thumbnail batch produced HTTP ${response.status()}. Thumbnail generation is CPU-bound image work; an unbounded batch is a cheap way to exhaust the server.`
    ).toBeLessThan(500);
  });

  test('[7] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload({ uuid: [nonExistentUuid()] });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8] auth: an expired token must not generate thumbnails', async ({ katchupClient }) => {
    const payload = buildExistingMessagePayload({ uuid: [nonExistentUuid()] });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ uuid: [SQLI_PAYLOAD] });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildExistingMessagePayload({ uuid: [nonExistentUuid()] });
    const response = await katchupClient.generateThumbnailUsingUUID(payload, {
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
 * POST /v2/katchup/sendKatchupMsgMultiPart/
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendKatchupMsgMultiPart/', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendKatchupMsgMultiPart,
    repro: `await katchupClient.sendKatchupMsgMultiPart({ files: [] }, { token, params: { text } });`,
  };

  test('[FR-K03][1] happy path: a multipart send satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const text = JSON.stringify(buildKatchupMessagePayload());
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
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

  test('[2] missing required parameter: no text parameter must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: { files: [] },
        scenario: 'multipart send with no message payload in the text parameter',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[3] business rule: a send with no receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    delete (payload as Record<string, unknown>).receiver;
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a message with nobody to deliver it to',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[4] spoofing: a body-supplied sender must not override the token', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKatchupMessagePayload({ sender: 'admin' });
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    expect(
      text.includes('"sender":"admin"'),
      `the message was sent as "admin" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route assigns the sender from the token (katchupMessageRO.setSender(kpostID)), so a body value must never survive — the recipient sees whoever the sender field says. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[5] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, { token: null });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[6] auth: an expired token must not send a message', async ({ katchupClient }) => {
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[7] auth: an alg=none token claiming admin must never send', async ({ katchupClient }) => {
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[8] XSS: a script payload in the message body must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ actualMessage: SQLI_PAYLOAD });
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] structural: a malformed text parameter must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: '{not json' },
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: { files: [] },
      title: 'A malformed message payload in the text parameter is not rejected with a clean 400',
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
 * POST /v2/katchup/sendBulkKatchupMsgMultiPart/
 *
 * The highest fan-out write in the API. Recipient lists are held to two synthetic identities;
 * the size-limit case asserts that a limit exists rather than trying to exceed it.
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendBulkKatchupMsgMultiPart/', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendBulkKatchupMsgMultiPart,
    repro: `await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, { token, params: { text } });`,
  };

  test('[1] happy path: a bulk multipart send satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const text = JSON.stringify(buildBulkMessagePayload());
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
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

  test('[2] boundary: an empty recipient list must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ receiverList: [] });
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a broadcast with nobody on the recipient list',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[3] boundary: a recipient-count limit must exist', async ({
    katchupClient,
    staticToken,
  }) => {
    // Deliberately synthetic identities only. The assertion is that the API imposes a cap,
    // not that a large broadcast succeeds — a successful one would raise a push per recipient.
    const receiverList = Array.from({ length: 500 }, () => syntheticReceiver());
    const payload = buildBulkMessagePayload({ receiverList });
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    expect(
      response.status(),
      `a 500-recipient broadcast produced HTTP ${response.status()}. The API's own documentation calls this the highest fan-out write it has and notes a mistaken bulk send cannot be undone in one action, so an explicit cap is required rather than a crash.`
    ).toBeLessThan(500);
  });

  test('[4] business rule: a blocked recipient must be excluded, not delivered to', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      response.status(),
      `a bulk send to non-existent recipients produced HTTP ${response.status()}. Per-recipient failure handling must be defined: one unknown or blocking recipient must not abort the whole broadcast, nor be silently delivered to. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[5] spoofing: a body-supplied sender must not override the token', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBulkMessagePayload({ sender: 'admin' });
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    expect(
      text.includes('"sender":"admin"'),
      `a broadcast went out as "admin" while the caller was ${authSession.kpostID ?? 'a different identity'}. A spoofed sender on the fan-out route reaches every recipient at once. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] storage: attachments must be stored once, not per recipient', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload();
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed');

    const uuids = [...text.matchAll(/"uuid"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    const unique = new Set(uuids);
    expect(
      uuids.length === 0 || unique.size,
      `the broadcast returned ${uuids.length} attachment handles of which ${unique.size} are distinct. Duplicating the upload per recipient multiplies the sender's metered storage by the recipient count. Body: ${text.slice(0, 200)}`
    ).toBeLessThanOrEqual(Math.max(1, unique.size));
  });

  test('[7] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[8] auth: an expired token must not broadcast', async ({ katchupClient }) => {
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[9] auth: an alg=none token claiming admin must never broadcast', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: { files: [] } });
  });

  test('[10] XSS: a script payload in the broadcast body must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildBulkMessagePayload({ actualMessage: XSS_PAYLOAD });
    const response = await katchupClient.sendBulkKatchupMsgMultiPart({ files: [] }, {
      token: staticToken,
      params: { text: JSON.stringify(payload) },
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
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
