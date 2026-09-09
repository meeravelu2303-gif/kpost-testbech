#!/usr/bin/env node
/**
 * Pre-creates a pool of throwaway KPOST accounts for the destructive-path tests.
 *
 * ## Why this exists
 *
 * `deactivateAccount` and `changePassword` assert that the API *refuses* an unsafe operation.
 * The whole point of the bench is to find the case where it does not refuse — and the first
 * time that happens against the shared QA identity, the account every other suite depends on is
 * destroyed. So those tests take a `disposableToken`: a session belonging to an account nobody
 * will miss.
 *
 * `freshUser()` mints one over REST, and on this environment it cannot. Signup requires a
 * **verified OTP** for the mobile number, the OTP is randomly generated, and it reaches only
 * SMS and the database. An HTTP client has no way to learn it, so `validateOTP` always fails,
 * `signup` returns `500 "Not Applicable"`, `disposableToken` is null, and roughly 13 tests skip
 * — the tests covering account deactivation and credential change, which is exactly the surface
 * where a defect is most expensive.
 *
 * ## Why it may read the database
 *
 * The bench is a REST client by design and holds no database driver. This script is not the
 * bench: it runs before a run, from `npm run seed:disposable`, and nothing under `tests/` or
 * `src/` imports it. It reads exactly one column — the OTP just issued for a number it invented
 * — and writes nothing. That narrow exception buys back a class of coverage that is otherwise
 * unreachable.
 *
 * **This is a stopgap.** The right fix is a fixed OTP for test numbers on non-production, which
 * makes `freshUser()` work as designed over pure REST. Delete this script the day that lands.
 *
 * ## The flow, per account
 *
 *   1. POST /v2/common/sendOTP      { mobileNumber, requestType: 'SIGNUP' }
 *   2. read the OTP from tbl_kpost_otp_validation   <- the database exception
 *   3. POST /v2/common/validateOTP  { mobileNumber, otp }
 *   4. POST /v2/signupLogin/signup  { kpostID, mobileNumber, password, ... }
 *   5. POST /v2/signupLogin/userLogin -> prove the account works, keep nothing else
 *
 * A fresh random mobile per account matters: reusing one trips the rate limiter with
 * "Try after 24 Hours, OTP sent more than 3 times", which is what made `TEST_MOBILE`
 * unusable for this.
 *
 * Usage:
 *   node scripts/seed/seed-disposable-accounts.js            # top the pool up to POOL_TARGET
 *   node scripts/seed/seed-disposable-accounts.js --count 5  # add exactly 5
 *   node scripts/seed/seed-disposable-accounts.js --status   # report, create nothing
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const LOG = '[seed:disposable]';
const POOL_FILE = path.join(ROOT, '.auth', 'disposable-pool.json');

/**
 * How many unused accounts to keep on hand.
 *
 * Sized to the destructive tests plus headroom: `deactivateAccount` consumes an account
 * outright, and a run that exhausts the pool silently returns to skipping. Topping up is cheap;
 * running dry costs a whole run's coverage of that surface.
 */
const POOL_TARGET = 25;

/** Matches `buildSignupPayload` so a pooled account is indistinguishable from a minted one. */
const PASSWORD = 'Qa@Passw0rd123';

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes('--status');
const countArg = argv.indexOf('--count');
const EXPLICIT_COUNT = countArg !== -1 ? Math.max(0, Number(argv[countArg + 1]) || 0) : null;

const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
if (!BASE_URL) {
  console.error(`${LOG} BASE_URL is not set. Nothing done.`);
  process.exit(2);
}

/* ------------------------------------------------------------------ database read */

const DB = {
  client: process.env.KPOST_DB_CLIENT || 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe',
  host: process.env.KPOST_DB_HOST || '127.0.0.1',
  port: process.env.KPOST_DB_PORT || '3307',
  user: process.env.KPOST_DB_USER || 'root',
  password: process.env.KPOST_DB_PASSWORD || '',
  database: process.env.KPOST_DB_NAME || 'kpost_testdb',
};

/**
 * The one database read. Parameters go through `execFileSync`'s argument array rather than a
 * shell string, so the mobile number cannot be interpreted as anything but a value.
 */
