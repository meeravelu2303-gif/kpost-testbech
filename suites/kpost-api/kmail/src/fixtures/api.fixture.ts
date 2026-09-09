import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { env } from '../config/env.config';
import { AuthSession, establishSession, requireToken, warnIfUnauthenticated } from '../helpers/authSession';
import { DraftClient } from '../api/clients/draft.client';
import { GenericClient } from '../api/clients/generic.client';
import { KmailSettingClient } from '../api/clients/kmailSetting.client';
import { KmailDataClient, TranslatorClient } from '../api/clients/misc.client';
import { MailboxClient } from '../api/clients/mailbox.client';
import { ReadMailClient } from '../api/clients/readMail.client';
import { SentMailClient } from '../api/clients/sentMail.client';

export interface WorkerFixtures {
  /**
   * Authentication is resolved **once per worker** rather than per test.
   *
   * Establishing a session costs a login against a second host plus a verification call
   * against this one, and the suite would otherwise spend most of its wall-clock
   * re-authenticating rather than testing.
   */
  authSession: AuthSession;
}

export interface ApiFixtures {
  /** Request context bound to the KMail host. Every client in the suite uses it. */
  apiContext: APIRequestContext;

  sentMailClient: SentMailClient;
  readMailClient: ReadMailClient;
  draftClient: DraftClient;
  mailboxClient: MailboxClient;
  settingClient: KmailSettingClient;
  translatorClient: TranslatorClient;
  kmailDataClient: KmailDataClient;
  /** Path-driven client, for the auth matrix and cross-cutting ownership probes. */
  genericClient: GenericClient;

  /** The worker's bearer token, or `null` when no session could be established. */
  authToken: string | null;
  /** The token, for the majority of specs that cannot say anything useful without one. */
  token: string;
  /** The authenticated identity, for assertions that need to name the caller. */
  callerKpostId: string | null;
  /** Returns the token, or throws a diagnostic-rich AuthenticationUnavailableError. */
  requireAuthToken: () => string;
}

