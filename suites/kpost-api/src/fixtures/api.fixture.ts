import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { env } from '../config/env.config';
import { AuthClient } from '../api/clients/auth.client';
import { CryptoClient } from '../api/clients/crypto.client';
import { ProfileClient } from '../api/clients/profile.client';
import { CommonClient } from '../api/clients/common.client';
import { RazorpayClient } from '../api/clients/razorpay.client';
import { DashboardV2Client } from '../api/clients/dashboardV2.client';
import { KnewsClient } from '../api/clients/knews.client';
import { GeneralSettingsClient } from '../api/clients/generalSettings.client';
import { GroupsV2Client } from '../api/clients/groupsV2.client';
import { CompanyAdministrationClient } from '../api/clients/companyAdministration.client';
import { ContactsDirectoryV2Client } from '../api/clients/contactsDirectoryV2.client';
import { KwordDocumentsClient } from '../api/clients/kwordDocuments.client';
import { KPresentationClient } from '../api/clients/kpresentation.client';
import { KdiaryClient } from '../api/clients/kdiary.client';
import { KallV2Client } from '../api/clients/kallV2.client';
import { RedbusClient } from '../api/clients/redbus.client';
import { KatchupV2Client } from '../api/clients/katchupV2.client';
import { IntegrationsClient } from '../api/clients/integrations.client';
import { GenericClient } from '../api/clients/generic.client';
import { buildLoginPayload, buildSignupPayload, SignupPayload } from '../api/payloads/auth.payload';
import { claimDisposableAccount } from './disposablePool';
import {
  AuthSession,
  establishAdminSession,
  establishSession,
  mintSacrificialSession,
  requireToken,
  warnIfUnauthenticated,
} from './authSession';

export interface FreshUser {
  kpostID: string;
  password: string;
  mobileNumber: string;
  signupPayload: SignupPayload;
  /** Access token if login succeeded, otherwise null (backend may not be seeded). */
  accessToken: string | null;
  refreshToken: string | null;
}

export interface WorkerFixtures {
  /**
   * Authentication is resolved once per worker rather than per test: establishing a session
   * costs several round trips, and ~3,000 tests would otherwise spend most of the run
   * re-authenticating.
   */
  authSession: AuthSession;
  /**
   * A **second, privileged** session for the admin/company suites, resolved once per worker
   * like `authSession`. Its token carries `role: admin`; `null` when no admin account is
   * configured or it cannot authenticate, in which case admin tests skip with the reason
   * stated rather than filing false defects.
   */
  adminSession: AuthSession;
}

export interface ApiFixtures {
  apiContext: APIRequestContext;
  authClient: AuthClient;
  cryptoClient: CryptoClient;
  profileClient: ProfileClient;
  commonClient: CommonClient;
  razorpayClient: RazorpayClient;
  dashboardV2Client: DashboardV2Client;
  knewsClient: KnewsClient;
  generalSettingsClient: GeneralSettingsClient;
  groupsV2Client: GroupsV2Client;
  companyAdminClient: CompanyAdministrationClient;
  contactsClient: ContactsDirectoryV2Client;
  kwordClient: KwordDocumentsClient;
  kpresentationClient: KPresentationClient;
  kdiaryClient: KdiaryClient;
  kallV2Client: KallV2Client;
  redbusClient: RedbusClient;
  katchupClient: KatchupV2Client;
  integrationsClient: IntegrationsClient;
  /** Path-driven client, for cross-cutting ownership probes. See generic.client.ts. */
  genericClient: GenericClient;
  /** Static token from .env — used for "send something that looks like a token" cases. */
  staticToken: string;
  /**
   * A **disposable** session on the same account but a throwaway device.
   *
   * Any test that revokes a session — `userLogout`, `userLogoutFromAllDevices` — must use
   * this and never `staticToken`. The shared token is bound to one `deviceID`, and
   * `AuthenticationFilter` checks that claim against the login-session table on every
   * request, so revoking it takes every other worker's authentication down with it. The
   * suite was doing exactly that, mid-run, on every run.
   *
   * `null` when no credentials are configured; tests skip with that reason stated rather
   * than quietly falling back to the shared token.
   */
  revocableToken: string | null;
  /**
   * A token belonging to a **throwaway account**, for tests whose subject is irreversible.
   *
   * `deactivateAccount` is the case that forced this: the block asserts the API *refuses*
   * deactivation without an OTP, with a body-supplied kpostID, and so on — but it was firing
   * every one of those at the shared QA identity. This suite exists to find the case where
   * the API does not refuse. The first time it succeeds, the account the entire bench depends
   * on is gone, and every run afterwards fails with "Invalid Credential" while looking exactly
   * like a wrong password.
   *
   * `null` when no disposable account could be registered; those tests then skip with that
   * stated, rather than aiming a destructive call at the account that must survive the run.
   */
  disposableToken: string | null;
  /** Token from the worker session, or null when authentication was not possible. */
  authToken: string | null;
  /** Returns the session token, or throws a diagnostic-rich AuthenticationUnavailableError. */
  requireAuthToken: () => string;
  /** Registers + logs in a throwaway faker user, independent of pre-seeded backend state. */
  freshUser: () => Promise<FreshUser>;
  /**
   * The admin (`role: admin`) session token, or `null` when no admin account is configured or
   * it could not authenticate. Admin/company specs use this instead of `staticToken`, and skip
   * with the reason stated when it is null — never falling back to the member token, which would
   * make an admin test silently prove nothing.
   */
  adminToken: string | null;
}

