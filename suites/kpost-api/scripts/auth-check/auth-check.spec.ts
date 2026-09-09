import { test, expect, request } from '@playwright/test';
import { establishSession, establishAdminSession } from '../../src/fixtures/authSession';
import { env } from '../../src/config/env.config';

/**
 * Preflight: answers "will the suite authenticate?" in a couple of seconds.
 *
 * Why this exists. The suite degrades gracefully when no session can be established — workers
 * get `token: null` and carry on, because unauthenticated coverage is still worth collecting
 * (see `api.fixture.ts`). That resilience has a cost: a full run completes, publishes a report
 * and files tickets while never having authenticated. One such run produced 387 "defects" of
 * which 296 were assertion failures downstream of the auth outage, and only 22 Critical against
 * a baseline of 130.
 *
 * So the check is worth running *before* committing four minutes and a Bugzilla dispatch to a
 * run whose conclusions cannot be trusted. It exercises the real `establishSession`, so it
 * proves the exact chain the suite will use — not an approximation of it.
 */

/** Reports how much life is left in a JWT, without verifying its signature. */
function describeExpiry(token: string): string {
  const segments = token.split('.');
  if (segments.length < 2) return 'not a JWT — cannot read an expiry';

  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64').toString()) as {
      exp?: number;
      sub?: string;
    };
    if (!claims.exp) return `subject ${claims.sub ?? '(unknown)'}, no exp claim`;

    const remainingMs = claims.exp * 1000 - Date.now();
    const hours = remainingMs / 3_600_000;
    const when = new Date(claims.exp * 1000).toISOString();
    return remainingMs <= 0
      ? `subject ${claims.sub ?? '(unknown)'} — EXPIRED at ${when}`
      : `subject ${claims.sub ?? '(unknown)'} — valid for ${hours.toFixed(1)}h (until ${when})`;
  } catch {
    return 'JWT payload could not be decoded';
  }
}

test('the suite can establish an authenticated session', async () => {
  const context = await request.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:8989',
    ignoreHTTPSErrors: true,
  });

  const session = await establishSession(context);
  await context.dispose();

  console.log('\n──────────────── AUTH PREFLIGHT ────────────────');
  console.log(`target   : ${process.env.BASE_URL ?? 'http://localhost:8989'}`);
  console.log(`strategy : ${session.strategy}`);
  console.log(`kpostID  : ${session.kpostID ?? '(none)'}`);
  console.log(`device   : ${session.deviceID ?? '(none)'}`);
  console.log(`token    : ${session.token ? `${session.token.slice(0, 24)}…` : '(NONE)'}`);
  if (session.token) console.log(`expiry   : ${describeExpiry(session.token)}`);

  console.log('\nattempts:');
  for (const line of session.diagnostics) console.log(`  • ${line}`);
  console.log('────────────────────────────────────────────────\n');

  expect(
    session.token,
    'No authenticated session could be established, so a full run would exercise only the ' +
      'unauthenticated surface while still publishing a report and filing tickets. Fix auth ' +
      'before running the suite — the attempt log above names the call that blocked each route. ' +
      'Preferred fix: set QA_KPOST_ID / QA_PASSWORD for a real account, so a fresh token is ' +
      'minted every run instead of expiring every 24 hours. ' +
      'If the credentials look right and login is still refused, run `npm run auth:diagnose` — ' +
      'KPOST answers "no such account", "wrong password", "account not active" and "wrong ' +
      'environment" with one identical message, and only elimination tells them apart.'
  ).not.toBeNull();
});

test('the admin (business) session can be established', async () => {
  const context = await request.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:8989',
    ignoreHTTPSErrors: true,
  });

  const session = await establishAdminSession(context);
  await context.dispose();

  console.log('\n──────────────── ADMIN PREFLIGHT ───────────────');
  console.log(`account  : ${env.qaAdminKpostId || '(QA_ADMIN_KPOST_ID not set)'}`);
  console.log(`tier     : ${env.qaAdminUserType}`);
  console.log(`strategy : ${session.strategy}`);
  console.log(`token    : ${session.token ? `${session.token.slice(0, 24)}…` : '(NONE)'}`);
  if (session.token) {
    console.log(`expiry   : ${describeExpiry(session.token)}`);
    try {
      const role = JSON.parse(Buffer.from(session.token.split('.')[1], 'base64').toString()).role;
      console.log(`role     : ${role}${role === 'admin' ? ' ✓' : '  ⚠ expected admin'}`);
    } catch {
      /* reported via token line above */
    }
  }
  for (const line of session.diagnostics) console.log(`  • ${line}`);
  console.log('────────────────────────────────────────────────\n');

  /*
   * A missing admin account is a *skip*, not a failure: the bench still runs its full
   * member surface, and the admin suites skip themselves. Only a *configured* admin that
   * cannot authenticate is an error worth failing this preflight for.
   */
  if (!env.qaAdminKpostId) {
    test.skip(true, 'QA_ADMIN_KPOST_ID not set — admin suites will skip; member coverage is unaffected');
    return;
  }
  expect(
    session.token,
    `Admin account "${env.qaAdminKpostId}" is configured but could not authenticate. The admin ` +
      'suites will skip and their surface goes unverified. Check the account exists, is active, ' +
      'and that QA_ADMIN_USER_TYPE matches the tier it was registered under.'
  ).not.toBeNull();
});