export const test = base.extend<ApiFixtures, WorkerFixtures>({
  authSession: [
    async ({}, use) => {
      /*
       * A context on the AUTH host, not the KMail one.
       *
       * This is the one place in the suite that talks to a different service, and giving it
       * its own short-lived context rather than reusing `apiContext` keeps that boundary
       * visible: nothing else in the suite can accidentally issue a request to the platform
       * API and have it look like KMail coverage.
       */
      const context = await playwrightRequest.newContext({
        baseURL: env.authBaseURL,
        timeout: env.apiTimeout,
        ignoreHTTPSErrors: true,
      });

      let session: AuthSession;
      try {
        session = await establishSession(context);
      } catch (error) {
        // A transport failure while authenticating must not abort the whole worker; the
        // unauthenticated coverage is still worth running.
        session = {
          token: null,
          refreshToken: null,
          kpostID: null,
          deviceID: null,
          strategy: 'unauthenticated',
          diagnostics: [`Authentication threw: ${(error as Error).message}`],
        };
      }

      warnIfUnauthenticated(session);
      await use(session);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  apiContext: async ({}, use) => {
    const context = await playwrightRequest.newContext({
      baseURL: env.kmailBaseURL,
      timeout: env.apiTimeout,
      ignoreHTTPSErrors: true,
    });
    await use(context);
    await context.dispose();
  },

  sentMailClient: async ({ apiContext }, use) => {
    await use(new SentMailClient(apiContext));
  },

  readMailClient: async ({ apiContext }, use) => {
    await use(new ReadMailClient(apiContext));
  },

  draftClient: async ({ apiContext }, use) => {
    await use(new DraftClient(apiContext));
  },

  mailboxClient: async ({ apiContext }, use) => {
    await use(new MailboxClient(apiContext));
  },

  settingClient: async ({ apiContext }, use) => {
    await use(new KmailSettingClient(apiContext));
  },

  translatorClient: async ({ apiContext }, use) => {
    await use(new TranslatorClient(apiContext));
  },

  kmailDataClient: async ({ apiContext }, use) => {
    await use(new KmailDataClient(apiContext));
  },

  genericClient: async ({ apiContext }, use) => {
    await use(new GenericClient(apiContext));
  },

  authToken: async ({ authSession }, use) => {
    await use(authSession.token);
  },

  /**
   * The token as a plain string.
   *
   * Skips the test — rather than failing it — when no session exists. A run with no
   * credentials should report "not evaluated", because a failure here would say the endpoint
   * is broken when the only thing that is broken is the bench's access to it. The
   * `ALLOW_UNAUTHENTICATED_RUN=false` default already makes such a run loud at startup, which
   * is the right place for that noise.
   */
  token: async ({ authSession }, use) => {
    test.skip(
      authSession.token === null,
      'no KMail session — set QA_KPOST_ID / QA_PASSWORD in .env'
    );
    await use(authSession.token as string);
  },

  callerKpostId: async ({ authSession }, use) => {
    await use(authSession.kpostID);
  },

  requireAuthToken: async ({ authSession }, use) => {
    await use(() => requireToken(authSession));
  },
});

export const expect = test.expect;

/**
 * Tokens that must never authenticate anything.
 *
 * Four distinct rejections, not four spellings of one. Each exercises a different branch of
 * the filter, and an implementation can pass three while failing the fourth:
 *
 *  - `EXPIRED_TOKEN` is structurally valid with an `exp` in the past — tests the clock check.
 *  - `MALFORMED_TOKEN` is not a JWT at all — tests the parser.
 *  - `FORGED_ALG_NONE_JWT` claims `alg: none` and an admin subject — tests that the signature
 *    is actually verified rather than merely parsed. A filter that reads claims before
 *    checking the algorithm honours this one.
 *  - `WRONG_SIGNATURE_TOKEN` has valid structure and live claims but a signature from a
 *    different key — tests that verification uses the right key, which is the failure a
 *    misconfigured multi-service deployment produces.
 */
export const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxYS1leHBpcmVkIiwia3Bvc3RJRCI6InFhLWV4cGlyZWRAa3Bvc3RpbmRpYS5jb20iLCJkZXZpY2VJRCI6ImRlYWQtYmVlZiIsImV4cCI6MTAwMDAwMDAwMH0.invalid-signature-for-testing';

export const MALFORMED_TOKEN = 'not-a-jwt-at-all';

/** `{"alg":"none"}` claiming an admin subject — must never be honoured. */
export const FORGED_ALG_NONE_JWT =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImtwb3N0SUQiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';

/** Valid structure, far-future expiry, signature from the wrong key. */
export const WRONG_SIGNATURE_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxYS1mb3JnZWQiLCJrcG9zdElEIjoicWEtZm9yZ2VkQGtwb3N0aW5kaWEuY29tIiwiZGV2aWNlSUQiOiJmb3JnZWQtZGV2aWNlIiwiZXhwIjo0MTAyNDQ0ODAwfQ.ZmFrZS1zaWduYXR1cmUtbm90LWZyb20tdGhlLXJlYWwta2V5';

/** Every invalid token, for the specs that assert the whole matrix against one route. */
export const INVALID_TOKENS: ReadonlyArray<{ label: string; token: string | null }> = [
  { label: 'no Authorization header', token: null },
  { label: 'an expired token', token: EXPIRED_TOKEN },
  { label: 'a malformed token', token: MALFORMED_TOKEN },
  { label: 'an alg=none token claiming admin', token: FORGED_ALG_NONE_JWT },
  { label: 'a token signed with the wrong key', token: WRONG_SIGNATURE_TOKEN },
];

export type { AuthSession } from '../helpers/authSession';
export { AuthenticationUnavailableError } from '../helpers/authSession';