export const test = base.extend<ApiFixtures, WorkerFixtures>({
  authSession: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: env.baseURL,
        timeout: env.apiTimeout,
        ignoreHTTPSErrors: true,
      });

      let session: AuthSession;
      try {
        session = await establishSession(context);
      } catch (error) {
        // A transport failure while authenticating must not abort the whole worker; the
        // suite still has substantial unauthenticated coverage to contribute.
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

  adminSession: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: env.baseURL,
        timeout: env.apiTimeout,
        ignoreHTTPSErrors: true,
      });

      let session: AuthSession;
      try {
        session = await establishAdminSession(context);
      } catch (error) {
        session = {
          token: null,
          refreshToken: null,
          kpostID: null,
          deviceID: null,
          strategy: 'unauthenticated',
          diagnostics: [`Admin authentication threw: ${(error as Error).message}`],
        };
      }

      await use(session);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  apiContext: async ({}, use) => {
    const context = await playwrightRequest.newContext({
      baseURL: env.baseURL,
      timeout: env.apiTimeout,
      ignoreHTTPSErrors: true,
    });
    await use(context);
    await context.dispose();
  },

  authClient: async ({ apiContext }, use) => {
    await use(new AuthClient(apiContext));
  },

  cryptoClient: async ({ apiContext }, use) => {
    await use(new CryptoClient(apiContext));
  },

  profileClient: async ({ apiContext }, use) => {
    await use(new ProfileClient(apiContext));
  },

  commonClient: async ({ apiContext }, use) => {
    await use(new CommonClient(apiContext));
  },

  razorpayClient: async ({ apiContext }, use) => {
    await use(new RazorpayClient(apiContext));
  },

  dashboardV2Client: async ({ apiContext }, use) => {
    await use(new DashboardV2Client(apiContext));
  },

  knewsClient: async ({ apiContext }, use) => {
    await use(new KnewsClient(apiContext));
  },

  generalSettingsClient: async ({ apiContext }, use) => {
    await use(new GeneralSettingsClient(apiContext));
  },

  groupsV2Client: async ({ apiContext }, use) => {
    await use(new GroupsV2Client(apiContext));
  },

  companyAdminClient: async ({ apiContext }, use) => {
    await use(new CompanyAdministrationClient(apiContext));
  },

  contactsClient: async ({ apiContext }, use) => {
    await use(new ContactsDirectoryV2Client(apiContext));
  },

  kwordClient: async ({ apiContext }, use) => {
    await use(new KwordDocumentsClient(apiContext));
  },

  kpresentationClient: async ({ apiContext }, use) => {
    await use(new KPresentationClient(apiContext));
  },

  kdiaryClient: async ({ apiContext }, use) => {
    await use(new KdiaryClient(apiContext));
  },

  kallV2Client: async ({ apiContext }, use) => {
    await use(new KallV2Client(apiContext));
  },

  redbusClient: async ({ apiContext }, use) => {
    await use(new RedbusClient(apiContext));
  },

  katchupClient: async ({ apiContext }, use) => {
    await use(new KatchupV2Client(apiContext));
  },

  integrationsClient: async ({ apiContext }, use) => {
    await use(new IntegrationsClient(apiContext));
  },

  genericClient: async ({ apiContext }, use) => {
    await use(new GenericClient(apiContext));
  },

  staticToken: async ({ authSession }, use) => {
    await use(authSession.token ?? env.staticTokenOverride);
  },

  adminToken: async ({ adminSession }, use) => {
    await use(adminSession.token);
  },

  /*
   * Minted per test rather than per worker: these sessions are destroyed by the tests that
   * use them, so sharing one would make the second such test in a worker fail for a reason
   * that has nothing to do with what it is asserting.
   */
  revocableToken: async ({ apiContext }, use) => {
    const sacrificial = await mintSacrificialSession(apiContext);
    await use(sacrificial ? sacrificial.token : null);
  },

  disposableToken: async ({ freshUser }, use) => {
    let token: string | null = null;
    try {
      token = (await freshUser()).accessToken;
    } catch {
      // Registration is itself one of the things under test; a failure here is reported by
      // the signup suite, and must not turn into a misleading failure in an unrelated block.
      token = null;
    }
    await use(token);
  },

  authToken: async ({ authSession }, use) => {
    await use(authSession.token);
  },

  requireAuthToken: async ({ authSession }, use) => {
    await use(() => requireToken(authSession));
  },

  freshUser: async ({ authClient }, use) => {
    const create = async (): Promise<FreshUser> => {
      /*
       * Prefer a pre-created account when one is available.
       *
       * Registering over REST needs a verified OTP, and on this environment the OTP is random
       * and reaches only SMS — so `signup` below returns 500 and every destructive-path test
       * skips. `npm run seed:disposable` creates accounts out-of-band through the full
       * sendOTP -> validateOTP -> signup flow and leaves them in `.auth/disposable-pool.json`;
       * this lends one, already proven to log in.
       *
       * The REST path is kept underneath, not replaced. It is what should work, it is what
       * will work again once a fixed test OTP exists, and on an environment that never had
       * this problem the pool is simply empty and nothing changes.
       */
      const pooled = claimDisposableAccount();
      if (pooled) {
        const loginResponse = await authClient.userLogin(
          buildLoginPayload(pooled.kpostID, pooled.password)
        );
        let accessToken: string | null = null;
        let refreshToken: string | null = null;
        try {
          const body = (await loginResponse.json()) as Record<string, unknown>;
          accessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
          refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : null;
        } catch {
          accessToken = null;
        }
        if (accessToken) {
          return {
            kpostID: pooled.kpostID,
            password: pooled.password,
            mobileNumber: pooled.mobileNumber,
            signupPayload: buildSignupPayload({
              kpostID: pooled.kpostID,
              password: pooled.password,
              mobileNumber: pooled.mobileNumber,
            }),
            accessToken,
            refreshToken,
          };
        }
        // A pooled account that will not authenticate has been spent by an earlier destructive
        // test. Fall through and let the REST path report why registration is unavailable.
      }

      const signupPayload = buildSignupPayload();
      await authClient.signup(signupPayload);

      let accessToken: string | null = null;
      let refreshToken: string | null = null;
      const loginResponse = await authClient.userLogin(
        buildLoginPayload(signupPayload.kpostID, signupPayload.password)
      );
      if (loginResponse.ok()) {
        try {
          const body = (await loginResponse.json()) as Record<string, unknown>;
          accessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
          refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : null;
        } catch {
          accessToken = null;
        }
      }

      return {
        kpostID: signupPayload.kpostID,
        password: signupPayload.password,
        mobileNumber: signupPayload.mobileNumber,
        signupPayload,
        accessToken,
        refreshToken,
      };
    };
    await use(create);
  },
});

export const expect = test.expect;

/** Deliberately malformed token used by 401/403 assertions. */
export const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxYS1leHBpcmVkIiwiZGV2aWNlSUQiOiJkZWFkLWJlZWYiLCJleHAiOjEwMDAwMDAwMDB9.invalid-signature-for-testing';
export const MALFORMED_TOKEN = 'not-a-jwt-at-all';
/** `{"alg":"none"}` token claiming to be admin — must never be honoured. */
export const FORGED_ALG_NONE_JWT =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImRldmljZUlEIjoieCJ9.';

export type { AuthSession } from './authSession';
export { AuthenticationUnavailableError } from './authSession';
