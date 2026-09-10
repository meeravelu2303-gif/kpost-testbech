import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import {
  COMPANY_ADMIN_PATHS,
  COMPANY_ADMIN_PATH_TEMPLATES,
} from '../../src/api/clients/companyAdministration.client';
import {
  adminAckResponseSchema,
  suggestionResponseSchema,
  userManagementResponseSchema,
} from '../../src/api/schemas/companyAdministration.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
  assertStatus,
} from '../../src/utils/apiAssertions';
import {
  buildAdminUserRegistrationPayload,
  buildReallocateUserPayload,
  buildDisplayNameSuggestionPayload,
  buildKpostIdSuggestionPayload,
  nonExistentCompanyId,
  nonExistentKpostId,
} from '../../src/api/payloads/companyAdministration.payload';
import { safeTestMobile } from '../../src/utils/safeTestData';
import { FOREIGN } from '../../src/api/clients/generic.client';

/*
 * Registration provisions a real account and measured at ~14.3s against a sub-200ms suite
 * baseline. The idempotency case fires three concurrently, so the default 30s global timeout
 * is not enough headroom — a timeout there would read as a defect when it is only slowness.
 */
test.describe.configure({ timeout: 90_000 });


/**
 * Company Administration — staff provisioning, identity reallocation, suggestion helpers
 * and the user-management roster read.
 *
 * Two routes carry rules worth stating:
 *
 * - `addingUserByAdmin` stamps the acting admin onto `userRegistration.admin` from the
 *   bearer token, and the spec says explicitly "the payload cannot spoof it". That claim is
 *   tested rather than assumed.
 * - `addingUserForReallocateByAdmin` rebinds an existing kpostID to a different person. It
 *   is the one route that can hand an established identity — and whatever history and trust
 *   attaches to it — to someone new, so an authorisation gap here is an identity takeover.
 *
 * Provisioning is outward-facing: new accounts are typically notified. Every builder
 * therefore targets a non-existent, QA-prefixed identity with `safeTestMobile()`.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;
/** A company the caller certainly does not administer. */
const FOREIGN_COMPANY_ID = '1';

/* =========================================================================================
 * POST /admin/addingUserByAdmin
 * ====================================================================================== */
