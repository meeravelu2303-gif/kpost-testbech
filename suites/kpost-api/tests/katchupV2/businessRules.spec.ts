import { test, expect } from '../../src/fixtures/api.fixture';
import { KATCHUP_PATHS, type KatchupV2Client } from '../../src/api/clients/katchupV2.client';
import { reportBusinessLogicFlaw, readBody } from '../../src/utils/apiAssertions';
import {
  buildKatchupMessagePayload,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

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
 * ## Verified live behaviour (2026-09) driving the assertions below
 *
 * - Empty subject → HTTP 200, **accepted** — BR-K01 (subject required) is not enforced.
 * - Missing subject → HTTP 500 — an unhandled path where a 400 is owed.
 * - Copies (14) / Secret (18) / Edit (6) / Recall (7) with correct payloads → 200, all work.
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
function wasAccepted(status: number, json: { status?: unknown; statusCode?: unknown } | null): boolean {
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
function handledCleanly(status: number, json: { status?: unknown; statusCode?: unknown } | null): boolean {
  if (status >= 500) return false;
  const maskedFailure =
    status < 400 && json != null && String(json.status).toUpperCase() === 'FAILURE';
  return !maskedFailure;
}

/** The msgID the send route echoes back, or null. Individual sends return `data[0].msgID`. */
async function sentMessageId(response: import('@playwright/test').APIResponse): Promise<number | null> {
  const { json } = await readBody(response);
  const row = json && Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: Array<{ msgID?: number }> }).data[0])
    : undefined;
  return row && typeof row.msgID === 'number' ? row.msgID : null;
}

/* =========================================================================================
 * POST /v2/katchup/sendMessage — the promises the composer makes
 * ====================================================================================== */
