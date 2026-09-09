import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { PROFILE_PATHS } from '../../src/api/clients/profile.client';
import { profileMutationResponseSchema } from '../../src/api/schemas/profile.schema';
import {
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
  buildAdvancedSearchPayload,
  buildAutoSearchPayload,
  buildDeleteProfileRecordPayload,
  buildExperienceDetailPayload,
  nonExistentProfileRecordId,
  syntheticKpostId,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * User Profile V2 — member search and the work-experience CRUD pair.
 *
 * ## Why search is graded as a data-exposure surface, not a query feature
 *
 * `advancedSearch` and `autoSearchWithName` walk the member directory. Two properties decide
 * how bad a weakness here is, and both are tested explicitly rather than assumed:
 *
 * - **What comes back per hit.** A name and a KPOST ID is a directory. A name, a mobile number
 *   and an email is a scrape target. Case `[9b]` reads the response for contact fields, because
 *   the same query is harmless or serious depending only on the projection.
 * - **Whether privacy is applied at query time.** A member who set their profile private must
 *   not appear. If the filter is applied in the UI rather than the query, the API returns them
 *   anyway and the setting is decorative.
 *
 * An empty or wildcard search term is therefore not a "missing validation" case here — it is an
 * *enumeration* case. `''`, `%` and `_` are the three values that, if the term is interpolated
 * into a LIKE, return the entire member table in one call.
 *
 * ## The experience pair
 *
 * `saveOrUpdateExperienceDetails` and `deleteExperienceDetail` are a create/delete pair keyed
 * by a record id the **caller supplies**. That is the shape that produces IDOR: if the delete
 * does not verify the record belongs to the caller, an id is all it takes to remove somebody
 * else's employment history. Deletion cases run against **non-existent synthetic ids only** —
 * a 404 versus a 200 on an id that cannot exist is already the whole answer, and guessing at
 * real ids to prove it would destroy a real member's data.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQL_WILDCARD = '%';
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const CONTACT_FIELD = /"(mobileNo|mobileNumber|emailId|email|alternateMobileno|dateOfBirth)"\s*:\s*"[^"]+"/i;
const ACCEPTED = [200, 201];
const REFUSED = [400, 401, 403, 422];
/**
 * The set an *invalid-input* case may legitimately answer with. Deliberately excludes 500:
 * `assertRejectsInvalidInput` treats every listed status as a valid refusal, so leaving 500 in
 * would mean "the server crashed on this input" counts as correct rejection — silencing the
 * exact defect the case exists to find. A 5xx on bad input is an unhandled-input fault and is
 * reported. `REFUSED` keeps 500 because it is also used as the *acceptable-response* list for
 * contract assertions, where an observed 500 is recorded rather than treated as a pass.
 */
const REJECTED = [400, 401, 403, 422];

/* =========================================================================================
 * POST /v2/profile/advancedSearch
 * ====================================================================================== */
