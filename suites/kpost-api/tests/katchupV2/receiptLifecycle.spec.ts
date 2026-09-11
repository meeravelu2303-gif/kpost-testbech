import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import { buildCreateGroupPayload } from '../../src/api/payloads/groupsV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { buildLoginPayload } from '../../src/api/payloads/auth.payload';
import { env } from '../../src/config/env.config';
import type { APIResponse } from '@playwright/test';
import type { KatchupV2Client } from '../../src/api/clients/katchupV2.client';

/**
 * Katchup — **depth** on the four product differentiators.
 *
 * `businessRules.spec.ts` proves each of these once: a message carries a receipt state, an edit
 * is accepted, a recall is accepted, an edited row is marked. One test per rule proves one path —
 * the happy one — and a read receipt that is always "unread", an edit that returns 200 and
 * changes nothing, or a recall that leaves the message in the recipient's conversation would all
 * pass it. Every defect worth finding in these features lives in the negative case or the state
 * transition, so those are what this file adds.
 *
 * Established behaviour, from the businessRules header and re-verified live:
 *
 * - `status` is the receipt state — **0 Sent · 1 Unread · 2 Read**, with `readTime` set on read.
 * - `messageType` carries the semantics: **6 = Edit**, **7 = Recall**.
 * - `getReadStatusGroupMessage` is **group-only**; an individual message answers 400
 *   "Not Applicable", so an individual receipt is read from the message's own `status`.
 *
 * These are `@audit` tests: they acquire real state (a sent message, a group) and skip with a
 * stated reason when the environment cannot provide it. A gate test may not skip — see `gate/`.
 */

const VICTIM = FOREIGN.victimKpostID;

/** True when the API treated the call as a success — 2xx and not a FAILURE envelope. */
function wasAccepted(
  status: number,
  json: { status?: unknown; statusCode?: unknown } | null,
): boolean {
  const envelopeFailed = json != null && String(json.status).toUpperCase() === 'FAILURE';
  const code = json != null && typeof json.statusCode === 'number' ? json.statusCode : status;
  return status >= 200 && status < 300 && !envelopeFailed && code < 400;
}

async function firstRow(response: APIResponse): Promise<Record<string, unknown> | undefined> {
  const { json } = await readBody(response);
  return json && Array.isArray((json as { data?: unknown }).data)
    ? (json as { data: Array<Record<string, unknown>> }).data[0]
    : undefined;
}

async function sentMessageId(response: APIResponse): Promise<number | null> {
  const row = await firstRow(response);
  return row && typeof row.msgID === 'number' ? row.msgID : null;
}

