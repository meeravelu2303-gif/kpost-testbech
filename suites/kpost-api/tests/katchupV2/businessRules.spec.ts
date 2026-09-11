import { test, expect } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, type KatchupV2Client } from '../../src/api/clients/katchupV2.client';
import { reportBusinessLogicFlaw, readBody } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { buildLoginPayload } from '../../src/api/payloads/auth.payload';
import type { AuthClient } from '../../src/api/clients/auth.client';
import { env } from '../../src/config/env.config';

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
 * and the KPOST API reference sheet. So "Copy (Cc)" and "Confidential Copy" are message *types*,
 * exercised here with their real payloads rather than a non-existent `cc` field:
 *
 * | type | meaning        | FR        | type | meaning        | FR        |
 * | ---- | -------------- | --------- | ---- | -------------- | --------- |
 * | 0    | Normal         | FR-K01    | 7    | Recall         | FR-K10    |
 * | 6    | Edit           | FR-K08    | 14   | Copies (Cc)    | FR-K04    |
 * |      |                |           | 18   | Secret / Conf. | FR-K05    |
 *
 * `status` carries the read-receipt state: 0 Sent · 1 Unread · 2 Read (with `readTime`).
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

  test('[FR-K04] a Copies (Cc) message — messageType 14 — is delivered', async ({
    katchupClient,
    staticToken,
  }) => {
    // Cc is a message TYPE (14 = Copies), not a `cc` field. The copies flow needs its own shape.
    const body = buildKatchupMessagePayload({
      subject: `QA-CC-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 14,
      isCopyMessage: true,
      sharedType: 2,
      sharedDetailReceiverList: [VICTIM_KPOST_ID],
    });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'a well-formed Copies (Cc) message must be accepted',
    ).toBe(true);
  });

  test('[FR-K05] a Secret / Confidential message — messageType 18 — is delivered', async ({
    katchupClient,
    staticToken,
  }) => {
    const body = buildKatchupMessagePayload({
      subject: `QA-SECRET-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 18,
      secretMessageExpireTime: Date.now() + 3_600_000,
    });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'a well-formed Secret (Confidential) message must be accepted',
    ).toBe(true);
  });

  /*
   * NFR-SEC02 — "Confidential Copy recipients shall not be visible to other recipients."
   *
   * TWO SHAPES carry a confidential party, and they are serialised by different code:
   *
   *   A. messageType 18                 — the party sits in `selectedMembers`.
   *   B. messageType 14 / sharedType 14 — the party sits in
   *      `sharedMessageDetails.hiddenContactList`, a JSON *string* field.
   *
   * Only A was covered. A live capture from the production API shows the leak on B: the
   * recipient's own row came back carrying `"hiddenContactList": ["aashavelu@kpostindia.com"]`.
   * In the SAME response the reference-snapshot copy of that message — embedded in another row's
   * `referenceMessage` — had `hiddenContactList` empty. So a stripping step exists on the
   * snapshot path and not on the direct read: two serialisers, one rule, one of them applying it.
   *
   * Written as data plus two literal tests rather than a loop. Each variant must report its own
   * verdict — "one of them leaks" is not an actionable ticket — and a loop collapses to a single
   * `test(` line, which the traceability depth count and the gate auditor both read as one test.
   */
  type ConfidentialVariant = {
    readonly label: string;
    readonly build: (args: {
      subject: string;
      primary: string;
      confidential: string;
    }) => Record<string, unknown>;
  };

  const CONFIDENTIAL_VARIANTS = {
    typeEighteen: {
      label: 'messageType 18, party in selectedMembers',
      build: ({ subject, primary, confidential }) =>
        buildKatchupMessagePayload({
          subject,
          receiver: primary,
          messageType: 18,
          selectedMembers: confidential,
          secretMessageExpireTime: Date.now() + 3_600_000,
        }),
    },
    sharedFourteen: {
      label: 'messageType 14 / sharedType 14, party in sharedMessageDetails.hiddenContactList',
      build: ({ subject, primary, confidential }) =>
        buildKatchupMessagePayload({
          subject,
          receiver: primary,
          messageType: 14,
          sharedType: 14,
          isCopyMessage: true,
          sharedDetailReceiverList: [primary],
          // A JSON *string* — that is how the API both accepts and returns this field.
          sharedMessageDetails: JSON.stringify({
            receiver: primary,
            receiverName: 'QA Primary',
            hiddenContactList: [confidential],
            revealContactList: [],
          }),
        }),
    },
  } satisfies Record<string, ConfidentialVariant>;

  /** Every hiddenContactList on a row, whether the field arrives as a JSON string or an object. */
  function hiddenContactsOf(row: Record<string, unknown>): string[] {
    const out: string[] = [];
    const visit = (value: unknown): void => {
      if (value == null) return;
      if (typeof value === 'string') {
        if (!value.includes('hiddenContactList')) return;
        try {
          visit(JSON.parse(value) as unknown);
        } catch {
          // Not JSON. The whole-row substring assertion still covers it.
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'hiddenContactList' && Array.isArray(item)) out.push(...item.map(String));
          else visit(item);
        }
      }
    };
    visit(row);
    return out;
  }

  /**
   * Sends one variant and judges it from the RECIPIENT's own fetch.
   *
   * Delivery is AWAITED with `expect.poll`, not skipped past. A Critical that quietly skips
   * because the message had not landed yet is a Critical nobody ever sees; if it never arrives
   * inside the window that is a failure, because the rule cannot be verified either way.
   */
  async function assertConfidentialPartyHidden(
    variant: ConfidentialVariant,
    ctx: {
      katchupClient: KatchupV2Client;
      authClient: AuthClient;
      staticToken: string;
      sender: string;
    },
  ): Promise<void> {
    const confidential = VICTIM_KPOST_ID;
    const primary = FOREIGN.businessReceiverKpostID;
    const subject = `QA-CONF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const body = variant.build({ subject, primary, confidential });

    const response = await ctx.katchupClient.sendMessage(body, { token: ctx.staticToken });
    const { json, text } = await readBody(response);
    test.skip(
      !wasAccepted(response.status(), json),
      `the send was not accepted on this environment (HTTP ${response.status()}): ${text.slice(0, 160)}`,
    );

    // Throwaway device id: the default belongs to QA_KPOST_ID and reusing it evicts that session.
    const login = await ctx.authClient.userLogin(
      buildLoginPayload(primary, env.qaPassword, {
        deviceIdentity_primary: `qa-nfrsec02-${Date.now()}`,
        loginRO: { countryID: env.qaCountryId, password: env.qaPassword, userType: 'BUSINESS_M' },
      }),
    );
    const recipientToken = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(await login.text())?.[0] ?? null;
    test.skip(
      recipientToken === null,
      `the primary recipient "${primary}" could not authenticate, so their view cannot be read`,
    );

    const fetchDelivered = async (): Promise<Record<string, unknown> | undefined> => {
      const inbox = await ctx.katchupClient.katchupMessagesForSelectedContactID(
        {
          selectedContact: ctx.sender,
          receiver: ctx.sender,
          groupFlag: false,
          firstMsgID: null,
          lastMsgID: null,
          msgID: 0,
        },
        { token: recipientToken as string },
      );
      try {
        const rows =
          (JSON.parse(await inbox.text()) as { data?: Array<Record<string, unknown>> }).data ?? [];
        return rows.find((row) => String(row.subject ?? '') === subject);
      } catch {
        return undefined;
      }
    };

    await expect
      .poll(async () => (await fetchDelivered()) !== undefined, {
        timeout: 15_000,
        intervals: [500, 1_000, 1_000, 2_000, 2_000, 2_000, 3_000, 3_000],
        message: `the message never reached the primary recipient within 15s, so NFR-SEC02 could not be verified on this shape. A Critical must not pass by default because delivery was slow.`,
      })
      .toBe(true);

    const ourRow = (await fetchDelivered()) as Record<string, unknown>;

    /*
     * Two assertions, deliberately. The substring check catches the party appearing ANYWHERE on
     * the row; the field check names the exact place the production capture showed it. A fix that
     * empties hiddenContactList while leaking elsewhere — or the reverse — still fails.
     */
    const hidden = hiddenContactsOf(ourRow);
    const inHiddenList = hidden.includes(confidential);
    const anywhereOnRow = JSON.stringify(ourRow).includes(confidential);

    if (inHiddenList || anywhereOnRow) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          title: 'A Confidential Copy recipient is disclosed to the primary recipient',
          scenario:
            `A confidential message was sent as ${variant.label}. Expected: the confidential ` +
            "recipient is stripped from every other recipient's copy. Actual: the primary " +
            'recipient fetches the message via katchupMessagesForSelectedContactID and receives ' +
            `the confidential account ${inHiddenList ? `in hiddenContactList ${JSON.stringify(hidden)}` : 'on the delivered row'}. ` +
            'NFR-SEC02 requires Confidential Copy recipients to stay invisible to other ' +
            'recipients — the feature exists solely to withhold that identity, so disclosing it ' +
            `defeats it entirely. Delivered row: ${JSON.stringify(ourRow).slice(0, 300)}`,
        },
        'Security/Information Disclosure',
        'Critical',
      );
    }

    expect(
      inHiddenList,
      `NFR-SEC02 (${variant.label}): the delivered row carries the confidential account "${confidential}" in hiddenContactList ${JSON.stringify(hidden)} — the one field whose entire purpose is to stay server-side. Row: ${JSON.stringify(ourRow).slice(0, 300)}`,
    ).toBe(false);

    expect(
      anywhereOnRow,
      `NFR-SEC02 (${variant.label}): the primary recipient's own copy names the Confidential Copy recipient "${confidential}" somewhere on the row. Row: ${JSON.stringify(ourRow).slice(0, 300)}`,
    ).toBe(false);
  }

  test('[NFR-SEC02] messageType 18: a Confidential Copy recipient must not be exposed', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    await assertConfidentialPartyHidden(CONFIDENTIAL_VARIANTS.typeEighteen, {
      katchupClient,
      authClient,
      staticToken,
      sender: authSession.kpostID ?? env.qaKpostId,
    });
  });

  test('[NFR-SEC02] sharedType 14: hiddenContactList must not reach the other recipient', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    await assertConfidentialPartyHidden(CONFIDENTIAL_VARIANTS.sharedFourteen, {
      katchupClient,
      authClient,
      staticToken,
      sender: authSession.kpostID ?? env.qaKpostId,
    });
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

  test('[FR-K12] a sender can attach a Note to a message — messageType 5', async ({
    katchupClient,
    staticToken,
  }) => {
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-NOTE-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(base);
    expect(msgID, 'the base message must send so a note can be attached to it').not.toBeNull();

    const note = buildKatchupMessagePayload({
      subject: `QA-NOTE-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 5,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
      actualMessage: 'QA note attached to the message',
    });
    const response = await katchupClient.sendMessage(note, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'attaching a Note (type 5) to an own message must be accepted',
    ).toBe(true);
  });

  test('[FR-K13] a sender can set a Reminder on a message — messageType 3', async ({
    katchupClient,
    staticToken,
  }) => {
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject: `QA-REMINDER-${Date.now()}`,
        receiver: VICTIM_KPOST_ID,
      }),
      { token: staticToken },
    );
    const msgID = await sentMessageId(base);
    expect(msgID, 'the base message must send so a reminder can be set on it').not.toBeNull();

    const reminder = buildKatchupMessagePayload({
      subject: `QA-REMINDER-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 3,
      msgID: msgID as number,
      referenceMsgID: msgID as number,
      actualMessage: 'QA reminder on the message',
    });
    const response = await katchupClient.sendMessage(reminder, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      'setting a Reminder (type 3) on an own message must be accepted',
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
