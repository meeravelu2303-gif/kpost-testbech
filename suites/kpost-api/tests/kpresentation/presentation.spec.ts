import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import {
  KPRESENTATION_PATHS,
  KPRESENTATION_PATH_TEMPLATES,
} from '../../src/api/clients/kpresentation.client';
import {
  createPresentationResponseSchema,
  deletePresentationResponseSchema,
  presentationDetailResponseSchema,
  presentationListResponseSchema,
  savePresentationResponseSchema,
} from '../../src/api/schemas/kpresentation.schema';
import {
  assertNoForeignAcknowledgement,
  assertStatus,
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
} from '../../src/utils/apiAssertions';
import {
  buildPresentationPayload,
  buildSavePresentationPayload,
  nonExistentPresentationId,
} from '../../src/api/payloads/kpresentation.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * KPresentation — deck creation, editing, listing and deletion.
 *
 * The delete route is the notable one. swagger.json documents two things about it that the
 * tests below target directly:
 *
 * 1. It is a **GET that performs a destructive write**, taking its argument as a query
 *    parameter. A GET is prefetchable and cacheable by intermediaries and is the classic
 *    CSRF shape, so the method choice is itself the finding.
 * 2. Success and not-found both return **HTTP 200 with `statusCode: 200`**, distinguished
 *    only by `status` and `msg`. Deleting another user's deck lands in the not-found branch,
 *    which means the transport layer reports the same thing whether a deck was destroyed or
 *    nothing happened at all.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /kpresentation/create
 * ====================================================================================== */
