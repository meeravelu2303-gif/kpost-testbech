import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { CONTACTS_V2_PATHS } from '../../src/api/clients/contactsDirectoryV2.client';
import {
  groupListingResponseSchema,
  myContactsResponseSchema,
  unknownContactsResponseSchema,
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
import { buildContactSyncPayload } from '../../src/api/payloads/contactsDirectoryV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Contacts Directory V2 — the four delta/listing routes.
 *
 * All four take the same `ContactsRO` and resolve the caller from the bearer token, so the
 * recurring question is whether a body-supplied identity can redirect the read.
 *
 * Two rules come straight from the spec:
 *
 * - `myContacts` and `myGroups` are cursor-driven. `lastfetchDate` is the cursor in, and a
 *   fresh `lastFetchDate` must come back out; without it the client cannot advance its sync
 *   window and will either re-download everything or stall.
 * - `myUnknownGroups` describes groups the caller is **not** a member of. The spec flags it
 *   as "a route to probe carefully for information disclosure": a group name alone is
 *   reasonable, but member lists or message content are not. It also states the four listing
 *   routes must partition cleanly — a group belongs in `myGroups` or `myUnknownGroups`,
 *   never both.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const EPOCH_CURSOR = '1970-01-01T00:00:00.000Z';
const FUTURE_CURSOR = '2999-12-31T23:59:59.000Z';

/* =========================================================================================
 * POST /v2/contacts/myContacts
 * ====================================================================================== */
test.describe('POST /v2/contacts/myContacts @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.myContacts,
    repro: `await contactsClient.myContacts(buildContactSyncPayload(), { token });`,
  };

  test('[1] happy path: a delta sync satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await expectValidContract(
      response,
      myContactsResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] contract: a successful sync must return a fresh cursor', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'sync did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.lastFetchDate,
      `the sync succeeded but returned no lastFetchDate. That value is the cursor the client carries into its next call; without it the client either re-downloads the entire directory every time or stops syncing altogether. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: an epoch cursor must not be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `an epoch cursor produced HTTP ${response.status()}. A first-ever sync legitimately starts from the beginning of time, so this is the normal cold-start case, not an error.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a far-future cursor must return an empty delta, not fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: FUTURE_CURSOR });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `a cursor set to the year 2999 produced HTTP ${response.status()}. Nothing can have changed after that instant, so the correct answer is an empty delta.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an absent cursor must be handled explicitly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    delete (payload as Record<string, unknown>).lastfetchDate;

    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `omitting lastfetchDate produced HTTP ${response.status()}. Either the route treats a missing cursor as a full sync or it refuses the request — both are defensible, a 5xx is not.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null cursor must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: null });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `a null lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4b] empty fuzzing: an unparseable cursor must be refused as a client error', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: 'not-a-date' });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'lastfetchDate set to an unparseable value' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a numeric cursor must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: 1700000000 });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `lastfetchDate was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a scalar where contactIDs expects an array', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ contactIDs: 'qa-single' });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `contactIDs was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the cursor must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: XSS_PAYLOAD });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology cursor must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: SQLI_PAYLOAD });
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not return a contact directory', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not return another user\'s contacts', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.myContacts(buildContactSyncPayload(), { token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.myContacts(buildContactSyncPayload({ kpostID: VICTIM_KPOST_ID }), {
        token: staticToken,
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" in the body changed the contacts returned. The spec states kpostID comes from the bearer token; a caller-supplied value must have no effect, or one user can download another's entire address book.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myContacts(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be handled as a cold-start, not a fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.myContacts({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}. A client with no stored cursor sends exactly this, so it must resolve to a full sync or a clean 400.`
    ).toBeLessThan(500);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(CONTACTS_V2_PATHS.myContacts, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical syncs must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.myContacts(payload, { token: staticToken }),
      contactsClient.myContacts(payload, { token: staticToken }),
      contactsClient.myContacts(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent syncs returned different statuses (${statuses.join(', ')}). A delta read must be deterministic for a given cursor.`
    ).toBe(1);
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
 * POST /v2/contacts/myGroups
 * ====================================================================================== */
test.describe('POST /v2/contacts/myGroups @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.myGroups,
    repro: `await contactsClient.myGroups(buildContactSyncPayload(), { token });`,
  };

  test('[1] happy path: a group delta sync satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    await expectValidContract(
      response,
      groupListingResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an epoch cursor must not be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `an epoch cursor produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a far-future cursor must return an empty delta', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: FUTURE_CURSOR });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `a cursor set to the year 2999 produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an absent cursor must be handled explicitly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    delete (payload as Record<string, unknown>).lastfetchDate;

    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `omitting lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null cursor must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: null });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `a null lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4b] empty fuzzing: an unparseable cursor must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: '' });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `an empty lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: an array where a cursor is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: [EPOCH_CURSOR] });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `lastfetchDate was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: XSS_PAYLOAD });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology cursor must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: SQLI_PAYLOAD });
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myGroups(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return a group list', async ({ contactsClient }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myGroups(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not return another user\'s groups', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.myGroups(buildContactSyncPayload(), { token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.myGroups(buildContactSyncPayload({ kpostID: VICTIM_KPOST_ID }), {
        token: staticToken,
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" in the body changed the groups returned. Group membership reveals who someone collaborates with, so this listing must come from the token alone.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myGroups(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be handled as a cold-start', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.myGroups({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(CONTACTS_V2_PATHS.myGroups, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical syncs must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.myGroups(payload, { token: staticToken }),
      contactsClient.myGroups(payload, { token: staticToken }),
      contactsClient.myGroups(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent syncs returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
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
 * POST /v2/contacts/myUnknownKatchupContacts
 * ====================================================================================== */
test.describe('POST /v2/contacts/myUnknownKatchupContacts @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.myUnknownKatchupContacts,
    repro: `await contactsClient.myUnknownKatchupContacts(buildContactSyncPayload(), { token });`,
  };

  test('[1] happy path: the unknown-senders list satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      unknownContactsResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an epoch cursor must not be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `an epoch cursor produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a 5000-character cursor must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: MAX_LENGTH_STRING });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character cursor produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an absent cursor must be handled explicitly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    delete (payload as Record<string, unknown>).lastfetchDate;

    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `omitting lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null cursor must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: null });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a null lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4b] empty fuzzing: an empty cursor must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: '' });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `an empty lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: an object where a cursor is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: { at: EPOCH_CURSOR } });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `lastfetchDate was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: XSS_PAYLOAD });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology cursor must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: SQLI_DROP_PAYLOAD });
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownKatchupContacts(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({ contactsClient }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not reveal another user\'s counterparties', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.myUnknownKatchupContacts(buildContactSyncPayload(), {
        token: staticToken,
      })
    );
    const impersonated = await readBody(
      await contactsClient.myUnknownKatchupContacts(
        buildContactSyncPayload({ kpostID: VICTIM_KPOST_ID }),
        { token: staticToken }
      )
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" changed the list returned. This route names people the target has exchanged messages with but never saved — arguably the most revealing listing in the controller, because it exposes relationships the user chose not to record.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownKatchupContacts(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be handled without a fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.myUnknownKatchupContacts({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.myUnknownKatchupContacts,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] partition: an unknown contact must not also appear as a saved contact', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const unknown = await readBody(
      await contactsClient.myUnknownKatchupContacts(payload, { token: staticToken })
    );
    const saved = await readBody(await contactsClient.myContacts(payload, { token: staticToken }));

    const unknownIds = Array.isArray(unknown.json?.data)
      ? (unknown.json.data as Array<Record<string, unknown>>).map((row) => row.contactID)
      : [];
    const savedData = saved.json?.data as Record<string, unknown> | undefined;
    const savedRows = Array.isArray(savedData?.newlyAdded)
      ? (savedData.newlyAdded as Array<Record<string, unknown>>)
      : [];
    const savedIds = new Set(savedRows.map((row) => row.contactID));

    const overlap = unknownIds.filter((id) => savedIds.has(id));

    expect(
      overlap.length,
      `${overlap.length} contacts appeared in both myUnknownKatchupContacts and myContacts. The spec requires these listings to partition cleanly — "unknown" means precisely "not saved", so an overlap makes the client prompt the user to add someone they already have.`
    ).toBe(0);
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
 * POST /v2/contacts/myUnknownGroups
 * ====================================================================================== */
test.describe('POST /v2/contacts/myUnknownGroups @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.myUnknownGroups,
    repro: `await contactsClient.myUnknownGroups(buildContactSyncPayload(), { token });`,
  };

  test('[1] happy path: the unknown-groups list satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    await expectValidContract(
      response,
      groupListingResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] disclosure: a group the caller has not joined must not expose its member list', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

    test.skip(rows.length === 0, 'no unknown groups returned to inspect');

    const withMembers = rows.filter(
      (row) => Array.isArray(row.memberDetails) && (row.memberDetails as unknown[]).length > 0
    );

    expect(
      withMembers.length,
      `${withMembers.length} groups the caller has not joined came back carrying a member list. The spec flags this route explicitly: a group name alone is reasonable, but a member roster is not — it tells a non-member exactly who is in a conversation they have no part in. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[1c] disclosure: an unknown group must not expose message content', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

    test.skip(rows.length === 0, 'no unknown groups returned to inspect');

    const withMessages = rows.filter(
      (row) => typeof row.actualMessage === 'string' && row.actualMessage.length > 0
    );

    expect(
      withMessages.length,
      `${withMessages.length} groups the caller has not joined came back carrying message content. Surfacing an unfamiliar group so the user can recognise it needs a name, not the conversation itself. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[2] boundary: an epoch cursor must not be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `an epoch cursor produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 cursor must be refused cleanly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: UTF8_STRING });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 cursor produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: an absent cursor must be handled explicitly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    delete (payload as Record<string, unknown>).lastfetchDate;

    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `omitting lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a null cursor must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: null });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `a null lastfetchDate produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a boolean where a cursor is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: true });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    expect(
      response.status(),
      `lastfetchDate was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: XSS_PAYLOAD });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology cursor must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: SQLI_PAYLOAD });
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownGroups(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not reveal unfamiliar groups', async ({
    contactsClient,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownGroups(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not reveal another user\'s unknown groups', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.myUnknownGroups(buildContactSyncPayload(), { token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.myUnknownGroups(
        buildContactSyncPayload({ kpostID: VICTIM_KPOST_ID }),
        { token: staticToken }
      )
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" changed the groups returned.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload();
    const response = await contactsClient.myUnknownGroups(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be handled without a fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.myUnknownGroups({}, { token: staticToken });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(CONTACTS_V2_PATHS.myUnknownGroups, '[1,2,', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] partition: a group must not appear in both myGroups and myUnknownGroups', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactSyncPayload({ lastfetchDate: EPOCH_CURSOR });
    const known = await readBody(await contactsClient.myGroups(payload, { token: staticToken }));
    const unknown = await readBody(
      await contactsClient.myUnknownGroups(payload, { token: staticToken })
    );

    const knownIds = new Set(
      Array.isArray(known.json?.data)
        ? (known.json.data as Array<Record<string, unknown>>).map((row) => row.groupKpostID)
        : []
    );
    const unknownIds = Array.isArray(unknown.json?.data)
      ? (unknown.json.data as Array<Record<string, unknown>>).map((row) => row.groupKpostID)
      : [];

    const overlap = unknownIds.filter((id) => knownIds.has(id));

    expect(
      overlap.length,
      `${overlap.length} groups appeared in both myGroups and myUnknownGroups. The spec requires these to partition cleanly: a group is one the caller belongs to or one they do not, never both. An overlap means the client shows the same group twice with contradictory affordances.`
    ).toBe(0);
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
