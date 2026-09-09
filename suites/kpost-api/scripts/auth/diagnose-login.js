#!/usr/bin/env node
/**
 * `npm run auth:diagnose` — answers "why can't the bench log in?" in about ten seconds.
 *
 * WHY THIS EXISTS
 * ---------------
 * KPOST's `userLogin` collapses every non-validation failure into one message:
 *
 *     {"statusCode":500,"status":"FAILURE","message":"Invalid Credential", ...}
 *
 * "No such account", "wrong password", "account not active", "wrong environment" and
 * "the service threw" are indistinguishable from the client. `swagger.json` says so in as
 * many words: *"rejected credentials and genuine server faults both report the same
 * message - assert on the absence of accessToken instead."*
 *
 * So the message cannot be debugged by reading it. It has to be debugged by *elimination*,
 * which is what this script does: it probes each candidate cause in turn against the public
 * (`permitAll`) endpoints and prints a single verdict naming the one that fits.
 *
 * It is deliberately dependency-free plain Node (>= 18, for global `fetch`) and does not
 * import anything from `src/`, so it still runs when the framework itself will not compile
 * or when `.env` is the thing that is wrong.
 *
 * USAGE
 *   node scripts/auth/diagnose-login.js
 *   node scripts/auth/diagnose-login.js --host http://192.168.0.158:8989
 *   node scripts/auth/diagnose-login.js --id someone@kpostindia.com --password 'Secret1!'
 *   node scripts/auth/diagnose-login.js --all-hosts     # sweep every known environment
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

/* ------------------------------------------------------------------ .env ---- */

/**
 * Minimal .env reader. `dotenv` is a devDependency of the framework, and this script has to
 * work even when `npm install` has not been run, so the five lines are inlined.
 */
function readEnvFile(file) {
  const out = {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------------- cli ---- */

function parseArgs(argv) {
  const args = { allHosts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all-hosts') args.allHosts = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--user-type') args.userType = argv[++i];
  }
  return args;
}

/* ------------------------------------------------------------------- jwt ---- */

/** Decodes a JWT's claims without verifying its signature (we hold no key). */
function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }
}

function describeToken(token) {
  const claims = decodeJwt(token);
  if (!claims) return 'not a decodable JWT';
  const now = Math.floor(Date.now() / 1000);
  const bits = [];
  if (claims.sub) bits.push(`sub=${claims.sub}`);
  if (claims.kpostID) bits.push(`kpostID=${claims.kpostID}`);
  if (claims.role) bits.push(`role=${claims.role}`);
  if (claims.deviceID) bits.push(`deviceID=${claims.deviceID}`);
  if (claims.iat) bits.push(`issued=${new Date(claims.iat * 1000).toISOString()}`);
  if (claims.exp) {
    const left = claims.exp - now;
    bits.push(
      left <= 0
        ? `EXPIRED ${(-left / 3600).toFixed(1)}h ago (${new Date(claims.exp * 1000).toISOString()})`
        : `valid ${(left / 3600).toFixed(1)}h more (${new Date(claims.exp * 1000).toISOString()})`
    );
    if (claims.iat) bits.push(`ttl=${((claims.exp - claims.iat) / 3600).toFixed(1)}h`);
  }
  return bits.join(', ');
}

/* ------------------------------------------------------------------ http ---- */

const TIMEOUT_MS = Number(process.env.DIAGNOSE_TIMEOUT_MS || 15000);

async function call(baseURL, routePath, { method = 'POST', body, token } = {}) {
  const url = `${baseURL.replace(/\/+$/, '')}${routePath}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body; `text` is still reported */
    }
    return { ok: true, status: response.status, text, json, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      ms: Date.now() - startedAt,
      error: error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function snippet(value, max = 220) {
  const collapsed = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}...`;
}

/**
 * Reads KPOST's failure envelope.
 *
 * The platform answers a *failed* signup, login or OTP send with **HTTP 200 carrying
 * `statusCode: 500` and `status: "FAILURE"`**, so branching on the HTTP status reads every
 * one of those failures as a success. Anything in this file that asks "did that work?" must
 * go through here.
 */
