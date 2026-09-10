/**
 * Preflight for the login form.
 *
 * KPost's login screen gained a **Country** step: `/login` renders a country
 * combobox above the KPOST ID field, and the ID input is `disabled={!country}`
 * (Login.js). The app is meant to fill that combobox itself — it fetches
 * `/v2/common/countries` on mount and defaults to India — so a healthy app
 * needs no interaction there and the flow stays ID → password.
 *
 * When that fetch does not produce a country the ID field simply stays disabled
 * forever. Playwright's own error for that is `element is not enabled`,
 * repeated for 30 seconds, several layers from the cause — and because global
 * setup signs in before anything else, it takes the entire run down with it.
 *
 * Both login paths (`LoginPage` for specs, `seedViaUi` for global setup) funnel
 * through `waitForLoginFormReady()`, which turns that timeout into a diagnosis.
 *
 * The diagnosis is EVIDENCE-BASED, and that distinction matters: an empty
 * country list has two very different causes, and blaming the wrong one files a
 * false bug.
 *
 *  - The request came back and the app still has no country → the app mishandled
 *    a good response. A real product defect.
 *  - The request never came back at all → the environment, the harness, or the
 *    network is at fault: a rejected CORS preflight (often caused by a custom
 *    request header THIS SUITE added), a mixed-content block, or an unreachable
 *    host. Not a product defect. Each is distinguished from EVIDENCE below —
 *    never inferred from the URL scheme, which produced a confident wrong
 *    answer once already and cost real debugging time.
 *
 * Telling them apart needs the network traffic, which is why `watchCountryList()`
 * is armed BEFORE navigating rather than inspected afterwards — a request the
 * browser blocks outright leaves nothing behind to find later.
 */
import { type Locator, type Page } from '@playwright/test';
const COUNTRIES_ENDPOINT = /common\/countries/i;

interface CountryListTraffic {
  /** Every countries request the page started, whether or not it completed. */
  readonly attempted: string[];
  /** `<status> <url>` for each one that actually came back. */
  readonly answered: string[];
  /**
   * `<errorText> <url>` for each one the browser aborted.
   *
   * This is what separates the causes. A request that never returns looks identical from the
   * outside whether it was blocked as mixed content, refused by a CORS preflight, or sent to a
   * dead host — but `request.failure().errorText` names which, and guessing from the URL scheme
   * alone produces a confident wrong answer.
   */
  readonly failed: string[];
  /** `<status> <url>` for each CORS preflight (OPTIONS) the browser sent. */
  readonly preflight: string[];
}

/**
 * Per-page traffic, keyed weakly so a closed page is collectable and two
 * contexts in the same worker never read each other's evidence.
 */
const TRAFFIC = new WeakMap<Page, CountryListTraffic>();

/**
 * Start recording the country-list traffic. Safe to call more than once per
 * page; only the first call attaches listeners.
 *
 * Call this BEFORE navigating to /login.
 */
export function watchCountryList(page: Page): void {
  if (TRAFFIC.has(page)) return;

  const traffic: CountryListTraffic = { attempted: [], answered: [], failed: [], preflight: [] };
  TRAFFIC.set(page, traffic);

  page.on('request', (request) => {
    if (!COUNTRIES_ENDPOINT.test(request.url())) return;
    // An OPTIONS to this URL is the CORS preflight, not the read itself — recorded separately so
    // a rejected preflight is not miscounted as "the app never asked".
    if (request.method() === 'OPTIONS') return;
    traffic.attempted.push(request.url());
  });
  page.on('response', (response) => {
    if (!COUNTRIES_ENDPOINT.test(response.url())) return;
    if (response.request().method() === 'OPTIONS') {
      traffic.preflight.push(`${response.status()} ${response.url()}`);
      return;
    }
    traffic.answered.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    if (!COUNTRIES_ENDPOINT.test(request.url())) return;
    const reason = request.failure()?.errorText ?? 'unknown';
    traffic.failed.push(`${reason} (${request.method()}) ${request.url()}`);
  });
}

/**
 * The country combobox. `react-select` gives it `role="combobox"`, but the
 * page's language picker is a native `<select>` — also a combobox — and renders
 * first, hence `.last()` rather than a positional guess.
 */
export function countryCombobox(page: Page): Locator {
  return page.getByRole('combobox').last();
}

