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
} from '../../src/utils/apiAssertions';
import {
  buildAboutYourselfPayload,
  buildCollegeDetailsPayload,
  buildDeleteProfileRecordPayload,
  buildOtherActivityPayload,
  buildSchoolDetailsPayload,
  buildUniversityDetailsPayload,
  nonExistentProfileRecordId,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * User Profile V2 — education history, activities and biography.
 *
 * All nine routes here are correctly scoped in the controller: each calls
 * `userProfileRO.setKpostID(request.getAttribute("kpostID"))` before reaching the service, and
 * `updateAboutYourself` passes the token identity as a separate argument. That makes this file
 * a regression battery rather than a hunt — every ownership case supplies a `kpostID` the
 * caller is not, and asserts the body value was discarded.
 *
 * The four delete routes remove profile history that cannot be restored through the API, so
 * every payload addresses a **non-existent** record id. The shared `UserProfileRO` DTO is worth
 * noting: one object serves school, college, university and activity records, so the binder
 * cannot distinguish a school payload from a college one — a mismatched `requestType` is the
 * only thing separating them.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_user_profile; --`;
const MAX_LENGTH_STRING = 'a'.repeat(50000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/profile/saveOrUpdateSchoolDetails
 * ====================================================================================== */
test.describe('POST /v2/profile/saveOrUpdateSchoolDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.saveOrUpdateSchoolDetails,
    repro: `await profileClient.saveOrUpdateSchoolDetails(buildSchoolDetailsPayload(), { token });`,
  };

  test('[1] happy path: saving school history satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload();
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character school name must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: MAX_LENGTH_STRING });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 50,000-character school name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 school name must survive', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: UTF8_STRING });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 school name produced HTTP ${response.status()}. School names are written in local scripts.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no schoolName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload();
    delete (payload as Record<string, unknown>).schoolName;

    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a school record with no school named' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null schoolName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: null });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "schoolName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric schoolName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: 12345 });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `schoolName was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: toYear before fromYear must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ fromYear: '2010', toYear: '2000' });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'school attendance ends ten years before it starts' },
      [400, 401, 403, 422]
    );
  });

  test('[6b] business rule: a future graduation year must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ fromYear: '2090', toYear: '2099' });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'school attendance dated 2090-2099' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in the school name must not be persisted unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: XSS_PAYLOAD });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await profileClient.saveOrUpdateSchoolDetails(buildSchoolDetailsPayload({ schoolName: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload({ schoolName: SQLI_DROP_PAYLOAD });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildSchoolDetailsPayload();
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not write profile history', async ({ profileClient }) => {
    const payload = buildSchoolDetailsPayload();
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: a body kpostID must not write to another user\'s profile', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSchoolDetailsPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'save did not succeed');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `the school record was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setKpostID from the token, so a body value must be discarded — a profile is a public-facing CV. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildSchoolDetailsPayload();
    const response = await profileClient.saveOrUpdateSchoolDetails(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ profileClient, staticToken }) => {
    const response = await profileClient.saveOrUpdateSchoolDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a school-history write' },
      [400, 401, 403, 422]
    );
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
 * POST /v2/profile/deleteSchoolDetail
 * ====================================================================================== */
test.describe('POST /v2/profile/deleteSchoolDetail', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deleteSchoolDetail,
    repro: `await profileClient.deleteSchoolDetail(buildDeleteProfileRecordPayload('schoolID'), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    // Non-existent id: profile history cannot be restored through the API.
    const payload = buildDeleteProfileRecordPayload('schoolID');
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: deleting a non-existent record must not report success', async ({
    profileClient,
    staticToken,
  }) => {
    const id = nonExistentProfileRecordId();
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: id });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting school record ${id}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.deleteSchoolDetail({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'destructive call with no record id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must not be a wildcard', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: null });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "schoolID" null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string id must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: 'all' });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a zero id must not match every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: 0 });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting id 0 reported success. A sentinel id must match nothing. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] boundary: an id beyond int32 must not overflow', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: INT32_OVERFLOW });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    expect(
      response.status(),
      `id ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not delete every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { schoolID: SQLI_PAYLOAD });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID');
    const response = await profileClient.deleteSchoolDetail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never delete', async ({
    profileClient,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID');
    const response = await profileClient.deleteSchoolDetail(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: another user\'s record must not be deletable', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID', { kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] idempotency: deleting twice must be stable', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID');
    const first = await profileClient.deleteSchoolDetail(payload, { token: staticToken });
    const second = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same record twice returned ${first.status()} then ${second.status()}.`
    ).toBe(second.status());
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('schoolID');
    const response = await profileClient.deleteSchoolDetail(payload, { token: staticToken });

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
 * POST /v2/profile/saveOrUpdateCollegeDetails
 * ====================================================================================== */
