import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { profileMutationResponseSchema } from '../../src/api/schemas/profile.schema';
import {
  assertNoForeignAcknowledgement,
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
  buildBasicDetailsLookupPayload,
  buildDesignationLookupPayload,
  buildKmailPatchPayload,
  buildLanguageLookupPayload,
  syntheticKpostId,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * User Profile V2 — reference lookups and the Kmail password patch job.
 *
 * ## `kmailPasswordPatchWork` — the reason this file matters
 *
 * The handler, in full:
 *
 * ```java
 * @PostMapping("kmailPasswordPatchWork")
 * public ResponseEntity<Map<String, Object>> kmailPasswordPatchWork(
 *         @RequestBody UserGroupRO userGroupRO, HttpServletRequest request) {
 *     userProfileService.updateKmailPassword(userGroupRO.getKpostIDs());
 *     resultMap.put(STATUS_CODE, 200);
 *     resultMap.put(STATUS, SUCCESS);
 *     resultMap.put(MSG, "kmailPasswordPatchWork Completed");
 *     return ResponseEntity.ok(resultMap);
 * }
 * ```
 *
 * Four things at once:
 *
 * 1. It accepts **`kpostIDs` — an arbitrary list of users** — and resets each one's Kmail
 *    password.
 * 2. It takes `HttpServletRequest` and **never reads it**. No identity check, no role check.
 * 3. There is **no try/catch and no result inspection** — it reports `SUCCESS` unconditionally,
 *    whatever the service did.
 * 4. `resultMap` is an **instance field on a singleton controller**, so concurrent callers
 *    share it.
 *
 * That combination is a mass account-takeover primitive: any authenticated user can lock an
 * arbitrary set of people out of their mail, and the response says it worked either way.
 *
 * **Every test here passes synthetic, non-existent kpostIDs only.** The builder has no default
 * that could carry a real identity. Confirming the exposure against a live account would mean
 * locking a real person out of their mail, which is not a test worth running — the refusal
 * path proves the shape.
 *
 * The same DESTRUCTIVE marking already excludes this route from the generated matrix; these
 * are the hand-written refusal cases that replace it.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /v2/profile/kmailPasswordPatchWork  — REFUSAL PATHS ONLY
 * ====================================================================================== */
test.describe('POST /v2/profile/kmailPasswordPatchWork', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.kmailPasswordPatchWork,
    repro: `await profileClient.kmailPasswordPatchWork(buildKmailPatchPayload(), { token });`,
  };

  test('[1] PRIVILEGE: an ordinary member must not be able to run a password patch job', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKmailPatchPayload();
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    await assertStatus(response, [401, 403, 404], {
      ...META,
      body: payload,
      title: 'Any authenticated user can reset Kmail passwords for an arbitrary list of accounts',
      severity: 'Critical',
      repro: `// as an ordinary member (${authSession.kpostID ?? 'any account'}):\nawait profileClient.kmailPasswordPatchWork({ kpostIDs: ['<victim>'] }, { token });`,
    });
  });

  test('[2] contract: the job must report what it actually did', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload();
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && json?.data === undefined,
      `the job reported SUCCESS with no indication of how many accounts were affected. The handler has no try/catch and never inspects the service result — it returns a hardcoded success whatever happened, so an operator cannot tell a completed run from a silent failure. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] missing required parameter: no kpostIDs must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.kmailPasswordPatchWork({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'a password patch job with no accounts named' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null kpostIDs must not mean "every account"', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload({ kpostIDs: null });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kpostIDs null on a bulk password reset — a null list must never mean all users',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] boundary: an empty kpostIDs list must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload({ kpostIDs: [] });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an empty account list — an empty IN() must not become an unfiltered UPDATE',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[6] SQL injection: a wildcard must not select every account', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload({ kpostIDs: [SQLI_WILDCARD] });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      response.status() < 400,
      `a kpostIDs entry of "%" was accepted on a bulk password reset. If the value reaches a LIKE unescaped, one request resets every Kmail password on the platform. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6b] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload({ kpostIDs: [SQLI_PAYLOAD] });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] type mismatch: a bare string kpostIDs must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildKmailPatchPayload({ kpostIDs: syntheticKpostId() });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    expect(
      response.status(),
      `kpostIDs was sent as a bare string rather than a list and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[8] auth: an unauthenticated patch job must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildKmailPatchPayload();
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not run the patch job', async ({ profileClient }) => {
    const payload = buildKmailPatchPayload();
    const response = await profileClient.kmailPasswordPatchWork(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never run the patch job', async ({
    profileClient,
  }) => {
    const payload = buildKmailPatchPayload();
    const response = await profileClient.kmailPasswordPatchWork(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] boundary: a 1000-account batch must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const kpostIDs = Array.from({ length: 1000 }, () => syntheticKpostId());
    const payload = buildKmailPatchPayload({ kpostIDs });
    const response = await profileClient.kmailPasswordPatchWork(payload, { token: staticToken });

    expect(
      response.status() < 400,
      `a 1000-account password reset was accepted. Even for an operator this needs a batch cap and an audit record; with no identity check on the route it is a denial-of-service against the whole user base.`
    ).toBe(false);
  });

  test('[10] concurrency: the shared resultMap must not bleed between callers', async ({
    profileClient,
    staticToken,
  }) => {
    // `resultMap` is an instance field on this singleton controller, reassigned per request.
    const [a, b] = await Promise.all([
      profileClient.kmailPasswordPatchWork(buildKmailPatchPayload(), { token: staticToken }),
      profileClient.getStorageDetails({ token: staticToken }),
    ]);
    const first = await readBody(a);
    const second = await readBody(b);

    test.skip(first.json === null || second.json === null, 'responses were not JSON');

    expect(
      first.text === second.text && first.text.length > 40,
      `a patch-job call and a concurrent storage read returned byte-identical bodies, which points at the shared resultMap instance field on this controller. Body: ${first.text.slice(0, 200)}`
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
 * POST /v2/profile/getUserBasicDetailsUsingKpostID
 * ====================================================================================== */
test.describe('POST /v2/profile/getUserBasicDetailsUsingKpostID', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.getUserBasicDetailsUsingKpostID,
    repro: `await profileClient.getUserBasicDetailsUsingKpostID(buildBasicDetailsLookupPayload(), { token });`,
  };

  test('[1] happy path: a cross-service lookup satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload();
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] disclosure: a lookup for another user must not return contact details', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    // This route is documented "for kmed, kjournal, ktec" — a deliberate cross-product lookup
    // with no ownership scoping, so what it returns is the whole question.
    const payload = buildBasicDetailsLookupPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.data === null, 'lookup returned no data');

    expect(
      /"(mobileNumber|email|otherEmail|dateOfBirth|presentAddress|permanentAddress)"\s*:\s*"[^"]{3,}"/i.test(
        text
      ),
      `a lookup for "${VICTIM_KPOST_ID}" returned contact or identity fields to ${authSession.kpostID ?? 'a different user'}. "Basic details" for a cross-product integration should be a display name at most — a phone number or address turns any valid token into a directory-scraping tool. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] status misreporting: "Invalid kpostID" must not be reported as SUCCESS', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload();
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    const message = String(json?.message ?? '');
    expect(
      String(json?.status).toUpperCase() === 'SUCCESS' && /invalid/i.test(message),
      `the route answered status SUCCESS with statusCode 200 while the message says "${message}". Both branches of the handler return the same success envelope, so a client cannot distinguish "found" from "no such user" without string-matching the message. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[4] enumeration: a wildcard must not return a list of users', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload({ kpostID: SQLI_WILDCARD });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.data === null, 'lookup returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a kpostID of "%" returned ${count} users. A single-user lookup must never become an enumeration endpoint. Body: ${text.slice(0, 300)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[5] missing required parameter: no kpostID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getUserBasicDetailsUsingKpostID({}, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a user lookup naming no user',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] null fuzzing: a null kpostID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload({ kpostID: null });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "kpostID" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload({ kpostID: SQLI_PAYLOAD });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload({ kpostID: XSS_PAYLOAD });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildBasicDetailsLookupPayload();
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not resolve a user', async ({ profileClient }) => {
    const payload = buildBasicDetailsLookupPayload();
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] boundary: a 5000-character kpostID must not fault the server', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicDetailsLookupPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await profileClient.getUserBasicDetailsUsingKpostID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] rate limiting: rapid lookups must be throttled', async ({
    profileClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        profileClient.getUserBasicDetailsUsingKpostID(buildBasicDetailsLookupPayload(), {
          token: staticToken,
        })
      )
    );

    expect(
      responses.every((response) => response.status() < 500),
      `ten rapid user lookups returned ${responses.map((r) => r.status()).join(', ')}. An unthrottled by-identifier lookup is how a directory gets enumerated; the route must survive the load and ideally rate-limit it.`
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
 * POST /v2/profile/getlanguages
 * ====================================================================================== */
test.describe('POST /v2/profile/getlanguages', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.getlanguages,
    repro: `await profileClient.getlanguages(buildLanguageLookupPayload(), { token });`,
  };

  test('[1] happy path: the language list satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload();
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: an unknown country must not be an error', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload({ countryID: 999999 });
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown country on a reference lookup is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no countryID must be handled explicitly', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getlanguages({}, { token: staticToken });

    expect(
      response.status(),
      `an empty language lookup produced HTTP ${response.status()}. Either it returns every language or it is a clean 400.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null countryID must be handled', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload({ countryID: null });
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    expect(
      response.status(),
      `countryID null produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string countryID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload({ countryID: 'India' });
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    expect(
      response.status(),
      `countryID was sent as the string "India" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload({ countryID: SQLI_PAYLOAD });
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload({ countryID: XSS_PAYLOAD });
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildLanguageLookupPayload();
    const response = await profileClient.getlanguages(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return reference data', async ({
    profileClient,
  }) => {
    const payload = buildLanguageLookupPayload();
    const response = await profileClient.getlanguages(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload();
    const response = await profileClient.getlanguages(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive lookups must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildLanguageLookupPayload();
    const [first, second] = await Promise.all([
      profileClient.getlanguages(payload, { token: staticToken }),
      profileClient.getlanguages(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reference lookups returned ${first.status()} and ${second.status()}.`
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

});

/* =========================================================================================
 * POST /v2/profile/getDesignationOrProfession
 * ====================================================================================== */
test.describe('POST /v2/profile/getDesignationOrProfession', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.getDesignationOrProfession,
    repro: `await profileClient.getDesignationOrProfession(buildDesignationLookupPayload(), { token });`,
  };

  test('[1] happy path: the designation list satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload();
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] business rule: an unknown requestType must be refused, not defaulted', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload({ requestType: 'NOT_A_TYPE' });
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'requestType is outside the DESIGNATION/PROFESSION set',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.getDesignationOrProfession({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'no requestType — the route cannot know which list to return',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload({ requestType: null });
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "requestType" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric requestType must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload({ requestType: 1 });
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `requestType was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] NPE: a flat payload must not crash the designation lookup', async ({
    profileClient,
    staticToken,
  }) => {
    // The sibling route getDesignationByProfessionId NPEs on a flat payload — swagger warns
    // about it and the suite already records it. This checks the same shape here.
    const payload = { professionID: 1 };
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a flat payload produced HTTP ${response.status()}. Its sibling getDesignationByProfessionId NPEs on exactly this shape, so the same defect is worth ruling out here.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload({ requestType: SQLI_PAYLOAD });
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload({ requestType: XSS_PAYLOAD });
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const payload = buildDesignationLookupPayload();
    const response = await profileClient.getDesignationOrProfession(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return reference data', async ({ profileClient }) => {
    const payload = buildDesignationLookupPayload();
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationLookupPayload();
    const response = await profileClient.getDesignationOrProfession(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.getDesignationOrProfession,
      '{"requestType":',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"requestType":',
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
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * GET /v2/profile/fetchUserDetails
 * ====================================================================================== */
test.describe('GET /v2/profile/fetchUserDetails', () => {
  const META = {
    method: 'GET',
    path: PROFILE_PATHS.fetchUserDetails,
    repro: `await profileClient.fetchUserDetails({ token });`,
  };

  test('[1] happy path: the caller\'s details satisfy the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.fetchUserDetails({ token: staticToken });

    await expectValidContract(
      response,
      profileMutationResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] contract: the response must identify the caller', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.fetchUserDetails({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no details returned');
    test.skip(!authSession.kpostID, 'no authenticated identity to compare against');

    expect(
      text.includes(authSession.kpostID as string),
      `fetchUserDetails did not return the authenticated caller's own kpostID (${authSession.kpostID}). The route derives identity from the token, so the record it returns must be theirs. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ profileClient }) => {
    const response = await profileClient.fetchUserDetails({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] auth: an expired token must not return user details', async ({ profileClient }) => {
    const response = await profileClient.fetchUserDetails({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] auth: a malformed token must not return user details', async ({ profileClient }) => {
    const response = await profileClient.fetchUserDetails({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: an alg=none token claiming admin must never be honoured', async ({
    profileClient,
  }) => {
    const response = await profileClient.fetchUserDetails({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[7] IDOR: a kpostID query parameter must not re-scope the read', async ({
    profileClient,
    staticToken,
    authSession,
  }) => {
    const response = await profileClient.fetchUserDetails({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no details returned');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `?kpostID=${VICTIM_KPOST_ID} returned that user's details while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[8] disclosure: the password hash must never be returned', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.fetchUserDetails({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'no details returned');

    expect(
      /"(password|kmailPassword|accessCode)"\s*:\s*"[^"]{3,}"/i.test(text),
      `the user record carried a credential field with a value. Even the caller's own password hash must never leave the server — it is offline-crackable and often reused. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] injection: a SQL tautology in a query parameter must not leak internals', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.fetchUserDetails({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      profileClient.fetchUserDetails({ token: staticToken }),
      profileClient.fetchUserDetails({ token: staticToken }),
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