test.describe('POST /v2/profile/advancedSearch', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.advancedSearch,
    repro: `await profileClient.advancedSearch(buildAdvancedSearchPayload(), { token });`,
  };

  test('[1] happy path: a normal search satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload();
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] enumeration: a bare "%" must not return the whole member directory', async ({
    profileClient,
    staticToken,
  }) => {
    // If the term reaches a LIKE unescaped, this single call is a full directory dump.
    const payload = buildAdvancedSearchPayload({ fullName: SQL_WILDCARD, city: SQL_WILDCARD });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 50,
      `a wildcard-only search returned ${hits} member records in one response. A SQL wildcard must be escaped before it reaches the query, or the search endpoint becomes a bulk export of the member directory. Body length: ${text.length}`
    ).toBe(false);
  });

  test('[2b] enumeration: a single-character "_" wildcard must not match everything', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: '_' });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 50,
      `the single-character SQL wildcard "_" returned ${hits} records. Both LIKE metacharacters need escaping, not just "%".`
    ).toBe(false);
  });

  test('[3] missing parameters: an empty search body must not return every member', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.advancedSearch({}, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 50,
      `a search with no criteria at all returned ${hits} member records. An unfiltered search must be refused, not answered with the entire table.`
    ).toBe(false);
  });

  test('[4] null fuzzing: a null fullName must not widen the result set', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: null, city: null });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertStatus(response, [...ACCEPTED, ...REFUSED], {
      ...META,
      body: payload,
      title: 'Search with all-null criteria returns an unexpected status',
    });
  });

  test('[5] type mismatch: an array where a name string is expected must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: ['a', 'b'] });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an array where a search term string is expected' },
      REJECTED
    );
  });

  test('[5b] boundary: a 5000-character search term must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: MAX_LENGTH_STRING });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character search term' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in a search term must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: XSS_PAYLOAD });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload({ fullName: SQLI_PAYLOAD });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous search must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildAdvancedSearchPayload();
    const response = await profileClient.advancedSearch(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not authorise a directory search', async ({
    profileClient,
  }) => {
    const payload = buildAdvancedSearchPayload();
    const response = await profileClient.advancedSearch(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAdvancedSearchPayload();
    const response = await profileClient.advancedSearch(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] disclosure: search hits must not carry contact details', async ({
    profileClient,
    staticToken,
  }) => {
    // A directory search is meant to help you find someone, then ask them. If every hit ships
    // a mobile number and a date of birth, one broad query harvests the address book.
    const payload = buildAdvancedSearchPayload({ fullName: 'a' });
    const response = await profileClient.advancedSearch(payload, { token: staticToken });
    const { text } = await readBody(response);
    const match = text.match(CONTACT_FIELD);

    expect(
      match !== null,
      `a search result included a contact field (${match ? match[0].slice(0, 60) : ''}). Search must project a name and an id; contact details belong behind an explicit profile fetch that honours the target's privacy setting.`
    ).toBe(false);
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.advancedSearch,
      '{"firstName": ',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"firstName": ',
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
 * POST /v2/profile/autoSearchWithName
 * ====================================================================================== */
test.describe('POST /v2/profile/autoSearchWithName', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.autoSearchWithName,
    repro: `await profileClient.autoSearchWithName(buildAutoSearchPayload(), { token });`,
  };

  test('[1] happy path: a type-ahead lookup satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload();
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] enumeration: a wildcard term must not dump the directory', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: SQL_WILDCARD });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 50,
      `a wildcard type-ahead returned ${hits} records. Auto-complete is called on every keystroke, so an unbounded result set here is both a data-exposure and an availability problem.`
    ).toBe(false);
  });

  test('[2b] business rule: a single character must not trigger an unbounded scan', async ({
    profileClient,
    staticToken,
  }) => {
    // Type-ahead endpoints normally require a minimum prefix length precisely because the
    // first keystroke would otherwise scan the whole table.
    const payload = buildAutoSearchPayload({ fullName: 'a' });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 100,
      `a one-character prefix returned ${hits} suggestions. Auto-complete needs a minimum term length and a result cap.`
    ).toBe(false);
  });

  test('[3] missing required parameter: no fullName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.autoSearchWithName({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'a type-ahead call with no search term' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null fullName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: null });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "fullName" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty term must be refused, not treated as match-all', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: '' });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });
    const { text } = await readBody(response);
    const hits = (text.match(/"kpostID"/g) || []).length;

    expect(
      hits > 50,
      `an empty search term returned ${hits} records — the empty string was treated as "match everything".`
    ).toBe(false);
  });

  test('[5] type mismatch: a numeric fullName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: 12345 });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a numeric value where a name string is expected' },
      REJECTED
    );
  });

  test('[5b] boundary: a 5000-character term must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: MAX_LENGTH_STRING });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character type-ahead term' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: XSS_PAYLOAD });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: SQLI_PAYLOAD });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous type-ahead must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildAutoSearchPayload();
    const response = await profileClient.autoSearchWithName(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildAutoSearchPayload();
    const response = await profileClient.autoSearchWithName(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload();
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[9b] disclosure: suggestions must not carry contact details', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildAutoSearchPayload({ fullName: 'an' });
    const response = await profileClient.autoSearchWithName(payload, { token: staticToken });
    const { text } = await readBody(response);
    const match = text.match(CONTACT_FIELD);

    expect(
      match !== null,
      `a type-ahead suggestion included a contact field (${match ? match[0].slice(0, 60) : ''}). Auto-complete fires on every keystroke; shipping contact details in it hands over the directory a few characters at a time.`
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/profile/saveOrUpdateExperienceDetails
 * ====================================================================================== */
test.describe('POST /v2/profile/saveOrUpdateExperienceDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.saveOrUpdateExperienceDetails,
    repro: `await profileClient.saveOrUpdateExperienceDetails(buildExperienceDetailPayload(), { token });`,
  };

  test('[1] happy path: a valid experience entry satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload();
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5000-character companyName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({
      experienceDetails: [
        { companyName: MAX_LENGTH_STRING, designation: 'QA', yearFrom: '2018', yearTo: '2021' },
      ],
    });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character company name' },
      REJECTED
    );
  });

  test('[2b] business rule: yearTo before yearFrom must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    // An inverted range is the classic date-field bug. Accepted, it renders as a negative
    // tenure on the member's digital card and breaks any duration arithmetic downstream.
    const payload = buildExperienceDetailPayload({
      experienceDetails: [
        { companyName: 'QA Ltd', designation: 'QA', yearFrom: '2021', yearTo: '2018' },
      ],
    });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an experience entry that ends before it starts' },
      REJECTED
    );
  });

  test('[3] missing required parameter: no experienceDetails must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload();
    delete (payload as Record<string, unknown>).experienceDetails;

    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an experience write with no experienceDetails array' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null experienceDetails must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({ experienceDetails: null });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "experienceDetails" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not create a null experience row', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.saveOrUpdateExperienceDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body on an experience write' },
      REJECTED
    );
  });

  test('[5] type mismatch: a string where the details array is expected must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({ experienceDetails: 'QA Ltd' });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a bare string where an array of entries is expected' },
      REJECTED
    );
  });

  test('[5b] boundary: an unparseable date must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({
      experienceDetails: [
        { companyName: 'QA Ltd', designation: 'QA', yearFrom: 'yesterday', yearTo: 'soon' },
      ],
    });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'free-text values in the date fields' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in companyName must not be stored unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({
      experienceDetails: [
        { companyName: XSS_PAYLOAD, designation: 'QA', yearFrom: '2018', yearTo: '2021' },
      ],
    });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload({
      experienceDetails: [
        { companyName: SQLI_PAYLOAD, designation: 'QA', yearFrom: '2018', yearTo: '2021' },
      ],
    });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildExperienceDetailPayload();
    const response = await profileClient.saveOrUpdateExperienceDetails(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] IDOR: a body-supplied kpostID must not write to another member\'s history', async ({
    profileClient,
    staticToken,
  }) => {
    const victim = syntheticKpostId();
    const payload = buildExperienceDetailPayload({ kpostID: victim });
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `saveOrUpdateExperienceDetails acknowledged a write against "${victim}". Employment history is presented as verified on the digital card, so being able to write it into someone else's profile is a credibility attack, not just a data-integrity one. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload();
    const response = await profileClient.saveOrUpdateExperienceDetails(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: the same entry submitted twice must not duplicate silently', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildExperienceDetailPayload();
    const [first, second] = await Promise.all([
      profileClient.saveOrUpdateExperienceDetails(payload, { token: staticToken }),
      profileClient.saveOrUpdateExperienceDetails(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical concurrent submissions returned ${first.status()} and ${second.status()}. The endpoint is named saveOrUpdate, so the second call must update rather than race — diverging statuses mean the caller cannot tell whether they now have one entry or two.`
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

});

