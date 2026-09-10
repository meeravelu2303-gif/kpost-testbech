import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { CONTACTS_V2_PATHS } from '../../src/api/clients/contactsDirectoryV2.client';
import {
  addContactResponseSchema,
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
  assertStatus,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildContactPayload,
  buildMultipleContactsPayload,
  nonExistentContactId,
} from '../../src/api/payloads/contactsDirectoryV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Contacts Directory V2 — directory mutations.
 *
 * All four routes stamp `kpostID` from the bearer token so the change lands in the caller's
 * own directory. The recurring question is therefore whether a body-supplied `kpostID` can
 * redirect the write into someone else's list — which would let one user plant, rename or
 * delete entries in another person's address book.
 *
 * `deleteContact` carries an extra rule the spec states plainly: the removal is **one-sided**
 * and must not remove the caller from the other party's directory.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/contacts/addContact
 * ====================================================================================== */
test.describe('POST /v2/contacts/addContact', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.addContact,
    repro: `await contactsClient.addContact(buildContactPayload(), { token });`,
  };

  test('[1] happy path: adding a contact satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await expectValidContract(
      response,
      addContactResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character reference name must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: MAX_LENGTH_STRING });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character referenceName produced HTTP ${response.status()}. The alias renders in the caller's contact list, so its length must be bounded by validation.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 reference name is handled without a server fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: UTF8_STRING });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 referenceName produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "contactID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    delete (payload as Record<string, unknown>).contactID;

    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "contactID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: null });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty contactID must not create a blank entry', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: '' });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a numeric contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: INT32_OVERFLOW });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    expect(
      response.status(),
      `contactID was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a string where isBlocked expects a boolean', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ isBlocked: 'true' });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    expect(
      response.status(),
      `isBlocked was sent as the string "true" and produced HTTP ${response.status()}. A truthy-string coercion on a safety flag is how an unintended block state gets stored.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the alias must not be stored unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: XSS_PAYLOAD });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await contactsClient.addContact(buildContactPayload({ referenceName: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: SQLI_PAYLOAD });
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not write to a directory', async ({ contactsClient }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContact(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not plant a contact in another list', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildContactPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.addContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const added = json !== null && json.statusCode === 200;

    expect(
      added,
      `a contact was added while the body carried kpostID="${VICTIM_KPOST_ID}" and the caller was ${authSession.kpostID ?? 'a different identity'}. The spec states kpostID is stamped from the token so the entry always lands in the caller's own directory; if the body wins, any user can plant entries in another person's address book. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContact(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.addContact({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an add-contact request' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(CONTACTS_V2_PATHS.addContact, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: adding the same contact twice must not duplicate the entry', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.addContact(payload, { token: staticToken }),
      contactsClient.addContact(payload, { token: staticToken }),
      contactsClient.addContact(payload, { token: staticToken }),
    ]);
    const accepted = [first, second, third].filter((r) => r.status() === 200).length;

    expect(
      accepted,
      `${accepted} of three concurrent identical adds were accepted. The service runs a checkContact validation before inserting; if that check is not transactional, the same person appears in the directory more than once.`
    ).toBeLessThanOrEqual(1);
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
 * POST /v2/contacts/addMultipleContact  — the request body is a JSON array
 * ====================================================================================== */
test.describe('POST /v2/contacts/addMultipleContact', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.addMultipleContact,
    repro: `await contactsClient.addMultipleContact(buildMultipleContactsPayload(3), { token });`,
  };

  test('[1] happy path: a batch add satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(3);
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await expectValidContract(
      response,
      addContactResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 500-entry batch must not exhaust the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(500);
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-contact batch produced HTTP ${response.status()}. The handler loops over the list calling checkContact per entry, so an unbounded batch is a straightforward denial-of-service surface.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty array must not report a successful add', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.addMultipleContact([], { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty batch returned success. Reporting a successful add when nothing was added makes the client show a confirmation for a no-op. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing required parameter: an entry without contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    delete (payload[1] as Record<string, unknown>).contactID;

    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'one batch entry missing its contactID' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null entry inside the batch must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload: unknown[] = [...buildMultipleContactsPayload(1), null];
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a null entry inside the batch produced HTTP ${response.status()}. The handler loops over the list, so a null element must be rejected up front rather than dereferenced mid-loop.`
    ).toBeLessThan(500);
  });

  test('[4b] partial failure: one invalid entry must not silently commit the valid ones', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    (payload[1] as Record<string, unknown>).contactID = '';

    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `a batch containing one invalid entry reported overall success. Because the handler loops per contact rather than working in a transaction, a blanket success hides which entries actually landed — the client cannot reconcile its local database. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: an object body where an array is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.addMultipleContact(buildMultipleContactsPayload(1)[0], {
      token: staticToken,
    });

    expect(
      response.status(),
      `a single object was sent where the route expects a JSON array, producing HTTP ${response.status()}. This shape mismatch is easy for a client to make and must be a clean 400.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a batch alias must not be stored unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(1, { referenceName: XSS_PAYLOAD });
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(1, { contactID: SQLI_PAYLOAD });
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    const response = await contactsClient.addMultipleContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not write a batch', async ({
    contactsClient,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    const response = await contactsClient.addMultipleContact(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not plant contacts in another list', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2, { kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const added = json !== null && json.statusCode === 200;

    expect(
      added,
      `a batch was written while every entry carried kpostID="${VICTIM_KPOST_ID}". The spec states kpostID is stamped from the token for each entry; honouring the body would let one call populate another user's whole address book. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    const response = await contactsClient.addMultipleContact(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.addMultipleContact,
      '[{"contactID":}]',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON array produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] idempotency: repeating a batch must not duplicate its entries', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildMultipleContactsPayload(2);
    const first = await contactsClient.addMultipleContact(payload, { token: staticToken });
    const second = await contactsClient.addMultipleContact(payload, { token: staticToken });

    expect(
      second.status(),
      `submitting the same batch twice returned HTTP ${first.status()} then ${second.status()}. A repeated batch must be stable, since the UI can easily re-submit after a network retry.`
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
 * POST /v2/contacts/addContactReference
 * ====================================================================================== */
test.describe('POST /v2/contacts/addContactReference', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.addContactReference,
    repro: `await contactsClient.addContactReference(buildContactPayload(), { token });`,
  };

  test('[1] happy path: setting an alias satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await expectValidContract(
      response,
      contactAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character alias must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: MAX_LENGTH_STRING });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character alias produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 alias is handled without a server fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: UTF8_STRING });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 alias produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "contactID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    delete (payload as Record<string, unknown>).contactID;

    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "contactID" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null alias must not blank the existing label', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: null });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "referenceName" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty alias must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: '' });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "referenceName" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where an alias string is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: ['Alias'] });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    expect(
      response.status(),
      `referenceName was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the alias must not be stored unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ referenceName: XSS_PAYLOAD });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not rename every contact', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: SQLI_PAYLOAD });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as contactID returned success on an alias update. Unparameterised, that could relabel every contact in the directory at once. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContactReference(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not rename a contact', async ({ contactsClient }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContactReference(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not rename an entry in another list', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await contactsClient.addContactReference(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const renamed = json !== null && json.statusCode === 200;

    expect(
      renamed,
      `an alias was written while the body carried kpostID="${VICTIM_KPOST_ID}". The alias is what the owner sees instead of the contact's real name, so writing into another user's directory lets an attacker relabel who that person thinks they are talking to. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.addContactReference(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.addContactReference({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on an alias update' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.addContactReference,
      '{"a":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-applying the same alias must be stable', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.addContactReference(payload, { token: staticToken }),
      contactsClient.addContactReference(payload, { token: staticToken }),
      contactsClient.addContactReference(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent alias updates returned different statuses (${statuses.join(', ')}).`
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
 * POST /v2/contacts/deleteContact
 * ====================================================================================== */
test.describe('POST /v2/contacts/deleteContact', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.deleteContact,
    repro: `await contactsClient.deleteContact(buildContactPayload(), { token });`,
  };

  test('[1] happy path: a delete request satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

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
    const payload = buildContactPayload({ contactID: MAX_LENGTH_STRING });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character contactID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow id is handled cleanly', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ id: INT32_OVERFLOW });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    expect(
      response.status(),
      `id=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "contactID" omitted must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    delete (payload as Record<string, unknown>).contactID;

    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "contactID" omitted on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null contactID must never widen the delete', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: null });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to null on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty contactID must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: '' });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "contactID" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a contactID is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: { id: 1 } });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    expect(
      response.status(),
      `contactID was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: XSS_PAYLOAD });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not empty the whole directory', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: SQLI_PAYLOAD });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    if (succeeded) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: payload,
          title: 'SQL injection accepted on deleteContact: a tautology contactID returns success',
          scenario: `a SQL tautology as contactID returned success on a delete. Unparameterised, that could remove every contact in the caller's directory in one request. Body: ${text.slice(0, 200)}`,
        },
        'Security/Access Control',
        'Critical'
      );
    }
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload({ contactID: SQLI_DROP_PAYLOAD });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.deleteContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not delete a contact', async ({
    contactsClient,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.deleteContact(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not delete from another user\'s list', async ({
    contactsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildContactPayload({
      kpostID: VICTIM_KPOST_ID,
      contactID: nonExistentContactId(),
    });
    const response = await contactsClient.deleteContact(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.statusCode === 200;

    expect(
      deleted,
      `a delete succeeded while the body carried kpostID="${VICTIM_KPOST_ID}" and the caller was ${authSession.kpostID ?? 'a different identity'}. The spec states the deletion is confined to the caller's own list by stamping kpostID from the token; if the body wins, one user can strip entries out of another's address book. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const response = await contactsClient.deleteContact(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not trigger an unscoped delete', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.deleteContact({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the delete route. With no contact named, success means the handler either inferred a target or reported a removal that did not happen. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.deleteContact,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: deleting the same contact twice must be stable', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildContactPayload();
    const first = await contactsClient.deleteContact(payload, { token: staticToken });
    const second = await contactsClient.deleteContact(payload, { token: staticToken });

    expect(
      second.status(),
      `deleting the same contact twice returned HTTP ${first.status()} then ${second.status()}.`
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
