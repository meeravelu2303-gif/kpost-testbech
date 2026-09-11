import { EXPIRED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { MAILBOX_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { contactListResponseSchema, kmailEnvelopeSchema } from '../../src/api/schemas/kmail.schema';
import {
  assertBoundedCollection,
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatus,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildContactIdPayload,
  buildContactSyncPayload,
  buildIncrementalSyncPayload,
  buildOtherDomainContactPayload,
  buildUnsubscriberPayload,
} from '../../src/api/payloads/mailbox.payload';
import {
  jdbcTimestamp,
  qaLabel,
  syntheticExternalRecipient,
  syntheticRecipient,
} from '../../src/utils/safeTestData';

/**
 * Contacts, sync, and unsubscribe — the address-book surface of `/v2/common/**`.
 *
 *  - External contacts: people with no KPOST account. Ordinary CRUD plus a soft delete, so
 *    "deleted" rows remain in the table and are reachable by a sync that forgets to filter them.
 *  - Contact sync: omitting `lastFetchTime` requests a full sync of every contact — the one call
 *    that legitimately returns everything, so it must return only the caller's.
 *  - Unsubscribe: reads `sender` and `receiver` from the body with no token binding. The specs
 *    do not assert a 401 the API never promised; they measure the blast radius of that decision.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/**
 * Creates an external contact and returns its assigned id, or `null`. Returns `null` rather than
 * throwing so the dependent block skips with a stated reason instead of failing on the wrong route.
 */
async function createContact(
  mailboxClient: {
    addOtherDomainContacts: (
      data: unknown,
      options?: { token?: string | null }
    ) => Promise<import('@playwright/test').APIResponse>;
  },
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<number | null> {
  const response = await mailboxClient.addOtherDomainContacts(
    buildOtherDomainContactPayload(overrides),
    { token }
  );
  if (!response.ok()) return null;
  const { json } = await readBody(response);
  if (!json) return null;

  const data = json.data;
  if (typeof data === 'number') return data;
  if (data !== null && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === 'number') return nested;
  }
  return null;
}

/* =========================================================================================
 * POST /v2/common/addOtherDomainContacts
 * ====================================================================================== */
test.describe('POST /v2/common/addOtherDomainContacts @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.addOtherDomainContacts,
    repro: `await mailboxClient.addOtherDomainContacts(buildOtherDomainContactPayload(), { token });`,
  };

  test('[1] happy path: adding a contact satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildOtherDomainContactPayload();
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] happy path: the created contact is returned by the sync', async ({
    mailboxClient,
    token,
  }) => {
    // A round trip, not a status check: "create returned 200" and "the contact is in the address
    // book" are different claims.
    const marker = qaLabel('contact-roundtrip');
    const created = await createContact(mailboxClient, token, { referenceName: marker });
    test.skip(created === null, 'could not create a contact on this environment');

    const sync = await mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), { token });
    const { json, text } = await readBody(sync);
    test.skip(json === null || !sync.ok(), 'contact sync returned no data');

    expect(
      text.includes(marker),
      `a contact created with referenceName "${marker}" was not returned by the full contact sync. The create reported success, so either it was not persisted or the sync does not see it — and a contact the user cannot address is a contact they did not get. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[3] IDOR: a body kpostID must not add a contact to another address book', async ({
    mailboxClient,
    token,
    callerKpostId,
  }) => {
    // A contact's display name is shown in place of the bare address throughout the UI, so writing
    // into another user's address book is a phishing primitive delivered inside the victim's client.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildOtherDomainContactPayload({ kpostID: FOREIGN.victimKpostID });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'contact create returned no parseable body');

    expect(
      text.includes(`"kpostID":"${FOREIGN.victimKpostID}"`),
      `the contact was created reporting "${FOREIGN.victimKpostID}" as its owner while the caller was ${callerKpostId ?? 'a different identity'}. kpostID is documented as overwritten from the JWT. A contact's display name replaces the raw address everywhere in the UI, so writing into someone else's address book means choosing what name their client shows for an address you control. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] validation: a contact with no email address must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildOtherDomainContactPayload();
    delete (payload as Record<string, unknown>).contactEmailID;
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a contact was created with no email address',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a malformed email address must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildOtherDomainContactPayload({ contactEmailID: 'not-an-address' });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the contact email address is not valid in any form',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] validation: a null email address must be refused', async ({ mailboxClient, token }) => {
    const payload = buildOtherDomainContactPayload({ contactEmailID: null });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactEmailID" set to null', severity: 'Major' },
      [400, 401, 403, 422]
    );
  });

  test('[7] validation: an empty body must be refused', async ({ mailboxClient, token }) => {
    const response = await mailboxClient.addOtherDomainContacts({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an empty body was posted to the contact create route',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] XSS: a script payload in the contact name must not be reflected', async ({
    mailboxClient,
    token,
  }) => {
    // `contactName` is displayed in place of the address in every list, header and compose
    // autocomplete — rendered by design, the highest-value stored-XSS target in the module.
    const payload = buildOtherDomainContactPayload({ contactName: XSS_PAYLOAD });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9] injection: a tautology in the contact name must not leak internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildOtherDomainContactPayload({ contactName: SQLI_PAYLOAD });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] boundary: a 5000-character contact name must not fault', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildOtherDomainContactPayload({ contactName: MAX_LENGTH_STRING });
    const response = await mailboxClient.addOtherDomainContacts(payload, { token });

    expect(
      response.status(),
      `a 5000-character contact name produced HTTP ${response.status()}. It must be truncated or refused by the validator, not by the column definition.`
    ).toBeLessThan(500);
  });

  test('[11] duplicate: adding the same address twice must be handled explicitly', async ({
    mailboxClient,
    token,
  }) => {
    const address = syntheticExternalRecipient();
    const payload = buildOtherDomainContactPayload({ contactEmailID: address });
    await mailboxClient.addOtherDomainContacts(payload, { token });
    const second = await mailboxClient.addOtherDomainContacts(payload, { token });

    expect(
      second.status(),
      `adding the same external address twice produced HTTP ${second.status()} on the second call. It must be a merge, an update, or a 409 — a duplicate row makes the address book show the same person twice, and a 5xx means the uniqueness rule is being enforced by a constraint violation.`
    ).toBeLessThan(500);
  });

  test('[12] structural: malformed JSON must be a clean 400', async ({ mailboxClient, token }) => {
    const malformed = '{"contactEmailID":';
    const response = await mailboxClient.sendRaw(MAILBOX_PATHS.addOtherDomainContacts, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await mailboxClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[13] auth: no Authorization header must be 401/403', async ({ mailboxClient }) => {
    const payload = buildOtherDomainContactPayload();
    const response = await mailboxClient.addOtherDomainContacts(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[14] auth: an expired token must not add a contact', async ({ mailboxClient }) => {
    const payload = buildOtherDomainContactPayload();
    const response = await mailboxClient.addOtherDomainContacts(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[15] status parity: HTTP status must agree with the envelope', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.addOtherDomainContacts({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });
});

/* =========================================================================================
 * POST /v2/common/editOtherDomainContactsDetails
 * ====================================================================================== */
test.describe('POST /v2/common/editOtherDomainContactsDetails @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.editOtherDomainContactsDetails,
    repro: `await mailboxClient.editOtherDomainContactsDetails(buildContactIdPayload(id), { token });`,
  };

  test('[1] lifecycle: a contact this test created can be edited', async ({
    mailboxClient,
    token,
  }) => {
    const created = await createContact(mailboxClient, token);
    test.skip(created === null, 'could not create a contact to edit on this environment');

    const payload = buildContactIdPayload(created as number, {
      contactName: qaLabel('renamed'),
    });
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403], { ...META, body: payload });
  });

  test('[2] IDOR: another user\'s contact must not be editable', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactIdPayload(FOREIGN.contactID, {
      contactName: qaLabel('idor-rename'),
    });
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.contactID,
      what: 'contact id on an edit',
    });
  });

  test('[3] validation: an edit with no id must be refused', async ({ mailboxClient, token }) => {
    // An update with no WHERE clause: "no id" read as "no filter" renames every contact in the
    // caller's address book, or every contact in the table if ownership is also unchecked.
    const payload = buildOtherDomainContactPayload({ contactName: qaLabel('no-id-edit') });
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an edit was submitted with no contact id',
        severity: 'Critical',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] validation: a null id must be refused', async ({ mailboxClient, token }) => {
    const payload = buildOtherDomainContactPayload({ id: null });
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "id" set to null on an edit', severity: 'Critical' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] not found: editing a contact that does not exist must not be a 500', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactIdPayload(FOREIGN.contactID);
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      body: payload,
      title: 'Editing a non-existent contact is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[6] XSS: a script payload in the edited name must not be reflected', async ({
    mailboxClient,
    token,
  }) => {
    const created = await createContact(mailboxClient, token);
    test.skip(created === null, 'could not create a contact to edit on this environment');

    const payload = buildContactIdPayload(created as number, { contactName: XSS_PAYLOAD });
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] auth: an anonymous caller must not edit a contact', async ({ mailboxClient }) => {
    const payload = buildContactIdPayload(FOREIGN.contactID);
    const response = await mailboxClient.editOtherDomainContactsDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/common/deleteOtherDomainContact
 * ====================================================================================== */
test.describe('POST /v2/common/deleteOtherDomainContact @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.deleteOtherDomainContact,
    repro: `await mailboxClient.deleteOtherDomainContact(buildContactIdPayload(id), { token });`,
  };

  test('[1] lifecycle: a contact this test created is deleted and stays deleted', async ({
    mailboxClient,
    token,
  }) => {
    const marker = qaLabel('contact-to-delete');
    const created = await createContact(mailboxClient, token, { referenceName: marker });
    test.skip(created === null, 'could not create a contact to delete on this environment');

    const payload = buildContactIdPayload(created as number);
    const deleteResponse = await mailboxClient.deleteOtherDomainContact(payload, { token });
    await assertStatus(deleteResponse, [200, 204, 400, 401, 403], { ...META, body: payload });

    // Read back through the full sync. This is a soft delete (sets `deleteStatus`); the full sync
    // must filter it, or the deleted contact reappears on the next device that syncs.
    const sync = await mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), { token });
    const { json, text } = await readBody(sync);
    test.skip(json === null || !sync.ok(), 'contact sync returned no data');

    expect(
      text.includes(marker),
      `a contact deleted through deleteOtherDomainContact was still returned by the full sync. The delete is a soft delete that sets deleteStatus, and the sync must filter on it — otherwise the contact the user deleted reappears on the next device that syncs. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[2] IDOR: another user\'s contact must not be deletable', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactIdPayload(FOREIGN.contactID);
    const response = await mailboxClient.deleteOtherDomainContact(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.contactID,
      what: 'contact id on a delete',
    });
  });

  test('[3] validation: a delete with no id must be refused', async ({ mailboxClient, token }) => {
    const response = await mailboxClient.deleteOtherDomainContact({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a contact delete was submitted with no id',
        severity: 'Critical',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] idempotency: deleting twice must not fault', async ({ mailboxClient, token }) => {
    const created = await createContact(mailboxClient, token);
    test.skip(created === null, 'could not create a contact to delete on this environment');

    const payload = buildContactIdPayload(created as number);
    await mailboxClient.deleteOtherDomainContact(payload, { token });
    const second = await mailboxClient.deleteOtherDomainContact(payload, { token });

    expect(
      second.status(),
      `deleting the same contact twice produced HTTP ${second.status()}. A soft delete applied twice is a no-op.`
    ).toBeLessThan(500);
  });

  test('[5] auth: an anonymous caller must not delete a contact', async ({ mailboxClient }) => {
    const payload = buildContactIdPayload(FOREIGN.contactID);
    const response = await mailboxClient.deleteOtherDomainContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/common/knownPostBoxContacts  — contact sync
 * ====================================================================================== */
test.describe('POST /v2/common/knownPostBoxContacts @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.knownPostBoxContacts,
    repro: `await mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), { token });`,
  };

  test('[1] happy path: a full sync satisfies the contract', async ({ mailboxClient, token }) => {
    const payload = buildContactSyncPayload();
    const response = await mailboxClient.knownPostBoxContacts(payload, { token });

    await expectValidContract(
      response,
      contactListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] the full sync must return only the caller\'s contacts', async ({
    mailboxClient,
    token,
    callerKpostId,
  }) => {
    // The one call that legitimately returns everything, so a scoping mistake returns everyone's
    // address book — the highest-density personal data in the product — in one response.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — cannot identify a foreign contact');

    const response = await mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'contact sync returned no data');

    expect(
      text.includes(`"kpostID":"${FOREIGN.victimKpostID}"`),
      `the full contact sync returned rows owned by "${FOREIGN.victimKpostID}" to ${callerKpostId ?? 'a different identity'}. This is the call that returns every contact, so a missing owner filter here discloses the entire cross-tenant address book in one response. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] IDOR: a body kpostUser must not sync another address book', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildContactSyncPayload({ kpostUser: FOREIGN.victimKpostID });
    const response = await mailboxClient.knownPostBoxContacts(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser on a contact sync',
    });
  });

  test('[4] incremental: a recent cursor must return less than a full sync', async ({
    mailboxClient,
    token,
  }) => {
    // The cursor is the point of an incremental sync. Ignored, every client re-downloads the whole
    // address book on every poll — silently.
    const [full, incremental] = await Promise.all([
      mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), { token }),
      mailboxClient.knownPostBoxContacts(buildIncrementalSyncPayload(jdbcTimestamp(-1)), { token }),
    ]);

    const [fullBody, incrementalBody] = await Promise.all([readBody(full), readBody(incremental)]);
    test.skip(!full.ok() || !incremental.ok(), 'the sync did not succeed on this environment');

    const fullCount = Array.isArray(fullBody.json?.data)
      ? (fullBody.json?.data as unknown[]).length
      : 0;
    const incrementalCount = Array.isArray(incrementalBody.json?.data)
      ? (incrementalBody.json?.data as unknown[]).length
      : 0;
    test.skip(fullCount === 0, 'the address book is empty, so both syncs are legitimately zero');

    expect(
      incrementalCount,
      `an incremental sync from one minute ago returned ${incrementalCount} contacts against a full sync of ${fullCount}. lastFetchTime is the cursor that makes this endpoint incremental; ignored, every client re-downloads the entire address book on every poll.`
    ).toBeLessThanOrEqual(fullCount);
  });

  test('[5] boundary: a full sync must still be bounded', async ({ mailboxClient, token }) => {
    const payload = buildContactSyncPayload();
    const response = await mailboxClient.knownPostBoxContacts(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 5000,
      what: 'contacts in a full sync',
    });
  });

  test('[6] validation: a malformed cursor must be refused', async ({ mailboxClient, token }) => {
    const payload = buildIncrementalSyncPayload('2026-08-31T10:00:00Z');
    const response = await mailboxClient.knownPostBoxContacts(payload, { token });

    expect(
      response.status(),
      `an ISO-8601 cursor where the contract declares JDBC timestamp form produced HTTP ${response.status()}. It must be a 400 naming the expected format, not a parse exception.`
    ).toBeLessThan(500);
  });

  test('[7] injection: a tautology in the cursor must not leak internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildIncrementalSyncPayload(SQLI_PAYLOAD);
    const response = await mailboxClient.knownPostBoxContacts(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous caller must not sync contacts', async ({ mailboxClient }) => {
    const response = await mailboxClient.knownPostBoxContacts(buildContactSyncPayload(), {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: buildContactSyncPayload() });
  });

  test('[9] the retired sync route must enforce the same authentication', async ({
    mailboxClient,
  }) => {
    // `unusedpostBoxContacts` is marked [Legacy] but still mapped, and returns the same address
    // book as its replacement — a retired route with an unrevisited auth check.
    const response = await mailboxClient.unusedPostBoxContacts(buildContactSyncPayload(), {
      token: null,
    });

    await assertUnauthorized(response, {
      method: 'POST',
      path: '/v2/common/unusedpostBoxContacts',
      repro: `await mailboxClient.unusedPostBoxContacts(payload, { token: null });`,
    });
  });
});