/* =========================================================================================
 * POST /v2/profile/deleteExperienceDetail  — NON-EXISTENT IDS ONLY
 * ====================================================================================== */
test.describe('POST /v2/profile/deleteExperienceDetail', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.deleteExperienceDetail,
    repro: `await profileClient.deleteExperienceDetail(buildDeleteProfileRecordPayload('experienceID'), { token });`,
  };

  test('[1] happy path: deleting a non-existent entry must report not-found, not success', async ({
    profileClient,
    staticToken,
  }) => {
    // The whole endpoint is tested against ids that cannot exist. A 200 SUCCESS here means the
    // handler never checked whether the row was there — which is also why it would not check
    // whose it was.
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: nonExistentProfileRecordId() });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      body: payload,
      title: 'Deleting a non-existent experience entry is reported as a success',
    });
  });

  test('[2] boundary: a 5000-character id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: MAX_LENGTH_STRING });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character experience id' },
      REJECTED
    );
  });

  test('[2b] boundary: a negative id must be refused', async ({ profileClient, staticToken }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: -1 });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a negative experience id' },
      REJECTED
    );
  });

  test('[3] missing required parameter: no experienceID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.deleteExperienceDetail({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a delete with no id — on a bulk-capable handler this can mean "delete all"',
      },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null experienceID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: null });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "experienceID" set to null on a delete' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty-string id must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: '' });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an empty-string experience id on a delete' },
      REJECTED
    );
  });

  test('[5] type mismatch: an array of ids must not be silently accepted', async ({
    profileClient,
    staticToken,
  }) => {
    // If the DTO binds a collection, a single delete call becomes a bulk delete.
    const payload = buildDeleteProfileRecordPayload('experienceID', {
      experienceID: [nonExistentProfileRecordId(), nonExistentProfileRecordId()],
    });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an array where a single experience id is expected' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload as an id must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: XSS_PAYLOAD });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology id must not delete by matching everything', async ({
    profileClient,
    staticToken,
  }) => {
    // On a delete, an unescaped tautology is not an information leak — it is a mass deletion.
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: SQLI_PAYLOAD });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous delete must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: nonExistentProfileRecordId() });
    const response = await profileClient.deleteExperienceDetail(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not authorise a delete', async ({ profileClient }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: nonExistentProfileRecordId() });
    const response = await profileClient.deleteExperienceDetail(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not scope the delete to someone else', async ({
    profileClient,
    staticToken,
  }) => {
    const victim = syntheticKpostId();
    const payload = buildDeleteProfileRecordPayload('experienceID', {
      experienceID: nonExistentProfileRecordId(),
      kpostID: victim,
    });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `deleteExperienceDetail acknowledged a delete scoped to "${victim}". Ownership must be derived from the token; a caller-supplied kpostID on a delete is a direct route to wiping another member's records. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: nonExistentProfileRecordId() });
    const response = await profileClient.deleteExperienceDetail(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: deleting the same id twice must give the same answer', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDeleteProfileRecordPayload('experienceID', { experienceID: nonExistentProfileRecordId() });
    const [first, second] = await Promise.all([
      profileClient.deleteExperienceDetail(payload, { token: staticToken }),
      profileClient.deleteExperienceDetail(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two concurrent deletes of the same id returned ${first.status()} and ${second.status()}. A delete must be idempotent; a difference here means the outcome depends on which request won.`
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
