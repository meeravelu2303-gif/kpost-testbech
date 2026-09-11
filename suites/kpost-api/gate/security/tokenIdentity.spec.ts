import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { buildWalletCommunicationPayload } from '../../src/api/payloads/integrations.payload';

/**
 * NFR-SEC06 — a caller-supplied identifier never overrides the identity on the token.
 * NFR-SEC05 — a notification's recipient comes from the record, never from the caller.
 *
 * Judged on **acknowledgement**, not on the request being refused.
 *
 * That distinction is the whole design of this file and it was paid for. A route that keys off
 * the token and ignores a foreign body id is CORRECT and answers 200 — indistinguishable, by
 * status, from the caller acting on their own data. Demanding a refusal produced three phantom
 * Criticals on this bench (a font-setting "foreign write", a dashboard "leak", and an "account
 * takeover" whose test also rotated the bench's own password). What is never safe is the foreign
 * value coming back in the response, because that means it reached the record lookup.
 */

/** True when the response both succeeded and echoed a value the caller does not own. */
async function acknowledgedForeignValue(
  response: { status: () => number; ok: () => boolean },
  text: string,
  json: Record<string, unknown> | null,
  foreign: string
): Promise<boolean> {
  if (!response.ok()) return false;
  if (json && String(json.status ?? '').toUpperCase() === 'FAILURE') return false;
  return text.includes(foreign);
}

const READS: Array<{ module: string; method: 'GET' | 'POST'; path: string; body: Record<string, unknown> }> = [
  { module: 'Profile', method: 'GET', path: '/v2/profile/getUserProfile', body: {} },
  { module: 'Contacts', method: 'GET', path: '/v2/contacts/getImportedPhoneContacts', body: {} },
  { module: 'Kdiary', method: 'GET', path: '/dairySchedule/getTodaySchedules', body: {} },
  { module: 'General Settings', method: 'GET', path: '/generalSetting/getPersonalize', body: {} },
  {
    module: 'Dashboard',
    method: 'POST',
    path: '/v2/dashboard/homeDashboardMsgs',
    body: { lastfetchDate: null },
  },
];

test.describe('NFR-SEC06 — a body-supplied kpostID never overrides the token @gate', () => {
  for (const route of READS) {
    test(`[NFR-SEC06] ${route.module} ${route.method} ${route.path} is reachable with a valid token`, async ({
      genericClient,
      staticToken,
    }) => {
      const response = await genericClient.send(
        route.method,
        route.path,
        { ...route.body },
        { token: staticToken }
      );

      expect(
        [401, 403, 404, 405].includes(response.status()),
        `${route.method} ${route.path} answered HTTP ${response.status()} to a valid token, so the ownership case below would prove nothing.`
      ).toBe(false);
    });

    test(`[NFR-SEC06] ${route.module} ${route.method} ${route.path} must not acknowledge a foreign kpostID`, async ({
      genericClient,
      staticToken,
    }) => {
      const response = await genericClient.send(
        route.method,
        route.path,
        { ...route.body, kpostID: FOREIGN.kpostID },
        { token: staticToken }
      );
      const { text, json } = await readBody(response);

      expect(
        await acknowledgedForeignValue(response, text, json, FOREIGN.kpostID),
        `NFR-SEC06: the response carried kpostID "${FOREIGN.kpostID}", an identity the caller does not own, so the value reached the record lookup. Authorisation on this route then depends on the client choosing not to ask. Refusing, or answering with the caller's own data, are both correct. Body: ${text.slice(0, 240)}`
      ).toBe(false);
    });
  }
});

test.describe('NFR-SEC05 — the caller cannot choose a notification recipient @gate', () => {
  test('[NFR-SEC05] taWallet sendCommunicationMessage must not accept a caller-supplied mobile', async ({
    integrationsClient,
    staticToken,
  }) => {
    /*
     * Pins BUG-API-9077DE, confirmed live: an arbitrary mobile number in the body is accepted as
     * the destination and answers 200 {"status":"SUCCESS"}. A callback bridge must notify the
     * party on the transaction; letting the caller name the number turns it into an open relay
     * that sends platform-branded messages to anyone.
     */
    const stranger = '9000000001';
    const response = await integrationsClient.taWalletSendCommunication(
      buildWalletCommunicationPayload({ mobileNumber: stranger }),
      { token: staticToken }
    );
    const { text, json } = await readBody(response);
    const accepted =
      response.ok() &&
      !(json && String(json.status ?? '').toUpperCase() === 'FAILURE') &&
      !(json && typeof json.statusCode === 'number' && json.statusCode >= 400);

    expect(
      accepted,
      `NFR-SEC05: a caller-supplied mobile number (${stranger}) was accepted as the notification destination — HTTP ${response.status()}. The recipient must be derived from the transaction record. Body: ${text.slice(0, 240)}`
    ).toBe(false);
  });
});
