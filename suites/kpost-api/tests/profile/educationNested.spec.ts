import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { profileMutationResponseSchema } from '../../src/api/schemas/profile.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
} from '../../src/utils/apiAssertions';
import {
  buildUpdateCollegeDetailsPayload,
  buildUpdateSchoolDetailsPayload,
  buildUpdateUniversityDetailsPayload,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * User Profile V2 — the **nested** education family (Excel rows 107-109).
 *
 * `updateSchoolDetails`, `updateCollegeDetails` and `updateUniversityDetails` are a second,
 * distinct family alongside the `saveOrUpdate*Details` routes covered in `education.spec.ts`.
 * They are not aliases and they do not share a DTO:
 *
 * | family                  | shape                                                          |
 * | ----------------------- | -------------------------------------------------------------- |
 * | `saveOrUpdate*Details`  | flat `UserProfileRO`, discriminated by `requestType`             |
 * | `update*Details` (here) | an ARRAY of records under a per-type key, each with the row id   |
 *
 * The nested form additionally carries `course` / `standard` / `field`, a free-text `about`, and
 * an `attachmentPath` list of uploaded-file uuids — fields the flat DTO has no place for. All
 * three routes were **entirely untested** until this file: they are in the workbook as mandatory
 * and nothing in the bench referenced them.
 *
 * ## All three are UNDEPLOYED on 192.168.0.66 (verified 2026-09-10)
 *
 * Each answers **404 to a valid token**, so every case below is guarded by `skipIfUndeployed`.
 * That guard is the point of the file, not a workaround: "must be < 500", "must be 401/403" and
 * "must not reflect script" all pass trivially against a 404, so without it this file would
 * report a screen of green while testing nothing. A skip states the truth; a pass would launder
 * a missing endpoint into evidence of a working one. The `[deployment]` case in each block
 * reports the 404 itself as the finding.
 *
 * ## Why three near-identical blocks rather than one loop
 *
 * Both gates read `test.describe('<literal>')` and the builder calls inside it. A table-driven
 * loop hides the endpoint behind a template literal and the payload behind `route.build()`, so
 * the vector gate stops counting these endpoints entirely and the Excel gate reports all ten
 * documented fields as never sent — a false finding against code that does send them. The
 * duplication buys measurable, truthful coverage, and it matches `education.spec.ts` next door.
 *
 * ## Safety
 *
 * Every record id addresses a **non-existent** row. These are updates to profile history the API
 * offers no way to restore, so a payload that resolved to a real record would destroy data the
 * other profile specs depend on.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(50000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/** Statuses that prove a route EXISTS. Anything else (404 above all) means it does not. */
const REACHABLE_STATUSES = [200, 201, 204, 400, 401, 403, 405, 415, 422];

/**
 * Marks a case skipped rather than letting it pass green against an undeployed route.
 *
 * 429 stands down too: under full-suite load this API throttles, and a throttled response
 * describes our request rate rather than the endpoint, so judging it either way is noise.
 */
const skipIfUndeployed = (status: number, path: string): void => {
  test.skip(
    status === 404,
    `${path} is not deployed on this environment (404 with a valid token) — see the [deployment] case`
  );
  test.skip(
    status === 429,
    `${path}: throttled (HTTP 429) — the response describes our request rate, not the endpoint`
  );
};

/* =========================================================================================
 * POST /v2/profile/updateSchoolDetails   (Excel row 108)
 * ====================================================================================== */
test.describe('POST /v2/profile/updateSchoolDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateSchoolDetails,
    repro: `await profileClient.updateSchoolDetails(buildUpdateSchoolDetailsPayload(), { token });`,
  };

  test('[deployment] /v2/profile/updateSchoolDetails must be reachable with a valid token', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The workbook lists this route as mandatory, so a 404 is a deployment gap worth a ticket
     * rather than something to route around quietly. This case is what turns the silence into
     * a finding — and it is why the rest of the block may honestly skip.
     */
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });

    /*
     * Asserted POSITIVELY — the route must answer something that proves it EXISTS — rather than
     * as `.not.toBe(404)`. The negative form passes on ANY other status, and under full-suite
     * load this API returns 429: written that way, this case went green in a full run while the
     * route was still missing, which is the exact vacuous pass the file exists to prevent.
     */
    test.skip(
      response.status() === 429,
      'throttled (HTTP 429) — a rate limit cannot be told apart from a missing route'
    );

    expect(
      REACHABLE_STATUSES.includes(response.status()),
      `/v2/profile/updateSchoolDetails is documented as mandatory in the API workbook (Excel row 108) but answers HTTP ${response.status()} to a valid token. Either it was never deployed to this environment or it has been renamed and the workbook is stale — both need a developer answer, because clients built from the workbook will call it.`
    ).toBe(true);
  });

  test('[1] happy path: a nested school update satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character schoolName must not fault', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    (payload.schoolDetails as Array<Record<string, unknown>>)[0].schoolName = MAX_LENGTH_STRING;
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a 50,000-character schoolName produced HTTP ${response.status()}. It must be truncated or refused by the validator, not by the column definition.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 schoolName must survive', async ({ profileClient, staticToken }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    (payload.schoolDetails as Array<Record<string, unknown>>)[0].schoolName = UTF8_STRING;
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a multi-byte UTF-8 schoolName produced HTTP ${response.status()}. Institution names are written in local scripts.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an empty schoolDetails array must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = { schoolDetails: [] };
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an update carrying no school records — it addresses nothing' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null schoolName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    (payload.schoolDetails as Array<Record<string, unknown>>)[0].schoolName = null;
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "schoolName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[typefuzz] the schoolDetails envelope sent as a scalar must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The documented shape is an array of records. A bare string where the collection belongs
     * is the natural mistake a hand-written client makes, and it must produce a clean 400
     * rather than a binder stack trace.
     */
    const payload = { schoolDetails: 'not-an-array' };
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `schoolDetails sent as a string produced HTTP ${response.status()}. A type mismatch is a 400, not a fault.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the schoolName must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    (payload.schoolDetails as Array<Record<string, unknown>>)[0].schoolName = XSS_PAYLOAD;
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    (payload.schoolDetails as Array<Record<string, unknown>>)[0].schoolName = SQLI_PAYLOAD;
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be 401/403', async ({
    profileClient,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: a malformed token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] auth: an alg=none forged token must not rewrite school history', async ({
    profileClient,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status parity: the HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateSchoolDetailsPayload();
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a body-supplied kpostID must not rewrite another user's school history", async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The controller is expected to take the owner from the token. Verdict is on
     * ACKNOWLEDGEMENT, not the status code: a correct implementation may answer 200 having
     * ignored the foreign id entirely, and demanding 403 would flag that as a defect. What is
     * never safe is the foreign identifier coming back — that means it reached the lookup.
     */
    const payload = { ...buildUpdateSchoolDetailsPayload(), kpostID: VICTIM_KPOST_ID };
    const response = await profileClient.updateSchoolDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      what: 'kpostID',
      foreignValue: VICTIM_KPOST_ID,
    });
  });
});

/* =========================================================================================
 * POST /v2/profile/updateCollegeDetails   (Excel row 107)
 * ====================================================================================== */
test.describe('POST /v2/profile/updateCollegeDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateCollegeDetails,
    repro: `await profileClient.updateCollegeDetails(buildUpdateCollegeDetailsPayload(), { token });`,
  };

  test('[deployment] /v2/profile/updateCollegeDetails must be reachable with a valid token', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The workbook lists this route as mandatory, so a 404 is a deployment gap worth a ticket
     * rather than something to route around quietly. This case is what turns the silence into
     * a finding — and it is why the rest of the block may honestly skip.
     */
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });

    /*
     * Asserted POSITIVELY — the route must answer something that proves it EXISTS — rather than
     * as `.not.toBe(404)`. The negative form passes on ANY other status, and under full-suite
     * load this API returns 429: written that way, this case went green in a full run while the
     * route was still missing, which is the exact vacuous pass the file exists to prevent.
     */
    test.skip(
      response.status() === 429,
      'throttled (HTTP 429) — a rate limit cannot be told apart from a missing route'
    );

    expect(
      REACHABLE_STATUSES.includes(response.status()),
      `/v2/profile/updateCollegeDetails is documented as mandatory in the API workbook (Excel row 107) but answers HTTP ${response.status()} to a valid token. Either it was never deployed to this environment or it has been renamed and the workbook is stale — both need a developer answer, because clients built from the workbook will call it.`
    ).toBe(true);
  });

  test('[1] happy path: a nested college update satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character collegeName must not fault', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    (payload.collegeDetails as Array<Record<string, unknown>>)[0].collegeName = MAX_LENGTH_STRING;
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a 50,000-character collegeName produced HTTP ${response.status()}. It must be truncated or refused by the validator, not by the column definition.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 collegeName must survive', async ({ profileClient, staticToken }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    (payload.collegeDetails as Array<Record<string, unknown>>)[0].collegeName = UTF8_STRING;
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a multi-byte UTF-8 collegeName produced HTTP ${response.status()}. Institution names are written in local scripts.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an empty collegeDetails array must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = { collegeDetails: [] };
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an update carrying no college records — it addresses nothing' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null collegeName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    (payload.collegeDetails as Array<Record<string, unknown>>)[0].collegeName = null;
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "collegeName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[typefuzz] the collegeDetails envelope sent as a scalar must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The documented shape is an array of records. A bare string where the collection belongs
     * is the natural mistake a hand-written client makes, and it must produce a clean 400
     * rather than a binder stack trace.
     */
    const payload = { collegeDetails: 'not-an-array' };
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `collegeDetails sent as a string produced HTTP ${response.status()}. A type mismatch is a 400, not a fault.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the collegeName must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    (payload.collegeDetails as Array<Record<string, unknown>>)[0].collegeName = XSS_PAYLOAD;
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    (payload.collegeDetails as Array<Record<string, unknown>>)[0].collegeName = SQLI_PAYLOAD;
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be 401/403', async ({
    profileClient,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: a malformed token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] auth: an alg=none forged token must not rewrite college history', async ({
    profileClient,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status parity: the HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateCollegeDetailsPayload();
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a body-supplied kpostID must not rewrite another user's college history", async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The controller is expected to take the owner from the token. Verdict is on
     * ACKNOWLEDGEMENT, not the status code: a correct implementation may answer 200 having
     * ignored the foreign id entirely, and demanding 403 would flag that as a defect. What is
     * never safe is the foreign identifier coming back — that means it reached the lookup.
     */
    const payload = { ...buildUpdateCollegeDetailsPayload(), kpostID: VICTIM_KPOST_ID };
    const response = await profileClient.updateCollegeDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      what: 'kpostID',
      foreignValue: VICTIM_KPOST_ID,
    });
  });
});

