import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Token and session-cache primitives.
 *
 * KMail issues no credentials of its own — `bearerAuth` in its OpenAPI document is "JWT
 * issued by the KPOST auth service" — so everything here is about handling a token minted
 * elsewhere: reading its expiry without the signing key, scoping it to the environment and
 * device it belongs to, and caching it between runs.
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
 * Decodes a JWT's claim set **without verifying the signature**, which the client cannot do —
 * the signing key never leaves the server. Used only to read `exp` so the bench can refresh
 * proactively instead of discovering staleness through a 401 halfway through the suite.
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
 * `skewSeconds` is not paranoia: a worker holds its token for the whole suite, and the
 * attachment specs stream multi-megabyte uploads, so a token with two minutes left is
 * already useless.
 */
export function isExpiredOrExpiring(token: string | null | undefined, skewSeconds: number): boolean {
  const left = secondsRemaining(token);
  if (left === null) return false; // no exp claim — the server decides, not us
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
    bits.push(
      `EXPIRED ${(-left / 3600).toFixed(1)}h ago at ${new Date((claims.exp ?? 0) * 1000).toISOString()}`
    );
  } else {
    bits.push(
      `valid for ${(left / 3600).toFixed(1)}h (until ${new Date((claims.exp ?? 0) * 1000).toISOString()})`
    );
  }
  return bits.join(', ');
}

/**
 * Identifies the environment a credential or token belongs to.
 *
 * A KPOST account exists in exactly one backend's MySQL and a token minted against one host
 * authenticates nothing against another — the API reports that as `"Invalid Credential"`,
 * indistinguishable from a wrong password. Hashed rather than stored raw so the cache key is
 * fixed-width and a stray URL with credentials in it cannot leak through a filename.
 */
export function environmentKey(baseURL: string): string {
  return crypto.createHash('sha256').update(baseURL.replace(/\/+$/, '')).digest('hex').slice(0, 16);
}

/**
 * A stable device identity for this (environment, account) pair.
 *
 * `AuthenticationFilter` matches the token's `deviceID` claim against the login-session table
 * on every request, so `deviceIdentity_primary` is half the session's identity rather than
 * decoration. A fresh UUID per login would open a new login-session row for every worker,
 * make the token uncacheable, and eventually trip a device cap — reported, inevitably, as
 * "Invalid Credential". Deriving it means the bench presents itself as **one** installation,
 * exactly as a real client does.
 */
export function deriveDeviceId(baseURL: string, kpostID: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`kmail-testbench|${baseURL}|${kpostID}`)
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
  token: string;
  refreshToken: string | null;
  kpostID: string | null;
  deviceID: string | null;
  /** Which backend minted it. A token from another host is silently useless. */
  environmentKey: string;
  mintedAt: string;
}

/**
 * Reads the cached session, returning `null` unless it is usable *here and now*.
 *
 * Three independent reasons to reject a cache hit, all of which have cost real debugging
 * time on this platform: it belongs to another environment, it belongs to another account,
 * or it is about to expire. Each is reported through `reason` so a run log says why it is
 * logging in again rather than silently doing so.
 */
export function readCachedSession(
  file: string,
  expected: { environmentKey: string; kpostID: string; deviceID: string; skewSeconds: number }
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
    return { session: null, reason: 'cached session is not readable JSON' };
  }

  if (!parsed.token) return { session: null, reason: 'cached session carries no token' };

  if (parsed.environmentKey !== expected.environmentKey) {
    return { session: null, reason: 'cached session was minted against a different environment' };
  }

  if (parsed.kpostID && expected.kpostID && parsed.kpostID !== expected.kpostID) {
    return {
      session: null,
      reason: `cached session belongs to ${parsed.kpostID}, not ${expected.kpostID}`,
    };
  }

  if (parsed.deviceID && parsed.deviceID !== expected.deviceID) {
    return { session: null, reason: 'cached session is bound to a different device identity' };
  }

  if (isExpiredOrExpiring(parsed.token, expected.skewSeconds)) {
    return { session: null, reason: `cached token is ${describeToken(parsed.token)}` };
  }

  return { session: parsed, reason: `reused cached token — ${describeToken(parsed.token)}` };
}

/** Writes the session 0600: it is a live credential for the duration of its lifetime. */
export function writeCachedSession(file: string, session: CachedSession): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch {
    // A cache that cannot be written costs one login per run. It must never fail the run.
  }
}

/** Drops the cache, so the next run authenticates from credentials. */
export function clearCachedSession(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to clear */
  }
}
