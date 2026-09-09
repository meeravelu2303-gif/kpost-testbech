import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { profileMutationResponseSchema } from '../../src/api/schemas/profile.schema';
import {
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
  base64Png,
  buildBase64ConversionPayload,
  buildImageUploadPayload,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * User Profile V2 — image uploads, signatures, attachments and storage accounting.
 *
 * Three things make this group riskier than it looks.
 *
 * **`uploadImageToS3` has no identity argument at all** — its signature is
 * `uploadImageToS3(@RequestBody MultipartFile file)`, with no `HttpServletRequest`. It derives
 * the S3 object name from `file.getOriginalFilename()`, a value the client controls entirely.
 * A filename is therefore an object key: traversal sequences, absolute paths and collisions
 * with another user's object are all worth probing.
 *
 * **Storage is metered per user** (`getStorageDetails` reports it), so an upload attributed to
 * the wrong account shifts one user's consumption onto another.
 *
 * **A signature image is a legal artefact.** `getSignatureImage` returning someone else's
 * signature is not a cosmetic leak — it is material that can be pasted onto a document.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL_FILENAME = '../../../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /v2/profile/uploadImageToS3
 * ====================================================================================== */
test.describe('POST /v2/profile/uploadImageToS3', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.uploadImageToS3,
    repro: `await profileClient.uploadImageToS3(buildImageUploadPayload(), { token });`,
  };

  test('[1] happy path: an upload satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[2] OBJECT KEY: a traversal filename must not escape the upload prefix', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: TRAVERSAL_FILENAME });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      text.includes('..'),
      `the returned object path still contained a traversal sequence. This route names the S3 object from the client-supplied filename, so an unsanitised name lets a caller choose where the object lands — including over an existing one. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] OBJECT KEY: an absolute path filename must be rejected or normalised', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: '/etc/kpost/config.json' });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });

    expect(
      response.status(),
      `an absolute-path filename produced HTTP ${response.status()}. It must be refused or reduced to a basename before it becomes an object key.`
    ).toBeLessThan(500);
  });

  test('[4] missing required parameter: no file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.uploadImageToS3({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an upload with no file',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[5] null fuzzing: a null file must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildImageUploadPayload({ file: null });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "file" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[6] content type: a non-image payload must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({
      file: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      fileName: 'payload.html',
    });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an HTML document was accepted by an image-upload route. If the object is later served from a domain the app trusts, stored HTML becomes stored XSS. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] quota: an upload must be attributed to the caller', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildImageUploadPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'upload did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the upload was attributed to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This handler takes no HttpServletRequest at all, so there is no token identity available to it — storage is metered per user, and an object with no owner is either unbilled or billed to whoever the body names. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadImageToS3(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not upload', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadImageToS3(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: 'not-base64-at-all' });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, 'S3');
  });

  test('[10] XSS: a script payload in the filename must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: XSS_PAYLOAD });
    const response = await profileClient.uploadImageToS3(payload, { token: staticToken });

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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * POST /v2/profile/uploadProfileAttachments
 * ====================================================================================== */
test.describe('POST /v2/profile/uploadProfileAttachments', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.uploadProfileAttachments,
    repro: `await profileClient.uploadProfileAttachments(buildImageUploadPayload(), { token });`,
  };

  test('[1] happy path: an attachment upload satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[2] missing required parameter: no file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.uploadProfileAttachments({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an attachment upload with no file',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[3] boundary: an oversized upload must be refused cleanly', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: `data:image/png;base64,${'A'.repeat(200000)}` });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a ~150 KB base64 upload produced HTTP ${response.status()}. A size cap must produce a 413 or 400, not an out-of-memory fault.`
    ).toBeLessThan(500);
  });

  test('[4] content type: an executable payload must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({
      file: 'data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA',
      fileName: 'payload.exe',
    });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a Windows executable (MZ header) was accepted as a profile attachment. Profile attachments are downloadable by other users, so an unrestricted type list makes the profile a malware host. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[5] OBJECT KEY: a traversal filename must not escape the upload prefix', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: TRAVERSAL_FILENAME });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text.includes('..'),
      `the returned path contained a traversal sequence. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[6] quota: the upload must count against the caller\'s storage', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildImageUploadPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'upload did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the attachment was attributed to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadProfileAttachments(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[7b] auth: an alg=none token claiming admin must never upload', async ({
    profileClient,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8] SQL injection: a tautology in the filename must not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: SQLI_PAYLOAD });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload in the filename must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: XSS_PAYLOAD });
    const response = await profileClient.uploadProfileAttachments(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadProfileAttachments(payload, {
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * POST /v2/profile/uploadCoverImage
 * ====================================================================================== */
test.describe('POST /v2/profile/uploadCoverImage', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.uploadCoverImage,
    repro: `await profileClient.uploadCoverImage(buildImageUploadPayload(), { token });`,
  };

  test('[1] happy path: a cover upload satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[2] missing required parameter: no file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.uploadCoverImage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a cover-image upload with no file',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[3] null fuzzing: a null file must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildImageUploadPayload({ file: null });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "file" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[4] type mismatch: a numeric file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: 12345 });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    expect(
      response.status(),
      `file was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] content type: a non-image must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildImageUploadPayload({
      file: 'data:text/html;base64,PGgxPmhpPC9oMT4=',
      fileName: 'cover.html',
    });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an HTML document was accepted as a cover image. A cover image is shown on the public profile. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] ownership: a body kpostID must not replace another user\'s cover', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildImageUploadPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'upload did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the cover image was set on "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Defacing a public profile is the visible half of this. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadCoverImage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[7b] auth: an expired token must not replace a cover image', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadCoverImage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: SQLI_PAYLOAD });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: XSS_PAYLOAD });
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP 200 must not carry a failure payload', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.uploadCoverImage(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
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

