/**
 * KMail module — navigation, tabs, and mailbox state.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * ── The 401 defect is resolved ──
 * This file previously carried a deliberately-failing test: launching KMail
 * fired four calls to `kmail5.kpostindia.com/kmail5/v2/common/*` that all
 * returned 401, and the SPA force-logged-out to `/login`. Re-probed on
 * 2026-08-12, KMail loads cleanly and makes no calls to that host at all — its
 * data now comes from `localhost:8989`. The module-load test below is therefore
 * a normal passing smoke test rather than a known-failure marker.
 *
 * Compose is not covered here: KMail has no composer. Composing is the separate
 * "Write Mail" module, which now has its own page object and specs — see
 * `tests/writemail/writemail.spec.ts`. What stays on `KMailPage` is the Sent
 * folder, because that is KMail's, not the composer's.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { faker } from '@faker-js/faker';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

/** Per-run unique text so parallel workers can never collide. */
function uniqueTerm(): string {
  return `qa-${Date.now()}-${faker.string.alphanumeric(6)}`;
}

test.describe('KMail navigation @smoke @kmail', () => {
  test('KMail is offered in the Quick Access launcher', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.expectModuleAvailable('KMail');
  });

  test('opening KMail from Quick Access loads the module', async ({
    homePage,
    kmailPage,
    page,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kmailPage.openFromLauncher();

    await expect(page).toHaveURL(/\/kmail/i);
    await kmailPage.expectLoaded();
    await kmailPage.expectPaneTitle();
  });

  test('KMail is also reachable from the icon rail', async ({ homePage, kmailPage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kmailPage.openFromRail();

    await kmailPage.expectLoaded();
  });
});

test.describe('KMail mailbox @regression @kmail', () => {
  test('the mailbox exposes Recents, Contacts and Status of Mails tabs', async ({
    homePage,
    kmailPage,
  }) => {
    // KMail still raises an uncaught TypeError on load (annotated below), and
    // in dev mode that pops an overlay which blocks clicks. Verified 2026-08-12:
    // the module underneath works — all three tabs click and select correctly
    // once the dev-only overlay is dismissed, which is exactly what a user does
    // and what a production build would show. So: dismiss the dev artifact,
    // test the real function, and keep the error on record via the annotation.
    noteKnownDefect(KNOWN_APP_DEFECTS.KMAIL_UNOPENED_MAIL_TYPE_ERROR);

    await homePage.open();
    await kmailPage.openFromLauncher();
    await kmailPage.dismissDevErrorOverlay();
    await kmailPage.expectLoaded();

    await kmailPage.expectTabsAvailable();

    await kmailPage.openContactsTab();
    await kmailPage.expectContactsSummary();

    await kmailPage.openStatusOfMailsTab();

    await kmailPage.openRecentsTab();
    await kmailPage.expectUnopenedMailsBadge();
  });

  test('the Recents pane reports mailbox state', async ({ homePage, kmailPage }) => {
    await homePage.open();
    await kmailPage.openFromLauncher();
    await kmailPage.expectLoaded();

    await kmailPage.expectUnopenedMailsBadge();
    await kmailPage.expectStatusOfMailSummary();

    // The counter must be a real number, not a placeholder.
    expect(await kmailPage.unopenedMailCount()).toBeGreaterThanOrEqual(0);
  });

  /**
   * Deliberately modest. KMail renders the same "No Data Found" whether the
   * mailbox is empty or a search matched nothing, so with an empty mailbox
   * there is no observable difference to assert on — claiming this proves
   * filtering would be a lie. What it does prove: the search box accepts and
   * commits a query, and the pane survives it. Strengthen this to a real
   * filtering assertion once the test account has mail.
   */
  test('the mailbox search accepts a query and keeps the pane coherent', async ({
    homePage,
    kmailPage,
  }) => {
    const term = uniqueTerm();

    await homePage.open();
    await kmailPage.openFromLauncher();
    await kmailPage.expectLoaded();

    await kmailPage.searchMail(term);
    expect(await kmailPage.currentSearchTerm()).toBe(term);
    await kmailPage.expectNoMailsFound();

    await kmailPage.clearMailSearch();
    expect(await kmailPage.currentSearchTerm()).toBe('');
    await kmailPage.expectUnopenedMailsBadge();
  });
});
