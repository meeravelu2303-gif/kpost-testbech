import { APIRequestContext } from '@playwright/test';
import { env, MOCK_OTP_CANDIDATES } from '../config/env.config';
import { AuthClient } from '../api/clients/auth.client';
import { CommonClient } from '../api/clients/common.client';
import { ProfileClient } from '../api/clients/profile.client';
import {
  buildGenerateJWTokensPayload,
  buildLoginPayload,
  buildSignupPayload,
} from '../api/payloads/auth.payload';
import { recordAuthStrategy } from '../utils/bugTracker';
import {
  CachedSession,
  clearCachedSession,
  describeToken,
  environmentKey,
  isExpiredOrExpiring,
  readCachedSession,
  writeCachedSession,
} from './tokenStore';

/**
 * SESSION ACQUISITION
 * ===================
 *
 * The bench needs one authenticated identity for the duration of a run. Getting it used to
 * mean pasting a bearer token into `.env`; that failed every 24 hours, silently, and the
 * suite's answer to failure was to run anyway. This module replaces that with the ordinary
 * production pattern: **credentials are configuration, tokens are derived state.**
 *
 * The ladder, in order, with every rung recorded in `diagnostics`:
 *
 *   1. **cached session** — a token minted earlier, still alive, and minted against *this*
 *      `BASE_URL`. Reused so a re-run costs no round trips.
 *   2. **refresh** — the cached token is spent but its refresh token is not, so exchange it
 *      via `generateJWTokens`.
 *   3. **credential login** — `QA_KPOST_ID` / `QA_PASSWORD`, from a stable device identity.
 *      This is the intended path and the one every run should take at least once a day.
 *   4. **static token override** — `QA_AUTH_TOKEN`, for the case where an operator holds a
 *      token but not the password. Deliberately last among the real strategies, and never
 *      cached: it cannot be refreshed, so it will die mid-run eventually.
 *   5. **throwaway signup** — register a disposable account. Kept as a fallback for an empty
 *      database; it is not a substitute for a real account, because a brand-new user owns no
 *      data and therefore cannot exercise most ownership assertions.
 *
 * Every token that reaches a test has been **verified against a protected route** before
 * being returned. A token in a login response is not evidence of a session: `userLogin` can
 * mint one while `AuthenticationFilter` refuses it, because the filter matches the token's
 * `deviceID` claim against the login-session table, not the signature alone.
 */

export type AuthStrategy =
  | 'cached-session'
  | 'refreshed-token'
  | 'credential-login'
  | 'static-token'
  | 'throwaway-signup'
  | 'unauthenticated';

export interface AuthSession {
  /** A token the backend accepted, or null when no route to a session succeeded. */
  token: string | null;
  refreshToken: string | null;
  /** The identity behind `token`, when known — needed for IDOR/ownership assertions. */
  kpostID: string | null;
  /** The device identity the session is bound to. */
  deviceID: string | null;
  strategy: AuthStrategy;
  /** Ordered log of what was tried and why it failed. Surfaced instead of a silent skip. */
  diagnostics: string[];
}

/**
 * A protected route was exercised without a session. Tests throw this so the failure
 * reads as "could not authenticate", never as "the endpoint is broken".
 */
export class AuthenticationUnavailableError extends Error {
  constructor(session: AuthSession) {
    super(
      [
        'No authenticated session could be established, so this assertion could not be evaluated.',
        '',
        `Target: ${env.baseURL}`,
        `Account: ${env.qaKpostId || '(QA_KPOST_ID not set)'}`,
        '',
        'Resolution: set QA_KPOST_ID / QA_PASSWORD in .env for an account that exists on THIS',
        'target, then run `npm run auth:diagnose` if it still refuses. Do not paste a bearer',
        'token into .env — it expires in 24h and is bound to the environment that minted it.',
        '',
        'Authentication attempts:',
        ...session.diagnostics.map((line) => `  - ${line}`),
      ].join('\n')
    );
    this.name = 'AuthenticationUnavailableError';
  }
}

function snippet(value: string, max = 180): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

async function describeResponse(
  label: string,
  response: { status(): number; text(): Promise<string> }
): Promise<string> {
  let body = '';
  try {
    body = snippet(await response.text());
  } catch {
    body = '<unreadable body>';
  }
  return `${label} -> HTTP ${response.status()} :: ${body}`;
}

