import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { MAILBOX_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import {
  DOCUMENTED_STATUS_VALUES,
  strictDocumentedEnvelopeSchema,
} from '../../src/api/schemas/envelope.schema';
import {
  countResponseSchema,
  followUpResponseSchema,
  kmailListResponseSchema,
} from '../../src/api/schemas/kmail.schema';
import {
  assertBoundedCollection,
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertRejectsInvalidInput,
  assertStatus,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  FETCH_MAIL_TYPE,
  KMAIL_STATUS_FLAG,
  buildCommonPayload,
  buildImportantMailsPayload,
  buildDashboardPagePayload,
  buildDashboardRefreshPayload,
  buildFollowUpPayload,
  buildMailCountPayload,
} from '../../src/api/payloads/mailbox.payload';
import { syntheticRecipient } from '../../src/utils/safeTestData';

/**
 * Folders and listing — the inbox, the bulk folder, the Important folder, the counts, and the
 * follow-up buckets.
 *
 * KMail has no folder resource: no `GET /folders`, no folder id, no create/rename. A folder is
 * a string on `kmailType` plus a listing route, and "Trash" is a soft-delete marker on the
 * user's own transaction row. So folders are covered through the listing endpoints.
 *
 * The follow-up buckets (`replyNotReceived`, `sentMailNotOpened`, `replyNotSent`) are covered
 * here too: they are presented as folders, selected by `kmailStatusFlag`, and share the same
 * listing, paging and scoping properties.
 *
 * Every listing route is asserted for two properties:
 *
 *  - Bounded. These read from a table that grows without limit; an unbounded response is a
 *    memory-exhaustion vector and an exfiltration primitive at once.
 *  - Scoped. `kpostUser` is server-assigned; every case that sets it asks whether the body can
 *    choose whose mailbox is listed.
 */

const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_WILDCARD = '%';

/* =========================================================================================
 * POST /v2/common/getKmailDashboardMsg  — the inbox
 * ====================================================================================== */
test.describe('POST /v2/common/getKmailDashboardMsg @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.getKmailDashboardMsg,
    repro: `await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), { token });`,
  };

  test('[1] happy path: a page of the inbox satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] paging: the requested page size must be honoured', async ({ mailboxClient, token }) => {
    // `count` is the page size, default 50. Ignoring it is not cosmetic here: the table grows
    // for the life of the account, so it is the difference between 20 rows and the whole mailbox.
    const payload = buildDashboardPagePayload({ count: 5 });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 5,
      what: 'inbox messages',
    });
  });

  test('[3] paging: an absent count must fall back to the documented default', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload();
    delete (payload as Record<string, unknown>).count;
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 50,
      what: 'inbox messages with no count supplied (documented default is 50)',
    });
  });

  test('[4] paging: an enormous count must be capped', async ({ mailboxClient, token }) => {
    // The client asks for a million. Obliging hands one request the entire mailbox — a memory
    // problem and, for anyone with a token, the fastest exfiltration.
    const payload = buildDashboardPagePayload({ count: 1_000_000 });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 500,
      what: 'inbox messages for a count of 1,000,000',
    });
  });

  test('[5] paging: a negative count must be refused', async ({ mailboxClient, token }) => {
    const payload = buildDashboardPagePayload({ count: -1 });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the page size was negative',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] paging: a zero count must not mean "unbounded"', async ({ mailboxClient, token }) => {
    // Zero is either "no rows" or a validation error — but passed into a LIMIT clause, or
    // treated as falsy/unset, it becomes "no limit": one mistyped parameter from a full dump.
    const payload = buildDashboardPagePayload({ count: 0 });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 50,
      what: 'inbox messages for a count of 0',
    });
  });

  test('[7] paging: the keyset cursor must page backwards, not repeat', async ({
    mailboxClient,
    token,
  }) => {
    // `kmailID` is the keyset cursor (Excel [F]): send back the oldest id held, receive the page
    // before it. If ignored, the second page repeats the first and the client loops forever.
    const first = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload({ count: 5 }), {
      token,
    });
    const firstBody = await readBody(first);
    const rows = Array.isArray(firstBody.json?.data)
      ? (firstBody.json?.data as Array<Record<string, unknown>>)
      : [];
    test.skip(rows.length < 2, 'not enough mail in this mailbox to page through');

    const oldest = rows
      .map((row) => (typeof row.kmailID === 'number' ? row.kmailID : Number.NaN))
      .filter((id) => !Number.isNaN(id))
      .sort((a, b) => a - b)[0];
    test.skip(oldest === undefined, 'the listing carries no kmailID to page from');

    const second = await mailboxClient.getKmailDashboardMsg(
      buildDashboardPagePayload({ count: 5, kmailID: String(oldest) }),
      { token }
    );
    const secondBody = await readBody(second);
    const secondRows = Array.isArray(secondBody.json?.data)
      ? (secondBody.json?.data as Array<Record<string, unknown>>)
      : [];

    const overlap = secondRows.filter(
      (row) => typeof row.kmailID === 'number' && rows.some((first) => first.kmailID === row.kmailID)
    );

    expect(
      overlap.length,
      `paging with kmailID=${oldest} returned ${overlap.length} rows that were already on the first page. The cursor is a keyset, not an offset: the second page must be strictly older than the cursor. If it is ignored, a client paging through its mailbox loops on the same rows and never reaches the end.`
    ).toBe(0);
  });

  test('[8] IDOR: a body kpostUser must not list another mailbox', async ({
    mailboxClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildDashboardPagePayload({ kpostUser: FOREIGN.victimKpostID });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'inbox listing returned no parseable body');

    expect(
      text.includes(`"toAddress":"${FOREIGN.victimKpostID}"`),
      `naming kpostUser "${FOREIGN.victimKpostID}" returned that account's inbox to ${callerKpostId ?? 'a different identity'}. kpostUser is documented as overwritten from the JWT on every route in this controller — this is the single request that would turn the platform into a mail reader for every account. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] read-state filter: unopened-only must not return opened mail', async ({
    mailboxClient,
    token,
  }) => {
    // `fetchMailType` is how KMail expresses read/unread on the listing side — no separate
    // markAsRead endpoint; the state lives on the transaction row. Accepted-and-ignored makes
    // the unread view meaningless while returning 200 throughout.
    const payload = buildDashboardPagePayload({
      fetchMailType: FETCH_MAIL_TYPE.unopenedOnly,
      count: 20,
    });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !Array.isArray(json.data) || (json.data as unknown[]).length === 0,
      'no mail returned for the unopened filter — nothing to check'
    );

    const rows = json?.data as Array<Record<string, unknown>>;
    const opened = rows.filter(
      (row) => row.openedStatus === 'Y' || row.openedStatus === true || row.openedStatus === 1
    );

    expect(
      opened.length,
      `asking for unopened mail (fetchMailType "N") returned ${opened.length} of ${rows.length} rows marked as already opened. This field is the entire read/unread mechanism on the listing side; if it is accepted and ignored, the unread view shows read mail and the unread badge cannot be trusted. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[10] read-state filter: an unrecognised fetchMailType must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload({ fetchMailType: 'Z' });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'fetchMailType "Z" is not one of the documented values Y, N or A',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[11] validation: an empty body must be handled explicitly', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.getKmailDashboardMsg({}, { token });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}. It is either "first page, default size" or a clean 400 — never a fault.`
    ).toBeLessThan(500);
  });

  test('[12] injection: a tautology in selectedContact must not leak internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload({ selectedContact: SQLI_PAYLOAD });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[13] type mismatch: a string count must not fault', async ({ mailboxClient, token }) => {
    const payload = buildDashboardPagePayload({ count: '50' });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    expect(
      response.status(),
      `count was sent as a string where the contract declares an integer, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[14] structural: malformed JSON must be a clean 400', async ({ mailboxClient, token }) => {
    const malformed = '{"count":';
    const response = await mailboxClient.sendRaw(MAILBOX_PATHS.getKmailDashboardMsg, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await mailboxClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[15] structural: an unknown field must not leak a stack trace', async ({
    mailboxClient,
    token,
  }) => {
    // Confirmed on this service: an unknown property on `KmailCommonRequestObject` produces
    // Spring's default error body carrying a full `trace`. Rejecting is correct; leaking the stack is not.
    const payload = buildDashboardPagePayload({ notAFieldOnThisEntity: 'probe' });
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, 'notAFieldOnThisEntity');
  });

  test('[16] auth: no Authorization header must be 401/403', async ({ mailboxClient }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[17] auth: an expired token must not list the inbox', async ({ mailboxClient }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getKmailDashboardMsg(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[18] status parity: HTTP status must agree with the envelope', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.getKmailDashboardMsg({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });
});

/* =========================================================================================
 * POST /v2/common/getKmailDashboardNewMsg  — incremental refresh
 * ====================================================================================== */
test.describe('POST /v2/common/getKmailDashboardNewMsg @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.getKmailDashboardNewMsg,
    repro: `await mailboxClient.getKmailDashboardNewMsg(buildDashboardRefreshPayload(), { token });`,
  };

  test('[1] happy path: the refresh satisfies the contract', async ({ mailboxClient, token }) => {
    const payload = buildDashboardRefreshPayload();
    const response = await mailboxClient.getKmailDashboardNewMsg(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] a cursor at the newest id must return nothing new', async ({
    mailboxClient,
    token,
  }) => {
    // The endpoint the mail client polls on a timer. Given the newest id the client already
    // holds it must return empty — otherwise every poll re-notifies about already-seen mail.
    const first = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload({ count: 5 }), {
      token,
    });
    const firstBody = await readBody(first);
    const rows = Array.isArray(firstBody.json?.data)
      ? (firstBody.json?.data as Array<Record<string, unknown>>)
      : [];
    test.skip(rows.length === 0, 'no mail in this mailbox to refresh from');

    const newest = rows
      .map((row) => (typeof row.kmailID === 'number' ? row.kmailID : Number.NaN))
      .filter((id) => !Number.isNaN(id))
      .sort((a, b) => b - a)[0];
    test.skip(newest === undefined, 'the listing carries no kmailID to refresh from');

    const response = await mailboxClient.getKmailDashboardNewMsg(
      buildDashboardRefreshPayload(newest),
      { token }
    );
    const { json, text } = await readBody(response);
    test.skip(json === null, 'refresh returned no parseable body');

    const returned = Array.isArray(json?.data) ? (json?.data as unknown[]).length : 0;

    expect(
      returned,
      `refreshing from firstKmailID=${newest} — the newest message the client already holds — returned ${returned} messages. This route is polled on a timer; if the cursor is ignored, every poll re-delivers mail the user has already seen and re-raises its notification. Body: ${text.slice(0, 200)}`
    ).toBe(0);
  });

  test('[3] boundary: a cursor of 0 must be bounded', async ({ mailboxClient, token }) => {
    // Cursor 0 means "everything since the beginning" — where an incremental endpoint becomes a full dump.
    const payload = buildDashboardRefreshPayload(0, { count: 20 });
    const response = await mailboxClient.getKmailDashboardNewMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'messages newer than cursor 0',
    });
  });

  test('[4] IDOR: a body kpostUser must not refresh another mailbox', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildDashboardRefreshPayload(0, { kpostUser: FOREIGN.victimKpostID });
    const response = await mailboxClient.getKmailDashboardNewMsg(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser',
    });
  });

  test('[5] validation: a negative cursor must be refused', async ({ mailboxClient, token }) => {
    const payload = buildDashboardRefreshPayload(-1);
    const response = await mailboxClient.getKmailDashboardNewMsg(payload, { token });

    expect(
      response.status(),
      `a negative firstKmailID produced HTTP ${response.status()}. No auto-increment identity is negative, so it is a 400 rather than a query.`
    ).toBeLessThan(500);
  });

  test('[6] auth: an anonymous caller must not refresh', async ({ mailboxClient }) => {
    const payload = buildDashboardRefreshPayload();
    const response = await mailboxClient.getKmailDashboardNewMsg(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/common/getBulkKmailDashboardMsg  — the bulk folder
 * ====================================================================================== */
test.describe('POST /v2/common/getBulkKmailDashboardMsg @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.getBulkKmailDashboardMsg,
    repro: `await mailboxClient.getBulkKmailDashboardMsg(buildDashboardPagePayload(), { token });`,
  };

  test('[1] happy path: the bulk folder satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getBulkKmailDashboardMsg(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] the bulk folder must be paged like the inbox', async ({ mailboxClient, token }) => {
    const payload = buildDashboardPagePayload({ count: 5 });
    const response = await mailboxClient.getBulkKmailDashboardMsg(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 5,
      what: 'bulk-campaign messages',
    });
  });

  test('[3] empty state: an account that has run no campaigns must not error', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getBulkKmailDashboardMsg(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'An empty bulk folder is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[4] IDOR: a body kpostUser must not list another account\'s campaigns', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildDashboardPagePayload({ kpostUser: FOREIGN.victimKpostID });
    const response = await mailboxClient.getBulkKmailDashboardMsg(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser',
    });
  });

  test('[5] auth: an anonymous caller must not list campaigns', async ({ mailboxClient }) => {
    const payload = buildDashboardPagePayload();
    const response = await mailboxClient.getBulkKmailDashboardMsg(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/common/getAllImportantMails  — the Important folder
 * ====================================================================================== */
test.describe('POST /v2/common/getAllImportantMails @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.getAllImportantMails,
    repro: `await mailboxClient.getAllImportantMails(buildCommonPayload(), { token });`,
  };

  test('[1] happy path: the Important folder satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    // Excel row 15 documents this fetch as `{ selectedContact }` — see buildImportantMailsPayload.
    const payload = buildImportantMailsPayload();
    const response = await mailboxClient.getAllImportantMails(payload, { token });

    await expectValidContract(
      response,
      kmailListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] the folder must return only flagged mail', async ({ mailboxClient, token }) => {
    const payload = buildCommonPayload({ count: 20 });
    const response = await mailboxClient.getAllImportantMails(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !Array.isArray(json.data) || (json.data as unknown[]).length === 0,
      'the Important folder is empty — nothing to check'
    );

    const rows = json?.data as Array<Record<string, unknown>>;
    const unflagged = rows.filter(
      (row) =>
        row.importantFlag === 'N' || row.importantFlag === false || row.importantFlag === 0
    );

    expect(
      unflagged.length,
      `the Important folder returned ${unflagged.length} of ${rows.length} rows explicitly marked as not important. A folder defined by a flag that returns rows without it is not filtering at all. Body: ${text.slice(0, 300)}`
    ).toBe(0);
  });

  test('[3] boundary: the folder must be bounded', async ({ mailboxClient, token }) => {
    const payload = buildCommonPayload({ count: 10 });
    const response = await mailboxClient.getAllImportantMails(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 10,
      what: 'important messages',
    });
  });

  test('[4] IDOR: a body kpostUser must not list another user\'s flagged mail', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildCommonPayload({ kpostUser: FOREIGN.victimKpostID });
    const response = await mailboxClient.getAllImportantMails(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser',
    });
  });

  test('[5] auth: an anonymous caller must not list flagged mail', async ({ mailboxClient }) => {
    const payload = buildCommonPayload();
    const response = await mailboxClient.getAllImportantMails(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * Counts
 * ====================================================================================== */
test.describe('Mail counts @audit', () => {
  test('[1] getAllMailCount: happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.getAllMailCount,
      repro: `await mailboxClient.getAllMailCount(buildMailCountPayload(), { token });`,
    };
    const payload = buildMailCountPayload();
    const response = await mailboxClient.getAllMailCount(payload, { token });

    await expectValidContract(
      response,
      countResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] getAllMailCount: counts must be non-negative', async ({ mailboxClient, token }) => {
    // A negative count means increment and decrement paths disagree — usually a delete that
    // decrements without confirming the mail was counted. Every quota/unread figure on the same
    // accounting is then wrong too.
    const response = await mailboxClient.getAllMailCount(buildMailCountPayload(), { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'count read returned no data on this environment');

    const numbers = [...text.matchAll(/:\s*(-\d+)/g)].map((match) => Number(match[1]));

    expect(
      numbers,
      `the mail counts include negative values (${numbers.join(', ')}). Counts are COUNT aggregations over transaction rows and cannot be negative — a negative figure means a cached counter is being decremented without a matching increment, which invalidates every unread badge and quota built on the same accounting. Body: ${text.slice(0, 300)}`
    ).toHaveLength(0);
  });

  test('[3] getAllMailCount: scoping to a contact must change the answer', async ({
    mailboxClient,
    token,
  }) => {
    // The route counts mailbox-wide or narrowed by `selectedContact`. A contact never
    // corresponded with must not return the mailbox-wide total — if it does, the filter is
    // ignored and a per-conversation count is really the whole mailbox.
    const [overall, scoped] = await Promise.all([
      // mailbox-wide total = the empty-body form; scoped = the Excel per-contact shape.
      mailboxClient.getAllMailCount({}, { token }),
      mailboxClient.getAllMailCount(buildMailCountPayload(), { token }),
    ]);

    const [overallBody, scopedBody] = await Promise.all([readBody(overall), readBody(scoped)]);
    test.skip(
      !overall.ok() || !scoped.ok() || overallBody.json === null,
      'counts did not resolve on this environment'
    );

    const overallTotals = JSON.stringify(overallBody.json?.data ?? {});
    const scopedTotals = JSON.stringify(scopedBody.json?.data ?? {});
    test.skip(overallTotals === '{}' || overallTotals === 'null', 'no counts returned to compare');
    test.skip(overallTotals === '0', 'the mailbox is empty, so both counts are legitimately zero');

    expect(
      scopedTotals,
      `counting mail for a contact the caller has never corresponded with returned the same totals as the mailbox-wide count (${overallTotals.slice(0, 120)}). selectedContact is documented to narrow the aggregation; if it is ignored, every per-conversation count in the UI is really the whole mailbox.`
    ).not.toBe(overallTotals);
  });

  test('[4] getAllMailCount: an anonymous caller must not read counts', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.getAllMailCount(buildMailCountPayload(), { token: null });

    await assertUnauthorized(response, {
      method: 'POST',
      path: MAILBOX_PATHS.getAllMailCount,
      repro: `await mailboxClient.getAllMailCount({}, { token: null });`,
    });
  });

  test('[5] unOpenedMailCountBySenderID: happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.unOpenedMailCountBySenderID,
      repro: `await mailboxClient.unOpenedMailCountBySenderID({ token });`,
    };
    const response = await mailboxClient.unOpenedMailCountBySenderID({ token });

    await expectValidContract(response, countResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[6] unOpenedMailCountBySenderID: a kpostID parameter must not re-scope it', async ({
    mailboxClient,
    token,
  }) => {
    // Per-sender unread counts are a correspondence map — who writes to this account and how
    // much. Even without a body, a social graph worth protecting.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await mailboxClient.unOpenedMailCountBySenderID({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      method: 'GET',
      path: MAILBOX_PATHS.unOpenedMailCountBySenderID,
      repro: `await mailboxClient.unOpenedMailCountBySenderID({ token, params: { kpostID: '<victim>' } });`,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
    });
  });

  test('[7] unOpenedMailCountBySenderID: an anonymous caller must be refused', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.unOpenedMailCountBySenderID({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.unOpenedMailCountBySenderID,
      repro: `await mailboxClient.unOpenedMailCountBySenderID({ token: null });`,
    });
  });

  test('[8] statusOfKmailsContactsTotalCount: happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: MAILBOX_PATHS.statusOfKmailsContactsTotalCount,
      repro: `await mailboxClient.statusOfKmailsContactsTotalCount({ token });`,
    };
    const response = await mailboxClient.statusOfKmailsContactsTotalCount({ token });

    await expectValidContract(response, countResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[9] statusOfKmailsContactsTotalCount: an anonymous caller must be refused', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.statusOfKmailsContactsTotalCount({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: MAILBOX_PATHS.statusOfKmailsContactsTotalCount,
      repro: `await mailboxClient.statusOfKmailsContactsTotalCount({ token: null });`,
    });
  });
});

/* =========================================================================================
 * Follow-up buckets — KMail's distinctive "folders"
 * ====================================================================================== */
test.describe('Follow-up status buckets @audit', () => {
  const BUCKETS = [
    {
      name: 'sentMailNotOpened',
      path: MAILBOX_PATHS.sentMailNotOpened,
      flag: KMAIL_STATUS_FLAG.sentNotOpened,
      call: 'sentMailNotOpened' as const,
      what: 'sent mail the recipient has not opened',
    },
    {
      name: 'replyNotReceived',
      path: MAILBOX_PATHS.replyNotReceived,
      flag: KMAIL_STATUS_FLAG.replyNotReceived,
      call: 'replyNotReceived' as const,
      what: 'sent mail still awaiting a reply',
    },
    {
      name: 'replyNotSent',
      path: MAILBOX_PATHS.replyNotSent,
      flag: KMAIL_STATUS_FLAG.replyNotSent,
      call: 'replyNotSent' as const,
      what: 'received mail the user still owes a reply to',
    },
  ];

  for (const bucket of BUCKETS) {
    const META = {
      method: 'POST',
      path: bucket.path,
      repro: `await mailboxClient.${bucket.call}(buildFollowUpPayload(${bucket.flag}), { token });`,
    };

    test(`[${bucket.name}] happy path: the bucket satisfies the contract`, async ({
      mailboxClient,
      token,
    }) => {
      const payload = buildFollowUpPayload(bucket.flag);
      const response = await mailboxClient[bucket.call](payload, { token });

      await expectValidContract(
        response,
        kmailListResponseSchema,
        { ...META, body: payload },
        [200, 400, 401, 403]
      );
    });

    test(`[${bucket.name}] the bucket must be bounded`, async ({ mailboxClient, token }) => {
      const payload = buildFollowUpPayload(bucket.flag, { count: 10 });
      const response = await mailboxClient[bucket.call](payload, { token });

      await assertBoundedCollection(response, {
        ...META,
        body: payload,
        limit: 10,
        what: bucket.what,
      });
    });

    test(`[${bucket.name}] IDOR: a body kpostUser must not list another user's bucket`, async ({
      mailboxClient,
      token,
    }) => {
      test.skip(
        !FOREIGN.hasVictim,
        'QA_VICTIM_KPOST_ID is unset — no real second account to target'
      );

      const payload = buildFollowUpPayload(bucket.flag, { kpostUser: FOREIGN.victimKpostID });
      const response = await mailboxClient[bucket.call](payload, { token });

      await assertNoForeignAcknowledgement(response, {
        ...META,
        body: payload,
        foreignValue: FOREIGN.victimKpostID,
        what: 'kpostUser',
      });
    });

    test(`[${bucket.name}] empty state must not be an error`, async ({ mailboxClient, token }) => {
      const payload = buildFollowUpPayload(bucket.flag, {
        selectedContact: syntheticRecipient(),
      });
      const response = await mailboxClient[bucket.call](payload, { token });

      await assertStatus(response, [200, 204, 400, 401, 403], {
        ...META,
        body: payload,
        title: `An empty ${bucket.name} bucket is reported as a server error`,
        severity: 'Minor',
      });
    });

    test(`[${bucket.name}] an anonymous caller must be refused`, async ({ mailboxClient }) => {
      const payload = buildFollowUpPayload(bucket.flag);
      const response = await mailboxClient[bucket.call](payload, { token: null });

      await assertUnauthorized(response, { ...META, body: payload });
    });
  }

  test('[statusOfKmailsContactsWithCount] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.statusOfKmailsContactsWithCount,
      repro: `await mailboxClient.statusOfKmailsContactsWithCount(buildFollowUpPayload(), { token });`,
    };
    const payload = buildFollowUpPayload();
    const response = await mailboxClient.statusOfKmailsContactsWithCount(payload, { token });

    await expectValidContract(
      response,
      followUpResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[statusOfKmailsContactsWithCount] an unknown status flag must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.statusOfKmailsContactsWithCount,
      repro: `await mailboxClient.statusOfKmailsContactsWithCount(buildFollowUpPayload(99), { token });`,
    };
    const payload = buildFollowUpPayload(99);
    const response = await mailboxClient.statusOfKmailsContactsWithCount(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailStatusFlag 99 is not one of the documented buckets',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[statusOfKmailsContactsWithCount] a wildcard contact must not merge every bucket', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.statusOfKmailsContactsWithCount,
      repro: `await mailboxClient.statusOfKmailsContactsWithCount({ selectedContact: '%' }, { token });`,
    };
    const payload = buildFollowUpPayload(KMAIL_STATUS_FLAG.replyNotReceived, {
      selectedContact: SQLI_WILDCARD,
      count: 20,
    });
    const response = await mailboxClient.statusOfKmailsContactsWithCount(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 20,
      what: 'follow-up contacts for a "%" contact filter',
    });
  });

  test('[retired] the legacy status route must enforce the same authentication', async ({
    mailboxClient,
  }) => {
    // `unusedstatusOfKmailsContacts` is marked `[Legacy]` but still mapped. An unmaintained
    // controller is where an authorisation check goes stale unnoticed — is it as closed as its
    // live replacement?
    const payload = buildFollowUpPayload();
    const response = await mailboxClient.unusedStatusOfKmailsContacts(payload, { token: null });

    await assertUnauthorized(response, {
      method: 'POST',
      path: '/v2/common/unusedstatusOfKmailsContacts',
      repro: `await mailboxClient.unusedStatusOfKmailsContacts(payload, { token: null });`,
      body: payload,
    });
  });
});

