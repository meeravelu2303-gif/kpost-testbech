import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { env } from '../config/env.config';
import {
  CachedSession,
  decodeJwt,
  describeToken,
  readCachedSession,
  writeCachedSession,
} from './tokenStore';

/**
 * Auth handler for the KMail suite.
 *
 * **KMail has no login route.** Its OpenAPI document declares exactly one security scheme,
 * `bearerAuth`, described as a "JWT issued by the KPOST auth service" — so a session is
 * established against `KPOST_AUTH_BASE_URL` and the resulting token is presented to
 * `KMAIL_BASE_URL`. That split is the single most important thing to understand about this
 * file: a failure here is a failure on a *different host* from the one under test, and
 * saying so plainly is what stops an outage on the platform API being triaged as a KMail bug.
 *
 * Two hosts also means two ways to be wrong that look identical from the outside. A token
 * minted against platform A and presented to KMail deployment B authenticates nothing, and
 * the response is the same 401 as a wrong password — which is why the cache is keyed on the
 * auth host and rejected outright when it does not match.
 */

const LOGIN_PATH = '/v2/signupLogin/userLogin';

export type AuthStrategy = 'cached' | 'credentials' | 'unauthenticated';

export interface AuthSession {
  token: string | null;
  refreshToken: string | null;
  kpostID: string | null;
  deviceID: string | null;
  strategy: AuthStrategy;
  /** Ordered account of what was attempted and what came back. Printed when auth fails. */
  diagnostics: string[];
}

/**
 * Thrown by `requireToken` when a test cannot proceed without a session.
 *
 * Carries the diagnostics rather than a bare "no token": the failure is almost always
 * environmental (auth host down, wrong `userType`, expired password) and the diagnostics are
 * the difference between a five-minute fix and an afternoon.
 */
export class AuthenticationUnavailableError extends Error {
  constructor(session: AuthSession) {
    super(
      [
        'No KMail session could be established.',
        '',
        `The KMail service under test is ${env.kmailBaseURL}, but its bearer token is issued`,
        `by the KPOST auth service at ${env.authBaseURL} — so this failure is on the auth host,`,
        'not on KMail.',
        '',
        'What was attempted:',
        ...session.diagnostics.map((line) => `  - ${line}`),
        '',
        'Check, in order: QA_KPOST_ID and QA_PASSWORD are set in .env; QA_USER_TYPE matches the',
        'tier the account was registered under (a wrong tier fails BEFORE the password is even',
        'checked); and KPOST_AUTH_BASE_URL points at the deployment that owns the account.',
      ].join('\n')
    );
    this.name = 'AuthenticationUnavailableError';
  }
}

function snippet(value: string, max = 200): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * The login body as the KPOST web client sends it.
 *
 * `loginRO.userType` is not optional decoration. On accounts registered under a business
 * tier, omitting it or sending the wrong value fails *before* credential validation, so a
 * correct password still cannot authenticate and the error names neither field. The
 * misspelling of "latitude" is the server's own field name, matched deliberately.
 */
function buildLoginPayload(kpostID: string, password: string): Record<string, unknown> {
  const deviceIdentity = env.qaDeviceId;
  const logintime = Date.now();
  return {
    kpostID,
    deviceType: 'Web',
    deviceIdentity_primary: deviceIdentity,
    deviceIdentity_secondary: 'Desktop-Chrome-151',
    sessionID: `${deviceIdentity}${logintime}`,
    logintime,
    login_lattitude: null,
    login_longitude: null,
    oneSignal_Key: '',
    loginRO: {
      countryID: env.qaCountryId,
      password,
      userType: env.qaUserType,
    },
  };
}

/** Pulls the token pair out of a login response, whatever envelope it arrives in. */
function extractTokens(raw: string): { accessToken: string | null; refreshToken: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accessToken: null, refreshToken: null };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { accessToken: null, refreshToken: null };
  }

  const body = parsed as Record<string, unknown>;
  // The platform returns the pair at the top level on `userLogin`, but nests it under `data`
  // on some deployments. Reading both costs nothing and removes a whole class of "the login
  // succeeded but the bench found no token" reports.
  const data =
    body.data !== null && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : {};

  const pick = (key: string): string | null => {
    const top = body[key];
    if (typeof top === 'string' && top.length > 0) return top;
    const nested = data[key];
    return typeof nested === 'string' && nested.length > 0 ? nested : null;
  };

  return { accessToken: pick('accessToken'), refreshToken: pick('refreshToken') };
}

/**
 * Confirms the token actually opens KMail.
 *
 * A token that the auth service happily issues can still be rejected by KMail — different
 * deployment, different signing key, a device row the KMail filter cannot see. Verifying
 * against the service under test rather than against the issuer is the only check that
 * answers the question this suite cares about, and `getKloudUsedData` is the cheapest
 * authenticated read in the API: no MongoDB access, no mail objects, one row.
 */