/**
 * Reads the platform's failure envelope, returning its message when the call failed.
 *
 * KPOST answers a failed signup, login or OTP send with **HTTP 200 carrying
 * `statusCode: 500` and `status: "FAILURE"`** — the exact behaviour `assertStatusCodeParity`
 * and `assertNot200OKOnError` exist to report. This session builder was itself branching on
 * `response.status() >= 400`, so it read every one of those failures as a success:
 *
 *   - signup returned `{"statusCode":500,"status":"FAILURE","message":"Mobile Number or
 *     kpostID Already Exist"}` under HTTP 200, so the OTP-gate recovery below never ran and
 *     the diagnostics never mentioned that signup had failed at all;
 *   - `sendOTP` returned `{"status":"FAILURE","message":"Try after 24 Hours, OTP sent more
 *     than 3 times"}` under HTTP 200, so the rate limit was invisible and the code went on to
 *     try mock codes that could not possibly be accepted.
 *
 * The run log therefore reported only "Login as throwaway user … Invalid Credential", which
 * pointed at the wrong step entirely and cost real time to diagnose.
 */
function envelopeFailure(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const status = typeof parsed.status === 'string' ? parsed.status.toUpperCase() : null;
    const code = typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
    const failed = status === 'FAILURE' || status === 'ERROR' || (code !== null && code >= 400);
    if (!failed) return null;
    return typeof parsed.message === 'string' && parsed.message ? parsed.message : 'unspecified failure';
  } catch {
    return null;
  }
}

function extractTokens(raw: string): { accessToken: string | null; refreshToken: string | null } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const accessToken =
      (typeof parsed.accessToken === 'string' && parsed.accessToken) ||
      (typeof data.accessToken === 'string' && data.accessToken) ||
      null;
    const refreshToken =
      (typeof parsed.refreshToken === 'string' && parsed.refreshToken) ||
      (typeof data.refreshToken === 'string' && data.refreshToken) ||
      null;
    return { accessToken: accessToken || null, refreshToken: refreshToken || null };
  } catch {
    return { accessToken: null, refreshToken: null };
  }
}

/**
 * Confirms a token is actually honoured, rather than trusting that login returned one.
 * `getUserProfile` is the cheapest authenticated read on the platform.
 */
async function tokenWorks(profileClient: ProfileClient, token: string): Promise<boolean> {
  try {
    const probe = await profileClient.getUserProfile({ token });
    return probe.status() === 200;
  } catch {
    return false;
  }
}

function cacheEntry(session: {
  token: string;
  refreshToken: string | null;
  kpostID: string;
  deviceID: string;
  strategy: AuthStrategy;
}): CachedSession {
  return {
    environmentKey: environmentKey(env.baseURL),
    baseURL: env.baseURL,
    kpostID: session.kpostID,
    deviceID: session.deviceID,
    token: session.token,
    refreshToken: session.refreshToken,
    strategy: session.strategy,
    mintedAt: new Date().toISOString(),
  };
}

/**
 * Logs in with `QA_KPOST_ID` / `QA_PASSWORD` and returns a verified session, or null.
 *
 * `deviceID` is a parameter rather than a constant so callers can mint a **second, disposable**
 * session on a different device — see `mintSacrificialSession`.
 */
async function loginWithCredentials(
  authClient: AuthClient,
  profileClient: ProfileClient,
  deviceID: string,
  diagnostics: string[]
): Promise<{ token: string; refreshToken: string | null } | null> {
  if (!env.qaKpostId || !env.qaPassword) {
    diagnostics.push('QA_KPOST_ID / QA_PASSWORD not set — credential login skipped');
    return null;
  }

  const response = await authClient.userLogin(
    buildLoginPayload(env.qaKpostId, env.qaPassword, { deviceIdentity_primary: deviceID })
  );
  const { accessToken, refreshToken } = extractTokens(await response.text());

  if (accessToken && (await tokenWorks(profileClient, accessToken))) {
    return { token: accessToken, refreshToken };
  }

  if (accessToken) {
    diagnostics.push(
      `Login as QA_KPOST_ID="${env.qaKpostId}" returned a token that GET /v2/profile/getUserProfile refused — the login-session row is not live for device ${deviceID}`
    );
    return null;
  }

  diagnostics.push(await describeResponse(`Login as QA_KPOST_ID="${env.qaKpostId}"`, response));
  diagnostics.push(
    '  note: KPOST reports "no such account", "wrong password", "account not active" and "wrong environment" with this identical message. Run `npm run auth:diagnose` to tell them apart.'
  );
  return null;
}