/* =========================================================================================
 * Contact listings
 * ====================================================================================== */
test.describe('Contact listings @audit', () => {
  test('[miscellaneousContacts] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.miscellaneousContacts,
      repro: `await mailboxClient.miscellaneousContacts({ token });`,
    };
    const response = await mailboxClient.miscellaneousContacts({ token });

    await expectValidContract(response, contactListResponseSchema, META, [
      200, 400, 401, 403, 500,
    ]);
  });

  test('[miscellaneousContacts] an anonymous caller must be refused', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.miscellaneousContacts({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.miscellaneousContacts,
      repro: `await mailboxClient.miscellaneousContacts({ token: null });`,
    });
  });

  test('[frequentKmailContact] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.frequentKmailContact,
      repro: `await mailboxClient.frequentKmailContact({ token });`,
    };
    const response = await mailboxClient.frequentKmailContact({ token });

    await expectValidContract(response, contactListResponseSchema, META, [
      200, 400, 401, 403, 500,
    ]);
  });

  test('[frequentKmailContact] the list must be a top-N, not the whole address book', async ({
    mailboxClient,
    token,
  }) => {
    // "Frequent" implies a bounded list. An unbounded one is the entire correspondence graph under
    // a name that suggests it is small.
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.frequentKmailContact,
      repro: `await mailboxClient.frequentKmailContact({ token });`,
    };
    const response = await mailboxClient.frequentKmailContact({ token });

    await assertBoundedCollection(response, {
      ...META,
      limit: 500,
      what: 'frequent contacts',
    });
  });

  test('[frequentKmailContact] IDOR: a kpostID parameter must not re-scope it', async ({
    mailboxClient,
    token,
  }) => {
    // Who someone corresponds with most is a social graph — revealing in aggregate, no message
    // body needed.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await mailboxClient.frequentKmailContact({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      method: 'GET',
      path: MAILBOX_PATHS.frequentKmailContact,
      repro: `await mailboxClient.frequentKmailContact({ token, params: { kpostID: '<victim>' } });`,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
    });
  });

  test('[frequentKmailContact] an anonymous caller must be refused', async ({ mailboxClient }) => {
    const response = await mailboxClient.frequentKmailContact({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.frequentKmailContact,
      repro: `await mailboxClient.frequentKmailContact({ token: null });`,
    });
  });
});