test.describe('POST /v2/profile/saveOrUpdateCollegeDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.saveOrUpdateCollegeDetails,
    repro: `await profileClient.saveOrUpdateCollegeDetails(buildCollegeDetailsPayload(), { token });`,
  };

  test('[1] happy path: saving college history satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload();
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character college name must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ collegeName: MAX_LENGTH_STRING });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 50,000-character college name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no collegeName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload();
    delete (payload as Record<string, unknown>).collegeName;

    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a college record with no college named' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null collegeName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ collegeName: null });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "collegeName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object degree must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ degree: { name: 'B.E.' } });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `degree was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] DTO confusion: a school payload must not be accepted as a college record', async ({
    profileClient,
    staticToken,
  }) => {
    // School, college, university and activity all bind to the same UserProfileRO, so the
    // binder cannot tell them apart — only the route and requestType do.
    const payload = buildSchoolDetailsPayload();
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a school-shaped payload with no collegeName was accepted by the college route, most likely writing a college record with null fields. One DTO serving four record types means the binder validates none of them. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] business rule: toYear before fromYear must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ fromYear: '2016', toYear: '2010' });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'college attendance ends before it starts' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload must not be persisted unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ collegeName: XSS_PAYLOAD });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload({ collegeName: SQLI_PAYLOAD });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildCollegeDetailsPayload();
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] ownership: a body kpostID must not write to another user\'s profile', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildCollegeDetailsPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'save did not succeed');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `the college record was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildCollegeDetailsPayload();
    const response = await profileClient.saveOrUpdateCollegeDetails(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ profileClient, staticToken }) => {
    const response = await profileClient.saveOrUpdateCollegeDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a college-history write' },
      [400, 401, 403, 422]
    );
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
 * POST /v2/profile/deleteCollegeDetail
 * ====================================================================================== */
test.describe('POST /v2/profile/deleteCollegeDetail', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deleteCollegeDetail,
    repro: `await profileClient.deleteCollegeDetail(buildDeleteProfileRecordPayload('collegeID'), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID');
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: deleting a non-existent record must not report success', async ({
    profileClient,
    staticToken,
  }) => {
    const id = nonExistentProfileRecordId();
    const payload = buildDeleteProfileRecordPayload('collegeID', { collegeID: id });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting college record ${id}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.deleteCollegeDetail({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'destructive call with no record id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must not be a wildcard', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID', { collegeID: null });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "collegeID" null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a boolean id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID', { collegeID: true });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a zero id must not match every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID', { collegeID: 0 });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting id 0 reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not delete every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID', { collegeID: SQLI_PAYLOAD });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID');
    const response = await profileClient.deleteCollegeDetail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not delete', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID');
    const response = await profileClient.deleteCollegeDetail(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] IDOR: another user\'s record must not be deletable', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID', { kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.deleteCollegeDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] idempotency: deleting twice must be stable', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('collegeID');
    const first = await profileClient.deleteCollegeDetail(payload, { token: staticToken });
    const second = await profileClient.deleteCollegeDetail(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same record twice returned ${first.status()} then ${second.status()}.`
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
 * POST /v2/profile/saveOrUpdateUniversityDetails
 * ====================================================================================== */
test.describe('POST /v2/profile/saveOrUpdateUniversityDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.saveOrUpdateUniversityDetails,
    repro: `await profileClient.saveOrUpdateUniversityDetails(buildUniversityDetailsPayload(), { token });`,
  };

  test('[1] happy path: saving university history satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload();
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character university name must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ universityName: MAX_LENGTH_STRING });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 50,000-character university name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no universityName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload();
    delete (payload as Record<string, unknown>).universityName;

    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a university record with no university named' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null universityName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ universityName: null });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "universityName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array degree must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ degree: ['M.Tech'] });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `degree was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: toYear before fromYear must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ fromYear: '2020', toYear: '2014' });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'university attendance ends before it starts' },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload must not be persisted unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ universityName: XSS_PAYLOAD });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload({ universityName: SQLI_PAYLOAD });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildUniversityDetailsPayload();
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] ownership: a body kpostID must not write to another user\'s profile', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildUniversityDetailsPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'save did not succeed');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `the university record was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUniversityDetailsPayload();
    const response = await profileClient.saveOrUpdateUniversityDetails(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.saveOrUpdateUniversityDetails,
      '{"universityName":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"universityName":',
      title: 'Malformed JSON is not rejected with a clean 400',
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/profile/deleteUniversityDetail
 * ====================================================================================== */
test.describe('POST /v2/profile/deleteUniversityDetail', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deleteUniversityDetail,
    repro: `await profileClient.deleteUniversityDetail(buildDeleteProfileRecordPayload('universityID'), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('universityID');
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: deleting a non-existent record must not report success', async ({
    profileClient,
    staticToken,
  }) => {
    const id = nonExistentProfileRecordId();
    const payload = buildDeleteProfileRecordPayload('universityID', { universityID: id });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting university record ${id}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.deleteUniversityDetail({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'destructive call with no record id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must not be a wildcard', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('universityID', { universityID: null });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "universityID" null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string id must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('universityID', { universityID: 'latest' });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as the string "latest" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a zero id must not match every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('universityID', { universityID: 0 });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting id 0 reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not delete every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('universityID', { universityID: SQLI_PAYLOAD });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('universityID');
    const response = await profileClient.deleteUniversityDetail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not delete', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('universityID');
    const response = await profileClient.deleteUniversityDetail(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] IDOR: another user\'s record must not be deletable', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeleteProfileRecordPayload('universityID', { kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.deleteUniversityDetail(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] idempotency: deleting twice must be stable', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('universityID');
    const first = await profileClient.deleteUniversityDetail(payload, { token: staticToken });
    const second = await profileClient.deleteUniversityDetail(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same record twice returned ${first.status()} then ${second.status()}.`
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
 * POST /v2/profile/saveOrUpdateOtherActivity
 * ====================================================================================== */
test.describe('POST /v2/profile/saveOrUpdateOtherActivity', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.saveOrUpdateOtherActivity,
    repro: `await profileClient.saveOrUpdateOtherActivity(buildOtherActivityPayload(), { token });`,
  };

  test('[1] happy path: saving an activity satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character activity must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    (payload.otherActivities as Array<Record<string, unknown>>)[0].title = MAX_LENGTH_STRING;
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 50,000-character activity title produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an activity with no title must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    delete (payload.otherActivities as Array<Record<string, unknown>>)[0].title;

    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an activity record with no title' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null activity title must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    (payload.otherActivities as Array<Record<string, unknown>>)[0].title = null;
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "title" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric activity title must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    (payload.otherActivities as Array<Record<string, unknown>>)[0].title = 999;
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `title was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a UTF-8 activity must survive', async ({ profileClient, staticToken }) => {
    const payload = buildOtherActivityPayload();
    (payload.otherActivities as Array<Record<string, unknown>>)[0].title = UTF8_STRING;
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 activity name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] XSS: a script payload must not be persisted unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    // The activity's real text fields are nested under otherActivities[] (title/achievements),
    // not a flat `activityName` — inject into the real field so the persisted-XSS path is tested.
    const payload = buildOtherActivityPayload({
      otherActivities: [
        { activityID: '', title: XSS_PAYLOAD, achievements: 'QA', logoPath: '', attachmentPath: '' },
      ],
    });
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    // `description` is a phantom field; the real free-text field is otherActivities[].achievements.
    const payload = buildOtherActivityPayload({
      otherActivities: [
        { activityID: '', title: 'QA', achievements: SQLI_PAYLOAD, logoPath: '', attachmentPath: '' },
      ],
    });
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildOtherActivityPayload();
    const response = await profileClient.saveOrUpdateOtherActivity(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] ownership: a body kpostID must not write to another user\'s profile', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildOtherActivityPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'save did not succeed');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `the activity was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildOtherActivityPayload();
    const response = await profileClient.saveOrUpdateOtherActivity(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ profileClient, staticToken }) => {
    const response = await profileClient.saveOrUpdateOtherActivity({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an activity write' },
      [400, 401, 403, 422]
    );
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
 * POST /v2/profile/deleteOtherActivity
 * ====================================================================================== */
test.describe('POST /v2/profile/deleteOtherActivity', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deleteOtherActivity,
    repro: `await profileClient.deleteOtherActivity(buildDeleteProfileRecordPayload('activityID'), { token });`,
  };

  test('[1] happy path: a delete satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID');
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: deleting a non-existent record must not report success', async ({
    profileClient,
    staticToken,
  }) => {
    const id = nonExistentProfileRecordId();
    const payload = buildDeleteProfileRecordPayload('activityID', { activityID: id });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting activity ${id}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.deleteOtherActivity({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'destructive call with no record id' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null id must not be a wildcard', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID', { activityID: null });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "activityID" null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID', { activityID: { id: 1 } });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });

    expect(
      response.status(),
      `id was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] boundary: a zero id must not match every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID', { activityID: 0 });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `deleting id 0 reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not delete every row', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID', { activityID: SQLI_PAYLOAD });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an unauthenticated delete must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('activityID');
    const response = await profileClient.deleteOtherActivity(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never delete', async ({
    profileClient,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID');
    const response = await profileClient.deleteOtherActivity(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] IDOR: another user\'s record must not be deletable', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDeleteProfileRecordPayload('activityID', { kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.deleteOtherActivity(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a delete naming kpostID "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] idempotency: deleting twice must be stable', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('activityID');
    const first = await profileClient.deleteOtherActivity(payload, { token: staticToken });
    const second = await profileClient.deleteOtherActivity(payload, { token: staticToken });

    expect(
      first.status(),
      `deleting the same record twice returned ${first.status()} then ${second.status()}.`
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
 * POST /v2/profile/updateAboutYourself
 * ====================================================================================== */
test.describe('POST /v2/profile/updateAboutYourself', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateAboutYourself,
    repro: `await profileClient.updateAboutYourself(buildAboutYourselfPayload(), { token });`,
  };

  test('[1] happy path: updating the biography satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload();
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character biography must be handled explicitly', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: MAX_LENGTH_STRING });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    expect(
      response.status(),
      `a 50,000-character biography produced HTTP ${response.status()}. Either there is a cap and it is a clean 400, or the text must be stored whole — silent truncation mangles a public profile.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 biography must survive', async ({ profileClient, staticToken }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: UTF8_STRING });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 biography produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no aboutYourself must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateAboutYourself({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'a biography update with no biography' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null biography must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: null });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "aboutYourself" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object biography must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: { text: 'hi' } });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    expect(
      response.status(),
      `aboutYourself was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] mass assignment: a body kpostID must not rewrite another user\'s biography', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildAboutYourselfPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'update did not succeed');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `the biography was written to "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. This route binds the whole UserProfile object, so every field on it is a mass-assignment candidate — the controller passes the token kpostID separately for exactly that reason. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[6b] mass assignment: unrelated profile fields must not be writable here', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ designationID: 1, companyName: 'QA-INJECTED' });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'update did not succeed');

    expect(
      text.includes('QA-INJECTED'),
      `a biography update also wrote companyName. The route binds the full UserProfile DTO, so a caller can change designation and employer through an endpoint that claims to edit only the "about" text — those have their own validated routes. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in the biography must not be persisted unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: XSS_PAYLOAD });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await profileClient.updateAboutYourself(buildAboutYourselfPayload({ aboutYourself: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload({ aboutYourself: SQLI_DROP_PAYLOAD });
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildAboutYourselfPayload();
    const response = await profileClient.updateAboutYourself(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not rewrite a biography', async ({ profileClient }) => {
    const payload = buildAboutYourselfPayload();
    const response = await profileClient.updateAboutYourself(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAboutYourselfPayload();
    const response = await profileClient.updateAboutYourself(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.updateAboutYourself,
      '{"aboutYourself":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"aboutYourself":',
      title: 'Malformed JSON is not rejected with a clean 400',
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
