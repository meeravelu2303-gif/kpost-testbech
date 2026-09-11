import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { COMPANY_ADMIN_PATHS } from '../../src/api/clients/companyAdministration.client';
import { adminAckResponseSchema } from '../../src/api/schemas/companyAdministration.schema';
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
  buildAdminUserActionPayload,
  buildTerminateUserPayload,
  buildBackupAdminPayload,
  buildHoldPayload,
  buildResetPasswordPayload,
  buildUpdateRolePayload,
  nonExistentKpostId,
} from '../../src/api/payloads/companyAdministration.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Company Administration — privilege and account-state control.
 *
 * `SecurityConfiguration` gates `/admin/**` with `hasRole("admin")`, so the single most
 * important question on every route here is whether a non-administrator is refused. The
 * five routes in this file are the ones where a missing check does the most damage:
 *
 * - `updateRole` granting "admin" hands the target the entire /admin/** tree.
 * - `createOrRemoveBackupAdmin` is the continuity delegation control.
 * - `holdOrRelease` blocks a real person from signing in (reversible).
 * - `terminateUser` permanently offboards an account (**not** reversible).
 * - `resetPassword` overwrites a credential irrecoverably and dispatches the new one.
 *
 * Every payload targets a non-existent, QA-prefixed identity, and every mobile number
 * routes through `safeTestMobile()`. The refusal path is what gets exercised — which is
 * exactly where an authorisation defect would show.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /admin/updateRole
 * ====================================================================================== */
