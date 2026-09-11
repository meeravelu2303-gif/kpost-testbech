import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
  FORGED_ALG_NONE_JWT,
} from '../../src/fixtures/api.fixture';
import { readBody, reportBusinessLogicFlaw } from '../../src/utils/apiAssertions';
import { buildKatchupMessagePayload } from '../../src/api/payloads/katchupV2.payload';
import {
  buildSignupPayload,
  buildAdminRegistrationPayload,
} from '../../src/api/payloads/auth.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Cross-module platform rules — the requirements that belong to **no single controller**.
 *
 * Every other spec in this suite is organised by endpoint, because that is how the API is
 * organised. Three requirements in `docs/requirements.json` are not: they are properties of the
 * platform as a whole, and a per-endpoint file has nowhere to put them. They live here.
 *
 * | id        | rule                                                            |
 * | --------- | --------------------------------------------------------------- |
 * | NFR-SEC01 | every authenticated operation requires a valid Auth-Service JWT  |
 * | BR-X02    | account and password rules apply uniformly at account creation   |
 * | NFR-R02   | delivery degrades gracefully rather than losing data silently    |
 *
 * **BR-X01 (read receipts consistent across Katchup and KMail) is deliberately absent.** It needs
 * a mail that was actually delivered, and `postMail` 500s on every QA account for want of
 * mail-server credentials — a provisioning gap recorded in the root CLAUDE.md, not something a
 * test can work around. Writing a version that skips would claim coverage this bench does not
 * have. It stays untraced until the accounts are provisioned.
 */

const wasAccepted = (status: number, json: unknown): boolean =>
  status === 200 && (json as { statusCode?: number })?.statusCode !== 500;

