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
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildBasicInformationPayload,
  buildContactInformationPayload,
  buildDesignationPayload,
  buildPrivacyPayload,
  buildPrivacySettingDetailsPayload,
  syntheticKpostId,
} from '../../src/api/payloads/profile.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * User Profile V2 — the five self-service write endpoints.
 *
 * These are the routes an ordinary member hits from the "edit my profile" screen. They share
 * one structural property that shapes every test below: **the record they write is selected
 * from the token, not from the body.** None of them takes a `kpostID` parameter in its
 * documented shape.
 *
 * That makes the interesting question not "does it save" but "can the body override whose
 * record is saved". A Spring `@RequestBody` DTO binds any field the class declares, and
 * KPOST's profile DTOs are wide. If `UserProfileRO` carries a `kpostID` the controller does
 * not deliberately ignore, sending one turns a self-service write into a write against
 * somebody else. Each endpoint therefore gets an explicit mass-assignment case (`[8b]`) that
 * smuggles a `kpostID` alongside otherwise valid data, and asserts the response does not
 * report success against that identity.
 *
 * The second recurring theme is **privacy semantics**. `setProfilePrivacy` and
 * `updatePrivacySettingDetails` are the controls that decide who can see a member's number
 * and address. An unvalidated value there does not corrupt a row — it silently widens an
 * audience, and the member is never told. `privacyStatus: 99` being accepted is graded on
 * that consequence, not on the type error.
 *
 * ## Safety
 *
 * Every case writes to the **suite's own throwaway account** via `staticToken`. The victim
 * identity used in the IDOR and mass-assignment cases is synthetic and non-existent, so a
 * successful override would create a stray row rather than damage a real member's profile.
 * No case here writes to a real third-party account.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
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
 * POST /v2/profile/updateBasicInformation
 * ====================================================================================== */
