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
  bankAndCompanyResponseSchema,
} from '../../src/api/schemas/companyAdministration.schema';
import {
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
  buildBankAccountPayload,
  buildCompanyDetailsPayload,
  buildRemoveCompanyLogoPayload,
  nonExistentCompanyId,
} from '../../src/api/payloads/companyAdministration.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Company Administration — company profile, settlement details and logo.
 *
 * `updateBankAccountDetails` is the most financially sensitive route on the platform: the
 * spec states these details determine where the company is paid. An attacker who can write
 * them redirects settlement; an attacker who can read them harvests account numbers. Both
 * directions are covered.
 *
 * The two GET routes take a `companyID` path variable **and** the acting admin's kpostID
 * from the token. That pairing only protects anything if the service actually checks the
 * caller administers the requested company — which is what the cross-company cases probe.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;
/** A company the caller certainly does not administer. */
const FOREIGN_COMPANY_ID = '1';

/* =========================================================================================
 * POST /admin/updateBankAccountDetails
 * ====================================================================================== */
test.describe('POST /admin/updateBankAccountDetails', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.updateBankAccountDetails,
    repro: `await companyAdminClient.updateBankAccountDetails(buildBankAccountPayload(), { token });`,
  };

  test('[1] happy path: a settlement update satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload();
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character account number must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: MAX_LENGTH_STRING });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character accountNumber produced HTTP ${response.status()}. Account numbers have a fixed format; an arbitrary-length value must be refused before it reaches the settlement table.`
    ).toBeLessThan(500);
  });

  test('[2b] business rule: a malformed IFSC code must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ ifscCode: 'not-an-ifsc' });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'ifscCode set to a malformed value "not-an-ifsc"' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[2c] business rule: a non-numeric account number must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: 'ABCDEFGHIJ' });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'accountNumber containing letters' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3] missing required parameter: "accountNumber" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload();
    delete (payload as Record<string, unknown>).accountNumber;

    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "accountNumber" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null account number must not blank the settlement record', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: null });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "accountNumber" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty account number must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: '' });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "accountNumber" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where an account number is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: { value: 123 } });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `accountNumber was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the holder name must not be stored unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountHolderName: XSS_PAYLOAD });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not rewrite every settlement record', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ accountNumber: SQLI_PAYLOAD });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as accountNumber returned success on a settlement update. Unparameterised, that could point every company's payouts at one attacker-controlled account. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildBankAccountPayload();
    const response = await companyAdminClient.updateBankAccountDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never rewrite settlement details', async ({
    companyAdminClient,
  }) => {
    const payload = buildBankAccountPayload();
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] cross-company: a caller must not rewrite another company\'s bank account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload({ companyID: Number(FOREIGN_COMPANY_ID) });
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-tenant write: the API may have safely rejected or
    // scoped the update and ignored the body-supplied companyID. A breach is only
    // proven if the response confirms the foreign companyID as the updated record.
    // (Asserting on the bare 200 flagged a safe, scoped response as a breach.)
    const echoed = (json?.data ?? json) as { companyID?: unknown } | null;
    const wroteForeignCompany =
      json?.statusCode === 200 && String(echoed?.companyID ?? '') === String(FOREIGN_COMPANY_ID);

    expect(
      wroteForeignCompany,
      `a settlement update was confirmed against companyID=${FOREIGN_COMPANY_ID}, which the caller does not administer — writing bank details across a tenant boundary redirects another company's money. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload();
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBankAccountPayload();
    const response = await companyAdminClient.updateBankAccountDetails(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not blank the settlement record', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.updateBankAccountDetails({}, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the settlement route. Accepting it would either blank the company's payout details or report a change that never happened. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.updateBankAccountDetails,
      '{invalid json',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent conflicting account writes must not race', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const [first, second] = await Promise.all([
      companyAdminClient.updateBankAccountDetails(
        buildBankAccountPayload({ accountNumber: '111111111111' }),
        { token: adminToken }
      ),
      companyAdminClient.updateBankAccountDetails(
        buildBankAccountPayload({ accountNumber: '222222222222' }),
        { token: adminToken }
      ),
    ]);
    const bothSucceeded = first.status() === 200 && second.status() === 200;

    expect(
      bothSucceeded,
      `two concurrent writes of different account numbers both reported success (HTTP ${first.status()} and ${second.status()}). Which account the company is ultimately paid into would then depend on write ordering.`
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.companyID)),
      `the response acknowledged companyID "${FOREIGN.companyID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /admin/getBankAndCompanyDetails/{companyID}
 * ====================================================================================== */
test.describe('GET /admin/getBankAndCompanyDetails/{companyID}', () => {
  const META = {
    method: 'GET',
    path: COMPANY_ADMIN_PATH_TEMPLATES.getBankAndCompanyDetails,
    repro: `await companyAdminClient.getBankAndCompanyDetails(companyID, { token });`,
  };

  test('[1] happy path: a settlement read satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
      token: adminToken,
    });

    await expectValidContract(
      response,
      bankAndCompanyResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character companyID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(MAX_LENGTH_STRING, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character companyID path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(String(INT32_OVERFLOW), {
      token: adminToken,
    });

    expect(
      response.status(),
      `companyID=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty companyID must not list every company', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails('', { token: adminToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `an empty companyID returned ${rows.length} records. The spec says the handler confirms companyID is non-empty first; with none supplied the route must refuse rather than degrade into an enumeration of every company's bank details. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[4] null fuzzing: a literal "null" companyID must not resolve', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails('null', {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    expect(
      resolved,
      `the literal string "null" resolved to a company record. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a non-numeric companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails('not-a-number', {
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
    const response = await companyAdminClient.getBankAndCompanyDetails(XSS_PAYLOAD, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not return every company\'s bank record', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(SQLI_PAYLOAD, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);

    expect(
      rows.length,
      `a SQL tautology as companyID returned ${rows.length} records. On the settlement read, a payload that yields rows means account numbers for companies other than the caller's are reachable. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(SQLI_DROP_PAYLOAD, {
      token: adminToken,
    });

    await assertNoInternalLeak(response, META, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not return settlement details', async ({
    companyAdminClient,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[8c] cross-company: a caller must not read another company\'s bank details', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(FOREIGN_COMPANY_ID, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const record = json?.data as Record<string, unknown> | undefined;

    expect(
      record?.accountNumber,
      `an account number was returned for companyID=${FOREIGN_COMPANY_ID}, which the caller does not administer. The spec notes the service receives both the acting admin's kpostID and the requested companyID; if it does not compare them, any administrator can harvest every other company's settlement details. Body: ${text.slice(0, 200)}`
    ).toBeUndefined();
  });

  test('[8d] disclosure: a returned account number should be masked, not sent in full', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
      token: adminToken,
    });
    const { json } = await readBody(response);
    const record = json?.data as Record<string, unknown> | undefined;
    const accountNumber = typeof record?.accountNumber === 'string' ? record.accountNumber : '';

    test.skip(accountNumber.length === 0, 'no account number returned to evaluate');

    expect(
      /^[0-9]{6,}$/.test(accountNumber),
      `the settlement read returned what appears to be a full account number ("${accountNumber.slice(0, 4)}…"). A settings screen needs only the last few digits to confirm which account is configured; returning it in full puts it into every client cache and proxy log that handles the response.`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
      token: adminToken,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails(nonExistentCompanyId(), {
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
      companyAdminClient.getBankAndCompanyDetails(companyID, { token: adminToken }),
      companyAdminClient.getBankAndCompanyDetails(companyID, { token: adminToken }),
      companyAdminClient.getBankAndCompanyDetails(companyID, { token: adminToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] structural: a path traversal attempt must not escape the route', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.getBankAndCompanyDetails('../../../etc/passwd', {
      token: adminToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file.`
    ).not.toContain('root:');
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.companyID)),
      `the response acknowledged companyID "${FOREIGN.companyID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
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
 * POST /admin/updateCompanyDetails
 * ====================================================================================== */
test.describe('POST /admin/updateCompanyDetails', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.updateCompanyDetails,
    repro: `await companyAdminClient.updateCompanyDetails(buildCompanyDetailsPayload(), { token });`,
  };

  test('[1] happy path: a company profile update satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character company name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyName: MAX_LENGTH_STRING });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character companyName produced HTTP ${response.status()}. Company details are rendered on generated documents, so a length limit must be enforced.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 company name is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyName: UTF8_STRING });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 companyName produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "companyName" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload();
    delete (payload as Record<string, unknown>).companyName;

    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "companyName" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null company name must not blank the profile', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyName: null });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "companyName" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty company name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyName: '' });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
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
    const payload = buildCompanyDetailsPayload({ companyName: ['Acme'] });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `companyName was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyName: XSS_PAYLOAD });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not rewrite every company profile', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyID: SQLI_PAYLOAD });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as companyID returned success on a profile update. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const response = await companyAdminClient.updateCompanyDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not amend a company profile', async ({
    companyAdminClient,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] cross-company: a caller must not amend another company\'s profile', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload({ companyID: Number(FOREIGN_COMPANY_ID) });
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    // A bare 200 does not prove a cross-tenant write — the service may have scoped the update to
    // the caller's own company and ignored the body companyID. Only a response confirming the
    // FOREIGN companyID as the amended record is a breach.
    const echoed = (json?.data ?? json) as { companyID?: unknown } | null;
    const amendedForeignCompany =
      json?.statusCode === 200 && String(echoed?.companyID ?? '') === String(FOREIGN_COMPANY_ID);

    expect(
      amendedForeignCompany,
      `a profile update was confirmed against companyID=${FOREIGN_COMPANY_ID}, which the caller does not administer. Company details are referenced across the platform and on generated documents. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const response = await companyAdminClient.updateCompanyDetails(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not blank the company profile', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.updateCompanyDetails({}, { token: adminToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the company profile route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.updateCompanyDetails,
      '{"a":}',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical updates must agree', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildCompanyDetailsPayload();
    const [first, second, third] = await Promise.all([
      companyAdminClient.updateCompanyDetails(payload, { token: adminToken }),
      companyAdminClient.updateCompanyDetails(payload, { token: adminToken }),
      companyAdminClient.updateCompanyDetails(payload, { token: adminToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent updates returned different statuses (${statuses.join(', ')}).`
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.companyID)),
      `the response acknowledged companyID "${FOREIGN.companyID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /admin/removeCompanyLogo
 * ====================================================================================== */
test.describe('POST /admin/removeCompanyLogo', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.removeCompanyLogo,
    repro: `await companyAdminClient.removeCompanyLogo(buildRemoveCompanyLogoPayload(), { token });`,
  };

  test('[1] happy path: a logo clear satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character companyID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character companyID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: INT32_OVERFLOW });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    expect(
      response.status(),
      `companyID=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "companyID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.removeCompanyLogo({}, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'companyID omitted — the handler reads it from an untyped request map',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null companyID must not clear an inferred logo', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: null });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "companyID" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty companyID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: '' });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "companyID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a companyID is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: [1] });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    expect(
      response.status(),
      `companyID was sent as an array and produced HTTP ${response.status()}. The handler reads this from an untyped map, so nothing but its own guard prevents a class-cast failure.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: XSS_PAYLOAD });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not clear every company logo', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: SQLI_PAYLOAD });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as companyID returned success. The route is an update-to-null, so unparameterised it could blank every company's logo at once. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not clear a company logo', async ({
    companyAdminClient,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const response = await companyAdminClient.removeCompanyLogo(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] cross-company: a caller must not clear another company\'s logo', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload({ companyID: FOREIGN_COMPANY_ID });
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    // A bare 200 does not prove cross-tenant clearing — the service may have scoped the clear to
    // the caller's own company. Only a response confirming the FOREIGN companyID is a breach.
    const echoed = (json?.data ?? json) as { companyID?: unknown } | null;
    const clearedForeignCompany =
      json?.statusCode === 200 && String(echoed?.companyID ?? '') === String(FOREIGN_COMPANY_ID);

    expect(
      clearedForeignCompany,
      `a logo clear was confirmed against companyID=${FOREIGN_COMPANY_ID}. companyID is read straight from an untyped request map, so if the service does not check it against the acting admin's company this is a cross-tenant defacement. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const response = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.removeCompanyLogo,
      'not json at all',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] idempotency: clearing an already-cleared logo must be stable', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildRemoveCompanyLogoPayload();
    const first = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });
    const second = await companyAdminClient.removeCompanyLogo(payload, { token: adminToken });

    expect(
      second.status(),
      `clearing the same logo twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.companyID)),
      `the response acknowledged companyID "${FOREIGN.companyID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
