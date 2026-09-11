import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import { buildSchedulePayload } from '../../src/api/payloads/kdiary.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * NFR-SEC07 — submitted markup is never returned as executable script.
 *
 * Pins `BUG-API-87F627`, confirmed against the live API: `createEvent` accepts
 * `<script>alert('xss')</script>` as an event title and `getTodaySchedules` serves it back
 * unescaped on a later read. **Stored**, not merely reflected — the payload survives the round
 * trip and reaches every participant who opens the diary, so one write poisons other people's
 * sessions.
 *
 * Asserted on the READ, not on the write. A write answering 200 is not the defect: storing the
 * raw text is fine if it is escaped on the way out. What is never safe is the read returning an
 * executable `<script>` or an inline event handler.
 *
 * These are RED until the fix lands, which is the point of a gate test. When escaping is added
 * they go green and stay green.
 */

const VECTORS: Array<[string, string]> = [
  ['a script element', "<script>alert('xss')</script>"],
  ['an inline error handler', '<img src=x onerror=alert(1)>'],
  ['an svg onload handler', '<svg/onload=alert(1)>'],
];

/** Script that would actually execute if the browser received this body as HTML. */
function servedExecutable(body: string, vector: string): boolean {
  if (!body.includes(vector)) return false;
  return /<script[\s>]/i.test(vector) || /\son[a-z]+\s*=/i.test(vector);
}

test.describe('NFR-SEC07 — Kdiary stores and serves submitted markup unescaped @gate', () => {
  for (const [label, vector] of VECTORS) {
    test(`[NFR-SEC07] Kdiary createEvent: ${label} must not come back executable`, async ({
      kdiaryClient,
      staticToken,
    }) => {
      const marker = `QA-GATE-${Date.now()}`;
      await kdiaryClient.createSchedule(buildSchedulePayload({ title: `${marker} ${vector}` }), {
        token: staticToken,
      });

      const read = await kdiaryClient.getTodaySchedules({ token: staticToken });
      const { text } = await readBody(read);

      expect(
        servedExecutable(text, vector),
        `NFR-SEC07: getTodaySchedules served ${label} back verbatim (${vector}). Content submitted by one user is read by every participant in the diary, so an unescaped read is stored XSS, not a cosmetic issue. Escape on output. Body: ${text.slice(0, 240)}`
      ).toBe(false);
    });
  }
});

test.describe('NFR-SEC07 — Katchup stores and serves submitted markup unescaped @gate', () => {
  for (const [label, vector] of VECTORS) {
    test(`[NFR-SEC07] Katchup sendMessage: ${label} must not come back executable`, async ({
      katchupClient,
      staticToken,
    }) => {
      const marker = `QA-GATE-${Date.now()}`;
      const body = buildKatchupMessagePayload({
        receiver: FOREIGN.victimKpostID,
        subject: `${marker} ${vector}`,
        actualMessage: vector,
      });
      await katchupClient.sendMessage(body, { token: staticToken });

      const read = await katchupClient.katchupMessagesForSelectedContactID(
        {
          selectedContact: FOREIGN.victimKpostID,
          receiver: FOREIGN.victimKpostID,
          groupFlag: false,
          firstMsgID: null,
          lastMsgID: null,
          msgID: 0,
        },
        { token: staticToken }
      );
      const { text } = await readBody(read);

      expect(
        servedExecutable(text, vector),
        `NFR-SEC07: the conversation read served ${label} back verbatim (${vector}). A message body is rendered in the recipient's client, so an unescaped read hands the sender script execution in someone else's session. Escape on output. Body: ${text.slice(0, 240)}`
      ).toBe(false);
    });
  }
});