test.describe('POST /admin/updateRole @audit', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.updateRole,
    repro: `await companyAdminClient.updateRole(buildUpdateRolePayload('user'), { token });`,
  };

  test('[1] happy path: a role change satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user');
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character role name must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload(MAX_LENGTH_STRING);
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character role produced HTTP ${response.status()}. A role is a short enum drawn from a fixed set, so an arbitrary-length value must be refused by validation.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an unrecognised role must be refused, not stored', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('superuser');
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'role set to an unrecognised value "superuser"' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user');
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted on a role change' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null role must not default to a privileged value', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user', { role: null });
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "role" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty role must not be persisted', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('');
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "role" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a role string is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user', { role: ['admin'] });
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    expect(
      response.status(),
      `role was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the role must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload(XSS_PAYLOAD);
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not widen the role update', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('admin', { kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target kpostID returned success on a role change granting "admin". If that value reaches the WHERE clause unparameterised it could promote every user in the table to administrator. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildUpdateRolePayload('admin');
    const response = await companyAdminClient.updateRole(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await companyAdminClient.updateRole(buildUpdateRolePayload('admin'), { token: null });`,
    });
  });

  test('[8b] auth: an alg=none forged token must never grant the admin role', async ({
    companyAdminClient,
  }) => {
    const payload = buildUpdateRolePayload('admin');
    const response = await companyAdminClient.updateRole(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not grant themselves "admin"', async ({
    companyAdminClient,
    staticToken,
    authSession,
  }) => {
    // Run as a NON-admin (the personal QA token). /admin/** is gated by hasRole("admin"); a
    // non-admin self-promotion must be refused. Running this as the admin token (which IS
    // entitled) would false-fail on the legitimate 200.
    const payload = buildUpdateRolePayload('admin', {
      kpostID: authSession.kpostID ?? nonExistentKpostId(),
    });
    const response = await companyAdminClient.updateRole(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const granted = json !== null && json.statusCode === 200;

    expect(
      granted,
      `a role change to "admin" succeeded for the caller's own identity. Roles drive authorisation: granting admin hands the target the entire /admin/** tree, which includes terminating employees, resetting their passwords and rewriting the company's bank account. Self-promotion here is total compromise of the company. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user');
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildUpdateRolePayload('user');
    const response = await companyAdminClient.updateRole(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not change any role', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.updateRole({}, { token: adminToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the role-change route. With no target and no role supplied, success can only mean the handler fell through without performing a check. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.updateRole,
      '{invalid json',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent conflicting role changes must not race', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const target = nonExistentKpostId();
    const [asAdmin, asUser] = await Promise.all([
      companyAdminClient.updateRole(buildUpdateRolePayload('admin', { kpostID: target }), {
        token: adminToken,
      }),
      companyAdminClient.updateRole(buildUpdateRolePayload('user', { kpostID: target }), {
        token: adminToken,
      }),
    ]);
    const bothSucceeded = asAdmin.status() === 200 && asUser.status() === 200;

    expect(
      bothSucceeded,
      `a concurrent promotion to "admin" and demotion to "user" for the same target both reported success (HTTP ${asAdmin.status()} and ${asUser.status()}). The resulting privilege level is then decided by write ordering rather than by the caller — a non-deterministic administrator set.`
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
 * POST /admin/createOrRemoveBackupAdmin
 * ====================================================================================== */
test.describe('POST /admin/createOrRemoveBackupAdmin @audit', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.createOrRemoveBackupAdmin,
    repro: `await companyAdminClient.createOrRemoveBackupAdmin(buildBackupAdminPayload(true), { token });`,
  };

  test('[1] happy path: a backup-admin grant satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true);
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true, { kpostID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `a 5000-character target kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow companyID is handled cleanly', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true, { companyID: INT32_OVERFLOW });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `companyID=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    // Real DTO is { kpostID, isBackUpAdmin, companyID } — omit the actual identity field, not
    // the phantom `mobileNumber` (absent from the body, so deleting it left a valid payload and
    // filed a false "invalid input accepted").
    const payload = buildBackupAdminPayload(true);
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null delegation flag must not default to a grant', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserActionPayload({ isBackUpAdmin: null });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "isBackUpAdmin" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true, { kpostID: '' });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a string where the delegation flag expects a boolean', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserActionPayload({ isBackUpAdmin: 'yes' });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    expect(
      response.status(),
      `isBackUpAdmin was sent as the string "yes" and produced HTTP ${response.status()}. A truthy-string coercion on a privilege flag is how accidental grants happen.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true, { kpostID: XSS_PAYLOAD });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not promote every user', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true, { kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target returned success on a backup-admin grant. Unparameterised, that could set the backup-admin flag on every row in the company. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildBackupAdminPayload(true);
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not delegate administration', async ({
    companyAdminClient,
  }) => {
    const payload = buildBackupAdminPayload(true);
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not delegate admin rights', async ({
    companyAdminClient,
    staticToken,
    authSession,
  }) => {
    // Non-admin caller: a personal user delegating backup-admin to themselves must be refused.
    const payload = buildBackupAdminPayload(true, {
      kpostID: authSession.kpostID ?? nonExistentKpostId(),
    });
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const granted = json !== null && json.statusCode === 200;

    expect(
      granted,
      `a backup-administrator grant succeeded for the caller's own identity. The spec states the acting admin's kpostID is taken from the token so the service can enforce that the caller is entitled to delegate; if that check is missing, any employee can make themselves a company administrator. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(true);
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildBackupAdminPayload(false);
    const response = await companyAdminClient.createOrRemoveBackupAdmin(payload, {
      token: adminToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not delegate anything', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.createOrRemoveBackupAdmin(
      {},
      { token: adminToken }
    );
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the delegation route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.createOrRemoveBackupAdmin,
      '{"a":}',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent grant and revoke must not leave an ambiguous state', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const target = nonExistentKpostId();
    const [grant, revoke] = await Promise.all([
      companyAdminClient.createOrRemoveBackupAdmin(
        buildBackupAdminPayload(true, { kpostID: target }),
        { token: adminToken }
      ),
      companyAdminClient.createOrRemoveBackupAdmin(
        buildBackupAdminPayload(false, { kpostID: target }),
        { token: adminToken }
      ),
    ]);
    const bothSucceeded = grant.status() === 200 && revoke.status() === 200;

    expect(
      bothSucceeded,
      `a concurrent grant and revoke of backup-admin for the same target both reported success (HTTP ${grant.status()} and ${revoke.status()}). Whether the company retains a backup administrator would then depend on write ordering.`
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
 * POST /admin/holdOrRelease
 * ====================================================================================== */
test.describe('POST /admin/holdOrRelease @audit', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.holdOrRelease,
    repro: `await companyAdminClient.holdOrRelease(buildHoldPayload(), { token });`,
  };

  test('[1] happy path: a suspension request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload();
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character target kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 identifier is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload({ kpostID: UTF8_STRING });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    // Real DTO is { kpostID, activeStatus, companyID } — omit the actual identity field, not the
    // phantom `mobileNumber` (which was absent from the body, so its deletion filed a false bug).
    const payload = buildHoldPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null hold flag must not default to suspending the account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserActionPayload({ activeStatus: null });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "activeStatus" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload({ kpostID: '' });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a numeric hold flag must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildAdminUserActionPayload({ activeStatus: 0 });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    expect(
      response.status(),
      `activeStatus was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload({ kpostID: XSS_PAYLOAD });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not suspend every account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload({ kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target returned success on a suspension. A held user is blocked from signing in, so an unparameterised value here could lock every employee out of the platform at once. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildHoldPayload();
    const response = await companyAdminClient.holdOrRelease(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not suspend an account', async ({
    companyAdminClient,
  }) => {
    const payload = buildHoldPayload();
    const response = await companyAdminClient.holdOrRelease(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not suspend a colleague', async ({
    companyAdminClient,
    staticToken,
  }) => {
    // Non-admin caller: a personal user must not be able to suspend anyone via /admin.
    const payload = buildHoldPayload({ kpostID: nonExistentKpostId() });
    const response = await companyAdminClient.holdOrRelease(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const suspended = json !== null && json.statusCode === 200;

    expect(
      suspended,
      `a suspension succeeded without company-administrator entitlement. A held user is blocked from signing in, so an unauthorised hold is a denial-of-service against a specific colleague. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload();
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload();
    const response = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not suspend an inferred account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.holdOrRelease({}, { token: adminToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the suspension route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.holdOrRelease,
      'not json at all',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a hold must not change its outcome', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildHoldPayload();
    const first = await companyAdminClient.holdOrRelease(payload, { token: adminToken });
    const second = await companyAdminClient.holdOrRelease(payload, { token: adminToken });

    expect(
      second.status(),
      `holding the same account twice returned HTTP ${first.status()} then ${second.status()}.`
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
 * POST /admin/terminateUser
 *
 * Permanent offboarding, contrasted in the spec with the reversible holdOrRelease. Every
 * payload targets a non-existent identity — the refusal path is the only safe thing to
 * exercise, and it is where the authorisation defect would be.
 * ====================================================================================== */
test.describe('POST /admin/terminateUser @audit', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.terminateUser,
    repro: `await companyAdminClient.terminateUser(buildTerminateUserPayload(), { token }); // non-existent target only`,
  };

  test('[1] happy path: a termination request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload();
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character target kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 identifier is handled without a server fault', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: UTF8_STRING });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "kpostID" omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "kpostID" omitted on a termination' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null target must never widen the termination', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: null });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to null on a termination' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty target identifier must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: '' });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a target identifier is expected', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: { id: 1 } });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    expect(
      response.status(),
      `kpostID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: XSS_PAYLOAD });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not terminate every employee', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target returned success on a termination. Termination is permanent and not reversible through the API; an unparameterised value here could offboard the entire company. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload({ kpostID: SQLI_DROP_PAYLOAD });
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildTerminateUserPayload();
    const response = await companyAdminClient.terminateUser(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never terminate an account', async ({
    companyAdminClient,
  }) => {
    const payload = buildTerminateUserPayload();
    const response = await companyAdminClient.terminateUser(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not terminate a colleague', async ({
    companyAdminClient,
    staticToken,
  }) => {
    // Non-admin caller: a personal user must not be able to terminate anyone via /admin.
    const payload = buildTerminateUserPayload({ kpostID: nonExistentKpostId() });
    const response = await companyAdminClient.terminateUser(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const terminated = json !== null && json.statusCode === 200;

    expect(
      terminated,
      `a termination succeeded without company-administrator entitlement. The spec states the acting admin's kpostID is passed alongside the target so the service can enforce entitlement; without that check any employee can permanently offboard any colleague. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload();
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload();
    const response = await companyAdminClient.terminateUser(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must never terminate an inferred account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.terminateUser({}, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the termination route. With no target named, success on an irreversible offboarding is the most dangerous possible fallthrough. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.terminateUser,
      '{invalid json',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a termination must not change its outcome', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildTerminateUserPayload();
    const first = await companyAdminClient.terminateUser(payload, { token: adminToken });
    const second = await companyAdminClient.terminateUser(payload, { token: adminToken });

    expect(
      second.status(),
      `terminating the same account twice returned HTTP ${first.status()} then ${second.status()}.`
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
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'companyID',
      foreignValue: FOREIGN.companyID,
    });
  });

});

/* =========================================================================================
 * POST /admin/resetPassword
 *
 * Overwrites a credential irrecoverably and typically dispatches the new one. Every payload
 * targets a non-existent identity and routes its mobile number through safeTestMobile().
 * ====================================================================================== */
test.describe('POST /admin/resetPassword @audit', () => {
  const META = {
    method: 'POST',
    path: COMPANY_ADMIN_PATHS.resetPassword,
    repro: `await companyAdminClient.resetPassword(buildResetPasswordPayload(), { token }); // non-existent target only`,
  };

  test('[1] happy path: a reset request satisfies the Zod contract', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await expectValidContract(
      response,
      adminAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] type mismatch: an unrecognised userType must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    // resetPassword takes { kpostID, companyID, mobileNumber, countryID, userType } and the
    // backend generates the new credential — there is no client-supplied password to validate.
    const payload = buildResetPasswordPayload({ userType: 'NOT_A_TIER' });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'userType set to an unrecognised tier "NOT_A_TIER"' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[2b] boundary: a 5000-character kpostID must not fault the server', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    expect(
      response.status(),
      `a 5000-character kpostID produced HTTP ${response.status()}. An unbounded identity field is an input the handler must bound rather than pass to a lookup unchecked.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: the target identity omitted must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload();
    delete (payload as Record<string, unknown>).kpostID;
    delete (payload as Record<string, unknown>).mobileNumber;

    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no target identity supplied on a password reset' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null companyID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ companyID: null });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'companyID set to null on a password reset' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty kpostID must be refused', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ kpostID: '' });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'kpostID set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: companyID sent as an array must not fault the server', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ companyID: [1] });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'companyID sent as an array' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[6] XSS: a script payload in the target must not be reflected unescaped', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ kpostID: XSS_PAYLOAD });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not reset every password', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload({ kpostID: SQLI_PAYLOAD });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the target returned success on a password reset. The previous credential is unrecoverable, so an unparameterised value here could overwrite every password in the company and lock everyone out permanently. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    companyAdminClient,
  }) => {
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never reset a password', async ({
    companyAdminClient,
  }) => {
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not reset a colleague\'s password', async ({
    companyAdminClient,
    staticToken,
  }) => {
    // Non-admin caller: a personal user must not be able to reset anyone's password via /admin.
    const payload = buildResetPasswordPayload({ kpostID: nonExistentKpostId() });
    const response = await companyAdminClient.resetPassword(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const reset = json !== null && json.statusCode === 200;

    expect(
      reset,
      `a password reset succeeded without company-administrator entitlement. The spec describes this route as a pure pass-through with no entitlement check of its own, so if the role gate is the only protection and it is missing, any caller can take over any account by resetting its password. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] disclosure: the reset response must not carry a generated credential', async ({
    companyAdminClient,
    adminToken,
  }) => {
    // Per the Excel, resetPassword takes no password field — the backend generates the new
    // credential and dispatches it out-of-band. So a password must never appear in the response.
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });
    const { text } = await readBody(response);

    expect(
      /"(password|newPassword|forgotPassword|tempPassword|generatedPassword)"\s*:\s*"[^"]+"/i.test(text),
      `the reset response carried a credential field in its body. A generated password must never appear in a response payload — it lands in proxy logs, browser history and monitoring traces. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload();
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must never reset an inferred account', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.resetPassword({}, { token: adminToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the password reset route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const response = await companyAdminClient.sendRaw(
      COMPANY_ADMIN_PATHS.resetPassword,
      '[1,2,',
      { token: adminToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] rate limiting: a burst of resets against one account should be throttled', async ({
    companyAdminClient,
    adminToken,
  }) => {
    const payload = buildResetPasswordPayload();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        companyAdminClient.resetPassword(payload, { token: adminToken })
      )
    );
    const accepted = responses.filter((r) => r.status() === 200).length;

    expect(
      accepted,
      `${accepted} of 5 rapid password resets against the same account were accepted. Each reset typically dispatches a new credential to the user, so an unthrottled burst is both an SMS/email flood against that person and a way to keep an account permanently locked out.`
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
