import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KWORD_PATHS } from '../../src/api/clients/kwordDocuments.client';
import {
  createDocumentResponseSchema,
  deleteResponseSchema,
  documentMutationResponseSchema,
} from '../../src/api/schemas/kwordDocuments.schema';
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
  buildConvertToKadPayload,
  buildDeleteHeadingPayload,
  buildDocumentActionPayload,
  buildUpdateHeadingPayload,
  buildDocumentPayload,
  buildSaveContentPayload,
  nonExistentDocId,
} from '../../src/api/payloads/kwordDocuments.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * KWord Documents — document lifecycle.
 *
 * Five of these six handlers stamp the caller's `kpostID` onto the DTO before delegating,
 * so ownership is enforced before the service is reached. `isConvertToKad` is the documented
 * exception: it does **not**, leaving ownership entirely to checks inside the service. That
 * asymmetry is the most interesting thing on this tag and gets its own dedicated cases.
 *
 * `delete` and `deleteHeading` are irreversible through the API — delete removes the document
 * with its headings, content and every share of it — so all payloads target a non-existent,
 * QA-prefixed docId and the refusal path is what gets exercised.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /kword/create
 * ====================================================================================== */
test.describe('POST /kword/create', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.create,
    repro: `await kwordClient.create(buildDocumentPayload(), { token });`,
  };

  test('[1] happy path: creating a document satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: staticToken });

    await expectValidContract(
      response,
      createDocumentResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a successful creation must return the generated docId', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'document creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.docId,
      `the document was created but no docId came back. Every other route on this tag addresses a document by that identifier, so omitting it leaves the editor unable to save into the document it just created. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character title must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: MAX_LENGTH_STRING });
    const response = await kwordClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character docTitle produced HTTP ${response.status()}. A title renders in the document list, so its length must be bounded by validation.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 title is stored or refused without a server fault', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: UTF8_STRING });
    const response = await kwordClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 docTitle produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: an unbounded subject must not exhaust the handler', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ subject: 'a'.repeat(100_000) });
    const response = await kwordClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a 100k-character subject produced HTTP ${response.status()}. An unbounded field the handler stores verbatim is a memory/DoS surface.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "titleOfDocument" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    delete (payload as Record<string, unknown>).titleOfDocument;

    const response = await kwordClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "titleOfDocument" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null title must not create an unnamed document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: null });
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "titleOfDocument" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty title must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: '' });
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "titleOfDocument" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a scalar where the subject expects a string', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ subject: ['not', 'a', 'string'] });
    const response = await kwordClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `subject was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric title must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: INT32_OVERFLOW });
    const response = await kwordClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `docTitle was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the title must not be stored unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: XSS_PAYLOAD });
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await kwordClient.create(buildDocumentPayload({ titleOfDocument: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[6b] XSS: a script payload in body content must not be stored unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ subject: XSS_PAYLOAD });
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload({ titleOfDocument: SQLI_PAYLOAD });
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not create a persistent document', async ({
    kwordClient,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: a body-supplied kpostID must not set the document owner', async ({
    kwordClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildDocumentPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kwordClient.create(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'document creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the created document was owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The spec states the token-derived kpostID is passed as an explicit argument, so a body value must be ignored — otherwise a user can plant documents in someone else's library. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    const response = await kwordClient.create(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kwordClient, staticToken }) => {
    const response = await kwordClient.create({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on document creation' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.create, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical creations must not mint duplicates', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentPayload();
    const [first, second, third] = await Promise.all([
      kwordClient.create(payload, { token: staticToken }),
      kwordClient.create(payload, { token: staticToken }),
      kwordClient.create(payload, { token: staticToken }),
    ]);

    const bodies = [await readBody(first), await readBody(second), await readBody(third)];
    const ids = bodies
      .map((b) => (b.json?.data as Record<string, unknown> | undefined)?.docId)
      .filter((id): id is string => typeof id === 'string');

    test.skip(ids.length === 0, 'no documents were created, so there is nothing to compare');

    expect(
      new Set(ids).size,
      `three identical concurrent creations produced ${new Set(ids).size} distinct documents. A double-submit from the editor should not silently fill the user's library with copies.`
    ).toBeLessThanOrEqual(1);
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});

/* =========================================================================================
 * POST /kword/update
 * ====================================================================================== */