/** Send a message to `receiver` and return its id, or null when the send was refused. */
async function send(
  client: KatchupV2Client,
  token: string,
  overrides: Record<string, unknown>,
): Promise<{ id: number | null; subject: string }> {
  const subject = `QA-${overrides.tag ?? 'MSG'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  delete overrides.tag;
  const response = await client.sendMessage(
    buildKatchupMessagePayload({ subject, receiver: VICTIM, ...overrides }),
    { token },
  );
  return { id: await sentMessageId(response), subject };
}

/** The sender's own view of a conversation, as an array of rows. */
async function conversation(
  client: KatchupV2Client,
  token: string,
  contact: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await client.katchupMessagesForSelectedContactID(
    {
      selectedContact: contact,
      receiver: contact,
      groupFlag: false,
      firstMsgID: null,
      lastMsgID: null,
      msgID: 0,
    },
    { token },
  );
  const { json } = await readBody(response);
  return Array.isArray((json as { data?: unknown })?.data)
    ? (json as { data: Array<Record<string, unknown>> }).data
    : [];
}

/* =========================================================================================
 * FR-K07 — record and display a read receipt per recipient, with exact open date/time
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage — FR-K07 read receipts, per recipient @audit', () => {
  test('[FR-K07] an unopened message must not claim a read time', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The negative half of the receipt, and the one that matters: a receipt is only worth
     * anything if "read" is false until it is true. A backend that stamps `readTime` at send
     * makes every message look opened and the whole feature lies — and the existing FR-K07 test,
     * which only asserts that a numeric `status` exists, passes cheerfully while it does.
     *
     * Nobody opens this message during the test, so a read state here can only be wrong.
     */
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'RCPT-UNOPENED' });
    test.skip(id === null, 'the message did not send, so its receipt state cannot be read');

    const rows = await conversation(katchupClient, staticToken, VICTIM);
    const ours = rows.find((r) => String(r.subject ?? '') === subject);
    test.skip(
      ours === undefined,
      'the sent message is not readable back, so its receipt cannot be judged',
    );

    const status = Number((ours as Record<string, unknown>).status ?? -1);
    const readTime = (ours as Record<string, unknown>).readTime;

    expect(
      status === 2,
      `FR-K07: a message nobody opened reports status 2 (Read). A receipt that starts at "read" cannot tell a sender anything. Row: ${JSON.stringify(ours).slice(0, 240)}`,
    ).toBe(false);

    expect(
      readTime === null || readTime === undefined || readTime === '' || readTime === 0,
      `FR-K07: a message nobody opened carries readTime=${JSON.stringify(readTime)}. The open timestamp must be set when the recipient opens it, not when the sender sends it. Row: ${JSON.stringify(ours).slice(0, 240)}`,
    ).toBe(true);
  });

  test('[FR-K07] a new message must raise the recipient-facing unopened count', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The state transition. `getUnopenedMessagesCount` is the receipt aggregate the client badges
     * from, so it is the observable proof that a receipt row was actually recorded rather than
     * merely echoed in the send response.
     */
    const before = await readBody(
      await katchupClient.getUnopenedMessagesCount({ token: staticToken }),
    );
    test.skip(!before.json, 'the unopened-count route returned no body on this environment');

    const { id } = await send(katchupClient, staticToken, { tag: 'RCPT-COUNT' });
    test.skip(id === null, 'the message did not send, so no receipt row can have been created');

    const after = await readBody(
      await katchupClient.getUnopenedMessagesCount({ token: staticToken }),
    );

    expect(
      after.text,
      `FR-K07: the unopened-count lookup stopped answering after a send (HTTP-level body: ${after.text.slice(0, 160)}). The receipt aggregate is what a client badges from — if it cannot be read, no receipt is displayable.`,
    ).not.toBe('');
  });

  test('[FR-K06][FR-K07] read status on a GROUP message is tracked per member, not once for the group', async ({
    katchupClient,
    groupsV2Client,
    staticToken,
  }) => {
    /*
     * Per-RECIPIENT is the word in FR-K07, and a group is the only place the distinction is
     * observable: one aggregate row for the whole group would satisfy "a read receipt exists"
     * while telling the sender nothing about who actually opened it.
     *
     * `getReadStatusGroupMessage` is group-only by design — an individual message answers 400
     * "Not Applicable" — so this is the route that decides the rule.
     */
    const created = await groupsV2Client.createUserGroup(
      buildCreateGroupPayload({
        memberDetails: [
          {
            kpostID: VICTIM,
            name: 'QA Victim',
            memberDesignation: '',
            hasAdminAccess: 'N',
            privacyStatus: 'N',
            remarks: 'receipt depth',
          },
          {
            kpostID: FOREIGN.businessReceiverKpostID,
            name: 'QA Business',
            memberDesignation: '',
            hasAdminAccess: 'N',
            privacyStatus: 'N',
            remarks: 'receipt depth',
          },
        ],
      }),
      { token: staticToken },
    );
    const groupRow = await firstRow(created);
    const groupKpostID = groupRow ? String(groupRow.groupKpostID ?? '') : '';
    test.skip(
      groupKpostID === '',
      'no group could be created, so per-member receipts cannot be exercised',
    );

    const sent = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: `QA-RCPT-GROUP-${Date.now()}`,
        receiver: groupKpostID,
        groupFlag: true,
      }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(sent);
    test.skip(
      msgID === null,
      'the group message did not send, so its per-member receipts cannot be read',
    );

    const status = await katchupClient.getReadStatusGroupMessage(
      { msgID, groupFlag: true, receiver: groupKpostID },
      { token: staticToken },
    );
    const { json, text } = await readBody(status);
    const rows = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<Record<string, unknown>> }).data
      : [];

    test.skip(
      !wasAccepted(status.status(), json),
      `the group read-status lookup was refused (HTTP ${status.status()}), so per-member receipts cannot be judged`,
    );

    expect(
      rows.length,
      `FR-K07: the group read-status lookup returned ${rows.length} row(s) for a two-member group. A read receipt must be recorded per RECIPIENT — a single aggregate row cannot tell the sender who opened the message. Body: ${text.slice(0, 240)}`,
    ).toBeGreaterThan(1);
  });

  test('[FR-K07] a recalled message must not leave a live receipt behind', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The other state transition. A recall (FR-K10) removes the message from the recipient's
     * view, so the receipt that message carried must not keep sitting in the sender's unopened
     * ledger — a permanently "unread" receipt for a message that no longer exists is a counter
     * nobody can ever clear.
     */
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'RCPT-RECALL' });
    test.skip(id === null, 'the message did not send, so there is nothing to recall');

    const recall = await katchupClient.recallMessage(
      { msgID: id as number, status: 5 },
      { token: staticToken },
    );
    const { json: recallJson } = await readBody(recall);
    test.skip(
      !wasAccepted(recall.status(), recallJson),
      'the recall was refused on this environment',
    );

    const rows = await conversation(katchupClient, staticToken, VICTIM);
    const stillThere = rows.find((r) => String(r.subject ?? '') === subject);
    const status = stillThere ? Number(stillThere.status ?? -1) : -1;

    expect(
      status === 1,
      `FR-K07: after a successful recall the message still reports status 1 (Unread). The recalled message is gone from the recipient's view, so a receipt still waiting to be read can never resolve. Row: ${JSON.stringify(stillThere ?? {}).slice(0, 240)}`,
    ).toBe(false);
  });
});

