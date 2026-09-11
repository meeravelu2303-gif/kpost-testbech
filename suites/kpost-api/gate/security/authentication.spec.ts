import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';

/**
 * NFR-SEC01 — every authenticated operation requires a valid JWT from the Auth Service.
 *
 * The volume half of the gate, and the half that is GREEN today: these routes already refuse
 * every invalid credential shape, and this pins that they keep doing so. A gate is not only for
 * open defects — most of its value is catching the day a filter config change quietly opens a
 * route that has been closed for a year.
 *
 * Three rules this suite exists to respect, all learned the hard way here:
 *
 *   - **A 401 never proves a route exists.** This API authenticates BEFORE routing, so a bare
 *     "must not be 2xx" is green against a path that was deleted. Each route is therefore paired
 *     with a reachability assertion on a valid token, and the credential cases below only mean
 *     something because that assertion holds. 401/403/404/405 are all rejected as proof.
 *   - **The verb matters as much as the path.** A 405 means the route exists but not for this
 *     method, so the credential cases would again be testing nothing. Every entry carries its
 *     real verb, confirmed against the live API.
 *   - **Gate tests do not file defects.** Plain `expect`, never the bug-tracking helpers. The
 *     audit sweep already files one ticket per fault; a gate failure is a red build, and filing
 *     it again would put the same fault in the report twice.
 */

const CREDENTIALS: Array<[string, string | null]> = [
  ['no Authorization header', null],
  ['an expired token', EXPIRED_TOKEN],
  ['a malformed token', MALFORMED_TOKEN],
  ['a forged alg=none token claiming admin', FORGED_ALG_NONE_JWT],
];

/**
 * Routes whose protection is settled. Verb and body are what the live API actually accepts —
 * a 400 from a valid token still proves reachability (the request reached application code),
 * which is all the positive control needs.
 */
const SECURED_ROUTES: Array<{
  module: string;
  method: 'GET' | 'POST';
  path: string;
  body: Record<string, unknown>;
}> = [
  { module: 'Profile', method: 'GET', path: '/v2/profile/getUserProfile', body: {} },
  { module: 'Contacts', method: 'GET', path: '/v2/contacts/getImportedPhoneContacts', body: {} },
  { module: 'Kdiary', method: 'GET', path: '/dairySchedule/getTodaySchedules', body: {} },
  { module: 'General Settings', method: 'GET', path: '/generalSetting/getPersonalize', body: {} },
  { module: 'Katchup', method: 'POST', path: '/v2/katchup/getSharedMessageInfo', body: { msgID: 0 } },
  {
    module: 'Dashboard',
    method: 'POST',
    path: '/v2/dashboard/homeDashboardMsgs',
    body: { lastfetchDate: null },
  },
  { module: 'Kall', method: 'POST', path: '/v2/kall/fetchScheduledRepeatKall', body: {} },
];

test.describe('NFR-SEC01 — secured routes refuse every invalid credential @gate', () => {
  for (const route of SECURED_ROUTES) {
    test(`[NFR-SEC01] ${route.module} ${route.method} ${route.path} is reachable with a valid token`, async ({
      genericClient,
      staticToken,
    }) => {
      const response = await genericClient.send(route.method, route.path, route.body, {
        token: staticToken,
      });

      expect(
        [401, 403, 404, 405].includes(response.status()),
        `${route.method} ${route.path} answered HTTP ${response.status()} to a VALID token. Every credential case for this route is therefore meaningless — a refusal proves nothing about a route that cannot be reached with the verb under test.`
      ).toBe(false);
    });

    for (const [label, token] of CREDENTIALS) {
      test(`[NFR-SEC01] ${route.module} ${route.method} ${route.path} refuses ${label}`, async ({
        genericClient,
      }) => {
        const response = await genericClient.send(route.method, route.path, route.body, { token });

        expect(
          [401, 403],
          `${route.method} ${route.path} answered HTTP ${response.status()} to ${label}. NFR-SEC01 requires a valid Auth Service JWT on every authenticated operation.`
        ).toContain(response.status());
      });
    }
  }
});
