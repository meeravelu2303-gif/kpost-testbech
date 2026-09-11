import { test } from '../src/fixtures/api.fixture';
import { readBody } from '../src/utils/apiAssertions';
import { buildScheduledKallPayload, buildRepeatKallPayload, kallEpoch, kallDate } from '../src/api/payloads/kallV2.payload';
import { buildSchedulePayload } from '../src/api/payloads/kdiary.payload';
import { FOREIGN } from '../src/api/clients/generic.client';
import { buildForwardPayload } from '../src/api/payloads/katchupV2.payload';
import { buildWalletCommunicationPayload } from '../src/api/payloads/integrations.payload';
import { buildResetPasswordPayload } from '../src/api/payloads/companyAdministration.payload';

/**
 * Verification harness for reported Criticals — NOT part of the suite.
 *
 * Run with `--config=scripts/verify-findings.config.ts`. It asserts nothing; it reproduces each
 * finding with the bench's OWN builders and clients and prints the request and response, so a
 * verdict rests on what the suite actually sends rather than on a hand-rolled approximation.
 *
 * That distinction is the whole point. A previous verification round hand-wrote the payloads,
 * hit the binding layer, and read `400 "request body is missing, malformed, or contains a value
 * of the wrong type"` as "the finding is not confirmed" — when it only meant the probe was wrong.
 * Importing the real builders removes that failure mode.
 */

const line = (label: string) => `\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`;

/** True when the envelope agrees the request succeeded — HTTP 2xx alone is not enough here. */
function accepted(status: number, json: Record<string, unknown> | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (json && typeof json.statusCode === 'number' && json.statusCode >= 400) return false;
  if (json && String(json.status ?? '').toUpperCase() === 'FAILURE') return false;
  return true;
}

test.describe('Finding verification', () => {
  test('BUG-API-51AA1B / 3580D1 / 5FD83F / B37E81 — Kall "invalid input accepted"', async ({
    kallV2Client,
    staticToken,
  }) => {
    const cases: Array<[string, () => unknown, 'scheduledKall' | 'scheduledRepeatKall']> = [
      ['51AA1B  a booked call with nobody invited', () => buildScheduledKallPayload({ kallDetails: [] }), 'scheduledKall'],
      [
        '3580D1  scheduled call ends three hours before it starts',
        () => buildScheduledKallPayload({ scheduledStartTime: kallEpoch(300), scheduledEndTime: kallEpoch(120) }),
        'scheduledKall',
      ],
      ['5FD83F  repeatType 9999 is outside the known set', () => buildRepeatKallPayload({ repeatType: 9999 }), 'scheduledRepeatKall'],
      [
        'B37E81  seriesEndDate precedes the first occurrence',
        () => buildRepeatKallPayload({ scheduledStartTime: kallEpoch(1440 * 5), seriesEndDate: kallDate(1440) }),
        'scheduledRepeatKall',
      ],
    ];

    for (const [label, build, route] of cases) {
      const payload = build();
      const response = await kallV2Client[route](payload, { token: staticToken });
      const { text, json } = await readBody(response);
      const verdict = accepted(response.status(), json)
        ? 'CONFIRMED — invalid input ACCEPTED (envelope reports success)'
        : `NOT CONFIRMED — refused with HTTP ${response.status()}`;

      // eslint-disable-next-line no-console
      console.log(
        `${line(label)}\nrequest : ${JSON.stringify(payload).slice(0, 240)}\n` +
          `response: HTTP ${response.status()} ${text.slice(0, 200).replace(/\n/g, ' ')}\nVERDICT : ${verdict}`
      );
    }
  });

  test('BUG-API-7C4662 — Kdiary createSchedule internals leak', async ({ kdiaryClient, staticToken }) => {
    const payload = buildSchedulePayload({ title: `' OR '1'='1` });
    const response = await kdiaryClient.createSchedule(payload, { token: staticToken });
    const { text } = await readBody(response);
    const leak = /hibernate|org\.springframework|com\.mysql|SQLGrammar|java\.lang\./i.exec(text);

    // eslint-disable-next-line no-console
    console.log(
      `${line('7C4662  injected input triggers an internals leak')}\n` +
        `request : ${JSON.stringify(payload).slice(0, 240)}\n` +
        `response: HTTP ${response.status()} ${text.slice(0, 300).replace(/\n/g, ' ')}\n` +
        `VERDICT : ${leak ? `CONFIRMED — exposes "${leak[0]}"` : 'NOT CONFIRMED — no framework internals in the body'}`
    );
  });

  test('BUG-API-31BA6D — forwarding a message between two other parties', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * The claim: a caller forwards a message between two OTHER parties.
     *
     * This route is MULTIPART — the body travels as a `text` part, which is why a JSON call
     * answers `400 "Required parameter 'text' is missing"`. Reading that as "not confirmed"
     * would have been the probe failing, not the finding. Replicated exactly as
     * tests/katchupV2/forwarding.spec.ts calls it.
     */
    const payload = buildForwardPayload({ sender: FOREIGN.victimKpostID, receiver: FOREIGN.victimKpostID });
    const response = await katchupClient.forwardKatchupMessage(
      { files: [] },
      { token: staticToken, params: { text: JSON.stringify(payload) } }
    );
    const { text, json } = await readBody(response);

    // eslint-disable-next-line no-console
    console.log(
      `${line('31BA6D  a message between two other parties was forwarded')}\n` +
        `request : ${JSON.stringify(payload).slice(0, 240)}\n` +
        `response: HTTP ${response.status()} ${text.slice(0, 240).replace(/\n/g, ' ')}\n` +
        `VERDICT : ${
          accepted(response.status(), json)
            ? 'CONFIRMED — a message the caller does not own was forwarded'
            : `NOT CONFIRMED — refused with HTTP ${response.status()}`
        }`
    );
  });
});

