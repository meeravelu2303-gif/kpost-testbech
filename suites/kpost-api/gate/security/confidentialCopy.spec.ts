import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import { buildLoginPayload } from '../../src/api/payloads/auth.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { env } from '../../src/config/env.config';

/**
 * NFR-SEC02 — Confidential Copy recipients are not visible to other recipients.
 *
 * Pins `BUG-API-6EEBB3`, confirmed live. Katchup encodes Confidential Copy as `messageType 18`
 * rather than a `bcc` field, so the confidential party travels in the same envelope as everyone
 * else and the risk is concrete.
 *
 * Two things this test gets right that the audit version had to learn:
 *
 *   - **The verdict comes from the RECIPIENT's own fetch**, never the send response. The send
 *     response is the sender's view, and a sender may legitimately see the list they chose.
 *   - **Both parties must be real accounts.** `sendMessage` refuses a non-existent receiver with
 *     a 400, so a synthetic primary recipient made the audit version skip every run and the rule
 *     went silently unverified for weeks.
 *
 * Being a gate test, every acquisition step is an ASSERTION rather than a skip: if the message
 * cannot be sent or the recipient cannot log in, this suite has lost the ability to prove the
 * rule, and that is itself a failure worth a red build.
 */

test.describe('NFR-SEC02 — a Confidential Copy recipient stays hidden @gate', () => {
  test('[NFR-SEC02] the primary recipient must not receive the confidential party', async ({
    katchupClient,
    authClient,
    authSession,
    staticToken,
  }) => {
    const confidential = FOREIGN.victimKpostID;
    const primary = FOREIGN.businessReceiverKpostID;
    const subject = `QA-GATE-CONF-${Date.now()}`;

    const body = buildKatchupMessagePayload({
      subject,
      receiver: primary,
      messageType: 18,
      selectedMembers: confidential,
      secretMessageExpireTime: Date.now() + 3_600_000,
    });
    const sent = await katchupClient.sendMessage(body, { token: staticToken });
    const sendBody = await readBody(sent);

    expect(
      sent.ok() && String(sendBody.json?.status ?? '').toUpperCase() !== 'FAILURE',
      `the confidential send was not accepted (HTTP ${sent.status()}), so NFR-SEC02 cannot be proved on this environment. Body: ${sendBody.text.slice(0, 200)}`
    ).toBe(true);

    /*
     * Log the primary recipient in on a THROWAWAY device id: the shared session belongs to
     * QA_KPOST_ID and the default device id would evict whatever session this account holds.
     * Business accounts must send their size-suffixed tier or login fails before the password
     * is even checked.
     */
    const login = await authClient.userLogin(
      buildLoginPayload(primary, env.qaPassword, {
        deviceIdentity_primary: `qa-gate-sec02-${Date.now()}`,
        loginRO: { countryID: env.qaCountryId, password: env.qaPassword, userType: 'BUSINESS_M' },
      })
    );
    const recipientToken = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(await login.text())?.[0] ?? null;

    expect(
      recipientToken,
      `the primary recipient "${primary}" could not authenticate, so their view of the message cannot be read and the rule cannot be proved.`
    ).not.toBeNull();

    const sender = authSession.kpostID ?? env.qaKpostId;
    const inbox = await katchupClient.katchupMessagesForSelectedContactID(
      {
        selectedContact: sender,
        receiver: sender,
        groupFlag: false,
        firstMsgID: null,
        lastMsgID: null,
        msgID: 0,
      },
      { token: recipientToken as string }
    );
    const inboxText = await inbox.text();

    expect(
      inboxText.includes(subject),
      `the message did not reach the primary recipient's conversation, so disclosure cannot be judged. Inbox: ${inboxText.slice(0, 200)}`
    ).toBe(true);

    /*
     * Isolate the delivered row before judging it. A substring match over the whole response
     * also fires on an unrelated message in the same conversation that legitimately names the
     * confidential account — the exact mistake that produced four phantom Criticals elsewhere.
     */
    const rows = (JSON.parse(inboxText) as { data?: Array<Record<string, unknown>> }).data ?? [];
    const ourRow = rows.find((row) => String(row.subject ?? '') === subject);

    expect(
      ourRow != null && JSON.stringify(ourRow).includes(confidential),
      `NFR-SEC02: the primary recipient's own copy disclosed the Confidential Copy recipient "${confidential}". The feature exists solely to withhold that identity, so disclosing it defeats it entirely. Delivered row: ${JSON.stringify(ourRow ?? {}).slice(0, 300)}`
    ).toBe(false);
  });
});