async function tokenOpensKmail(token: string): Promise<boolean> {
  const context = await playwrightRequest.newContext({
    baseURL: env.kmailBaseURL,
    timeout: env.apiTimeout,
    ignoreHTTPSErrors: true,
  });
  try {
    const response = await context.get('/v2/kmailData/getKloudUsedData', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    // 401/403 means the token was refused. Anything else — including a 500 — means it got
    // past the filter, which is all this check is asking.
    return response.status() !== 401 && response.status() !== 403;
  } catch {
    return false;
  } finally {
    await context.dispose();
  }
}

function cacheEntry(session: {
  token: string;
  refreshToken: string | null;
  kpostID: string | null;
  deviceID: string | null;
}): CachedSession {
  return {
    token: session.token,
    refreshToken: session.refreshToken,
    kpostID: session.kpostID,
    deviceID: session.deviceID,
    environmentKey: env.environmentKey,
    mintedAt: new Date().toISOString(),
  };
}

/** Logs in against the KPOST auth service and returns the token pair, or a stated reason. */
async function loginWithCredentials(
  context: APIRequestContext,
  diagnostics: string[]
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  if (!env.qaKpostId || !env.qaPassword) {
    diagnostics.push('QA_KPOST_ID / QA_PASSWORD are not both set in .env — cannot log in');
    return null;
  }

  const payload = buildLoginPayload(env.qaKpostId, env.qaPassword);
  let raw: string;
  let status: number;
  try {
    const response = await context.post(LOGIN_PATH, {
      headers: { 'Content-Type': 'application/json' },
      data: payload as never,
    });
    status = response.status();
    raw = await response.text();
  } catch (error) {
    diagnostics.push(
      `POST ${env.authBaseURL}${LOGIN_PATH} threw: ${(error as Error).message}. The auth host is unreachable from here.`
    );
    return null;
  }

  const { accessToken, refreshToken } = extractTokens(raw);
  if (!accessToken) {
    diagnostics.push(
      `POST ${LOGIN_PATH} answered HTTP ${status} with no accessToken. Body: ${snippet(raw)}`
    );
    return null;
  }

  diagnostics.push(
    `logged in as ${env.qaKpostId} (userType ${env.qaUserType}) — ${describeToken(accessToken)}`
  );
  return { accessToken, refreshToken };
}

/**
 * Establishes the worker's session: cache first, credentials second.
 *
 * Never throws. A transport failure while authenticating must not abort the worker — the
 * suite still has real unauthenticated coverage to contribute, and the auth matrix in
 * `tests/auth/` is meaningful with no token at all.
 */
export async function establishSession(context: APIRequestContext): Promise<AuthSession> {
  const diagnostics: string[] = [];

  const { session: cached, reason } = readCachedSession(env.authStateFile, {
    environmentKey: env.environmentKey,
    kpostID: env.qaKpostId,
    deviceID: env.qaDeviceId,
    skewSeconds: env.tokenRefreshSkewSeconds,
  });
  diagnostics.push(reason);

  if (cached && (await tokenOpensKmail(cached.token))) {
    return {
      token: cached.token,
      refreshToken: cached.refreshToken,
      kpostID: cached.kpostID,
      deviceID: cached.deviceID,
      strategy: 'cached',
      diagnostics,
    };
  }
  if (cached) {
    diagnostics.push(
      'the cached token was refused by the KMail host — re-authenticating against the auth service'
    );
  }

  const minted = await loginWithCredentials(context, diagnostics);
  if (!minted) {
    return {
      token: null,
      refreshToken: null,
      kpostID: null,
      deviceID: null,
      strategy: 'unauthenticated',
      diagnostics,
    };
  }

  const claims = decodeJwt(minted.accessToken);
  const session: AuthSession = {
    token: minted.accessToken,
    refreshToken: minted.refreshToken,
    kpostID: (claims?.kpostID as string | undefined) ?? claims?.sub ?? env.qaKpostId,
    deviceID: (claims?.deviceID as string | undefined) ?? env.qaDeviceId,
    strategy: 'credentials',
    diagnostics,
  };

  if (!(await tokenOpensKmail(session.token as string))) {
    diagnostics.push(
      `the freshly minted token was refused by ${env.kmailBaseURL}. The auth service and the KMail service are almost certainly from different deployments — a token signed by one authenticates nothing against the other.`
    );
    return { ...session, token: null, strategy: 'unauthenticated' };
  }

  writeCachedSession(
    env.authStateFile,
    cacheEntry({
      token: session.token as string,
      refreshToken: session.refreshToken,
      kpostID: session.kpostID,
      deviceID: session.deviceID,
    })
  );

  return session;
}

/**
 * Prints why a run is proceeding without a session, and stops it when that is not allowed.
 *
 * An unauthenticated run still completes and still publishes a report — it simply cannot
 * evaluate a single authorisation, IDOR or cross-tenant assertion, which is most of what
 * this suite exists to do. Failing loudly by default is deliberate: a quiet run that proves
 * nothing is the worse outcome.
 */
export function warnIfUnauthenticated(session: AuthSession): void {
  if (session.token) {
    if (env.verboseAuthDiagnostics) {
      // eslint-disable-next-line no-console
      console.log(`[kmail-auth] ${session.strategy}: ${describeToken(session.token)}`);
    }
    return;
  }

  const message = [
    '',
    '  ─────────────────────────────────────────────────────────────────────────────',
    '  KMail suite is running WITHOUT a session.',
    '',
    `  Service under test : ${env.kmailBaseURL}`,
    `  Token issued by    : ${env.authBaseURL}`,
    '',
    ...session.diagnostics.map((line) => `    - ${line}`),
    '',
    '  Every ownership, IDOR and authorisation assertion will skip. Set QA_KPOST_ID and',
    '  QA_PASSWORD in .env, or set ALLOW_UNAUTHENTICATED_RUN=true to accept the reduced',
    '  coverage deliberately.',
    '  ─────────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

  if (!env.allowUnauthenticatedRun) {
    throw new Error(message);
  }
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** Returns the session token, or throws a diagnostic-rich error naming the real cause. */
export function requireToken(session: AuthSession): string {
  if (!session.token) throw new AuthenticationUnavailableError(session);
  return session.token;
}

export { describeToken } from './tokenStore';