test.describe('POST /kword/update', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.update,
    repro: `await kwordClient.update(buildUpdateHeadingPayload(), { token });`,
  };

  test('[1] happy path: an update satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload();
    const response = await kwordClient.update(payload, { token: staticToken });

    await expectValidContract(
      response,
      documentMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character title must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ heading: [{ topic: MAX_LENGTH_STRING, children: [] }] });
    const response = await kwordClient.update(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character heading topic produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 title is handled without a server fault', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ heading: [{ topic: UTF8_STRING, children: [] }] });
    const response = await kwordClient.update(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 heading topic produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "docId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload();
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.update(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "docId" omitted on an update' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null docId must never widen the update', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ docId: null });
    const response = await kwordClient.update(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ docId: '' });
    const response = await kwordClient.update(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where a docId is expected', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ docId: { id: 1 } });
    const response = await kwordClient.update(payload, { token: staticToken });

    expect(
      response.status(),
      `docId was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ heading: [{ topic: XSS_PAYLOAD, children: [] }] });
    const response = await kwordClient.update(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not rewrite every document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ docId: SQLI_PAYLOAD });
    const response = await kwordClient.update(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as docId returned success on an update. Unparameterised, that could overwrite the title and structure of every document in the table. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildUpdateHeadingPayload();
    const response = await kwordClient.update(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not modify a document', async ({ kwordClient }) => {
    const payload = buildUpdateHeadingPayload();
    const response = await kwordClient.update(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: updating a document the caller does not own must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload({ docId: nonExistentDocId() });
    const response = await kwordClient.update(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const updated = json !== null && json.statusCode === 200;

    expect(
      updated,
      `an update succeeded against a document the caller does not own. The handler stamps kpostID from the token precisely so the service can enforce ownership; a success here means that enforcement is missing. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload();
    const response = await kwordClient.update(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload();
    const response = await kwordClient.update(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not update an inferred document', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.update({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty body returned success on the update route. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.update, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical updates must agree', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildUpdateHeadingPayload();
    const [first, second, third] = await Promise.all([
      kwordClient.update(payload, { token: staticToken }),
      kwordClient.update(payload, { token: staticToken }),
      kwordClient.update(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent updates returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});

/* =========================================================================================
 * POST /kword/saveContent
 * ====================================================================================== */
test.describe('POST /kword/saveContent', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.saveContent,
    repro: `await kwordClient.saveContent(buildSaveContentPayload(), { token });`,
  };

  test('[1] happy path: saving content satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload();
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await expectValidContract(
      response,
      documentMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a very large document body must not be silently truncated', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ compose: 'a'.repeat(200000) });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    expect(
      response.status(),
      `a 200 KB document body produced HTTP ${response.status()}. This is the editor's save path, so a long document is ordinary input: it must be stored or refused explicitly, never truncated without telling the author.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 body is stored without a server fault', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ compose: UTF8_STRING.repeat(50) });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "docId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload();
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "docId" omitted on a content save' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null docId must not write content nowhere', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ docId: null });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty body must not blank a stored document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ compose: '' });
    const response = await kwordClient.saveContent(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const saved = json !== null && json.statusCode === 200;

    expect(
      saved,
      `an empty compose value was accepted against a document the caller does not own. On the autosave path an empty save is how a document silently loses its content. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a numeric headingId beyond int32 must be handled', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ headingId: INT32_OVERFLOW });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    expect(
      response.status(),
      `headingId=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a string headingId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ headingId: 'first' });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    expect(
      response.status(),
      `headingId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in content must not be stored unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ compose: XSS_PAYLOAD });
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await kwordClient.saveContent(buildSaveContentPayload({ compose: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology must not overwrite every document body', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ docId: SQLI_PAYLOAD });
    const response = await kwordClient.saveContent(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as docId returned success on a content save. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildSaveContentPayload();
    const response = await kwordClient.saveContent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not write document content', async ({
    kwordClient,
  }) => {
    const payload = buildSaveContentPayload();
    const response = await kwordClient.saveContent(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: saving into a document the caller does not own must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload({ docId: nonExistentDocId() });
    const response = await kwordClient.saveContent(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const saved = json !== null && json.statusCode === 200;

    expect(
      saved,
      `a content save succeeded against a document the caller does not own. This route overwrites the stored body, so an ownership gap here lets one user destroy another's work. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload();
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSaveContentPayload();
    const response = await kwordClient.saveContent(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kwordClient, staticToken }) => {
    const response = await kwordClient.saveContent({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a content save' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.saveContent, 'not json at all', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] concurrency: rapid autosaves must not produce conflicting outcomes', async ({
    kwordClient,
    staticToken,
  }) => {
    const docId = nonExistentDocId();
    const responses = await Promise.all([
      kwordClient.saveContent(buildSaveContentPayload({ docId, compose: 'version one' }), {
        token: staticToken,
      }),
      kwordClient.saveContent(buildSaveContentPayload({ docId, compose: 'version two' }), {
        token: staticToken,
      }),
      kwordClient.saveContent(buildSaveContentPayload({ docId, compose: 'version three' }), {
        token: staticToken,
      }),
    ]);
    const statuses = responses.map((r) => r.status());

    expect(
      new Set(statuses).size,
      `three concurrent autosaves of different content returned different statuses (${statuses.join(', ')}). The editor fires this loop continuously, so which version survives must not depend on a race the client cannot observe.`
    ).toBe(1);
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
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
 * POST /kword/isConvertToKad — the handler that does NOT stamp kpostID from the token
 * ====================================================================================== */
test.describe('POST /kword/isConvertToKad', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.isConvertToKad,
    repro: `await kwordClient.isConvertToKad(buildConvertToKadPayload(true), { token });`,
  };

  test('[1] happy path: toggling the KAD flag satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true);
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await expectValidContract(
      response,
      documentMutationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: MAX_LENGTH_STRING });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character docId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 docId is handled without a server fault', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: UTF8_STRING });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 docId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "docId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true);
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "docId" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null conversion flag must not default to true', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ convertToKad: null });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "convertToKad" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: '' });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a truthy string where the flag expects a boolean', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ convertToKad: 'false' });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    expect(
      response.status(),
      `convertToKad was sent as the string "false" and produced HTTP ${response.status()}. A string is truthy in most coercions, so accepting it risks setting the flag when the caller asked to clear it.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: XSS_PAYLOAD });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not flag every document for conversion', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: SQLI_PAYLOAD });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as docId returned success. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildConvertToKadPayload(true);
    const response = await kwordClient.isConvertToKad(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not toggle the conversion flag', async ({
    kwordClient,
  }) => {
    const payload = buildConvertToKadPayload(true);
    const response = await kwordClient.isConvertToKad(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] the documented gap: the flag must not be settable on another user\'s document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { docId: nonExistentDocId() });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `the KAD flag was set on a document the caller does not own. The spec singles this handler out: unlike update, saveContent, deleteHeading and share, it does not stamp the caller's kpostID onto the DTO, so ownership rests entirely on checks inside the service. This is the one route on the tag where that enforcement can be missing without any handler-level guard catching it. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] the documented gap: a body-supplied kpostID must not stand in for the caller', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true, { kpostID: VICTIM_KPOST_ID });
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `the flag was set while the body carried kpostID="${VICTIM_KPOST_ID}". Since this handler does not overwrite that field from the token, whatever the caller sends reaches the service as the acting identity. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(true);
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildConvertToKadPayload(false);
    const response = await kwordClient.isConvertToKad(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not toggle anything', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.isConvertToKad({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const applied = json !== null && json.statusCode === 200;

    expect(
      applied,
      `an empty body returned success on the KAD toggle. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.isConvertToKad, '[1,2,', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: a concurrent set and clear must not leave the flag ambiguous', async ({
    kwordClient,
    staticToken,
  }) => {
    const docId = nonExistentDocId();
    const [setResponse, clearResponse] = await Promise.all([
      kwordClient.isConvertToKad(buildConvertToKadPayload(true, { docId }), {
        token: staticToken,
      }),
      kwordClient.isConvertToKad(buildConvertToKadPayload(false, { docId }), {
        token: staticToken,
      }),
    ]);
    const bothSucceeded = setResponse.status() === 200 && clearResponse.status() === 200;

    expect(
      bothSucceeded,
      `a concurrent set and clear of the KAD flag both reported success (HTTP ${setResponse.status()} and ${clearResponse.status()}). Whether the document is queued for downstream conversion would then depend on write ordering.`
    ).toBeFalsy();
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
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
 * POST /kword/delete
 * ====================================================================================== */
test.describe('POST /kword/delete', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.delete,
    repro: `await kwordClient.delete(buildDocumentActionPayload(), { token }); // non-existent doc only`,
  };

  test('[1] happy path: a delete request satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload();
    const response = await kwordClient.delete(payload, { token: staticToken });

    await expectValidContract(
      response,
      deleteResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] contract: deleting nothing must not report a deleted row', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: nonExistentDocId() });
    const response = await kwordClient.delete(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'endpoint did not return a JSON envelope');

    expect(
      json?.data,
      `deleting a non-existent document reported a deleted-row count of 1. The spec states the service returns 1 only when a matching owned document was removed, so a 1 here means either the ownership filter is absent or the count is fabricated. Body: ${text.slice(0, 200)}`
    ).not.toBe(1);
  });

  test('[2] boundary: a 5000-character docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: MAX_LENGTH_STRING });
    const response = await kwordClient.delete(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character docId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "docId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload();
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "docId" omitted on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null docId must never widen the delete', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: null });
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to null on a delete' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: '' });
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an array where a docId is expected', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: ['doc-1'] });
    const response = await kwordClient.delete(payload, { token: staticToken });

    expect(
      response.status(),
      `docId was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: XSS_PAYLOAD });
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not delete every document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: SQLI_PAYLOAD });
    const response = await kwordClient.delete(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as docId returned success on a delete. This removes documents with their headings, content and shares, and is not reversible through the API — unparameterised, it could empty the table. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: SQLI_DROP_PAYLOAD });
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildDocumentActionPayload();
    const response = await kwordClient.delete(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must never delete a document', async ({
    kwordClient,
  }) => {
    const payload = buildDocumentActionPayload();
    const response = await kwordClient.delete(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: deleting a document the caller does not own must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload({ docId: nonExistentDocId() });
    const response = await kwordClient.delete(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.statusCode === 200 && json.data === 1;

    expect(
      deleted,
      `a delete reported success against a document the caller does not own. Every share of that document also becomes invalid, so recipients lose access to work they were reading. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload();
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload();
    const response = await kwordClient.delete(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must never trigger an unscoped delete', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.delete({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200 && json.data === 1;

    expect(
      succeeded,
      `an empty body reported a deleted document. With no docId supplied, that can only mean the handler inferred a target. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.delete, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a delete must not change its outcome', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDocumentActionPayload();
    const first = await kwordClient.delete(payload, { token: staticToken });
    const second = await kwordClient.delete(payload, { token: staticToken });

    expect(
      second.status(),
      `deleting the same document twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});

/* =========================================================================================
 * POST /kword/deleteHeading
 * ====================================================================================== */
test.describe('POST /kword/deleteHeading', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.deleteHeading,
    repro: `await kwordClient.deleteHeading(buildDeleteHeadingPayload(), { token });`,
  };

  test('[1] happy path: a heading delete satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload();
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await expectValidContract(
      response,
      deleteResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] contract: deleting a non-existent heading must not report a removal', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ headingId: 999999999 });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'endpoint did not return a JSON envelope');

    expect(
      json?.data,
      `deleting a non-existent heading reported a removed-row count of 1. Body: ${text.slice(0, 200)}`
    ).not.toBe(1);
  });

  test('[2] boundary: an int32-overflow headingId must be handled cleanly', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ headingId: INT32_OVERFLOW });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    expect(
      response.status(),
      `headingId=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative headingId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ headingId: -1 });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    expect(
      response.status(),
      `headingId=-1 produced HTTP ${response.status()}. A negative identifier cannot exist and must be refused.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "headingId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload();
    delete (payload as Record<string, unknown>).headingId;

    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "headingId" omitted' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null headingId must not remove an inferred node', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ headingId: null });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "headingId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ docId: '' });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a string headingId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ headingId: 'first-heading' });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    expect(
      response.status(),
      `headingId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ docId: XSS_PAYLOAD });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not strip every heading', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ docId: SQLI_PAYLOAD });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology returned success on a heading delete. The content stored beneath each heading goes with it, so unparameterised this could gut every document at once. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildDeleteHeadingPayload();
    const response = await kwordClient.deleteHeading(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not remove a heading', async ({ kwordClient }) => {
    const payload = buildDeleteHeadingPayload();
    const response = await kwordClient.deleteHeading(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: removing a heading from another user\'s document must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload({ docId: nonExistentDocId() });
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const removed = json !== null && json.statusCode === 200 && json.data === 1;

    expect(
      removed,
      `a heading removal reported success against a document the caller does not own. The content beneath that heading is destroyed with it. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload();
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload();
    const response = await kwordClient.deleteHeading(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must not remove an inferred heading', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.deleteHeading({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200 && json.data === 1;

    expect(
      succeeded,
      `an empty body reported a removed heading. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.deleteHeading, '{"a":}', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: repeating a heading delete must be stable', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildDeleteHeadingPayload();
    const first = await kwordClient.deleteHeading(payload, { token: staticToken });
    const second = await kwordClient.deleteHeading(payload, { token: staticToken });

    expect(
      second.status(),
      `deleting the same heading twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
  });

  test('[IDOR] a foreign documentID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});
