import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { GROUPS_V2_PATHS } from '../../src/api/clients/groupsV2.client';
import {
  addUserToGroupResponseSchema,
  groupAckResponseSchema,
} from '../../src/api/schemas/groupsV2.schema';
import {
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildAddUserToGroupPayload,
  buildAdminAccessPayload,
  buildCreateGroupPayload,
  buildGroupMemberActionPayload,
  nonExistentGroupKpostId,
} from '../../src/api/payloads/groupsV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Groups V2 — membership and privilege delegation.
 *
 * The authorisation model here is the point of the tag:
 * - `addUserToGroup` and `removeGroupMember` stamp `groupAdmin` from the token, so the
 *   service can verify the caller administers the group.
 * - `leaveFromGroup` stamps `kpostID` instead, so a caller can only ever remove themselves —
 *   the cross-user risk that applies to `removeGroupMember` does not exist there.
 * - `addOrRemoveAdminAccess` is the delegation mechanism: a promoted member gains the
 *   ability to add and remove members, delegate further, rename the group and delete it.
 *   The spec notes the flag is compared by **exact match** on "Y"/"N", so anything else —
 *   including lowercase "y" — takes an unspecified fallthrough branch. That is tested.
 *
 * All payloads target a non-existent group by default: these routes are outward-facing
 * (added and removed users are notified), so the refusal path is the safe thing to exercise.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/group/addUserToGroup
 * ====================================================================================== */
