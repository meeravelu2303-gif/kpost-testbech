import { request } from '@playwright/test';
import { resetBugLedger } from '../utils/bugTracker';
import { resetDisposableClaims } from '../fixtures/disposablePool';
import { env } from './env.config';
import { establishSession } from '../fixtures/authSession';
import { describeToken } from '../fixtures/tokenStore';

/**
 * Runs once, before any worker starts.
 *
 * Two jobs, and the second one is new:
 *
 *   1. Reset the defect ledger, as before.
 *
 *   2. **Acquire the run's session, once, and fail the run if it cannot be acquired.**
 *
 *      Previously each worker authenticated for itself, which meant N logins, N login-session
 *      rows and N chances to get a different answer; and if authentication failed, the run
 *      continued regardless. That last part is the expensive one. An unauthenticated run
 *      still executes ~4,500 assertions, still publishes an HTML report, still updates the
 *      trend history and still files Bugzilla tickets — it simply cannot evaluate a single
 *      authorisation, IDOR or cross-tenant assertion. The run of 2026-08-19 did exactly that:
 *      387 "defects", of which 296 were assertion failures downstream of the auth outage, and
 *      22 Critical against a baseline of 130. Every one of those tickets had to be withdrawn.
 *
 *      A test bench that reports confidently on coverage it did not execute is worse than one
 *      that refuses to start, so it now refuses to start. `ALLOW_UNAUTHENTICATED_RUN=1` is
 *      the deliberate opt-out for the case where unauthenticated surface is genuinely what
 *      you want to measure.
 *
 * The session is cached to `.auth/session.json`, scoped to `BASE_URL`; workers reuse it
 * instead of logging in again.
 */
async function globalSetup(): Promise<void> {
  resetBugLedger();

  /*
   * Release last run's disposable-account claims.
   *
   * A claim marks an account as "in use by a worker", and no worker outlives the run that made
   * it. Left in place, the pool would read as exhausted on the next run even though its accounts
   * were never touched, and the destructive-path tests would silently return to skipping.
   */
  resetDisposableClaims();

  const context = await request.newContext({
    baseURL: env.baseURL,
    timeout: env.apiTimeout,
    ignoreHTTPSErrors: true,
  });

  try {
    const session = await establishSession(context);

    const banner = [
      '',
      '─'.repeat(78),
      'KPOST TEST BENCH — session bootstrap',
      '─'.repeat(78),
      `target   : ${env.baseURL}`,
      `strategy : ${session.strategy}`,
      `identity : ${session.kpostID ?? '(none)'}`,
      `device   : ${session.deviceID ?? '(none)'}`,
      `token    : ${session.token ? describeToken(session.token) : '(NONE)'}`,
    ];
    for (const line of session.diagnostics) banner.push(`  · ${line}`);
    banner.push('─'.repeat(78), '');
    console.log(banner.join('\n'));

    if (!session.token && !env.allowUnauthenticatedRun) {
      throw new Error(
        [
          '',
          '='.repeat(78),
          'RUN ABORTED — no authenticated session.',
          '='.repeat(78),
          '',
          `Target: ${env.baseURL}`,
          `Account: ${env.qaKpostId || '(QA_KPOST_ID not set)'}`,
          '',
          'Continuing would produce a report and a batch of Bugzilla tickets from a run that',
          'never exercised a single authorisation, IDOR or cross-tenant assertion. That has',
          'happened before and every ticket from it had to be withdrawn.',
          '',
          'Attempts:',
          ...session.diagnostics.map((line) => `  - ${line}`),
          '',
          'Next step:  npm run auth:diagnose',
          '            (probes each cause in turn and names the one that fits)',
          '',
          'To measure the unauthenticated surface deliberately:  ALLOW_UNAUTHENTICATED_RUN=1',
          '='.repeat(78),
          '',
        ].join('\n')
      );
    }
  } finally {
    await context.dispose();
  }
}

export default globalSetup;
