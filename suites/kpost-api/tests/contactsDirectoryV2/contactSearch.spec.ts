import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { CONTACTS_V2_PATHS } from '../../src/api/clients/contactsDirectoryV2.client';
import {
  globalSearchResponseSchema,
  searchDetailsResponseSchema,
} from '../../src/api/schemas/contactsDirectoryV2.schema';
import {
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
  buildGlobalSearchPayload,
  buildSearchDetailsPayload,
} from '../../src/api/payloads/contactsDirectoryV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Contacts Directory V2 — the two search routes.
 *
 * These are the widest-reach reads in the controller and the spec singles both out:
 *
 * - `globalSearch` queries **all users**, not just the caller's contacts. The spec lists
 *   four things to verify — private profiles excluded, users who blocked the caller absent,
 *   a result limit enforced, and company scoping respected for enterprise tiers. Each is a
 *   dedicated case below. Its untyped `Map` body means unrecognised criteria are silently
 *   ignored, which *widens* the search rather than erroring — so a typo'd filter name
 *   returns more, not less.
 * - `getSearchDetails` is described as "the one gap in this controller": every other route
 *   takes `HttpServletRequest` and resolves the caller from the token, and this one does
 *   not. With no caller identity reaching the service the results cannot be caller-scoped
 *   unless the payload carries an identifier the service trusts — and if they are
 *   platform-wide, they leak the full range of company and designation values across every
 *   user. Both possibilities are probed.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
/** A directory this size is a bulk export, not a search result. */
const PLAUSIBLE_RESULT_CAP = 500;

/* =========================================================================================
 * POST /v2/contacts/globalSearch
 * ====================================================================================== */
