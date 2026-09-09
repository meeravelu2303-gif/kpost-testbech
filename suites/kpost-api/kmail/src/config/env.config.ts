import dotenv from 'dotenv';
import path from 'path';
import { deriveDeviceId, environmentKey } from '../helpers/tokenStore';

/*
 * `quiet: true` because dotenv v17 prints a banner ("injected env (19) from .env") to stdout
 * on load, and this module is imported by `playwright.config.ts` — so the banner lands on
 * stdout of *every* command, including `playwright test --list --reporter=json`, putting a
 * non-JSON first line into anything that parses that output.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.resolve(REPO_ROOT, '.env'), quiet: true });

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

/** `host:port` of a base URL, for labelling a run by the environment it ran against. */
export function hostOf(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return baseURL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

/**
 * The service under test. Every request issued from `tests/` goes here.
 *
 * Defaulted to the port the KMail Spring service binds locally, so a developer who has the
 * service running needs only credentials in `.env` to get a run.
 */
const kmailBaseURL = optional('KMAIL_BASE_URL', 'http://localhost:9081').replace(/\/+$/, '');

/**
 * The KPOST platform API — **not** the service under test.
 *
 * KMail's OpenAPI document declares one security scheme, `bearerAuth`, described as a "JWT
 * issued by the KPOST auth service". KMail therefore has no login route of its own: the auth
 * handler logs in here, and presents the resulting token to `kmailBaseURL`. The two hosts are
 * separate settings because they are separate deployments and drift apart routinely.
 */
const authBaseURL = optional('KPOST_AUTH_BASE_URL', 'http://localhost:8989').replace(/\/+$/, '');

const qaKpostId = optional('QA_KPOST_ID', '');

export const env = {
  kmailBaseURL,
  authBaseURL,
  apiTimeout: optionalNumber('API_TIMEOUT', 30000),
  isCI: process.env.CI === 'true' || process.env.CI === '1',
  workers: optionalNumber('TEST_WORKERS', 4),

  /**
   * Fingerprint of the **auth** environment, not the KMail one.
   *
   * The cache key has to name whichever backend minted the token, because that is the only
   * thing that decides whether the token authenticates. Keying it on the KMail host instead
   * would happily reuse a token from a different platform deployment and report the result as
   * "Invalid Credential" — indistinguishable from a wrong password.
   */
  environmentKey: environmentKey(authBaseURL),

  /* ------------------------------------------------------------------ credentials -- */

  /**
   * **The only auth configuration that belongs in `.env`.**
   *
   * A username and a password are stable facts about an account. A bearer token is derived
   * state with a lifetime, an owning environment and an owning device — it is minted per run
   * by `authSession.ts`, cached under `.auth/`, and never written back into `.env`.
   */
  qaKpostId,
  qaPassword: optional('QA_PASSWORD', ''),

  /**
   * The account tier, sent as `loginRO.userType`. Personal accounts (`@kpostindia.com`) are
   * `PERSONAL`; a business identity (`<handle>@<uniqueName>.kpost.in`) needs the
   * size-suffixed form its company was registered under, e.g. `BUSINESS_M`. Sending the
   * wrong tier fails *before* credential validation on some accounts, so a correct password
   * still cannot authenticate — and the error names neither field.
   */
  qaUserType: optional('QA_USER_TYPE', 'PERSONAL'),
  qaCountryId: optionalNumber('QA_COUNTRY_ID', 1),

  /**
   * A **second real account**, used as the victim in every ownership and IDOR assertion.
   *
   * A victim only proves cross-tenant reach if it owns mail the caller must not see. An
   * identity that does not exist is the worst possible choice: the API ignores it and serves
   * the caller's own data, so a test comparing "mine" against "theirs" sees two identical
   * reads and reports a breach that never happened. Unset → those assertions skip with the
   * reason stated rather than filing a finding they cannot substantiate.
   */
  qaVictimKpostId: optional('QA_VICTIM_KPOST_ID', ''),

  /**
   * The device identity the bench presents. Derived deterministically from
   * (auth host, QA_KPOST_ID) unless pinned, so the suite looks like **one** installation
   * rather than opening a fresh login-session row on every login — see `deriveDeviceId`.
   */
  qaDeviceId: optional('QA_DEVICE_ID', deriveDeviceId(authBaseURL, qaKpostId)),

  /* ---------------------------------------------------------------- session cache -- */

  /** Where the run-scoped session is cached. Gitignored, written 0600. */
  authStateFile: path.resolve(REPO_ROOT, optional('AUTH_STATE_FILE', '.auth/session.json')),

  /**
   * Refresh a token with less than this many seconds left rather than carrying it into the
   * run. A worker holds its token for the whole suite and the attachment specs stream
   * multi-megabyte uploads, so anything under ~5 minutes would expire mid-flight and produce
   * failures that look like defects.
   */
  tokenRefreshSkewSeconds: optionalNumber('TOKEN_REFRESH_SKEW_SECONDS', 600),

  /**
   * Whether a run may proceed with no session at all.
   *
   * Defaults to **false**. An unauthenticated run still completes and still publishes a
   * report — it simply cannot evaluate a single authorisation, IDOR or cross-tenant
   * assertion, which is most of what this suite exists to do. A quiet run that proves
   * nothing is worse than a loud failure, so the loud failure is the default.
   */
  allowUnauthenticatedRun: optionalBool('ALLOW_UNAUTHENTICATED_RUN', false),

  /** Emit authentication diagnostics to the console when a session cannot be established. */
  verboseAuthDiagnostics: optionalBool('VERBOSE_AUTH_DIAGNOSTICS', true),

  /* ---------------------------------------------------------------- send behaviour -- */

  /**
   * The domain synthetic recipients are built under.
   *
   * **KMail delivers real mail.** Every recipient default in `src/api/payloads/` is a
   * synthetic, non-existent address on this domain, because a plausible-looking generated
   * address could collide with a live subscriber and this suite fires the send routes
   * hundreds of times per run.
   */
  syntheticMailDomain: optional('QA_SYNTHETIC_MAIL_DOMAIN', 'kpostindia.com'),

  /**
   * Whether the bulk-campaign specs may actually fan out.
   *
   * `postBulkMail` generates one `KmailMaster`/`KmailTransaction` set and one MongoDB body
   * document **per recipient**, and it cannot be undone in one action. Opt-in, and the specs
   * assert the documented limits rather than trying to exceed them.
   */
  allowBulkSend: optionalBool('ALLOW_BULK_SEND', false),

  /**
   * Largest attachment the suite will construct, in megabytes.
   *
   * The limit specs assert that the service *bounds* uploads, so they need a buffer big
   * enough to cross a plausible threshold — but a bench that builds an unbounded one can
   * exhaust the S3 bucket or the service heap, which is a self-inflicted outage rather than
   * a finding.
   */
  maxAttachmentMb: optionalNumber('MAX_ATTACHMENT_MB', 6),
} as const;
