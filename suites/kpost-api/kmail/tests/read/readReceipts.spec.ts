import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import {
  buildCommonPayload,
  buildDashboardPagePayload,
} from '../../src/api/payloads/mailbox.payload';

/**
 * KMail — **read receipts**: FR-M04 and BR-M01.
 *
 * FR-M04 "Record and display a read receipt per mail, with exact open date/time."
 * BR-M01 "Read-receipt data is recorded for every mail sent, matching Katchup's behaviour."
 *
 * ## Why this file exists
 *
 * Both ids were previously carried by ONE test — `actions.spec.ts` "a flagged mail must appear in
 * the Important folder". That test is worth having, but it exercises the **Important flag**, not a
 * read receipt: it proves nothing about whether an open is recorded, when it is recorded, or
 * whether the timestamp is real. The requirements therefore read as traced while the feature they
 * describe was never verified. The tag has been corrected there and the real coverage lives here.
 *
 * ## The receipt surface
 *
 * KMail has no single "receipt" route. The receipt state is observable through four reads, and
 * the rule is only provable by agreeing what each one is for:
 *
 * | route | what it answers |
 * | --- | --- |
 * | `sentMailNotOpened` | mails this sender sent that the recipient has not opened |
 * | `statusOfKmailsContactsWithCount` | per-contact open/unopened counts |
 * | `unOpenedMailCountBySenderID` | the badge aggregate |
 * | `kmailGroupReadStatus` | per-member state on a group mail — the per-RECIPIENT half |
 *
 * ## A standing environment limit, stated rather than worked around
 *
 * `postMail` 500s on the QA accounts: they have no mail-server credentials
 * (`getMailCredentials` returns all-null). That is a provisioning gap for the developers, not a
 * payload bug. So these tests read receipts for mail that **already exists** and skip with a
 * stated reason when the mailbox is empty. BR-M01's "for every mail sent" cannot be closed from
 * the send side until the credentials land — that is recorded here rather than faked with a test
 * that would pass against an empty store.
 */

/** True when the API treated the read as a success — 2xx and not a FAILURE envelope. */
function ok(status: number, json: Record<string, unknown> | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (json && String(json.status ?? '').toUpperCase() === 'FAILURE') return false;
  if (json && typeof json.statusCode === 'number' && json.statusCode >= 400) return false;
  return true;
}

function rows(json: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!json) return [];
  for (const key of ['data', 'value']) {
    const v = (json as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  return [];
}

/** Any field on a row that looks like an open timestamp. */
function openTimestamp(row: Record<string, unknown>): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (/(read|open|seen)(At|Time|Date|On)?$/i.test(key)) return value;
  }
  return undefined;
}

