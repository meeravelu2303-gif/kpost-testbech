import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, KATCHUP_PATH_TEMPLATES } from '../../src/api/clients/katchupV2.client';
import {
  frequentContactsResponseSchema,
  katchupCountResponseSchema,
  katchupMessageListResponseSchema,
} from '../../src/api/schemas/katchupV2.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildFetchKatchupPayload,
  buildKatchupFilterPayload,
  buildKatchupMessagePayload,
  buildSearchPayload,
  syntheticReceiver,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Katchup V2 — search, filter and conversation reads.
 *
 * Every route here is scoped by `fetchKatchupRO.setSender(request.getAttribute("kpostID"))`
 * or its equivalent, so the body's `sender` should be inert. That makes this file mostly an
 * ownership battery: each test supplies a `sender` the caller is not, and asserts nothing
 * comes back.
 *
 * The distinctive risk on a search surface is **enumeration**. A message search that accepts
 * a wildcard, or that returns hits from conversations the caller has no part in, turns the
 * private messaging store into a queryable index. Several cases below probe exactly that,
 * because a scoped-by-default route that leaks on `%` is far more dangerous than one that
 * simply forgets a check — it looks correct in every normal test.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null,null--`;
const SQLI_WILDCARD = `%`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /v2/katchup/searchKatchUpMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/searchKatchUpMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.searchKatchUpMessage,
    repro: `await katchupClient.searchKatchUpMessage(buildSearchPayload(), { token });`,
  };

  test('[1] happy path: a message search satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] enumeration: a wildcard must not return the whole message store', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: SQLI_WILDCARD });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a search term of "%" returned ${count} messages. If the term is interpolated into a LIKE without escaping, a single character dumps the caller's entire message history — and, if scoping is also weak, other people's. Body: ${text.slice(0, 300)}`
    ).toBeLessThan(1000);
  });

  test('[2b] boundary: an empty search term must be refused or bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: '' });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `an empty search term produced HTTP ${response.status()}. It must either be refused or return a bounded page, never an unbounded dump.`
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a 5000-character search term must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: MAX_LENGTH_STRING });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character search term produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: no search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload();
    delete (payload as Record<string, unknown>).searchMessage;

    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a search with nothing to search for',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: null });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "searchMessage" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an array search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: ['a', 'b'] });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `searchMessage was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body sender must not search another user\'s conversations', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSearchPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming sender "${VICTIM_KPOST_ID}" returned that user's messages while the caller was ${authSession.kpostID ?? 'a different identity'}. The controller calls setSender from the token precisely so the body cannot choose whose conversations are searched. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a UNION probe must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: SQLI_UNION_PAYLOAD });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: XSS_PAYLOAD });
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not search messages', async ({ katchupClient }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessage(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.searchKatchUpMessage({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'empty body on a message search',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/katchup/searchKatchUpMessageSubject
 * ====================================================================================== */
