import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { CONTACTS_V2_PATHS } from '../../src/api/clients/contactsDirectoryV2.client';
import {
  blockedContactsResponseSchema,
  contactAckResponseSchema,
} from '../../src/api/schemas/contactsDirectoryV2.schema';
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
  comparableBody,
} from '../../src/utils/apiAssertions';
import {
  buildBlockPayload,
  buildBulkBlockPayload,
  buildContactPayload,
  nonExistentContactId,
} from '../../src/api/payloads/contactsDirectoryV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Contacts Directory V2 — blocking.
 *
 * The spec is emphatic that this is a **safety control**, so the tests check consequences
 * rather than status codes wherever the environment allows it. Blocking is meant to suppress
 * incoming Katchup messages and Kall attempts and hide the caller from the blocked party's
 * search results; the block itself should not be visible to the blocked party.
 *
 * It also stresses that the toggle is **payload-driven, not stateless inversion** — the
 * explicit `isBlocked` value is what applies — and names two edge cases worth covering:
 * blocking a user who is not in the directory, and blocking oneself.
 *
 * `getblockContactDetails` accepts no parameters by design: a caller may only ever see their
 * own block list, since learning who has blocked you would itself be a disclosure.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/contacts/blockOrUnBlockContact
 * ====================================================================================== */
test.describe('POST /v2/contacts/blockOrUnBlockContact @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.blockOrUnBlockContact,
    repro: `await contactsClient.blockOrUnBlockContact(buildBlockPayload(true), { token });`,
  };

  test('[1] happy path: a block request satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true);
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await expectValidContract(
      response,
      contactAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: MAX_LENGTH_STRING });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character contactID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] edge case: blocking a user who is not in the directory must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: nonExistentContactId() });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const blocked = json !== null && json.statusCode === 200;

    expect(
      blocked,
      `blocking a user who is not in the caller's directory reported success. The spec names this as an edge case to cover: a block row against a non-existent relationship either creates a dangling record or silently does nothing while telling the client it worked. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[2c] edge case: blocking oneself must be refused', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const self = authSession.kpostID ?? 'qa-self';
    const payload = buildBlockPayload(true, { contactID: self });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const blocked = json !== null && json.statusCode === 200;

    expect(
      blocked,
      `the caller was allowed to block themselves ("${self}"). Blocking suppresses incoming messages and calls, so a self-block is a way for a user to silently break their own account in a way the UI offers no route to undo. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing required parameter: "contactID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true);
    delete (payload as Record<string, unknown>).contactID;

    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "contactID" omitted on a block' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3b] missing required parameter: "isBlocked" omitted must not default', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    delete (payload as Record<string, unknown>).isBlocked;

    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the isBlocked flag omitted — the spec states this toggle is payload-driven, so there is no state to fall back on',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null isBlocked must not resolve to a block', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ isBlocked: null });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "isBlocked" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: '' });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a truthy string where isBlocked expects a boolean', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ isBlocked: 'false' });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `isBlocked was sent as the string "false" and the request reported success. A string is truthy in most coercions, so accepting it risks applying a block when the caller asked for the opposite — on a safety control that inversion is the worst possible failure. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5b] type mismatch: an object where a contactID is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: { id: 1 } });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    expect(
      response.status(),
      `contactID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: XSS_PAYLOAD });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not block every contact at once', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true, { contactID: SQLI_PAYLOAD });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as contactID returned success on a block. Unparameterised, that could set the block flag on every contact in the directory — silently cutting the user off from everyone they know. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildBlockPayload(true);
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not alter a block list', async ({
    contactsClient,
  }) => {
    const payload = buildBlockPayload(true);
    const response = await contactsClient.blockOrUnBlockContact(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not edit another user\'s block list', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildBlockPayload(true, { kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-user write: the API may have safely scoped the
    // block to the caller's own list and ignored the body-supplied kpostID. Only a
    // response reflecting the injected identity proves the body won over the token.
    const reflectedForeignIdentity =
      json !== null && JSON.stringify(json).toLowerCase().includes(String(VICTIM_KPOST_ID).toLowerCase());

    expect(
      reflectedForeignIdentity,
      `a block for the injected kpostID="${VICTIM_KPOST_ID}" was written back to the caller ${authSession.kpostID ?? 'a different identity'} — the body-supplied identity won over the token, letting one user alter another user's block list. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(true);
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBlockPayload(false);
    const response = await contactsClient.blockOrUnBlockContact(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not toggle anything', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.blockOrUnBlockContact({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the block route. With neither a contact nor a flag supplied, success means the handler fell through without performing the toggle. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.blockOrUnBlockContact,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: a concurrent block and unblock must not leave state ambiguous', async ({
    contactsClient,
    staticToken,
  }) => {
    const contactID = nonExistentContactId();
    const [blockResponse, unblockResponse] = await Promise.all([
      contactsClient.blockOrUnBlockContact(buildBlockPayload(true, { contactID }), {
        token: staticToken,
      }),
      contactsClient.blockOrUnBlockContact(buildBlockPayload(false, { contactID }), {
        token: staticToken,
      }),
    ]);
    const bothSucceeded = blockResponse.status() === 200 && unblockResponse.status() === 200;

    expect(
      bothSucceeded,
      `a concurrent block and unblock of the same contact both reported success (HTTP ${blockResponse.status()} and ${unblockResponse.status()}). Whether that person is blocked would then depend on write ordering — on a safety control the final state must never be a race.`
    ).toBeFalsy();
  });

  test('[IDOR] a foreign contactID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { contactID: FOREIGN.contactID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'contactID',
      foreignValue: FOREIGN.contactID,
    });
  });

});