test.describe('FR-M04 — read receipts are recorded per mail @audit', () => {
  test('[FR-M04] the unopened-mail read must answer, not fault', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * The reachability control for everything below. `sentMailNotOpened` IS the receipt read on
     * this platform, so if it does not answer, no receipt is displayable and every other case in
     * this file would be asserting against an error body.
     */
    const response = await mailboxClient.sentMailNotOpened(buildCommonPayload(), { token });
    const { json, text } = await readBody(response);

    expect(
      ok(response.status(), json),
      `FR-M04: the unopened-mail read answered HTTP ${response.status()}. This is the route a sender's "not yet opened" view is built from — if it faults, KMail cannot display a read receipt at all. Body: ${text.slice(0, 240)}`,
    ).toBe(true);
  });

  test('[FR-M04] an unopened mail must not carry an open timestamp', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * The negative case, and the one that decides whether the receipt means anything. Every row
     * this route returns is BY DEFINITION not yet opened, so an open timestamp on one of them is
     * self-contradictory — the backend stamped it at send or at write rather than at open, and
     * "exact open date/time" is then a fiction.
     */
    const response = await mailboxClient.sentMailNotOpened(buildCommonPayload(), { token });
    const { json } = await readBody(response);
    test.skip(
      !ok(response.status(), json),
      'the unopened-mail read was refused on this environment',
    );

    const unopened = rows(json);
    test.skip(
      unopened.length === 0,
      'no unopened sent mail on this account — nothing to contradict (postMail 500s here, so the store cannot be seeded)',
    );

    const stamped = unopened.filter((row) => {
      const t = openTimestamp(row);
      return t !== null && t !== undefined && t !== '' && t !== 0;
    });

    expect(
      stamped.length,
      `FR-M04: ${stamped.length} of ${unopened.length} rows returned by the UNOPENED-mail read carry an open timestamp. A row in this list has not been opened, so the timestamp cannot be an open time — it is being written at send. First: ${JSON.stringify(stamped[0] ?? {}).slice(0, 240)}`,
    ).toBe(0);
  });

  test('[FR-M04] per-contact receipt counts must be internally consistent', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * A receipt store that reports a total which does not match the sum of its parts is not
     * recording per-mail state; it is keeping two counters that drift. `statusOfKmailsContacts-
     * WithCount` and its `TotalCount` sibling are the two halves a client renders together, so
     * disagreement between them is visible to a user as a badge that never clears.
     */
    const perContact = await mailboxClient.statusOfKmailsContactsWithCount(buildCommonPayload(), {
      token,
    });
    const total = await mailboxClient.statusOfKmailsContactsTotalCount({ token });
    const a = await readBody(perContact);
    const b = await readBody(total);

    test.skip(
      !ok(perContact.status(), a.json) || !ok(total.status(), b.json),
      'one of the two receipt-count reads was refused, so they cannot be compared',
    );

    const contacts = rows(a.json);
    test.skip(contacts.length === 0, 'no contacts carry receipt state on this account');

    const summed = contacts.reduce((sum, row) => {
      const n = Number(row.count ?? row.unOpenedCount ?? row.unopenedCount ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    const reported = Number(
      (b.json as Record<string, unknown>)?.data ??
        (b.json as Record<string, unknown>)?.count ??
        NaN,
    );

    test.skip(
      !Number.isFinite(reported),
      `the total-count read returned no numeric total: ${b.text.slice(0, 160)}`,
    );

    expect(
      reported,
      `FR-M04: the per-contact receipt rows sum to ${summed} but the total-count read reports ${reported}. These are the two halves a client renders together, so a mismatch shows the user a badge that does not match the list it opens.`,
    ).toBe(summed);
  });

  test('[FR-M04] a group mail must expose read state per member, not one row for the group', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * The per-RECIPIENT half, which is the whole phrase in FR-M04 and the thing a single
     * aggregate row silently fails. Mirrors Katchup's `getReadStatusGroupMessage` case so
     * BR-M01's "matching Katchup's behaviour" is comparable rather than asserted.
     *
     * Uses a REAL kmailID from the mailbox: a synthetic id is ignored by this route, which then
     * answers about nothing and the test would pass against an empty result.
     */
    const inbox = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), { token });
    const { json: inboxJson } = await readBody(inbox);
    const owned = rows(inboxJson)
      .map((r) => Number(r.kmailID))
      .find((id) => Number.isFinite(id) && id > 0);

    test.skip(
      owned === undefined,
      'no readable mail on this account — the mailbox read is degraded here ("No Data Found"), so group receipt state cannot be exercised',
    );

    const response = await mailboxClient.kmailGroupReadStatus(
      buildCommonPayload({ kmailID: owned, groupFlag: true }),
      { token },
    );
    const { json, text } = await readBody(response);

    test.skip(
      !ok(response.status(), json),
      `the group read-status lookup was refused for kmailID ${owned} (HTTP ${response.status()}), so per-member receipts cannot be judged`,
    );

    const members = rows(json);
    const named = members.filter((m) =>
      Object.keys(m).some((k) => /kpost|member|recipient|email|toAddress/i.test(k)),
    );

    expect(
      named.length,
      `FR-M04: the group read-status lookup returned ${members.length} row(s), ${named.length} of which identify a recipient. A read receipt must be per recipient — rows that name nobody cannot tell the sender who opened the mail. Body: ${text.slice(0, 240)}`,
    ).toBe(members.length);
  });
});

