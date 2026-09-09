import { INVALID_TOKENS, expect, test } from '../../src/fixtures/api.fixture';
import {
  AUTHENTICATED_ROUTES,
  DOCUMENTED_ANONYMOUS_ROUTES,
  MAILBOX_PATHS,
  PATH_TEMPLATES,
  READ_MAIL_PATHS,
  SENT_MAIL_PATHS,
} from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import {
  assertNoInternalLeak,
  assertStatus,
  assertUnauthorized,
  readBody,
} from '../../src/utils/apiAssertions';
import { nonExistentUuid } from '../../src/utils/safeTestData';

/**
 * The authentication matrix — one question of the whole surface at once: does an absent, expired,
 * malformed or forged token reach anything it should not?
 *
 * Written as data-driven loops, a deliberate exception: the assertion is genuinely identical at every
 * route in AUTHENTICATED_ROUTES and only the address changes, so hand-writing would produce hundreds
 * of near-identical blocks (5 token states × every secured route).
 *
 *  - Five token states, not one. Each exercises a different branch of the filter; `alg: none`
 *    matters most, since a filter reading claims before verifying the algorithm honours a token
 *    anyone can mint.
 *  - The documented-anonymous routes are asserted, not skipped: `saveUnsubscriberDetails` and the
 *    translator's `postMail` are supposed to be reachable without a token, so this pins that they
 *    are the only two, catching a route quietly joining them.
 */

test.describe('Authentication matrix — every secured route, every invalid token', () => {
  for (const route of AUTHENTICATED_ROUTES) {
    for (const { label, token } of INVALID_TOKENS) {
      test(`[auth] ${route.method} ${route.path} refuses ${label}`, async ({ genericClient }) => {
        const response = await genericClient.send(route.method, route.path, {}, { token });

        await assertUnauthorized(response, {
          method: route.method,
          path: route.path,
          repro: `await genericClient.send('${route.method}', '${route.path}', {}, { token: ${token === null ? 'null' : `'<${label}>'`} });`,
          body: {},
        });
      });
    }
  }
});

test.describe('Documented anonymous routes', () => {
  // These two are reachable without a token by design. The finding worth guarding against is that
  // the set has grown — caught by this file failing to compile against the route registry.
  test('[anon] the documented anonymous set is exactly two routes', () => {
    expect(
      DOCUMENTED_ANONYMOUS_ROUTES.map((route) => `${route.method} ${route.path}`).sort(),
      'The KMail API documents exactly two routes as reachable without a token: saveUnsubscriberDetails (an unsubscribe link must work from an email client with no session) and the translator postMail path. Any change to this set is a change to the platform\'s attack surface and must be a deliberate, reviewed decision rather than a side effect.'
    ).toEqual([
      'POST /v2/common/saveUnsubscriberDetails',
      'POST /v2/translator/postMail',
    ]);
  });

  for (const route of DOCUMENTED_ANONYMOUS_ROUTES) {
    test(`[anon] ${route.method} ${route.path} is reachable without a token, and does not fault`, async ({
      genericClient,
    }) => {
      const response = await genericClient.send(route.method, route.path, {}, { token: null });

      // Asserted as "not a server fault", not "succeeds": an empty body is not a valid unsubscribe,
      // so a 400 is correct; a 500 is an unauthenticated crash vector on a route anyone can reach.
      expect(
        response.status(),
        `${route.method} ${route.path} is documented as reachable without a token, and answered HTTP ${response.status()} to an empty body from an anonymous caller. A 400 is correct here; a 5xx is an unhandled path on a route anyone on the network can reach.`
      ).toBeLessThan(500);
    });
  }
});