/**
 * Establishes a session for the run. See the module comment for the ladder and its rationale.
 */
export async function establishSession(context: APIRequestContext): Promise<AuthSession> {
  const authClient = new AuthClient(context);
  const commonClient = new CommonClient(context);
  const profileClient = new ProfileClient(context);
  const diagnostics: string[] = [];
  const deviceID = env.qaDeviceId;

  /* 1) A session cached by an earlier run or by globalSetup, scoped to this BASE_URL. */
  const cached = readCachedSession(env.authStateFile, env.baseURL, env.tokenRefreshSkewSeconds);
  if (cached.session) {
    if (await tokenWorks(profileClient, cached.session.token)) {
      return {
        token: cached.session.token,
        refreshToken: cached.session.refreshToken,
        /*
         * `kpostID` is optional in the cache file, so a session written by an older run can come
         * back without one. It is not unknown, though: the cache is scoped to this BASE_URL and
         * was minted for QA_KPOST_ID, so falling back to that is accurate rather than a guess.
         *
         * Without this the identity is null on every cache hit, and the specs that need a known
         * member - the profile image reads - throw "the auth session carries no kpostID". That
         * surfaced as 3 Major defects against User Profile V2 on 2026-08-27 which were bench
         * faults, not API faults: the worst kind of entry in a bug report, because it sends a
         * developer to an endpoint that never misbehaved.
         */
        kpostID: cached.session.kpostID ?? env.qaKpostId ?? null,
        deviceID: cached.session.deviceID,
        strategy: 'cached-session',
        diagnostics: [cached.reason],
      };
    }
    diagnostics.push(
      'cached token is unexpired but no longer honoured — its login session was closed (a logout, a logout-from-all-devices, or a backend restart)'
    );
    clearCachedSession(env.authStateFile);
  } else {
    diagnostics.push(cached.reason);
  }

  /* 2) Exchange a refresh token rather than re-authenticating from scratch. */
  const staleCache = readCachedSession(env.authStateFile, env.baseURL, -Infinity).session;
  if (staleCache?.refreshToken && staleCache.kpostID) {
    const response = await authClient.generateJWTokens(
      buildGenerateJWTokensPayload(staleCache.kpostID, staleCache.refreshToken)
    );
    const { accessToken, refreshToken } = extractTokens(await response.text());
    if (accessToken && (await tokenWorks(profileClient, accessToken))) {
      const session = {
        token: accessToken,
        refreshToken: refreshToken ?? staleCache.refreshToken,
        kpostID: staleCache.kpostID,
        deviceID: staleCache.deviceID,
        strategy: 'refreshed-token' as const,
      };
      writeCachedSession(env.authStateFile, cacheEntry(session));
      return { ...session, diagnostics: [`refreshed via generateJWTokens (${describeToken(accessToken)})`] };
    }
    diagnostics.push(await describeResponse('Refresh via generateJWTokens', response));
  }

  /* 3) The intended path: log in with the configured credentials. */
  const credentialLogin = await loginWithCredentials(authClient, profileClient, deviceID, diagnostics);
  if (credentialLogin) {
    const session = {
      token: credentialLogin.token,
      refreshToken: credentialLogin.refreshToken,
      kpostID: env.qaKpostId,
      deviceID,
      strategy: 'credential-login' as const,
    };
    writeCachedSession(env.authStateFile, cacheEntry(session));
    return {
      ...session,
      diagnostics: [`Logged in as QA_KPOST_ID="${env.qaKpostId}" (${describeToken(credentialLogin.token)})`],
    };
  }

  /* 4) A token handed in directly. Never cached — it cannot be refreshed. */
  const override = env.staticTokenOverride;
  if (override && override !== 'placeholder_jwt_token') {
    if (isExpiredOrExpiring(override, env.tokenRefreshSkewSeconds)) {
      diagnostics.push(
        `QA_AUTH_TOKEN is set but spent: ${describeToken(override)}. Remove it from .env and configure QA_KPOST_ID / QA_PASSWORD instead — a pasted token is stale within 24h by construction.`
      );
    } else if (await tokenWorks(profileClient, override)) {
      return {
        token: override,
        refreshToken: null,
        kpostID: env.qaKpostId || null,
        deviceID: null,
        strategy: 'static-token',
        diagnostics: [
          `QA_AUTH_TOKEN accepted (${describeToken(override)}) — WARNING: it cannot be refreshed, so it will expire mid-run eventually. Prefer QA_KPOST_ID / QA_PASSWORD.`,
        ],
      };
    } else {
      diagnostics.push(
        `QA_AUTH_TOKEN was set and unexpired but rejected by GET /v2/profile/getUserProfile — it was minted against a different backend, or its login session has been closed`
      );
    }
  } else {
    diagnostics.push('QA_AUTH_TOKEN not set (this is the recommended state)');
  }

  /* 5) Last resort: register a disposable account. */
  const throwaway = await registerThrowawayUser(authClient, commonClient, profileClient, diagnostics);
  if (throwaway) return throwaway;

  return {
    token: null,
    refreshToken: null,
    kpostID: null,
    deviceID: null,
    strategy: 'unauthenticated',
    diagnostics,
  };
}