test.describe('Finding verification — wallet and admin', () => {
  test('BUG-API-9077DE — wallet notification to a caller-supplied mobile', async ({
    integrationsClient,
    staticToken,
  }) => {
    const payload = buildWalletCommunicationPayload({ mobileNumber: '9000000001' });
    const response = await integrationsClient.taWalletSendCommunication(payload, { token: staticToken });
    const { text, json } = await readBody(response);

    // eslint-disable-next-line no-console
    console.log(
      `${line('9077DE  caller-supplied mobile accepted as the notification destination')}\n` +
        `request : ${JSON.stringify(payload).slice(0, 200)}\n` +
        `response: HTTP ${response.status()} ${text.slice(0, 220).replace(/\n/g, ' ')}\n` +
        `VERDICT : ${
          accepted(response.status(), json)
            ? 'CONFIRMED — the caller chose the recipient and the API accepted it'
            : `NOT CONFIRMED — refused with HTTP ${response.status()}`
        }`
    );
  });

  test('BUG-API-198051 — admin resetPassword accepts an unknown userType', async ({
    companyAdminClient,
    adminToken,
  }) => {
    test.skip(!adminToken, 'no admin token available on this environment');
    const payload = buildResetPasswordPayload({ userType: 'NOT_A_TIER' });
    const response = await companyAdminClient.resetPassword(payload, { token: adminToken as string });
    const { text, json } = await readBody(response);

    // eslint-disable-next-line no-console
    console.log(
      `${line('198051  userType set to an unrecognised tier "NOT_A_TIER"')}\n` +
        `request : ${JSON.stringify(payload).slice(0, 200)}\n` +
        `response: HTTP ${response.status()} ${text.slice(0, 220).replace(/\n/g, ' ')}\n` +
        `VERDICT : ${
          accepted(response.status(), json)
            ? 'CONFIRMED — an unknown tier was accepted'
            : `NOT CONFIRMED — refused with HTTP ${response.status()}`
        }`
    );
  });
});
