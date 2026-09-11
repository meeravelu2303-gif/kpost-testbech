import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import { buildLoginPayload } from '../../src/api/payloads/auth.payload';
import { env } from '../../src/config/env.config';
import type { APIResponse } from '@playwright/test';
import type { KatchupV2Client } from '../../src/api/clients/katchupV2.client';

/**
 * FR-K08 / NFR-SEC06 — a sender action may be performed only by the account that sent the message.
 *
 * ## What was measured, 2026-09-11, against 192.168.0.66
 *
 * Message ids are **global and sequential**: meera960 -> meera961 got 850786 and meera961 ->
 * meera962 got 850787 on the next call. Different senders, different recipients, delta 1. So the
 * set of ids an attacker can reach is not "messages they were shown" — it is every message on the
 * platform, by counting.
 *
 * Against a message meera961 sent to meera962, with meera960 neither sender nor recipient:
 *
 * | action                  | result | owner's view afterwards |
 * | ----------------------- | ------ | ----------------------- |
 * | edit (messageType 6)    | 200    | message GONE            |
 * | note (messageType 5)    | 200    | message GONE            |
 * | reminder (messageType 3)| 200    | message GONE            |
 * | recall                  | 400    | intact                  |
 * | delete                  | 400    | intact                  |
 *
 * Recall and delete DO check ownership. The three `sendMessage` variants that reference an
 * existing `msgID` do not — and each one **moves the message into the attacker's conversation**,
 * rewriting `sender` to the attacker. Control follows: after the edit, the attacker's recall
 * answers 200 and their delete answers 200, because by then they are the recorded sender.
 *
 * So the edit is a privilege escalation, not an isolated write. One unauthorised call converts
 * any message on the platform into the attacker's own, and everything ownership protects follows.
 *
 * ## Safety
 *
 * Every case seeds its OWN message between two QA-owned accounts. No test aims a write at a
 * counted id belonging to an account the bench does not own — the enumeration is demonstrated by
 * making the attacker a non-participant, which is the same proof without touching a stranger's
 * data.
 *
 * The verdict is taken from the OWNER's fetch, never the attacker's response — see the
 * vantage-point rule in the root CLAUDE.md.
 */

const OWNER = 'meera961@kpostindia.com';
const COUNTERPART = 'meera962@kpostindia.com';

type SenderAction = {
  readonly label: string;
  readonly run: (
    client: KatchupV2Client,
    attackerToken: string,
    msgID: number,
    subject: string,
  ) => Promise<APIResponse>;
};

const SENDER_ACTIONS = {
  edit: {
    label: 'edit (messageType 6)',
    run: (client, token, msgID, subject) =>
      client.sendMessage(
        buildKatchupMessagePayload({
          subject,
          receiver: OWNER,
          messageType: 6,
          msgID,
          referenceMsgID: msgID,
          actualMessage: `QA-GATE-HIJACK-${subject}`,
        }),
        { token },
      ),
  },
  note: {
    label: 'note (messageType 5)',
    run: (client, token, msgID, subject) =>
      client.sendMessage(
        buildKatchupMessagePayload({
          subject,
          receiver: OWNER,
          messageType: 5,
          msgID,
          referenceMsgID: msgID,
          actualMessage: `QA-GATE-NOTE-${subject}`,
        }),
        { token },
      ),
  },
  reminder: {
    label: 'reminder (messageType 3)',
    run: (client, token, msgID, subject) =>
      client.sendMessage(
        buildKatchupMessagePayload({
          subject,
          receiver: OWNER,
          messageType: 3,
          msgID,
          referenceMsgID: msgID,
          actualMessage: `QA-GATE-REMIND-${subject}`,
        }),
        { token },
      ),
  },
  recall: {
    label: 'recall',
    run: (client, token, msgID) => client.recallMessage({ msgID, status: 5 }, { token }),
  },
  remove: {
    label: 'delete',
    run: (client, token, msgID) =>
      client.deleteKatchUpMessage({ messageIds: [msgID], groupFlag: false }, { token }),
  },
} satisfies Record<string, SenderAction>;

/**
 * Seeds a message between two accounts the attacker is not party to, runs one sender action as
 * the attacker, and judges the result from the OWNER's own conversation.
 *
 * A gate test may not skip, so every acquisition step is asserted.
 */