function envelopeFailure(result) {
  if (!result.ok) return result.error || 'transport failure';
  if (result.status >= 400) return `HTTP ${result.status}`;
  const parsed = result.json;
  if (!parsed || typeof parsed !== 'object') return null;
  const status = typeof parsed.status === 'string' ? parsed.status.toUpperCase() : null;
  const code = typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
  const failed =
    status === 'FAILURE' || status === 'ERROR' || (code !== null && code >= 400);
  if (!failed) return null;
  return parsed.message || parsed.errorMsg || parsed.msg || 'unspecified failure';
}

function extractTokens(result) {
  const parsed = result.json;
  if (!parsed || typeof parsed !== 'object') return { accessToken: null, refreshToken: null };
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  return {
    accessToken:
      (typeof parsed.accessToken === 'string' && parsed.accessToken) ||
      (typeof data.accessToken === 'string' && data.accessToken) ||
      null,
    refreshToken:
      (typeof parsed.refreshToken === 'string' && parsed.refreshToken) ||
      (typeof data.refreshToken === 'string' && data.refreshToken) ||
      null,
  };
}

/* -------------------------------------------------------------- payloads ---- */

/**
 * The four login body shapes this API has been documented or observed to use.
 *
 * They are tried in order and the first one that yields a token wins. This exists because
 * the shape is genuinely ambiguous across the project's own sources:
 *
 *   - `docs/api.json` (the team's endpoint log) shows `loginRO:{countryID,password,userType}`
 *     with `kpostID` on the OUTER object;
 *   - `swagger.json`'s `LoginRO` schema *also* declares `kpostID` and a `requestType`
 *     constrained to `^(Admin|User|SubAdmin)$`;
 *   - `swagger.json`'s `userLogin` request **example** puts `password` at the TOP level.
 *
 * Guessing between them by reading is how this cost days. Probing settles it in one run.
 */
function loginVariants(kpostID, password, userType, countryID, deviceID) {
  const logintime = Date.now();
  const base = {
    kpostID,
    deviceType: 'Web',
    deviceIdentity_primary: deviceID,
    deviceIdentity_secondary: 'Desktop-Chrome-151',
    sessionID: `${deviceID}${logintime}`,
    logintime,
    login_lattitude: null,
    login_longitude: null,
    oneSignal_Key: '',
  };

  return [
    {
      name: 'A: loginRO{countryID,password,userType}  (docs/api.json shape - current bench)',
      body: { ...base, loginRO: { countryID, password, userType } },
    },
    {
      name: 'B: A + loginRO.kpostID                    (swagger LoginRO declares it)',
      body: { ...base, loginRO: { countryID, password, userType, kpostID } },
    },
    {
      name: 'C: B + loginRO.requestType="User"         (swagger pattern ^(Admin|User|SubAdmin)$)',
      body: { ...base, loginRO: { countryID, password, userType, kpostID, requestType: 'User' } },
    },
    {
      name: 'D: top-level password                     (swagger userLogin example)',
      body: { ...base, password, userType, countryID },
    },
  ];
}

/* ------------------------------------------------------------------ main ---- */

const PATHS = {
  publicKey: '/crypto/public-key',
  kpostIdExist: '/v2/signupLogin/kpostIdExist',
  userLogin: '/v2/signupLogin/userLogin',
  profile: '/v2/profile/getUserProfile',
};

const line = (ch = '-') => ch.repeat(78);

