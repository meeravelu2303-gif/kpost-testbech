/**
 * Registry of known **application** defects that currently fail tests.
 *
 * Why this exists: a red test is only useful if the reader can tell, in one
 * glance, whether the *suite* is broken or the *app* is. Each entry below is a
 * defect confirmed by direct observation against the live app, together with
 * the evidence. `noteKnownDefect()` attaches it to the test so it shows up in
 * the HTML report and in the failure message.
 *
 * Rules of engagement:
 *  - Never weaken an assertion to make one of these go green. The assertion
 *    describes correct behaviour; the app does not meet it yet.
 *  - When a defect is fixed, delete its entry and the `noteKnownDefect()` call.
 *    A stale entry is worse than none — it excuses a real regression.
 *  - This is documentation, not suppression: annotated tests still fail.
 */
import { test } from '@playwright/test';

export interface KnownDefect {
  /** Short stable handle, quotable in a bug tracker. */
  readonly id: string;
  /** One-line statement of what the app does wrong. */
  readonly summary: string;
  /** The observed evidence — errors, endpoints, reproduction. */
  readonly evidence: string;
  /** What the test asserts, i.e. the behaviour we expect once fixed. */
  readonly expected: string;
  /** Severity as reported to the QA dashboard. */
  readonly severity: 'High' | 'Medium' | 'Low';
  /** The KPost module the defect lives in, as shown on the QA dashboard. */
  readonly module: string;
  /**
   * OPTIONAL assignee override. Omit and the defect goes to `env.defectOwner`
   * (the UI team lead) — correct for almost everything this bench finds, since
   * it only tests the UI. Set it when a defect genuinely belongs to another
   * team, so the dashboard routes it to someone who can actually fix it.
   */
  readonly owner?: string;
}