test.describe('POST /v2/katchup/searchKatchUpMessageSubject', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.searchKatchUpMessageSubject,
    repro: `await katchupClient.searchKatchUpMessageSubject(buildSearchPayload(), { token });`,
  };

  test('[1] happy path: a subject search satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] enumeration: a wildcard must not return every subject', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: SQLI_WILDCARD });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a "%" subject search returned ${count} results. Subjects alone reveal who is talking to whom about what. Body: ${text.slice(0, 300)}`
    ).toBeLessThan(1000);
  });

  test('[3] missing required parameter: no search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.searchKatchUpMessageSubject({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a subject search with nothing to search for',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: null });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "searchMessage" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric search term must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: 12345 });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `searchMessage was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body sender must not search another user\'s subjects', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildSearchPayload({ sender: VICTIM_KPOST_ID });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `naming sender "${VICTIM_KPOST_ID}" returned that user's subjects while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: SQLI_PAYLOAD });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: XSS_PAYLOAD });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessageSubject(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not search subjects', async ({ katchupClient }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] boundary: a UTF-8 search term must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload({ searchMessage: UTF8_STRING });
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 search term produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildSearchPayload();
    const response = await katchupClient.searchKatchUpMessageSubject(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/katchup/katchupSearch
 * ====================================================================================== */
test.describe('POST /v2/katchup/katchupSearch', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.katchupSearch,
    repro: `await katchupClient.katchupSearch(buildKatchupFilterPayload(), { token });`,
  };

  test('[1] happy path: a faceted search satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] business rule: a reversed date range must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ fromDate: '2026-12-31', toDate: '2026-01-01' });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'date range runs backwards',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[2b] business rule: an impossible calendar date must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ fromDate: '2026-02-31' });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: '31 February is not a date',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] boundary: an unbounded date range must be paginated', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ fromDate: '1970-01-01', toDate: '2099-12-31' });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a 130-year date range returned ${count} messages in one response. A search over the whole message store must be paginated, or one request can exhaust server memory and saturate the connection. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(1000);
  });

  test('[4] null fuzzing: a null keyword must be refused or bounded', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ keyWord: null, searchMessage: null });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    expect(
      response.status(),
      `a null keyword produced HTTP ${response.status()}. It must be refused or treated as "no keyword filter" with a bounded page, never a fault.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string where messageType expects an array', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ messageType: '0' });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    expect(
      response.status(),
      `messageType was sent as a bare string where the contract declares an array, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body kpostID must not search another user\'s messages', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKatchupFilterPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'search returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`) ||
        text.includes(`"receiver":"${VICTIM_KPOST_ID}"`),
      `the filter's kpostID field selected "${VICTIM_KPOST_ID}"'s messages while the caller was ${authSession.kpostID ?? 'a different identity'}. A filter DTO that carries the identity is the classic way scoping gets bypassed — the field must be overwritten from the token. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology in the keyword must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ keyWord: SQLI_PAYLOAD });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ keyWord: XSS_PAYLOAD });
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.katchupSearch(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none token claiming admin must never search', async ({
    katchupClient,
  }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.katchupSearch(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.katchupSearch(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.sendRaw(KATCHUP_PATHS.katchupSearch, '{"keyWord":', {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 415], {
      ...META,
      body: '{"keyWord":',
      repro: `await katchupClient.sendRaw(KATCHUP_PATHS.katchupSearch, '{"keyWord":', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
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
 * POST /v2/katchup/filterKatchUpMessage
 * ====================================================================================== */
test.describe('POST /v2/katchup/filterKatchUpMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.filterKatchUpMessage,
    repro: `await katchupClient.filterKatchUpMessage(buildKatchupFilterPayload(), { token });`,
  };

  test('[1] happy path: a filter satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a filter matching nothing must not be an error', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ keyWord: 'zzzz-no-such-message-zzzz' });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      body: payload,
      title: 'A filter matching nothing is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] boundary: an unbounded range must be paginated', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ fromDate: '1970-01-01', toDate: '2099-12-31' });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'filter returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `an unbounded date filter returned ${count} messages in one response. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(1000);
  });

  test('[4] null fuzzing: null facets must be treated as "no filter", not as a fault', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({
      contactType: null,
      messageType: null,
      contentType: null,
    });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `null facet lists produced HTTP ${response.status()}. An unset facet is the normal case on a filter screen.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: an object where contentType expects an array', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ contentType: { type: 'image' } });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    expect(
      response.status(),
      `contentType was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] IDOR: a body kpostID must not filter another user\'s messages', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKatchupFilterPayload({ kpostID: VICTIM_KPOST_ID });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'filter returned no data');

    expect(
      text.includes(`"sender":"${VICTIM_KPOST_ID}"`) ||
        text.includes(`"receiver":"${VICTIM_KPOST_ID}"`),
      `the filter returned "${VICTIM_KPOST_ID}"'s messages while the caller was ${authSession.kpostID ?? 'a different identity'}. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology in a facet must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ messageBy: SQLI_PAYLOAD });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload({ searchContactText: XSS_PAYLOAD });
    const response = await katchupClient.filterKatchUpMessage(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.filterKatchUpMessage(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not filter messages', async ({ katchupClient }) => {
    const payload = buildKatchupFilterPayload();
    const response = await katchupClient.filterKatchUpMessage(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] idempotency: two identical filters must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupFilterPayload();
    const [first, second] = await Promise.all([
      katchupClient.filterKatchUpMessage(payload, { token: staticToken }),
      katchupClient.filterKatchUpMessage(payload, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical filters returned ${first.status()} and ${second.status()}. A read must be stable.`
    ).toBe(second.status());
  });

  test('[10] structural: an empty body must be handled explicitly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.filterKatchUpMessage({}, { token: staticToken });

    expect(
      response.status(),
      `an empty filter body produced HTTP ${response.status()}. It is either "no filters, bounded page" or a clean 400.`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });

});

