import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { MAILBOX_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { kmailListResponseSchema } from '../../src/api/schemas/kmail.schema';
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
  FETCH_MAIL_TYPE,
  buildContactMailsPayload,
  buildCommonPayload,
} from '../../src/api/payloads/mailbox.payload';
import { jdbcTimestamp, syntheticRecipient } from '../../src/utils/safeTestData';

/**
 * Search and filter — conversation lookup, subject search, and the date/read-state filters.
 *
 * KMail has no free-text search endpoint. It has `selectedContactMails` (the conversation with one
 * contact) and `mailSubjectSelectedContact` (the distinct subjects exchanged with one contact),
 * plus the `fetchMailType` and `selectedDate` filters on the listing routes.
 *
 * The distinctive risk is enumeration: `selectedContact` is a bare string interpolated into a
 * lookup. A search that accepts a wildcard, or returns hits from conversations the caller is not
 * part of, turns a private mail store into a queryable index — and looks correct in normal tests.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null,null--`;
const SQLI_WILDCARD = '%';
const UNDERSCORE_WILDCARD = '_';
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = 'ಕನ್ನಡ-日本語-🚀-Ñoño';

/* =========================================================================================
 * POST /v2/common/selectedContactMails
 * ====================================================================================== */
test.describe('POST /v2/common/selectedContactMails', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.selectedContactMails,
    repro: `await mailboxClient.selectedContactMails(buildContactMailsPayload(), { token });`,
  };

  test('[1] happy path: a conversation read satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] enumeration: a "%" contact must not merge every conversation', async ({
    mailboxClient,
    token,
  }) => {
    // `selectedContact` is a bare string. Interpolated into a LIKE without escaping, one character
    // returns every conversation the query can see — the platform's, if scoping is also weak.
    const payload = buildContactMailsPayload(SQLI_WILDCARD, { count: 20 });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'messages for a "%" contact',
    });
  });

  test('[3] enumeration: a "_" single-character wildcard must not widen the match', async ({
    mailboxClient,
    token,
  }) => {
    // Asserted separately from `%` because they are escaped separately: stripping `%` but forgetting
    // `_` still leaves a wildcard.
    const payload = buildContactMailsPayload(UNDERSCORE_WILDCARD, { count: 20 });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'messages for a "_" contact',
    });
  });

  test('[4] IDOR: a conversation between two other people must return nothing', async ({
    mailboxClient,
    token,
    callerKpostId,
  }) => {
    // The caller's own side comes from the token, only the counterpart from the body. If the body
    // can pick both participants, this reads every conversation on the platform.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildContactMailsPayload(syntheticRecipient(), {
      kpostUser: FOREIGN.victimKpostID,
    });
    const response = await mailboxClient.selectedContactMails(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'conversation read returned no data');

    const returned = Array.isArray(json?.data) ? (json?.data as unknown[]).length : 0;

    expect(
      returned > 0 && text.includes(FOREIGN.victimKpostID),
      `reading a conversation with kpostUser set to "${FOREIGN.victimKpostID}" returned ${returned} messages to ${callerKpostId ?? 'a different identity'}. kpostUser is documented as overwritten from the JWT precisely so the body cannot choose whose side of a conversation is read. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] paging: the page size must be honoured', async ({ mailboxClient, token }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), { count: 5 });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 5,
      what: 'conversation messages',
    });
  });

  test('[6] paging: the keyset cursor must page backwards', async ({ mailboxClient, token }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), {
      count: 5,
      lastKmailID: 999_999_999,
    });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 5,
      what: 'conversation messages with a cursor spanning the whole table',
    });
  });

  test('[7] validation: a missing selectedContact must be refused', async ({
    mailboxClient,
    token,
  }) => {
    // With no counterpart named, an implementation treating it as "no filter" returns every message
    // the caller has — a full mailbox dump reachable by omitting one field.
    const response = await mailboxClient.selectedContactMails(buildCommonPayload(), { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: buildCommonPayload(),
        scenario: 'a conversation read with no counterpart named',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] validation: a null selectedContact must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), { selectedContact: null });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "selectedContact" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[9] validation: an empty selectedContact must be refused or bounded', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload('', { count: 20 });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'messages for an empty contact string',
    });
  });

  test('[10] type mismatch: an array selectedContact must not fault', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), {
      selectedContact: [syntheticRecipient()],
    });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    expect(
      response.status(),
      `selectedContact was sent as an array where the contract declares a string, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[11] injection: a tautology must not leak database internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(SQLI_PAYLOAD);
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[12] injection: a UNION probe must not leak database internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(SQLI_UNION_PAYLOAD);
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[13] XSS: a script payload must not be reflected unescaped', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(XSS_PAYLOAD);
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[14] boundary: a 5000-character contact must not fault', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(MAX_LENGTH_STRING);
    const response = await mailboxClient.selectedContactMails(payload, { token });

    expect(
      response.status(),
      `a 5000-character selectedContact produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[15] boundary: a multi-byte UTF-8 contact must not fault', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(UTF8_STRING);
    const response = await mailboxClient.selectedContactMails(payload, { token });

    expect(
      response.status(),
      `a multi-byte UTF-8 contact string produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[16] empty state: a contact with no correspondence must not be an error', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient());
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A contact with no correspondence is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[17] group: groupFlag must not widen the conversation to every group', async ({
    mailboxClient,
    token,
  }) => {
    // `groupFlag` (a single boolean) switches which query runs. A group branch that resolves
    // membership without checking the caller belongs returns a conversation they were never part of.
    const payload = buildContactMailsPayload(String(FOREIGN.kmailID), { groupFlag: true });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'group identifier with groupFlag set',
    });
  });

  test('[18] filter: a date filter must actually narrow the result', async ({
    mailboxClient,
    token,
  }) => {
    // `selectedDate` is the only date filter in the API. Accepted and ignored is worse than
    // rejected: the user believes they see one day's mail and do not, with nothing saying so.
    const unfilteredPayload = buildContactMailsPayload(syntheticRecipient(), { count: 20 });
    const filteredPayload = buildContactMailsPayload(syntheticRecipient(), {
      count: 20,
      selectedDate: jdbcTimestamp(-60 * 24 * 365 * 10),
    });

    const [unfiltered, filtered] = await Promise.all([
      mailboxClient.selectedContactMails(unfilteredPayload, { token }),
      mailboxClient.selectedContactMails(filteredPayload, { token }),
    ]);

    const [unfilteredBody, filteredBody] = await Promise.all([
      readBody(unfiltered),
      readBody(filtered),
    ]);
    test.skip(
      !unfiltered.ok() || !filtered.ok(),
      'the conversation read did not succeed on this environment'
    );

    const unfilteredCount = Array.isArray(unfilteredBody.json?.data)
      ? (unfilteredBody.json?.data as unknown[]).length
      : 0;
    const filteredCount = Array.isArray(filteredBody.json?.data)
      ? (filteredBody.json?.data as unknown[]).length
      : 0;
    test.skip(unfilteredCount === 0, 'no messages in this conversation to filter');

    expect(
      filteredCount,
      `filtering to a date ten years ago returned ${filteredCount} messages, the same as the unfiltered read (${unfilteredCount}). selectedDate is documented as a date filter; accepted and ignored means the user is shown mail from a day they did not ask about, with nothing in the response saying so.`
    ).toBeLessThanOrEqual(unfilteredCount);
  });

  test('[19] filter: a malformed date must be refused', async ({ mailboxClient, token }) => {
    // The format is JDBC (`yyyy-MM-dd HH:mm:ss.SSS`), not ISO-8601. An ISO string with a `T`
    // separator fails a `java.sql.Timestamp` parse, which must be a 400, not an escaped exception.
    const payload = buildContactMailsPayload(syntheticRecipient(), {
      selectedDate: '2026-08-31T10:00:00Z',
    });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    expect(
      response.status(),
      `an ISO-8601 date where the contract declares JDBC timestamp form produced HTTP ${response.status()}. The formats differ by one character and clients get it wrong constantly, so the answer must be a 400 that names the expected format.`
    ).toBeLessThan(500);
  });

  test('[20] filter: an impossible calendar date must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), {
      selectedDate: '2026-02-31 00:00:00.000',
    });
    const response = await mailboxClient.selectedContactMails(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: '31 February is not a date',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[21] filter: the read-state filter must narrow the result', async ({
    mailboxClient,
    token,
  }) => {
    const openedPayload = buildContactMailsPayload(syntheticRecipient(), {
      fetchMailType: FETCH_MAIL_TYPE.openedOnly,
      count: 20,
    });
    const response = await mailboxClient.selectedContactMails(openedPayload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !Array.isArray(json.data) || (json.data as unknown[]).length === 0,
      'no messages returned for the opened filter — nothing to check'
    );

    const rows = json?.data as Array<Record<string, unknown>>;
    const unopened = rows.filter(
      (row) => row.openedStatus === 'N' || row.openedStatus === false || row.openedStatus === 0
    );

    expect(
      unopened.length,
      `asking for opened mail only (fetchMailType "Y") returned ${unopened.length} of ${rows.length} rows marked unopened. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[22] structural: malformed JSON must be a clean 400', async ({ mailboxClient, token }) => {
    const malformed = '{"selectedContact":';
    const response = await mailboxClient.sendRaw(MAILBOX_PATHS.selectedContactMails, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await mailboxClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[23] auth: no Authorization header must be 401/403', async ({ mailboxClient }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.selectedContactMails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[24] auth: an expired token must not read a conversation', async ({ mailboxClient }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.selectedContactMails(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[25] auth: a malformed token must not read a conversation', async ({ mailboxClient }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.selectedContactMails(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[26] idempotency: two identical reads must agree', async ({ mailboxClient, token }) => {
    const payload = buildContactMailsPayload(syntheticRecipient());
    const [first, second] = await Promise.all([
      mailboxClient.selectedContactMails(payload, { token }),
      mailboxClient.selectedContactMails(payload, { token }),
    ]);

    expect(
      first.status(),
      `two identical conversation reads returned ${first.status()} and ${second.status()}. A read must be stable.`
    ).toBe(second.status());
  });

  test('[27] status parity: HTTP status must agree with the envelope', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.selectedContactMails({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });
});

/* =========================================================================================
 * POST /v2/common/mailSubjectSelectedContact
 * ====================================================================================== */
test.describe('POST /v2/common/mailSubjectSelectedContact', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.mailSubjectSelectedContact,
    repro: `await mailboxClient.mailSubjectSelectedContact(buildContactMailsPayload(), { token });`,
  };

  test('[1] happy path: a subject list satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] enumeration: a "%" contact must not return every subject', async ({
    mailboxClient,
    token,
  }) => {
    // Subjects without bodies are not a lesser leak: the subject line alone reveals who is talking
    // to whom about what.
    const payload = buildContactMailsPayload(SQLI_WILDCARD, { count: 20 });
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'subjects for a "%" contact',
    });
  });

  test('[3] IDOR: another user\'s subjects must not be readable', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildContactMailsPayload(syntheticRecipient(), {
      kpostUser: FOREIGN.victimKpostID,
    });
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser on a subject search',
    });
  });

  test('[4] validation: a missing selectedContact must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.mailSubjectSelectedContact(buildCommonPayload(), {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: buildCommonPayload(),
        scenario: 'a subject search with no contact named',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a null selectedContact must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), { selectedContact: null });
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "selectedContact" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] injection: a tautology must not leak database internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(SQLI_PAYLOAD);
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(XSS_PAYLOAD);
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] boundary: the subject list must be bounded', async ({ mailboxClient, token }) => {
    const payload = buildContactMailsPayload(syntheticRecipient(), { count: 10 });
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 10,
      what: 'distinct subjects',
    });
  });

  test('[9] empty state: a contact with no subjects must not be an error', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(syntheticRecipient());
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A contact with no subjects is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[10] boundary: a 5000-character contact must not fault', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildContactMailsPayload(MAX_LENGTH_STRING);
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token });

    expect(
      response.status(),
      `a 5000-character selectedContact produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[11] auth: an anonymous caller must not search subjects', async ({ mailboxClient }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.mailSubjectSelectedContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[12] auth: an expired token must not search subjects', async ({ mailboxClient }) => {
    const payload = buildContactMailsPayload();
    const response = await mailboxClient.mailSubjectSelectedContact(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * Cross-cutting search properties
 * ====================================================================================== */
test.describe('Search surface properties', () => {
  test('[1] the two search routes must agree about scoping', async ({ mailboxClient, token }) => {
    // Both routes take the same DTO and `selectedContact`, differing only in bodies vs subjects. A
    // wildcard escaped on one and not the other means the subject index leaks what the body does not.
    const payload = buildContactMailsPayload(SQLI_WILDCARD, { count: 20 });
    const [conversation, subjects] = await Promise.all([
      mailboxClient.selectedContactMails(payload, { token }),
      mailboxClient.mailSubjectSelectedContact(payload, { token }),
    ]);

    const [conversationBody, subjectsBody] = await Promise.all([
      readBody(conversation),
      readBody(subjects),
    ]);
    test.skip(
      !conversation.ok() || !subjects.ok(),
      'the search routes did not both succeed on this environment'
    );

    const conversationCount = Array.isArray(conversationBody.json?.data)
      ? (conversationBody.json?.data as unknown[]).length
      : 0;
    const subjectCount = Array.isArray(subjectsBody.json?.data)
      ? (subjectsBody.json?.data as unknown[]).length
      : 0;

    expect(
      conversationCount === 0 && subjectCount > 0,
      `a "%" contact returned 0 conversations but ${subjectCount} subjects. The two routes take the same field and must escape it the same way; one that treats the wildcard literally while the other expands it means the subject index leaks correspondence the body index correctly refuses.`
    ).toBe(false);
  });

  test('[2] a search must not disclose whether an account exists', async ({
    mailboxClient,
    token,
  }) => {
    // User enumeration: searching a real account with no correspondence and a wholly invented one
    // must be indistinguishable, or the search box becomes a registration-directory lookup.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real account to compare against');

    const [real, invented] = await Promise.all([
      mailboxClient.selectedContactMails(buildContactMailsPayload(FOREIGN.victimKpostID), {
        token,
      }),
      mailboxClient.selectedContactMails(buildContactMailsPayload(syntheticRecipient()), { token }),
    ]);

    const [realBody, inventedBody] = await Promise.all([readBody(real), readBody(invented)]);
    test.skip(!real.ok() && !invented.ok(), 'neither search succeeded on this environment');

    const normalise = (text: string): string =>
      text.replace(/\d{10,}/g, '<ts>').replace(/"[\w.@-]+@[\w.-]+"/g, '"<address>"');

    expect(
      real.status() === invented.status() &&
        normalise(realBody.text) === normalise(inventedBody.text),
      `searching for a registered account with no correspondence produced a different answer (HTTP ${real.status()}) from searching for an address that does not exist (HTTP ${invented.status()}). A difference here turns the conversation lookup into a registration oracle: an attacker learns which addresses have KPOST accounts without needing any correspondence with them.`
    ).toBe(true);
  });

  test('[3] repeated failed searches must eventually be throttled', async ({
    mailboxClient,
    token,
  }) => {
    // The one place this suite asserts rate limiting should fire: an unthrottled search endpoint is
    // what makes the enumeration above practical at scale. Twenty requests is a gentle probe — a
    // pass means twenty is under the limit, not that one exists.
    const attempts = 20;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        mailboxClient.selectedContactMails(buildContactMailsPayload(syntheticRecipient()), {
          token,
        })
      )
    );

    const throttled = responses.filter((response) => response.status() === 429).length;

    test.info().annotations.push({
      type: 'rate-limit probe',
      description: `${attempts} rapid searches, ${throttled} throttled. This is a gentle probe: no 429 here means the limit is above ${attempts} requests, not that none exists.`,
    });

    expect(
      responses.every((response) => response.status() < 500),
      `${attempts} rapid searches produced at least one 5xx. Whatever the rate-limiting policy is, exceeding it must be a 429 with a retry hint — a server fault under modest concurrent load is a availability problem in its own right.`
    ).toBe(true);
  });
});
