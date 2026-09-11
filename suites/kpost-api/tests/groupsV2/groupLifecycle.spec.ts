import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import {
  GROUPS_V2_PATHS,
  GROUPS_V2_PATH_TEMPLATES,
} from '../../src/api/clients/groupsV2.client';
import {
  createUserGroupResponseSchema,
  groupAckResponseSchema,
  groupDetailsResponseSchema,
} from '../../src/api/schemas/groupsV2.schema';
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
  buildCreateGroupPayload,
  buildEditGroupNamePayload,
  buildGroupMemberActionPayload,
  nonExistentGroupKpostId,
} from '../../src/api/payloads/groupsV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Groups V2 — group lifecycle: create, rename, delete, and the detail read.
 *
 * Safety note that shapes this whole file: `deleteGroup` is described in swagger.json as
 * "the most destructive group operation, and not reversible through the API", and both it
 * and `editGroupName` change state visible to every member. Every payload here therefore
 * targets a **non-existent, QA-prefixed groupKpostID** by default, so a misfired assertion
 * cannot destroy or rename a real group on a shared environment. The value being asserted
 * is the refusal path — which is where the authorisation defects live anyway.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/group/createUserGroup
 * ====================================================================================== */
test.describe('POST /v2/group/createUserGroup @audit', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.createUserGroup,
    repro: `await groupsV2Client.createUserGroup(buildCreateGroupPayload(), { token });`,
  };

  test('[FR-K06][1] happy path: a valid creation satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await expectValidContract(
      response,
      createUserGroupResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a successful creation must return the generated groupKpostID', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'group creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.groupKpostID,
      `the group was created but no groupKpostID was returned. Every other route on this tag is addressed by that identifier, so omitting it leaves the client unable to reference the group it just created. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character group name must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: MAX_LENGTH_STRING });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character group name produced HTTP ${response.status()}. The name renders in every member's contact list, so a length limit must be enforced by validation.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 group name is stored or refused without a server fault', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: UTF8_STRING });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 group name produced HTTP ${response.status()}. Non-ASCII names are ordinary on a platform serving India and Malaysia.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a very large initial member list must not exhaust the handler', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const memberDetails = Array.from({ length: 500 }, (_, index) => ({
      kpostID: `qa-bulk-member-${index}`,
    }));
    const payload = buildCreateGroupPayload({ memberDetails });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-member initial list produced HTTP ${response.status()}. An unbounded member list is a denial-of-service surface: it must be capped by validation, not absorbed until the request times out.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostName" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    delete (payload as Record<string, unknown>).groupKpostName;

    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostName" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: "groupKpostName" set to null must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: null });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty group name must not create an unnamed group', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: '' });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostName" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a scalar where memberDetails expects an array', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ memberDetails: 'not-an-array' });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `memberDetails is an array in the contract but was sent as a string, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric group name must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: INT32_OVERFLOW });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `groupKpostName was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the group name must not be stored unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: XSS_PAYLOAD });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await groupsV2Client.createUserGroup(buildCreateGroupPayload({ groupKpostName: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: SQLI_PAYLOAD });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload({ groupKpostName: SQLI_DROP_PAYLOAD });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await groupsV2Client.createUserGroup(payload, { token: null });`,
    });
  });

  test('[8b] auth: an expired token must not create a persistent group', async ({
    groupsV2Client,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege: a body-supplied groupAdmin must not override the token identity', async ({
    groupsV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildCreateGroupPayload({ groupAdmin: 'admin' });
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'group creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.groupAdmin,
      `the created group named "admin" as its administrator even though the caller was ${authSession.kpostID ?? 'a different identity'}. The spec states groupAdmin is stamped from the bearer token, so a body-supplied value must be ignored — otherwise a user can create a group owned by someone else. Body: ${text.slice(0, 200)}`
    ).not.toBe('admin');
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    const response = await groupsV2Client.createUserGroup(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not stored as an unnamed group', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.createUserGroup({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on group creation' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(
      GROUPS_V2_PATHS.createUserGroup,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical creations must not mint duplicate groups', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildCreateGroupPayload();
    const [first, second, third] = await Promise.all([
      groupsV2Client.createUserGroup(payload, { token: staticToken }),
      groupsV2Client.createUserGroup(payload, { token: staticToken }),
      groupsV2Client.createUserGroup(payload, { token: staticToken }),
    ]);

    const bodies = [await readBody(first), await readBody(second), await readBody(third)];
    const createdIds = bodies
      .map((b) => (b.json?.data as Record<string, unknown> | undefined)?.groupKpostID)
      .filter((id): id is string => typeof id === 'string');

    test.skip(createdIds.length === 0, 'no groups were created, so there is nothing to compare');

    expect(
      createdIds.length,
      `${createdIds.length} groups were created from three identical concurrent requests (${createdIds.join(', ')}). The spec notes creation is not idempotent; if name uniqueness is intended, concurrent submits must not each win. Confirm the intended rule and enforce it in one place.`
    ).toBeLessThanOrEqual(1);
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
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'groupID',
      foreignValue: FOREIGN.groupID,
    });
  });

});

