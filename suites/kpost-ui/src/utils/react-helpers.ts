/**
 * React-specific interaction helpers.
 *
 * React apps present unique timing challenges that generic Playwright
 * auto-waiting does not fully cover:
 *   - Re-renders after async state updates (the DOM node may be replaced).
 *   - Virtualized / windowed lists (react-window, react-virtualized) where
 *     only visible rows exist in the DOM.
 *   - Controlled inputs whose value is driven by state — a native fill can
 *     race the onChange handler and get "reverted".
 *
 * These helpers are intentionally framework-aware but locator-agnostic: they
 * take Playwright Locators/Pages so any page object can reuse them.
 */
import { type Locator, type Page, expect } from '@playwright/test';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from './known-defects';

/**
 * Wait for the app to be render-ready after a navigation.
 *
 * Deliberately does NOT wait for `networkidle`. KPost never reaches it: the
 * shell continuously polls news feeds, Firebase, and websocket endpoints, so a
 * `networkidle` gate simply burns the navigation timeout and fails every test
 * that navigates (this was measured against the live app, not assumed).
 *
 * What remains is cheap and correct: the document is parsed, and two rAF ticks
 * give React a commit cycle to flush pending state into the DOM. Everything
 * beyond that is the job of the web-first assertions in `expectLoaded()`, which
 * auto-retry against the element the test actually cares about.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await assertNoAppErrorOverlay(page);
  try {
    // Flush one React commit cycle.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
  } catch (error) {
    // A destroyed execution context here usually means the page navigated out
    // from under us mid-check. The one verified, recurring cause is the app
    // force-logging-out the session under sustained use — detect that specific
    // case and annotate it before re-throwing, so it counts as a known defect
    // instead of a generic, uncategorised failure.
    // The destroyed context fires mid-navigation, so the /login page (and its
    // alert) may not have rendered yet at this exact instant — a plain
    // isVisible() check races the navigation and misses it. Give it a bounded
    // window to actually appear instead.
    const forcedLogoutAlert = page
      .getByRole('alert')
      .filter({ hasText: /logged out .*(another|other).*(device|browser)/i });
    const forcedOut = await forcedLogoutAlert
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (forcedOut) {
      noteKnownDefect(KNOWN_APP_DEFECTS.SESSION_FORCED_LOGOUT_UNDER_SUSTAINED_USE);
      throw new Error(
        `${KNOWN_APP_DEFECTS.SESSION_FORCED_LOGOUT_UNDER_SUSTAINED_USE.id} — the app force-logged-out ` +
          'the authenticated session mid-test ("logged out ... another device"), even though no ' +
          'other device was actually in use. This is an app problem, not a test problem.',
      );
    }
    /*
     * No alert, but we landed on /login: the session simply is not
     * authenticated any more. Left as the raw "Execution context was
     * destroyed", this reads like a Playwright timing bug and costs an
     * afternoon — it is what the auth specs logging the SHARED account out
     * looked like from here, for an entire suite's worth of failures. Name the
     * condition and list the two causes that actually produce it.
     */
    if (/\/login/i.test(page.url())) {
      throw new Error(
        'The session is no longer authenticated — this navigation landed on /login. The page ' +
          'context was destroyed by that redirect, which is why the underlying error mentions a ' +
          'destroyed execution context rather than a login.\n' +
          'Two things cause this: (1) another sign-in on the SAME account took the one session ' +
          'KPost allows per account — check that nothing outside the standard user is signing in ' +
          'or out (tests/auth/ uses env.users.auth precisely so it cannot); (2) the app dropped ' +
          'the session on its own (KPOST-AUTH-002).\n' +
          `Underlying error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

/** The iframe the dev server injects over the page to report an app error. */
const DEV_SERVER_OVERLAY = '#webpack-dev-server-client-overlay';

/**
 * Fail fast, and legibly, when the app under test has raised an error.
 *
 * The KPost dev server injects a full-page iframe overlay for **both** build
 * failures and uncaught runtime errors. The server still answers 200, so from
 * the suite's point of view the app is "up" — but the overlay then blocks
 * pointer events, and any click reports the useless
 * "<iframe id=webpack-dev-server-client-overlay> intercepts pointer events".
 * Reads (assertions, `fill`) still work, which makes the failure look
 * arbitrary: some tests pass, the ones that click do not.
 *
 * That reading has already cost several debugging sessions, so we detect the
 * overlay, pull the real error out of it — compiler message or runtime stack —
 * and raise that instead.
 *
 * Note this overlay is a **dev-mode** artifact. Against a production build it
 * would not exist, and the underlying error would instead surface as a silently
 * broken feature — so treat anything this reports as a genuine app defect, not
 * merely a local annoyance.
 */
export async function assertNoAppErrorOverlay(page: Page): Promise<void> {
  const detail = await readAppErrorOverlay(page);
  if (detail === null) return;

  // A specific, previously-verified crash: Firebase Messaging throws on
  // browsers it doesn't fully support (Safari/WebKit, Firefox), on every page
  // load. Annotate it as a known defect before failing, so the reporting
  // pipeline counts and files it instead of the failure vanishing into the
  // generic bucket alongside genuinely new failures. The thrown error is
  // prefixed with the defect's own id — matching SESSION_FORCED_LOGOUT's
  // pattern in `waitForAppReady` above — so the reporter's evidence-collector
  // can tell "this failure IS the Firebase crash" from "this test merely
  // carries an unrelated known-defect annotation from earlier in its body",
  // and stop attributing this crash's screenshot to whatever the test was
  // actually trying to verify when the crash cut it off.
  if (detail?.includes('messaging/unsupported-browser')) {
    noteKnownDefect(KNOWN_APP_DEFECTS.FIREBASE_MESSAGING_UNSUPPORTED_BROWSER_CRASH);
    throw new Error(
      `${KNOWN_APP_DEFECTS.FIREBASE_MESSAGING_UNSUPPORTED_BROWSER_CRASH.id} — the application ` +
        'under test raised an error — the dev-server error overlay is covering the page, so ' +
        'clicks will be intercepted. This is an app problem, not a test problem.\n\n' +
        (detail || '(overlay text could not be read)'),
    );
  }

  // The Firefox counterpart: MicInput throws an unhandled fetch error out of a
  // mount effect, on the shell every screen renders. Same treatment as the
  // Firebase crash above — attribute it so the run files ONE defect with real
  // evidence instead of two dozen anonymous "the app raised an error" failures.
  if (detail.includes('MicInput')) {
    noteKnownDefect(KNOWN_APP_DEFECTS.MIC_INPUT_UNHANDLED_NETWORK_ERROR);
    throw new Error(
      `${KNOWN_APP_DEFECTS.MIC_INPUT_UNHANDLED_NETWORK_ERROR.id} — the application under test ` +
        'raised an unhandled error from MicInput, so the dev-server overlay is covering the page ' +
        'and clicks will be intercepted. This is an app problem, not a test problem.\n\n' +
        detail,
    );
  }

  throw new Error(
    'The application under test raised an error — the dev-server error overlay is ' +
      'covering the page, so clicks will be intercepted. This is an app problem, ' +
      'not a test problem.\n\n' +
      (detail || '(overlay text could not be read)'),
  );
}

/** The overlay's text when it is showing, or null when it is not. */
export async function readAppErrorOverlay(page: Page): Promise<string | null> {
  const overlay = page.locator(DEV_SERVER_OVERLAY);
  if (!(await overlay.isVisible().catch(() => false))) return null;
  const detail = await page
    .frameLocator(DEV_SERVER_OVERLAY)
    .locator('body')
    .innerText()
    .catch(() => '');
  return detail.trim().slice(0, 800);
}

/**
 * Dismiss a **runtime**-error overlay the way a user would (its × button), and
 * return the error text that was showing.
 *
 * Rationale: the dev overlay is a dev-mode artifact. For an *uncaught runtime
 * error* the app underneath usually still functions — verified on KMail, where
 * all three tabs work normally once the overlay is closed — and in a production
 * build there would be no overlay at all. Refusing to test past it would mean
 * refusing to test what users actually get.
 *
 * Deliberately refuses to dismiss a **compile**-failure overlay: behind one of
 * those there is no working app to test, so it throws instead.
 *
 * Callers own the accountability half of the bargain: pair this with a
 * `noteKnownDefect()` annotation so the dismissed error stays visible in the
 * report instead of quietly vanishing.
 */
export async function dismissRuntimeErrorOverlay(page: Page): Promise<string | null> {
  const detail = await readAppErrorOverlay(page);
  if (detail === null) return null;

  // "Uncaught runtime errors:" heads the runtime variant. Anything else —
  // "Failed to compile", "Module build failed" — means no app to test.
  if (!/uncaught runtime error/i.test(detail)) {
    throw new Error(
      'The dev-server overlay reports a COMPILE failure, which cannot be dismissed ' +
        'past — there is no working app underneath.\n\n' +
        detail,
    );
  }

  await page
    .frameLocator(DEV_SERVER_OVERLAY)
    .getByRole('button', { name: /dismiss|close|×/i })
    .first()
    .click();
  await page.locator(DEV_SERVER_OVERLAY).waitFor({ state: 'hidden', timeout: 10_000 });
  return detail;
}

/**
 * Fill a controlled React input reliably.
 *
 * Controlled inputs re-render on every keystroke. `Locator.fill` sets the value
 * in one shot and dispatches a single input event, which most React onChange
 * handlers accept — but for inputs with debounced/validated state we verify the
 * committed value and fall back to sequential typing if React reverted it.
 */
export async function fillReactInput(locator: Locator, value: string): Promise<void> {
  await locator.waitFor({ state: 'visible' });
  await locator.fill('');
  await locator.fill(value);

  // Confirm React actually committed the value (guards against controlled
  // components that reset on re-render). If not, type character-by-character.
  const committed = await locator.inputValue();
  if (committed !== value) {
    await locator.fill('');
    await locator.pressSequentially(value, { delay: 20 });
  }
  await expect(locator).toHaveValue(value);
}

/**
 * Interact with a custom (non-native) React select / combobox.
 *
 * Component libraries (MUI, react-select, Radix, Headless UI) render dropdowns
 * as portalled listboxes rather than a native <select>. This opens the trigger,
 * waits for the listbox to be visible, and clicks the option by its accessible
 * name — resilient to the underlying DOM structure.
 */
export async function selectCustomOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option', { name: optionName }).click();
  // The listbox should close after selection — wait it out to avoid races.
  await expect(listbox).toBeHidden();
}

/**
 * Scroll a virtualized list until an item with the given accessible name is
 * rendered, then return its locator.
 *
 * Virtualized lists only mount visible rows, so `scrollIntoViewIfNeeded` on a
 * not-yet-rendered item fails. We incrementally scroll the container and poll
 * until the target row mounts or we exhaust the attempt budget.
 */
export async function scrollVirtualizedListToItem(
  container: Locator,
  itemName: string | RegExp,
  maxScrolls = 30,
): Promise<Locator> {
  const item = container.getByText(itemName, { exact: false }).first();

  for (let i = 0; i < maxScrolls; i++) {
    if (await item.isVisible().catch(() => false)) {
      await item.scrollIntoViewIfNeeded();
      return item;
    }
    // Scroll the virtualized viewport by roughly one page.
    await container.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.9));
    // Give react-window a tick to mount the newly-visible rows. This bounded
    // poll is the one legitimate place a short wait is unavoidable: a
    // virtualized row does not exist until scrolling mounts it, so there is no
    // element to auto-wait on yet.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await container.page().waitForTimeout(100);
  }

  throw new Error(`Item "${itemName}" not found after ${maxScrolls} scroll attempts in virtualized list.`);
}

/**
 * Wait for a toast/notification with the expected text to appear, assert it,
 * then wait for it to auto-dismiss so it cannot leak into the next assertion.
 */
export async function expectToast(
  page: Page,
  message: string | RegExp,
  options: { role?: 'alert' | 'status'; dismiss?: boolean } = {},
): Promise<void> {
  const { role = 'status', dismiss = true } = options;
  const toast = page.getByRole(role).filter({ hasText: message });
  await expect(toast).toBeVisible();
  if (dismiss) {
    // Toasts typically auto-dismiss; wait for detachment so subsequent steps
    // aren't fooled by a lingering notification.
    await toast.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {
      /* Non-auto-dismissing toast — leave it; the caller may close it. */
    });
  }
}
