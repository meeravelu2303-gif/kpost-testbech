import { request as playwrightRequest } from '@playwright/test';
import { env } from './env.config';

/**
 * Pre-flight check, run once before the suite.
 *
 * It answers one question — **is the thing under test actually reachable, and is it the thing
 * we think it is?** — and prints the answer at the top of the run.
 *
 * That is worth a few seconds because of how this suite is wired. It talks to two hosts, and
 * a failure on either produces the same symptom downstream: hundreds of tests failing with
 * statuses that look like defects. Without this banner, a KMail service that is simply not
 * running reads as "every endpoint returns a connection error", and an auth host pointed at
 * the wrong deployment reads as "every endpoint returns 401" — neither of which is a finding
 * about KMail, and both of which take longer to diagnose from the failures than from one line
 * printed before they start.
 *
 * It never throws. A pre-flight that aborts the run on a slow health check would be a second
 * source of false failures, and `authSession.ts` already fails loudly and specifically when a
 * session cannot be established.
 */
async function globalSetup(): Promise<void> {
  const context = await playwrightRequest.newContext({
    baseURL: env.kmailBaseURL,
    timeout: Math.min(env.apiTimeout, 10_000),
    ignoreHTTPSErrors: true,
  });

  let identity = 'unreachable';
  try {
    // `/v3/api-docs` is the service's own OpenAPI document. Reading its `info.title` proves
    // both that the host answers and that it is a KMail deployment rather than, say, the
    // platform API on a mistyped port — a mistake that otherwise surfaces as 404 on all 82
    // routes.
    const response = await context.get('/v3/api-docs');
    if (response.ok()) {
      const spec = (await response.json()) as { info?: { title?: string; version?: string } };
      identity = spec.info?.title
        ? `${spec.info.title}${spec.info.version ? ` v${spec.info.version}` : ''}`
        : `answered HTTP ${response.status()} but published no API title`;
    } else {
      identity = `answered HTTP ${response.status()} on /v3/api-docs`;
    }
  } catch (error) {
    identity = `unreachable — ${(error as Error).message}`;
  } finally {
    await context.dispose();
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  KMail API automation',
      `    service under test : ${env.kmailBaseURL}  (${identity})`,
      `    token issued by    : ${env.authBaseURL}`,
      `    account            : ${env.qaKpostId || '<unset — authenticated coverage will skip>'}`,
      `    ownership victim   : ${env.qaVictimKpostId || '<unset — cross-tenant assertions will skip>'}`,
      `    bulk send          : ${env.allowBulkSend ? 'ENABLED' : 'disabled (ALLOW_BULK_SEND)'}`,
      '',
    ].join('\n')
  );
}

export default globalSetup;