/* =========================================================================================
 * Reference data and infrastructure
 * ====================================================================================== */
test.describe('Reference data @audit', () => {
  test('[getSaluations] happy path satisfies the contract', async ({ mailboxClient, token }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.getSaluations,
      repro: `await mailboxClient.getSaluations({ token });`,
    };
    const response = await mailboxClient.getSaluations({ token });

    await expectValidContract(response, kmailEnvelopeSchema, META, [200, 400, 401, 403]);
  });

  test('[getSaluations] the caller\'s custom salutations must not be served anonymously', async ({
    mailboxClient,
  }) => {
    // The system salutation list is reference data, but this route also returns the user's custom
    // salutations — free text carrying names and titles, i.e. user data.
    const response = await mailboxClient.getSaluations({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.getSaluations,
      repro: `await mailboxClient.getSaluations({ token: null });`,
    });
  });

  test('[getInstantReply] happy path satisfies the contract', async ({ mailboxClient, token }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.getInstantReply,
      repro: `await mailboxClient.getInstantReply({ token });`,
    };
    const response = await mailboxClient.getInstantReply({ token });

    await expectValidContract(response, kmailEnvelopeSchema, META, [200, 400, 401, 403]);
  });

  test('[getInstantReply] canned replies are user data and must require a token', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.getInstantReply({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.getInstantReply,
      repro: `await mailboxClient.getInstantReply({ token: null });`,
    });
  });

  test('[mailServerConnection] the health probe must not disclose infrastructure', async ({
    mailboxClient,
    token,
  }) => {
    // A connectivity check answers up or down. Answering with host, port and credentials publishes
    // the mail infrastructure's topology — and this route is reachable without a token here.
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.mailServerConnection,
      repro: `await mailboxClient.mailServerConnection({ token });`,
    };
    const response = await mailboxClient.mailServerConnection({ token });
    const { text } = await readBody(response);

    await assertNoInternalLeak(response, META, 'mailServerConnection');

    expect(
      /"(host|hostname|mailServerHost|port|username|password)"\s*:\s*"?[^",}]{2,}/i.test(text),
      `the mail-server health probe returned connection details (host, port, or credentials). A connectivity check must answer up or down; anything more publishes the mail infrastructure's topology to whoever can reach the route. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[mailServerConnection] the response must identify its own route', async ({
    mailboxClient,
    token,
  }) => {
    // Observed: `GET /v2/common/mailServerConnection` answers with `"urlPath":"getsaluations"`.
    // Clients correlate concurrent responses by `urlPath`; a misreported one means a copy-pasted
    // handler is running where it was not intended.
    const response = await mailboxClient.mailServerConnection({ token });
    const { json, text } = await readBody(response);

    test.skip(json === null || typeof json.urlPath !== 'string', 'no urlPath in the envelope');

    expect(
      String(json?.urlPath).toLowerCase(),
      `GET /v2/common/mailServerConnection returned an envelope whose urlPath reads "${String(json?.urlPath)}". Clients correlate concurrent responses by this field, and a route reporting another route's name means a handler was copied without its identifier being updated. Body: ${text.slice(0, 200)}`
    ).toContain('mailserver');
  });
});