/**
 * Establishes the **admin** session, used only by the admin/company suites.
 *
 * Deliberately simpler than `establishSession`: no cache ladder, no refresh, no throwaway
 * fallback. There is exactly one way to be an admin here — log in with the configured admin
 * credentials — and if that account is not configured or cannot authenticate, the admin suites
 * must *skip with the reason stated*, never fall back to the member token (which would make an
 * admin test silently prove nothing) and never file a false defect.
 *
 * It presents its own `deviceID` so it never evicts the member session's login-session row.
 */
export async function establishAdminSession(context: APIRequestContext): Promise<AuthSession> {
  const diagnostics: string[] = [];

  if (!env.qaAdminKpostId || !env.qaAdminPassword) {
    diagnostics.push('QA_ADMIN_KPOST_ID / QA_ADMIN_PASSWORD not set — admin suites will skip');
    return { token: null, refreshToken: null, kpostID: null, deviceID: null, strategy: 'unauthenticated', diagnostics };
  }

  const authClient = new AuthClient(context);
  const profileClient = new ProfileClient(context);
  const deviceID = env.qaAdminDeviceId;

  /*
   * The admin logs in through the regular `userLogin` — a BUSINESS_S company admin authenticates
   * there and receives a `role: admin` token (the backend derives the role from the account's
   * `created_by='admin'` flag, not from the endpoint). The tier must be sent as
   * `loginRO.userType`, so `loginRO` is overridden wholesale with the admin's tier rather than
   * inheriting the member's `QA_USER_TYPE`.
   */
  const response = await authClient.userLogin(
    buildLoginPayload(env.qaAdminKpostId, env.qaAdminPassword, {
      deviceIdentity_primary: deviceID,
      loginRO: {
        countryID: env.qaCountryId,
        password: env.qaAdminPassword,
        userType: env.qaAdminUserType,
      },
    })
  );
  const { accessToken, refreshToken } = extractTokens(await response.text());

  if (accessToken && (await tokenWorks(profileClient, accessToken))) {
    return {
      token: accessToken,
      refreshToken,
      kpostID: env.qaAdminKpostId,
      deviceID,
      strategy: 'credential-login',
      diagnostics: [`Admin logged in as QA_ADMIN_KPOST_ID="${env.qaAdminKpostId}" (${describeToken(accessToken)})`],
    };
  }

  diagnostics.push(await describeResponse(`Admin login as QA_ADMIN_KPOST_ID="${env.qaAdminKpostId}"`, response));
  return { token: null, refreshToken: null, kpostID: null, deviceID: null, strategy: 'unauthenticated', diagnostics };
}