test.describe('BR-M01 — receipt data exists for mail that was sent @audit', () => {
  test('[BR-M01] every sent mail must be accounted for in the receipt store', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * BR-M01 says receipt data is recorded for EVERY mail sent. The send side cannot be exercised
     * here (postMail 500s — no mail-server credentials on the QA accounts), so this asserts the
     * half that is provable from existing state: a mail the mailbox knows about must be visible
     * to the receipt reads, either as opened or as not-yet-opened. A mail in neither bucket has
     * no receipt at all, which is the defect BR-M01 describes.
     */
    const inbox = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), { token });
    const { json: inboxJson } = await readBody(inbox);
    const mails = rows(inboxJson)
      .map((r) => Number(r.kmailID))
      .filter((id) => Number.isFinite(id) && id > 0);

    test.skip(
      mails.length === 0,
      'the mailbox read returns no rows on this environment (a known degraded read), so "every mail sent" has no population to check',
    );

    const unopened = await mailboxClient.sentMailNotOpened(buildCommonPayload(), { token });
    const opened = await mailboxClient.statusOfKmailsContactsWithCount(buildCommonPayload(), {
      token,
    });
    const u = await readBody(unopened);
    const o = await readBody(opened);

    test.skip(
      !ok(unopened.status(), u.json) && !ok(opened.status(), o.json),
      'neither receipt read answered, so no mail can be accounted for',
    );

    const accountedFor = new Set(
      [...rows(u.json), ...rows(o.json)]
        .map((r) => Number(r.kmailID))
        .filter((id) => Number.isFinite(id) && id > 0),
    );
    const missing = mails.filter((id) => !accountedFor.has(id));

    expect(
      missing.length,
      `BR-M01: ${missing.length} of ${mails.length} mails in the mailbox appear in NEITHER receipt read — not as opened, not as unopened. A mail with no receipt row cannot report a read state to its sender, which is the rule BR-M01 states. Missing ids: ${missing.slice(0, 10).join(', ')}`,
    ).toBe(0);
  });

  test('[BR-M01] the badge aggregate must agree with the unopened list', async ({
    mailboxClient,
    token,
  }) => {
    /*
     * The state-transition half, expressed as an invariant: the number a client badges must be
     * derivable from the list a client opens. When these two disagree the user sees an unread
     * count that clearing the list never resolves — the single most common receipt complaint,
     * and invisible to any test that reads only one of the two routes.
     */
    const badge = await mailboxClient.unOpenedMailCountBySenderID({ token });
    const list = await mailboxClient.sentMailNotOpened(buildCommonPayload(), { token });
    const b = await readBody(badge);
    const l = await readBody(list);

    test.skip(
      !ok(badge.status(), b.json) || !ok(list.status(), l.json),
      'one of the badge/list reads was refused, so they cannot be compared',
    );

    const counted = Number(
      (b.json as Record<string, unknown>)?.data ??
        (b.json as Record<string, unknown>)?.count ??
        NaN,
    );
    test.skip(
      !Number.isFinite(counted),
      `the badge read returned no numeric count: ${b.text.slice(0, 160)}`,
    );

    const listed = rows(l.json).length;
    test.skip(
      counted === 0 && listed === 0,
      'no unopened mail on this account, so badge and list agree trivially and prove nothing',
    );

    expect(
      counted,
      `BR-M01: the unopened badge reports ${counted} but the unopened list returns ${listed} row(s). A badge a user cannot clear by reading the list it points at is a receipt store keeping two counters instead of one.`,
    ).toBe(listed);
  });

  test("[BR-M01] clearing a contact's receipt state must actually clear it", async ({
    mailboxClient,
    token,
  }) => {
    /*
     * The state transition on the receipt store itself. `clearStatusOfKmailsContacts` is what a
     * user triggers by opening a conversation, so a clear that reports success without moving the
     * count is the defect behind every "unread badge that will not go away" complaint — and it is
     * invisible to any test that calls the clear and only checks its status code.
     *
     * Read, clear, read again. If the count was already zero the assertion proves nothing, so
     * that case skips rather than passing vacuously.
     */
    const before = await mailboxClient.statusOfKmailsContactsWithCount(buildCommonPayload(), {
      token,
    });
    const b = await readBody(before);
    test.skip(
      !ok(before.status(), b.json),
      'the receipt-count read was refused, so a clear cannot be observed',
    );

    const withState = rows(b.json).filter((r) => {
      const n = Number(r.count ?? r.unOpenedCount ?? r.unopenedCount ?? 0);
      return Number.isFinite(n) && n > 0;
    });
    test.skip(
      withState.length === 0,
      'no contact carries a non-zero receipt count on this account, so clearing it would prove nothing',
    );

    const contact = String(
      withState[0].selectedContact ?? withState[0].kpostID ?? withState[0].fromAddress ?? '',
    );
    test.skip(
      contact === '',
      `the receipt row names no contact to clear: ${JSON.stringify(withState[0]).slice(0, 200)}`,
    );

    const cleared = await mailboxClient.clearStatusOfKmailsContacts(
      buildCommonPayload({ selectedContact: contact }),
      { token },
    );
    const c = await readBody(cleared);
    test.skip(
      !ok(cleared.status(), c.json),
      `the clear was refused for "${contact}" (HTTP ${cleared.status()})`,
    );

    const after = await mailboxClient.statusOfKmailsContactsWithCount(buildCommonPayload(), {
      token,
    });
    const a = await readBody(after);
    const stillSet = rows(a.json).find(
      (r) =>
        String(r.selectedContact ?? r.kpostID ?? r.fromAddress ?? '') === contact &&
        Number(r.count ?? r.unOpenedCount ?? r.unopenedCount ?? 0) > 0,
    );

    expect(
      stillSet,
      `BR-M01: the receipt state for "${contact}" was cleared successfully but the count is still non-zero on the next read. A clear that reports success without changing state leaves the user an unread badge they cannot dismiss. Row: ${JSON.stringify(stillSet ?? {}).slice(0, 240)}`,
    ).toBeUndefined();
  });
});
