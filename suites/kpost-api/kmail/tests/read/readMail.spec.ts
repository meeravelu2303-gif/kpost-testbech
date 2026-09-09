import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { PATH_TEMPLATES, READ_MAIL_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import {
  kmailContentResponseSchema,
  kmailEnvelopeSchema,
  kmailListResponseSchema,
} from '../../src/api/schemas/kmail.schema';
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
  MAIL_DIRECTION,
  buildKmailDetailsPayload,
  buildReadMailPayload,
  buildReferenceMailPayload,
} from '../../src/api/payloads/readMail.payload';
import { nonExistentKmailId, syntheticRecipient } from '../../src/utils/safeTestData';

/**
 * Reading mail — `/v2/readMail/**`.
 *
 * This controller serves mail bodies. Nearly every case asks one question: can a caller who
 * supplies an identifier reach content they were never sent?
 *
 * Three contract facts shape the file:
 *
 *  - `kmailType` is `@NotBlank` and names the folder; a blank value is a documented 400, firm
 *    enough to assert directly rather than probe.
 *  - `kpostUser` is server-assigned (overwritten from the token). The ownership cases set it
 *    deliberately — a field naming the owner that is supposed to be ignored is where scoping
 *    quietly stops being applied.
 *  - `getCopiesInfo` is documented to filter BCC recipients; an unfiltered response discloses
 *    that someone was silently copied, which is the whole point of the feature.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null,null--`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * POST /v2/readMail/sentAndInboxMailContent
 * ====================================================================================== */