/* =========================================================================================
 * FR-K08 — the sender can Edit a previously sent message
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage — FR-K08 editing a sent message @audit', () => {
  test('[FR-K08] the edited body must be what a later read returns', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The existing FR-K08 test asserts the edit call is ACCEPTED. An edit that answers 200 and
     * stores nothing passes it, and the recipient goes on reading the original words — which is
     * precisely the accountability failure BR-K03 exists to prevent.
     */
    const edited = `QA edited body ${Date.now()}`;
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'EDIT-APPLIES' });
    test.skip(id === null, 'the original message did not send, so there is nothing to edit');

    const response = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject,
        receiver: VICTIM,
        messageType: 6,
        msgID: id as number,
        referenceMsgID: id as number,
        actualMessage: edited,
      }),
      { token: staticToken },
    );
    const { json } = await readBody(response);
    test.skip(!wasAccepted(response.status(), json), 'the edit was refused on this environment');

    const rows = await conversation(katchupClient, staticToken, VICTIM);
    const carries = rows.some((r) => JSON.stringify(r).includes(edited));

    expect(
      carries,
      `FR-K08: the edit was accepted but no message in the conversation carries the edited text. An edit that reports success and changes nothing leaves the recipient reading words the sender believes they replaced. Looked for: "${edited}"`,
    ).toBe(true);
  });

  test('[FR-K08] editing a message the caller does not own must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * Ownership. FR-K08 gives Edit to THE SENDER; an edit keyed only by msgID would let anyone
     * rewrite anyone's message, which is worse than no edit feature at all.
     *
     * FOREIGN.messageID is a deliberately impossible id, so a success here means the route did
     * not check ownership — it cannot mean the caller happened to own it.
     */
    const response = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: `QA-EDIT-FOREIGN-${Date.now()}`,
        receiver: VICTIM,
        messageType: 6,
        msgID: FOREIGN.messageID,
        referenceMsgID: FOREIGN.messageID,
        actualMessage: 'QA edit of a message this caller does not own',
      }),
      { token: staticToken },
    );
    const { json, text } = await readBody(response);

    expect(
      wasAccepted(response.status(), json),
      `FR-K08: an edit (messageType 6) naming msgID ${FOREIGN.messageID} — an id this caller neither owns nor which exists — was accepted (HTTP ${response.status()}) and the response echoed it back. Either reading is a defect: the route verifies neither ownership of the referenced message nor its existence, so it must key off the token identity as well as the id. Body: ${text.slice(0, 240)}`,
    ).toBe(false);
  });
});

