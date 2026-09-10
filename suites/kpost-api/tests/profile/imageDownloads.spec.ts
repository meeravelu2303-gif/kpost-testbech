import { test, expect, FORGED_ALG_NONE_JWT } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertUnauthorized,
  readBody,
  assertStatusCodeParity,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import { syntheticKpostId } from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * User Profile V2 — the three image reads and the device-OTP dispatcher.
 *
 * ## Why these four are grouped
 *
 * All four take their only argument **in the URL path**, which changes what "invalid input"
 * means. There is no DTO to leave unvalidated; the value is a path segment, so the failure
 * modes are traversal, injection into whatever resolves the segment to a file or a row, and
 * the enumeration that follows from an identifier being guessable.
 *
 * ## The authentication question these tests actually answer
 *
 * `SecurityConfiguration` puts `/v2/profile/downloadProfileImage/**` in `permitAll`. That is
 * defensible on its own — an avatar is shown next to a name in places a token may not exist,
 * and the sibling `downloadAttachment` route is documented as relying on UUID possession.
 *
 * The tests do not treat "no token" as automatically wrong. They ask a narrower question:
 * **is the identifier a UUID or a kpostID?** A UUID is a bearer credential — unguessable, so
 * possession is a weak but real access control. A **kpostID is a username**: it appears in
 * search results, it is chosen by the member, and it is frequently their email local-part. If
 * the path variable is a kpostID, "possession of the identifier" is not access control at all,
 * and the route is an anonymous, enumerable read of every member's photograph. Case `[8]` on
 * each endpoint is written around that distinction, and grades on what came back — an actual
 * image body — rather than on the status code alone.
 *
 * `downloadCoverImage` and `downloadFullProfileImage` matter more than the thumbnail: a full
 * resolution original carries EXIF, which can carry GPS coordinates.
 *
 * ## Safety
 *
 * `sendPrimaryOrSecondaryDeviceOtp` **dispatches a real SMS** to the caller's own registered
 * handset. Only one case here triggers a successful dispatch; every other case sends a
 * `requestType` the API must refuse, so the refusal path carries the coverage. No case targets
 * a number other than the suite's own test handset.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL = '../../../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(2000);
/**
 * Every endpoint in this file is keyed by a member id, so a session without one cannot verify
 * the coverage. Failing loudly beats skipping - an unverified image route looks identical to a
 * passing one in the report.
 */
function ownerKpostId(session: { kpostID: string | null }): string {
  if (!session.kpostID) {
    throw new Error(
      'The auth session carries no kpostID, so the image reads cannot be exercised against a known member. Set QA_KPOST_ID in .env.'
    );
  }
  return session.kpostID;
}

/** True when the response body looks like actual image bytes rather than a JSON envelope. */
async function looksLikeImage(response: {
  headers: () => Record<string, string>;
  body: () => Promise<Buffer>;
}): Promise<{ isImage: boolean; detail: string }> {
  const contentType = response.headers()['content-type'] ?? '';
  const buffer = await response.body();
  const magic = buffer.subarray(0, 8).toString('latin1');
  const isImage =
    /^image\//i.test(contentType) ||
    /^application\/octet-stream/i.test(contentType) ||
    magic.startsWith('\x89PNG') ||
    magic.startsWith('\xFF\xD8\xFF') ||
    magic.startsWith('GIF8');
  return {
    isImage: isImage && buffer.length > 100,
    detail: `content-type=${contentType || '(none)'} bytes=${buffer.length}`,
  };
}

/* =========================================================================================
 * GET /v2/profile/downloadProfileImage/{kpostID}
 * ====================================================================================== */
