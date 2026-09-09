import dotenv from 'dotenv';
import path from 'path';
import { deriveDeviceId, environmentKey } from '../fixtures/tokenStore';

/*
 * `quiet: true` because dotenv v17 prints a banner ("injected env (19) from .env") to stdout
 * on load, and this module is imported by `playwright.config.ts` — so the banner lands on
 * stdout of *every* command, including `playwright test --list --reporter=json`. That put a
 * non-JSON first line into `.scorecard-build/test-list.json`, `JSON.parse` threw, and the
 * scorecard silently fell back to "n/a" for every count. It is why "Active coverage" has read
 * 0.0% in every scorecard this repo has produced, while the suite was in fact exercising 314
 * endpoints. `dashboard-bugzilla.ts` already passed this flag for the same reason.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.resolve(REPO_ROOT, '.env'), quiet: true });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be numeric, got "${raw}"`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const baseURL = optional('BASE_URL', 'http://localhost:8989').replace(/\/+$/, '');
const qaKpostId = optional('QA_KPOST_ID', '');

export const env = {
  baseURL,
  apiTimeout: optionalNumber('API_TIMEOUT', 30000),
  isCI: process.env.CI === 'true' || process.env.CI === '1',
  workers: optionalNumber('TEST_WORKERS', 4),

  /**
   * Fingerprint of the target environment. Every credential, token and cache entry is scoped
   * to it, because a KPOST account exists in exactly one backend's MySQL and a token minted
   * against one host authenticates nothing against another. `BASE_URL` has pointed at four
   * different hosts in this repository's history and the resulting mismatch is reported by
   * the API as `"Invalid Credential"` — indistinguishable from a wrong password, and the
   * single most expensive false trail this project has followed.
   */
  environmentKey: environmentKey(baseURL),

  /* ------------------------------------------------------------------ credentials -- */

  /**
   * **The only auth configuration that belongs in `.env`.**
   *
   * A username and a password are stable facts about an account. A bearer token is derived
   * state with a 24-hour lifetime, an owning environment and an owning device — it is
   * generated per run by `authSession.ts`, cached under `.auth/`, and never written back
   * into `.env`.
   */
  qaKpostId,
  qaPassword: optional('QA_PASSWORD', ''),

  /**
   * A **second, privileged** identity, used only by the admin/company suites.
   *
   * The bench runs as `QA_KPOST_ID` (a member) for the bulk of coverage, and as this account
   * — one whose login token carries `role: admin` (backend sets that from `created_by='admin'`
   * or `is_backup_admin=true`) — for the endpoints a member cannot reach. Keeping them separate
   * is deliberate: it lets the admin suites exercise real admin behaviour *and* lets a member
   * token be aimed at admin routes to prove privilege boundaries hold. Unset → the admin suites
   * skip with that reason stated rather than filing false defects.
   */
  qaAdminKpostId: optional('QA_ADMIN_KPOST_ID', ''),
  qaAdminPassword: optional('QA_ADMIN_PASSWORD', ''),
  /**
   * The admin account's tier, sent as `loginRO.userType`. A company admin registered as a
   * small business is `BUSINESS_S`; medium/large are `BUSINESS_M`/`BUSINESS_L`. This must match
   * the tier the account was registered under, or login fails before credential validation.
   * (Note: `BUSINESS_S` admins authenticate through the regular `userLogin`; `BUSINESS_M/_L`
   * use the separate `adminUserLogin` endpoint — see `establishAdminSession`.)
   */
  qaAdminUserType: optional('QA_ADMIN_USER_TYPE', 'BUSINESS_S'),

  /**
   * The account tier, sent as `loginRO.userType`. Personal accounts (`@kpostindia.com`) are
   * `PERSONAL`; a business identity (`<handle>@<uniqueName>.kpost.in`) needs the
   * size-suffixed form its company was registered under, e.g. `BUSINESS_M`. Sending the
   * wrong tier fails *before* credential validation on some accounts, so a correct password
   * still cannot authenticate.
   */
  qaUserType: optional('QA_USER_TYPE', 'PERSONAL'),
  qaCountryId: optionalNumber('QA_COUNTRY_ID', optionalNumber('TEST_COUNTRY_ID', 1)),

  /**
   * The device identity the bench presents. Derived deterministically from
   * (BASE_URL, QA_KPOST_ID) unless pinned, so the suite looks like **one** installation
   * rather than opening a fresh login-session row on every login — see `deriveDeviceId`.
   */
  qaDeviceId: optional('QA_DEVICE_ID', deriveDeviceId(baseURL, qaKpostId)),

  /** Device identity for the admin session — distinct from the member's, so the two sessions
   *  do not evict each other's login-session row. Derived unless pinned. */
  qaAdminDeviceId: optional(
    'QA_ADMIN_DEVICE_ID',
    deriveDeviceId(baseURL, `admin:${optional('QA_ADMIN_KPOST_ID', '')}`)
  ),

  /**
   * Escape hatch only: a token supplied directly, for a one-off run against an account whose
   * password the operator does not hold. It is validated and its expiry reported, but it is
   * never refreshed and never cached — when it dies, it dies mid-run. Prefer credentials.
   */
  staticTokenOverride: optional('QA_AUTH_TOKEN', optional('AUTH_TOKEN', '')),

  /* ---------------------------------------------------------------- session cache -- */

  /** Where the run-scoped session is cached. Gitignored, written 0600. */
  authStateFile: path.resolve(REPO_ROOT, optional('AUTH_STATE_FILE', '.auth/session.json')),

  /**
   * Refresh a token with less than this many seconds left rather than carrying it into the
   * run. A full suite takes ~250s and a worker holds its token for all of it, so anything
   * under ~5 minutes would expire mid-flight and produce failures that look like defects.
   */
  tokenRefreshSkewSeconds: optionalNumber('TOKEN_REFRESH_SKEW_SECONDS', 600),

  /**
   * Whether a run may proceed with no session at all.
   *
   * Defaults to **false**, reversing the previous behaviour. An unauthenticated run still
   * completes, still publishes a report and still files tickets — it simply cannot evaluate
   * a single authorisation, IDOR or cross-tenant assertion. One such run produced 387
   * "defects" of which 296 were assertion failures downstream of the auth outage, and 22
   * Critical against a baseline of 130. A quiet run that proves nothing is worse than a
   * loud failure, so the loud failure is now the default.
   */
  allowUnauthenticatedRun: optionalBool('ALLOW_UNAUTHENTICATED_RUN', false),

  /* -------------------------------------------------------------------- OTP / test -- */

  /**
   * Test environments typically short-circuit OTP verification to a fixed code rather than
   * dispatching a real SMS. Tests that must clear an OTP gate use this value; when the
   * backend does not honour it the affected assertions report the failure explicitly
   * instead of silently passing.
   */
  mockOtp: optional('TEST_MOCK_OTP', '123456'),
  /** Secondary code tried when the primary mock OTP is rejected. */
  mockOtpFallback: optional('TEST_MOCK_OTP_FALLBACK', '000000'),

  /** Every OTP-dispatching test routes here so runs can't fan out SMS/email to real numbers. */
  testMobile: required('TEST_MOBILE', '9999999999'),
  testEmail: required('TEST_EMAIL', 'qa-test@example.com'),
  testCountryId: optionalNumber('TEST_COUNTRY_ID', 1),

  /** Emit authentication diagnostics to the console when a session cannot be established. */
  verboseAuthDiagnostics: optionalBool('VERBOSE_AUTH_DIAGNOSTICS', true),
} as const;

/** Candidate OTP values, in the order the auth helper will try them. */
export const MOCK_OTP_CANDIDATES: readonly string[] = Array.from(
  new Set([env.mockOtp, env.mockOtpFallback, '123456', '000000'])
);