async function assertSenderActionRequiresOwnership(
  action: SenderAction,
  ctx: {
    katchupClient: KatchupV2Client;
    authClient: import('../../src/api/clients/auth.client').AuthClient;
    attackerToken: string;
  },
): Promise<void> {
  const login = await ctx.authClient.userLogin(
    buildLoginPayload(OWNER, env.qaPassword, {
      deviceIdentity_primary: `qa-gate-own-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    }),
  );
  const ownerToken = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(await login.text())?.[0] ?? null;
  expect(
    ownerToken,
    `the owner account "${OWNER}" could not authenticate (HTTP ${login.status()}), so ownership cannot be proved.`,
  ).not.toBeNull();

  const subject = `QA-GATE-OWN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const originalBody = `QA-GATE-ORIGINAL-${subject}`;
  const seeded = await ctx.katchupClient.sendMessage(
    buildKatchupMessagePayload({ subject, receiver: COUNTERPART, actualMessage: originalBody }),
    { token: ownerToken as string },
  );
  const msgID =
    ((await readBody(seeded)).json as { data?: Array<{ msgID?: number }> })?.data?.[0]?.msgID ??
    null;
  expect(
    msgID,
    `could not seed a message from ${OWNER} to ${COUNTERPART} (HTTP ${seeded.status()}), so there is nothing for a non-owner to act on.`,
  ).not.toBeNull();

  // The attack, by an account that is neither sender nor recipient.
  const attack = await action.run(ctx.katchupClient, ctx.attackerToken, msgID as number, subject);
  const { json: attackJson } = await readBody(attack);
  const envelopeFailed =
    attackJson != null &&
    String((attackJson as { status?: unknown }).status).toUpperCase() === 'FAILURE';
  const accepted = attack.status() >= 200 && attack.status() < 300 && !envelopeFailed;

  // The verdict, from the owner's own conversation.
  const own = await ctx.katchupClient.katchupMessagesForSelectedContactID(
    {
      selectedContact: COUNTERPART,
      receiver: COUNTERPART,
      groupFlag: false,
      firstMsgID: null,
      lastMsgID: null,
      msgID: 0,
    },
    { token: ownerToken as string },
  );
  const rows =
    ((await readBody(own)).json as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const ours = rows.filter((row) => Number(row.msgID) === msgID);
  const intact = ours.some(
    (row) => String(row.sender ?? '') === OWNER && String(row.actualMessage ?? '') === originalBody,
  );

  expect(
    accepted,
    `FR-K08 / NFR-SEC06: ${action.label} on msgID ${msgID} — a message sent by ${OWNER} to ${COUNTERPART} — was accepted (HTTP ${attack.status()}) for a caller who is neither party. Message ids are global and sequential, so this reaches every message on the platform by counting, not just ones the caller was shown.`,
  ).toBe(false);

  expect(
    intact,
    `FR-K08 / NFR-SEC06: after ${action.label} by a non-participant, the owner's own conversation no longer shows msgID ${msgID} as theirs. Rows now: ${JSON.stringify(ours).slice(0, 300)}`,
  ).toBe(true);
}

test.describe('FR-K08 — sender actions require ownership of the message @gate', () => {
  test('[FR-K08][NFR-SEC06] edit must be refused for a non-participant', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    await assertSenderActionRequiresOwnership(SENDER_ACTIONS.edit, {
      katchupClient,
      authClient,
      attackerToken: staticToken,
    });
  });

  test('[FR-K08][NFR-SEC06] note must be refused for a non-participant', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    await assertSenderActionRequiresOwnership(SENDER_ACTIONS.note, {
      katchupClient,
      authClient,
      attackerToken: staticToken,
    });
  });

  test('[FR-K08][NFR-SEC06] reminder must be refused for a non-participant', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    await assertSenderActionRequiresOwnership(SENDER_ACTIONS.reminder, {
      katchupClient,
      authClient,
      attackerToken: staticToken,
    });
  });

  /*
   * Recall and delete already refuse a non-participant with 400. These two are the REGRESSION
   * PINS for behaviour that is currently correct — and they matter more than usual here, because
   * the edit hole reaches them: once an attacker has edited a message they become its recorded
   * sender, and both of these then answer 200 legitimately. If the edit is fixed and these are
   * later loosened, the escalation reopens from the other end.
   */
  test('[FR-K10][NFR-SEC06] recall must stay refused for a non-participant', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    await assertSenderActionRequiresOwnership(SENDER_ACTIONS.recall, {
      katchupClient,
      authClient,
      attackerToken: staticToken,
    });
  });

  test('[FR-K20][NFR-SEC06] delete must stay refused for a non-participant', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    await assertSenderActionRequiresOwnership(SENDER_ACTIONS.remove, {
      katchupClient,
      authClient,
      attackerToken: staticToken,
    });
  });
});

