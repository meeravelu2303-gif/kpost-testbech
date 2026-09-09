/**
 * Centralized, type-safe environment configuration.
 *
 * Reads from process.env (populated by dotenv in playwright.config.ts) and
 * exposes a single frozen `env` object. Keeping all environment access behind
 * this module means tests and page objects never touch process.env directly,
 * which makes them portable across local / dev / staging / CI.
 */
import { config as loadDotenv } from 'dotenv';
import { environmentName } from '../utils/environment';

// Load `.env` if present. In CI, real values come from injected env vars,
// so a missing `.env` file is not an error.
loadDotenv();

/**
 * Reads a required env var and fails loudly at startup if it is missing.
 *
 * Deliberately takes no fallback: a credential that silently defaults to a
 * placeholder produces an opaque login timeout deep inside global setup instead
 * of a readable configuration error here.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        `Copy .env.example to .env or set it in your CI secrets.`,
    );
  }
  return value;
}

/** Reads an optional env var with a default. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toBool(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
}

function toIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Read an optional credential pair. Returns undefined when neither is set, and
 * throws when only one is — a half-configured account is a mistake worth
 * catching at startup rather than as a confusing login failure later.
 */
function optionalCredentials(emailVar: string, passwordVar: string): Credentials | undefined {
  const email = process.env[emailVar];
  const password = process.env[passwordVar];
  const hasEmail = email !== undefined && email !== '';
  const hasPassword = password !== undefined && password !== '';

  if (!hasEmail && !hasPassword) return undefined;
  if (!hasEmail || !hasPassword) {
    throw new Error(
      `"${emailVar}" and "${passwordVar}" must be set together — found only ` +
        `${hasEmail ? emailVar : passwordVar}.`,
    );
  }
  return { email, password };
}

const directoryUser = optionalCredentials('DIRECTORY_USER_EMAIL', 'DIRECTORY_USER_PASSWORD');

/**
 * The account the AUTH specs drive the real login/logout flow as.
 *
 * It must NOT be the standard user. KPost allows one active session per
 * account, so a spec that signs in as the standard user invalidates the shared
 * `storageState` global setup captured for that same account — and every
 * authenticated test that runs afterwards is silently logged out, failing on a
 * confusing "Execution context was destroyed" several layers from the cause.
 * That was measured, not theorised: on 2026-08-27 the stored session was
 * verified working by global setup, the auth specs ran, and the same stored
 * session then redirected `/home` to `/login`.
 *
 * Defaults to the admin account, which no spec otherwise uses. Override with
 * AUTH_USER_EMAIL / AUTH_USER_PASSWORD to give the auth journeys an account of
 * their very own — which is what you want as soon as anything starts asserting
 * on admin-specific behaviour.
 */
const authUser = optionalCredentials('AUTH_USER_EMAIL', 'AUTH_USER_PASSWORD');

/** The scheme+host+port of a URL, or undefined if it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Read the optional dashboard pair; both-or-neither, like credentials. */
function optionalDashboard(): {
  ingestUrl: string | undefined;
  apiKey: string | undefined;
  publicUrl: string | undefined;
} {
  const ingestUrl = process.env.DASHBOARD_INGEST_URL || undefined;
  const apiKey = process.env.DASHBOARD_API_KEY || undefined;
  if ((ingestUrl === undefined) !== (apiKey === undefined)) {
    throw new Error(
      '"DASHBOARD_INGEST_URL" and "DASHBOARD_API_KEY" must be set together — found only ' +
        `${ingestUrl ? 'DASHBOARD_INGEST_URL' : 'DASHBOARD_API_KEY'}.`,
    );
  }
  // DASHBOARD_INGEST_URL is a server-to-server address — often `localhost`,
  // which is meaningless in a link handed to a person on another machine.
  // DASHBOARD_PUBLIC_URL is the address a browser can actually reach; it
  // falls back to the ingest URL's origin only when the two happen to
  // coincide (set it explicitly whenever the dashboard sits behind a
  // different host/port/proxy than the ingest endpoint).
  const publicUrl = (process.env.DASHBOARD_PUBLIC_URL || undefined) ?? (ingestUrl ? originOf(ingestUrl) : undefined);
  return { ingestUrl, apiKey, publicUrl };
}