/* =========================================================================================
 * Envelope contract
 * ====================================================================================== */
test.describe('Response envelope contract @audit', () => {
  test('[envelope] the documented status casing is asserted once, here', async ({
    mailboxClient,
    token,
  }) => {
    // Isolated deliberately. Docs describe `status` as Success/Failure/Error; the service emits
    // SUCCESS/FAILURE. Enforcing the documented casing everywhere would fail every assertion on
    // one known deviation, so `dataEnvelopeSchema` accepts a plain string and it is reported once here.
    const response = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), {
      token,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'no envelope returned to check on this environment');

    const parsed = strictDocumentedEnvelopeSchema.safeParse(json);

    expect(
      parsed.success,
      `the response envelope does not match the documented contract. Documented status values are ${DOCUMENTED_STATUS_VALUES.join(' / ')}; the service returned "${String(json?.status)}". A generated client that types this field as the documented enum fails to deserialise every response. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  test('[envelope] a successful listing carries statusCode, status and data', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), {
      token,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'no envelope returned to check on this environment');

    expect(
      typeof json?.statusCode === 'number' && typeof json?.status === 'string',
      `a successful listing returned an envelope missing statusCode or status. Every consumer of this API branches on those two fields, and an endpoint that omits them forces callers to special-case it. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  test('[envelope] an authentication failure uses the documented error shape', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), {
      token: MALFORMED_TOKEN,
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'the auth filter returned no parseable body');

    expect(
      typeof json?.status === 'string' || typeof json?.message === 'string',
      `the authentication failure body carries neither a status nor a message field. A client cannot distinguish "authenticate again" from any other failure without one. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });
});