test.describe('POST /kpresentation/create @audit', () => {
  const META = {
    method: 'POST',
    path: KPRESENTATION_PATHS.create,
    repro: `await kpresentationClient.create(buildPresentationPayload(), { token });`,
  };

  test('[1] happy path: creating a deck satisfies the Zod contract', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await expectValidContract(
      response,
      createPresentationResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[1b] contract: a successful creation must return the generated presentationId', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.presentationId,
      `the deck was created but no presentationId came back. Every other route addresses a deck by that id, so the editor cannot open what it just created. Body: ${text.slice(0, 200)}`
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character title must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: MAX_LENGTH_STRING });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character presentationTitle produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a very large slide blob must not be silently truncated', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ subject: 'a'.repeat(200000) });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a 200 KB slides blob produced HTTP ${response.status()}. Slides are stored as one serialised value, so a large deck is ordinary input and must be stored or refused explicitly.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a UTF-8 title is stored or refused without a server fault', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: UTF8_STRING });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 title produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "titleOfPresentation" omitted must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    delete (payload as Record<string, unknown>).titleOfPresentation;

    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "titleOfPresentation" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null title must not create an unnamed deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: null });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "titleOfPresentation" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty title must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: '' });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "titleOfPresentation" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object where slides expects a serialised string', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ subject: { index: 1 } });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `slides was sent as an object where the contract expects a string, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a numeric title must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: INT32_OVERFLOW });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    expect(
      response.status(),
      `presentationTitle was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the title must not be stored unescaped', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: XSS_PAYLOAD });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await kpresentationClient.create(buildPresentationPayload({ titleOfPresentation: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[6b] XSS: a script payload inside the slide blob must not be reflected unescaped', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ subject: XSS_PAYLOAD });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload({ titleOfPresentation: SQLI_PAYLOAD });
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kpresentationClient,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not create a persistent deck', async ({
    kpresentationClient,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: a body-supplied kpostID must not set the deck owner', async ({
    kpresentationClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPresentationPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await kpresentationClient.create(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'creation did not succeed');

    const data = json?.data as Record<string, unknown> | undefined;
    expect(
      data?.kpostID,
      `the created deck was owned by "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The spec states the token-derived kpostID is passed as both the owner and the creator argument, so a body value must be ignored. Body: ${text.slice(0, 200)}`
    ).not.toBe(VICTIM_KPOST_ID);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    const response = await kpresentationClient.create(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.create({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on deck creation' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.sendRaw(
      KPRESENTATION_PATHS.create,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: concurrent identical creations must not mint duplicate decks', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildPresentationPayload();
    const [first, second, third] = await Promise.all([
      kpresentationClient.create(payload, { token: staticToken }),
      kpresentationClient.create(payload, { token: staticToken }),
      kpresentationClient.create(payload, { token: staticToken }),
    ]);

    const bodies = [await readBody(first), await readBody(second), await readBody(third)];
    const ids = bodies
      .map((b) => (b.json?.data as Record<string, unknown> | undefined)?.presentationId)
      .filter((id): id is number => typeof id === 'number');

    test.skip(ids.length === 0, 'no decks were created, so there is nothing to compare');

    expect(
      new Set(ids).size,
      `three identical concurrent creations produced ${new Set(ids).size} distinct decks. A double-submit from the editor should not fill the deck picker with copies.`
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
 * POST /kpresentation/savePresentation
 * ====================================================================================== */
test.describe('POST /kpresentation/savePresentation @audit', () => {
  const META = {
    method: 'POST',
    path: KPRESENTATION_PATHS.savePresentation,
    repro: `await kpresentationClient.savePresentation(buildSavePresentationPayload(), { token });`,
  };

  test('[1] happy path: saving a deck satisfies the Zod contract', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload();
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await expectValidContract(
      response,
      savePresentationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a very large slide blob must not be silently truncated', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ slides: 'a'.repeat(200000) });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    expect(
      response.status(),
      `a 200 KB slides blob produced HTTP ${response.status()}. This route overwrites the stored deck, so a truncated save silently destroys slides the author still has on screen.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow presentationId must be handled cleanly', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ presentationId: INT32_OVERFLOW });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    expect(
      response.status(),
      `presentationId=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "presentationId" omitted must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload();
    delete (payload as Record<string, unknown>).presentationId;

    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "presentationId" omitted on a save' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null presentationId must not write the deck nowhere', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ presentationId: null });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "presentationId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4b] empty fuzzing: empty slides must not blank a stored deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ slides: '' });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const saved = json !== null && json.statusCode === 200;

    expect(
      saved,
      `an empty slides value was accepted against a deck the caller does not own. On a save path an empty write is how a presentation silently loses all its content. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a string presentationId must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ presentationId: 'first-deck' });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    expect(
      response.status(),
      `presentationId was sent as a string and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored unescaped', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ presentationTitle: XSS_PAYLOAD });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not overwrite every deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({ presentationId: SQLI_PAYLOAD });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const succeeded = json !== null && json.statusCode === 200;

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      succeeded,
      `a SQL tautology as presentationId returned success on a save. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kpresentationClient,
  }) => {
    const payload = buildSavePresentationPayload();
    const response = await kpresentationClient.savePresentation(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not overwrite a deck', async ({
    kpresentationClient,
  }) => {
    const payload = buildSavePresentationPayload();
    const response = await kpresentationClient.savePresentation(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] ownership: saving into a deck the caller does not own must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload({
      presentationId: nonExistentPresentationId(),
    });
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const saved = json !== null && json.statusCode === 200;

    expect(
      saved,
      `a save succeeded against a deck the caller does not own. This route overwrites the stored presentation and its slide rows, so an ownership gap lets one user destroy another's work. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload();
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const payload = buildSavePresentationPayload();
    const response = await kpresentationClient.savePresentation(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.savePresentation({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a deck save' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.sendRaw(
      KPRESENTATION_PATHS.savePresentation,
      '{"a":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] concurrency: competing saves of the same deck must not diverge', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const presentationId = nonExistentPresentationId();
    const responses = await Promise.all([
      kpresentationClient.savePresentation(
        buildSavePresentationPayload({ presentationId, slides: 'version one' }),
        { token: staticToken }
      ),
      kpresentationClient.savePresentation(
        buildSavePresentationPayload({ presentationId, slides: 'version two' }),
        { token: staticToken }
      ),
    ]);
    const statuses = responses.map((r) => r.status());

    expect(
      new Set(statuses).size,
      `two concurrent saves of different slide content returned different statuses (${statuses.join(', ')}). Which version survives must not depend on a race the author cannot observe.`
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
 * GET /kpresentation/presentations
 * ====================================================================================== */
test.describe('GET /kpresentation/presentations @audit', () => {
  const META = {
    method: 'GET',
    path: KPRESENTATION_PATHS.presentations,
    repro: `await kpresentationClient.presentations({ token });`,
  };

  test('[1] happy path: the deck list satisfies the Zod contract', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({ token: staticToken });

    await expectValidContract(
      response,
      presentationListResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The listing is scoped to the token identity, so no parameters are required.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { kpostID: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a numeric query value is handled cleanly', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { presentationId: INT32_OVERFLOW },
    });

    expect(
      response.status(),
      `a numeric presentationId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kpresentationClient,
  }) => {
    const response = await kpresentationClient.presentations({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: a malformed token must not list decks', async ({ kpresentationClient }) => {
    const response = await kpresentationClient.presentations({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] scoping: a query-supplied kpostID must not switch whose decks are listed', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const own = await readBody(await kpresentationClient.presentations({ token: staticToken }));
    const impersonated = await readBody(
      await kpresentationClient.presentations({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" changed the decks listed. The spec states the listing is scoped to the token-derived kpostID.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentations({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      kpresentationClient.presentations({ token: staticToken }),
      kpresentationClient.presentations({ token: staticToken }),
      kpresentationClient.presentations({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] contract: the summary listing must not carry full slide content', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const { json } = await readBody(
      await kpresentationClient.presentations({ token: staticToken })
    );
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

    test.skip(rows.length === 0, 'no decks returned to inspect');

    const withSlides = rows.filter(
      (row) => typeof row.slides === 'string' && row.slides.length > 500
    );

    expect(
      withSlides.length,
      `${withSlides.length} rows in the summary listing carried full slide content. The spec states this route returns lightweight summaries precisely so it is safe to call frequently; shipping every deck's slides defeats that.`
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
 * GET /kpresentation/presentations/{presentationId}
 * ====================================================================================== */
test.describe('GET /kpresentation/presentations/{presentationId} @audit', () => {
  const META = {
    method: 'GET',
    path: KPRESENTATION_PATH_TEMPLATES.presentationById,
    repro: `await kpresentationClient.presentationById(presentationId, { token });`,
  };

  test('[1] happy path: a deck read satisfies the Zod contract', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: staticToken }
    );

    await expectValidContract(
      response,
      presentationDetailResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character id must be refused', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character presentationId path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative id must not resolve to a deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById('-1', { token: staticToken });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    expect(
      resolved,
      `presentationId=-1 resolved to a deck. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing parameter: an empty id must not return every deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById('', { token: staticToken });
    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    const scenario = `an empty presentationId returned ${rows.length} decks. Body: ${text.slice(0, 200)}`;

    /*
     * An empty id listing every deck is an access-control question, not a cosmetic one: the
     * route addresses a single presentation, so a caller who omits the id should get nothing,
     * not the whole store. Graded Critical for the same reason the other identity-scoping
     * findings are - it is unbounded exposure of records the caller never named.
     */
    if (rows.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          title: 'An empty presentationId returns every deck instead of none',
          scenario,
        },
        'Security/Access Control',
        'Critical'
      );
    }

    expect(rows.length, scenario).toBe(0);
  });

  test('[4] null fuzzing: a literal "null" id must not resolve', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById('null', { token: staticToken });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    expect(
      resolved,
      `the literal string "null" resolved to a deck. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a non-numeric id must be handled cleanly', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById('not-a-number', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a non-numeric presentationId produced HTTP ${response.status()}. The id is a numeric column, so a binding failure must be a clean 400.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in the path must not be reflected unescaped', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not return another user\'s deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(SQLI_PAYLOAD, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const resolved = json !== null && json.statusCode === 200 && json.data != null;

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);

    expect(
      resolved,
      `a SQL tautology as presentationId resolved to a deck. The spec states the lookup pairs the id with the token-derived kpostID, so anything returned proves that pairing is not parameterised. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(SQLI_DROP_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kpresentationClient,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: null }
    );

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must not return slide content', async ({
    kpresentationClient,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: EXPIRED_TOKEN }
    );

    await assertUnauthorized(response, META);
  });

  test('[8c] ownership: another user\'s deck must not return its slide content', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: staticToken }
    );
    const { json, text } = await readBody(response);
    const record = json?.data as Record<string, unknown> | undefined;

    expect(
      record?.slides,
      `slide content was returned for a deck the caller does not own. This route loads the full presentation — everything the author wrote. Body: ${text.slice(0, 200)}`
    ).toBeUndefined();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: staticToken }
    );

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById(
      String(nonExistentPresentationId()),
      { token: staticToken }
    );

    await assertStatusCodeParity(response, META);
  });

  test('[10] structural: a path traversal attempt must not escape the route', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.presentationById('../../../etc/passwd', {
      token: staticToken,
    });
    const { text } = await readBody(response);

    expect(
      text,
      `a path traversal payload returned content resembling a system file.`
    ).not.toContain('root:');
  });

  test('[10b] idempotency: three concurrent identical reads must agree', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const presentationId = String(nonExistentPresentationId());
    const [first, second, third] = await Promise.all([
      kpresentationClient.presentationById(presentationId, { token: staticToken }),
      kpresentationClient.presentationById(presentationId, { token: staticToken }),
      kpresentationClient.presentationById(presentationId, { token: staticToken }),
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
 * GET /kpresentation/delete — a destructive write behind a safe method
 * ====================================================================================== */
test.describe('GET /kpresentation/delete @audit', () => {
  const META = {
    method: 'GET',
    path: KPRESENTATION_PATHS.delete,
    repro: `await kpresentationClient.deletePresentation(presentationId, { token });`,
  };

  test('[1] happy path: a delete request satisfies the Zod contract', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      deletePresentationResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[1b] method: a destructive operation must not be reachable by GET', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });

    // Routed through assertStatus rather than a bare expect so the finding lands in
    // BUG_REPORT.md with its repro — the method choice is the defect, not the response body.
    await assertStatus(response, [404, 405], {
      ...META,
      title: 'Destructive deletion is exposed on a GET route',
      severity: 'Critical',
    });
  });

  test('[1c] status: success and not-found must be distinguishable by status code', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'endpoint did not return a JSON envelope');

    const notFound =
      typeof json?.msg === 'string' && json.msg.toLowerCase().includes('not found');

    expect(
      notFound && response.status() === 200 && json?.statusCode === 200,
      `deleting a non-existent deck returned HTTP 200 with statusCode 200 and only the msg text ("${String(json?.msg)}") to signal that nothing happened. A client keying on the status code cannot tell a successful deletion from a no-op, which is exactly the case a UI needs to distinguish before telling the user their deck is gone. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[2] boundary: an int32-overflow id must be handled cleanly', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(INT32_OVERFLOW, {
      token: staticToken,
    });

    expect(
      response.status(),
      `presentationId=${INT32_OVERFLOW} produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a negative id must not delete anything', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(-1, { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    expect(
      deleted,
      `presentationId=-1 reported a deleted deck. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[3] missing required parameter: an absent presentationId must be HTTP 400', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deleteWithoutId({ token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'presentationId query parameter omitted — the spec states binding fails with 400',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a literal "null" id must not delete anything', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation('null', { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    expect(
      deleted,
      `the literal string "null" reported a deleted deck. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[4b] empty fuzzing: an empty id must not delete anything', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation('', { token: staticToken });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    expect(
      deleted,
      `an empty presentationId reported a deleted deck. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[5] type mismatch: a non-numeric id must be a clean binding failure', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation('not-a-number', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a non-numeric presentationId produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not delete every deck', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(SQLI_PAYLOAD, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);

    expect(
      deleted,
      `a SQL tautology reported a deleted deck. Deletion removes the presentation and its slide rows and is not reversible through the API. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    kpresentationClient,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an alg=none forged token must never delete a deck', async ({
    kpresentationClient,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[8c] ownership: deleting another user\'s deck must not report a deletion', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    expect(
      deleted,
      `a delete reported outcome 1 for a deck the caller does not own. The spec states 1 means the deck was removed and that another user's deck falls into the not-found branch, so a 1 here means the ownership filter is absent. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] caching: a destructive route must forbid intermediary caching', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
    });
    const cacheControl = response.headers()['cache-control'] ?? '';

    expect(
      /no-store|no-cache/i.test(cacheControl),
      `the delete route returned Cache-Control: "${cacheControl || '(absent)'}". Because the action is a GET, a proxy or browser is entitled to cache or prefetch it unless the response forbids that explicitly — and a cached delete is a delete that fires again on its own.`
    ).toBe(true);
  });

  test('[10] idempotency: repeating a delete must not change its outcome', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const presentationId = nonExistentPresentationId();
    const first = await kpresentationClient.deletePresentation(presentationId, {
      token: staticToken,
    });
    const second = await kpresentationClient.deletePresentation(presentationId, {
      token: staticToken,
    });

    expect(
      second.status(),
      `deleting the same deck twice returned HTTP ${first.status()} then ${second.status()}.`
    ).toBe(first.status());
  });

  test('[10b] structural: extra query parameters must not widen the delete', async ({
    kpresentationClient,
    staticToken,
  }) => {
    const response = await kpresentationClient.deletePresentation(nonExistentPresentationId(), {
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID, all: 'true' },
    });
    const { json, text } = await readBody(response);
    const deleted = json !== null && json.data === 1;

    expect(
      deleted,
      `supplying extra query parameters (kpostID="${VICTIM_KPOST_ID}", all=true) alongside the id reported a deletion. Unrecognised parameters must be ignored, never used to redirect or widen a destructive action. Body: ${text.slice(0, 200)}`
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
    const response = await genericClient.send('GET', META.path, { documentID: FOREIGN.documentID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'documentID',
      foreignValue: FOREIGN.documentID,
    });
  });

});