/**
 * Mints a **second, disposable** session on a throwaway device.
 *
 * This exists because of a self-inflicted outage. `tests/auth/signupLogin.spec.ts` exercises
 * `userLogout` and `userLogoutFromAllDevices` — including an idempotency case that fires two
 * revoke-all calls concurrently — and it was passing the *live* session token to all of them.
 * `AuthenticationFilter` matches the token's `deviceID` claim against the login-session table,
 * so the moment those tests ran, every other worker's token stopped authenticating. The
 * suite was revoking its own credentials halfway through every run and then reporting the
 * resulting 401s as defects in unrelated modules.
 *
 * Revocation still has to be tested. It just has to be tested against a session nobody else
 * is using: same account, different `deviceIdentity_primary`, so killing it is free.
 *
 * Returns null when no credentials are configured; callers skip with an explicit reason
 * rather than falling back to the shared token.
 */
export async function mintSacrificialSession(
  context: APIRequestContext
): Promise<{ token: string; kpostID: string; deviceID: string } | null> {
  const authClient = new AuthClient(context);
  const profileClient = new ProfileClient(context);
  const diagnostics: string[] = [];

  // A per-call device id: this session is meant to be destroyed, so it must never collide
  // with the run's shared device identity.
  const deviceID = `sacrificial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  /*
   * Retry through the login throttle.
   *
   * This fixture is test-scoped: every logout / revoke-all case mints its own session, so a
   * burst of them arrives within seconds. The backend rate-limits `userLogin` at five attempts
   * and then answers `429 "Too many requests. Please retry in 15 seconds."` — measured on
   * 2026-08-27: attempts 1-5 returned a token, the 6th a 429. Each 429 made this return null,
   * and 18 revocation tests skipped with "no disposable session could be minted" — the surface
   * this fixture exists to protect went unverified on every run.
   *
   * The wait is the one the server itself names, so a retry is not a second guess at the same
   * instant. Three attempts covers a worker's burst without stalling a run that is genuinely
   * unable to log in: a wrong password still fails on the first attempt and returns null, since
   * only a throttled attempt is worth repeating.
   */
  const RETRY_DELAYS_MS = [16_000, 16_000];
  for (let attempt = 0; ; attempt += 1) {
    const before = diagnostics.length;
    const login = await loginWithCredentials(authClient, profileClient, deviceID, diagnostics);
    if (login) return { token: login.token, kpostID: env.qaKpostId, deviceID };

    const throttled = diagnostics.slice(before).some((line) => /\b429\b|too many requests/i.test(line));
    if (!throttled || attempt >= RETRY_DELAYS_MS.length) return null;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

/** Registers a disposable account, clearing an OTP gate if one is present. */
async function registerThrowawayUser(
  authClient: AuthClient,
  commonClient: CommonClient,
  profileClient: ProfileClient,
  diagnostics: string[]
): Promise<AuthSession | null> {
  const signupPayload = buildSignupPayload({ mobileNumber: env.testMobile });
  const signupResponse = await authClient.signup(signupPayload);
  const signupBody = await signupResponse.text().catch(() => '');
  const signupFailure = signupResponse.status() >= 400 ? 'HTTP error' : envelopeFailure(signupBody);

  if (signupFailure !== null) {
    diagnostics.push(`Throwaway signup -> HTTP ${signupResponse.status()} :: ${snippet(signupBody)}`);

    // A signup blocked behind mobile verification may succeed once the OTP is cleared.
    const otpCleared = await tryClearOtpGate(commonClient, signupPayload.mobileNumber, diagnostics);
    if (otpCleared) {
      const retry = await authClient.signup(signupPayload);
      const retryBody = await retry.text().catch(() => '');
      if (retry.status() >= 400 || envelopeFailure(retryBody) !== null) {
        diagnostics.push(`Throwaway signup (after OTP) -> HTTP ${retry.status()} :: ${snippet(retryBody)}`);
      }
    }
  }

  const deviceID = `throwaway-${Date.now().toString(36)}`;
  const loginResponse = await authClient.userLogin(
    buildLoginPayload(signupPayload.kpostID, signupPayload.password, {
      deviceIdentity_primary: deviceID,
    })
  );
  const { accessToken, refreshToken } = extractTokens(await loginResponse.text());

  if (accessToken && (await tokenWorks(profileClient, accessToken))) {
    /*
     * Deliberately NOT cached. A throwaway account owns no groups, documents, contacts or
     * messages, so reusing it across runs would quietly narrow ownership coverage while
     * looking, in the digest, exactly like a healthy authenticated run.
     */
    return {
      token: accessToken,
      refreshToken,
      kpostID: signupPayload.kpostID,
      deviceID,
      strategy: 'throwaway-signup',
      diagnostics: [
        `Registered and logged in throwaway user "${signupPayload.kpostID}"`,
        'WARNING: this account owns no data, so ownership and IDOR assertions have little to bite on. Configure QA_KPOST_ID / QA_PASSWORD for a real account.',
      ],
    };
  }

  diagnostics.push(
    await describeResponse(`Login as throwaway user "${signupPayload.kpostID}"`, loginResponse)
  );
  return null;
}

/**
 * Best-effort pass through a mobile OTP gate using the configured mock codes. Returns true
 * only if a code was actually accepted; every rejection is recorded.
 */
async function tryClearOtpGate(
  commonClient: CommonClient,
  mobileNumber: string,
  diagnostics: string[]
): Promise<boolean> {
  const sendResponse = await commonClient.sendOTP({
    countryID: env.testCountryId,
    mobileNumber,
    requestType: 'SIGNUP',
  });

  const sendBody = await sendResponse.text().catch(() => '');
  const sendFailure = sendResponse.status() >= 400 ? 'HTTP error' : envelopeFailure(sendBody);
  if (sendFailure !== null) {
    /*
     * Reported rather than swallowed, because the message is usually the whole answer. On this
     * environment it reads "Try after 24 Hours, OTP sent more than 3 times": TEST_MOBILE is a
     * single pinned number and the suite fires OTP endpoints hundreds of times per run, so the
     * gate is permanently exhausted and no mock code can clear it.
     */
    diagnostics.push(`sendOTP for throwaway signup -> HTTP ${sendResponse.status()} :: ${snippet(sendBody)}`);
    return false;
  }

  for (const otp of MOCK_OTP_CANDIDATES) {
    const validateResponse = await commonClient.validateOTP({
      countryID: env.testCountryId,
      mobileNumber,
      otp,
      type: 'MOBILE',
    });

    let body = '';
    try {
      body = await validateResponse.text();
    } catch {
      body = '';
    }

    let accepted = false;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      accepted = validateResponse.status() === 200 && parsed.statusCode === 200;
    } catch {
      accepted = false;
    }

    if (accepted) {
      diagnostics.push(`Mock OTP "${otp}" accepted for ${mobileNumber}`);
      return true;
    }
  }

  diagnostics.push(
    `None of the mock OTP candidates [${MOCK_OTP_CANDIDATES.join(', ')}] were accepted for ${mobileNumber} — set TEST_MOCK_OTP to the value this environment honours`
  );
  return false;
}

const STRATEGY_SUMMARY: Record<AuthStrategy, string> = {
  'cached-session': 'cached session (QA_KPOST_ID, reused)',
  'refreshed-token': 'refresh-token exchange (QA_KPOST_ID)',
  'credential-login': 'QA_KPOST_ID / QA_PASSWORD login',
  'static-token': 'QA_AUTH_TOKEN override (not refreshable)',
  'throwaway-signup': 'throwaway signup + login (owns no data)',
  unauthenticated: 'NONE — protected-route coverage could not run (see run log)',
};

let warned = false;

/** Prints the diagnostic block once per worker so the reason is visible in the run log. */
export function warnIfUnauthenticated(session: AuthSession): void {
  recordAuthStrategy(STRATEGY_SUMMARY[session.strategy]);
  if (session.token || warned || !env.verboseAuthDiagnostics) return;
  warned = true;

  const lines = [
    '',
    '='.repeat(78),
    'WARNING: no authenticated session could be established.',
    `Target: ${env.baseURL}`,
    'Protected-route assertions that need a real session will FAIL with an explicit',
    'AuthenticationUnavailableError rather than passing silently.',
    '',
    'Attempts:',
    ...session.diagnostics.map((line) => `  - ${line}`),
    '',
    'Fix: set QA_KPOST_ID / QA_PASSWORD in .env for an account that exists on this target,',
    'then run `npm run auth:diagnose` if login is still refused.',
    '='.repeat(78),
    '',
  ];
  console.warn(lines.join('\n'));
}

/** Returns the session token or throws a diagnostic-rich error. */
export function requireToken(session: AuthSession): string {
  if (!session.token) {
    throw new AuthenticationUnavailableError(session);
  }
  return session.token;
}

export { describeToken } from './tokenStore';