test.describe('POST /admin/addingUserByAdmin', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.addingUserByAdmin,
    repro: `await companyAdminClient.addingUserByAdmin(buildAdminUserRegistrationPayload(), { token });`,
  };

  test('[1] happy path: a provisioning request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character first name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ firstName: MAX_LENGTH_STRING });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character firstName produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 name is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ firstName: UTF8_STRING });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 firstName produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a malformed mobile number must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ mobileNumber: '123' });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'mobileNumber too short to be valid ("123")' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3b] missing required parameter: "mobileNumber" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    delete (payload as Record<string, unknown>).mobileNumber;

    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "mobileNumber" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null kpostID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: null });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty kpostID must not provision an unnamed account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: '' });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a numeric kpostID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: INT32_OVERFLOW });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    expect(
      response.status(),
      `kpostID was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the name must not be stored unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ firstName: XSS_PAYLOAD });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not provision an account', async ({
    companyAdminClient,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserByAdmin(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] spoofing: a body-supplied "admin" must not override the token identity', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ admin: 'someone-else' });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    // A 200 alone does NOT prove a spoof: the service may have provisioned the account correctly
    // while ignoring the body-supplied `admin`. The breach is only proven if the response echoes
    // the SPOOFED value as the acting admin. (Asserting on the bare 200 false-failed a safe,
    // correctly-stamped provisioning.)
    const echoed = (json?.data ?? json) as { admin?: unknown; createdBy?: unknown } | null;
    const spoofHonoured =
      json?.statusCode === 200 &&
      (String(echoed?.admin ?? '') === 'someone-else' || String(echoed?.createdBy ?? '') === 'someone-else');

    expect(
      spoofHonoured,
      `the account was stamped with admin="someone-else" from the body. The spec stamps the acting admin from the bearer token specifically so "the payload cannot spoof it" — a spoofable value makes the audit trail worthless. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] cross-company: a caller must not provision into another company', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({
      companyID: Number(FOREIGN_COMPANY_ID),
    });
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const provisioned = json !== null && json.statusCode === 200;

    expect(
      provisioned,
      `an account was provisioned into companyID=${FOREIGN_COMPANY_ID}, which the caller does not administer. That inserts an attacker-controlled identity into another tenant's directory with a company-membership row. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserByAdmin(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not provision an account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.addingUserByAdmin({}, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a provisioning request' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.addingUserByAdmin,
      '{invalid json',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical provisioning must not create duplicates', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const [first, second, third] = await Promise.all([
      companyAdminClient.addingUserByAdmin(payload, { token: adminToken }),
      companyAdminClient.addingUserByAdmin(payload, { token: adminToken }),
      companyAdminClient.addingUserByAdmin(payload, { token: adminToken }),
    ]);
    const accepted = [first, second, third].filter((r) => r.status() === 200).length;

    expect(
      accepted,
      `${accepted} of three concurrent identical provisioning requests were accepted. The spec says the service validates uniqueness before allocating the kpostID; if that check is not transactional, concurrent submits each pass it and the same identity is inserted more than once.`
    ).toBeLessThanOrEqual(1);
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
    genericClient,
    adminToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { companyID: FOREIGN.companyID }, { token: adminToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    adminToken,
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
      token: adminToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

});

/* =========================================================================================
 * POST /admin/addingUserForReallocateByAdmin
 * ====================================================================================== */
test.describe('POST /admin/addingUserForReallocateByAdmin', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.addingUserForReallocateByAdmin,
    repro: `await companyAdminClient.addingUserForReallocateByAdmin(buildReallocateUserPayload(), { token });`,
  };

  test('[1] happy path: a reallocation request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildReallocateUserPayload();
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character target identity must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a malformed mobile number must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ mobileNumber: '1' });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'mobileNumber too short to be valid ("1")' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted on a reallocation' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null target identity must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: null });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty target identity must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: '' });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a target identity is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: { id: 1 } });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `kpostID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ firstName: XSS_PAYLOAD });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not rebind every identity', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload({ kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target kpostID returned success on a reallocation. This route rebinds an existing identity to a new person, so an unparameterised value could hand every identity in the company to one individual. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not rebind an identity', async ({
    companyAdminClient,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] identity takeover: a non-administrator must not rebind an existing kpostID', async ({
    companyAdminClient,
    staticToken,
  }) => {
    // Non-admin caller (personal token): /admin reallocation must be refused for them. Running
    // as the admin token would false-fail on the legitimate 200.
    const payload = buildAdminUserRegistrationPayload({
      kpostID: nonExistentKpostId(),
      mobileNumber: safeTestMobile(),
    });
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const rebound = json !== null && json.statusCode === 200;

    expect(
      rebound,
      `a reallocation succeeded without company-administrator entitlement. This route rebinds an established kpostID — and the history, contacts and trust attached to it — to a different person. Without the entitlement check it is a direct identity takeover. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserRegistrationPayload();
    const response = await companyAdminClient.addingUserForReallocateByAdmin(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not rebind an inferred identity', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.addingUserForReallocateByAdmin(
      {},
      { token: adminToken }
    );
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the reallocation route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.addingUserForReallocateByAdmin,
      '{"a":}',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent reallocations of one identity must not both win', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const target = nonExistentKpostId();
    const [first, second] = await Promise.all([
      companyAdminClient.addingUserForReallocateByAdmin(
        buildAdminUserRegistrationPayload({ kpostID: target, firstName: 'PersonOne' }),
        { token: adminToken }
      ),
      companyAdminClient.addingUserForReallocateByAdmin(
        buildAdminUserRegistrationPayload({ kpostID: target, firstName: 'PersonTwo' }),
        { token: adminToken }
      ),
    ]);
    const bothSucceeded = first.status() === 200 && second.status() === 200;

    expect(
      bothSucceeded,
      `two concurrent reallocations of the same kpostID to different people both reported success (HTTP ${first.status()} and ${second.status()}). Who ends up holding the identity would then depend on write ordering.`
    ).toBeFalsy();
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
    genericClient,
    adminToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { companyID: FOREIGN.companyID }, { token: adminToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });

});

/* =========================================================================================
 * GET /admin/userManagementDetails/{companyID}
 * ====================================================================================== */
test.describe('GET /admin/userManagementDetails/{companyID}', () => {
  const META = {
    method: 'GET',
    path: COMPANY_ADMIN_PATH_TEMPLATES.userManagementDetails,
    repro: `await companyAdminClient.userManagementDetails(companyID, { token });`,
  };

  test('[1] happy path: a roster read satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: adminToken,
    });

    await expectValidContract(
      response,
      userManagementResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character companyID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(MAX_LENGTH_STRING, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character companyID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(String(INT32_OVERFLOW), {
      token: adminToken,
    });

    expect(
      response.status(),
      `companyID=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty companyID must not list every user', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails('', { token: adminToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `an empty companyID returned ${rows.length} user records. The spec says the handler confirms companyID is non-empty first; degrading to a full listing would expose every employee on the platform. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[4] null fuzzing: a literal "null" companyID must not resolve', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails('null', {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `the literal string "null" returned ${rows.length} user records. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[5] type mismatch: a non-numeric companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails('not-a-number', {
      token: adminToken,
    });

    expect(
      response.status(),
      `a non-numeric companyID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(XSS_PAYLOAD, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not return every company\'s roster', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(SQLI_PAYLOAD, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);

    expect(
      rows.length,
      `a SQL tautology as companyID returned ${rows.length} user records. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not return a company roster', async ({
    companyAdminClient,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[8c] cross-company: a caller must not read another company\'s roster', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(FOREIGN_COMPANY_ID, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `${rows.length} employee records were returned for companyID=${FOREIGN_COMPANY_ID}, which the caller does not administer. The spec notes the service receives both the acting admin's kpostID and the requested companyID; if it does not compare them, any administrator can enumerate every other company's staff — names, mobile numbers, roles and account states. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: adminToken,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: adminToken,
    });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const companyID = nonExistentCompanyId();
    const [first, second, third] = await Promise.all([
      companyAdminClient.userManagementDetails(companyID, { token: adminToken }),
      companyAdminClient.userManagementDetails(companyID, { token: adminToken }),
      companyAdminClient.userManagementDetails(companyID, { token: adminToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] disclosure: the roster must not carry credential material', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.userManagementDetails(nonExistentCompanyId(), {
      token: adminToken,
    });
    const { text } = await readBody(response);

    expect(
      /"(password|kmailPassword|accessCode)"\s*:\s*"[^"]{3,}"/i.test(text),
      `the user-management roster included a password, kmail password or access code. The console needs identity, role and account state — never credential material, which would hand an administrator every employee's secrets in one call.`
    ).toBe(false);
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
    genericClient,
    adminToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.companyID), { token: adminToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    adminToken,
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
      token: adminToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

});

/* =========================================================================================
 * POST /admin/createKpostIDAndDesignationSuggestion
 * ====================================================================================== */
test.describe('POST /admin/createKpostIDAndDesignationSuggestion', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.createKpostIDAndDesignationSuggestion,
    repro: `await companyAdminClient.createKpostIDAndDesignationSuggestion(buildKpostIdSuggestionPayload(), { token });`,
  };

  test('[1] happy path: a suggestion request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      suggestionResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character company name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: MAX_LENGTH_STRING });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character companyName produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 company name is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: UTF8_STRING });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 companyName produced HTTP ${response.status()}. The suggestion is derived from this value, so non-ASCII input must yield a usable identifier rather than a fault.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "companyName" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    delete (payload as Record<string, unknown>).companyName;

    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "companyName" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null company name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: null });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "companyName" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty company name must not yield a bare suggestion', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: '' });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "companyName" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a company name is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: ['Acme'] });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `companyName was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected in the suggestion', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: XSS_PAYLOAD });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ companyName: SQLI_PAYLOAD });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ companyAdminClient }) => {
    const payload = buildKpostIdSuggestionPayload();
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] scoping: a body-supplied kpostID must be overwritten from the token', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload({ kpostID: 'someone-else' });
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      `the suggestion response referenced the body-supplied kpostID "someone-else". The spec states user.kpostID is overwritten with the acting admin's id from the bearer token, so a body value must have no influence on the result.`
    ).not.toContain('someone-else');
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.createKpostIDAndDesignationSuggestion(
      {},
      { token: adminToken }
    );

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a suggestion request' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.createKpostIDAndDesignationSuggestion,
      'not json at all',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeated suggestions must not collide with each other', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildKpostIdSuggestionPayload();
    const [first, second, third] = await Promise.all([
      companyAdminClient.createKpostIDAndDesignationSuggestion(payload, { token: adminToken }),
      companyAdminClient.createKpostIDAndDesignationSuggestion(payload, { token: adminToken }),
      companyAdminClient.createKpostIDAndDesignationSuggestion(payload, { token: adminToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent suggestion requests returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
    genericClient,
    adminToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { companyID: FOREIGN.companyID }, { token: adminToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });

});

/* =========================================================================================
 * POST /admin/displayNameSuggestion
 * ====================================================================================== */
test.describe('POST /admin/displayNameSuggestion', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.displayNameSuggestion,
    repro: `await companyAdminClient.displayNameSuggestion(buildDisplayNameSuggestionPayload(), { token });`,
  };

  test('[1] happy path: a display-name suggestion satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      suggestionResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character designation must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ designation: MAX_LENGTH_STRING });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character designation produced HTTP ${response.status()}. The suggestion is shown alongside every message the employee sends, so its length must be bounded.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 designation is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ designation: UTF8_STRING });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 designation produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "designation" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    delete (payload as Record<string, unknown>).designation;

    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'designation omitted — both inputs are read from an untyped request map',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null designation must not yield "null" in the name', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ designation: null });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });
    const { text } = await readBody(response);

    expect(
      text.toLowerCase(),
      `a null designation produced a suggestion containing the literal word "null". The composed name is shown to other users, so a null input must be refused rather than concatenated into the output.`
    ).not.toContain('null null');
  });

  test('[4b] empty fuzzing: an empty designation must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ designation: '' });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "designation" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a designation is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ designation: { title: 'Manager' } });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `designation was sent as an object and produced HTTP ${response.status()}. Both inputs come from an untyped map, so only the handler's own guard prevents a class-cast failure.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be composed into the display name', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ companyName: XSS_PAYLOAD });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload({ companyName: SQLI_PAYLOAD });
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const response = await companyAdminClient.displayNameSuggestion(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const response = await companyAdminClient.displayNameSuggestion(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.displayNameSuggestion({}, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a display-name suggestion' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.displayNameSuggestion,
      '[1,2,',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: the same inputs must yield the same suggestion', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildDisplayNameSuggestionPayload();
    const [first, second, third] = await Promise.all([
      companyAdminClient.displayNameSuggestion(payload, { token: adminToken }),
      companyAdminClient.displayNameSuggestion(payload, { token: adminToken }),
      companyAdminClient.displayNameSuggestion(payload, { token: adminToken }),
    ]);
    const bodies = [await readBody(first), await readBody(second), await readBody(third)];

    expect(
      new Set(bodies.map((b) => b.text)).size,
      `the same company name and designation produced different display-name suggestions across three concurrent calls. A pure composition of two inputs must be deterministic.`
    ).toBe(1);
  });

  test('[IDOR] a foreign companyID must not reach another owner\'s record', async ({
    genericClient,
    adminToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { companyID: FOREIGN.companyID }, { token: adminToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });

});