/* =========================================================================================
 * GET /v2/profile/removeCoverImage
 * ====================================================================================== */
test.describe('GET /v2/profile/removeCoverImage', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.removeCoverImage,
    repro: `await profileClient.removeCoverImage({ token });`,
  };

  test('[1] method safety: a destructive action must not be exposed as a GET', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.removeCoverImage({ token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'The cover image is deleted by a prefetchable GET',
      severity: 'Major',
    });
  });

  test('[2] contract: the response must satisfy the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.removeCoverImage({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403, 404, 405]
    );
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.removeCoverImage({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not delete a cover image', async ({ profileClient }) => {
    const response = await profileClient.removeCoverImage({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: a malformed token must not delete a cover image', async ({ profileClient }) => {
    const response = await profileClient.removeCoverImage({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: an alg=none token claiming admin must never delete', async ({
    profileClient,
  }) => {
    const response = await profileClient.removeCoverImage({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[7] IDOR: a kpostID query parameter must not delete another user\'s cover', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.removeCoverImage({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `?kpostID=${VICTIM_KPOST_ID} was echoed on a delete while the caller was ${authSession.kpostID ?? 'a different identity'}. Combined with the GET method that would be a one-link profile defacement. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[8] idempotency: removing twice must be stable', async ({ profileClient, staticToken }) => {
    const first = await profileClient.removeCoverImage({ token: staticToken });
    const second = await profileClient.removeCoverImage({ token: staticToken });

    expect(
      first.status(),
      `removing the cover twice returned ${first.status()} then ${second.status()}.`
    ).toBe(second.status());
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.removeCoverImage({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.removeCoverImage({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/profile/updateSignatureImage
 * ====================================================================================== */
test.describe('POST /v2/profile/updateSignatureImage', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateSignatureImage,
    repro: `await profileClient.updateSignatureImage(buildImageUploadPayload(), { token });`,
  };

  test('[1] happy path: a signature upload satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 415]
    );
  });

  test('[2] OWNERSHIP: a signature must not be written to another user\'s account', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildImageUploadPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'upload did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `a signature image was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. A signature is applied to documents on the user's behalf — replacing someone's is forgery infrastructure. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateSignatureImage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a signature update with no image',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[4] null fuzzing: a null file must not blank the signature', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: null });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "file" null — a null signature silently erases the stored one',
        severity: 'Major' as const,
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[5] type mismatch: an object file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: { data: base64Png() } });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

    expect(
      response.status(),
      `file was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] content type: a non-image signature must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({
      file: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an HTML document was accepted as a signature image. Signatures are rendered into documents; a non-image here is either a broken document or an injection. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.updateSignatureImage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[7b] auth: an expired token must not replace a signature', async ({ profileClient }) => {
    const payload = buildImageUploadPayload();
    const response = await profileClient.updateSignatureImage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8] boundary: an oversized signature must be refused cleanly', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ file: `data:image/png;base64,${'A'.repeat(200000)}` });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

    expect(
      response.status(),
      `a ~150 KB signature produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: SQLI_PAYLOAD });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildImageUploadPayload({ fileName: XSS_PAYLOAD });
    const response = await profileClient.updateSignatureImage(payload, { token: staticToken });

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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * GET /v2/profile/getSignatureImage
 * ====================================================================================== */
test.describe('GET /v2/profile/getSignatureImage', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.getSignatureImage,
    repro: `await profileClient.getSignatureImage({ token });`,
  };

  test('[1] happy path: the signature read satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getSignatureImage({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] OWNERSHIP: a kpostID parameter must not return another user\'s signature', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const withParam = await profileClient.getSignatureImage({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const without = await profileClient.getSignatureImage({ token: staticToken });
    const a = await readBody(withParam);
    const b = await readBody(without);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      comparableBody(a.text),
      `?kpostID=${VICTIM_KPOST_ID} returned a different signature than the caller's own, while the caller was ${authSession.kpostID ?? 'a different identity'}. A signature image is legally significant material — retrieving someone else's is the raw ingredient for forgery. Body: ${a.text.slice(0, 200)}`
    ).toBe(comparableBody(b.text));
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getSignatureImage({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not return a signature', async ({ profileClient }) => {
    const response = await profileClient.getSignatureImage({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: a malformed token must not return a signature', async ({ profileClient }) => {
    const response = await profileClient.getSignatureImage({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: an alg=none token claiming admin must never return a signature', async ({
    profileClient,
  }) => {
    const response = await profileClient.getSignatureImage({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[7] empty-state: no signature on file must not be an error', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getSignatureImage({ token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      title: 'An absent signature image is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[8] injection: a SQL tautology in a query parameter must not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getSignatureImage({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[9] disclosure: an S3 SDK error must not reach the caller', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getSignatureImage({ token: staticToken });

    await assertNoInternalLeak(response, META, 'S3');
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      profileClient.getSignatureImage({ token: staticToken }),
      profileClient.getSignatureImage({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
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
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * POST /v2/profile/convertBase64ToImage
 * ====================================================================================== */
test.describe('POST /v2/profile/convertBase64ToImage', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.convertBase64ToImage,
    repro: `await profileClient.convertBase64ToImage(buildBase64ConversionPayload(), { token });`,
  };

  test('[1] happy path: a conversion satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload();
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] OBJECT KEY: a traversal filename must not choose where the file lands', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ fileName: TRAVERSAL_FILENAME });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text.includes('..'),
      `the returned path contained a traversal sequence. This route writes a file named by the client — an unsanitised name is an arbitrary-write primitive. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no file must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.convertBase64ToImage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a conversion with nothing to convert',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null payload must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ file: null });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "file" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: malformed base64 must be refused cleanly', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ file: 'this-is-not-base64!!!' });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the payload is not valid base64',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] boundary: a decompression-bomb-sized payload must be bounded', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ file: `data:image/png;base64,${'A'.repeat(300000)}` });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

    expect(
      response.status(),
      `a ~220 KB base64 blob produced HTTP ${response.status()}. Base64 decoding allocates before validation, so the size limit has to be checked on the encoded string.`
    ).toBeLessThan(500);
  });

  test('[7] content type: a non-image payload must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({
      file: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      fileName: 'x.html',
    });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `an HTML document was converted by an image route. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildBase64ConversionPayload();
    const response = await profileClient.convertBase64ToImage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not convert', async ({ profileClient }) => {
    const payload = buildBase64ConversionPayload();
    const response = await profileClient.convertBase64ToImage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] boundary: a 5000-character filename must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ fileName: MAX_LENGTH_STRING });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character filename produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] XSS: a script payload in the filename must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBase64ConversionPayload({ fileName: XSS_PAYLOAD });
    const response = await profileClient.convertBase64ToImage(payload, { token: staticToken });

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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * GET /v2/profile/getStorageDetails
 * ====================================================================================== */
test.describe('GET /v2/profile/getStorageDetails', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.getStorageDetails,
    repro: `await profileClient.getStorageDetails({ token });`,
  };

  test('[1] happy path: storage accounting satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getStorageDetails({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: the counters must be populated, not null', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getStorageDetails({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const nulls = [...text.matchAll(/"(\w*DataSize)"\s*:\s*null/g)].map((m) => m[1]);
    expect(
      nulls.join(', ') || 'none',
      `storage counters came back null: ${nulls.join(', ')}. A quota screen that shows "null" cannot tell a user whether they are near their limit, and a null is indistinguishable from genuinely-zero usage.`
    ).toBe('none');
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.getStorageDetails({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not return storage accounting', async ({
    profileClient,
  }) => {
    const response = await profileClient.getStorageDetails({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: an alg=none token claiming admin must never be honoured', async ({
    profileClient,
  }) => {
    const response = await profileClient.getStorageDetails({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[6] IDOR: a kpostID query parameter must not report another user\'s usage', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const withParam = await profileClient.getStorageDetails({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const without = await profileClient.getStorageDetails({ token: staticToken });
    const a = await readBody(withParam);
    const b = await readBody(without);

    test.skip(a.json === null || b.json === null, 'responses were not JSON');

    expect(
      comparableBody(a.text),
      `?kpostID=${VICTIM_KPOST_ID} changed the reported usage for ${authSession.kpostID ?? 'the caller'}. Storage usage reveals how much someone stores and, by extension, how heavily they use the product. Body: ${a.text.slice(0, 200)}`
    ).toBe(comparableBody(b.text));
  });

  test('[7] injection: a SQL tautology in a query parameter must not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getStorageDetails({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] XSS: a script payload in a query parameter must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getStorageDetails({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[9] idempotency: two consecutive reads must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      profileClient.getStorageDetails({ token: staticToken }),
      profileClient.getStorageDetails({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getStorageDetails({ token: staticToken });

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
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