/*
 * THE ROOT CAUSE, isolated.
 *
 * The five action tests above are symptoms. Measured 2026-09-11, the vector is not any message
 * type — it is the `msgID` request field:
 *
 *   | request                                   | effect                                    |
 *   | ----------------------------------------- | ----------------------------------------- |
 *   | type 6, `referenceMsgID` only             | new message created, owner keeps theirs   |
 *   | type 1, `referenceMsgID` only             | new message created, owner keeps theirs   |
 *   | type 6, `msgID` present                   | OWNER'S ROW OVERWRITTEN                   |
 *   | type 1, `msgID` present                   | OWNER'S ROW OVERWRITTEN                   |
 *   | **type 0** (plain send), `msgID` present  | OWNER'S ROW OVERWRITTEN                   |
 *
 * A plain send with no action semantics at all takes the message over, so Edit / Note / Reminder
 * are incidental. And `msgID` is **not in the Excel contract for this route** — only
 * `referenceMsgID` is. An undocumented field silently turns a create into an unauthorised update.
 *
 * This is the test that should stay green forever once the field is rejected; the five above are
 * the per-action guards that prove no path regressed individually.
 */
test.describe('NFR-SEC06 — an undocumented msgID must not overwrite another account @gate', () => {
  test('[NFR-SEC06] a plain send carrying msgID must not take over an existing message', async ({
    katchupClient,
    authClient,
    staticToken,
  }) => {
    const login = await authClient.userLogin(
      buildLoginPayload(OWNER, env.qaPassword, {
        deviceIdentity_primary: `qa-gate-root-${Date.now()}`,
      }),
    );
    const ownerToken = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(await login.text())?.[0] ?? null;
    expect(
      ownerToken,
      `the owner account "${OWNER}" could not authenticate (HTTP ${login.status()}).`,
    ).not.toBeNull();

    const subject = `QA-GATE-ROOT-${Date.now()}`;
    const originalBody = `QA-GATE-ORIGINAL-${subject}`;
    const seeded = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject, receiver: COUNTERPART, actualMessage: originalBody }),
      { token: ownerToken as string },
    );
    const msgID =
      ((await readBody(seeded)).json as { data?: Array<{ msgID?: number }> })?.data?.[0]?.msgID ??
      null;
    expect(msgID, `could not seed a message from ${OWNER} to ${COUNTERPART}.`).not.toBeNull();

    // messageType 0 — an ordinary new message that merely names someone else's id.
    const attack = await katchupClient.sendMessage(
      buildKatchupMessagePayload({
        subject,
        receiver: OWNER,
        messageType: 0,
        msgID: msgID as number,
        actualMessage: `QA-GATE-TAKEOVER-${subject}`,
      }),
      { token: staticToken },
    );
    const echoed =
      ((await readBody(attack)).json as { data?: Array<{ msgID?: number }> })?.data?.[0]?.msgID ??
      null;

    const own = await katchupClient.katchupMessagesForSelectedContactID(
      {
        selectedContact: COUNTERPART,
        receiver: COUNTERPART,
        groupFlag: false,
        firstMsgID: null,
        lastMsgID: null,
        msgID: 0,
      },
      { token: ownerToken as string },
    );
    const rows =
      ((await readBody(own)).json as { data?: Array<Record<string, unknown>> })?.data ?? [];
    const intact = rows.some(
      (row) =>
        Number(row.msgID) === msgID &&
        String(row.sender ?? '') === OWNER &&
        String(row.actualMessage ?? '') === originalBody,
    );

    expect(
      echoed === msgID,
      `NFR-SEC06: a plain send (messageType 0) carrying msgID ${msgID} was answered with that same id, meaning the call UPDATED an existing row rather than creating a message. \`msgID\` is not a documented request field on this route — only \`referenceMsgID\` is — and honouring it turns any create into an unauthorised update.`,
    ).toBe(false);

    expect(
      intact,
      `NFR-SEC06: after a plain send carrying msgID ${msgID}, the owner's message is no longer theirs. Rows now: ${JSON.stringify(rows.filter((r) => Number(r.msgID) === msgID)).slice(0, 300)}`,
    ).toBe(true);
  });
});