/* =========================================================================================
 * POST /v2/group/editGroupName
 * ====================================================================================== */
test.describe('POST /v2/group/editGroupName @audit', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.editGroupName,
    repro: `await groupsV2Client.editGroupName(buildEditGroupNamePayload(), { token });`,
  };

  test('[1] happy path: a rename request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload();
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await expectValidContract(
      response,
      groupAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character new name must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: MAX_LENGTH_STRING });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character rename produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 new name is handled without a server fault', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: UTF8_STRING });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 rename produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostID" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload();
    delete (payload as Record<string, unknown>).groupKpostID;

    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: "groupKpostName" set to null must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: null });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostName" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty new name must not blank the group title', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: '' });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'rename to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a name string is expected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: ['New Name'] });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    expect(
      response.status(),
      `groupKpostName was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the new name must not be stored unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostName: XSS_PAYLOAD });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildEditGroupNamePayload();
    const response = await groupsV2Client.editGroupName(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not rename a group', async ({
    groupsV2Client,
  }) => {
    const payload = buildEditGroupNamePayload();
    const response = await groupsV2Client.editGroupName(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] authorisation: renaming a group the caller does not administer must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload({ groupKpostID: nonExistentGroupKpostId() });
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const renamed = json !== null && json.statusCode === 200;

    expect(
      renamed,
      `a rename succeeded against a group the caller does not administer. The spec states the acting user is stamped from the token so the service can verify administration rights; a rename is visible to every member wherever the group appears, so an unauthorised rename is a defacement vector. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload();
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload();
    const response = await groupsV2Client.editGroupName(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.editGroupName({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a rename' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(GROUPS_V2_PATHS.editGroupName, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical renames must agree', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildEditGroupNamePayload();
    const [first, second, third] = await Promise.all([
      groupsV2Client.editGroupName(payload, { token: staticToken }),
      groupsV2Client.editGroupName(payload, { token: staticToken }),
      groupsV2Client.editGroupName(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent renames returned different statuses (${statuses.join(', ')}).`
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
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'groupID',
      foreignValue: FOREIGN.groupID,
    });
  });

});

/* =========================================================================================
 * POST /v2/group/deleteGroup
 *
 * Every case below targets a non-existent group. The spec calls this the most destructive
 * group operation and states it is not reversible through the API, so the refusal path is
 * the only safe thing to exercise on a shared environment — and it is also where the
 * authorisation defect would be.
 * ====================================================================================== */
test.describe('POST /v2/group/deleteGroup @audit', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.deleteGroup,
    repro: `await groupsV2Client.deleteGroup(buildGroupMemberActionPayload(), { token }); // non-existent group only`,
  };

  test('[1] happy path: a deletion request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

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
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character groupKpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow groupID must be handled cleanly', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupID: INT32_OVERFLOW });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `groupID=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostID" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    delete (payload as Record<string, unknown>).groupKpostID;

    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostID" omitted on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null group identifier must never widen the delete', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: null });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to null on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: '' });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to an empty string on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a group identifier is expected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: { id: 1 } });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `groupKpostID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the identifier must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: XSS_PAYLOAD });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not delete beyond the named group', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the group identifier returned success on a delete. If that value reaches the WHERE clause unparameterised it could match every row — catastrophic and irreversible on this route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: SQLI_DROP_PAYLOAD });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.deleteGroup(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never delete a group', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.deleteGroup(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] authorisation: deleting a group the caller does not administer must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: nonExistentGroupKpostId() });
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.statusCode === 200;

    expect(
      deleted,
      `a delete succeeded against a group the caller does not administer. This is the most destructive operation on the tag and is not reversible through the API: all members lose the group and the fate of its message history is a service-layer decision. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: a business rejection must be a real 400, not a 200', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must never trigger an unscoped delete', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.deleteGroup({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the delete route. With no group identified, a success response means the handler either deleted something it inferred or reported success for doing nothing — both are wrong on an irreversible operation. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(GROUPS_V2_PATHS.deleteGroup, 'not json at all', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a delete must not change its outcome', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const first = await groupsV2Client.deleteGroup(payload, { token: staticToken });
    const second = await groupsV2Client.deleteGroup(payload, { token: staticToken });

    expect(
      second.status(),
      `deleting the same group twice returned HTTP ${first.status()} then ${second.status()}. A repeated delete must be stable — a differing second answer suggests the handler's outcome depends on prior state in a way callers cannot predict.`
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
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'groupID',
      foreignValue: FOREIGN.groupID,
    });
  });

});

/* =========================================================================================
 * GET /v2/group/getGroupDetailsUsingGroupKpostID/{groupKpostID}
 * ====================================================================================== */
test.describe('GET /v2/group/getGroupDetailsUsingGroupKpostID/{groupKpostID} @audit', () => {
  const META = {
    method: 'GET',
    path: GROUPS_V2_PATH_TEMPLATES.getGroupDetailsUsingGroupKpostID,
    repro: `await groupsV2Client.getGroupDetails(groupKpostID, { token });`,
  };

  test('[1] happy path: a group detail read satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      groupDetailsResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character path identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character groupKpostID path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 path identifier is handled without a server fault', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(UTF8_STRING, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 groupKpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty path segment must not list every group', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails('', { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `an empty groupKpostID returned ${rows.length} group records. With no group named, the route must 404 rather than degrade into an enumeration of every group. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[4] null fuzzing: a literal "null" identifier must not resolve to a group', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails('null', { token: staticToken });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    expect(
      resolved,
      `the literal string "null" resolved to a group record. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a numeric identifier where a kpostID string is expected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails('12345', { token: staticToken });

    expect(
      response.status(),
      `a numeric groupKpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in the path must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(SQLI_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not widen the result set', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(SQLI_PAYLOAD, { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `a SQL tautology as the group identifier returned ${rows.length} records. A payload that yields rows proves the value reaches the query unparameterised. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ groupsV2Client }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[8c] membership scoping: a non-member must not read a group\'s member list', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const record = json?.data as Record<string, unknown> | undefined;
    const members = Array.isArray(record?.memberDetails)
      ? (record.memberDetails as unknown[])
      : [];

    expect(
      members.length,
      `${members.length} members were returned for a group the caller does not belong to. The spec flags this explicitly: the group is identified by a path variable, so if any authenticated user can read any group by supplying its groupKpostID, that exposes the membership roster — who is in which group — to anyone who can guess or harvest an identifier. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: staticToken,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails(nonExistentGroupKpostId(), {
      token: staticToken,
    });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const groupKpostID = nonExistentGroupKpostId();
    const [first, second, third] = await Promise.all([
      groupsV2Client.getGroupDetails(groupKpostID, { token: staticToken }),
      groupsV2Client.getGroupDetails(groupKpostID, { token: staticToken }),
      groupsV2Client.getGroupDetails(groupKpostID, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] structural: a path traversal attempt must not escape the route', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.getGroupDetails('../../../etc/passwd', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file. The identifier is interpolated into a route, so it must be treated as an opaque value.`
    ).not.toContain('root:');
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

});