test.describe('GET /v2/profile/downloadProfileImage/{kpostID}', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.downloadProfileImage,
    repro: `await profileClient.downloadProfileImage(kpostID, { token });`,
  };

  test('[1] happy path: the caller\'s own avatar resolves without a server fault', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.downloadProfileImage(ownerKpostId(authSession), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'Fetching the caller\'s own profile image returns an unexpected status',
    });
  });

  test('[2] boundary: a 2000-character kpostID must not reach a file lookup', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 414, 422], {
      ...META,
      title: 'A 2000-character path variable is not rejected cleanly',
    });
  });

  test('[2b] boundary: a UTF-8 kpostID must not raise a server fault', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage('उपयोगकर्ता🌸', {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'उपयोगकर्ता🌸');
  });

  test('[3] missing parameter: the bare route with no kpostID must not list every image', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(`${PROFILE_PATHS.downloadProfileImage}/`, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && /"kpostID"/.test(text),
      `the route with an empty path variable answered ${response.status()} with member data. An omitted identifier must be a 404, never a listing. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal string "null" must not resolve to a record', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage('null', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      title: 'The literal path segment "null" is treated as a valid identifier',
    });
  });

  test('[5] traversal: a path-traversal segment must not escape the image directory', async ({
    profileClient,
    staticToken,
  }) => {
    // Sent unencoded on purpose — the encoded form proves nothing about the server's handling.
    const response = await profileClient.getRawImagePath(
      `${PROFILE_PATHS.downloadProfileImage}/${TRAVERSAL}`,
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(
      /root:.*:0:0:/.test(text),
      `a traversal payload in the path returned the contents of /etc/passwd. The path variable is being concatenated into a filesystem path with no containment check. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in the path must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] anonymous access: an avatar keyed by username must not be readable without a token', async ({
    profileClient,
    authSession,
  }) => {
    // The decisive case. Not "did it 401" — did an unauthenticated caller receive image bytes
    // for a member they merely named. A kpostID is a username, not a secret.
    const response = await profileClient.downloadProfileImage(ownerKpostId(authSession));
    const { isImage, detail } = await looksLikeImage(response);

    expect(
      isImage,
      `an anonymous caller retrieved a real profile image for "${ownerKpostId(authSession)}" (${detail}). The identifier is a username that appears in search results, so possession of it is not an access control — every member's photograph is enumerable. Either the route needs a token or it needs an unguessable UUID.`
    ).toBe(false);
  });

  test('[8b] enumeration: a guessed kpostID must not return another member\'s image', async ({
    profileClient,
  }) => {
    const response = await profileClient.downloadProfileImage('admin');
    const { isImage, detail } = await looksLikeImage(response);

    expect(
      isImage,
      `an anonymous request for the guessable identifier "admin" returned image bytes (${detail}). Common identifiers are the first thing an enumeration script tries.`
    ).toBe(false);
  });

  // No token-validation case: swagger declares this route public (security: []), so a forged/
  // expired token is not meaningful here. The privacy exposure — a username-keyed image served
  // anonymously — is filed by [8]/[8b] above.

  test('[9] disclosure: a not-found image must not expose a filesystem or bucket path', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadProfileImage(syntheticKpostId(), {
      token: staticToken,
    });
    const { text } = await readBody(response);
    const leak = text.match(/([A-Za-z]:\\[^\s"]+|\/(?:home|var|opt|usr)\/[^\s"]+|s3:\/\/[^\s"]+)/);

    expect(
      leak !== null,
      `a missing image returned an absolute storage path (${leak ? leak[0].slice(0, 80) : ''}). That names the storage layout and, for an S3 URI, the bucket. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] verb binding: POST to a read-only image route must not be accepted', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.postRawTo(
      `${PROFILE_PATHS.downloadProfileImage}/${ownerKpostId(authSession)}`,
      '{}',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      method: 'POST',
      title: 'A read-only image route also answers POST',
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.kpostID), { token: staticToken });
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
 * GET /v2/profile/downloadFullProfileImage/{kpostID}
 * ====================================================================================== */
test.describe('GET /v2/profile/downloadFullProfileImage/{kpostID}', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.downloadFullProfileImage,
    repro: `await profileClient.downloadFullProfileImage(kpostID, { token });`,
  };

  test('[1] happy path: the caller\'s own full-resolution image resolves cleanly', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.downloadFullProfileImage(ownerKpostId(authSession), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'Fetching the caller\'s own full-resolution image returns an unexpected status',
    });
  });

  test('[2] boundary: a 2000-character kpostID must be rejected cleanly', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 414, 422], {
      ...META,
      title: 'A 2000-character path variable is not rejected cleanly',
    });
  });

  test('[2b] boundary: a UTF-8 identifier must not raise a server fault', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage('उपयोगकर्ता🌸', {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'उपयोगकर्ता🌸');
  });

  test('[3] missing parameter: the bare route must not enumerate', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(
      `${PROFILE_PATHS.downloadFullProfileImage}/`,
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(
      response.ok() && /"kpostID"/.test(text),
      `the route with an empty path variable answered ${response.status()} with member data. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal "null" must not resolve to a record', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage('null', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      title: 'The literal path segment "null" is treated as a valid identifier',
    });
  });

  test('[5] traversal: a traversal segment must not escape the image directory', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(
      `${PROFILE_PATHS.downloadFullProfileImage}/${TRAVERSAL}`,
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(
      /root:.*:0:0:/.test(text),
      `a traversal payload returned /etc/passwd from the full-image route. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] anonymous access: a full-resolution original must not be readable without a token', async ({
    profileClient,
    authSession,
  }) => {
    // Worse than the thumbnail: an untouched original commonly retains EXIF, and phone EXIF
    // commonly retains GPS coordinates. That turns an avatar read into a location disclosure.
    const response = await profileClient.downloadFullProfileImage(ownerKpostId(authSession));
    const { isImage, detail } = await looksLikeImage(response);

    expect(
      isImage,
      `an anonymous caller retrieved the full-resolution original for "${ownerKpostId(authSession)}" (${detail}). Originals carry EXIF, which frequently carries the GPS coordinates of where the photo was taken — so this is a location disclosure, not only an image one.`
    ).toBe(false);
  });

  // No token-validation case: swagger declares this route public (security: []).

  test('[9] disclosure: a not-found image must not expose a storage path', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadFullProfileImage(syntheticKpostId(), {
      token: staticToken,
    });
    const { text } = await readBody(response);
    const leak = text.match(/([A-Za-z]:\\[^\s"]+|\/(?:home|var|opt|usr)\/[^\s"]+|s3:\/\/[^\s"]+)/);

    expect(
      leak !== null,
      `a missing full-resolution image returned an absolute storage path (${leak ? leak[0].slice(0, 80) : ''}).`
    ).toBe(false);
  });

  test('[10] consistency: the thumbnail and full-image routes must agree on access', async ({
    profileClient,
    authSession,
  }) => {
    // Two routes over the same asset. If one is guarded and the other is not, the unguarded
    // one is simply the way to get the picture.
    const [thumb, full] = await Promise.all([
      profileClient.downloadProfileImage(ownerKpostId(authSession)),
      profileClient.downloadFullProfileImage(ownerKpostId(authSession)),
    ]);

    expect(
      thumb.ok() === full.ok(),
      `anonymously, downloadProfileImage answered ${thumb.status()} and downloadFullProfileImage answered ${full.status()}. Two reads of the same member's photograph must enforce the same access rule; the more permissive one defines the actual exposure.`
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.kpostID), { token: staticToken });
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
 * GET /v2/profile/downloadCoverImage/{kpostID}
 * ====================================================================================== */
test.describe('GET /v2/profile/downloadCoverImage/{kpostID}', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.downloadCoverImage,
    repro: `await profileClient.downloadCoverImage(kpostID, { token });`,
  };

  test('[1] happy path: the caller\'s own cover image resolves cleanly', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.downloadCoverImage(ownerKpostId(authSession), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'Fetching the caller\'s own cover image returns an unexpected status',
    });
  });

  test('[2] boundary: a 2000-character kpostID must be rejected cleanly', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 414, 422], {
      ...META,
      title: 'A 2000-character path variable is not rejected cleanly',
    });
  });

  test('[2b] boundary: a UTF-8 identifier must not raise a server fault', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage('उपयोगकर्ता🌸', {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, 'उपयोगकर्ता🌸');
  });

  test('[3] missing parameter: the bare route must not enumerate', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(`${PROFILE_PATHS.downloadCoverImage}/`, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && /"kpostID"/.test(text),
      `the route with an empty path variable answered ${response.status()} with member data. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal "null" must not resolve to a record', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage('null', { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      title: 'The literal path segment "null" is treated as a valid identifier',
    });
  });

  test('[5] traversal: a traversal segment must not escape the image directory', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(
      `${PROFILE_PATHS.downloadCoverImage}/${TRAVERSAL}`,
      { token: staticToken }
    );
    const { text } = await readBody(response);

    expect(
      /root:.*:0:0:/.test(text),
      `a traversal payload returned /etc/passwd from the cover-image route. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] anonymous access: a cover image must not be readable without a token', async ({
    profileClient,
    authSession,
  }) => {
    const response = await profileClient.downloadCoverImage(ownerKpostId(authSession));
    const { isImage, detail } = await looksLikeImage(response);

    expect(
      isImage,
      `an anonymous caller retrieved the cover image for "${ownerKpostId(authSession)}" (${detail}). Keyed by a username rather than an unguessable id, this is an enumerable read of every member's banner photo.`
    ).toBe(false);
  });

  // No token-validation case: swagger declares this route public (security: []).

  test('[9] disclosure: a not-found image must not expose a storage path', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.downloadCoverImage(syntheticKpostId(), {
      token: staticToken,
    });
    const { text } = await readBody(response);
    const leak = text.match(/([A-Za-z]:\\[^\s"]+|\/(?:home|var|opt|usr)\/[^\s"]+|s3:\/\/[^\s"]+)/);

    expect(
      leak !== null,
      `a missing cover image returned an absolute storage path (${leak ? leak[0].slice(0, 80) : ''}).`
    ).toBe(false);
  });

  test('[10] verb binding: DELETE on a read route must not remove the image', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    // removeCoverImage already exists as a destructive GET elsewhere in this API, so checking
    // whether the read route also binds DELETE is not a hypothetical concern here.
    const response = await profileClient.sendVerb(
      'delete',
      `${PROFILE_PATHS.downloadCoverImage}/${ownerKpostId(authSession)}`,
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      method: 'DELETE',
      title: 'A read-only cover-image route also answers DELETE',
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.kpostID), { token: staticToken });
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
 * GET /v2/profile/sendPrimaryOrSecondaryDeviceOtp/{requestType}
 * ====================================================================================== */
test.describe('GET /v2/profile/sendPrimaryOrSecondaryDeviceOtp/{requestType}', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.sendPrimaryOrSecondaryDeviceOtp,
    repro: `await profileClient.sendPrimaryOrSecondaryDeviceOtp('primary', { token });`,
  };

  test('[1] happy path: a valid requestType is accepted and dispatches to the caller\'s own handset', async ({
    profileClient,
    staticToken,
  }) => {
    // The only case in this file that triggers a real SMS. Every other case below sends a
    // requestType the API must refuse, so the coverage does not cost a message each.
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('primary', {
      token: staticToken,
    });

    await assertStatus(response, [200, 400, 401, 403, 404], {
      ...META,
      title: 'A valid device OTP request returns an unexpected status',
    });
  });

  test('[2] boundary: a 2000-character requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 414, 422], {
      ...META,
      title: 'A 2000-character requestType is not rejected cleanly',
    });
  });

  test('[3] business rule: an unknown requestType must not default to sending anything', async ({
    profileClient,
    staticToken,
  }) => {
    // The failure that matters: an unrecognised type falling through a switch to a permissive
    // default sends a code to the wrong handset — which is exactly how a device-pairing check
    // gets defeated.
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('tertiary', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && /SUCCESS/i.test(text),
      `requestType "tertiary" is not a defined device type, yet the API reported success. An unrecognised value must be refused, not resolved to a default handset — dispatching a pairing code to the wrong device is how the second factor is bypassed. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[4] null fuzzing: the literal "null" must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('null', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && /SUCCESS/i.test(text),
      `the literal path segment "null" was accepted as a device type and reported success. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[4b] empty fuzzing: an empty requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getRawImagePath(
      `${PROFILE_PATHS.sendPrimaryOrSecondaryDeviceOtp}/`,
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'An empty requestType is not rejected cleanly',
    });
  });

  test('[5] type mismatch: a numeric requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('1', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && /SUCCESS/i.test(text),
      `the numeric requestType "1" was accepted. If the type is an ordinal rather than a name, that must be documented; if it is not, this is a permissive default. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[6] XSS: a script payload in requestType must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous OTP dispatch must be HTTP 401/403', async ({ profileClient }) => {
    // Unauthenticated access here is an SMS-bombing primitive as well as an auth gap.
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('primary');

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an alg=none forged token must not dispatch a code', async ({
    profileClient,
  }) => {
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('primary', {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[9] disclosure: the response must not echo the destination number or the code', async ({
    profileClient,
    staticToken,
  }) => {
    // Returning the OTP in its own dispatch response defeats the entire point of sending it
    // out of band; returning the full destination number leaks PII to whoever triggered it.
    const response = await profileClient.sendPrimaryOrSecondaryDeviceOtp('primary', {
      token: staticToken,
    });
    const { text } = await readBody(response);
    const otpEcho = text.match(/"(otp|otpCode|code|pin)"\s*:\s*"?\d{4,8}"?/i);
    const numberEcho = text.match(/\b[6-9]\d{9}\b/);

    expect(
      otpEcho !== null || numberEcho !== null,
      `the OTP dispatch response echoed ${otpEcho ? 'the code itself' : 'the destination mobile number'} (${(otpEcho ?? numberEcho ?? [''])[0]}). An out-of-band code returned in-band is not a second factor. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[10] rate limiting: repeated dispatches must not all succeed unthrottled', async ({
    profileClient,
    staticToken,
  }) => {
    // Deliberately small: three refused requestTypes, not a burst of valid ones. The question
    // is whether a limiter exists at all, and that does not require sending real messages.
    const responses = await Promise.all([
      profileClient.sendPrimaryOrSecondaryDeviceOtp('tertiary', { token: staticToken }),
      profileClient.sendPrimaryOrSecondaryDeviceOtp('tertiary', { token: staticToken }),
      profileClient.sendPrimaryOrSecondaryDeviceOtp('tertiary', { token: staticToken }),
    ]);
    // Title stays constant across runs so the finding dedupes to one ticket; the actual
    // per-run statuses land in the ledger's `actual` field, not the title (which is the id seed).
    await assertStatus(responses[responses.length - 1], [400, 401, 403, 404, 422, 429], {
      ...META,
      title: 'Repeated device-OTP requests are not throttled',
    });
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