function readLatestOtp(mobileNumber) {
  const args = [
    `-u${DB.user}`,
    ...(DB.password ? [`-p${DB.password}`] : []),
    `-h${DB.host}`,
    `-P${DB.port}`,
    '-N',
    '-B',
    DB.database,
    '-e',
    `SELECT otp FROM tbl_kpost_otp_validation WHERE mobile_number = '${mobileNumber}' ORDER BY id DESC LIMIT 1;`,
  ];
  try {
    return execFileSync(DB.client, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ pool file */

function readPool() {
  try {
    const parsed = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
    return Array.isArray(parsed.accounts) ? parsed : { accounts: [] };
  } catch {
    return { accounts: [] };
  }
}

function writePool(pool) {
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2), 'utf-8');
}

/* ------------------------------------------------------------------ HTTP */

const TIMEOUT_MS = 20_000;

async function post(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, text: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 10-digit Indian-format number, matching the sendOTP country-length rule. */
const randomMobile = () => `9${String(Math.floor(100_000_000 + Math.random() * 899_999_999))}`;
const randomKpostId = () => `qa${Math.random().toString(36).slice(2, 10)}@kpostindia.com`;

/* ------------------------------------------------------------------ one account */

async function createAccount() {
  const mobileNumber = randomMobile();
  const kpostID = randomKpostId();

  const sent = await post('/v2/common/sendOTP', {
    countryID: Number(process.env.TEST_COUNTRY_ID || 1),
    mobileNumber,
    requestType: 'SIGNUP',
  });
  if (sent.json?.statusCode !== 200) {
    return { error: `sendOTP -> ${sent.status} ${(sent.text || '').slice(0, 90)}` };
  }

  const otp = readLatestOtp(mobileNumber);
  if (!otp) {
    return {
      error:
        'could not read the OTP from the database — check KPOST_DB_* settings, or ask for a ' +
        'fixed test OTP so this script is no longer needed',
    };
  }

  const validated = await post('/v2/common/validateOTP', {
    countryID: Number(process.env.TEST_COUNTRY_ID || 1),
    mobileNumber,
    otp,
    type: 'MOBILE',
  });
  if (validated.json?.statusCode !== 200) {
    return { error: `validateOTP -> ${validated.status} ${(validated.text || '').slice(0, 90)}` };
  }

  const signedUp = await post('/v2/signupLogin/signup', {
    kpostID,
    firstName: 'Qa',
    lastName: 'Disposable',
    mobileNumber,
    createdDate: Date.now(),
    password: PASSWORD,
    gender: 'male',
    dateOfBirth: '1989-07-09',
    countryCode: '91',
    userProfile: { landLineNumber: '044444343784', referalId: '' },
  });
  if (signedUp.json?.statusCode !== 200) {
    return { error: `signup -> ${signedUp.status} ${(signedUp.text || '').slice(0, 110)}` };
  }

  /*
   * Log in once before pooling it. An account that cannot authenticate is worse than no account:
   * the fixture would hand a null token to a destructive test, which then skips anyway — but
   * only after the run has spent the time. Proving it here keeps the pool trustworthy.
   */
  const deviceID = `disposable-${Math.random().toString(36).slice(2, 10)}`;
  const loginTime = Date.now();
  const loggedIn = await post('/v2/signupLogin/userLogin', {
    kpostID,
    deviceType: 'Web',
    deviceIdentity_primary: deviceID,
    deviceIdentity_secondary: 'Desktop-Chrome-151',
    sessionID: `${deviceID}${loginTime}`,
    logintime: loginTime,
    login_lattitude: null,
    login_longitude: null,
    oneSignal_Key: '',
    loginRO: {
      countryID: Number(process.env.QA_COUNTRY_ID || 1),
      password: PASSWORD,
      userType: 'PERSONAL',
    },
  });
  if (!loggedIn.json?.accessToken) {
    return { error: `created but cannot log in -> ${(loggedIn.text || '').slice(0, 90)}` };
  }

  return { account: { kpostID, password: PASSWORD, mobileNumber, createdAt: new Date().toISOString() } };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const pool = readPool();
  const unused = pool.accounts.filter((a) => !a.consumedAt);

  console.log('');
  console.log(`${LOG} target ${BASE_URL}`);
  console.log(`${LOG} pool file ${path.relative(ROOT, POOL_FILE)}`);
  console.log(`${LOG} accounts: ${unused.length} unused of ${pool.accounts.length} total`);

  if (STATUS_ONLY) {
    console.log(`${LOG} --status: nothing created.`);
    return;
  }

  const needed = EXPLICIT_COUNT ?? Math.max(0, POOL_TARGET - unused.length);
  if (needed === 0) {
    console.log(`${LOG} pool is already at or above the target of ${POOL_TARGET}. Nothing to do.`);
    return;
  }

  console.log(`${LOG} creating ${needed} account(s)…`);
  console.log('');

  let created = 0;
  let failed = 0;
  for (let i = 0; i < needed; i += 1) {
    const result = await createAccount();
    if (result.account) {
      pool.accounts.push(result.account);
      created += 1;
      console.log(`${LOG}   ✓ ${result.account.kpostID}`);
      // Written after each success: a rate-limit or an interrupted run then keeps everything
      // created so far instead of discarding the lot.
      writePool(pool);
    } else {
      failed += 1;
      console.error(`${LOG}   ! ${result.error}`);
    }
    // The registration routes rate-limit; pacing keeps a top-up from tripping it.
    if (i < needed - 1) await wait(2500);
  }

  console.log('');
  console.log(`${LOG} done — ${created} created, ${failed} failed.`);
  console.log(`${LOG} pool now holds ${pool.accounts.filter((a) => !a.consumedAt).length} unused account(s).`);
}

main().catch((error) => {
  console.error(`${LOG} fatal:`, error);
  process.exit(1);
});
