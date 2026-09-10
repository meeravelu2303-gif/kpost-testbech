import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KWORD_PATHS, KWORD_PATH_TEMPLATES } from '../../src/api/clients/kwordDocuments.client';
import {
  documentDetailResponseSchema,
  documentListResponseSchema,
  shareDocumentResponseSchema,
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
  comparableBody,
  reportBusinessLogicFlaw,
  assertStatus,
} from '../../src/utils/apiAssertions';
import {
  buildSharePayload,
  nonExistentDocId,
} from '../../src/api/payloads/kwordDocuments.payload';
import { qaIdentifier } from '../../src/utils/safeTestData';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * KWord Documents — sharing and the read routes.
 *
 * `share` is outward-facing: the named users gain access to the document and are typically
 * notified, so recipients are QA identities and the tests target a non-existent document.
 *
 * The three reads are all documented as scoped to the token-derived `kpostID`, so the
 * question each asks is whether a caller-supplied identifier can widen that scope.
 * `documentsType` and `documentsType1` are documented as returning identical results when
 * no `type` filter is given — the same service method behind both — so that equivalence is
 * asserted directly rather than assumed.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /kword/share
 * ====================================================================================== */
test.describe('POST /kword/share', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.share,
    repro: `await kwordClient.share(buildSharePayload([recipient]), { token });`,
  };

  test('[1] happy path: a share grant satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    const response = await kwordClient.share(payload, { token: staticToken });

    await expectValidContract(
      response,
      shareDocumentResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 500-recipient share must not exhaust the handler', async ({
    kwordClient,
    staticToken,
  }) => {
    const recipients = Array.from({ length: 500 }, (_, index) => `qa-bulk-share-${index}`);
    const payload = buildSharePayload(recipients);
    const response = await kwordClient.share(payload, { token: staticToken });

    expect(
      response.status(),
      `a 500-recipient share produced HTTP ${response.status()}. Each recipient becomes a share row and is typically notified, so an unbounded list is both a bulk-insert and a mass-notification surface.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an empty recipient list must not report a successful share', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([]);
    const response = await kwordClient.share(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    expect(
      succeeded,
      `an empty recipient list returned success. Telling the author their document was shared when nobody received it is worse than an error. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing required parameter: "docId" omitted must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.share(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "docId" omitted on a share' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null recipient list must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    // Real recipient field is `kWordDocshares` (array of { kpostId, role, validUpto }); the old
    // `kpostIds` was a phantom, so nulling it left a valid share body and filed a false bug.
    const payload = buildSharePayload();
    (payload as Record<string, unknown>).kWordDocshares = null;

    const response = await kwordClient.share(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kWordDocshares" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: an empty docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([qaIdentifier('recipient')], { docId: '' });
    const response = await kwordClient.share(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a scalar where kWordDocshares expects an array', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    (payload as Record<string, unknown>).kWordDocshares = 'qa-single-recipient';

    const response = await kwordClient.share(payload, { token: staticToken });

    expect(
      response.status(),
      `kWordDocshares was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] access control: an unrecognised role must not silently grant write', async ({
    kwordClient,
    staticToken,
  }) => {
    // Access is the `role` inside each `kWordDocshares` entry (there is no `isEdit` field). An
    // unknown role value must not be treated as an editor grant.
    const payload = buildSharePayload([qaIdentifier('recipient')], {
      kWordDocshares: [
        { kpostId: qaIdentifier('recipient'), role: 'not-a-real-role', validUpto: Date.now() + 30 * 86_400_000 },
      ],
    });
    const response = await kwordClient.share(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const granted = json !== null && json.statusCode === 200;

    expect(
      granted,
      `an unrecognised role "not-a-real-role" was accepted and the share reported success. An unknown role must be rejected, not defaulted to editor — otherwise a typo silently grants write access. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[6] XSS: a script payload in a recipient id must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([XSS_PAYLOAD]);
    const response = await kwordClient.share(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not share every document', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([qaIdentifier('recipient')], { docId: SQLI_PAYLOAD });
    const response = await kwordClient.share(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as docId returned success on a share. Unparameterised, that could grant a recipient access to every document in the table. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const payload = buildSharePayload();
    const response = await kwordClient.share(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not grant document access', async ({
    kwordClient,
  }) => {
    const payload = buildSharePayload();
    const response = await kwordClient.share(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: sharing a document the caller does not own must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([qaIdentifier('recipient')], { docId: nonExistentDocId() });
    const response = await kwordClient.share(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const shared = json !== null && json.statusCode === 200;

    expect(
      shared,
      `a share succeeded for a document the caller does not own. That is an unauthorised grant of read access to someone else's work — the attacker names themselves as recipient and gains the document. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8d] privilege: a body-supplied kpostID must not stand in as the sharer', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload([qaIdentifier('recipient')], { kpostID: VICTIM_KPOST_ID });
    const response = await kwordClient.share(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const shared = json !== null && json.statusCode === 200;

    expect(
      shared,
      `a share succeeded while the body claimed kpostID="${VICTIM_KPOST_ID}". The handler stamps that field from the token to establish who is doing the sharing, so a body value must be ignored. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    const response = await kwordClient.share(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    const response = await kwordClient.share(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kwordClient, staticToken }) => {
    const response = await kwordClient.share({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a share grant' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.sendRaw(KWORD_PATHS.share, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: sharing twice must not duplicate the grant', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildSharePayload();
    const [first, second, third] = await Promise.all([
      kwordClient.share(payload, { token: staticToken }),
      kwordClient.share(payload, { token: staticToken }),
      kwordClient.share(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical shares returned different statuses (${statuses.join(', ')}). Without a uniqueness constraint the same recipient gets duplicate share rows and duplicate notifications.`
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
 * GET /kword/documents/{docId}
 * ====================================================================================== */
test.describe('GET /kword/documents/{docId}', () => {
  const META = {
    method: 'GET',
    path: KWORD_PATH_TEMPLATES.documentById,
    repro: `await kwordClient.documentById(docId, { token });`,
  };

  test('[1] happy path: a document read satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), { token: staticToken });

    await expectValidContract(
      response,
      documentDetailResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(MAX_LENGTH_STRING, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character docId path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 docId is handled without a server fault', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(UTF8_STRING, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 docId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameter: an empty docId must not return every document', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById('', { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      rows.length,
      `an empty docId returned ${rows.length} documents. With no document named the route must 404 rather than degrade into a listing. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[4] null fuzzing: a literal "null" docId must not resolve', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById('null', { token: staticToken });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    expect(
      resolved,
      `the literal string "null" resolved to a document. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a numeric docId is handled cleanly', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(String(INT32_OVERFLOW), {
      token: staticToken,
    });

    expect(
      response.status(),
      `a numeric docId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(XSS_PAYLOAD, { token: staticToken });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not return another user\'s document', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(SQLI_PAYLOAD, { token: staticToken });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);

    expect(
      resolved,
      `a SQL tautology as docId resolved to a document. The spec states the lookup resolves by docId **and** the token-derived kpostID, so a payload that returns anything proves that pairing is not parameterised. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(SQLI_DROP_PAYLOAD, { token: staticToken });

    await assertNoInternalLeak(response, META, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not return a document', async ({ kwordClient }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[8c] ownership: reading a document the caller neither owns nor was shared must fail', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), { token: staticToken });
    const { json, text } = await readBody(response);
    const record = json?.data as Record<string, unknown> | undefined;

    expect(
      record?.compose,
      `document body content was returned for a document the caller does not own. This route loads metadata, the heading tree and the full body — everything the author wrote. Body: ${text.slice(0, 200)}`
    ).toBeUndefined();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), { token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById(nonExistentDocId(), { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] structural: a path traversal attempt must not escape the route', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentById('../../../etc/passwd', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file.`
    ).not.toContain('root:');
  });

  test('[10b] idempotency: three concurrent identical reads must agree', async ({
    kwordClient,
    staticToken,
  }) => {
    const docId = nonExistentDocId();
    const [first, second, third] = await Promise.all([
      kwordClient.documentById(docId, { token: staticToken }),
      kwordClient.documentById(docId, { token: staticToken }),
      kwordClient.documentById(docId, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[IDOR] a foreign pathVariable must not reach another owner\'s record', async ({
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
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'pathVariable',
      foreignValue: FOREIGN.uuid,
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

/* =========================================================================================
 * GET /kword/documentsType
 * ====================================================================================== */
test.describe('GET /kword/documentsType', () => {
  const META = {
    method: 'GET',
    path: KWORD_PATHS.documentsType,
    repro: `await kwordClient.documentsType({ token });`,
  };

  test('[1] happy path: the document list satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({ token: staticToken });

    await expectValidContract(
      response,
      documentListResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character type filter must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({
      token: staticToken,
      params: { type: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character type filter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an unrecognised type must return an empty list, not everything', async ({
    kwordClient,
    staticToken,
  }) => {
    const filtered = await readBody(
      await kwordClient.documentsType({
        token: staticToken,
        params: { type: 'QA_NO_SUCH_TYPE' },
      })
    );
    const unfiltered = await readBody(await kwordClient.documentsType({ token: staticToken }));

    const filteredCount = Array.isArray(filtered.json?.data)
      ? (filtered.json.data as unknown[]).length
      : 0;
    const unfilteredCount = Array.isArray(unfiltered.json?.data)
      ? (unfiltered.json.data as unknown[]).length
      : 0;

    expect(
      filteredCount,
      `filtering by an unrecognised document type returned ${filteredCount} documents against ${unfilteredCount} unfiltered. An unknown filter value must narrow the result to nothing, not fall through to the unfiltered query.`
    ).toBeLessThanOrEqual(unfilteredCount);
  });

  test('[3] missing parameter: an omitted type must return the unfiltered list', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({ token: staticToken });

    expect(
      response.status(),
      `a call with no type parameter produced HTTP ${response.status()}. The spec states an omitted or empty type returns everything, so this is the documented default path.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" type must not be treated as a real filter', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({
      token: staticToken,
      params: { type: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a type filter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4b] empty fuzzing: an empty type must behave as no filter', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({ token: staticToken, params: { type: '' } });

    expect(
      response.status(),
      `an empty type filter produced HTTP ${response.status()}. The spec states an empty value takes the unfiltered path.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a numeric type filter is handled cleanly', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({
      token: staticToken,
      params: { type: INT32_OVERFLOW },
    });

    expect(
      response.status(),
      `a numeric type filter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the filter must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({
      token: staticToken,
      params: { type: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology filter must not widen the result set', async ({
    kwordClient,
    staticToken,
  }) => {
    const baseline = await readBody(await kwordClient.documentsType({ token: staticToken }));
    const injected = await readBody(
      await kwordClient.documentsType({ token: staticToken, params: { type: SQLI_PAYLOAD } })
    );

    const baselineCount = Array.isArray(baseline.json?.data)
      ? (baseline.json.data as unknown[]).length
      : 0;
    const injectedCount = Array.isArray(injected.json?.data)
      ? (injected.json.data as unknown[]).length
      : 0;

    expect(
      injectedCount,
      `a SQL tautology filter returned ${injectedCount} documents against a baseline of ${baselineCount}. A filter that widens the result set proves the value reaches the query unparameterised — and here it could reach documents belonging to other users.`
    ).toBeLessThanOrEqual(baselineCount);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const response = await kwordClient.documentsType({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must not list documents', async ({ kwordClient }) => {
    const response = await kwordClient.documentsType({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] scoping: a query-supplied kpostID must not switch whose documents are listed', async ({
    kwordClient,
    staticToken,
  }) => {
    const own = await readBody(await kwordClient.documentsType({ token: staticToken }));
    const impersonated = await readBody(
      await kwordClient.documentsType({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" as a query parameter changed the documents listed. The spec states both queries are scoped to the token-derived kpostID so cross-user reads are not possible; a difference here contradicts that.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    kwordClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      kwordClient.documentsType({ token: staticToken }),
      kwordClient.documentsType({ token: staticToken }),
      kwordClient.documentsType({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] disclosure: the summary list must not carry full document bodies', async ({
    kwordClient,
    staticToken,
  }) => {
    const { json } = await readBody(await kwordClient.documentsType({ token: staticToken }));
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

    test.skip(rows.length === 0, 'no documents returned to inspect');

    const withBodies = rows.filter(
      (row) => typeof row.compose === 'string' && row.compose.length > 500
    );

    expect(
      withBodies.length,
      `${withBodies.length} rows in the summary listing carried a full document body. The spec describes this route as returning summary records; shipping every document's text on a list call is a needless payload and widens what a single compromised response exposes.`
    ).toBe(0);
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
    const response = await genericClient.send('GET', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});

/* =========================================================================================
 * GET /kword/documentsType1
 *
 * SKIPPED: the backend team says /kword/documentsType1 is a developer-only test endpoint,
 * so its 16 cases are not run. Skipped rather than deleted: the path is in swagger.json, so
 * npm run generate would re-add its registry entry, and .skip keeps the cases one word away
 * from returning. NOTE: swagger documents this route as "retained for older clients" - if any
 * client still calls it, this only stops us WATCHING a live route, it does not decommission it.
 * ===================================================================================== */
test.describe.skip('GET /kword/documentsType1', () => {
  const META = {
    method: 'GET',
    path: KWORD_PATHS.documentsType1,
    repro: `await kwordClient.documentsType1({ token });`,
  };

  test('[1] happy path: the document list satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({ token: staticToken });

    await expectValidContract(
      response,
      documentListResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] equivalence: this must return the same result as documentsType with no filter', async ({
    kwordClient,
    staticToken,
  }) => {
    const viaType = await readBody(await kwordClient.documentsType({ token: staticToken }));
    const viaType1Response = await kwordClient.documentsType1({ token: staticToken });
    const viaType1 = await readBody(viaType1Response);

    const scenario =
      'documentsType1 and documentsType (no filter) returned different bodies. The spec states both call the same service method with the token-derived kpostID and therefore produce the same result; a divergence means one of them is scoping or filtering differently than documented.';

    if (viaType1.text !== viaType.text) {
      await reportBusinessLogicFlaw(
        viaType1Response,
        {
          ...META,
          title: 'documentsType1 and documentsType return different bodies for the same caller',
          scenario,
        },
        'Business Logic Flaw',
        'Major'
      );
    }

    expect(comparableBody(viaType1.text), scenario).toBe(comparableBody(viaType.text));
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. This route accepts no type filter by design.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { kpostID: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a numeric query value is handled cleanly', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { docId: INT32_OVERFLOW },
    });

    expect(
      response.status(),
      `a numeric docId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kwordClient,
  }) => {
    const response = await kwordClient.documentsType1({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an alg=none forged token must not list documents', async ({ kwordClient }) => {
    const response = await kwordClient.documentsType1({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[8c] scoping: a query-supplied kpostID must not switch whose documents are listed', async ({
    kwordClient,
    staticToken,
  }) => {
    const own = await readBody(await kwordClient.documentsType1({ token: staticToken }));
    const impersonated = await readBody(
      await kwordClient.documentsType1({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" changed the documents listed.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const response = await kwordClient.documentsType1({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    kwordClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      kwordClient.documentsType1({ token: staticToken }),
      kwordClient.documentsType1({ token: staticToken }),
      kwordClient.documentsType1({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] disclosure: the listing must not expose another user\'s documents', async ({
    kwordClient,
    staticToken,
    authSession,
  }) => {
    const { json } = await readBody(await kwordClient.documentsType1({ token: staticToken }));
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

    test.skip(rows.length === 0 || !authSession.kpostID, 'no documents or no identity to compare');

    const foreign = rows.filter(
      (row) => typeof row.kpostID === 'string' && row.kpostID !== authSession.kpostID
    );

    expect(
      foreign.length,
      `${foreign.length} listed documents belong to a kpostID other than the authenticated caller (${authSession.kpostID}). The listing is documented as scoped to the token identity.`
    ).toBe(0);
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
    const response = await genericClient.send('GET', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});