/** Read the optional Bugzilla pair; both-or-neither, like credentials. */
function optionalBugzilla(): {
  url: string | undefined;
  apiKey: string | undefined;
  product: string;
  version: string;
  dryRun: boolean;
} {
  const url = process.env.BUGZILLA_URL || undefined;
  const apiKey = process.env.BUGZILLA_API_KEY || undefined;
  if ((url === undefined) !== (apiKey === undefined)) {
    throw new Error(
      '"BUGZILLA_URL" and "BUGZILLA_API_KEY" must be set together — found only ' +
        `${url ? 'BUGZILLA_URL' : 'BUGZILLA_API_KEY'}.`,
    );
  }
  return {
    url,
    apiKey,
    product: optional('BUGZILLA_PRODUCT', 'KPost UI'),
    version: optional('BUGZILLA_VERSION', 'unspecified'),
    // Defaults to true: filing real tickets is a deliberate opt-in, not a side
    // effect of running the suite.
    dryRun: toBool(optional('BUGZILLA_DRY_RUN', 'true')),
  };
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface EnvConfig {
  /**
   * Short environment CODE — `Local` / `QA` / `Staging` / `Production` / `Unknown`,
   * or an explicit `TEST_ENV` override. Never a URL: this is the string the QA
   * Dashboard groups runs by, and it must match what the API bench sends for the
   * same environment (see `src/utils/environment.ts`). The target URL lives in
   * `baseURL` and is reported separately.
   */
  readonly testEnv: string;
  readonly baseURL: string;
  readonly apiBaseURL: string;
  readonly headless: boolean;
  readonly slowMo: number;
  readonly workers: number | undefined;
  readonly retries: number | undefined;
  readonly isCI: boolean;
  readonly users: {
    readonly standard: Credentials;
    readonly admin: Credentials;
    /**
     * The account `tests/auth/` drives the real login and logout flows as.
     * NEVER the standard user — see the note on `authUser` above: signing in
     * as the standard user invalidates the shared session every other spec
     * depends on. Defaults to `admin`.
     */
    readonly auth: Credentials;
    /**
     * OPTIONAL account that has already completed KDirectory onboarding.
     *
     * KDirectory's search, contact list, and filters sit behind a one-time
     * setup wizard, and completing it permanently onboards an account into a
     * vertical — so the shared standard user is deliberately left un-onboarded.
     * Set DIRECTORY_USER_EMAIL / DIRECTORY_USER_PASSWORD to point the gated
     * specs at a user that is already through it; leave unset and they skip
     * with a reason. Both variables must be set together.
     */
    readonly directory?: Credentials;
  };
  /** True when a pre-onboarded directory user is configured. */
  readonly hasDirectoryUser: boolean;
  readonly mail: {
    /**
     * OPTIONAL recipient for the KMail send E2E test. The backend rejects
     * sending to yourself ("Duplicate IDs are present in ToAddress, CopyList,
     * or ConfidentialCopyList" — the app auto-appends the sender), so the full
     * success path needs a second KPOST account. Unset → the send test verifies
     * the compose/send mechanics against that documented self-send rejection.
     */
    readonly recipient: string | undefined;
  };
  /**
   * OPTIONAL external QA dashboard (the separate QA-Dashboard repo). When both
   * values are set, `DashboardReporter` posts every run's summary and observed
   * known defects to `POST {ingestUrl}` with `Authorization: Bearer {apiKey}`.
   * Leave both unset and the reporter no-ops. Set only one and startup fails.
   */
  readonly dashboard: {
    readonly ingestUrl: string | undefined;
    readonly apiKey: string | undefined;
    /**
     * Browser-reachable base URL for the dashboard's own UI (e.g.
     * `http://192.168.0.50:8081`), used to link a defect's `/defects/:id`
     * evidence page — with a real `<video>` player — from places like a filed
     * Bugzilla ticket. Defaults to `ingestUrl`'s origin; override with
     * `DASHBOARD_PUBLIC_URL` when that origin isn't what a person's browser
     * can actually reach (e.g. ingest goes over `localhost`).
     */
    readonly publicUrl: string | undefined;
  };
  /**
   * OPTIONAL Bugzilla instance (the separate BUGZILLA-UI-fronted deployment
   * the API bench already files into, under its own "KPost API" product).
   * This bench files into its own "KPost UI" product instead, so the two
   * benches never share or collide on tickets. Both values unset → no-op;
   * set only one → startup fails. `dryRun` defaults true — filing real
   * tickets is an explicit opt-in via `BUGZILLA_DRY_RUN=false`.
   */
  readonly bugzilla: {
    readonly url: string | undefined;
    readonly apiKey: string | undefined;
    readonly product: string;
    readonly version: string;
    readonly dryRun: boolean;
  };
  /**
   * Who a defect found by this bench is assigned to, carried into
   * `BUG_REPORT.*` and the dashboard's Owner field.
   *
   * Defaults to the UI team lead, because every defect this bench can find is a
   * KPost **UI** defect and lands with that team. Override with `DEFECT_OWNER`
   * when the team changes, or per defect with an `owner` on its registry entry
   * — that is the escape hatch for a bug that genuinely belongs elsewhere
   * (KPOST-KMAIL-002, for instance, is a backend fault surfaced through the UI).
   */
  readonly defectOwner: string;
  readonly auth: {
    /** 'api' → fast API login for storage state; 'ui' → drive the login form. */
    readonly mode: 'api' | 'ui';
    /** Login endpoint path, relative to apiBaseURL (POST email+password). */
    readonly loginPath: string;
    /** localStorage key the SPA reads the auth token from (token-based apps). */
    readonly tokenStorageKey: string;
  };
}

// Resolved before the object literal so `testEnv` can be derived from it.
const baseURL = optional('BASE_URL', 'https://localhost:3000');

export const env: EnvConfig = Object.freeze({
  testEnv: environmentName(baseURL),
  baseURL,
  apiBaseURL: optional('API_BASE_URL', 'https://localhost:3000/api'),
  headless: toBool(optional('HEADLESS', 'true')),
  slowMo: Number.parseInt(optional('SLOW_MO', '0'), 10),
  workers: toIntOrUndefined(process.env.WORKERS),
  retries: toIntOrUndefined(process.env.RETRIES),
  isCI: toBool(optional('CI', 'false')),
  users: {
    standard: {
      email: required('STANDARD_USER_EMAIL'),
      password: required('STANDARD_USER_PASSWORD'),
    },
    admin: {
      email: required('ADMIN_USER_EMAIL'),
      password: required('ADMIN_USER_PASSWORD'),
    },
    // Falls back to the admin account, which no other spec drives — so the auth
    // journeys never compete with the standard user for the single login slot
    // KPost allows per account.
    auth: authUser ?? {
      email: required('ADMIN_USER_EMAIL'),
      password: required('ADMIN_USER_PASSWORD'),
    },
    ...(directoryUser ? { directory: directoryUser } : {}),
  },
  hasDirectoryUser: directoryUser !== undefined,
  mail: {
    recipient: process.env.MAIL_RECIPIENT || undefined,
  },
  dashboard: optionalDashboard(),
  bugzilla: optionalBugzilla(),
  defectOwner: optional('DEFECT_OWNER', 'Ayyappan'),
  auth: {
    // Defaults to 'ui': KPost stores its session as several localStorage keys
    // (accessToken, refreshToken, isAuthenticated, Authuser, and an encrypted
    // redux-persist blob), so a single injected API token is not enough to boot
    // the SPA authenticated. Set AUTH_MODE=api only once that contract is wired.
    mode: optional('AUTH_MODE', 'ui') as 'api' | 'ui',
    loginPath: optional('AUTH_LOGIN_PATH', '/auth/login'),
    tokenStorageKey: optional('AUTH_TOKEN_STORAGE_KEY', 'accessToken'),
  },
});