export const KNOWN_APP_DEFECTS = {
  /** KMail's unopened-mail thunk throws an uncaught error on load. */
  KMAIL_UNOPENED_MAIL_TYPE_ERROR: {
    id: 'KPOST-KMAIL-001',
    severity: 'Medium',
    module: 'KMail',
    summary: 'KMail raises an uncaught TypeError on load (UnopenedMailAsync).',
    evidence:
      "Uncaught \"TypeError: Cannot read properties of undefined (reading 'status')\" at " +
      'UnopenedMailAsync, thrown as soon as /kmail loads. Verified 2026-08-12: the module ' +
      'underneath still functions — all three tabs work once the dev-only overlay is ' +
      'dismissed — so the suite dismisses the overlay (recording it as a ' +
      '"dismissed-app-error" annotation) and verifies the real behaviour. The error ' +
      'itself remains unfixed: in a production build it would surface as the ' +
      'unopened-mail feature failing silently.',
    expected: 'KMail loads without raising any uncaught error.',
  },

  /** Opening KMail signs the user out. */
  KMAIL_OPENING_SIGNS_USER_OUT: {
    id: 'KPOST-KMAIL-003',
    severity: 'High',
    module: 'KMail',
    summary: 'Opening KMail silently signs the user out and dumps them on /login.',
    evidence:
      'Verified 2026-08-28 (chromium, http://localhost:3000). Reproduced three ways, all identical: ' +
      'launching KMail from the Quick Access launcher, clicking its icon-rail entry, and navigating ' +
      'straight to /kmail. In every case the app lands on /login within seconds. It is NOT a stale ' +
      'stored session — the same thing happens from a completely fresh, human-style login in a clean ' +
      'browser context: sign in, reach /home, open Quick Access, click KMail, and the next thing on ' +
      'screen is the login form.\n' +
      'No 401 is involved: the only failing app requests during the bounce are HTTP 400 ' +
      '"Request validation failed" from POST /v2/contacts/myContacts/, /myUnknownGroups/, ' +
      '/myGroups/, /myUnknownKatchupContacts/ and POST /v2/dashboard/homeDashboardMsgs/, so the ' +
      'sign-out is decided client-side rather than by the server rejecting the token. Nothing is ' +
      'shown to the user — no alert, no "session expired" notice — so from their chair the mail ' +
      'module simply throws them out of the product.',
    expected:
      'Opening KMail loads the mailbox and leaves the session intact; a genuine auth failure says so ' +
      'instead of silently returning to the login screen.',
  },

  /** MicInput throws an unhandled fetch error on Firefox and takes the page with it. */
  MIC_INPUT_UNHANDLED_NETWORK_ERROR: {
    id: 'KPOST-GENERAL-002',
    severity: 'High',
    module: 'General',
    summary:
      'The voice-command MicInput component raises an unhandled NetworkError on Firefox, breaking ' +
      'every page it mounts on.',
    evidence:
      'Verified 2026-08-28 (firefox, full @smoke run, http://localhost:3000): the app raises an ' +
      'uncaught "NetworkError when attempting to fetch resource" from ' +
      './src/components/common/MicInput/MicInput.js inside a mount effect ' +
      '(commitHookEffectListMount → commitPassiveMountOnFiber). It fires on the authenticated shell, ' +
      'which every screen renders, so it is not confined to one module — 24 of firefox\'s 28 smoke ' +
      'tests failed on it, and the same run on chromium saw it zero times. In dev the error puts the ' +
      'dev-server overlay over the page and blocks every click; in a production build there is no ' +
      'overlay, so the same fault would instead be a voice-command button that silently does nothing ' +
      'on Firefox, plus an unhandled rejection on every page load.',
    expected:
      'MicInput handles a failed fetch — the feature degrades or hides itself — instead of throwing ' +
      'an unhandled error out of a mount effect.',
  },

  /** The mobile layout renders no navigation whatsoever. */
  MOBILE_SHELL_HAS_NO_NAVIGATION: {
    id: 'KPOST-HOME-001',
    severity: 'High',
    module: 'Home',
    summary:
      'On a mobile viewport the authenticated shell renders no navigation at all — no Quick Access, ' +
      'and the icon rail is absent.',
    evidence:
      'Verified 2026-08-28 (mobile-chrome / Pixel 7, 412px, http://localhost:3000): a signed-in ' +
      '/home renders exactly TWO buttons in the entire page — "Global Search (Disabled)" and "Start ' +
      'voice command". There is no "Quick Access" button, no icon rail, and no links, so there is no ' +
      'way to reach KMail, Katchup, KDirectory, KEcommerce, KNews or Settings at all. The Recents / ' +
      'Contacts tabs and the search boxes render normally, so this is the navigation specifically, ' +
      'not a failed page load. 26 of mobile-chrome\'s 28 smoke tests failed on it, every one waiting ' +
      'for the Quick Access button that the desktop layout provides.\n' +
      'Quick Access is also the only accessible navigation path KPost has (the rail exposes no ' +
      'accessible names — KPOST-A11Y-006), so on mobile the product has no navigation for anyone, ' +
      'assistive technology or not.',
    expected:
      'The mobile layout offers a way to reach every module — the Quick Access launcher, or an ' +
      'equivalent control with a real accessible name.',
  },

  /** Katchup's contacts backend 500s and the app does not handle it. */
  KATCHUP_CONTACTS_500_UNHANDLED: {
    id: 'KPOST-KATCHUP-001',
    severity: 'Medium',
    module: 'Katchup',
    summary: 'Katchup does not handle a failing contacts backend; it raises instead of degrading.',
    evidence:
      'GET localhost:8989/v2/contacts/getImportedPhoneContacts/ and POST ' +
      'localhost:8989/v2/contacts/myUnknownKatchupContacts/ intermittently return 500. ' +
      'The app then raises an unhandled "[object Object]" at handleError rather than ' +
      'degrading, and the conversation/search surface never renders. This is why these ' +
      'tests pass in isolation but fail when the backend happens to error.',
    expected:
      'A failing contacts call degrades gracefully — the pane still renders and search ' +
      'still reports its result state.',
  },

  /** The mail backend intermittently 401s requests from a valid session. */
  KMAIL_POSTMAIL_INTERMITTENT_401: {
    id: 'KPOST-KMAIL-002',
    severity: 'High',
    module: 'KMail',
    summary: 'POST /v2/sentMail/postMail/ intermittently returns 401 for a valid session.',
    evidence:
      'The same self-send, from a freshly logged-in session with an unexpired token ' +
      '(24h JWT lifetime), is sometimes answered 400 "Duplicate IDs are present in ' +
      'ToAddress, CopyList, or ConfidentialCopyList" (the expected validation) and ' +
      'sometimes 401 — observed switching between the two across consecutive runs on ' +
      '2026-08-12. A backend that authenticates a session for one request and rejects ' +
      'it for the next is failing auth intermittently; the historical KMail 401 ' +
      'force-logout (now fixed) was the same category of fault.',
    expected: 'A valid session is authenticated consistently; postMail never 401s it.',
  },

  /** The KEcommerce merchant catalog intermittently renders empty. */
  KECOMMERCE_CATALOG_INTERMITTENTLY_EMPTY: {
    id: 'KPOST-KECOM-001',
    severity: 'Medium',
    module: 'KEcommerce',
    summary: 'The KEcommerce catalog intermittently renders as an empty pane.',
    evidence:
      'During a full serial suite run on 2026-08-12, /e-commerce rendered only the ' +
      'app-shell header with zero merchant tiles (the page snapshot shows an empty ' +
      'content area), failing both catalog tests; the same tests pass 5/5 when the ' +
      'spec runs in isolation, before and after. The module shows no error state ' +
      'when this happens — the catalog is simply missing. Root cause not yet ' +
      'captured (no failed catalog request has been observed; the tile source may ' +
      'be a data call that fails silently or an app-side race under longer sessions).',
    expected: 'The catalog renders its merchant tiles on every load, or shows an error state.',
  },

  /** KNews renders an empty feed with no error state when its sources fail. */
  KNEWS_EMPTY_FEED_ON_SOURCE_FAILURE: {
    id: 'KPOST-KNEWS-001',
    severity: 'Medium',
    module: 'KNews',
    summary: 'KNews renders an empty feed with no error state when its news bridges fail.',
    evidence:
      'KNews fetches content through public RSS bridges (corsproxy.io, rss2json.com) ' +
      'that intermittently answer 503/422/429 — rss2json rate-limiting (429) was ' +
      'captured directly. When that happens the main feed renders zero cards and no ' +
      'error or empty-state message (page snapshot: a main landmark with no links), ' +
      'minutes after the same feed rendered normally. A news feed with nothing in it ' +
      'and no explanation is indistinguishable from a broken app to the user.',
    expected:
      'When the news sources fail, the feed shows an error/retry state instead of ' +
      'silently rendering nothing.',
  },

  /** The rail advertises a KPay module that does not exist. */
  KPAY_DEAD_NAV_ENTRY: {
    id: 'KPOST-KPAY-001',
    severity: 'Low',
    module: 'KPay',
    summary: 'The icon rail shows a KPay entry that silently does nothing.',
    evidence:
      'The rail renders div.icon-KP_12-KWallet and its expanded labels include ' +
      '"KPay", but clicking either leaves the URL unchanged, Quick Access does not ' +
      'offer the module, and /kpay, /kwallet, and /pay all render the 404 page ' +
      '(verified 2026-08-13). A visible nav entry that silently does nothing is ' +
      'broken UX from the user’s side, whatever the roadmap says — it should be ' +
      'hidden, disabled with an affordance, or wired up.',
    expected: 'Rail entries either navigate somewhere or are visibly disabled/absent.',
  },

  /** Firebase Cloud Messaging crashes the whole app on browsers it doesn't support. */
  FIREBASE_MESSAGING_UNSUPPORTED_BROWSER_CRASH: {
    id: 'KPOST-GENERAL-001',
    severity: 'High',
    module: 'General',
    summary:
      'Firebase Cloud Messaging throws an uncaught error on browsers it does not fully support, ' +
      'crashing the whole app.',
    evidence:
      'On every page load — including the signed-out /login screen, before any auth — the app raises ' +
      'an uncaught "Messaging: This browser doesn\'t support the API\'s required to use the Firebase ' +
      'SDK. (messaging/unsupported-browser)" from its Firebase Cloud Messaging initialisation. The ' +
      'dev-server error overlay then covers the page and blocks every subsequent click.\n' +
      'Re-verified 2026-08-28 on a clean full @smoke run against http://localhost:3000 (a secure ' +
      'origin, so this is not the insecure-context variant): **28 of 28 WebKit tests failed on it — ' +
      'the entire project, no exceptions.** Chromium was unaffected in the same run. Firefox now ' +
      'fails on a different unhandled error instead (KPOST-GENERAL-002, MicInput), and ' +
      'mobile-chrome on missing navigation (KPOST-HOME-001), so this entry is now specifically the ' +
      'WebKit/Safari crash.\n' +
      'The error is uncaught rather than guarded, so a production build would leave Safari users ' +
      'with a fully broken app rather than a messaging feature that degrades gracefully. The same ' +
      'unguarded assumption is what makes the app render a blank page on any non-secure origin.',
    expected:
      'Firebase Messaging initialisation checks browser support before calling into the SDK, and ' +
      'disables push notifications instead of throwing when a browser (Safari/WebKit, Firefox) does ' +
      'not support the required APIs.',
  },

  /** The app force-logs-out an authenticated session under sustained use. */
  SESSION_FORCED_LOGOUT_UNDER_SUSTAINED_USE: {
    id: 'KPOST-AUTH-002',
    severity: 'High',
    module: 'Auth',
    summary:
      'The app intermittently force-logs-out an authenticated session during sustained use, even ' +
      'with no other device or browser actually signed in.',
    evidence:
      'Observed 2026-08-25: isolated runs of the same tests (1 test, then 6 tests — single ' +
      'browser, single worker) complete cleanly every time, while a full serial run of the whole ' +
      'suite repeatedly bounced the session back to /login mid-test, showing the alert "You are ' +
      'logged out on this device as you logged on another 3rd party device" at a rate of roughly ' +
      '55 of ~64 tests per project.\n' +
      '✅ DID NOT REPRODUCE on 2026-08-28. A complete serial run of the whole suite — 260 tests, ' +
      'all four browser projects, 1.2 hours, every test accounted for — raised this alert ZERO ' +
      'times, and no bug was filed for it. Every one of that run\'s 191 failures is attributable ' +
      'to another, named defect. The entry is kept, unfired, so that the detection in ' +
      '`waitForAppReady` still names it correctly if the app ever does drop a session again; delete ' +
      'it if a few more full runs stay clean.\n' +
      '⚠ WHY THE ORIGINAL DIAGNOSIS WAS WRONG. On 2026-08-27 the cause was traced to THIS SUITE, ' +
      'not the app: tests/auth/ signed in and logged out as the same standard user whose shared ' +
      'storageState every other spec depends on, and KPost allows one active session per account ' +
      '— so the auth specs took the session and everything after them ran logged out. Measured ' +
      'directly: global setup verified the stored session, the auth specs ran, and loading /home ' +
      'with that same stored state then redirected to /login. The suite now signs the auth ' +
      'journeys in as a separate account (env.users.auth), which removes that cause entirely.\n' +
      'Do not quote the old "no other device was signed in" claim: another sign-in was happening, ' +
      'and it was ours.',
    expected:
      'An authenticated session is not force-logged-out while it remains the only device actually ' +
      'signed in, regardless of how long or how many page loads the session has been active for.',
  },

  /** The login form's country list never populates, so login is impossible. */
  LOGIN_COUNTRY_LIST_NEVER_POPULATES: {
    id: 'KPOST-AUTH-004',
    severity: 'High',
    module: 'Auth',
    summary:
      'The login screen renders a Country list showing "No options", leaving the KPOST ID field ' +
      'permanently disabled — nobody can sign in at all.',
    evidence:
      'Verified 2026-08-28 (chromium, http://localhost:3000). /login renders a Country combobox ' +
      'above the KPOST ID field, and the ID input is `disabled={!country}`. The combobox shows ' +
      '"No options" forever, so the ID field never enables and the login flow cannot start.\n' +
      'The data is NOT missing: GET /v2/common/countries answers HTTP 200 with 26,702 bytes ' +
      'listing 200+ countries, India first. This is a response-contract mismatch. Login.js:970 ' +
      'gates the whole list on a case-sensitive `response.status === "SUCCESS"` while that ' +
      'endpoint answers `"status":"Success"`, so the branch that calls setcountryAll() and ' +
      'setCountry() never runs.\n' +
      'Both sides drifted, and both are provable. The shared dev backend ' +
      '(devapi2.kpostindia.com) still returns "SUCCESS", which is why the same build signs in ' +
      'there; the local backend (192.168.1.176:8989) returns "Success" — but only from its ' +
      'common/* controller. Its own signupLogin/fetchUserDetails still returns "SUCCESS", and ' +
      'its failures still return "FAILURE", so one controller deviates from the platform ' +
      'convention rather than the convention having changed. Login.js is inconsistent too: its ' +
      'other three status checks (lines 292, 329, 355) all use `.toLowerCase() === "success"`; ' +
      'CountryGetAll alone compares strictly.\n' +
      'Proved by isolation: intercepting the response and rewriting ONLY "Success" to "SUCCESS" ' +
      '— no other change — makes the country default to "+91 India", enables the KPOST ID field, ' +
      'and a full sign-in completes to /home.',
    expected:
      'The login screen loads its country list and enables the KPOST ID field, so a user can ' +
      'sign in.',
  },

  /** Logging out does not guard protected routes. */
  LOGOUT_NO_ROUTE_GUARD: {
    id: 'KPOST-AUTH-001',
    severity: 'High',
    module: 'Auth',
    summary: 'After logout, protected routes are not redirected back to /login.',
    evidence:
      'Logout correctly clears accessToken, refreshToken, Authuser and ' +
      'deviceIdentity_primary and lands on /login. But navigating back to /home ' +
      'afterwards stays on /home and renders a dead, shell-less page (the Quick Access ' +
      'button never appears) instead of redirecting to the login screen.',
    expected: 'Visiting a protected route while signed out redirects to /login.',
  },

  /*
   * Accessibility defects, all observed by the axe-core scans in `tests/a11y/`
   * on 2026-08-16 (chromium, WCAG 2.1 A/AA). These are not style opinions:
   * `best-practice` rules are excluded from the scan, so every entry here is a
   * conformance failure. Several are also the direct cause of this bench's
   * ugliest workarounds — see KPOST-A11Y-001.
   */

  /** Form controls render with no accessible name. */
  A11Y_UNLABELLED_FORM_CONTROLS: {
    id: 'KPOST-A11Y-001',
    severity: 'High',
    module: 'Accessibility',
    summary: 'Form controls render with no accessible name (label, select-name).',
    evidence:
      'axe-core, 2026-08-16: two CRITICAL violations. On /login the combobox input ' +
      '#react-select-2-input trips "label — Form elements must have labels"; the ' +
      'language <select> trips "select-name — Select element must have an accessible ' +
      'name" on both /login and /home. A screen-reader user cannot tell what either ' +
      'control is for. This is the same root cause that forces the suite to reach for ' +
      'CSS selectors in WriteMailPage and AppShellPage, so fixing it removes real ' +
      'brittleness from the tests as well as unblocking assistive tech.',
    expected:
      'Every form control exposes an accessible name via <label>, aria-label or ' +
      'aria-labelledby.',
  },

  /** Pinch-zoom is disabled for everyone. */
  A11Y_ZOOM_DISABLED: {
    id: 'KPOST-A11Y-002',
    severity: 'Medium',
    module: 'Accessibility',
    summary: 'Zooming and scaling are disabled via the viewport meta tag.',
    evidence:
      'axe-core, 2026-08-16: "meta-viewport — Zooming and scaling must not be ' +
      'disabled" on meta[name="viewport"], present on /login and /home and therefore ' +
      'on every page of the SPA. Users who need to magnify text cannot, which is a ' +
      'WCAG 1.4.4 failure and affects far more people than it appears to — it is a ' +
      'one-line fix in index.html.',
    expected: 'The viewport meta tag permits user scaling (no user-scalable=no, no maximum-scale=1).',
  },

  /** Text fails minimum contrast in several places. */
  A11Y_INSUFFICIENT_CONTRAST: {
    id: 'KPOST-A11Y-003',
    severity: 'Medium',
    module: 'Accessibility',
    summary: 'Several UI elements fall below the minimum colour-contrast ratio.',
    evidence:
      'axe-core, 2026-08-16: "color-contrast — Elements must meet minimum color ' +
      'contrast ratio thresholds" (SERIOUS). Four elements on /home — .Katchup_Name, ' +
      '#slider-tab-example-tab-Recent, .Calender_icon and .ecomm_font — plus the ' +
      'secondary text inside the Quick Access launcher. Low-contrast text is unreadable ' +
      'in bright light and for low-vision users.',
    expected: 'Text meets the WCAG AA contrast ratio (4.5:1 normal, 3:1 large).',
  },

  /** A scrollable pane cannot be reached from the keyboard. */
  A11Y_SCROLL_REGION_NOT_FOCUSABLE: {
    id: 'KPOST-A11Y-004',
    severity: 'Medium',
    module: 'Accessibility',
    summary: 'The KEcommerce scroll area is unreachable by keyboard.',
    evidence:
      'axe-core, 2026-08-16: "scrollable-region-focusable — Scrollable region must ' +
      'have keyboard access" (SERIOUS) on .ecommerce-scroll-area on /home. The pane ' +
      'scrolls with a mouse or trackpad but has no tabindex, so a keyboard-only user ' +
      'cannot scroll it and simply cannot see the content past the fold.',
    expected: 'Scrollable regions are focusable (tabindex="0") or expose a keyboard-operable alternative.',
  },

  /** KPost renders no navigation landmark at all. */
  A11Y_NO_NAVIGATION_LANDMARK: {
    id: 'KPOST-A11Y-006',
    severity: 'High',
    module: 'Accessibility',
    summary: 'KPost renders no <nav> element and no [role="navigation"] landmark anywhere in the app.',
    evidence:
      'Verified 2026-08-25: page.locator(\'nav, [role="navigation"]\').count() is 0 on /home. An ' +
      'earlier attempt to axe-scan a navigation landmark directly failed with "No elements found for ' +
      'include in page Context" — axe cannot scope a scan to something that does not exist, which was ' +
      'itself the finding. The icon rail (div.icon-KP_03-KMail, ...) is the only in-app navigation and ' +
      'carries no landmark role, no accessible name and no text — a screen-reader user has no way to ' +
      'jump to navigation at all, and the one accessible path (Quick Access) is a dialog, not a ' +
      'persistent nav landmark.',
    expected:
      'The app exposes a <nav> element or a [role="navigation"] landmark so assistive technology can ' +
      'locate and jump to navigation.',
  },

  /** Quick Access nests interactive controls inside one another. */
  A11Y_NESTED_INTERACTIVE_CONTROLS: {
    id: 'KPOST-A11Y-005',
    severity: 'Medium',
    module: 'Accessibility',
    summary: 'Quick Access nests interactive controls inside its result buttons.',
    evidence:
      'axe-core, 2026-08-16: "nested-interactive — Interactive controls must not be ' +
      'nested" (SERIOUS) across 13 elements, every ' +
      'button[data-quick-search-item-index="n"] in the launcher. Nesting a focusable ' +
      'control inside another makes the inner one unreachable for screen readers and ' +
      'produces an unpredictable tab order. Quick Access is the ONLY accessible ' +
      'navigation path in KPost (the icon rail exposes no names at all), so a defect ' +
      'here has no fallback.',
    expected: 'Interactive controls are siblings, never nested inside one another.',
  },
} as const satisfies Record<string, KnownDefect>;

/**
 * Attach a known defect to the running test.
 *
 * Adds a report annotation (visible in the HTML report next to the test) and
 * returns a formatted description suitable for use as an `expect()` message, so
 * the failure output explains itself without anyone opening this file.
 */
export function noteKnownDefect(defect: KnownDefect): string {
  const description = `${defect.id} — ${defect.summary}\nEvidence: ${defect.evidence}\nExpected: ${defect.expected}`;

  test.info().annotations.push({
    type: 'known-app-defect',
    description,
  });

  return (
    `KNOWN APPLICATION DEFECT ${defect.id}: ${defect.summary}\n` +
    `This is an app-side bug, not a broken test — the assertion below describes the ` +
    `behaviour the app should have.\n${defect.evidence}`
  );
}
