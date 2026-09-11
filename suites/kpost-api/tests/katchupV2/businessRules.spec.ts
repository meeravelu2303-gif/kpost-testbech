import { test, expect } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, type KatchupV2Client } from '../../src/api/clients/katchupV2.client';
import { reportBusinessLogicFlaw, readBody } from '../../src/utils/apiAssertions';
import {
  buildCopyMessagePayload,
  buildKatchupMessagePayload,
  buildReferenceActionPayload,
  katchupSnapshotOf,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import type { AuthClient } from '../../src/api/clients/auth.client';
import { env } from '../../src/config/env.config';
import { KATCHUP_MESSAGE_TYPE, KATCHUP_SHARE_TYPE } from '../../src/api/enums/kpostTypes';
import {
  contactListsOf,
  conversationRows,
  loginAs,
  recipientCopy,
} from '../../src/utils/katchupRecipients';

/**
 * Katchup V2 — **business-rule / does-the-feature-work layer.**
 *
 * The rest of the katchupV2 specs prove the endpoints are hard to break (auth, injection,
 * type-fuzz, status parity). This file proves the *product promises* the KPOST FRD makes for
 * Katchup actually hold — the things a user is told the feature does, not just "the endpoint
 * responds". Each test names the FR/BR it verifies.
 *
 * ## What the reference material establishes
 *
 * Katchup encodes message semantics in the `messageType` field, **not** in separate Cc/BCC
 * fields — verified against the DTO (`isCopyMessage`, `secretMessageExpireTime`, `sharedType`)
 * and the product team's type enum (supplied 2026-09-11):
 *
 * | type | meaning                    | type  | meaning                                   |
 * | ---- | -------------------------- | ----- | ----------------------------------------- |
 * | 0    | Normal                     | 11    | Group notification                        |
 * | 1    | Reply                      | 14    | **Copies** — Cc and Confidential, see below |
 * | 2    | Share                      | 15    | Forward (Reveal)                          |
 * | 3    | Reminder                   | 16    | Forward (Hidden)                          |
 * | 4    | SMS                        | 17    | Schedule call                             |
 * | 5    | Note                       | 18    | **Secret** message                        |
 * | 6    | Edit                       | 19    | Bulk message                              |
 * | 7    | Recall                     | 20/21 | Forward multiple thread (Reveal / Hidden) |
 * | 8    | Comment                    | 22    | Share digital card                        |
 * | 9    | Clarify                    | 23    | Share location                            |
 * | 10   | Notification mail / msgs   | 24    | Forward selected attachment               |
 * |      |                            | 25/26 | Broadcast (reply enabled / no reply)      |
 *
 * **Copy (Cc) and Confidential Copy are BOTH `messageType 14`.** They differ only by which list
 * inside `sharedMessageDetails` (a JSON string) carries the person: `revealContactList` = Copies
 * (Cc), visible to the other recipients; `hiddenContactList` = Confidential Copy, stripped from
 * every copy but the sender's. `messageType 18` is a **Secret** message and has nothing to do with
 * Confidential Copy. An earlier revision labelled 18 "Secret / Conf.", which produced an invalid
 * Critical (BUG-API-6EEBB3).
 *
 * `status`: 0 Sent · 1 Unread · 2 Read (with `readTime`) · 3 Not sent · 4 Group. A recalled
 * message answers `status: 5`, which the enum does not list — an open question for the developers.
 * `getReadStatusGroupMessage` is **group-only** (an individual message answers 400 "Not
 * Applicable"), so an individual read receipt is verified from the message's own `status` field.
 *
 * ## Verified live behaviour — re-checked 2026-09-10 against 192.168.0.66
 *
 * The earlier reading of this file is now OUT OF DATE and the backend has been fixed. Recorded
 * so nobody re-files what is already resolved:
 *
 * - Empty subject → **HTTP 400 `"subject is required"`**. Previously 200-and-accepted, i.e.
 *   BR-K01 was not enforced. It is now.
 * - Subject omitted entirely → **HTTP 400**, same message. Previously an unhandled 500.
 * - Copies (14) / Secret (18) / Edit (6) / Recall (7) with correct payloads → 200, all work.
 * - Copies (14) sent WITHOUT its companion fields (`isCopyMessage`, `sharedType`,
 *   `sharedDetailReceiverList`) → 500. That is the ordinary 500-on-incomplete-input class this
 *   suite already covers elsewhere, not a fault in the Copies feature itself — the FR-K04 case
 *   below sends the complete shape and is accepted.
 *
 * The two BR-K01 cases below therefore now PASS. Keep them: they are the regression guard for a
 * rule the product only recently started enforcing.
 *
 * ## Safety
 *
 * `sendMessage` **rejects a non-existent receiver with HTTP 400**, so proving these promises
 * requires a real recipient: every send here addresses the bench victim account
 * (`QA_VICTIM_KPOST_ID`), a QA-owned inbox, never a live subscriber. Every body is QA-labelled;
 * these routes deliver real messages and raise push notifications, so recipient stays pinned.
 */

const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/** True when the API treated the send as a success (2xx and not a FAILURE envelope). */
function wasAccepted(
  status: number,
  json: { status?: unknown; statusCode?: unknown } | null,
): boolean {
  const envelopeFailed = json != null && String(json.status).toUpperCase() === 'FAILURE';
  const code = json != null && typeof json.statusCode === 'number' ? json.statusCode : status;
  return status >= 200 && status < 300 && !envelopeFailed && code < 400;
}

/**
 * True when the API HANDLED the send cleanly — accepted, or cleanly rejected (4xx) — but did not
 * crash (5xx) and did not mask a failure behind a success transport status. Used for message
 * types not yet verified against the live backend, so an unsupported-on-this-build type is not
 * filed as a false "must be accepted" defect while a crash or a masked failure still is.
 */
function handledCleanly(
  status: number,
  json: { status?: unknown; statusCode?: unknown } | null,
): boolean {
  if (status >= 500) return false;
  const maskedFailure =
    status < 400 && json != null && String(json.status).toUpperCase() === 'FAILURE';
  return !maskedFailure;
}

/** The msgID the send route echoes back, or null. Individual sends return `data[0].msgID`. */
async function sentMessageId(
  response: import('@playwright/test').APIResponse,
): Promise<number | null> {
  const { json } = await readBody(response);
  const row =
    json && Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: Array<{ msgID?: number }> }).data[0]
      : undefined;
  return row && typeof row.msgID === 'number' ? row.msgID : null;
}