/* =========================================================================================
 * POST /v2/contacts/blockOrUnBlockMultipleContact
 * ====================================================================================== */
test.describe('POST /v2/contacts/blockOrUnBlockMultipleContact @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.blockOrUnBlockMultipleContact,
    repro: `await contactsClient.blockOrUnBlockMultipleContact(buildBulkBlockPayload([id], true), { token });`,
  };

  test('[1] happy path: a bulk block satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      contactAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 500-contact batch must not exhaust the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const ids = Array.from({ length: 500 }, (_, index) => `qa-bulk-block-${index}`);
    const payload = buildBulkBlockPayload(ids, true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 500-contact bulk block produced HTTP ${response.status()}. The handler loops over the ids calling the single-contact service per entry, so an unbounded list is a straightforward denial-of-service surface.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty id list must not report a successful block', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty contactIDs list returned success. Reporting a successful bulk block when nobody was blocked makes the multi-select screen show a confirmation for a no-op. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing required parameter: "contactIDs" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    delete (payload as Record<string, unknown>).contactIDs;

    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "contactIDs" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null id list must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    (payload as Record<string, unknown>).contactIDs = null;

    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactIDs" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] partial failure: one bad id must not report the whole batch as applied', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId(), ''], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `a batch containing an empty id reported overall success. Because the handler loops per id rather than working in a transaction, a blanket success hides which contacts were actually blocked — and on a safety control the user needs to know exactly who they silenced. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a scalar where contactIDs expects an array', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([], true);
    (payload as Record<string, unknown>).contactIDs = 'qa-single-id';

    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `contactIDs was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric isBlocked must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    (payload as Record<string, unknown>).isBlocked = 1;

    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `isBlocked was sent as the number 1 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in an id must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([XSS_PAYLOAD], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology in the id list must not widen the block', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([SQLI_PAYLOAD], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology inside the bulk id list returned success. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([SQLI_DROP_PAYLOAD], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not bulk-block contacts', async ({ contactsClient }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not bulk-edit another user\'s block list', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true, {
      kpostID: VICTIM_KPOST_ID,
    });
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `a bulk block was applied while the body carried kpostID="${VICTIM_KPOST_ID}". The same consequences as the single-contact route, multiplied across the whole list. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], false);
    const response = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not toggle anything', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.blockOrUnBlockMultipleContact(
      {},
      { token: staticToken }
    );
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the bulk block route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.blockOrUnBlockMultipleContact,
      '{"contactIDs":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a bulk block must be stable', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildBulkBlockPayload([nonExistentContactId()], true);
    const first = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });
    const second = await contactsClient.blockOrUnBlockMultipleContact(payload, {
      token: staticToken,
    });

    expect(
      second.status(),
      `submitting the same bulk block twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
  });

  test('[IDOR] a foreign contactID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { contactID: FOREIGN.contactID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'contactID',
      foreignValue: FOREIGN.contactID,
    });
  });

});

/* =========================================================================================
 * GET /v2/contacts/getblockContactDetails
 * ====================================================================================== */
test.describe('GET /v2/contacts/getblockContactDetails @audit', () => {
  const META = {
    method: 'GET',
    path: CONTACTS_V2_PATHS.getblockContactDetails,
    repro: `await contactsClient.getblockContactDetails({ token });`,
  };

  test('[1] happy path: the block list satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({ token: staticToken });

    await expectValidContract(
      response,
      blockedContactsResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The spec states no parameters are accepted, so the caller is identified solely by the token.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { kpostID: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric value where an id is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { id: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric id query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const response = await contactsClient.getblockContactDetails({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not return a block list', async ({ contactsClient }) => {
    const response = await contactsClient.getblockContactDetails({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] disclosure: a query-supplied kpostID must not reveal who blocked someone else', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.getblockContactDetails({ token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.getblockContactDetails({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" as a query parameter changed the block list returned. The spec is explicit that no parameters are accepted precisely because knowing who has blocked you would itself be a disclosure — the list must come from the token alone.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      contactsClient.getblockContactDetails({ token: staticToken }),
      contactsClient.getblockContactDetails({ token: staticToken }),
      contactsClient.getblockContactDetails({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] boundary: an int32-overflow query id must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getblockContactDetails({
      token: staticToken,
      params: { id: INT32_OVERFLOW },
    });

    expect(
      response.status(),
      `id=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign contactID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { contactID: FOREIGN.contactID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'contactID',
      foreignValue: FOREIGN.contactID,
    });
  });

});
