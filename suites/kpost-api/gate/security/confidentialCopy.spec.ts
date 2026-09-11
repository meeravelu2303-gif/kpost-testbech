import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import {
  buildCopyMessagePayload,
  katchupSnapshotOf,
} from '../../src/api/payloads/katchupV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { env } from '../../src/config/env.config';
import { KATCHUP_SHARE_TYPE } from '../../src/api/enums/kpostTypes';
import { contactListsOf, loginAs, recipientCopy } from '../../src/utils/katchupRecipients';

/**
 * NFR-SEC02 — Confidential Copy recipients are not visible to other recipients.
 *
 * Per the Excel Types tab, Copies (Cc) and Confidential Copy are both `messageType 14`: the people
 * sit in `sharedMessageDetails.revealContactList` (Cc, visible) or `hiddenContactList`
 * (Confidential, must be stripped from every copy but the sender's). The send is the live web
 * client's own shape (captured 2026-09-11), including `forwardReceiverList`, which drives delivery.
 *
 * GREEN on the QA host — verified 2026-09-11 from every vantage point: the primary and a Cc
 * recipient see `hiddenContactList: []`; a hidden recipient sees only themselves. It exists because
 * a capture from PRODUCTION shows this exact shape leaking. If the strip ever regresses, it goes red.
 *
 * An earlier revision was built on `messageType 18` (Secret, not Confidential Copy) and pinned
 * BUG-API-6EEBB3, which was invalid.
 *
 * Every acquisition step is an assertion, not a skip: a gate that silently cannot prove its rule
 * is not a gate.
 */

const PRIMARY = FOREIGN.victimKpostID;
const CC = FOREIGN.thirdKpostID;
const HIDDEN = FOREIGN.businessReceiverKpostID;

test.describe('POST /v2/katchup/sendMessage — NFR-SEC02 a Confidential Copy stays hidden @gate', () => {
  test('[NFR-SEC02] neither the primary nor a Cc recipient can see the hidden recipient', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    const sender = authSession.kpostID ?? env.qaKpostId;
    const subject = `QA-GATE-CONF-${Date.now()}`;
    const sent = await katchupClient.sendMessage(
      buildCopyMessagePayload(
        { receiver: PRIMARY, copies: [CC], confidential: [HIDDEN] },
        { subject },
      ),
      { token: staticToken },
    );
    const sentBody = await readBody(sent);
    expect(
      sent.ok() && String(sentBody.json?.status ?? '').toUpperCase() !== 'FAILURE',
      `the Cc + Confidential Copy send was not accepted (HTTP ${sent.status()}), so NFR-SEC02 cannot be proved. Body: ${sentBody.text.slice(0, 200)}`,
    ).toBe(true);

    for (const viewer of [PRIMARY, CC, HIDDEN]) {
      const token = await loginAs(authClient, viewer);
      expect(
        token,
        `"${viewer}" could not authenticate, so their copy cannot be read and the rule cannot be proved.`,
      ).not.toBeNull();

      const { row } = await recipientCopy(katchupClient, token as string, sender, subject);
      expect(
        row,
        `"${viewer}" never received the message within 15s, so the rule cannot be judged.`,
      ).toBeDefined();

      const { hidden } = contactListsOf(row as Record<string, unknown>);
      expect(
        hidden.filter((h) => h !== viewer),
        `NFR-SEC02: "${viewer}"'s own copy lists another recipient's Confidential Copy in hiddenContactList. Row: ${JSON.stringify(row).slice(0, 300)}`,
      ).toEqual([]);

      if (viewer !== HIDDEN) {
        expect(
          JSON.stringify(row).includes(HIDDEN),
          `NFR-SEC02: "${viewer}"'s own copy names the Confidential Copy recipient "${HIDDEN}". Row: ${JSON.stringify(row).slice(0, 300)}`,
        ).toBe(false);
      }
    }
  });
});

test.describe('POST /v2/katchup/sendMessage — NFR-SEC02 a Note must not leak the Confidential Copy list @gate', () => {
  test('[NFR-SEC02] a Note snapshot on a Confidential Copy must not expose the hidden recipients', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    /*
     * Confirmed live 2026-09-11 and RED until fixed. A Note (sharedType 5) embeds a referenceMessage
     * snapshot of the original; on a Confidential Copy that snapshot carries the full
     * hiddenContactList, and the server serves it to every recipient. Fix: strip hiddenContactList
     * from any referenceMessage served to a caller who is not the sender (server-side is the durable
     * fix — the client cannot be trusted to omit it).
     */
    const sender = authSession.kpostID ?? env.qaKpostId;
    const primary = FOREIGN.victimKpostID;
    const hidden = [FOREIGN.thirdKpostID, FOREIGN.businessReceiverKpostID];
    const subject = `QA-GATE-NOTE-${Date.now()}`;

    const orig = await katchupClient.sendMessage(
      buildCopyMessagePayload({ receiver: primary, confidential: hidden }, { subject }),
      { token: staticToken },
    );
    const origRow = ((await readBody(orig)).json as { data?: Array<Record<string, unknown>> })
      ?.data?.[0];
    expect(
      origRow?.msgID,
      `the confidential original was not accepted (HTTP ${orig.status()}).`,
    ).toBeDefined();

    // A note on a copies thread needs the copy envelope AND the referenceMessage snapshot — the
    // live client's shape. Without the envelope the server 500s; the snapshot carries the leak.
    const note = await katchupClient.sendMessage(
      buildCopyMessagePayload(
        { receiver: primary, confidential: hidden },
        {
          subject,
          sharedType: KATCHUP_SHARE_TYPE.note,
          temporaryMsgID: (origRow as Record<string, unknown>).msgID,
          referenceMessage: katchupSnapshotOf(origRow as Record<string, unknown>),
          actualMessage: `[{"insert":"QA gate note ${Date.now()}\\n"}]`,
        },
      ),
      { token: staticToken },
    );
    const noteBody = await readBody(note);
    expect(
      note.ok() && String(noteBody.json?.status ?? '').toUpperCase() !== 'FAILURE',
      `the Note was not accepted (HTTP ${note.status()}), so NFR-SEC02 cannot be proved. Body: ${noteBody.text.slice(0, 200)}`,
    ).toBe(true);

    for (const viewer of [primary, ...hidden]) {
      const token = await loginAs(authClient, viewer);
      expect(
        token,
        `"${viewer}" could not authenticate, so their copy cannot be read.`,
      ).not.toBeNull();

      const { row } = await recipientCopy(katchupClient, token as string, sender, subject);
      expect(
        row,
        `the Note never reached "${viewer}", so the rule cannot be judged.`,
      ).toBeDefined();

      const others = hidden.filter((h) => h !== viewer);
      expect(
        others.filter((h) => JSON.stringify(row).includes(h)),
        `NFR-SEC02: the Note read by "${viewer}" exposes other hidden recipient(s) through its snapshot. Row: ${JSON.stringify(row).slice(0, 300)}`,
      ).toEqual([]);
    }
  });
});