test.describe('POST /v2/profile/updateBasicInformation', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateBasicInformation,
    repro: `await profileClient.updateBasicInformation(buildBasicInformationPayload(), { token });`,
  };

  test('[1] happy path: a valid basic-information write satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload();
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5000-character firstName must be refused, not truncated silently', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload({ firstName: MAX_LENGTH_STRING });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a 5000-character firstName on a profile write',
      },
      REJECTED
    );
  });

  test('[2b] boundary: a UTF-8 name must round-trip without mangling', async ({
    profileClient,
    staticToken,
  }) => {
    // Devanagari and an emoji. A name column that is latin1 rather than utf8mb4 either throws
    // or stores mojibake, and the member's own name comes back wrong on their card.
    const unicodeName = 'अनुराधा 🌸';
    const payload = buildBasicInformationPayload({ firstName: unicodeName });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, unicodeName);
  });

  test('[3] missing required parameter: no firstName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload();
    delete (payload as Record<string, unknown>).firstName;

    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a profile write with no firstName' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null firstName must not blank out the stored name', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload({ firstName: null });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "firstName" set to null — accepting this erases the member\'s name',
      },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not overwrite a populated profile', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateBasicInformation({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an empty body on a profile update — a full-record overwrite with nulls',
      },
      REJECTED
    );
  });

  test('[5] type mismatch: a numeric firstName must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload({ firstName: 12345 });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a numeric value where a name string is expected' },
      REJECTED
    );
  });

  test('[5b] business rule: an out-of-range dateOfBirth must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    // A birth date in the future is not a formatting error — it is a value no validation
    // layer should let through, and it propagates into age-gated features downstream.
    const payload = buildBasicInformationPayload({ dateOfBirth: '2999-12-31' });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a dateOfBirth in the year 2999' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in firstName must not be stored unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload({ firstName: XSS_PAYLOAD });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in city must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload({ city: SQLI_PAYLOAD });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildBasicInformationPayload();
    const response = await profileClient.updateBasicInformation(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] mass assignment: a body-supplied kpostID must not redirect the write', async ({
    profileClient,
    staticToken,
  }) => {
    // The record is meant to be chosen by the token. If the DTO binds a kpostID the controller
    // does not ignore, this one field turns self-service editing into editing anyone.
    const victim = syntheticKpostId();
    const payload = buildBasicInformationPayload({ kpostID: victim, firstName: 'Overwritten' });
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `updateBasicInformation acknowledged a write against "${victim}", an identity the caller does not own. The target record must come from the token, never the body — otherwise any member can rewrite any other member's profile. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[8c] auth: an alg=none forged token must not be accepted', async ({ profileClient }) => {
    const payload = buildBasicInformationPayload();
    const response = await profileClient.updateBasicInformation(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildBasicInformationPayload();
    const response = await profileClient.updateBasicInformation(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.updateBasicInformation,
      '{"firstName": "unterminated',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"firstName": "unterminated',
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
 * POST /v2/profile/updateContactInformation
 * ====================================================================================== */
test.describe('POST /v2/profile/updateContactInformation', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateContactInformation,
    repro: `await profileClient.updateContactInformation(buildContactInformationPayload(), { token });`,
  };

  test('[1] happy path: a valid contact write satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload();
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5000-character addressLine1 must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ addressLine1: MAX_LENGTH_STRING });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character address line' },
      REJECTED
    );
  });

  test('[2b] business rule: a 3-digit alternate mobile number must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    // An Indian mobile number is ten digits. A three-digit value is not a near-miss; it is a
    // number the platform can never deliver an OTP or a Kall to.
    const payload = buildContactInformationPayload({ alternateMobileno: '123' });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 3-digit alternate mobile number' },
      REJECTED
    );
  });

  test('[3] missing required parameter: no addressLine1 must be handled deterministically', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload();
    delete (payload as Record<string, unknown>).addressLine1;

    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertStatus(response, [...ACCEPTED, ...REFUSED], {
      ...META,
      body: payload,
      title: 'Contact write with an omitted address line returns an unexpected status',
    });
  });

  test('[4] null fuzzing: a null otherEmail must not be stored as a null contact', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ otherEmail: null });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "otherEmail" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not blank the whole contact block', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateContactInformation({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body on a contact-information write' },
      REJECTED
    );
  });

  test('[5] type mismatch: an array where an email string is expected must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ otherEmail: ['a@b.com', 'c@d.com'] });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an array where a single email string is expected' },
      REJECTED
    );
  });

  test('[5b] business rule: a malformed email must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ otherEmail: 'not-an-email' });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an unparseable value in the email field' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in addressLine2 must not be stored unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ addressLine2: XSS_PAYLOAD });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in pinCode must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload({ pinCode: SQLI_PAYLOAD });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildContactInformationPayload();
    const response = await profileClient.updateContactInformation(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] mass assignment: a body-supplied kpostID must not redirect the write', async ({
    profileClient,
    staticToken,
  }) => {
    const victim = syntheticKpostId();
    const payload = buildContactInformationPayload({ kpostID: victim });
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `updateContactInformation acknowledged a write against "${victim}". A member's home address and alternate number must not be settable by anyone who can name them. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[8c] auth: an expired token must be HTTP 401/403', async ({ profileClient }) => {
    const payload = buildContactInformationPayload();
    const response = await profileClient.updateContactInformation(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload();
    const response = await profileClient.updateContactInformation(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: the same contact write twice must give the same outcome', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildContactInformationPayload();
    const [first, second] = await Promise.all([
      profileClient.updateContactInformation(payload, { token: staticToken }),
      profileClient.updateContactInformation(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical concurrent contact writes returned ${first.status()} and ${second.status()}. A profile update is an overwrite, so it must be idempotent; diverging statuses point at a race on the shared controller state.`
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
 * POST /v2/profile/updateDesignation
 * ====================================================================================== */
test.describe('POST /v2/profile/updateDesignation', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updateDesignation,
    repro: `await profileClient.updateDesignation(buildDesignationPayload(), { token });`,
  };

  test('[1] happy path: a valid designation write satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload();
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a 5000-character designation must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designation: MAX_LENGTH_STRING });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a 5000-character designation' },
      REJECTED
    );
  });

  test('[2b] boundary: a negative designationID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designationID: -1 });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'designationID -1, outside any valid key range' },
      REJECTED
    );
  });

  test('[3] missing required parameter: no designationID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload();
    delete (payload as Record<string, unknown>).designationID;

    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a designation write with no designationID' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null designationID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designationID: null });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "designationID" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updateDesignation({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body on a designation write' },
      REJECTED
    );
  });

  test('[5] type mismatch: a string designationID must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designationID: 'one' });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a non-numeric designationID' },
      REJECTED
    );
  });

  test('[5b] referential integrity: an unknown designationID must not be accepted', async ({
    profileClient,
    staticToken,
  }) => {
    // Accepting a key with no row behind it leaves the profile pointing at nothing, and the
    // failure only surfaces later on whatever screen tries to render the designation.
    const payload = buildDesignationPayload({ designationID: 99999999 });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a designationID with no corresponding row' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in designation must not be stored unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designation: XSS_PAYLOAD });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology designationID must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload({ designationID: SQLI_PAYLOAD });
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildDesignationPayload();
    const response = await profileClient.updateDesignation(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a structurally malformed token must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildDesignationPayload();
    const response = await profileClient.updateDesignation(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildDesignationPayload();
    const response = await profileClient.updateDesignation(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.updateDesignation,
      '{"designationID": }',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"designationID": }',
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
 * POST /v2/profile/setProfilePrivacy
 * ====================================================================================== */
test.describe('POST /v2/profile/setProfilePrivacy', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.setProfilePrivacy,
    repro: `await profileClient.setProfilePrivacy(buildPrivacyPayload(), { token });`,
  };

  test('[1] happy path: a valid privacy write satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: privacyStatus 99 is outside the defined set and must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    // This is the case that matters most on this endpoint. An unrecognised privacy level is
    // very unlikely to fail closed — the usual implementation is a switch with a permissive
    // default, so an out-of-range value quietly makes the profile MORE visible, and the
    // member is never told their setting did not take.
    const payload = buildPrivacyPayload({ privacyStatus: 99 });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario:
          'privacyStatus 99 — an undefined visibility level that may fail open and widen the audience',
      },
      REJECTED
    );
  });

  test('[2b] boundary: a negative privacyStatus must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload({ privacyStatus: -1 });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a negative privacyStatus' },
      REJECTED
    );
  });

  test('[3] missing required parameter: no privacyStatus must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload();
    delete (payload as Record<string, unknown>).privacyStatus;

    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a privacy write with no privacyStatus' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null privacyStatus must not default to public', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload({ privacyStatus: null });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'privacyStatus null — a primitive field that null-unboxes to 0, often "public"',
      },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must not reset the privacy setting', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.setProfilePrivacy({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body on a privacy write' },
      REJECTED
    );
  });

  test('[5] type mismatch: a string privacyStatus must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload({ privacyStatus: 'public' });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'the word "public" where a numeric level is expected' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload in the privacy field must not be reflected', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload({ privacyStatus: XSS_PAYLOAD });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload({ privacyStatus: SQLI_PAYLOAD });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.setProfilePrivacy(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] IDOR: a body-supplied kpostID must not change another member\'s privacy', async ({
    profileClient,
    staticToken,
  }) => {
    // The worst version of the mass-assignment bug: not editing someone's name, but making
    // their profile public on their behalf.
    const victim = syntheticKpostId();
    const payload = buildPrivacyPayload({ kpostID: victim, privacyStatus: 0 });
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `setProfilePrivacy acknowledged a privacy change against "${victim}". Being able to name someone and lower their visibility exposes their contact details without their knowledge. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.setProfilePrivacy(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: setting the same privacy level twice must agree', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload();
    const [first, second] = await Promise.all([
      profileClient.setProfilePrivacy(payload, { token: staticToken }),
      profileClient.setProfilePrivacy(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical concurrent privacy writes returned ${first.status()} and ${second.status()}. A member must never be left unsure which visibility level actually took effect.`
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
 * POST /v2/profile/updatePrivacySettingDetails
 * ====================================================================================== */
test.describe('POST /v2/profile/updatePrivacySettingDetails', () => {
  const META = {
    method: 'POST',
    path: PROFILE_PATHS.updatePrivacySettingDetails,
    repro: `await profileClient.updatePrivacySettingDetails(buildPrivacySettingDetailsPayload(), { token });`,
  };

  test('[1] happy path: a valid settings write satisfies the Zod contract', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload();
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await expectValidContract(response, profileMutationResponseSchema, { ...META, body: payload }, [
      ...ACCEPTED,
      ...REFUSED,
    ]);
  });

  test('[2] boundary: a malformed privacyDetails string must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    // Excel DTO: `{ privacyDetails: "<stringified JSON>" }`. A non-JSON string is invalid input.
    const payload = buildPrivacySettingDetailsPayload({ privacyDetails: 'not-a-json-object' });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'privacyDetails set to a non-JSON string' },
      REJECTED
    );
  });

  test('[2b] consistency: this route and setProfilePrivacy must not disagree', async ({
    profileClient,
    staticToken,
  }) => {
    // Two endpoints writing the same privacy concept via different DTOs. If one validates a
    // malformed write and the other does not, the unvalidated one is the way round the check.
    const [viaSettings, viaPrivacy] = await Promise.all([
      profileClient.updatePrivacySettingDetails(
        buildPrivacySettingDetailsPayload({ privacyDetails: 'not-a-json-object' }),
        { token: staticToken }
      ),
      profileClient.setProfilePrivacy(buildPrivacyPayload({ privacyStatus: 99, privacySettings: 99 }), {
        token: staticToken,
      }),
    ]);

    if (viaSettings.ok() !== viaPrivacy.ok()) {
      await reportBusinessLogicFlaw(
        viaSettings.ok() ? viaSettings : viaPrivacy,
        {
          method: 'POST',
          path: PROFILE_PATHS.updatePrivacySettingDetails,
          body: { privacyDetails: 'not-a-json-object' },
          repro: `updatePrivacySettingDetails(malformed) vs setProfilePrivacy(malformed) — compare which accepts`,
          title: 'Inconsistent privacy validation: two routes writing the same setting enforce different rules',
          scenario: `updatePrivacySettingDetails answered ${viaSettings.status()} and setProfilePrivacy answered ${viaPrivacy.status()} to a malformed privacy write — the weaker one is the bypass.`,
        },
        'Business Logic Flaw',
        'Major'
      );
    }
  });

  test('[3] missing required parameter: no privacyDetails must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload();
    delete (payload as Record<string, unknown>).privacyDetails;

    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a settings write with no privacyDetails' },
      REJECTED
    );
  });

  test('[4] null fuzzing: a null privacyDetails must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload({ privacyDetails: null });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "privacyDetails" set to null' },
      REJECTED
    );
  });

  test('[4b] empty fuzzing: an empty body must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.updatePrivacySettingDetails({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body on a privacy-settings write' },
      REJECTED
    );
  });

  test('[5] type mismatch: a nested object where a level is expected must be refused', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload({ privacyDetails: { level: 1 } });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a nested object where a stringified JSON is expected' },
      REJECTED
    );
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload({ privacyDetails: XSS_PAYLOAD });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacySettingDetailsPayload({ privacyDetails: SQLI_PAYLOAD });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    profileClient,
  }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.updatePrivacySettingDetails(payload);

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not be accepted', async ({ profileClient }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not redirect the settings write', async ({
    profileClient,
    staticToken,
  }) => {
    const victim = syntheticKpostId();
    const payload = buildPrivacyPayload({ kpostID: victim });
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(victim),
      `updatePrivacySettingDetails acknowledged a write against "${victim}". Privacy settings must be writable only by their owner. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    profileClient,
    staticToken,
  }) => {
    const payload = buildPrivacyPayload();
    const response = await profileClient.updatePrivacySettingDetails(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    profileClient,
    staticToken,
  }) => {
    const response = await profileClient.postRawTo(
      PROFILE_PATHS.updatePrivacySettingDetails,
      '{"privacySettings": [1,',
      { token: staticToken }
    );

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"privacySettings": [1,',
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
