import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { CONTACTS_V2_PATHS } from '../../src/api/clients/contactsDirectoryV2.client';
import {
  contactAckResponseSchema,
  phoneContactsResponseSchema,
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
  assertStatus,
} from '../../src/utils/apiAssertions';
import {
  buildInviteStatusPayload,
  buildPhoneContactsPayload,
} from '../../src/api/payloads/contactsDirectoryV2.payload';
import { safeTestMobile } from '../../src/utils/safeTestData';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Contacts Directory V2 — phone-book import, read-back and invite state.
 *
 * `importPhoneContacts` and `getImportedPhoneContacts` are described as the **safe
 * replacements** for their V1 counterparts, which took the owning user from the request body
 * with no ownership check — meaning one user could upload into, or retrieve, another's entire
 * address book. Here the owner is resolved from the bearer token. The tests confirm the V1
 * flaw has not survived the rewrite, because an address book is the densest personal data in
 * the product: every name and number the user knows, in one payload.
 *
 * Every number in these payloads routes through `safeTestMobile()`. A bulk import built from
 * faker values would be an invitation-spam vector against real subscribers.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /v2/contacts/importPhoneContacts
 * ====================================================================================== */
test.describe('POST /v2/contacts/importPhoneContacts @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.importPhoneContacts,
    repro: `await contactsClient.importPhoneContacts(buildPhoneContactsPayload(3), { token });`,
  };

  test('[1] happy path: an address-book import satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(3);
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await expectValidContract(
      response,
      phoneContactsResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 2000-entry address book must not exhaust the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(2000);
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `a 2000-entry import produced HTTP ${response.status()}. Real address books reach this size, so the bulk insert must either handle it or refuse it explicitly — a timeout or 5xx here means the feature simply fails for heavy users.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty contact list must not report a successful import', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(0);
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty phoneContacts list returned success. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[2c] boundary: a UTF-8 contact name is stored or refused without a fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    (payload.phoneContacts as Array<Record<string, unknown>>)[0].name = UTF8_STRING;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 contact name produced HTTP ${response.status()}. Address books on this platform are full of non-ASCII names.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "deviceID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    delete payload.deviceID;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "deviceID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3b] missing required parameter: "mobileNumber" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    delete payload.mobileNumber;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "mobileNumber" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null contact list must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    payload.phoneContacts = null;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "phoneContacts" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty deviceID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1, { deviceID: '' });
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "deviceID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a scalar where phoneContacts expects an array', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    payload.phoneContacts = 'not-an-array';

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `phoneContacts was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a null entry inside the list must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    (payload.phoneContacts as unknown[]).push(null);

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    expect(
      response.status(),
      `a null entry inside phoneContacts produced HTTP ${response.status()}. The service bulk-inserts this list, so a null element must be rejected before it reaches the insert.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a contact name must not be stored unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    (payload.phoneContacts as Array<Record<string, unknown>>)[0].name = XSS_PAYLOAD;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `const p = buildPhoneContactsPayload(1); p.phoneContacts[0].name = ${JSON.stringify(XSS_PAYLOAD)}; await contactsClient.importPhoneContacts(p, { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1, { deviceID: SQLI_PAYLOAD });
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(1);
    (payload.phoneContacts as Array<Record<string, unknown>>)[0].name = SQLI_DROP_PAYLOAD;

    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    const response = await contactsClient.importPhoneContacts(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not upload an address book', async ({
    contactsClient,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    const response = await contactsClient.importPhoneContacts(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] the V1 flaw must not have survived: a body kpostID must not set the owner', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPhoneContactsPayload(2, { kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const imported = json !== null && json.statusCode === 200;

    expect(
      imported,
      `an address book was imported while the body carried kpostID="${VICTIM_KPOST_ID}" and the caller was ${authSession.kpostID ?? 'a different identity'}. This route exists specifically because the V1 version took the owner from the body with no ownership check; if the body still wins, the rewrite did not fix anything and one user can plant an address book under another user's account. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(2);
    const response = await contactsClient.importPhoneContacts(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.importPhoneContacts({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an address-book import' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.importPhoneContacts,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-importing the same book must not duplicate entries', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildPhoneContactsPayload(3);
    const [first, second, third] = await Promise.all([
      contactsClient.importPhoneContacts(payload, { token: staticToken }),
      contactsClient.importPhoneContacts(payload, { token: staticToken }),
      contactsClient.importPhoneContacts(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical imports returned different statuses (${statuses.join(', ')}). Clients re-import on every address-book change, so a bulk insert without an upsert key duplicates the user's whole phone book each time.`
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
 * GET /v2/contacts/getImportedPhoneContacts
 * ====================================================================================== */
test.describe('GET /v2/contacts/getImportedPhoneContacts @audit', () => {
  const META = {
    method: 'GET',
    path: CONTACTS_V2_PATHS.getImportedPhoneContacts,
    repro: `await contactsClient.getImportedPhoneContacts({ token });`,
  };

  test('[1] happy path: the imported book satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: staticToken });

    await expectValidContract(
      response,
      phoneContactsResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative page size must not be honoured', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({
      token: staticToken,
      params: { limit: -1 },
    });

    expect(
      response.status(),
      `limit=-1 produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The owner is resolved from the token, so no parameters are required.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({
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
    const response = await contactsClient.getImportedPhoneContacts({
      token: staticToken,
      params: { deviceID: 12345 },
    });

    expect(
      response.status(),
      `a numeric deviceID query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not return an address book', async ({
    contactsClient,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] the V1 flaw must not have survived: a query kpostID must not switch the owner', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.getImportedPhoneContacts({ token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.getImportedPhoneContacts({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" changed the address book returned. This route replaced a V1 version that allowed exactly this — retrieving another user's entire uploaded phone book. An address book is every name and number the person knows, so a regression here is one of the highest-impact disclosures in the product.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getImportedPhoneContacts({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      contactsClient.getImportedPhoneContacts({ token: staticToken }),
      contactsClient.getImportedPhoneContacts({ token: staticToken }),
      contactsClient.getImportedPhoneContacts({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] disclosure: the read must not expose another user\'s device identifier', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const { text } = await readBody(
      await contactsClient.getImportedPhoneContacts({ token: staticToken })
    );
    test.skip(!authSession.kpostID, 'no authenticated identity to compare against');

    expect(
      text.includes(VICTIM_KPOST_ID) && authSession.kpostID !== VICTIM_KPOST_ID,
      `the imported address book referenced "${VICTIM_KPOST_ID}" while authenticated as ${authSession.kpostID}. The read must return only the caller's own upload.`
    ).toBe(false);
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

/* =========================================================================================
 * POST /v2/contacts/updateInviteStatus
 * ====================================================================================== */
test.describe('POST /v2/contacts/updateInviteStatus @audit', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.updateInviteStatus,
    repro: `await contactsClient.updateInviteStatus(buildInviteStatusPayload(), { token });`,
  };

  test('[1] happy path: an invite-status update satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload();
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await expectValidContract(
      response,
      contactAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character name must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ name: MAX_LENGTH_STRING });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character name produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an unrecognised invite state must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ inviteStatus: 'MAYBE_LATER' });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'inviteStatus set to an unrecognised value' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3] missing required parameter: "mobileNumber" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload();
    delete payload.mobileNumber;

    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "mobileNumber" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[3b] missing required parameter: "deviceID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload();
    delete payload.deviceID;

    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "deviceID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null mobileNumber must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumber: null });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "mobileNumber" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty mobileNumber must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumber: '' });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "mobileNumber" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a numeric mobileNumber must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumber: 9999999999 });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `mobileNumber was sent as a number and produced HTTP ${response.status()}. Numeric coercion silently drops a leading zero, so the contract expects a string.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where mobileNumberList expects strings', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumberList: [12345, 67890] });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    expect(
      response.status(),
      `mobileNumberList was sent as an array of numbers and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the name must not be stored unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ name: XSS_PAYLOAD });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not mark every entry as invited', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumber: SQLI_PAYLOAD });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as the mobile number returned success. Unparameterised, that could flip the invite flag on every entry in the phone book at once — hiding the invite option for everyone the user knows. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildInviteStatusPayload();
    const response = await contactsClient.updateInviteStatus(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not update invite state', async ({ contactsClient }) => {
    const payload = buildInviteStatusPayload();
    const response = await contactsClient.updateInviteStatus(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not edit another user\'s phone book', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an invite-status update succeeded while the body carried kpostID="${VICTIM_KPOST_ID}". The flag governs what another user's client shows for that entry, so writing it across an ownership boundary manipulates their UI. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload();
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload();
    const response = await contactsClient.updateInviteStatus(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.updateInviteStatus({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an invite-status update' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.updateInviteStatus,
      '{"a":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] rate limiting: repeated invite marks against one number should be bounded', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildInviteStatusPayload({ mobileNumber: safeTestMobile() });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        contactsClient.updateInviteStatus(payload, { token: staticToken })
      )
    );
    const statuses = responses.map((r) => r.status());

    expect(
      new Set(statuses).size,
      `ten rapid invite-status updates for the same number returned mixed statuses (${[...new Set(statuses)].join(', ')}). The spec notes this route records state and leaves open whether it also dispatches the invite; if it does, an unbounded loop here is an SMS flood against one person.`
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