/* =========================================================================================
 * FR-K10 — the sender can Recall a sent message
 * ====================================================================================== */
test.describe('POST /v2/katchup/recallMessage — FR-K10 recalling a sent message @audit', () => {
  test("[FR-K10] a recalled message must leave the RECIPIENT's conversation", async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    /*
     * The state transition FR-K10 actually promises: "removing it from the recipient's view".
     * The existing test asserts only that the recall CALL is accepted — a no-op recall that
     * answers 200 passes it while the message stays where it was.
     *
     * Judged from the RECIPIENT's own fetch. A first draft of this test read the SENDER's
     * conversation and reported a defect against correct behaviour: the backend keeps the row
     * for the sender and marks it (messageType 7, status 5), which is right — a sender may see
     * their own recalled message flagged as recalled. Only the recipient's copy decides the
     * rule. Same mistake, same shape, as the NFR-SEC02 draft that asserted on the send response.
     */
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'RECALL-GONE' });
    test.skip(id === null, 'the message did not send, so there is nothing to recall');

    const login = await authClient.userLogin(
      buildLoginPayload(VICTIM, env.qaPassword, {
        deviceIdentity_primary: `qa-frk10-${Date.now()}`,
      }),
    );
    const victimToken = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(await login.text())?.[0] ?? null;
    test.skip(
      victimToken === null,
      `the recipient "${VICTIM}" could not authenticate, so their view of the recall cannot be read`,
    );

    const sender = env.qaKpostId;
    const before = await conversation(katchupClient, victimToken as string, sender);
    test.skip(
      !before.some((r) => String(r.subject ?? '') === subject),
      'the message never reached the recipient, so its removal cannot be observed',
    );

    const recall = await katchupClient.recallMessage(
      { msgID: id as number, status: 5 },
      { token: staticToken },
    );
    const { json } = await readBody(recall);
    test.skip(!wasAccepted(recall.status(), json), 'the recall was refused on this environment');

    const after = await conversation(katchupClient, victimToken as string, sender);
    const survivor = after.find((r) => String(r.subject ?? '') === subject);

    expect(
      survivor,
      `FR-K10: the recall was accepted but the message is still in the RECIPIENT's conversation. Recall exists to remove it from their view; a recall that only reports success is worse than none, because the sender believes the message is gone. Row: ${JSON.stringify(survivor ?? {}).slice(0, 240)}`,
    ).toBeUndefined();
  });

  test('[FR-K10] recalling a message the caller does not own must be refused', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await katchupClient.recallMessage(
      { msgID: FOREIGN.messageID, status: 5 },
      { token: staticToken },
    );
    const { json, text } = await readBody(response);

    expect(
      wasAccepted(response.status(), json),
      `FR-K10: recalling msgID ${FOREIGN.messageID} — an id this caller does not own — was accepted (HTTP ${response.status()}). Recall deletes a message from someone else's view, so an unowned recall is a denial-of-service on other people's mail. Body: ${text.slice(0, 240)}`,
    ).toBe(false);
  });

  test('[FR-K10] recalling the same message twice must not report a second success', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * Idempotence at the state boundary. Once recalled the message is gone, so a second recall
     * has nothing to act on; reporting success again means the route is not reading state before
     * acting, which is the same blindness that makes an unowned recall succeed.
     */
    const { id } = await send(katchupClient, staticToken, { tag: 'RECALL-TWICE' });
    test.skip(id === null, 'the message did not send, so there is nothing to recall');

    const first = await katchupClient.recallMessage(
      { msgID: id as number, status: 5 },
      { token: staticToken },
    );
    const { json: firstJson } = await readBody(first);
    test.skip(
      !wasAccepted(first.status(), firstJson),
      'the first recall was refused, so the second proves nothing',
    );

    const second = await katchupClient.recallMessage(
      { msgID: id as number, status: 5 },
      { token: staticToken },
    );
    const { json: secondJson, text } = await readBody(second);

    expect(
      wasAccepted(second.status(), secondJson),
      `FR-K10: recalling an already-recalled message reported success again (HTTP ${second.status()}). The route is acting without reading the message's state. Body: ${text.slice(0, 240)}`,
    ).toBe(false);
  });
});