test.describe('POST /v2/contacts/globalSearch', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.globalSearch,
    repro: `await contactsClient.globalSearch(buildGlobalSearchPayload(), { token });`,
  };

  test('[1] happy path: a directory search satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload();
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    await expectValidContract(
      response,
      globalSearchResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an empty search term must not return the entire directory', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: '' });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      hits.length,
      `an empty search term returned ${hits.length} users. The spec requires a result limit precisely so that an empty or single-character term cannot dump the whole user directory; without one this route is a bulk-export endpoint for every registered person on the platform. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[2b] boundary: a single-character term must not return the entire directory', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: 'a' });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      hits.length,
      `a single-character search term returned ${hits.length} users. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[2c] boundary: a 5000-character term must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: MAX_LENGTH_STRING });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character search term produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2d] boundary: a UTF-8 term is handled without a server fault', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: UTF8_STRING });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 search term produced HTTP ${response.status()}. Non-ASCII names are ordinary on this platform, so search must handle them.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: an entirely empty body must not dump the directory', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.globalSearch({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      hits.length,
      `an empty search body returned ${hits.length} users. With no criteria supplied the route must refuse rather than match everything. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[4] null fuzzing: a null criterion must not widen the search', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: null });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      hits.length,
      `a null firstName returned ${hits.length} users. A null criterion must be treated as absent-and-refused, not as "match all". Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[4b] empty fuzzing: an unrecognised criterion key must not silently widen the search', async ({
    contactsClient,
    staticToken,
  }) => {
    const narrow = await readBody(
      await contactsClient.globalSearch(buildGlobalSearchPayload({ search: 'zzqqxx' }), {
        token: staticToken,
      })
    );
    const typo = await readBody(
      await contactsClient.globalSearch({ frstName: 'zzqqxx' }, { token: staticToken })
    );

    const narrowHits = Array.isArray(narrow.json?.data) ? (narrow.json.data as unknown[]).length : 0;
    const typoHits = Array.isArray(typo.json?.data) ? (typo.json.data as unknown[]).length : 0;

    expect(
      typoHits,
      `a misspelled criterion key ("frstName") returned ${typoHits} users against ${narrowHits} for the correct key. The spec notes the untyped Map body means unrecognised criteria are silently ignored, which widens the search — so a client typo quietly turns a targeted lookup into a directory dump.`
    ).toBeLessThanOrEqual(Math.max(narrowHits, PLAUSIBLE_RESULT_CAP - 1));
  });

  test('[5] type mismatch: an array where a search term is expected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: ['a', 'b'] });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    expect(
      response.status(),
      `firstName was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: XSS_PAYLOAD });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await contactsClient.globalSearch(buildGlobalSearchPayload({ search: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology must not return the whole directory', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: SQLI_PAYLOAD });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);

    expect(
      hits.length,
      `a SQL tautology returned ${hits.length} users. On the platform-wide directory read, a payload that widens the result set is the difference between a search and a full user export. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: SQLI_DROP_PAYLOAD });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildGlobalSearchPayload();
    const response = await contactsClient.globalSearch(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await contactsClient.globalSearch(payload, { token: null });`,
    });
  });

  test('[8b] auth: an alg=none forged token must not search the directory', async ({
    contactsClient,
  }) => {
    const payload = buildGlobalSearchPayload();
    const response = await contactsClient.globalSearch(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] privacy: a search hit must not carry contact details of a private profile', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: 'a' });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const hits = Array.isArray(json?.data)
      ? (json.data as Array<Record<string, unknown>>)
      : [];

    test.skip(hits.length === 0, 'no directory hits returned to evaluate');

    const privateHitsWithContactDetails = hits.filter(
      (hit) =>
        Number(hit.privacyStatus) > 0 &&
        (typeof hit.mobileNumber === 'string' || typeof hit.email === 'string')
    );

    expect(
      privateHitsWithContactDetails.length,
      `${privateHitsWithContactDetails.length} search hits marked as privacy-restricted still carried a mobile number or email. The spec requires private profiles to be excluded or reduced; returning their contact details to any authenticated searcher defeats the privacy setting entirely. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[8d] privacy: a directory hit must not expose credential material', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload({ search: 'a' });
    const response = await contactsClient.globalSearch(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      /"(password|kmailPassword|accessCode|aadhaarNumber|panNumber)"\s*:\s*"[^"]{3,}"/i.test(text),
      `a directory search result included credential or government-identifier material. The search view exists to help users find each other by name and company; it must never surface secrets or national identifiers.`
    ).toBe(false);
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload();
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload();
    const response = await contactsClient.globalSearch(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.globalSearch,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] idempotency: three concurrent identical searches must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildGlobalSearchPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.globalSearch(payload, { token: staticToken }),
      contactsClient.globalSearch(payload, { token: staticToken }),
      contactsClient.globalSearch(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent searches returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10c] rate limiting: a burst of directory searches should be throttled', async ({
    contactsClient,
    staticToken,
  }) => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        contactsClient.globalSearch(buildGlobalSearchPayload({ search: `probe${index}` }), {
          token: staticToken,
        })
      )
    );
    const throttled = responses.filter((r) => r.status() === 429).length;

    expect(
      throttled,
      `15 rapid directory searches produced no 429 responses. This route reads across all users, so without throttling it is the cheapest way to enumerate the platform's entire membership one query at a time.`
    ).toBeGreaterThan(0);
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.contactID)),
      `the response acknowledged contactID "${FOREIGN.contactID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * POST /v2/contacts/getSearchDetails
 *
 * The documented gap: no HttpServletRequest reaches the service, so the caller's identity is
 * unavailable and the result set cannot be scoped to them by the framework.
 * ====================================================================================== */
test.describe('POST /v2/contacts/getSearchDetails', () => {
  const META = {
    method: 'POST',
    path: CONTACTS_V2_PATHS.getSearchDetails,
    repro: `await contactsClient.getSearchDetails(buildSearchDetailsPayload(), { token });`,
  };

  test('[1] happy path: a suggestion lookup satisfies the Zod contract', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await expectValidContract(
      response,
      searchDetailsResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: the returned value set must not be an unbounded platform-wide dump', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const values = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      values.length,
      `the suggestion lookup returned ${values.length} distinct values. Because no caller identity reaches this service, a large set implies the values span every user on the platform rather than the caller's own contacts — which is commercially meaningful reconnaissance: the full range of company names and designations across the customer base. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[2b] boundary: a 5000-character criterion must not fault the handler', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ companyName: MAX_LENGTH_STRING });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character criterion produced HTTP ${response.status()}. The spec notes there is no @Valid on this payload, so nothing rejects an oversized value before it reaches the query.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: an empty body must not return every value on the platform', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.getSearchDetails({}, { token: staticToken });
    const { json, text } = await readBody(response);
    const values = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      values.length,
      `an empty body returned ${values.length} distinct values. With no criteria and no caller identity, this is the worst case for the documented gap: an unauthenticated-in-effect enumeration of the platform's company and designation vocabulary. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[4] null fuzzing: a null requestType must not widen the result set', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ requestType: null });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const values = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

    expect(
      values.length,
      `a null requestType returned ${values.length} values. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(PLAUSIBLE_RESULT_CAP);
  });

  test('[4b] empty fuzzing: an empty requestType must be refused', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ requestType: '' });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "requestType" set to an empty string' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: an object where requestType expects a string', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ requestType: { type: 'COMPANY' } });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    expect(
      response.status(),
      `requestType was sent as an object and produced HTTP ${response.status()}. With no @Valid on the payload, only the handler's own guard stands between this and a class-cast failure.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be reflected unescaped', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ companyName: XSS_PAYLOAD });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology must not leak database internals', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ requestType: SQLI_PAYLOAD });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: an injected requestType must not widen the value set', async ({
    contactsClient,
    staticToken,
  }) => {
    const baseline = await readBody(
      await contactsClient.getSearchDetails(buildSearchDetailsPayload(), { token: staticToken })
    );
    const injected = await readBody(
      await contactsClient.getSearchDetails(
        buildSearchDetailsPayload({ requestType: SQLI_PAYLOAD }),
        { token: staticToken }
      )
    );

    const baselineCount = Array.isArray(baseline.json?.data)
      ? (baseline.json.data as unknown[]).length
      : 0;
    const injectedCount = Array.isArray(injected.json?.data)
      ? (injected.json.data as unknown[]).length
      : 0;

    expect(
      injectedCount,
      `a SQL tautology returned ${injectedCount} values against a baseline of ${baselineCount}. A payload that widens the set proves the value reaches the query unparameterised — and this route has no @Valid guard in front of it.`
    ).toBeLessThanOrEqual(baselineCount);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    contactsClient,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ contactsClient }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] the documented gap: a payload-supplied kpostID must not scope the results', async ({
    contactsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await contactsClient.getSearchDetails(buildSearchDetailsPayload(), { token: staticToken })
    );
    const impersonated = await readBody(
      await contactsClient.getSearchDetails(
        buildSearchDetailsPayload({ kpostID: VICTIM_KPOST_ID }),
        { token: staticToken }
      )
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" in the body changed the values returned. This is the specific risk the spec flags: no caller identity reaches this service, so if the payload's kpostID is trusted instead, any user can read the company and designation values drawn from another user's contact list — a direct read of who that person deals with.`
    ).toBe(comparableBody(own.text));
  });

  test('[8d] the documented gap: an expired token must still be refused', async ({
    contactsClient,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      title: 'Suggestion lookup accepts an expired token',
    });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload();
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: a malformed JSON body must be a clean HTTP 400', async ({
    contactsClient,
    staticToken,
  }) => {
    const response = await contactsClient.sendRaw(
      CONTACTS_V2_PATHS.getSearchDetails,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10b] structural: unrecognised keys must be ignored, not reflected', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload({ notARealFilter: 'qa-canary-value' });
    const response = await contactsClient.getSearchDetails(payload, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      text,
      `an unrecognised payload key was echoed back in the response. The spec says unrecognised keys are ignored rather than rejected; ignoring them silently is one thing, reflecting them is another.`
    ).not.toContain('qa-canary-value');
  });

  test('[10c] idempotency: three concurrent identical lookups must agree', async ({
    contactsClient,
    staticToken,
  }) => {
    const payload = buildSearchDetailsPayload();
    const [first, second, third] = await Promise.all([
      contactsClient.getSearchDetails(payload, { token: staticToken }),
      contactsClient.getSearchDetails(payload, { token: staticToken }),
      contactsClient.getSearchDetails(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent lookups returned different statuses (${statuses.join(', ')}).`
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.contactID)),
      `the response acknowledged contactID "${FOREIGN.contactID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