test.describe('POST /v2/katchup/sendMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.sendMessage,
    repro: `await katchupClient.sendMessage(buildKatchupMessagePayload({ subject: '' }), { token });`,
  };

  test('[BR-K01] a message must not be sendable without a Subject', async ({ katchupClient, staticToken }) => {
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
        'Major'
      );
    }

    expect(
      accepted,
      'a Katchup message with an empty Subject was accepted — BR-K01 (Subject required before send) is not enforced'
    ).toBe(false);
  });

  test('[BR-K01] a missing Subject must be refused, not crash the send', async ({ katchupClient, staticToken }) => {
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
        'Minor'
      );
    }

    expect(crashed, `omitting Subject produced HTTP ${response.status()} — a missing required field must be a 4xx`).toBe(false);
  });

  test('[FR-K01] a sent message preserves the Subject it was sent with', async ({ katchupClient, staticToken }) => {
    const subject = `QA-SUBJECT-${Date.now()}`;
    const body = buildKatchupMessagePayload({ subject, receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);

    expect(wasAccepted(response.status(), json), 'a well-formed message with a Subject must send').toBe(true);
    const row = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<{ subject?: string }> }).data[0]
      : undefined;
    expect(row?.subject, 'the Subject the message was sent with must be preserved on the stored message').toBe(subject);
  });

  test('[FR-K07] a sent message carries a read-receipt state', async ({ katchupClient, staticToken }) => {
    // A real recipient so the receipt row is meaningful; the recipient never opens it here, so
    // the state stays at its initial value — what we assert is that the receipt field EXISTS and
    // initialises, which is FR-K07's "record a read receipt for each message" mechanism.
    const body = buildKatchupMessagePayload({ subject: `QA-RECEIPT-${Date.now()}`, receiver: VICTIM_KPOST_ID });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);

    expect(wasAccepted(response.status(), json), 'the message to the victim account must send').toBe(true);
    const row = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: Array<{ status?: number }> }).data[0]
      : undefined;
    expect(
      row != null && typeof row.status === 'number',
      'the sent message must carry a numeric read-state (status: 0 Sent / 1 Unread / 2 Read) — the read-receipt mechanism'
    ).toBe(true);
  });

  test('[FR-K04] a Copies (Cc) message — messageType 14 — is delivered', async ({ katchupClient, staticToken }) => {
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
    expect(wasAccepted(response.status(), json), 'a well-formed Copies (Cc) message must be accepted').toBe(true);
  });

  test('[FR-K05] a Secret / Confidential message — messageType 18 — is delivered', async ({ katchupClient, staticToken }) => {
    const body = buildKatchupMessagePayload({
      subject: `QA-SECRET-${Date.now()}`,
      receiver: VICTIM_KPOST_ID,
      messageType: 18,
      secretMessageExpireTime: Date.now() + 3_600_000,
    });
    const response = await katchupClient.sendMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(wasAccepted(response.status(), json), 'a well-formed Secret (Confidential) message must be accepted').toBe(true);
  });

  test('[FR-K08] a sender can Edit a message they sent — messageType 6', async ({ katchupClient, staticToken }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-EDIT-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken }
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
    expect(wasAccepted(response.status(), json), 'editing an own message (type 6) must be accepted').toBe(true);
  });

  // Reply(1) / Share(2) / Comment(8) / Clarify(9) reference an original message. They are not yet
  // verified against this deployment, so each is exercised in the real establish-then-reference
  // flow and asserted only to be HANDLED cleanly — a 5xx crash or a masked-200 failure is a real
  // defect, while a clean rejection is not (the type may be unsupported on this build).
  async function sendReferencingType(
    katchupClient: KatchupV2Client,
    token: string,
    label: string,
    messageType: number
  ) {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-${label}-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token }
    );
    const msgID = await sentMessageId(original);
    expect(msgID, `the original message must send and return a msgID for the ${label.toLowerCase()}`).not.toBeNull();

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

  test('[FR-K14] a Reply referencing an own message — messageType 1 — is handled cleanly', async ({ katchupClient, staticToken }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'REPLY', 1);
    const { json } = await readBody(response);
    expect(handledCleanly(response.status(), json), 'a Reply (type 1) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect').toBe(true);
  });

  test('[FR-K15] a Share referencing an own message — messageType 2 — is handled cleanly', async ({ katchupClient, staticToken }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'SHARE', 2);
    const { json } = await readBody(response);
    expect(handledCleanly(response.status(), json), 'a Share (type 2) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect').toBe(true);
  });

  test('[FR-K16] a Comment referencing an own message — messageType 8 — is handled cleanly', async ({ katchupClient, staticToken }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'COMMENT', 8);
    const { json } = await readBody(response);
    expect(handledCleanly(response.status(), json), 'a Comment (type 8) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect').toBe(true);
  });

  test('[FR-K17] a Clarify referencing an own message — messageType 9 — is handled cleanly', async ({ katchupClient, staticToken }) => {
    const response = await sendReferencingType(katchupClient, staticToken, 'CLARIFY', 9);
    const { json } = await readBody(response);
    expect(handledCleanly(response.status(), json), 'a Clarify (type 9) must be handled cleanly — a 5xx crash or a 200 masking a FAILURE envelope is a defect').toBe(true);
  });

  test('[FR-K12] a sender can attach a Note to a message — messageType 5', async ({ katchupClient, staticToken }) => {
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-NOTE-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken }
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
    expect(wasAccepted(response.status(), json), 'attaching a Note (type 5) to an own message must be accepted').toBe(true);
  });

  test('[FR-K13] a sender can set a Reminder on a message — messageType 3', async ({ katchupClient, staticToken }) => {
    const base = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-REMINDER-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken }
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
    expect(wasAccepted(response.status(), json), 'setting a Reminder (type 3) on an own message must be accepted').toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/katchup/recallMessage — the sender's post-send control
 * ====================================================================================== */
test.describe('POST /v2/katchup/recallMessage', () => {
  const META = {
    method: 'POST',
    path: KATCHUP_PATHS.recallMessage,
    repro: `await katchupClient.recallMessage({ msgID, status: 5 }, { token });`,
  };

  test('[FR-K10] a sender can Recall a message they sent', async ({ katchupClient, staticToken }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-RECALL-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken }
    );
    const msgID = await sentMessageId(original);
    expect(msgID, 'the original message must send and return a msgID to recall').not.toBeNull();

    const body = { msgID: msgID as number, status: 5 };
    const response = await katchupClient.recallMessage(body, { token: staticToken });
    const { json } = await readBody(response);
    expect(
      wasAccepted(response.status(), json),
      `recalling an own message must succeed — the sender owns FR-K10 (Recall). Meta: ${META.path}`
    ).toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/katchup/deleteKatchUpMessage — the sender's Delete action
 * ====================================================================================== */
test.describe('POST /v2/katchup/deleteKatchUpMessage', () => {
  test('[FR-K20] a sender can Delete a message they sent', async ({ katchupClient, staticToken }) => {
    const original = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject: `QA-DELETE-${Date.now()}`, receiver: VICTIM_KPOST_ID }),
      { token: staticToken }
    );
    const msgID = await sentMessageId(original);
    expect(msgID, 'the original message must send and return a msgID to delete').not.toBeNull();

    const response = await katchupClient.deleteKatchUpMessage(
      { messageIds: [msgID as number], groupFlag: false },
      { token: staticToken }
    );
    const { json } = await readBody(response);
    expect(wasAccepted(response.status(), json), 'deleting an own message must be accepted — FR-K20 (Delete)').toBe(true);
  });
});