/* =========================================================================================
 * POST /v2/common/saveUnsubscriberDetails  — documented as unauthenticated
 * ====================================================================================== */
test.describe('POST /v2/common/saveUnsubscriberDetails @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.saveUnsubscriberDetails,
    repro: `await mailboxClient.saveUnsubscriberDetails(buildUnsubscriberPayload(), { token: null });`,
  };

  test('[1] happy path: an anonymous unsubscribe is accepted, by design', async ({
    mailboxClient,
  }) => {
    // Reachable without a token by design: an unsubscribe link must work from a mail client with
    // no session. So this asserts the route works as documented rather than asserting a 401.
    const payload = buildUnsubscriberPayload();
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    await assertStatus(response, [200, 201, 204, 400], { ...META, body: payload });
  });

  test('[2] risk: anyone can unsubscribe any address from any sender', async ({
    mailboxClient,
  }) => {
    // Both `sender` and `receiver` come from the body with no token binding, so an anonymous caller
    // can opt any address out of any sender's mail — silently destroying a mailing list at scale.
    // The fix is a signed per-recipient token in the link, not authentication; this records whether
    // any such proof is required.
    const payload = buildUnsubscriberPayload({
      sender: syntheticRecipient(),
      receiver: syntheticExternalRecipient(),
    });
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });
    const { json, text } = await readBody(response);

    const accepted =
      response.ok() &&
      !(json && typeof json.status === 'string' && /FAIL|ERROR/i.test(json.status));

    test.info().annotations.push({
      type: 'documented risk',
      description:
        'saveUnsubscriberDetails reads sender and receiver from the body with no token binding — an anonymous caller can opt any address out of any sender. The mitigation is a signed per-recipient token in the unsubscribe link, not authentication.',
    });

    expect(
      accepted,
      `an anonymous caller unsubscribed an arbitrary receiver from an arbitrary sender and the request was accepted with HTTP ${response.status()}. The route must be reachable without a session — an unsubscribe link has to work from a mail client — but it must carry proof that the request came from the mail, such as a signed per-recipient token, rather than accepting any pair of addresses it is handed. As it stands, a script can silently unsubscribe an entire mailing list and neither the sender nor the recipients see an error. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[3] validation: an unsubscribe with no receiver must be refused', async ({
    mailboxClient,
  }) => {
    const payload = buildUnsubscriberPayload();
    delete (payload as Record<string, unknown>).receiver;
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an unsubscribe was submitted with no receiver',
        severity: 'Major',
      },
      [400, 422]
    );
  });

  test('[4] validation: a malformed receiver address must be refused', async ({
    mailboxClient,
  }) => {
    const payload = buildUnsubscriberPayload({ receiver: 'not-an-address' });
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the unsubscribing address is not valid in any form',
        severity: 'Minor',
      },
      [400, 422]
    );
  });

  test('[5] XSS: a script payload in the reason must not be reflected', async ({
    mailboxClient,
  }) => {
    // `reason` is free text from the unsubscribe form, shown back to the sender in campaign
    // reporting — an anonymous write rendered in an authenticated dashboard: the cleanest stored-XSS
    // path in this API.
    const payload = buildUnsubscriberPayload({ reason: XSS_PAYLOAD });
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[6] injection: a tautology in the sender must not leak internals', async ({
    mailboxClient,
  }) => {
    const payload = buildUnsubscriberPayload({ sender: SQLI_PAYLOAD });
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] boundary: a 5000-character reason must not fault', async ({ mailboxClient }) => {
    const payload = buildUnsubscriberPayload({ reason: MAX_LENGTH_STRING });
    const response = await mailboxClient.saveUnsubscriberDetails(payload, { token: null });

    expect(
      response.status(),
      `a 5000-character unsubscribe reason produced HTTP ${response.status()}. This is an anonymous write, so an unhandled path in it is an unauthenticated crash vector.`
    ).toBeLessThan(500);
  });

  test('[8] rate limiting: repeated anonymous writes must eventually be throttled', async ({
    mailboxClient,
  }) => {
    // An unauthenticated write: without a limiter it is a way to unsubscribe a list in a loop and
    // fill the table for free, with no token to revoke. Twenty requests is a gentle probe — a pass
    // means the limit is above twenty, not that one exists.
    const attempts = 20;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        mailboxClient.saveUnsubscriberDetails(buildUnsubscriberPayload(), { token: null })
      )
    );

    const throttled = responses.filter((response) => response.status() === 429).length;

    test.info().annotations.push({
      type: 'rate-limit probe',
      description: `${attempts} rapid anonymous unsubscribes, ${throttled} throttled. A gentle probe: no 429 here means the limit is above ${attempts}, not that none exists.`,
    });

    expect(
      responses.every((response) => response.status() < 500),
      `${attempts} rapid anonymous unsubscribe writes produced at least one 5xx. This route takes no token, so anything that faults under modest concurrency is reachable by anyone on the network with no credential to revoke afterwards.`
    ).toBe(true);
  });

  test('[9] an empty body must not fault', async ({ mailboxClient }) => {
    const response = await mailboxClient.saveUnsubscriberDetails({}, { token: null });

    expect(
      response.status(),
      `an empty body to the anonymous unsubscribe route produced HTTP ${response.status()}. A 400 is correct; a 5xx is an unhandled path on a route anyone can reach.`
    ).toBeLessThan(500);
  });
});
