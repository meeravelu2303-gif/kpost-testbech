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
 *    a good response. That is KPOST-AUTH-004, a real product defect.
 *  - The request never came back at all → the environment is misconfigured (an
 *    unreachable backend, or an http:// API called from an https:// page, which
 *    the browser blocks as mixed content). That is not a product defect and
 *    must not be filed as one.
 *
 * Telling them apart needs the network traffic, which is why `watchCountryList()`
 * is armed BEFORE navigating rather than inspected afterwards — a request the
 * browser blocks outright leaves nothing behind to find later.
 */
import { type Locator, type Page } from '@playwright/test';
import { KNOWN_APP_DEFECTS } from './known-defects';

const DEFECT = KNOWN_APP_DEFECTS.LOGIN_COUNTRY_LIST_NEVER_POPULATES;
const COUNTRIES_ENDPOINT = /common\/countries/i;

interface CountryListTraffic {
  /** Every countries request the page started, whether or not it completed. */
  readonly attempted: string[];
  /** `<status> <url>` for each one that actually came back. */
  readonly answered: string[];
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

  const traffic: CountryListTraffic = { attempted: [], answered: [] };
  TRAFFIC.set(page, traffic);

  page.on('request', (request) => {
    if (COUNTRIES_ENDPOINT.test(request.url())) traffic.attempted.push(request.url());
  });
  page.on('response', (response) => {
    if (COUNTRIES_ENDPOINT.test(response.url())) {
      traffic.answered.push(`${response.status()} ${response.url()}`);
    }
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
    const insecure = traffic.attempted.filter((url) => url.startsWith('http://'));
    const mixedContent =
      insecure.length > 0 && page.url().startsWith('https://')
        ? '\nMIXED CONTENT: this page is served over https:// but the country list is requested ' +
          `over plain http:// (${insecure[0]}). Browsers block that outright, so the request can ` +
          'never succeed from here. The app has to call its API over https, or same-origin ' +
          'through the dev server proxy.'
        : '';

    return [
      'ENVIRONMENT PROBLEM — not an application defect, and not a bug to file.',
      preamble,
      `The app requested its country list but never received a response (${unanswered} of ` +
        `${traffic.attempted.length} request(s) unanswered):`,
      attempted + mixedContent,
      `Page origin: ${page.url()}`,
      'Fix the environment — reachable API host, https or same-origin — then re-run. Nothing in ' +
        'this suite can proceed until a user can sign in.',
    ].join('\n');
  }

  // The request came back and the app still has no country: the app mishandled
  // a good response. That is the registered defect.
  return [
    `KNOWN APPLICATION DEFECT ${DEFECT.id}: ${DEFECT.summary}`,
    preamble,
    `The country list request DID succeed (${traffic.answered.join(', ')}) and the app still has ` +
      'no country, so this is the app mishandling a good response — Login.js gates the list on a ' +
      'case-sensitive `response.status === "SUCCESS"` while the backend answers "Success".',
    'Nothing in this suite can proceed until a user can sign in, so this is reported here rather ' +
      'than as 300 identical timeouts. See src/utils/known-defects.ts for the full evidence.',
  ].join('\n');
}
