import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Run-scoped session cache.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bench used to carry a bearer token in `.env` as `QA_AUTH_TOKEN`. That cannot work, and
 * the failure is structural rather than a bug that can be fixed in place:
 *
 *   1. **It expires.** KPOST access tokens carry a 24h `exp`. A token pasted into `.env` on
 *      Monday is dead on Tuesday, and the suite's response was to run anyway and publish a
 *      report - 387 "defects", of which 296 were assertion failures downstream of the auth
 *      outage.
 *   2. **It is environment-bound and nothing enforced that.** `BASE_URL` has pointed at four
 *      different hosts in this repository's history. A token minted against one host's MySQL
 *      is meaningless against another's, but `.env` has no idea which host its token came
 *      from, so the mismatch surfaced as `"Invalid Credential"` - the same message KPOST uses
 *      for a wrong password. Days were spent debugging a password that was never wrong.
 *   3. **It is device-bound.** `AuthenticationFilter` matches the token's `deviceID` claim
 *      against the login-session table on every request. A token whose session row has been
 *      closed authenticates nothing, no matter how much of its `exp` remains.
 *
 * So a token is not configuration - it is derived state with a lifetime, an owning
 * environment and an owning device. This module treats it that way: the cache records what
 * the token was minted against and refuses to hand it back to a different target.
 *
 * The file is written with mode 0600 and lives under `.auth/`, which is gitignored. Nothing
 * here ever writes a credential back into `.env`.
 */

export interface JwtClaims {
  sub?: string;
  kpostID?: string;
  role?: string;
  deviceID?: string;
  companyID?: number;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Decodes a JWT's claim set **without verifying the signature**, which the client cannot do
 * - the signing key never leaves the server. Used only to read `exp` so the bench can
 * refresh proactively instead of discovering staleness through a 401 mid-suite.
 */
export function decodeJwt(token: string | null | undefined): JwtClaims | null {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  for (const encoding of ['base64url', 'base64'] as const) {
    try {
      return JSON.parse(Buffer.from(parts[1], encoding).toString('utf-8')) as JwtClaims;
    } catch {
      /* try the next encoding */
    }
  }
  return null;
}

/** Seconds of life left on a token, or `null` when it carries no `exp` claim. */
export function secondsRemaining(token: string | null | undefined): number | null {
  const claims = decodeJwt(token);
  if (!claims?.exp) return null;
  return claims.exp - Math.floor(Date.now() / 1000);
}

/**
 * True when the token is expired, or close enough that it would die mid-run.
 *
 * `skewSeconds` is not paranoia: a full suite runs for ~4 minutes and a worker holds its
 * token for the whole of it, so a token with two minutes left is already useless.
 */
export function isExpiredOrExpiring(token: string | null | undefined, skewSeconds: number): boolean {
  const left = secondsRemaining(token);
  if (left === null) return false; // no exp claim - the server decides, not us
  return left <= skewSeconds;
}

/** Human-readable one-liner for run logs and failure messages. */
export function describeToken(token: string | null | undefined): string {
  const claims = decodeJwt(token);
  if (!claims) return 'not a decodable JWT';

  const bits: string[] = [];
  const subject = claims.sub ?? claims.kpostID;
  if (subject) bits.push(`subject ${subject}`);
  if (claims.deviceID) bits.push(`device ${claims.deviceID}`);

  const left = secondsRemaining(token);
  if (left === null) {
    bits.push('no exp claim');
  } else if (left <= 0) {
    bits.push(`EXPIRED ${(-left / 3600).toFixed(1)}h ago at ${new Date(claims.exp! * 1000).toISOString()}`);
  } else {
    bits.push(`valid for ${(left / 3600).toFixed(1)}h (until ${new Date(claims.exp! * 1000).toISOString()})`);
  }
  return bits.join(', ');
}

/**
 * Identifies the environment a credential or token belongs to.
 *
 * Hashed rather than stored raw so the cache key is fixed-width and a stray `BASE_URL`
 * with credentials in it cannot leak through the filename.
 */
export function environmentKey(baseURL: string): string {
  return crypto.createHash('sha256').update(baseURL.replace(/\/+$/, '')).digest('hex').slice(0, 16);
}

/**
 * A stable device identity for this (environment, account) pair.
 *
 * `deviceIdentity_primary` was `faker.string.uuid()` - a **new UUID on every login call**.
 * Three costs, all of which showed up in production runs:
 *
 *   - every worker's login opened a *new* login-session row, so one `npm test` with four
 *     workers left four sessions behind, and weeks of runs left hundreds;
 *   - a token could never be shared between workers or reused across runs, because each was
 *     bound to a device that only one caller knew about;
 *   - accounts with a device cap eventually refuse further logins, reported - inevitably -
 *     as `"Invalid Credential"`.
 *
 * Deriving it deterministically means the bench presents itself as **one device**, exactly
 * as a real client installation would. `QA_DEVICE_ID` overrides it when a specific value is
 * needed; the derived default means nobody has to set anything for it to be stable.
 */
export function deriveDeviceId(baseURL: string, kpostID: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`kpost-testbench|${baseURL}|${kpostID}`)
    .digest('hex');
  // Formatted as a v4-shaped UUID: the server stores it as an opaque string, but every real
  // client sends a UUID and a value that does not look like one is an unnecessary variable.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export interface CachedSession {
  /** Hash of the `BASE_URL` this token was minted against. A mismatch invalidates the entry. */
  environmentKey: string;
  /** Kept in plain text purely so a human reading the file can see which target it belongs to. */
  baseURL: string;
  kpostID: string;
  deviceID: string;
  token: string;
  refreshToken: string | null;
  strategy: string;
  mintedAt: string;
}

/**
 * Reads the cached session, returning `null` unless it is valid **for this exact target**.
 *
 * The environment check is the point of the cache, not an extra: reusing a token across
 * environments is the failure this whole module exists to make impossible.
 */
export function readCachedSession(
  file: string,
  baseURL: string,
  skewSeconds: number
): { session: CachedSession | null; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { session: null, reason: 'no cached session on disk' };
  }

  let parsed: CachedSession;
  try {
    parsed = JSON.parse(raw) as CachedSession;
  } catch {
    return { session: null, reason: 'cached session file is not valid JSON' };
  }

  if (!parsed.token) return { session: null, reason: 'cached session carries no token' };

  const expected = environmentKey(baseURL);
  if (parsed.environmentKey !== expected) {
    return {
      session: null,
      reason: `cached session was minted against ${parsed.baseURL ?? 'an unknown target'}, not ${baseURL} - discarded rather than reused`,
    };
  }

  if (isExpiredOrExpiring(parsed.token, skewSeconds)) {
    const left = secondsRemaining(parsed.token);
    // Distinguished deliberately: "expired" and "inside the refresh window" are different
    // situations, and a run log that conflates them sends the reader looking for the wrong
    // problem. The second is the healthy case — the bench refreshing before it has to.
    const why =
      left !== null && left > 0
        ? `cached token has ${Math.round(left)}s left, under the ${skewSeconds}s refresh window — refreshing early`
        : 'cached token is expired';
    return { session: null, reason: `${why} (${describeToken(parsed.token)})` };
  }

  return { session: parsed, reason: `cached token reused (${describeToken(parsed.token)})` };
}

/** Persists a freshly minted session. Best-effort: a cache miss costs a login, never a run. */
export function writeCachedSession(file: string, session: CachedSession): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    /* The cache is an optimisation. Losing it must never fail a run. */
  }
}

export function clearCachedSession(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to clear */
  }
}