/** Whatever the country control is showing right now — a value, or its empty state. */
export async function countryStatusText(page: Page): Promise<string> {
  const field = page.locator('.login__field').filter({ hasText: /country/i }).first();
  const text = await field.innerText().catch(() => '');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Wait until the login form can actually be used, i.e. the KPOST ID field is
 * enabled. Throws a diagnosis when it never is.
 *
 * Deliberately free of `test.step()` so global setup can call it too — steps
 * are only legal inside a running test.
 */
export async function waitForLoginFormReady(
  page: Page,
  idInput: Locator,
  timeout: number,
): Promise<void> {
  const enabledIdInput = idInput.and(page.locator('input:enabled'));

  try {
    await enabledIdInput.waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(await describeBlockedLogin(page));
  }
}

/** The failure message: what was observed, what it means, and who fixes it. */
export async function describeBlockedLogin(page: Page): Promise<string> {
  const country = await countryStatusText(page);
  const traffic = TRAFFIC.get(page);
  const shown = country ? `"${country}"` : '(not rendered)';

  const preamble =
    'The KPOST ID field never became enabled, so the login flow could not be started. ' +
    `The country control reads: ${shown}.`;

  // No recording — the caller navigated without arming the watch. Say so rather
  // than guessing a cause from an empty record.
  if (!traffic) {
    return [
      preamble,
      'The country list is what enables that field. Its network traffic was not recorded on ' +
        'this page, so the cause cannot be attributed automatically — call watchCountryList(page) ' +
        'before navigating to /login.',
    ].join('\n');
  }

  const unanswered = traffic.attempted.length - traffic.answered.length;

  // Started and never came back: blocked or unreachable. An environment fault,
  // NOT a product defect — do not attribute it to one.
  if (traffic.attempted.length === 0 || unanswered > 0) {
    const attempted = traffic.attempted.length
      ? traffic.attempted.map((url) => `  - ${url}`).join('\n')
      : '  (the page never even requested it)';

    /*
     * Attribute the cause from EVIDENCE, in order of specificity. An earlier version declared
     * "MIXED CONTENT" whenever the page was https and the API http — which is a guess, and it
     * was wrong: the real cause was a CORS preflight rejected because this suite added an
     * `x-automated-test` request header the API does not allow. That message cost real
     * debugging time, so each branch below now requires proof before it will claim a cause.
     */
    const rejectedPreflight = traffic.preflight.filter((entry) => !/^2\d\d /.test(entry));
    const failures = traffic.failed;
    // Chromium's wording for a mixed-content block; matched explicitly rather than inferred.
    const mixedBlocked = failures.filter((f) =>
      /ERR_BLOCKED_BY_(CLIENT|RESPONSE)|mixed|insecure/i.test(f)
    );

    let cause: string;
    if (rejectedPreflight.length > 0) {
      cause =
        '\nCORS PREFLIGHT REJECTED: the browser sent an OPTIONS preflight for the country list ' +
        `and the API refused it (${rejectedPreflight.join(', ')}). The real GET is then never ` +
        'sent, so the list can never arrive.\n' +
        'A preflight only happens when the request is not "simple" — most often because a CUSTOM ' +
        'REQUEST HEADER was added. Check `extraHTTPHeaders` in playwright.config.ts and any ' +
        '`setExtraHTTPHeaders` call before blaming the environment: this suite caused exactly ' +
        'this once, with an `x-automated-test` tag the API does not list in ' +
        'Access-Control-Allow-Headers.';
    } else if (mixedBlocked.length > 0) {
      cause =
        '\nMIXED CONTENT: the browser blocked the request outright ' +
        `(${mixedBlocked.join(', ')}). This page is served over https:// and the country list is ` +
        'requested over plain http://. The app has to call its API over https, or same-origin ' +
        'through the dev-server proxy.';
    } else if (failures.length > 0) {
      cause =
        `\nThe request was aborted by the browser: ${failures.join(', ')}. That is usually an ` +
        'unreachable host, a TLS failure, or a connection reset — check the API host is up and ' +
        'reachable from this machine.';
    } else {
      cause =
        '\nThe request was started and simply never completed, with no failure reported — most ' +
        'often the API host is accepting connections but not answering. Confirm it directly ' +
        '(curl the country-list URL) before treating this as an app defect.';
    }

    return [
      'ENVIRONMENT PROBLEM — not an application defect, and not a bug to file.',
      preamble,
      `The app requested its country list but never received a response (${unanswered} of ` +
        `${traffic.attempted.length} request(s) unanswered):`,
      attempted + cause,
      `Page origin: ${page.url()}`,
      'Fix the environment, then re-run. Nothing in this suite can proceed until a user can sign in.',
    ].join('\n');
  }

  // The request came back and the app still has no country: the app mishandled
  // a good response. That is the registered defect.
  return [
    'APPLICATION DEFECT — the country list arrived and the app did not use it.',
    preamble,
    `The country list request DID succeed (${traffic.answered.join(', ')}) and the app still has ` +
      'no country, so the app mishandled a good response. Compare the envelope it returned with ' +
      'what Login.js expects — a status-value or shape mismatch is the usual cause. That was ' +
      'KPOST-AUTH-004 (fixed 2026-09-10): a case-sensitive check against "SUCCESS" while the ' +
      'backend answered "Success".',
    'Nothing in this suite can proceed until a user can sign in, so this is reported here rather ' +
      'than as 300 identical timeouts.',
  ].join('\n');
}