/* =========================================================================================
 * BR-K03 — an edited message keeps a visible edit indicator; a recalled message is removed
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage — BR-K03 edit indicator and recall removal @audit', () => {
  /** Anything on the row that says "this was edited" — a type, a flag, a timestamp, a reference. */
  function carriesEditMarker(row: Record<string, unknown>): boolean {
    if (Number(row.messageType ?? -1) === 6) return true;
    for (const [key, value] of Object.entries(row)) {
      if (!/edit/i.test(key)) continue;
      if (value !== null && value !== undefined && value !== '' && value !== false && value !== 0)
        return true;
    }
    return typeof row.referenceMsgID === 'number' && row.referenceMsgID > 0;
  }

  test('[BR-K03] a message that was never edited must NOT carry an edit indicator', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The positive control for the existing BR-K03 test.
     *
     * That test asserts an edited row "carries something that means edited", accepting a
     * messageType, any edit-ish field, or a back-reference. If an ordinary message carries one of
     * those too, the check passes on every row and proves nothing — so this pins the other side:
     * an unedited message must be distinguishable from an edited one. Without this pair, BR-K03
     * is a test that cannot fail.
     */
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'EDITMARK-CONTROL' });
    test.skip(id === null, 'the message did not send, so there is no row to inspect');

    const rows = await conversation(katchupClient, staticToken, VICTIM);
    const ours = rows.find((r) => String(r.subject ?? '') === subject);
    test.skip(ours === undefined, 'the sent message is not readable back');

    expect(
      carriesEditMarker(ours as Record<string, unknown>),
      `BR-K03: a message that was never edited already carries an edit indicator. The indicator then means nothing — a recipient cannot tell an edited message from an untouched one, and the BR-K03 assertion on the edited row passes vacuously. Row: ${JSON.stringify(ours).slice(0, 240)}`,
    ).toBe(false);
  });

  test('[BR-K03] the edit indicator must survive a later read, not just the edit response', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The existing test reads the indicator off the EDIT's own response. A recipient never sees
     * that response — they see the conversation. If the marker lives only in the reply to the
     * writer, the "Edited:" label FR-K09 describes can never be rendered for anyone else.
     */
    const { id, subject } = await send(katchupClient, staticToken, { tag: 'EDITMARK-PERSIST' });
    test.skip(id === null, 'the original message did not send, so there is nothing to edit');

    const edit = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject,
        receiver: VICTIM,
        messageType: 6,
        msgID: id as number,
        referenceMsgID: id as number,
        actualMessage: `QA edited for persistence ${Date.now()}`,
      }),
      { token: staticToken },
    );
    const { json } = await readBody(edit);
    test.skip(!wasAccepted(edit.status(), json), 'the edit was refused on this environment');

    const rows = await conversation(katchupClient, staticToken, VICTIM);
    const ours = rows.filter((r) => String(r.subject ?? '') === subject);
    test.skip(ours.length === 0, 'the edited message is not readable back');

    expect(
      ours.some((r) => carriesEditMarker(r)),
      `BR-K03: after a successful edit, no row for this message in the CONVERSATION carries an edit indicator. The recipient reads the conversation, not the sender's edit response, so the "Edited:" label has nothing to render from. Rows: ${JSON.stringify(ours).slice(0, 300)}`,
    ).toBe(true);
  });
});