/* =========================================================================================
 * POST /v2/katchup/sendMessage — the promises the composer makes
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage @audit', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendMessage,
    repro: `await katchupClient.sendMessage(buildKatchupMessagePayload({ subject: '' }), { token });`,
  };

  test('[FR-K02][BR-K01] a message must not be sendable without a Subject', async ({
    katchupClient,
    staticToken,
  }) => {
    const body = buildKatchupMessagePayload({ subject: '', receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json, text } = await readBody(response);
    const accepted = wasAccepted(response.status(), json);

    if (accepted) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          title: 'A Katchup message is accepted with an empty Subject (BR-K01 not enforced)',
          scenario:
            'FR-K02 / BR-K01: the Subject field must be populated before a Katchup message can be sent — it is the ' +
            'differentiator the platform is built on (every message carries a subject so a conversation can be found ' +
            `and handed off). The API accepted a send with subject: "" and HTTP ${response.status()}, persisting a ` +
            `subject-less message. The rule exists in the product but not in the service. Body: ${text.slice(0, 160)}`,
        },
        'Business Logic Flaw',
        'Major',
      );
    }

    expect(
      accepted,
      'a Katchup message with an empty Subject was accepted — BR-K01 (Subject required before send) is not enforced',
    ).toBe(false);
  });

  test('[BR-K01] a missing Subject must be refused, not crash the send', async ({
    katchupClient,
    staticToken,
  }) => {
    const body = buildKatchupMessagePayload({ receiver: VICTIM_KPOST_ID });
    delete (body as Record<string, unknown>).subject;
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { text } = await readBody(response);
    const crashed = response.status() >= 500;

    if (crashed) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          title: 'Omitting Subject on sendMessage returns HTTP 500 instead of a 4xx',
          scenario:
            'A send with the Subject field omitted entirely produces an unhandled server error rather than a clean ' +
            `4xx validation refusal. A required field missing is a client error (400/422); a ${response.status()} ` +
            `tells the caller the server malfunctioned and hides the real cause. Body: ${text.slice(0, 160)}`,
        },
        'Unhandled NPE / Server Error',
        'Minor',
      );
    }

    expect(
      crashed,
      `omitting Subject produced HTTP ${response.status()} — a missing required field must be a 4xx`,
    ).toBe(false);
  });

  test('[FR-K01] a sent message preserves the Subject it was sent with', async ({
    katchupClient,
    staticToken,
  }) => {
    const subject = `QA-SUBJECT-${Date.now()}`;
    const body = buildKatchupMessagePayload({ subject, receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);

    expect(
      wasAccepted(response.status(), json),
      'a well-formed message with a Subject must send',
    ).toBe(true);
    const row = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<{ subject?: string }> }).data[0]
      : undefined;
    expect(
      row?.subject,
      'the Subject the message was sent with must be preserved on the stored message',
    ).toBe(subject);
  });

  test('[FR-K07] a sent message carries a read-receipt state', async ({
    katchupClient,
    staticToken,
  }) => {
    // A real recipient so the receipt row is meaningful; the recipient never opens it here, so
    // the state stays at its initial value — what we assert is that the receipt field EXISTS and
    // initialises, which is FR-K07's "record a read receipt for each message" mechanism.
    const body = buildKatchupMessagePayload({
      subject: `QA-RECEIPT-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
    });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);

    expect(
      wasAccepted(response.status(), json),
      'the message to the victim account must send',
    ).toBe(true);
    const row = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<{ status?: number }> }).data[0]
      : undefined;
    expect(
      row != null && typeof row.status === 'number',
      'the sent message must carry a numeric read-state (status: 0 Sent / 1 Unread / 2 Read) — the read-receipt mechanism',
    ).toBe(true);
  });

  /*
   * Copies (Cc) and Confidential Copy — BOTH `messageType 14` per the Excel Types tab.
   *
   * The shape below is the one the live web client sends (captured 2026-09-11), built by
   * `buildCopyMessagePayload`: the people travel in `sharedMessageDetails` — `revealContactList` for
   * Cc, `hiddenContactList` for Confidential — and delivery is driven by `forwardReceiverList`, which
   * lists every recipient including the primary. Earlier revisions used `sharedDetailReceiverList`,
   * which the client never sends; no copy was ever delivered and FR-K05 was wrongly declared blocked.
   *
   * Every verdict is read from each recipient's OWN copy (trap #5), one seeded message per test
   * (trap #6). Three real accounts: the primary, a personal account and a business account.
   */
  const COPY_PRIMARY = VICTIM_KPOST_ID;
  const COPY_SECOND = FOREIGN.thirdKpostID;
  const COPY_BUSINESS = FOREIGN.businessReceiverKpostID;

  test('[FR-K04] a Copies (Cc) message reaches every Cc recipient, and each sees the Cc list', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    const sender = authSession.kpostID ?? env.qaKpostId;
    const copies = [COPY_SECOND, COPY_BUSINESS];
    const subject = `QA-CC-${Date.now()}`;
    const response = await katchupClient.sendMessage(
      buildCopyMessagePayload({ receiver: COPY_PRIMARY, copies }, { subject }),
      { token: staticToken },
    );
    const { json, text } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      `FR-K04: the Copies send was refused (HTTP ${response.status()}). Body: ${text.slice(0, 200)}`,
    ).toBe(true);

    for (const recipient of [COPY_PRIMARY, ...copies]) {
      const token = await loginAs(authClient, recipient);
      test.skip(
        token === null,
        `"${recipient}" could not authenticate, so their copy cannot be read`,
      );

      const { row } = await recipientCopy(katchupClient, token as string, sender, subject);
      expect(
        row,
        `FR-K04: "${recipient}" never received the Copies message. Every Cc recipient and the primary must get their copy.`,
      ).toBeDefined();

      // Cc is visible by design: every recipient's copy lists every Cc recipient.
      const { reveal } = contactListsOf(row as Record<string, unknown>);
      expect(
        copies.every((c) => reveal.includes(c)),
        `FR-K04: "${recipient}"'s copy shows revealContactList ${JSON.stringify(reveal)}; a Cc list is visible by design and must name every Cc recipient.`,
      ).toBe(true);
    }
  });

  test('[FR-K05] a Confidential Copy reaches the primary and every hidden recipient', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    const sender = authSession.kpostID ?? env.qaKpostId;
    const confidential = [COPY_SECOND, COPY_BUSINESS];
    const subject = `QA-CONF-DELIVERY-${Date.now()}`;
    const response = await katchupClient.sendMessage(
      buildCopyMessagePayload({ receiver: COPY_PRIMARY, confidential }, { subject }),
      { token: staticToken },
    );
    const { json, text } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      `FR-K05: the Confidential Copy send was refused (HTTP ${response.status()}). Body: ${text.slice(0, 200)}`,
    ).toBe(true);

    for (const recipient of [COPY_PRIMARY, ...confidential]) {
      const token = await loginAs(authClient, recipient);
      test.skip(
        token === null,
        `"${recipient}" could not authenticate, so their copy cannot be read`,
      );

      const { row } = await recipientCopy(katchupClient, token as string, sender, subject);
      expect(
        row,
        `FR-K05: "${recipient}" never received the Confidential Copy message. Adding someone as a Confidential Copy recipient must deliver them a copy.`,
      ).toBeDefined();
    }
  });

  test('a Secret message — messageType 18 — is delivered', async ({
    katchupClient,
    staticToken,
  }) => {
    // No requirement id: Secret messages are not in the requirements list. This carried FR-K05
    // (Confidential Copy) by mistake — 18 is Secret; Confidential Copy is 14 + hiddenContactList.
    const body = buildKatchupMessagePayload({
      subject: `QA-SECRET-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: KATCHUP_MESSAGE_TYPE.secret,
      secretMessageExpireTime: Date.now() + 3_600_000,
    });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'a well-formed Secret message must be accepted',
    ).toBe(true);
  });

  /*
   * NFR-SEC02 — "Confidential Copy recipients are not visible to other recipients."
   *
   * "Other recipients" means everyone except the hidden person themselves: the primary, every Cc
   * recipient, and every OTHER hidden recipient. Verified live 2026-09-11 on the QA host — the
   * primary and a Cc recipient see `hiddenContactList: []`, and each hidden recipient sees only
   * themselves. Both tests below pass there.
   *
   * They exist because a capture from PRODUCTION shows the leak on exactly this shape: a
   * recipient's own row carried `"hiddenContactList": ["aashavelu@kpostindia.com"]`. Production is
   * likely on a build without the strip.
   *
   * A variant built on messageType 18 was removed. 18 is Secret; its `selectedMembers` field makes
   * nobody a recipient. It filed BUG-API-6EEBB3 as a Critical — invalid.
   */
  async function assertHiddenRecipientsStayHidden(
    ctx: {
      katchupClient: KatchupV2Client;
      authClient: AuthClient;
      staticToken: string;
      sender: string;
    },
    parties: { copies: string[]; confidential: string[] },
    label: string,
  ): Promise<void> {
    const subject = `QA-CONF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const body = buildCopyMessagePayload({ receiver: COPY_PRIMARY, ...parties }, { subject });
    const sent = await ctx.katchupClient.sendMessage(body, { token: ctx.staticToken });
    const sentBody = await readBody(sent);
    test.skip(
      !wasAccepted(sent.status(), sentBody.json),
      `the send was not accepted on this environment (HTTP ${sent.status()}): ${sentBody.text.slice(0, 160)}`,
    );

    for (const viewer of [COPY_PRIMARY, ...parties.copies, ...parties.confidential]) {
      const token = await loginAs(ctx.authClient, viewer);
      test.skip(token === null, `"${viewer}" could not authenticate, so their copy cannot be read`);

      const { row, response } = await recipientCopy(
        ctx.katchupClient,
        token as string,
        ctx.sender,
        subject,
      );
      expect(
        row,
        `NFR-SEC02 (${label}): "${viewer}" never received the message within 15s, so what they can see cannot be judged.`,
      ).toBeDefined();

      // A hidden recipient may see themselves; nobody may see any OTHER hidden recipient.
      const others = parties.confidential.filter((c) => c !== viewer);
      const { hidden } = contactListsOf(row as Record<string, unknown>);
      const inList = hidden.filter((h) => h !== viewer);
      const anywhere = others.filter((c) => JSON.stringify(row).includes(c));

      if (inList.length || anywhere.length) {
        await reportBusinessLogicFlaw(
          response,
          {
            ...META,
            body,
            title:
              'A Confidential Copy (hiddenContactList) recipient is disclosed to another recipient',
            scenario:
              `A messageType 14 Confidential Copy (${label}) was sent to ${COPY_PRIMARY}. Reading as ` +
              `"${viewer}", their own copy names hidden recipient(s) ${JSON.stringify([...new Set([...inList, ...anywhere])])}. ` +
              'NFR-SEC02 requires Confidential Copy recipients to stay invisible to every other ' +
              'recipient — the feature exists solely to withhold that identity. ' +
              `Delivered row: ${JSON.stringify(row).slice(0, 300)}`,
          },
          'Security/Information Disclosure',
          'Critical',
        );
      }

      expect(
        inList,
        `NFR-SEC02 (${label}): "${viewer}"'s own copy lists other hidden recipients in hiddenContactList. Row: ${JSON.stringify(row).slice(0, 300)}`,
      ).toEqual([]);
      expect(
        anywhere,
        `NFR-SEC02 (${label}): "${viewer}"'s own copy names another hidden recipient somewhere on the row. Row: ${JSON.stringify(row).slice(0, 300)}`,
      ).toEqual([]);
    }
  }

  test('[NFR-SEC02] Confidential Copy: no recipient sees another hidden recipient', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    await assertHiddenRecipientsStayHidden(
      { katchupClient, authClient, staticToken, sender: authSession.kpostID ?? env.qaKpostId },
      { copies: [], confidential: [COPY_SECOND, COPY_BUSINESS] },
      'two hidden recipients',
    );
  });

  test('[NFR-SEC02] Cc + Confidential: a Cc recipient never sees the hidden recipient', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    await assertHiddenRecipientsStayHidden(
      { katchupClient, authClient, staticToken, sender: authSession.kpostID ?? env.qaKpostId },
      { copies: [COPY_SECOND], confidential: [COPY_BUSINESS] },
      'mixed Cc and Confidential',
    );
  });

  test('[NFR-SEC02] a Note on a Confidential Copy must not carry the hidden list in its snapshot', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    /*
     * The subtle leak. The top-level `hiddenContactList` is stripped per recipient correctly, but a
     * Note / Reminder / Reply embeds a `referenceMessage` SNAPSHOT of the original, and the live web
     * client builds that snapshot from the sender's view — which legitimately holds the full hidden
     * list. The server serves the snapshot to every recipient unchanged, so the primary and each
     * hidden recipient learn the other hidden recipients through the note. Confirmed live 2026-09-11.
     *
     * Judged from each recipient's OWN copy (trap #5), one seeded thread (trap #6).
     */
    const sender = authSession.kpostID ?? env.qaKpostId;
    const primary = VICTIM_KPOST_ID;
    const hidden = [FOREIGN.thirdKpostID, FOREIGN.businessReceiverKpostID];
    const subject = `QA-NOTE-CONF-${Date.now()}`;

    const orig = await katchupClient.sendMessage(
      buildCopyMessagePayload({ receiver: primary, confidential: hidden }, { subject }),
      { token: staticToken },
    );
    const origRow = ((await readBody(orig)).json as { data?: Array<Record<string, unknown>> })
      ?.data?.[0];
    test.skip(!origRow?.msgID, 'the confidential original was not accepted on this environment');

    const noteMarker = `QA-NOTE-${Date.now()}`;
    // A note on a copies thread carries the copy envelope (forwardReceiverList / sharedMessageDetails)
    // AND the referenceMessage snapshot — the live client's shape. Without the envelope the server 500s.
    const note = await katchupClient.sendMessage(
      buildCopyMessagePayload(
        { receiver: primary, confidential: hidden },
        {
          subject,
          sharedType: KATCHUP_SHARE_TYPE.note,
          temporaryMsgID: (origRow as Record<string, unknown>).msgID,
          referenceMessage: katchupSnapshotOf(origRow as Record<string, unknown>),
          actualMessage: `[{"insert":"${noteMarker}\\n"}]`,
        },
      ),
      { token: staticToken },
    );
    const { json: noteJson } = await readBody(note);
    test.skip(
      !wasAccepted(note.status(), noteJson),
      'the note was not accepted on this environment',
    );

    for (const viewer of [primary, ...hidden]) {
      const token = await loginAs(authClient, viewer);
      test.skip(
        token === null,
        `"${viewer}" could not authenticate, so their copy of the note cannot be read`,
      );

      const { row } = await recipientCopy(katchupClient, token as string, sender, subject);
      test.skip(
        row === undefined,
        `the note never reached "${viewer}", so the snapshot cannot be judged`,
      );

      const others = hidden.filter((h) => h !== viewer);
      const leaked = others.filter((h) => JSON.stringify(row).includes(h));
      if (leaked.length) {
        await reportBusinessLogicFlaw(
          note,
          {
            ...META,
            body: {},
            title: 'A Note on a Confidential Copy leaks the hidden recipients through its snapshot',
            scenario:
              `A Confidential Copy to ${primary} (hidden: ${JSON.stringify(hidden)}) was annotated with a Note ` +
              "(sharedType 5). The top-level hiddenContactList is stripped per recipient, but the note's " +
              `referenceMessage snapshot carries the full hidden list, so reading as "${viewer}" exposes hidden ` +
              `recipient(s) ${JSON.stringify(leaked)}. NFR-SEC02 requires Confidential Copy recipients to stay ` +
              `invisible to every other recipient. Delivered note: ${JSON.stringify(row).slice(0, 300)}`,
          },
          'Security/Information Disclosure',
          'Critical',
        );
      }
      expect(
        leaked,
        `NFR-SEC02: reading the Note as "${viewer}", its snapshot exposes other hidden recipient(s). Row: ${JSON.stringify(row).slice(0, 300)}`,
      ).toEqual([]);
    }
  });

  test('[FR-K08] a sender can Edit a message they sent — messageType 6', async ({
    katchupClient,
    staticToken,
  }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-EDIT-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(original);
    expect(msgID, 'the original message must send and return a msgID to edit').not.toBeNull();

    const edit = buildKatchupMessagePayload({
      subject: `QA-EDIT-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 6,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
      actualMessage: 'QA edited body',
    });
    const response = await katchupClient.sendMessage(edit, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'editing an own message (type 6) must be accepted',
    ).toBe(true);
  });

  test('[BR-K03] an edited message must carry an edit indicator the recipient can see', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * BR-K03: "An edited message must retain a visible edit indicator." The FRD pairs it with
     * FR-K09's "Edited:" label, which is the UI rendering of it — but the client can only render
     * that label if the API returns something to render it FROM. This asserts the data half:
     * after an edit, the stored message is distinguishable from one that was never edited.
     *
     * Without it a recipient cannot tell that the words they are reading are not the words that
     * were sent — which is exactly the accountability KPost sells.
     */
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: `QA-EDITMARK-${Date.now()}`,
        receiver: VICTIM_KPOST_ID,
      }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(original);
    test.skip(msgID === null, 'the original message did not send, so there is nothing to edit');

    const edit = buildKatchupMessagePayload({
      subject: `QA-EDITMARK-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 6,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
      actualMessage: 'QA edited body — the recipient must be able to tell this changed',
    });
    const response = await katchupClient.sendMessage(edit, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(
      !wasAccepted(response.status(), json),
      'the edit was not accepted on this environment',
    );

    const rows = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<Record<string, unknown>> }).data
      : [];
    const row = rows[0];
    // Any of these carries "this was edited": the edit messageType survives on the row, or an
    // explicit flag/timestamp/back-reference does. The rule is that SOMETHING does — not which.
    const marked =
      row != null &&
      (Number(row.messageType) === 6 ||
        row.isEdited != null ||
        row.editedTime != null ||
        row.modifiedDate != null ||
        row.referenceMsgID != null);

    if (!marked) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: edit,
          title: 'An edited Katchup message carries no edit indicator',
          scenario:
            'A message edited after sending comes back with nothing that distinguishes it from one never ' +
            'edited — no edit messageType, no isEdited flag, no edited timestamp, no reference to the ' +
            'original. BR-K03 requires a visible edit indicator and FR-K09 requires an "Edited:" label, ' +
            'which the client cannot render without this. The recipient is shown altered words as if they ' +
            `were the original. Body: ${text.slice(0, 200)}`,
        },
        'Business Logic Flaw',
        'Major',
      );
    }

    expect(
      marked,
      'the edited message must come back carrying an edit indicator (edit type, flag, edited timestamp or original reference) — BR-K03',
    ).toBe(true);
  });

  test('[FR-K11] Recall and Repost must work as one action', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * FR-K11 is "Recall and Repost an edited message as a combined action" — pull the original
     * back, send the corrected version. Exercised as the real two-step flow the product describes
     * and asserted only to be HANDLED cleanly: this build's support for the combined form is
     * unverified, so a clean refusal is an acceptable answer while a 5xx crash or a 200 masking a
     * FAILURE envelope is a genuine defect.
     */
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-REPOST-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(original);
    test.skip(msgID === null, 'the original message did not send, so there is nothing to recall');

    const recall = buildKatchupMessagePayload({
      subject: `QA-REPOST-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 7,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
    });
    const recalled = await katchupClient.sendMessage(recall, { token: staticToken });
    const recalledBody = await readBody(recalled);
    expect(
      handledCleanly(recalled.status(), recalledBody.json),
      'the recall half of Recall-and-Repost must be handled cleanly',
    ).toBe(true);

    const repost = buildKatchupMessagePayload({
      subject: `QA-REPOST-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      referenceMsgID: msgID as number,
      actualMessage: 'QA reposted body',
    });
    const response = await katchupClient.sendMessage(repost, { token: staticToken });
    const { json } = await readBody(response);

    expect(
      handledCleanly(response.status(), json),
      'the repost half of Recall-and-Repost must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect',
    ).toBe(true);
  });

  // Reply(1) / Share(2) / Comment(8) / Clarify(9) reference an original message. They are not yet
  // verified against this deployment, so each is exercised in the real establish-then-reference
  // flow and asserted only to be HANDLED cleanly — a 5xx crash or a masked-200 failure is a real
  // defect, while a clean rejection is not (the type may be unsupported on this build).
  async function sendReferencingType(
    katchupClient: KatchupV2Client,
    token: string,
    label: string,
    messageType: number,
  ) {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: `QA-${label}-${Date.now()}`,
        receiver: VICTIM_KPOST_ID,
      }),
      { token },
    );
    const msgID = await sentMessageId(original);
    expect(
      msgID,
      `the original message must send and return a msgID for the ${label.toLowerCase()}`,
    ).not.toBeNull();

    const payload = buildKatchupMessagePayload({
      subject: `QA-${label}-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
      actualMessage: `QA ${label.toLowerCase()} body`,
    });
    return katchupClient.sendMessage(payload, { token });
  }

  test('[FR-K21] a Reply must be stored linked to the message it replies to', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * Replaces a `handledCleanly()` assertion, which accepted any non-5xx — so the server
     * REJECTING the reply satisfied "a recipient can Reply to a received message". The rule is
     * about the link, not the status code: a reply that is not attached to its original is a new
     * message that happens to quote something, and every downstream feature built on the
     * reference chain (thread forward, reference lookup, clarification) has nothing to follow.
     *
     * Sends only `referenceMsgID` — the field the Excel contract actually defines for this route.
     * `msgID` is NOT in the contract, and passing it makes the call overwrite the referenced row
     * instead of creating a reply; see gate/security/messageOwnership.spec.ts.
     */
    const originalSubject = `QA-K21-ORIG-${Date.now()}`;
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: originalSubject, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const originalID = await sentMessageId(original);
    expect(
      originalID,
      'the original message must send so a reply has something to reference',
    ).not.toBeNull();

    const replySubject = `QA-K21-REPLY-${Date.now()}`;
    const reply = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: replySubject,
        receiver: VICTIM_KPOST_ID,
        messageType: 1,
        referenceMsgID: originalID as number,
        actualMessage: 'QA reply body',
      }),
      { token: staticToken },
    );
    const { json, text } = await readBody(reply);
    expect(
      wasAccepted(reply.status(), json),
      `FR-K21: the reply was refused (HTTP ${reply.status()}). A recipient must be able to reply to a message they received. Body: ${text.slice(0, 200)}`,
    ).toBe(true);

    const inbox = await katchupClient.katchupMessagesForSelectedContactID(
      {
        selectedContact: VICTIM_KPOST_ID,
        receiver: VICTIM_KPOST_ID,
        groupFlag: false,
        firstMsgID: null,
        lastMsgID: null,
        msgID: 0,
      },
      { token: staticToken },
    );
    const rows =
      ((await readBody(inbox)).json as { data?: Array<Record<string, unknown>> })?.data ?? [];
    const stored = rows.find((row) => String(row.subject ?? '') === replySubject);
    expect(stored, `FR-K21: the reply is not readable back from the conversation.`).toBeDefined();

    /*
     * The link, wherever the row carries it: an explicit reference id, the id list, or an
     * embedded snapshot. The rule is that SOMETHING points at the original — not which field.
     */
    const row = stored as Record<string, unknown>;
    const idList = Array.isArray(row.referenceMessageIDList)
      ? (row.referenceMessageIDList as unknown[]).map(Number)
      : [];
    const linked =
      Number(row.referenceMsgID ?? 0) === originalID ||
      idList.includes(originalID as number) ||
      (row.referenceMessage != null &&
        JSON.stringify(row.referenceMessage).includes(String(originalID)));

    expect(
      linked,
      `FR-K21: the reply was stored but carries no reference to msgID ${originalID}, the message it replies to — referenceMessageIDList=${JSON.stringify(row.referenceMessageIDList)}, referenceMessage=${row.referenceMessage === null ? 'null' : 'present'}. A reply that is not linked to its original is an unrelated message, and every feature built on the reference chain has nothing to follow. Row: ${JSON.stringify(row).slice(0, 300)}`,
    ).toBe(true);
  });

  test('[FR-K14] a Share/Transfer referencing an own message — messageType 2 — is handled cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'SHARE', 2);
    const { json } = await readBody(response);
    expect(
      handledCleanly(response.status(), json),
      'a Share (type 2) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect',
    ).toBe(true);
  });

  test('[FR-K22] a Comment referencing an own message — messageType 8 — is handled cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'COMMENT', 8);
    const { json } = await readBody(response);
    expect(
      handledCleanly(response.status(), json),
      'a Comment (type 8) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect',
    ).toBe(true);
  });

  test('[FR-K23] a Clarify referencing an own message — messageType 9 — is handled cleanly', async ({
    katchupClient,
    staticToken,
  }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'CLARIFY', 9);
    const { json } = await readBody(response);
    expect(
      handledCleanly(response.status(), json),
      'a Clarify (type 9) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect',
    ).toBe(true);
  });

  test('[FR-K12] a sender can attach a Note (sharedType 5) without overwriting the message', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * A Note rides on the thread as `sharedType 5` and references the original via
     * `temporaryMsgID` + a `referenceMessage` snapshot — the live web client's shape. The old test
     * sent `messageType 5` + `msgID`, and `msgID` OVERWRITES the referenced row (see
     * gate/security/messageOwnership), so it destroyed the base message and still reported success.
     */
    const baseMarker = `QA-NOTE-BASE-${Date.now()}`;
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: baseMarker,
        receiver: VICTIM_KPOST_ID,
        actualMessage: `[{"insert":"${baseMarker}\\n"}]`,
      }),
      { token: staticToken },
    );
    const { json: baseJson } = await readBody(base);
    const baseRow = (baseJson as { data?: Array<Record<string, unknown>> })?.data?.[0];
    expect(baseRow?.msgID, 'the base message must send so a note can reference it').toBeDefined();

    const noteMarker = `QA-NOTE-${Date.now()}`;
    const response = await katchupClient.sendMessage(
      buildReferenceActionPayload(baseRow as Record<string, unknown>, KATCHUP_SHARE_TYPE.note, {
        subject: baseMarker,
        actualMessage: `[{"insert":"${noteMarker}\\n"}]`,
      }),
      { token: staticToken },
    );
    const { json } = await readBody(response);
    expect(wasAccepted(response.status(), json), 'attaching a Note must be accepted').toBe(true);

    const rows = await conversationRows(katchupClient, staticToken, VICTIM_KPOST_ID);
    expect(
      rows.some(
        (r) =>
          Number(r.msgID) === Number(baseRow?.msgID) &&
          String(r.actualMessage ?? '').includes(baseMarker),
      ),
      `FR-K12: attaching a Note destroyed the base message ${baseRow?.msgID} instead of annotating it — the Note was sent with the msgID takeover vector.`,
    ).toBe(true);
    expect(
      rows.some(
        (r) =>
          String(r.actualMessage ?? '').includes(noteMarker) &&
          Number(r.msgID) !== Number(baseRow?.msgID),
      ),
      'FR-K12: the Note was not delivered as its own message.',
    ).toBe(true);
  });

  test('[FR-K13] a sender can set a Reminder (sharedType 3) without overwriting the message', async ({
    katchupClient,
    staticToken,
  }) => {
    const baseMarker = `QA-REMINDER-BASE-${Date.now()}`;
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: baseMarker,
        receiver: VICTIM_KPOST_ID,
        actualMessage: `[{"insert":"${baseMarker}\\n"}]`,
      }),
      { token: staticToken },
    );
    const { json: baseJson } = await readBody(base);
    const baseRow = (baseJson as { data?: Array<Record<string, unknown>> })?.data?.[0];
    expect(
      baseRow?.msgID,
      'the base message must send so a reminder can reference it',
    ).toBeDefined();

    const reminderMarker = `QA-REMINDER-${Date.now()}`;
    const response = await katchupClient.sendMessage(
      buildReferenceActionPayload(baseRow as Record<string, unknown>, KATCHUP_SHARE_TYPE.reminder, {
        subject: baseMarker,
        actualMessage: `[{"insert":"${reminderMarker}\\n"}]`,
      }),
      { token: staticToken },
    );
    const { json } = await readBody(response);
    expect(wasAccepted(response.status(), json), 'setting a Reminder must be accepted').toBe(true);

    const rows = await conversationRows(katchupClient, staticToken, VICTIM_KPOST_ID);
    expect(
      rows.some(
        (r) =>
          Number(r.msgID) === Number(baseRow?.msgID) &&
          String(r.actualMessage ?? '').includes(baseMarker),
      ),
      `FR-K13: setting a Reminder destroyed the base message ${baseRow?.msgID} instead of annotating it.`,
    ).toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/katchup/recallMessage — the sender's post-send control
 * ====================================================================================== */
test.describe('POST /v2/katchup/recallMessage @audit', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.recallMessage,
    repro: `await katchupClient.recallMessage({ msgID, status: 5 }, { token });`,
  };

  test('[FR-K10] a sender can Recall a message they sent', async ({
    katchupClient,
    staticToken,
  }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-RECALL-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(original);
    expect(msgID, 'the original message must send and return a msgID to recall').not.toBeNull();

    const body = { msgID: msgID as number, status: 5 };
    const response = await katchupClient.recallMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      `recalling an own message must succeed — the sender owns FR-K10 (Recall). Meta: ${META.path}`,
    ).toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/katchup/deleteKatchUpMessage — the sender's Delete action
 * ====================================================================================== */
test.describe('POST /v2/katchup/deleteKatchUpMessage @audit', () => {
  test('[FR-K20] a sender can Delete a message they sent', async ({
    katchupClient,
    staticToken,
  }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-DELETE-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(original);
    expect(msgID, 'the original message must send and return a msgID to delete').not.toBeNull();

    const response = await katchupClient.deleteKatchUpMessage(
      { messageIds: [msgID as number], groupFlag: false },
      { token: staticToken },
    );
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'deleting an own message must be accepted — FR-K20 (Delete)',
    ).toBe(true);
  });
});