test.describe('Cross-module platform rules @audit', () => {
  /*
   * A representative authenticated route from each major module. This is a **sweep, not a
   * duplicate** of the per-endpoint auth cases: those prove one route is guarded, this proves the
   * guard is a platform property — so a newly-added route that forgets its security annotation, or
   * a SecurityConfiguration edit that widens `permitAll`, is caught by a test nobody has to
   * remember to write.
   *
   * **Every route here is verified reachable (HTTP 200 with a valid token) on 2026-09-10, and the
   * reachability guard below re-verifies it on every run.** That guard is not ceremony. The
   * assertion this test makes is "the response was NOT 2xx", which a route that has been renamed,
   * moved, or given a different HTTP method passes trivially with its 404 — so a stale path turns
   * into a green test that proves nothing. The first draft of this file had exactly that: five of
   * six paths were wrong, and twenty of its twenty-four cases were passing on 404s. Verified
   * method matters as much as verified path (these read routes are GET; a POST to them answers
   * 405, which would also pass vacuously).
   */
  const SECURED_ROUTES: Array<{
    module: string;
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }> = [
    { module: 'Profile', method: 'GET', path: '/v2/profile/getUserProfile' },
    { module: 'Katchup', method: 'GET', path: '/v2/katchup/getUnopenedMessagesCount' },
    { module: 'Katchup', method: 'GET', path: '/v2/katchup/frequentlyAccessContacts' },
    { module: 'KDiary', method: 'GET', path: '/dairySchedule/getTodaySchedules' },
    { module: 'Contacts', method: 'POST', path: '/v2/contacts/globalSearch', body: { search: 'qa' } },
  ];

  for (const route of SECURED_ROUTES) {
    test(`[NFR-SEC01] guard: ${route.module} ${route.method} ${route.path} is reachable with a valid token`, async ({
      genericClient,
      staticToken,
    }) => {
      const response = await genericClient.send(route.method, route.path, route.body, {
        token: staticToken,
      });
      expect(
        response.status(),
        `${route.method} ${route.path} answered HTTP ${response.status()} to a VALID token. The refusal cases ` +
          `below assert "not 2xx", so an unreachable route passes them without testing anything — this route ` +
          `must be corrected or removed from SECURED_ROUTES, not left to report false confidence.`
      ).toBe(200);
    });
  }

  const BAD_CREDENTIALS: Array<{ label: string; token: string | null }> = [
    { label: 'no token at all', token: null },
    { label: 'an expired token', token: EXPIRED_TOKEN },
    { label: 'a malformed token', token: MALFORMED_TOKEN },
    { label: 'an alg=none forged token claiming to be admin', token: FORGED_ALG_NONE_JWT },
  ];

  for (const route of SECURED_ROUTES) {
    for (const credential of BAD_CREDENTIALS) {
      test(`[NFR-SEC01] ${route.module}: ${route.path} must refuse ${credential.label}`, async ({
        genericClient,
      }) => {
        const response = await genericClient.send(route.method, route.path, route.body, {
          token: credential.token,
        });
        const status = response.status();

        /*
         * 401/403 is the correct answer. A 5xx is a *different* defect (the route is broken),
         * already reported by that route's own spec — flagging it again here would be a second
         * ticket for one fault, so it is tolerated. What must never happen is a 2xx: that is the
         * route serving protected data to an unauthenticated caller.
         */
        const served = status >= 200 && status < 300;

        if (served) {
          const { text } = await readBody(response);
          await reportBusinessLogicFlaw(
            response,
            {
              method: route.method,
              path: route.path,
              repro: `await genericClient.send('${route.method}', '${route.path}', ${JSON.stringify(route.body)}, { token: ${credential.token === null ? 'null' : 'BAD_TOKEN'} });`,
              body: route.body,
              title: `${route.path} serves an authenticated read to a caller with ${credential.label}`,
              scenario:
                `NFR-SEC01 requires every authenticated operation to demand a valid Auth-Service JWT. ` +
                `This ${route.module} route answered HTTP ${status} to a caller presenting ${credential.label}, ` +
                `so the guard is absent or not reached. Body: ${text.slice(0, 200)}`,
            },
            'Security/Access Control',
            'Critical'
          );
        }

        expect(
          served,
          `${route.path} answered HTTP ${status} to a caller with ${credential.label} — NFR-SEC01 requires a valid JWT for every authenticated operation`
        ).toBe(false);
      });
    }
  }

  test('[BR-X02] a password below policy must be refused at every account-creation path', async ({
    authClient,
  }) => {
    /*
     * BR-X02: "Account, password and acceptable-use rules apply uniformly at account creation."
     * The risk is not that a rule is missing — it is that KPost has more than one way in
     * (personal signup, business registration) and only one of them enforces the rule. An account
     * created through the weaker path is just as usable as one created through the stronger, so a
     * single unenforced path defeats the policy for the whole platform.
     *
     * `'123'` is below any credible policy. The assertion is that BOTH paths agree — not on a
     * particular status code, but on refusing. A path that accepts it has created a real account,
     * which is why the identities below are synthetic and QA-labelled.
     */
    const weak = '123';

    /*
     * Both bodies come from the suite's own Excel-aligned builders with only the password
     * overridden. Re-declaring the shapes here would fork them from the Excel the moment either
     * spec changes, and would also mean this test failing for a reason that has nothing to do
     * with the password. Every other field keeps the builders' safe synthetic defaults.
     */
    const personal = await authClient.signup(buildSignupPayload({ password: weak }));
    const business = await authClient.adminRegistration(
      buildAdminRegistrationPayload({ password: weak })
    );

    /*
     * A 5xx on either path means the request never reached the policy check, so this test cannot
     * speak to BR-X02 — that 5xx is its own defect, reported by the signup specs.
     */
    test.skip(
      personal.status() >= 500 || business.status() >= 500,
      `an account-creation path answered 5xx (personal ${personal.status()}, business ${business.status()}), so the password policy was never reached`
    );

    /*
     * The refusal must be ABOUT THE PASSWORD, not merely a 4xx.
     *
     * Both creation endpoints validate many fields, and a body rejected for an unrelated reason
     * (a kpostID that fails its format rule, a duplicate mobile number) also answers 400 — so
     * "status is 4xx" would report BR-X02 as satisfied on an endpoint with no password policy at
     * all. That is the worst outcome available here: a green test standing in for an unchecked
     * rule. Verified live on 2026-09-10: both paths answer `fieldErrors.password` with
     * "Password must be at least 8 characters...".
     */
    const refusedOnPassword = async (response: typeof personal): Promise<boolean> => {
      if (response.status() < 400 || response.status() >= 500) return false;
      const { text } = await readBody(response);
      return /password/i.test(text);
    };
    const personalRefused = await refusedOnPassword(personal);
    const businessRefused = await refusedOnPassword(business);

    if (personalRefused !== businessRefused) {
      const weaker = personalRefused ? 'business registration' : 'personal signup';
      await reportBusinessLogicFlaw(
        personalRefused ? business : personal,
        {
          method: 'POST',
          path: personalRefused ? '/v2/signupLogin/adminRegistration' : '/v2/signupLogin/userSignup',
          repro: `await authClient.${personalRefused ? 'adminRegistration' : 'userSignup'}({ password: '123', ... });`,
          title: `The password policy is not enforced on ${weaker}`,
          scenario:
            `BR-X02 requires account and password rules to apply uniformly at account creation. A password of ` +
            `"${weak}" was refused by one creation path and accepted by the other (personal ${personal.status()}, ` +
            `business ${business.status()}), so the weaker path can mint an account the stronger one would reject — ` +
            `and both accounts are equally usable afterwards.`,
        },
        'Business Logic Flaw',
        'Major'
      );
    }

    expect(
      personalRefused,
      `BR-X02: personal signup did not refuse the password "${weak}" on password grounds (HTTP ${personal.status()})`
    ).toBe(true);
    expect(
      businessRefused,
      `BR-X02: business registration did not refuse the password "${weak}" on password grounds (HTTP ${business.status()})`
    ).toBe(true);
  });

  test('[NFR-R02] an accepted message must be retrievable — an accept that stores nothing is silent data loss', async ({
    katchupClient,
    staticToken,
  }) => {
    /*
     * NFR-R02: "Message and mail delivery degrade gracefully rather than losing data silently."
     *
     * The failure mode this guards is specific and nasty: the API answers 200 with a msgID, the
     * sender's client shows the message as sent, and the row was never persisted. The user is told
     * their message went through and it did not. A refusal would be *graceful* degradation; an
     * accept-then-discard is the silent loss the requirement forbids.
     *
     * So the test does not assert on the send at all — it sends, then reads the conversation back
     * and requires the message to be there. Only a send that was ACCEPTED is judged: a rejected
     * send is the API degrading exactly as the requirement asks.
     */
    const subject = `QA-NFRR02-${Date.now()}`;
    const send = await katchupClient.sendMessage(
      buildKatchupMessagePayload({ subject, receiver: FOREIGN.victimKpostID }),
      { token: staticToken }
    );
    const { json, text } = await readBody(send);

    test.skip(
      !wasAccepted(send.status(), json),
      `the send was refused (HTTP ${send.status()}) — a refusal is the graceful degradation NFR-R02 asks for, not the silent loss it forbids`
    );

    const msgID = (json as { data?: Array<{ msgID?: number }> })?.data?.[0]?.msgID ?? null;
    expect(
      msgID,
      `an accepted send must return the msgID it claims to have stored. Body: ${text.slice(0, 200)}`
    ).not.toBeNull();

    const conversation = await katchupClient.katchupMessagesForSelectedContactID(
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
    const stored = await conversation.text();
    const persisted = stored.includes(subject);

    if (!persisted) {
      await reportBusinessLogicFlaw(
        send,
        {
          method: 'POST',
          path: '/v2/katchup/sendMessage',
          repro: `const { msgID } = await katchupClient.sendMessage(...); await katchupClient.katchupMessagesForSelectedContactID(...);`,
          title: 'A message accepted with a msgID is absent from the conversation — silent data loss',
          scenario:
            `NFR-R02 requires delivery to degrade gracefully rather than lose data silently. sendMessage answered ` +
            `HTTP ${send.status()} and returned msgID ${msgID}, but re-reading the conversation does not contain ` +
            `subject "${subject}". The sender was told the message was delivered and it was not — the exact silent ` +
            `loss the requirement forbids. A refusal would have been acceptable; this is not.`,
        },
        'Business Logic Flaw',
        'Critical'
      );
    }

    expect(
      persisted,
      `NFR-R02: sendMessage returned msgID ${msgID} but "${subject}" is absent from the conversation it was sent to — the accept stored nothing`
    ).toBe(true);
  });
});