test.describe('Auth filter behaviour', () => {
  test('[filter] a rejection must not disclose why the token failed', async ({ genericClient }) => {
    // "Invalid signature" and "expired" are different answers to an attacker. A filter that
    // distinguishes them out loud is an oracle for token forgery.
    const responses = await Promise.all(
      INVALID_TOKENS.filter((entry) => entry.token !== null).map((entry) =>
        genericClient
          .send('GET', '/v2/kmailData/getKloudUsedData', {}, { token: entry.token })
          .then(async (response) => ({ label: entry.label, body: (await readBody(response)).text }))
      )
    );

    const distinct = new Set(responses.map((entry) => entry.body.replace(/\d{10,}/g, '<ts>')));

    expect(
      distinct.size,
      `The auth filter returned ${distinct.size} distinct bodies across ${responses.length} different invalid tokens:\n${responses.map((entry) => `  ${entry.label} -> ${entry.body.slice(0, 120)}`).join('\n')}\nDistinguishing "expired" from "bad signature" tells an attacker which of their forgeries was structurally correct, which turns brute-forcing a signature into a guided search.`
    ).toBe(1);
  });

  test('[filter] a rejection must not leak server internals', async ({ genericClient }) => {
    const response = await genericClient.send(
      'POST',
      MAILBOX_PATHS.getKmailDashboardMsg,
      {},
      { token: 'Bearer-shaped-but-nonsense.<>.value' }
    );

    await assertNoInternalLeak(
      response,
      {
        method: 'POST',
        path: MAILBOX_PATHS.getKmailDashboardMsg,
        repro: `await genericClient.send('POST', path, {}, { token: '<nonsense>' });`,
      },
      'Bearer-shaped-but-nonsense.<>.value'
    );
  });

  test('[filter] an Authorization header with no scheme must be refused', async ({
    genericClient,
    token,
  }) => {
    // A bare token with no "Bearer " prefix. Accepting it means the filter is substring-matching
    // rather than parsing the header, which widens what counts as a credential.
    const response = await genericClient.send(
      'GET',
      '/v2/kmailData/getKloudUsedData',
      {},
      { headers: { Authorization: token } }
    );

    await assertUnauthorized(response, {
      method: 'GET',
      path: '/v2/kmailData/getKloudUsedData',
      repro: `await genericClient.send('GET', path, {}, { headers: { Authorization: '<raw token, no Bearer prefix>' } });`,
    });
  });

  test('[filter] a token in a query parameter must not authenticate', async ({
    genericClient,
    token,
  }) => {
    // Query strings are logged by every proxy, load balancer and access log in the path. A route
    // that accepts a token there turns every one of those logs into a credential store.
    const response = await genericClient.send(
      'GET',
      '/v2/kmailData/getKloudUsedData',
      {},
      { token: null, params: { access_token: token, token } }
    );

    await assertUnauthorized(response, {
      method: 'GET',
      path: '/v2/kmailData/getKloudUsedData',
      repro: `await genericClient.send('GET', path, {}, { token: null, params: { access_token: '<token>' } });`,
    });
  });
});

test.describe('UUID-addressed attachment routes', () => {
  // These take no body and no owner key — the path UUID is the object's entire identity. If any
  // serves an anonymous caller, possession of a UUID is the only access control on the attachment
  // store, and UUIDs travel in every mail listing response.
  const UUID_ROUTES = [
    { name: 'download', template: PATH_TEMPLATES.download, build: READ_MAIL_PATHS.download },
    {
      name: 'downloadThumbnail',
      template: PATH_TEMPLATES.downloadThumbnail,
      build: READ_MAIL_PATHS.downloadThumbnail,
    },
    {
      name: 'mediaStreaming',
      template: PATH_TEMPLATES.mediaStreaming,
      build: READ_MAIL_PATHS.mediaStreaming,
    },
  ] as const;

  for (const route of UUID_ROUTES) {
    test(`[uuid-auth] ${route.name} refuses an anonymous caller`, async ({ readMailClient }) => {
      const response = await readMailClient.getPath(route.build(nonExistentUuid()), {
        token: null,
      });

      await assertUnauthorized(response, {
        method: 'GET',
        path: route.template,
        repro: `await readMailClient.${route.name}(uuid, { token: null });`,
      });
    });

    test(`[uuid-auth] ${route.name} refuses a forged alg=none token`, async ({
      readMailClient,
    }) => {
      const response = await readMailClient.getPath(route.build(nonExistentUuid()), {
        token: INVALID_TOKENS[3].token,
      });

      await assertUnauthorized(response, {
        method: 'GET',
        path: route.template,
        repro: `await readMailClient.${route.name}(uuid, { token: FORGED_ALG_NONE_JWT });`,
      });
    });
  }

  test('[uuid-auth] getCopiesInfo refuses an anonymous caller', async ({ readMailClient }) => {
    const response = await readMailClient.getCopiesInfo(FOREIGN.kmailID, { token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: PATH_TEMPLATES.getCopiesInfo,
      repro: `await readMailClient.getCopiesInfo(kmailID, { token: null });`,
    });
  });

  test('[uuid-auth] bulkMail status refuses an anonymous caller', async ({ sentMailClient }) => {
    // The path variable is a sender address. Served to anonymous callers it confirms whether any
    // address runs campaigns and how large — reconnaissance that needs no account.
    const response = await sentMailClient.bulkMailStatus('qa-noreply@example.com', {
      token: null,
    });

    await assertUnauthorized(response, {
      method: 'GET',
      path: PATH_TEMPLATES.bulkMailStatus,
      repro: `await sentMailClient.bulkMailStatus(address, { token: null });`,
    });
  });
});