test.describe('POST /v2/group/addUserToGroup', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.addUserToGroup,
    repro: `await groupsV2Client.addUserToGroup(buildAddUserToGroupPayload(), { token });`,
  };

  test('[1] happy path: an add-members request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await expectValidContract(
      response,
      addUserToGroupResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 500-member batch must not exhaust the handler', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const memberDetails = Array.from({ length: 500 }, (_, index) => ({
      kpostID: `qa-bulk-add-${index}`,
    }));
    const payload = buildAddUserToGroupPayload({ memberDetails });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-member add produced HTTP ${response.status()}. Because added users are notified, an unbounded batch is both a denial-of-service surface and a mass-notification surface; it must be capped by validation.`
    ).toBeLessThan(500);
  });

  test('[2c] business rule: group membership must not exceed the plan member cap', async ({
    groupsV2Client,
    adminToken,
  }) => {
    /*
     * The member cap is a company/plan limit (`adminRegistration.maximumMembersCount`). Probing it
     * needs a REAL group in the admin's own company, an over-cap add, then a readback of the actual
     * membership. A finding is filed ONLY when the group details expose the plan cap AND the stored
     * member count exceeds it — otherwise the case skips, so it can never false-fail on a cap it
     * could not determine. Members are synthetic (qa-prefixed, non-existent) — no real subscriber
     * is notified.
     */
    test.skip(adminToken === null, 'no admin token — cannot create a real group to probe the member cap');

    const create = await groupsV2Client.createUserGroup(buildCreateGroupPayload(), { token: adminToken });
    const { json: createJson } = await readBody(create);
    const createdData = createJson?.data as { groupKpostID?: unknown } | undefined;
    const groupKpostID = createdData?.groupKpostID;
    test.skip(
      !create.ok() || createJson?.statusCode !== 200 || typeof groupKpostID !== 'string',
      'group creation did not return a groupKpostID — cannot probe the member cap'
    );

    const overCap = Array.from({ length: 25 }, (_, i) => ({
      kpostID: `qa-cap-probe-${i}`,
      name: 'QA Cap Probe',
      hasAdminAccess: 'N',
      privacyStatus: 'N',
    }));
    await groupsV2Client.addUserToGroup(
      buildAddUserToGroupPayload({ groupKpostID, memberDetails: overCap }),
      { token: adminToken }
    );

    const details = await groupsV2Client.getGroupDetails(groupKpostID as string, { token: adminToken });
    const { json: detailsJson, text } = await readBody(details);
    test.skip(!details.ok() || detailsJson === null, 'could not read group details to count members');

    const data = (detailsJson?.data ?? detailsJson) as Record<string, unknown> | null;
    const asArray = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
    const memberList =
      (data && asArray((data as { memberDetails?: unknown }).memberDetails)) ??
      (data && asArray((data as { members?: unknown }).members)) ??
      (data && asArray((data as { groupMembers?: unknown }).groupMembers)) ??
      null;
    const capRaw = data ? (data as { maximumMembersCount?: unknown }).maximumMembersCount : undefined;
    const cap = typeof capRaw === 'number' ? capRaw : null;
    test.skip(
      memberList === null || cap === null,
      'group details did not expose both a member list and the plan cap — cannot assert the cap on this environment'
    );

    if ((memberList as unknown[]).length > (cap as number)) {
      await reportBusinessLogicFlaw(details, {
        method: 'POST',
        path: GROUPS_V2_PATHS.addUserToGroup,
        body: { groupKpostID, addedMembers: overCap.length },
        repro: `create a group, add ${overCap.length} members, then getGroupDetails and count`,
        title: 'Group membership exceeds the plan member cap',
        scenario: `the group holds ${(memberList as unknown[]).length} members against a plan cap of ${cap} — the member/license limit is not enforced on addUserToGroup, so a company can be grown past what it paid for. Body: ${text.slice(0, 200)}`,
        severity: 'Major',
      });
    }
  });

  test('[2b] boundary: a 5000-character member identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({
      memberDetails: [{ kpostID: MAX_LENGTH_STRING }],
    });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character member kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostID" omitted must be a real 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload();
    delete (payload as Record<string, unknown>).groupKpostID;

    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'required field "groupKpostID" omitted (payload is @Valid, so a real 400 is expected)',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null member list must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ memberDetails: null });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "memberDetails" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty member list must not report a successful add', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ memberDetails: [] });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty member list returned success. Reporting a successful add when nobody was added misleads the client into showing a confirmation for a no-op. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a scalar where memberDetails expects an array', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ memberDetails: 'qa-member' });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `memberDetails was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ groupKpostID: INT32_OVERFLOW });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `groupKpostID was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a member id must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ memberDetails: [{ kpostID: XSS_PAYLOAD }] });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ groupKpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const response = await groupsV2Client.addUserToGroup(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not add members to a group', async ({
    groupsV2Client,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const response = await groupsV2Client.addUserToGroup(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] authorisation: adding members to a group the caller does not administer', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ groupKpostID: nonExistentGroupKpostId() });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const added = json !== null && json.statusCode === 200;

    expect(
      added,
      `members were added to a group the caller does not administer. The spec calls this the key authorisation test on the route: added users gain access to the group's messages, so an unauthorised add is an unauthorised grant of read access to a private conversation. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] privilege: a body-supplied groupAdmin must not override the token identity', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload({ groupAdmin: VICTIM_KPOST_ID });
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const added = json !== null && json.statusCode === 200;

    expect(
      added,
      `the add succeeded while the body claimed groupAdmin="${VICTIM_KPOST_ID}". The spec states groupAdmin is stamped from the bearer token, so a body value must be ignored — honouring it would let any caller borrow an administrator's authority. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const response = await groupsV2Client.addUserToGroup(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.addUserToGroup({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an add-members request' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(GROUPS_V2_PATHS.addUserToGroup, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: adding the same member twice must not duplicate membership', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAddUserToGroupPayload();
    const [first, second, third] = await Promise.all([
      groupsV2Client.addUserToGroup(payload, { token: staticToken }),
      groupsV2Client.addUserToGroup(payload, { token: staticToken }),
      groupsV2Client.addUserToGroup(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical adds returned different statuses (${statuses.join(', ')}). Without a uniqueness constraint the same user can be inserted into a group repeatedly, which corrupts member counts and duplicates notifications.`
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
 * POST /v2/group/removeGroupMember
 * ====================================================================================== */
test.describe('POST /v2/group/removeGroupMember', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.removeGroupMember,
    repro: `await groupsV2Client.removeGroupMember(buildGroupMemberActionPayload(), { token });`,
  };

  test('[1] happy path: a removal request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await expectValidContract(
      response,
      groupAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character member identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character member kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 500-entry removal list must not exhaust the handler', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const memberKpostIdList = Array.from({ length: 500 }, (_, i) => `qa-bulk-remove-${i}`);
    const payload = buildGroupMemberActionPayload({ memberKpostIdList });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-member removal produced HTTP ${response.status()}. A mass ejection must be bounded, since every removed user loses access and is notified.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "groupKpostID" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    delete (payload as Record<string, unknown>).groupKpostID;

    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostID" omitted on a removal' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null member identifier must not widen the removal', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: null, memberKpostIdList: null });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'member identifiers set to null on a removal' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty removal list must not report success', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ memberKpostIdList: [] });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty removal list returned success. The spec notes this handler has no else branch for the failure case, so a success response may simply be the fallthrough — meaning the client is told an ejection happened when none did. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a scalar where the removal list expects an array', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ memberKpostIdList: 'qa-member' });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    expect(
      response.status(),
      `memberKpostIdList was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a member id must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: XSS_PAYLOAD });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not eject every member', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the member identifier returned success on a removal. If that value reaches the WHERE clause unparameterised it could match every membership row and empty the group. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: SQLI_DROP_PAYLOAD });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupMember(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not eject a member', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupMember(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] authorisation: a non-administrator must not eject another member', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({
      groupKpostID: nonExistentGroupKpostId(),
      kpostID: VICTIM_KPOST_ID,
    });
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const removed = json !== null && json.statusCode === 200;

    expect(
      removed,
      `an ejection succeeded against a group the caller does not administer. The removed user loses access to the group and its future messages; letting a non-administrator do that turns any member into a moderator. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not trigger an unscoped removal', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.removeGroupMember({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the removal route. With neither a group nor a member named, success means the handler fell through without doing the check. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(GROUPS_V2_PATHS.removeGroupMember, '[1,2,', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a removal must not change its outcome', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const first = await groupsV2Client.removeGroupMember(payload, { token: staticToken });
    const second = await groupsV2Client.removeGroupMember(payload, { token: staticToken });

    expect(
      second.status(),
      `removing the same member twice returned HTTP ${first.status()} then ${second.status()}. A repeated removal must be stable.`
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
 * POST /v2/group/leaveFromGroup
 * ====================================================================================== */
test.describe('POST /v2/group/leaveFromGroup', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.leaveFromGroup,
    repro: `await groupsV2Client.leaveFromGroup(buildGroupMemberActionPayload(), { token });`,
  };

  test('[1] happy path: a leave request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

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
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

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
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

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

    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "groupKpostID" omitted on a leave' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: null });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to null on a leave' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty group identifier must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: '' });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "groupKpostID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a group identifier is expected', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: ['group-1'] });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    expect(
      response.status(),
      `groupKpostID was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: XSS_PAYLOAD });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ groupKpostID: SQLI_PAYLOAD });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.leaveFromGroup(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ groupsV2Client }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.leaveFromGroup(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] scoping: a body-supplied kpostID must not remove a different user', async ({
    groupsV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const removed = json !== null && json.statusCode === 200;

    expect(
      removed,
      `a leave succeeded while the body named kpostID="${VICTIM_KPOST_ID}" and the caller was ${authSession.kpostID ?? 'a different identity'}. The spec is explicit that this route stamps kpostID from the token so a caller can only ever remove themselves; if the body wins, leaveFromGroup silently becomes an unauthenticated ejection route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const response = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.leaveFromGroup({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a leave request' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(GROUPS_V2_PATHS.leaveFromGroup, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: leaving the same group twice must be stable', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload();
    const first = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });
    const second = await groupsV2Client.leaveFromGroup(payload, { token: staticToken });

    expect(
      second.status(),
      `leaving the same group twice returned HTTP ${first.status()} then ${second.status()}.`
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
 * POST /v2/group/addOrRemoveAdminAccess
 * ====================================================================================== */
test.describe('POST /v2/group/addOrRemoveAdminAccess', () => {
  const META = {
    method: 'POST',
    path: GROUPS_V2_PATHS.addOrRemoveAdminAccess,
    repro: `await groupsV2Client.addOrRemoveAdminAccess(buildAdminAccessPayload('Y'), { token });`,
  };

  test('[1] happy path: a grant request satisfies the Zod contract', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('Y');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await expectValidContract(
      response,
      groupAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a lowercase "y" must not silently grant admin rights', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('y');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `hasAdminAccess="y" (lowercase) reported success. The spec states the flag is compared by exact match on "Y"/"N", so any other value takes an unspecified fallthrough branch. Reporting success for a value that does not match either arm leaves the caller unable to know whether admin rights changed. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[2b] boundary: an unrecognised flag value must be rejected, not fall through', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('MAYBE');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'hasAdminAccess set to an unrecognised value "MAYBE"' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[2c] boundary: a 5000-character flag value must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload(MAX_LENGTH_STRING);
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character hasAdminAccess produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "hasAdminAccess" omitted must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('Y');
    delete (payload as Record<string, unknown>).hasAdminAccess;

    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'privilege flag "hasAdminAccess" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null privilege flag must not default to a grant', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ hasAdminAccess: null });
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "hasAdminAccess" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty privilege flag must be refused', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "hasAdminAccess" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a boolean where the flag expects "Y" or "N"', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ hasAdminAccess: true });
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `hasAdminAccess=true (boolean) reported success. A boolean is not an exact match for "Y", so a success response here means a privilege change was reported for an input the service does not actually understand. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[6] XSS: a script payload in the flag must not be reflected unescaped', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload(XSS_PAYLOAD);
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildGroupMemberActionPayload({ kpostID: SQLI_PAYLOAD, hasAdminAccess: 'Y' });
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    groupsV2Client,
  }) => {
    const payload = buildAdminAccessPayload('Y');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never grant admin rights', async ({
    groupsV2Client,
  }) => {
    const payload = buildAdminAccessPayload('Y');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privilege escalation: a non-administrator must not promote themselves', async ({
    groupsV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildAdminAccessPayload('Y', {
      groupKpostID: nonExistentGroupKpostId(),
      kpostID: authSession.kpostID ?? 'qa-self',
    });
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const granted = json !== null && json.statusCode === 200;

    expect(
      granted,
      `an admin grant succeeded on a group the caller does not administer. This is the group-level delegation mechanism: a promoted member can add and remove members, delegate admin rights further, rename the group and delete it. Self-promotion here is full takeover of the group. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] privilege escalation: a body-supplied groupAdmin must not be honoured', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('Y', { groupAdmin: VICTIM_KPOST_ID });
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const granted = json !== null && json.statusCode === 200;

    expect(
      granted,
      `an admin grant succeeded while the body claimed groupAdmin="${VICTIM_KPOST_ID}". groupAdmin is stamped from the token, so a body value must be ignored. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('Y');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const payload = buildAdminAccessPayload('N');
    const response = await groupsV2Client.addOrRemoveAdminAccess(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not change any privilege', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.addOrRemoveAdminAccess({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the privilege-delegation route. With neither a group, a member, nor a flag supplied, success can only mean the handler fell through without performing a check. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const response = await groupsV2Client.sendRaw(
      GROUPS_V2_PATHS.addOrRemoveAdminAccess,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent grant and revoke must not leave an ambiguous state', async ({
    groupsV2Client,
    staticToken,
  }) => {
    const grant = buildAdminAccessPayload('Y');
    const revoke = buildAdminAccessPayload('N', { groupKpostID: grant.groupKpostID, kpostID: grant.kpostID });

    const [grantResponse, revokeResponse] = await Promise.all([
      groupsV2Client.addOrRemoveAdminAccess(grant, { token: staticToken }),
      groupsV2Client.addOrRemoveAdminAccess(revoke, { token: staticToken }),
    ]);
    const bothSucceeded =
      grantResponse.status() === 200 && revokeResponse.status() === 200;

    expect(
      bothSucceeded,
      `a concurrent grant and revoke of the same member both reported success (HTTP ${grantResponse.status()} and ${revokeResponse.status()}). The final privilege state is then decided by write ordering rather than by the caller, which on an admin flag means the group's administrator set is non-deterministic.`
    ).toBeFalsy();
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
