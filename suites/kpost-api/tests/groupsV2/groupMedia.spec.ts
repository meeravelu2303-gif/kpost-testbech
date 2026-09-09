import { test, expect, EXPIRED_TOKEN, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import {
  GROUPS_V2_PATHS,
  GROUPS_V2_PATH_TEMPLATES,
} from '../../src/api/clients/groupsV2.client';
import { groupAckResponseSchema } from '../../src/api/schemas/groupsV2.schema';
import {
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatus,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildGroupMemberActionPayload,
  nonExistentGroupKpostId,
  pngFileBuffer,
  scriptFileBuffer,
} from '../../src/api/payloads/groupsV2.payload';
import { qaIdentifier } from '../../src/utils/safeTestData';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * Groups V2 — group avatar upload, removal and the two download routes.
 *
 * The spec is unusually direct about the risk here: for both write routes it says the
 * authorisation test "matters more here than for a personal image", because the avatar is
 * shared — an unauthorised change or clear is a **defacement vector** visible to every
 * member at once.
 *
 * The two download routes are declared `security: []` and listed as `permitAll`, so they are
 * public by design. They each take a **second path variable, `kpostID`**, which on an
 * unauthenticated route cannot be an authorisation check in any meaningful sense: anyone can
 * supply any member's id. The tests below establish what that segment actually gates.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /v2/group/updateGroupProfileImage  (multipart)
 * ====================================================================================== */
test.describe('POST /v2/group/updateGroupProfileImage', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.updateGroupProfileImage,
    repro: `await groupsV2Client.updateGroupProfileImage({ file: { name: 'avatar.png', mimeType: 'image/png', buffer: pngFileBuffer() } }, { token, params: { text: groupKpostID } });`,
  };

  const imagePart = () => ({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: pngFileBuffer(),
  });

  test('[1] happy path: a valid avatar upload satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    await expectValidContract(
      response,
      groupAckResponseSchema,
      META,
      [200, 400, 401, 403, 404, 415]
    );
  });

  test('[2] boundary: an oversized image must be refused, not streamed to S3', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const oversized = Buffer.alloc(12 * 1024 * 1024, 0x41);
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: { name: 'huge.png', mimeType: 'image/png', buffer: oversized } },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    expect(
      response.status(),
      `a 12 MB avatar produced HTTP ${response.status()}. Without a size cap this route is a storage-cost and denial-of-service surface, since the image is streamed to S3 before any group check.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 group identifier in the query is handled cleanly', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: UTF8_STRING } }
    );

    expect(
      response.status(),
      `a multi-byte UTF-8 group identifier produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: the "text" query parameter must be required', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'required query parameter "text" (the group identifier) omitted',
        repro: `await groupsV2Client.updateGroupProfileImage({ file }, { token }); // no text param`,
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3b] missing required parameter: the file part must be required', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { text: nonExistentGroupKpostId() },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'multipart request sent with no file part' },
      [400, 401, 403, 404, 415, 422]
    );
  });

  test('[4] null fuzzing: an empty group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: '' } }
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'query parameter "text" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: a zero-byte file must not be accepted as an avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) } },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'zero-byte file uploaded as a group avatar' },
      [400, 401, 403, 404, 415, 422]
    );
  });

  test('[5] type mismatch: a non-image payload must be rejected by content validation', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: { name: 'shell.php', mimeType: 'image/png', buffer: scriptFileBuffer() } },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );
    const { json, text } = await readBody(response);
    const stored = json !== null && json.statusCode === 200;

    expect(
      stored,
      `a PHP payload declaring itself as image/png was accepted as a group avatar. The file is streamed to S3 and its path stored, so accepting executable content on the strength of a client-supplied MIME type is a stored-payload risk — content must be validated by inspection, not by the declared type. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[6] XSS: a script payload in the group identifier must not be reflected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: XSS_PAYLOAD } }
    );

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology identifier must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: SQLI_PAYLOAD } }
    );

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: null, params: { text: nonExistentGroupKpostId() } }
    );

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must not replace a group avatar', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: EXPIRED_TOKEN, params: { text: nonExistentGroupKpostId() } }
    );

    await assertUnauthorized(response, META);
  });

  test('[8c] authorisation: a non-administrator must not change a group avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );
    const { json, text } = await readBody(response);
    const changed = json !== null && json.statusCode === 200;

    expect(
      changed,
      `an avatar upload succeeded against a group the caller does not administer. The spec is explicit that this authorisation test matters more than for a personal image: the change is visible to every member at once, so an unauthorised upload is a defacement vector. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.updateGroupProfileImage(
      { file: imagePart() },
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    await assertStatusCodeParity(response, META);
  });

  test('[10] structural: a JSON body on a multipart route must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(
      GROUPS_V2_PATHS.updateGroupProfileImage,
      JSON.stringify({ file: 'not-multipart' }),
      { token: staticToken, params: { text: nonExistentGroupKpostId() } }
    );

    expect(
      response.status(),
      `a JSON body on a multipart/form-data route produced HTTP ${response.status()}. A content-type mismatch is a client error and should be 400 or 415, never a 5xx.`
    ).toBeLessThan(500);
  });

  test('[10b] idempotency: concurrent uploads must not leave the avatar ambiguous', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const [first, second, third] = await Promise.all([
      groupsV2Client.updateGroupProfileImage(
        { file: imagePart() },
        { token: staticToken, params: { text: groupKpostID } }
      ),
      groupsV2Client.updateGroupProfileImage(
        { file: imagePart() },
        { token: staticToken, params: { text: groupKpostID } }
      ),
      groupsV2Client.updateGroupProfileImage(
        { file: imagePart() },
        { token: staticToken, params: { text: groupKpostID } }
      ),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent avatar uploads returned different statuses (${statuses.join(', ')}). Each upload writes a new S3 path onto the same group row, so a divergence means the last-writer outcome is not deterministic.`
    ).toBe(1);
  });

  test('[IDOR] a foreign groupID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { groupID: FOREIGN.groupID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.groupID)),
      `the response acknowledged groupID "${FOREIGN.groupID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/group/removeGroupProfileImage
 * ====================================================================================== */
test.describe('POST /v2/group/removeGroupProfileImage', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.removeGroupProfileImage,
    repro: `await groupsV2Client.removeGroupProfileImage(buildGroupMemberActionPayload(), { token });`,
  };

  test('[1] happy path: an avatar clear satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      groupAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: MAX_LENGTH_STRING });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character groupKpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 group identifier is handled without a server fault', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: UTF8_STRING });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 groupKpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostID" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    delete (payload as Record<string, unknown>).groupKpostID;

    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null group identifier must not clear an unrelated avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: null });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: '' });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a group identifier is expected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: { id: 1 } });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `groupKpostID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: XSS_PAYLOAD });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not clear every group avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the group identifier returned success. The route is implemented as an update-to-null, so an unparameterised value in the WHERE clause could blank the avatar on every group at once. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupProfileImage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ groupsV2Client }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] authorisation: a non-administrator must not clear a group avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: nonExistentGroupKpostId() });
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const cleared = json !== null && json.statusCode === 200;

    expect(
      cleared,
      `an avatar clear succeeded against a group the caller does not administer. The avatar reverts for all members, so an ordinary member clearing it is the same defacement vector as an unauthorised upload. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupProfileImage(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not clear an inferred avatar', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.removeGroupProfileImage({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the avatar-clear route. With no group named, success means the handler either inferred a target or reported success for a no-op. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(
      GROUPS_V2_PATHS.removeGroupProfileImage,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: clearing an already-cleared avatar must be stable', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const first = await groupsV2Client.removeGroupProfileImage(payload, { token: staticToken });
    const second = await groupsV2Client.removeGroupProfileImage(payload, { token: staticToken });

    expect(
      second.status(),
      `clearing the same avatar twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
  });

  test('[IDOR] a foreign groupID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { groupID: FOREIGN.groupID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.groupID)),
      `the response acknowledged groupID "${FOREIGN.groupID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/group/downloadGroupProfileImage/{groupKpostID}/{kpostID}   — public by design
 * ====================================================================================== */
test.describe('GET /v2/group/downloadGroupProfileImage/{groupKpostID}/{kpostID}', () => {
  const META = {
    method: 'GET',
    path: GROUPS_V2_PATH_TEMPLATES.downloadGroupProfileImage,
    repro: `await groupsV2Client.downloadGroupProfileImage(groupKpostID, kpostID, { token: null });`,
  };

  test('[1] happy path: the route answers a documented status without a token', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    // swagger documents 200 (image bytes) or 404 (no avatar). Anything else — the live API
    // answers 204 — is a contract deviation, so it is recorded rather than merely failed.
    await assertStatus(response, [200, 404], {
      ...META,
      title: 'Public avatar route answers an undocumented status',
      severity: 'Trivial',
    });
  });

  test('[2] boundary: an oversized group segment must not leak the S3 error verbatim', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      MAX_LENGTH_STRING,
      qaIdentifier('member'),
      { token: null }
    );

    // The oversized key is rejected by S3, and the handler returns the SDK error as-is.
    // That discloses the bucket's request identifiers to an anonymous caller, so the leak
    // assertion is the point of this case — the status check alone would understate it.
    await assertNoInternalLeak(response, META, MAX_LENGTH_STRING);

    expect(
      response.status(),
      `a 5000-character groupKpostID path segment produced HTTP ${response.status()}. An identifier too long to be a valid storage key must be rejected by input validation before any S3 call is attempted.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 path segment is handled without a server fault', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(UTF8_STRING, UTF8_STRING, {
      token: null,
    });

    expect(
      response.status(),
      `multi-byte UTF-8 path segments produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty group segment must not serve an image', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage('', qaIdentifier('member'), {
      token: null,
    });

    expect(
      response.status(),
      `an empty groupKpostID segment produced HTTP ${response.status()}. With no group named the route must 404 rather than resolve to a default object.`
    ).not.toBe(200);
  });

  test('[4] null fuzzing: a literal "null" group segment must not resolve', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage('null', 'null', {
      token: null,
    });

    expect(
      response.status(),
      `the literal string "null" in both path segments produced HTTP ${response.status()}.`
    ).not.toBe(200);
  });

  test('[5] type mismatch: a numeric group segment is handled cleanly', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage('12345', '67890', {
      token: null,
    });

    expect(
      response.status(),
      `numeric path segments produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      XSS_PAYLOAD,
      qaIdentifier('member'),
      { token: null }
    );

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in the path must not leak database internals', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      SQLI_PAYLOAD,
      qaIdentifier('member'),
      { token: null }
    );

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] public by design: the route must not demand authentication', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    expect(
      response.status(),
      `the route answered 401 without a token even though downloadGroupProfileImage/** is listed as permitAll in SecurityConfiguration and swagger.json declares security: []. Either the security config changed or the spec is now wrong; both break clients rendering group icons.`
    ).not.toBe(401);
  });

  test('[8b] public by design: a malformed token must not break the route', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: MALFORMED_TOKEN }
    );

    expect(
      response.status(),
      `a malformed Authorization header on a permitAll route produced HTTP ${response.status()}. A public route must ignore an irrelevant token rather than fault on it.`
    ).toBeLessThan(500);
  });

  test('[8c] the kpostID segment: an arbitrary member id must not unlock a private avatar', async ({
    groupsV2Client,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const asStranger = await groupsV2Client.downloadGroupProfileImage(
      groupKpostID,
      qaIdentifier('stranger'),
      { token: null }
    );
    const asVictim = await groupsV2Client.downloadGroupProfileImage(
      groupKpostID,
      VICTIM_KPOST_ID,
      { token: null }
    );

    expect(
      asVictim.status(),
      `supplying "${VICTIM_KPOST_ID}" as the kpostID path segment changed the outcome (HTTP ${asStranger.status()} for a stranger vs ${asVictim.status()}). On an unauthenticated route that second segment cannot be an authorisation check — anyone can supply any member's id — so if it gates access, the gate is decorative and the avatar is effectively public to anyone who can name a member.`
    ).toBe(asStranger.status());
  });

  test('[9] status misreporting: an image response must not carry a failure payload', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    await assertNot200OKOnError(response, META);
  });

  test('[9b] contract: a 200 must carry actual image bytes, not an empty body', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );
    test.skip(response.status() !== 200, 'no avatar served for this group');

    const body = await response.body();
    expect(
      body.length,
      `the route returned HTTP 200 with a zero-length body. A 200 on an image route tells the client an avatar exists; an empty payload then renders as a broken image rather than the default icon a 404 would produce.`
    ).toBeGreaterThan(0);
  });

  test('[10] structural: a path traversal attempt must not escape the S3 prefix', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupProfileImage(
      '../../../etc/passwd',
      qaIdentifier('member'),
      { token: null }
    );
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file. The identifier is used to resolve a stored S3 path, so it must be treated as an opaque key.`
    ).not.toContain('root:');
  });

  test('[10b] idempotency: three concurrent identical reads must agree', async ({
    groupsV2Client,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const memberId = qaIdentifier('member');
    const [first, second, third] = await Promise.all([
      groupsV2Client.downloadGroupProfileImage(groupKpostID, memberId, { token: null }),
      groupsV2Client.downloadGroupProfileImage(groupKpostID, memberId, { token: null }),
      groupsV2Client.downloadGroupProfileImage(groupKpostID, memberId, { token: null }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent image reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
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
 * GET /v2/group/downloadGroupFullProfileImage/{groupKpostID}/{kpostID}   — public by design
 * ====================================================================================== */
test.describe('GET /v2/group/downloadGroupFullProfileImage/{groupKpostID}/{kpostID}', () => {
  const META = {
    method: 'GET',
    path: GROUPS_V2_PATH_TEMPLATES.downloadGroupFullProfileImage,
    repro: `await groupsV2Client.downloadGroupFullProfileImage(groupKpostID, kpostID, { token: null });`,
  };

  test('[1] happy path: the route answers a documented status without a token', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    await assertStatus(response, [200, 404], {
      ...META,
      title: 'Public avatar route answers an undocumented status',
      severity: 'Trivial',
    });
  });

  test('[2] boundary: an oversized group segment must not leak the S3 error verbatim', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      MAX_LENGTH_STRING,
      qaIdentifier('member'),
      { token: null }
    );

    await assertNoInternalLeak(response, META, MAX_LENGTH_STRING);

    expect(
      response.status(),
      `a 5000-character groupKpostID path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 path segment is handled without a server fault', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      UTF8_STRING,
      UTF8_STRING,
      { token: null }
    );

    expect(
      response.status(),
      `multi-byte UTF-8 path segments produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty group segment must not serve an image', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      '',
      qaIdentifier('member'),
      { token: null }
    );

    expect(
      response.status(),
      `an empty groupKpostID segment produced HTTP ${response.status()}.`
    ).not.toBe(200);
  });

  test('[4] null fuzzing: a literal "null" group segment must not resolve', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage('null', 'null', {
      token: null,
    });

    expect(
      response.status(),
      `the literal string "null" in both path segments produced HTTP ${response.status()}.`
    ).not.toBe(200);
  });

  test('[5] type mismatch: a numeric group segment is handled cleanly', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage('12345', '67890', {
      token: null,
    });

    expect(
      response.status(),
      `numeric path segments produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      XSS_PAYLOAD,
      qaIdentifier('member'),
      { token: null }
    );

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in the path must not leak database internals', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      SQLI_PAYLOAD,
      qaIdentifier('member'),
      { token: null }
    );

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] public by design: the route must not demand authentication', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    expect(
      response.status(),
      `the route answered 401 without a token even though downloadGroupFullProfileImage/** is listed as permitAll and swagger.json declares security: [].`
    ).not.toBe(401);
  });

  // No token-validation case: swagger declares this route public (security: []).

  test('[8c] the kpostID segment: an arbitrary member id must not unlock a private avatar', async ({
    groupsV2Client,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const asStranger = await groupsV2Client.downloadGroupFullProfileImage(
      groupKpostID,
      qaIdentifier('stranger'),
      { token: null }
    );
    const asVictim = await groupsV2Client.downloadGroupFullProfileImage(
      groupKpostID,
      VICTIM_KPOST_ID,
      { token: null }
    );

    expect(
      asVictim.status(),
      `supplying "${VICTIM_KPOST_ID}" as the kpostID segment changed the outcome (HTTP ${asStranger.status()} vs ${asVictim.status()}). The same open question as the thumbnail route: on an unauthenticated endpoint that segment cannot be a real access check.`
    ).toBe(asStranger.status());
  });

  test('[9] status misreporting: an image response must not carry a failure payload', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );

    await assertNot200OKOnError(response, META);
  });

  test('[9b] contract: a 200 must carry actual image bytes, not an empty body', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      nonExistentGroupKpostId(),
      qaIdentifier('member'),
      { token: null }
    );
    test.skip(response.status() !== 200, 'no avatar served for this group');

    const body = await response.body();
    expect(
      body.length,
      `the route returned HTTP 200 with a zero-length body.`
    ).toBeGreaterThan(0);
  });

  test('[10] structural: a path traversal attempt must not escape the S3 prefix', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.downloadGroupFullProfileImage(
      '../../../etc/passwd',
      qaIdentifier('member'),
      { token: null }
    );
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file.`
    ).not.toContain('root:');
  });

  test('[10b] idempotency: three concurrent identical reads must agree', async ({
    groupsV2Client,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const memberId = qaIdentifier('member');
    const [first, second, third] = await Promise.all([
      groupsV2Client.downloadGroupFullProfileImage(groupKpostID, memberId, { token: null }),
      groupsV2Client.downloadGroupFullProfileImage(groupKpostID, memberId, { token: null }),
      groupsV2Client.downloadGroupFullProfileImage(groupKpostID, memberId, { token: null }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent image reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
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