/* =========================================================================================
 * POST /v2/profile/updateUniversityDetails   (Excel row 109)
 * ====================================================================================== */
test.describe('POST /v2/profile/updateUniversityDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateUniversityDetails,
    repro: `await profileClient.updateUniversityDetails(buildUpdateUniversityDetailsPayload(), { token });`,
  };

  test('[deployment] /v2/profile/updateUniversityDetails must be reachable with a valid token', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The workbook lists this route as mandatory, so a 404 is a deployment gap worth a ticket
     * rather than something to route around quietly. This case is what turns the silence into
     * a finding — and it is why the rest of the block may honestly skip.
     */
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });

    /*
     * Asserted POSITIVELY — the route must answer something that proves it EXISTS — rather than
     * as `.not.toBe(404)`. The negative form passes on ANY other status, and under full-suite
     * load this API returns 429: written that way, this case went green in a full run while the
     * route was still missing, which is the exact vacuous pass the file exists to prevent.
     */
    test.skip(
      response.status() === 429,
      'throttled (HTTP 429) — a rate limit cannot be told apart from a missing route'
    );

    expect(
      REACHABLE_STATUSES.includes(response.status()),
      `/v2/profile/updateUniversityDetails is documented as mandatory in the API workbook (Excel row 109) but answers HTTP ${response.status()} to a valid token. Either it was never deployed to this environment or it has been renamed and the workbook is stale — both need a developer answer, because clients built from the workbook will call it.`
    ).toBe(true);
  });

  test('[1] happy path: a nested university update satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] boundary: a 50,000-character universityName must not fault', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    (payload.universityDetails as Array<Record<string, unknown>>)[0].universityName = MAX_LENGTH_STRING;
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a 50,000-character universityName produced HTTP ${response.status()}. It must be truncated or refused by the validator, not by the column definition.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 universityName must survive', async ({ profileClient, staticToken }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    (payload.universityDetails as Array<Record<string, unknown>>)[0].universityName = UTF8_STRING;
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `a multi-byte UTF-8 universityName produced HTTP ${response.status()}. Institution names are written in local scripts.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an empty universityDetails array must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = { universityDetails: [] };
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an update carrying no university records — it addresses nothing' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null universityName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    (payload.universityDetails as Array<Record<string, unknown>>)[0].universityName = null;
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "universityName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[typefuzz] the universityDetails envelope sent as a scalar must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The documented shape is an array of records. A bare string where the collection belongs
     * is the natural mistake a hand-written client makes, and it must produce a clean 400
     * rather than a binder stack trace.
     */
    const payload = { universityDetails: 'not-an-array' };
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    expect(
      response.status(),
      `universityDetails sent as a string produced HTTP ${response.status()}. A type mismatch is a 400, not a fault.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the universityName must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    (payload.universityDetails as Array<Record<string, unknown>>)[0].universityName = XSS_PAYLOAD;
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    (payload.universityDetails as Array<Record<string, unknown>>)[0].universityName = SQLI_PAYLOAD;
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be 401/403', async ({
    profileClient,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: a malformed token must be refused', async ({ profileClient }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] auth: an alg=none forged token must not rewrite university history', async ({
    profileClient,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status parity: the HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildUpdateUniversityDetailsPayload();
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test("[IDOR] a body-supplied kpostID must not rewrite another user's university history", async ({
    profileClient,
    staticToken,
  }) => {
    /*
     * The controller is expected to take the owner from the token. Verdict is on
     * ACKNOWLEDGEMENT, not the status code: a correct implementation may answer 200 having
     * ignored the foreign id entirely, and demanding 403 would flag that as a defect. What is
     * never safe is the foreign identifier coming back — that means it reached the lookup.
     */
    const payload = { ...buildUpdateUniversityDetailsPayload(), kpostID: VICTIM_KPOST_ID };
    const response = await profileClient.updateUniversityDetails(payload, { token: staticToken });
    skipIfUndeployed(response.status(), META.path);

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      what: 'kpostID',
      foreignValue: VICTIM_KPOST_ID,
    });
  });
});
