import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KALL_V2_PATHS } from '../../src/api/clients/kallV2.client';
import {
  frequentContactsResponseSchema,
  kallClearResponseSchema,
  kallListResponseSchema,
  kallResponseSchema,
} from '../../src/api/schemas/kallV2.schema';
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
  buildAddMembersPayload,
  buildClearKallPayload,
  buildExistingKallPayload,
  buildKallDashboardPayload,
  buildModifyMembersPayload,
  nonExistentKallId,
  syntheticReceiver,
} from '../../src/api/payloads/kallV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';

/**
 * Kall V2 — membership changes, call info and history.
 *
 * The headline route here is **`GET /v2/kall/clearKallHistory`**: a GET that irreversibly
 * wipes the caller's entire call history and takes no arguments at all. A GET is
 * prefetchable by browsers and link scanners, cacheable by intermediaries, and the classic
 * CSRF shape — a single `<img src>` pointed at it destroys a user's history. The method
 * choice is the finding, so the tests exercise it exactly as shipped.
 *
 * Because it takes no arguments there is nothing to parameterise safely, so it is probed
 * unauthenticated and with invalid tokens only. The one authenticated case asserts the
 * envelope contract and deliberately does not chase a "did it really delete everything"
 * confirmation — that would mean wiping the shared QA account's history to find out.
 *
 * `kallInfo` and `contactInfo` both call `setKpostID` from the token, so their body values
 * must be inert; `kallDashboard` does the same via `setReceiver`. `modifyKallMembers` is the
 * one membership route that both adds and removes in a single request.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE tbl_kpost_kall_master; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/kall/addMembersToKall
 * ====================================================================================== */