test.describe('Service root', () => {
  // `GET /` is the Spring application root, not a KMail feature. Covered so every published
  // endpoint has an explicit test, and because a root route always reaches an unauthenticated
  // caller: it must answer plainly and not leak build, framework or environment detail.
  const META = { method: 'GET', path: '/', repro: `await genericClient.send('GET', '/');` };

  test('[root] answers without a token and does not fault', async ({ genericClient }) => {
    const response = await genericClient.send('GET', '/', undefined, { token: null });

    expect(
      response.status(),
      `GET / answered HTTP ${response.status()} to an anonymous caller. The application root is a liveness route; it must answer 2xx/3xx/404, never a 5xx.`
    ).toBeLessThan(500);
  });

  test('[root] must not disclose server internals', async ({ genericClient }) => {
    const response = await genericClient.send('GET', '/', undefined, { token: null });

    await assertNoInternalLeak(response, META, 'root');
  });
});

test.describe('Verb enforcement', () => {
  // Each route is declared with an explicit @PostMapping/@GetMapping. A route mapped with a bare
  // @RequestMapping answers every method, so a write could be triggered from a link or a prefetch
  // that only issues GETs.
  const VERB_CASES = [
    { path: SENT_MAIL_PATHS.postMail, wrongVerb: 'GET' as const, declared: 'POST' },
    { path: MAILBOX_PATHS.deleteKmailWithDeletedBy, wrongVerb: 'GET' as const, declared: 'POST' },
    { path: MAILBOX_PATHS.setKmailAsImportant, wrongVerb: 'GET' as const, declared: 'POST' },
  ];

  for (const testCase of VERB_CASES) {
    test(`[verb] ${testCase.path} must not answer ${testCase.wrongVerb}`, async ({
      genericClient,
      token,
    }) => {
      const response = await genericClient.send(testCase.wrongVerb, testCase.path, {}, { token });

      await assertStatus(response, [400, 401, 403, 404, 405, 415], {
        method: testCase.wrongVerb,
        path: testCase.path,
        repro: `await genericClient.send('${testCase.wrongVerb}', '${testCase.path}', {}, { token });`,
        title: `A ${testCase.declared}-only route answers ${testCase.wrongVerb}`,
        severity: 'Major',
      });
    });
  }

  test('[verb] a write route must not answer DELETE', async ({ genericClient, token }) => {
    const response = await genericClient.withVerb('delete', MAILBOX_PATHS.setKmailAsImportant, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415], {
      method: 'DELETE',
      path: MAILBOX_PATHS.setKmailAsImportant,
      repro: `await genericClient.withVerb('delete', path, { token });`,
      title: 'A POST-only route answers DELETE',
      severity: 'Major',
    });
  });
});