async function probeHost(host, creds) {
  const findings = { host, reachable: false, accountExists: null, token: null, variant: null, notes: [] };

  /* 1 - is anything answering at all? A dead BASE_URL and a rejected password are the same
   *     "Invalid Credential" to the caller, because the bench swallows transport errors. */
  const reach = await call(host, PATHS.publicKey, { method: 'GET' });
  if (!reach.ok) {
    findings.notes.push(`unreachable: ${reach.error}`);
    return findings;
  }
  findings.reachable = true;
  findings.notes.push(`reachable (GET ${PATHS.publicKey} -> HTTP ${reach.status}, ${reach.ms}ms)`);

  /* 2 - does the account exist ON THIS HOST? This is the single most valuable probe in the
   *     script. `kpostIdExist` is permitAll, so it answers without a token, and it separates
   *     "wrong environment / no such account" from "right account, wrong password" - which
   *     `userLogin` itself refuses to do. */
  const exists = await call(host, PATHS.kpostIdExist, {
    body: { kpostID: creds.kpostID, firstName: 'qa', lastName: 'probe' },
  });
  findings.existsRaw = `HTTP ${exists.status} :: ${snippet(exists.text, 300)}`;
  if (exists.ok && exists.json) {
    /* The route reports availability, so the polarity is inverted: "available" means the
     * account does NOT exist. Both spellings of the payload key are checked because this
     * API is not consistent about `data` vs top level. */
    const blob = JSON.stringify(exists.json).toLowerCase();
    if (blob.includes('already') || blob.includes('exist')) {
      findings.accountExists = !blob.includes('not exist') && !blob.includes('available');
    }
  }

  /* 3 - try each documented login shape. */
  for (const variant of loginVariants(
    creds.kpostID,
    creds.password,
    creds.userType,
    creds.countryID,
    creds.deviceID
  )) {
    const response = await call(host, PATHS.userLogin, { body: variant.body });
    const failure = envelopeFailure(response);
    const { accessToken, refreshToken } = extractTokens(response);

    if (accessToken) {
      /* A token in the body is not proof. `AuthenticationFilter` matches the token's
       * `deviceID` claim against the login-session table on every later request, so a token
       * can be issued and still authenticate nothing. Verify on a real protected read. */
      const verify = await call(host, PATHS.profile, { method: 'GET', token: accessToken });
      if (verify.status === 200) {
        findings.token = accessToken;
        findings.refreshToken = refreshToken;
        findings.variant = variant.name;
        findings.notes.push(`LOGIN OK via variant ${variant.name[0]} - token honoured by ${PATHS.profile}`);
        return findings;
      }
      findings.notes.push(
        `${variant.name[0]}: token issued but ${PATHS.profile} answered HTTP ${verify.status} - the session is not live`
      );
      continue;
    }

    findings.notes.push(`${variant.name[0]}: ${failure || `no token (HTTP ${response.status})`}`);
  }

  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fileEnv = readEnvFile(ENV_PATH);
  const cfg = { ...fileEnv, ...process.env };

  const kpostID = args.id || cfg.QA_KPOST_ID || '';
  const password = args.password || cfg.QA_PASSWORD || '';
  const userType = args.userType || cfg.QA_USER_TYPE || 'PERSONAL';
  const countryID = Number(cfg.TEST_COUNTRY_ID || cfg.QA_COUNTRY_ID || 1);
  const deviceID = cfg.QA_DEVICE_ID || crypto.randomUUID();

  const configured = (cfg.BASE_URL || 'http://localhost:8989').replace(/\/+$/, '');

  /* Every host this repository has ever pointed at, recovered from the .env.example history
   * in git. The account was created against ONE of them; a credential is only meaningful
   * against the database behind the host that minted it. */
  const KNOWN_HOSTS = [
    configured,
    'http://localhost:8989',
    'http://192.168.0.158:8989',
    'http://192.168.1.58:8989',
    'http://192.168.1.1:8989',
  ];
  const hosts = args.host
    ? [args.host.replace(/\/+$/, '')]
    : args.allHosts
      ? [...new Set(KNOWN_HOSTS)]
      : [configured];

  console.log(`\n${line('=')}`);
  console.log('KPOST AUTH DIAGNOSTIC');
  console.log(line('='));
  console.log(`repo        : ${REPO_ROOT}`);
  console.log(`BASE_URL    : ${configured}`);
  console.log(`QA_KPOST_ID : ${kpostID || '(not set)'}`);
  console.log(`QA_PASSWORD : ${password ? `${password.length} chars, set` : '(not set)'}`);
  console.log(`userType    : ${userType}   countryID: ${countryID}`);
  console.log(`deviceID    : ${deviceID}${cfg.QA_DEVICE_ID ? ' (pinned)' : ' (random - set QA_DEVICE_ID to pin it)'}`);

  if (cfg.QA_AUTH_TOKEN && cfg.QA_AUTH_TOKEN !== 'placeholder_jwt_token') {
    console.log(`\nQA_AUTH_TOKEN in .env: ${describeToken(cfg.QA_AUTH_TOKEN)}`);
    const claims = decodeJwt(cfg.QA_AUTH_TOKEN) || {};
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      console.log(
        '  -> This token is dead. A static token cannot be the suite\'s auth strategy;\n' +
          '     it is stale every 24h by construction. See docs/AUTHENTICATION.md.'
      );
    }
  }

  if (!kpostID || !password) {
    console.log('\nQA_KPOST_ID / QA_PASSWORD are not both set, so there is nothing to test.');
    console.log('Set them in .env (see .env.example) and re-run.\n');
    process.exit(2);
  }

  const results = [];
  for (const host of hosts) {
    console.log(`\n${line()}`);
    console.log(`PROBING ${host}`);
    console.log(line());
    const finding = await probeHost(host, { kpostID, password, userType, countryID, deviceID });
    results.push(finding);
    for (const note of finding.notes) console.log(`  . ${note}`);
    if (finding.existsRaw) console.log(`  . kpostIdExist -> ${finding.existsRaw}`);
  }

  /* --------------------------------------------------------------- verdict -- */

  const winner = results.find((r) => r.token);
  console.log(`\n${line('=')}`);
  console.log('VERDICT');
  console.log(line('='));

  if (winner) {
    console.log(`\nAuthentication WORKS against ${winner.host}`);
    console.log(`  payload shape : ${winner.variant}`);
    console.log(`  token         : ${describeToken(winner.token)}`);
    if (winner.host !== configured) {
      console.log(
        `\n  >>> THE CAUSE: your credentials belong to ${winner.host}, but BASE_URL is ${configured}.\n` +
          '      Different host = different MySQL = the account does not exist where the suite\n' +
          '      is pointed, and KPOST reports that as "Invalid Credential". Point BASE_URL at\n' +
          `      ${winner.host}, or create the QA account on ${configured}.`
      );
    } else {
      console.log(
        '\n  Nothing more to do: run `npm run auth:check`, then `npm test`. The session\n' +
          '  manager mints and refreshes this token per run - do NOT paste it into .env.'
      );
    }
    process.exit(0);
  }

  const anyReachable = results.some((r) => r.reachable);
  if (!anyReachable) {
    console.log(
      '\nNo candidate host answered at all.\n' +
        '  The backend is down, or BASE_URL names a host this machine cannot route to.\n' +
        '  Start the KPOST service and re-run. Until then every auth failure is a red herring.'
    );
    process.exit(1);
  }

  console.log(
    '\nThe backend answered, but no login shape produced a usable session on any host tried.\n\n' +
      'Remaining causes, in the order worth checking:\n\n' +
      '  1. The account does not exist in this environment\'s database.\n' +
      `     Confirm directly:  SELECT kpostID, activeStatus, userType, createdDate\n` +
      `                        FROM user WHERE kpostID = '${kpostID}';\n` +
      '     No row -> you created it on a different environment. Re-run with --all-hosts,\n' +
      '     or create a dedicated QA account on this one.\n\n' +
      '  2. The account exists but is not active.\n' +
      '     Signup writes the row before mobile verification clears, so an unverified\n' +
      '     account authenticates as "Invalid Credential" forever. Check activeStatus.\n\n' +
      '  3. The stored password is not the one in .env.\n' +
      '     The column is hashed, so compare by resetting it through the product\'s own\n' +
      '     flow rather than by reading it. Never hand-edit the hash.\n\n' +
      '  4. The password is expected ENCRYPTED, not plaintext.\n' +
      '     docs/api.json records a real adminUserLogin body carrying\n' +
      '     "password": "0FPnV+OKhDGGXMkQjtj1eQ==" - 16 bytes of base64, i.e. one AES block,\n' +
      '     not a plaintext password. If the web client encrypts before POSTing, a plaintext\n' +
      '     password can never authenticate. Capture one real login from the browser\'s\n' +
      '     network tab and compare the password field byte for byte with what you send.\n\n' +
      '  5. The account is locked or its device cap is reached.\n' +
      '     swagger.json: "Failed attempts may feed lockout counters." Every login the bench\n' +
      '     made used a fresh random deviceIdentity_primary, so it opened a new session row\n' +
      '     each time. Check the login-session table for this kpostID.\n'
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n[diagnose] unexpected failure: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