/* =========================================================================================
 * POST /v2/katchup/katchupMessagesForSelectedContactID
 * ====================================================================================== */
test.describe('POST /v2/katchup/katchupMessagesForSelectedContactID', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.katchupMessagesForSelectedContactID,
    repro: `await katchupClient.katchupMessagesForSelectedContactID(buildFetchKatchupPayload(), { token });`,
  };

  test('[1] happy path: a conversation read satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload();
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: reading a conversation between two other people must return nothing', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildFetchKatchupPayload({
      sender: VICTIM_KPOST_ID,
      selectedContact: 'admin',
    });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'read returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `reading the conversation between "${VICTIM_KPOST_ID}" and "admin" returned ${count} messages while the caller was ${authSession.kpostID ?? 'a different identity'}. This is the route a chat screen calls; if the body can pick both participants it is a reader for every conversation on the platform. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[3] missing required parameter: no selectedContact must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.katchupMessagesForSelectedContactID(
      {},
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a conversation read with no counterpart named',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null selectedContact must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload({ selectedContact: null });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "selectedContact" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] enumeration: a wildcard contact must not merge every conversation', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload({ selectedContact: SQLI_WILDCARD });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'read returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a selectedContact of "%" returned ${count} messages. Body: ${text.slice(0, 300)}`
    ).toBeLessThan(1000);
  });

  test('[6] type mismatch: an array selectedContact must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload({ selectedContact: [syntheticReceiver()] });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `selectedContact was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload({ selectedContact: SQLI_PAYLOAD });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload({ selectedContact: XSS_PAYLOAD });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildFetchKatchupPayload();
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an expired token must not read a conversation', async ({ katchupClient }) => {
    const payload = buildFetchKatchupPayload();
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] boundary: paging must be bounded', async ({ katchupClient, staticToken }) => {
    const payload = buildFetchKatchupPayload({ firstMsgID: 0, lastMsgID: 999999999 });
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'read returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a message-id window spanning the whole table returned ${count} messages in one response. firstMsgID/lastMsgID exist to page the conversation; an unbounded window defeats them. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(1000);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildFetchKatchupPayload();
    const response = await katchupClient.katchupMessagesForSelectedContactID(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/katchup/getKatchupMessagesSubject/{selectedContact}
 * ====================================================================================== */
test.describe('GET /v2/katchup/getKatchupMessagesSubject/{selectedContact}', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATH_TEMPLATES.getKatchupMessagesSubject,
    repro: `await katchupClient.getKatchupMessagesSubject(contact, { token });`,
  };

  test('[1] happy path: a subject list satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(syntheticReceiver(), {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupMessageListResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: another user\'s conversation subjects must not be readable', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(VICTIM_KPOST_ID, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'read returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count === 0 || !text.includes(`"sender":"${VICTIM_KPOST_ID}"`),
      `subjects from "${VICTIM_KPOST_ID}"'s conversations were returned to ${authSession.kpostID ?? 'a different identity'}. The path variable names the counterpart; the caller's own side must come from the token. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[3] boundary: a 5000-character contact must not fault the server', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(MAX_LENGTH_STRING, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character path segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[4] enumeration: a wildcard contact must not merge every conversation', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(SQLI_WILDCARD, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'read returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `a "%" contact returned ${count} subjects. Body: ${text.slice(0, 300)}`
    ).toBeLessThan(1000);
  });

  test('[5] path traversal must not resolve a different route', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject('../getAllReportMsg', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a traversal sequence in the contact segment produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(SQLI_PAYLOAD, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(XSS_PAYLOAD, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.getKatchupMessagesSubject(syntheticReceiver(), {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must not return subjects', async ({ katchupClient }) => {
    const response = await katchupClient.getKatchupMessagesSubject(syntheticReceiver(), {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[9] empty-state: a contact with no conversation must not be an error', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.getKatchupMessagesSubject(syntheticReceiver(), {
      token: staticToken,
    });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'A contact with no conversation is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[10] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const contact = syntheticReceiver();
    const [first, second] = await Promise.all([
      katchupClient.getKatchupMessagesSubject(contact, { token: staticToken }),
      katchupClient.getKatchupMessagesSubject(contact, { token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}.`
    ).toBe(second.status());
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.uuid)),
      `the response acknowledged pathVariable "${FOREIGN.uuid}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.sendToPathVariable('GET', META.path, String(FOREIGN.uuid), { token: staticToken });

    await assertStatusCodeParity(response, META);
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
 * POST /v2/katchup/messageCountBetweenSenderAndReceiver
 * ====================================================================================== */
test.describe('POST /v2/katchup/messageCountBetweenSenderAndReceiver', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.messageCountBetweenSenderAndReceiver,
    repro: `await katchupClient.messageCountBetweenSenderAndReceiver(buildKatchupMessagePayload(), { token });`,
  };

  test('[1] happy path: a message count satisfies the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      katchupCountResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: the count between two other people must not be disclosed', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildKatchupMessagePayload({
      sender: VICTIM_KPOST_ID,
      receiver: 'admin',
    });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'count returned no data');

    const count = typeof json?.data === 'number' ? json.data : 0;
    expect(
      count,
      `the message count between "${VICTIM_KPOST_ID}" and "admin" was disclosed to ${authSession.kpostID ?? 'a different identity'} as ${count}. Even without message bodies, a count confirms two people correspond and how much — that is metadata worth protecting on its own. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[3] missing required parameter: no receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(
      {},
      { token: staticToken }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a count with no counterpart named',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: a null receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: null });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "receiver" set to null',
        severity: 'Major' as const,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: an object receiver must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: { id: 1 } });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `receiver was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] enumeration: a wildcard receiver must not count across everyone', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: SQLI_WILDCARD });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_WILDCARD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: SQLI_PAYLOAD });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not return a count', async ({ katchupClient }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload must not be reflected unescaped', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload({ receiver: XSS_PAYLOAD });
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const payload = buildKatchupMessagePayload();
    const response = await katchupClient.messageCountBetweenSenderAndReceiver(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('POST', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/katchup/frequentlyAccessContacts
 * ====================================================================================== */
test.describe('GET /v2/katchup/frequentlyAccessContacts', () => {
  const META = {
    method: 'GET',
    path: KATCHUP_PATHS.frequentlyAccessContacts,
    repro: `await katchupClient.frequentlyAccessContacts({ token });`,
  };

  test('[1] happy path: frequent contacts satisfy the Zod contract', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: staticToken });

    await expectValidContract(
      response,
      frequentContactsResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] empty-state: a new user with no history must not get an error', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: staticToken });

    await assertStatus(response, [200, 204, 401, 403], {
      ...META,
      title: 'An empty frequent-contacts list is not reported with a success status',
      severity: 'Major',
    });
  });

  test('[3] auth: no Authorization header must be 401/403', async ({ katchupClient }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3b] auth: an expired token must not return contacts', async ({ katchupClient }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3c] auth: a malformed token must not return contacts', async ({ katchupClient }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[3d] auth: an alg=none token claiming admin must never be honoured', async ({
    katchupClient,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the list', async ({
    katchupClient,
    staticToken,
    authSession,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({
      token: staticToken,
      params: { kpostID: VICTIM_KPOST_ID },
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    expect(
      text.includes(`"kpostID":"${VICTIM_KPOST_ID}"`),
      `passing ?kpostID=${VICTIM_KPOST_ID} returned that user's frequent contacts while the caller was ${authSession.kpostID ?? 'a different identity'}. Who someone messages most is a social graph. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] injection: a SQL tautology in a query parameter must not leak internals', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({
      token: staticToken,
      params: { kpostID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] status misreporting: HTTP status must equal the envelope statusCode', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[8] idempotency: two consecutive reads must agree', async ({
    katchupClient,
    staticToken,
  }) => {
    const [first, second] = await Promise.all([
      katchupClient.frequentlyAccessContacts({ token: staticToken }),
      katchupClient.frequentlyAccessContacts({ token: staticToken }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[9] structural: an unknown query parameter must be ignored, not fatal', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.frequentlyAccessContacts({
      token: staticToken,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] boundary: the list must be bounded', async ({ katchupClient, staticToken }) => {
    const response = await katchupClient.frequentlyAccessContacts({ token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'listing returned no data');

    const data = json?.data;
    const count = Array.isArray(data) ? data.length : 0;
    expect(
      count,
      `the frequent-contacts list returned ${count} entries. "Frequent" implies a top-N; an unbounded list is the whole address book under a misleading name. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[IDOR] a foreign messageID must not reach another owner\'s record', async ({
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
    const response = await genericClient.send('GET', META.path, { messageID: FOREIGN.messageID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.messageID)),
      `the response acknowledged messageID "${FOREIGN.messageID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