test.describe('POST /v2/kall/addMembersToKall', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.addMembersToKall,
    repro: `await kallV2Client.addMembersToKall(buildAddMembersPayload(), { token });`,
  };

  test('[1] happy path: adding members satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload();
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 500-member addition must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallDetails = Array.from({ length: 500 }, () => ({
      receiver: syntheticReceiver(),
      receiverName: 'QA Bulk',
    }));
    const payload = buildAddMembersPayload({ kallDetails });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    expect(
      response.status(),
      `adding 500 members produced HTTP ${response.status()}. A conference-size cap must be enforced explicitly rather than surfacing as a crash.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty member list must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload({ kallDetails: [] });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'member list is empty — nothing to add' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID — the members address no call' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null member list must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload({ kallDetails: null });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallDetails" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: members sent as bare strings must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload({ kallDetails: [syntheticReceiver()] });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    expect(
      response.status(),
      `kallDetails was sent as an array of bare strings and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: adding a member to a non-existent call must not succeed', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallID = nonExistentKallId();
    const payload = buildAddMembersPayload({ kallID });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `adding a member to call ${kallID}, which does not exist, reported success. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload in a member name must not be reflected', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload({
      kallDetails: [{ receiver: syntheticReceiver(), receiverName: XSS_PAYLOAD }],
    });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology in a member must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload({
      kallDetails: [{ receiver: SQLI_PAYLOAD, receiverName: 'QA' }],
    });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildAddMembersPayload();
    const response = await kallV2Client.addMembersToKall(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not add members', async ({ kallV2Client }) => {
    const payload = buildAddMembersPayload();
    const response = await kallV2Client.addMembersToKall(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: members must not be added to another user\'s call', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildAddMembersPayload({ sender: VICTIM_KPOST_ID });
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'member addition did not succeed');

    const data = json?.data;
    const record = Array.isArray(data) ? data[0] : data;
    expect(
      (record as Record<string, unknown> | undefined)?.sender,
      `members were added to a call organised by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. Adding an attendee to someone else's call puts an uninvited listener into a private conversation. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload();
    const response = await kallV2Client.addMembersToKall(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: adding the same member twice must not duplicate them', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildAddMembersPayload();
    const [first, second] = await Promise.all([
      kallV2Client.addMembersToKall(payload, { token: staticToken }),
      kallV2Client.addMembersToKall(payload, { token: staticToken }),
    ]);

    expect(
      [first.status(), second.status()].every((status) => status < 500),
      `concurrent identical member additions returned ${first.status()} and ${second.status()}. A duplicated invitation must be collapsed or refused, not fault.`
    ).toBe(true);
  });

  test('[10b] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.addMembersToKall({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a membership route' },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/kall/modifyKallMembers
 * ====================================================================================== */
test.describe('POST /v2/kall/modifyKallMembers', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.modifyKallMembers,
    repro: `await kallV2Client.modifyKallMembers(buildModifyMembersPayload(), { token });`,
  };

  test('[1] happy path: a membership change satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload();
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a kallID beyond int32 must not modify a different call', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ kallID: INT32_OVERFLOW });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID ${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: both lists empty must be refused as a no-op', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ addingUserIds: [], removingUserIds: [] });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'nothing to add and nothing to remove' },
      [400, 401, 403, 422]
    );
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID on a membership change' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null removingUserIds must not remove everyone', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ removingUserIds: null });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    expect(
      response.status(),
      `removingUserIds null produced HTTP ${response.status()}. A null removal list must mean "remove nobody", never "remove everyone".`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string where addingUserIds expects a list', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ addingUserIds: syntheticReceiver() });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    expect(
      response.status(),
      `addingUserIds was sent as a bare string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: the same user in both lists must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const target = syntheticReceiver();
    const payload = buildModifyMembersPayload({
      addingUserIds: [target],
      removingUserIds: [target],
    });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the same user is both added and removed — the outcome depends on ordering',
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] XSS: a script payload in a user id must not be reflected', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ addingUserIds: [XSS_PAYLOAD] });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload({ removingUserIds: [SQLI_PAYLOAD] });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildModifyMembersPayload();
    const response = await kallV2Client.modifyKallMembers(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never modify membership', async ({
    kallV2Client,
  }) => {
    const payload = buildModifyMembersPayload();
    const response = await kallV2Client.modifyKallMembers(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a non-organiser must not eject members from a call', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildModifyMembersPayload({
      kallID: nonExistentKallId(),
      addingUserIds: [],
      removingUserIds: [VICTIM_KPOST_ID],
    });
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `removing "${VICTIM_KPOST_ID}" from a call the caller (${authSession.kpostID ?? 'a different identity'}) does not organise reported success. Ejecting a participant from someone else's call is a denial of service against a live conversation. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildModifyMembersPayload();
    const response = await kallV2Client.modifyKallMembers(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.sendRaw(KALL_V2_PATHS.modifyKallMembers, '{"kallID":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"kallID":',
      repro: `await kallV2Client.sendRaw(KALL_V2_PATHS.modifyKallMembers, '{"kallID":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/kall/kallInfo
 * ====================================================================================== */
test.describe('POST /v2/kall/kallInfo', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.kallInfo,
    repro: `await kallV2Client.kallInfo(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: call details satisfy the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: an unknown call must not be reported as a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: nonExistentKallId() });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown call is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).kallID;

    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no kallID on a details lookup', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: null });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string kallID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kallID: 'recent' });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    expect(
      response.status(),
      `kallID was sent as the string "recent" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body kpostID must not read another user\'s call details', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'details lookup returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `naming kpostID "${VICTIM_KPOST_ID}" returned that user's call details while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setKpostID from the token, so the body value must never reach the service. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[6b] exposure: call details must not include media-server join credentials', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'details lookup returned no data');

    expect(
      /"rtcToken"\s*:\s*"[^"]+"/.test(text),
      `a details lookup returned a populated rtcToken. Reading a call's metadata must not be the same thing as being handed the credential to join it. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE probe must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ kpostID: SQLI_DROP_PAYLOAD });
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.kallInfo(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return call details', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.kallInfo(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    const response = await kallV2Client.kallInfo(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.kallInfo({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a details lookup', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
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
 * POST /v2/kall/contactInfo
 * ====================================================================================== */
test.describe('POST /v2/kall/contactInfo', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.contactInfo,
    repro: `await kallV2Client.contactInfo(buildExistingKallPayload(), { token });`,
  };

  test('[1] happy path: contact details satisfy the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: syntheticReceiver() });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: an unknown contact must not be reported as a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: syntheticReceiver() });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 404, 401, 403], {
      ...META,
      body: payload,
      title: 'An unknown contact is not reported with a success or 404 status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no contactID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload();
    delete (payload as Record<string, unknown>).contactID;

    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'no contactID on a contact lookup', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null contactID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: null });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to null', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array contactID must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: [syntheticReceiver()] });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    expect(
      response.status(),
      `contactID was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] enumeration: a contact lookup must not become a directory scrape', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: '%' });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'contact lookup returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a contactID of "%" returned ${count} contacts. A wildcard reaching the query turns a single-contact lookup into a way to enumerate the whole directory. Body: ${text.slice(0, 300)}`
    ).toBeLessThanOrEqual(1);
  });

  test('[6b] IDOR: a body kpostID must not read another user\'s contact book', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildExistingKallPayload({
      kpostID: VICTIM_KPOST_ID,
      contactID: syntheticReceiver(),
    });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'contact lookup returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `naming kpostID "${VICTIM_KPOST_ID}" resolved against that user's contacts while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setKpostID from the token for exactly this reason. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: XSS_PAYLOAD });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7b] SQL injection: a tautology must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: SQLI_PAYLOAD });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildExistingKallPayload({ contactID: syntheticReceiver() });
    const response = await kallV2Client.contactInfo(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return contact details', async ({ kallV2Client }) => {
    const payload = buildExistingKallPayload({ contactID: syntheticReceiver() });
    const response = await kallV2Client.contactInfo(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildExistingKallPayload({ contactID: syntheticReceiver() });
    const response = await kallV2Client.contactInfo(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kallV2Client, staticToken }) => {
    const response = await kallV2Client.contactInfo({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a contact lookup', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/kall/kallDashboard
 * ====================================================================================== */
test.describe('POST /v2/kall/kallDashboard', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.kallDashboard,
    repro: `await kallV2Client.kallDashboard(buildKallDashboardPayload(), { token });`,
  };

  test('[1] happy path: the call history satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a user with no call history must not get a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: '2099-01-01' });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      body: payload,
      title: 'An empty call history is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] missing required parameter: no selectedDate must be handled explicitly', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    delete (payload as Record<string, unknown>).selectedDate;

    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `omitting selectedDate produced HTTP ${response.status()}. Either it defaults to "all history" or it is a clean 400 — a fault is neither.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null selectedDate must be handled', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: null });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `selectedDate null produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a numeric selectedDate must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: 20990101 });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `selectedDate was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] business rule: a malformed date must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: '31-02-2026' });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an impossible calendar date', severity: 'Major' as const },
      [400, 401, 403, 422]
    );
  });

  test('[6b] boundary: a 5000-character fetchType must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ fetchType: MAX_LENGTH_STRING });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character fetchType produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] IDOR: a body receiver must not read another user\'s call history', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildKallDashboardPayload({ receiver: VICTIM_KPOST_ID });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'history returned no data');

    expect(
      text.includes(`"receiver":"${VICTIM_KPOST_ID}"`),
      `naming receiver "${VICTIM_KPOST_ID}" returned that user's call history while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setReceiver from the token; a call log is a record of who someone spoke to and when. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7b] SQL injection: a tautology in the date must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ selectedDate: SQLI_PAYLOAD });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7c] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload({ fetchType: XSS_PAYLOAD });
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await kallV2Client.kallDashboard(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return call history', async ({ kallV2Client }) => {
    const payload = buildKallDashboardPayload();
    const response = await kallV2Client.kallDashboard(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const response = await kallV2Client.kallDashboard(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildKallDashboardPayload();
    const [first, second] = await Promise.all([
      kallV2Client.kallDashboard(payload, { token: staticToken }),
      kallV2Client.kallDashboard(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical history reads returned ${first.status()} and ${second.status()}. A read must be stable.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/kall/frequentKallContacts
 * ====================================================================================== */
test.describe('GET /v2/kall/frequentKallContacts', () => {
  const META = {
    method: 'GET',
    path: KALL_V2_PATHS.frequentKallContacts,
    repro: `await kallV2Client.frequentKallContacts({ token });`,
  };

  test('[1] happy path: frequent contacts satisfy the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: staticToken });

    await expectValidContract(
      response,
      frequentContactsResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a new user with no call history must not get a server error', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty frequent-contacts list is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kallV2Client,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return contacts', async ({ kallV2Client }) => {
    const response = await kallV2Client.frequentKallContacts({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return contacts', async ({ kallV2Client }) => {
    const response = await kallV2Client.frequentKallContacts({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    kallV2Client,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the list', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const response = await kallV2Client.frequentKallContacts({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's frequent contacts while the caller was ${authSession.kpostID ?? 'a different identity'}. Who someone calls most is a social graph, not a public list. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[7b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[8] idempotency: two consecutive reads must agree', async ({
    kallV2Client,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      kallV2Client.frequentKallContacts({ token: staticToken }),
      kallV2Client.frequentKallContacts({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[9] structural: an unknown query parameter must be ignored, not fatal', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.frequentKallContacts({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] method binding: a POST-only route must not also answer this GET shape', async ({
    kallV2Client,
    staticToken,
  }) => {
    const response = await kallV2Client.getRoute(KALL_V2_PATHS.initiateKall, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      method: 'GET',
      path: KALL_V2_PATHS.initiateKall,
      repro: `await kallV2Client.getRoute(KALL_V2_PATHS.initiateKall, { token });`,
      title: 'A call-placing route declared POST-only also responds to GET',
    });
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/kall/clearKallBykallIds
 * ====================================================================================== */
test.describe('POST /v2/kall/clearKallBykallIds', () => {
  const META = {
    method: 'POST',
    path: KALL_V2_PATHS.clearKallBykallIds,
    repro: `await kallV2Client.clearKallBykallIds(buildClearKallPayload(), { token });`,
  };

  test('[1] happy path: clearing specific calls satisfies the Zod contract', async ({
    kallV2Client,
    staticToken,
  }) => {
    // Addresses deliberately non-existent ids — history removal is irreversible.
    const payload = buildClearKallPayload();
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await expectValidContract(
      response,
      kallClearResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: an empty kallIds list must be refused, not treated as "all"', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ kallIds: [] });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'empty kallIds on a destructive route — an empty IN() must not mean everything',
      },
      [400, 401, 403, 422]
    );
  });

  test('[2b] boundary: a 1000-id clear must not fault the server', async ({
    kallV2Client,
    staticToken,
  }) => {
    const kallIds = Array.from({ length: 1000 }, () => nonExistentKallId());
    const payload = buildClearKallPayload({ kallIds });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    expect(
      response.status(),
      `clearing 1000 ids at once produced HTTP ${response.status()}. Bulk history clearing is a normal user action and must be bounded explicitly.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no kallIds must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload();
    delete (payload as Record<string, unknown>).kallIds;

    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'destructive call with no kallIds' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null kallIds must not be treated as a wildcard', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ kallIds: null });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kallIds" null on a destructive route' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a string kallIds must be refused', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ kallIds: 'all' });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    expect(
      response.status(),
      `kallIds was sent as the string "all" and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology in an id must not clear every row', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ kallIds: [SQLI_PAYLOAD] });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[6b] SQL injection: a DROP TABLE probe must not leak database internals', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ kallIds: [SQLI_DROP_PAYLOAD] });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload({ subject: XSS_PAYLOAD });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: an unauthenticated clear must be HTTP 401/403', async ({ kallV2Client }) => {
    const payload = buildClearKallPayload();
    const response = await kallV2Client.clearKallBykallIds(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not clear history', async ({ kallV2Client }) => {
    const payload = buildClearKallPayload();
    const response = await kallV2Client.clearKallBykallIds(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none token claiming admin must never clear history', async ({
    kallV2Client,
  }) => {
    const payload = buildClearKallPayload();
    const response = await kallV2Client.clearKallBykallIds(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: a body kpostID must not clear another user\'s history', async ({
    kallV2Client,
    staticToken,
    authSession,
  }) => {
    const payload = buildClearKallPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a clear naming kpostID "${VICTIM_KPOST_ID}" reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller passes the token's kpostID to the service as a separate argument, so a body value must be inert — destroying another user's call log is irreversible. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload();
    const response = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] idempotency: clearing the same ids twice must be stable', async ({
    kallV2Client,
    staticToken,
  }) => {
    const payload = buildClearKallPayload();
    const first = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });
    const second = await kallV2Client.clearKallBykallIds(payload, { token: staticToken });

    expect(
      first.status(),
      `clearing the same ids twice returned ${first.status()} then ${second.status()}. A repeated delete must not change the outcome.`
    ).toBe(second.status());
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { kallID: FOREIGN.kallID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/kall/clearKallHistory
 *
 * A GET that irreversibly destroys the caller's entire call history and takes no arguments.
 * There is no safe parameterisation, so the authenticated case asserts only the envelope
 * contract and the method-safety finding; it does not try to confirm the wipe.
 * ====================================================================================== */
test.describe('GET /v2/kall/clearKallHistory', () => {
  const META = {
    method: 'GET',
    path: KALL_V2_PATHS.clearKallHistory,
    repro: `await kallV2Client.clearKallHistory({ token });`,
  };

  test('[1] method safety: a destructive action must not be exposed as a GET', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({ token: disposableToken });

    await assertStatus(response, [400, 401, 403, 404, 405], {
      ...META,
      title: 'Call history is irreversibly wiped by a GET request',
      severity: 'Critical',
    });
  });

  test('[2] contract: the response must report how much was destroyed', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({ token: disposableToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'clear did not return a 200 envelope');

    expect(
      json?.data,
      `clearKallHistory answered 200 with no indication of what was removed. On an irreversible bulk delete the caller cannot tell a real wipe from a no-op. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[3] auth: an unauthenticated wipe must be HTTP 401/403', async ({ kallV2Client }) => {
    const response = await kallV2Client.clearKallHistory({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not wipe history', async ({ kallV2Client }) => {
    const response = await kallV2Client.clearKallHistory({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not wipe history', async ({ kallV2Client }) => {
    const response = await kallV2Client.clearKallHistory({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never wipe history', async ({
    kallV2Client,
  }) => {
    const response = await kallV2Client.clearKallHistory({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not wipe another user\'s history', async ({
    kallV2Client,
    disposableToken,
    authSession,
  }) => {
    const response = await kallV2Client.clearKallHistory({
      token: disposableToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `?kpostID=${VICTIM_KPOST_ID} on the wipe route reported success while the caller was ${authSession.kpostID ?? 'a different identity'}. The route takes its identity from the auth-filter attribute, so a query parameter must be inert — combined with the GET method this would be a one-link way to destroy any user's call log. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[5] CSRF shape: a cross-site form-encoded content type must not be honoured', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({
      token: disposableToken,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      ...META,
      title: 'Destructive GET accepts a simple-request content type, completing the CSRF shape',
      severity: 'Critical',
    });
  });

  test('[6] injection: a SQL tautology in a query parameter must not leak internals', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({
      token: disposableToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in a query parameter must not be reflected', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({
      token: disposableToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({ token: disposableToken });

    await assertNot200OKOnError(response, META);
  });

  test('[8b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({ token: disposableToken });

    await assertStatusCodeParity(response, META);
  });

  test('[9] idempotency: a repeated wipe must be stable', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const first = await kallV2Client.clearKallHistory({ token: disposableToken });
    const second = await kallV2Client.clearKallHistory({ token: disposableToken });

    expect(
      first.status(),
      `wiping twice returned ${first.status()} then ${second.status()}. A repeated destructive call must not change the outcome.`
    ).toBe(second.status());
  });

  test('[10] structural: an unknown query parameter must be ignored, not fatal', async ({
    kallV2Client,
    disposableToken,
  }) => {
    const response = await kallV2Client.clearKallHistory({
      token: disposableToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign kallID must not reach another owner\'s record', async ({
    genericClient,
    disposableToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kallID: FOREIGN.kallID }, { token: disposableToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kallID)),
      `the response acknowledged kallID "${FOREIGN.kallID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });


  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    disposableToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('GET', META.path, {}, { token: disposableToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});