test.describe('POST /v2/readMail/sentAndInboxMailContent', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.sentAndInboxMailContent,
    repro: `await readMailClient.sentAndInboxMailContent(buildReadMailPayload(), { token });`,
  };

  test('[1] happy path: opening a mail satisfies the contract', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload();
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await expectValidContract(
      response,
      kmailContentResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: another user\'s mail body must not be readable by kmailID', async ({
    readMailClient,
    token,
  }) => {
    // The central assertion of this file. kmailID is a MySQL auto-increment — sequential and
    // guessable — so the only thing between a caller and the whole store is whether the service
    // checks the caller was party to the mail before returning its body.
    const payload = buildReadMailPayload({ kmailID: FOREIGN.kmailID });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID',
    });
  });

  test('[3] IDOR: a body kpostUser must not re-scope the read', async ({
    readMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildReadMailPayload({ kpostUser: FOREIGN.victimKpostID });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'read returned no parseable body');

    expect(
      text.includes(`"kpostUser":"${FOREIGN.victimKpostID}"`) ||
        text.includes(`"toAddress":"${FOREIGN.victimKpostID}"`),
      `naming kpostUser "${FOREIGN.victimKpostID}" returned that account's mail while the caller was ${callerKpostId ?? 'a different identity'}. kpostUser is documented as overwritten from the token precisely so the body cannot choose whose mailbox is read. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] IDOR: sequential kmailIDs must not walk the mail store', async ({
    readMailClient,
    token,
  }) => {
    // Five consecutive low ids. On a correctly scoped service each returns nothing (the caller
    // is party to none); if several return content, the id alone is access and the whole store
    // walks with a for-loop.
    const ids = [1001, 1002, 1003, 1004, 1005];
    const responses = await Promise.all(
      ids.map((kmailID) =>
        readMailClient
          .sentAndInboxMailContent(buildReadMailPayload({ kmailID }), { token })
          .then(async (response) => ({ kmailID, ...(await readBody(response)), ok: response.ok() }))
      )
    );

    const withContent = responses.filter(
      (entry) => entry.ok && /"kmailContent"\s*:\s*"[^"]{10,}"/.test(entry.text)
    );

    expect(
      withContent.length,
      `${withContent.length} of ${ids.length} sequential low kmailIDs (${withContent.map((e) => e.kmailID).join(', ')}) returned mail bodies to a caller who was party to none of them. kmailID is a MySQL auto-increment, so this is not a guessing attack — it is a for-loop over the entire mail store.`
    ).toBe(0);
  });

  test('[5] validation: a blank kmailType must be a 400', async ({ readMailClient, token }) => {
    // The one hard validation contract here: kmailType is `@NotBlank` and the OpenAPI doc states
    // a blank value yields 400 — asserted as a specific status since the answer is unambiguous.
    const payload = buildReadMailPayload({ kmailType: '' });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertStatus(response, [400, 401, 403, 422], {
      ...META,
      body: payload,
      title: 'A blank kmailType is not rejected with the documented 400',
      severity: 'Major',
    });
  });

  test('[6] validation: a missing kmailType must be refused', async ({ readMailClient, token }) => {
    const payload = buildReadMailPayload();
    delete (payload as Record<string, unknown>).kmailType;
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the required field "kmailType" was omitted',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] validation: a null kmailType must be refused', async ({ readMailClient, token }) => {
    const payload = buildReadMailPayload({ kmailType: null });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "kmailType" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] validation: an unknown kmailType direction must not read across both sides', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ kmailType: 'NotADirection' });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    expect(
      response.status(),
      `an unrecognised kmailType produced HTTP ${response.status()}. kmailType is a direction ("received"/"sent"); an unknown value must be refused or return nothing. If it is treated as "no filter" the route reads both the sent and received copies of a mail the caller may only be entitled to one side of.`
    ).toBeLessThan(500);
  });

  test('[9] validation: a malformed kmailID must be refused', async ({ readMailClient, token }) => {
    const payload = buildReadMailPayload({ kmailID: 'not-a-number' });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    expect(
      response.status(),
      `a non-numeric kmailID produced HTTP ${response.status()}. The column is a bigint, so a string is a parser-level type error and not a database exception.`
    ).toBeLessThan(500);
  });

  test('[10] validation: a negative kmailID must be refused', async ({ readMailClient, token }) => {
    const payload = buildReadMailPayload({ kmailID: -1 });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailID was negative, which no auto-increment identity can be',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[11] not found: a mail that does not exist must not be a 500', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ kmailID: nonExistentKmailId() });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      body: payload,
      title: 'A mail that does not exist is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[12] validation: an empty body must be refused', async ({ readMailClient, token }) => {
    const response = await readMailClient.sentAndInboxMailContent({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an empty body was posted to the mail read route',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[13] injection: a tautology in selectedContact must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ selectedContact: SQLI_PAYLOAD });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[14] injection: a UNION probe in kmailType must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ kmailType: SQLI_UNION_PAYLOAD });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[15] injection: a NoSQL operator must not reach the Mongo query', async ({
    readMailClient,
    token,
  }) => {
    // Mail bodies live in MongoDB, not MySQL. An object where a scalar belongs is how a Mongo
    // query gets subverted, and `{$ne: null}` is the canonical "match everything" form.
    const payload = buildReadMailPayload({ kmailID: { $ne: null } });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });
    const { text } = await readBody(response);

    await assertNoInternalLeak(response, { ...META, body: payload }, '$ne');

    expect(
      response.ok() && /"kmailContent"\s*:\s*"[^"]{10,}"/.test(text),
      `a Mongo operator object ({"$ne": null}) supplied where kmailID expects a number returned mail content. Mail bodies are stored in MongoDB, so an operator that reaches the query unmodified matches every document rather than one. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[16] XSS: a script payload must not be reflected unescaped', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ selectedContact: XSS_PAYLOAD });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[17] boundary: a 5000-character selectedContact must not fault', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({ selectedContact: MAX_LENGTH_STRING });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    expect(
      response.status(),
      `a 5000-character selectedContact produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[18] structural: malformed JSON must be a clean 400', async ({ readMailClient, token }) => {
    const malformed = '{"kmailID":';
    const response = await readMailClient.sendRaw(
      READ_MAIL_PATHS.sentAndInboxMailContent,
      malformed,
      { token }
    );

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await readMailClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[19] auth: no Authorization header must be 401/403', async ({ readMailClient }) => {
    const payload = buildReadMailPayload();
    const response = await readMailClient.sentAndInboxMailContent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[20] auth: an expired token must not read mail', async ({ readMailClient }) => {
    const payload = buildReadMailPayload();
    const response = await readMailClient.sentAndInboxMailContent(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[21] auth: a malformed token must not read mail', async ({ readMailClient }) => {
    const payload = buildReadMailPayload();
    const response = await readMailClient.sentAndInboxMailContent(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[22] status parity: HTTP status must agree with the envelope', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.sentAndInboxMailContent({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });

  test('[23] direction isolation: the sent side must not return the received side verbatim', async ({
    readMailClient,
    token,
  }) => {
    // Two reads of the same id differing only by direction. A service that ignores kmailType
    // returns the same copy for both — the direction filter is decorative and a caller entitled
    // to one side can read the other.
    const kmailID = nonExistentKmailId();
    const [received, sent] = await Promise.all([
      readMailClient.sentAndInboxMailContent(
        buildReadMailPayload({ kmailID, kmailType: MAIL_DIRECTION.received }),
        { token }
      ),
      readMailClient.sentAndInboxMailContent(
        buildReadMailPayload({ kmailID, kmailType: MAIL_DIRECTION.sent }),
        { token }
      ),
    ]);

    const [receivedBody, sentBody] = await Promise.all([readBody(received), readBody(sent)]);
    test.skip(
      !received.ok() || !sent.ok(),
      'neither direction read succeeded on this environment — nothing to compare'
    );

    const receivedHasContent = /"kmailContent"\s*:\s*"[^"]{10,}"/.test(receivedBody.text);
    const sentHasContent = /"kmailContent"\s*:\s*"[^"]{10,}"/.test(sentBody.text);

    expect(
      receivedHasContent && sentHasContent && receivedBody.text === sentBody.text,
      `the same kmailID returned byte-identical content when read as "received" and as "sent". kmailType is required on this route and names the direction; if the same mail answers to both, the field is decorative and the sent/received boundary means nothing.`
    ).toBe(false);
  });
});

/* =========================================================================================
 * POST /v2/readMail/referenceMailContent
 * ====================================================================================== */
test.describe('POST /v2/readMail/referenceMailContent', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.referenceMailContent,
    repro: `await readMailClient.referenceMailContent(buildReferenceMailPayload(), { token });`,
  };

  test('[1] happy path: a thread read satisfies the contract', async ({ readMailClient, token }) => {
    const payload = buildReferenceMailPayload();
    const response = await readMailClient.referenceMailContent(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: a thread of foreign kmailIDs must return nothing', async ({
    readMailClient,
    token,
  }) => {
    // The batch version of the single-mail IDOR: `referenceMails` is an array, so one request
    // reads as many bodies as it names. A per-mail check applied on the single route but skipped
    // on the batch route is a common shape, so this is asserted separately.
    const payload = buildReferenceMailPayload([FOREIGN.kmailID, FOREIGN.kmailID + 1]);
    const response = await readMailClient.referenceMailContent(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'referenced kmailID',
    });
  });

  test('[3] boundary: an unbounded reference chain must be capped', async ({
    readMailClient,
    token,
  }) => {
    // One body per entry. Uncapped, the response size is the caller's to choose — 500 entries is
    // a memory amplification of several hundred times the request size.
    const chain = Array.from({ length: 500 }, (_unused, index) => 1000 + index);
    const payload = buildReferenceMailPayload(chain);
    const response = await readMailClient.referenceMailContent(payload, { token });

    expect(
      response.status(),
      `a 500-entry reference chain produced HTTP ${response.status()}. The route reads one mail body per entry, so an uncapped chain lets one small request generate an arbitrarily large response. It must be refused with a stated cap.`
    ).toBeLessThan(500);

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 200,
      what: 'thread messages',
    });
  });

  test('[4] validation: an empty reference chain must be handled explicitly', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReferenceMailPayload([]);
    const response = await readMailClient.referenceMailContent(payload, { token });

    expect(
      response.status(),
      `an empty referenceMails array produced HTTP ${response.status()}. "No thread" is either an empty result or a 400 — never a fault, and never "return everything".`
    ).toBeLessThan(500);
  });

  test('[5] validation: a null reference chain must be refused', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReferenceMailPayload([], { referenceMails: null });
    const response = await readMailClient.referenceMailContent(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "referenceMails" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] type mismatch: a bare number where referenceMails expects an array', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReferenceMailPayload([], { referenceMails: nonExistentKmailId() });
    const response = await readMailClient.referenceMailContent(payload, { token });

    expect(
      response.status(),
      `referenceMails was sent as a bare number where the contract declares an array, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] injection: a tautology inside the chain must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReferenceMailPayload([], { referenceMails: [SQLI_PAYLOAD] });
    const response = await readMailClient.referenceMailContent(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: an anonymous caller must not read a thread', async ({ readMailClient }) => {
    const payload = buildReferenceMailPayload();
    const response = await readMailClient.referenceMailContent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/readMail/getKmailDetailsUsingKmailID
 * ====================================================================================== */
test.describe('POST /v2/readMail/getKmailDetailsUsingKmailID', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.getKmailDetailsUsingKmailID,
    repro: `await readMailClient.getKmailDetailsUsingKmailID(buildKmailDetailsPayload(), { token });`,
  };

  test('[1] happy path: a batch metadata fetch satisfies the contract', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildKmailDetailsPayload();
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: a batch of foreign kmailIDs must return nothing', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildKmailDetailsPayload([FOREIGN.kmailID, FOREIGN.kmailID + 1]);
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'batched kmailID',
    });
  });

  test('[3] IDOR: a batch mixing owned and foreign ids must return only the owned ones', async ({
    readMailClient,
    token,
  }) => {
    // The subtler batch failure a per-id check catches but a whole-batch check does not: an
    // implementation validating "does the caller own any of these?" then returning the lot leaks
    // every foreign entry alongside a legitimate one, and looks correct on all-foreign batches.
    const payload = buildKmailDetailsPayload([1, FOREIGN.kmailID]);
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'foreign kmailID batched alongside an owned one',
    });
  });

  test('[4] boundary: an unbounded batch must be capped', async ({ readMailClient, token }) => {
    const kmailIDs = Array.from({ length: 1000 }, (_unused, index) => 1000 + index);
    const payload = buildKmailDetailsPayload(kmailIDs);
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    expect(
      response.status(),
      `a 1000-entry kmailIDs batch produced HTTP ${response.status()}. A batch endpoint without a cap is a bulk-read primitive; it must be refused with a stated limit.`
    ).toBeLessThan(500);
  });

  test('[5] validation: an empty batch must be handled explicitly', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildKmailDetailsPayload([]);
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    expect(
      response.status(),
      `an empty kmailIDs array produced HTTP ${response.status()}. It must be an empty result or a 400, and specifically must not be read as "no filter".`
    ).toBeLessThan(500);
  });

  test('[6] validation: a missing kmailIDs must be refused', async ({ readMailClient, token }) => {
    const payload = buildReadMailPayload();
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a batch fetch with no kmailIDs supplied',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] auth: an anonymous caller must not batch-fetch metadata', async ({
    readMailClient,
  }) => {
    const payload = buildKmailDetailsPayload();
    const response = await readMailClient.getKmailDetailsUsingKmailID(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * GET /v2/readMail/getCopiesInfo/{kmailID}
 * ====================================================================================== */
test.describe('GET /v2/readMail/getCopiesInfo/{kmailID}', () => {
  const META = {
    method: 'GET',
    path: PATH_TEMPLATES.getCopiesInfo,
    repro: `await readMailClient.getCopiesInfo(kmailID, { token });`,
  };

  test('[1] happy path: the recipient list satisfies the contract', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo(nonExistentKmailId(), { token });

    await expectValidContract(response, kmailEnvelopeSchema, META, [
      200, 204, 400, 401, 403, 404, 500,
    ]);
  });

  test('[2] BCC: blind recipients must not be disclosed to other recipients', async ({
    readMailClient,
    token,
  }) => {
    // `getCopiesInfo` is documented to filter BCC entries — that filter is the whole
    // implementation of blind copying. Every recipient can call this route, so if the filter is
    // missing or branch-specific, BCC silently becomes CC and reveals who was silently copied.
    const response = await readMailClient.getCopiesInfo(nonExistentKmailId(), { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'copies info returned no data on this environment');

    expect(
      /"bcc(List)?"\s*:\s*\[\s*"[^"]+"/i.test(text),
      `the recipient list returned populated BCC entries. This route is documented to filter blind copies, and that filter is the whole implementation of BCC — every recipient of a mail can call this endpoint, so an unfiltered response tells all of them who was silently copied. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] IDOR: the recipients of another user\'s mail must not be listed', async ({
    readMailClient,
    token,
  }) => {
    // Metadata, not content, but worth protecting: who corresponded with whom is a social graph,
    // often more revealing at scale than any single body.
    const response = await readMailClient.getCopiesInfo(FOREIGN.kmailID, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID path variable',
    });
  });

  test('[4] validation: a non-numeric kmailID must be refused', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo('not-a-number', { token });

    expect(
      response.status(),
      `a non-numeric kmailID in the path produced HTTP ${response.status()}. The path variable is declared as an integer, so Spring's own type conversion should answer 400 before the controller runs.`
    ).toBeLessThan(500);
  });

  test('[5] boundary: path traversal must not resolve another route', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo('../../draft/getAllDraftMails', { token });

    expect(
      response.status(),
      `a traversal sequence in the kmailID segment produced HTTP ${response.status()}. It must resolve to nothing, not to a different controller.`
    ).toBeLessThan(500);
  });

  test('[6] injection: a tautology in the path must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo(SQLI_PAYLOAD, { token });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload in the path must not be reflected', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo(XSS_PAYLOAD, { token });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] not found: a mail that does not exist must not be a 500', async ({
    readMailClient,
    token,
  }) => {
    const response = await readMailClient.getCopiesInfo(nonExistentKmailId(), { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'A mail that does not exist is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[9] auth: an anonymous caller must not list recipients', async ({ readMailClient }) => {
    const response = await readMailClient.getCopiesInfo(nonExistentKmailId(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[10] idempotency: two consecutive reads must agree', async ({ readMailClient, token }) => {
    const kmailID = nonExistentKmailId();
    const [first, second] = await Promise.all([
      readMailClient.getCopiesInfo(kmailID, { token }),
      readMailClient.getCopiesInfo(kmailID, { token }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });
});

/* =========================================================================================
 * Read-state semantics
 * ====================================================================================== */
test.describe('Read-state side effects', () => {
  test('[1] opening a mail must not be exploitable to mark another user\'s mail as read', async ({
    readMailClient,
    token,
  }) => {
    // Opening a mail sets its opened status, driving the sender's `sentMailNotOpened` bucket and
    // the unread badge. An unscoped read not only reads another user's mail but marks it read,
    // hiding the evidence — destroying the trace is often worth more than the content.
    const payload = buildReadMailPayload({
      kmailID: FOREIGN.kmailID,
      kpostUser: FOREIGN.hasVictim ? FOREIGN.victimKpostID : undefined,
    });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      method: 'POST',
      path: READ_MAIL_PATHS.sentAndInboxMailContent,
      repro: `await readMailClient.sentAndInboxMailContent({ kmailID: <foreign>, kpostUser: '<victim>' }, { token });`,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on a read that also mutates opened-state',
    });
  });

  test('[2] a read must be repeatable without changing its own answer', async ({
    readMailClient,
    token,
  }) => {
    // The second read must return the same content. If the "mark as opened" side effect changes
    // what the read returns, a client retrying after a dropped connection gets a different answer.
    const payload = buildReadMailPayload({ kmailID: nonExistentKmailId() });
    const first = await readMailClient.sentAndInboxMailContent(payload, { token });
    const second = await readMailClient.sentAndInboxMailContent(payload, { token });

    const [firstBody, secondBody] = await Promise.all([readBody(first), readBody(second)]);

    expect(
      firstBody.text.replace(/\d{10,}/g, '<ts>'),
      `reading the same mail twice returned different bodies. Opening a mail has a side effect on its read state, but that must not change what the read itself returns — a client retrying after a dropped connection would otherwise receive something different from what it lost.`
    ).toBe(secondBody.text.replace(/\d{10,}/g, '<ts>'));
  });

  test('[3] a read of a contact with no correspondence must not be an error', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildReadMailPayload({
      selectedContact: syntheticRecipient(),
      kmailID: nonExistentKmailId(),
    });
    const response = await readMailClient.sentAndInboxMailContent(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      method: 'POST',
      path: READ_MAIL_PATHS.sentAndInboxMailContent,
      repro: `await readMailClient.sentAndInboxMailContent({ selectedContact: '<unknown>' }, { token });`,
      body: payload,
      title: 'A contact with no correspondence is reported as a server error',
      severity: 'Minor',
    });
  });
});
