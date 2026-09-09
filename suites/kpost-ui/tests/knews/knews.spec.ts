/**
 * KNews module — navigation, categories, feed cards, and click-through.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * Verified against the live app on 2026-08-13. Notes that shape these tests:
 *
 *  · There is no "Top Stories" category in this build — the broadest feed is
 *    "All News", and the topic set is Politics / Technology / Science / Health /
 *    Business / Sports / Environment / Entertainment / Opinion / World. The
 *    category tests use what exists.
 *  · Feed content arrives via third-party RSS bridges (corsproxy.io,
 *    rss2json.com) that intermittently answer 503/422/429, so card assertions
 *    are a floor (at least one card), not a census.
 *  · Cards link to external news sites, so click-through is verified by
 *    asserting the sampled cards are genuine links with a non-empty href —
 *    navigating the suite off to a third-party site would prove nothing about
 *    KPost and everything about that site's uptime.
 */
import { test } from '../../src/fixtures/fixtures';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

test.describe('KNews navigation @smoke @knews', () => {
  test('KNews is offered in the Quick Access launcher', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.expectModuleAvailable('KNews');
  });

  test('opening KNews from Quick Access loads the module', async ({ homePage, knewsPage, page }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await knewsPage.openFromLauncher();

    await knewsPage.expectLoaded();
    await page.waitForURL(/\/knews/i);
  });

  test('KNews is also reachable from the icon rail', async ({ homePage, knewsPage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await knewsPage.openFromRail();

    await knewsPage.expectLoaded();
  });

  test('the news feed renders cards', async ({ homePage, knewsPage }) => {
    // Intermittent: when the third-party news bridges fail or rate-limit, the
    // feed silently renders empty instead of an error state (KNEWS-001).
    noteKnownDefect(KNOWN_APP_DEFECTS.KNEWS_EMPTY_FEED_ON_SOURCE_FAILURE);

    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    await knewsPage.expectFeedHasCards();
  });

  test('the breaking-news ticker links out when breaking content exists', async ({
    homePage,
    knewsPage,
  }) => {
    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    // The ticker mounts only when the third-party breaking feed returned data
    // — observed present and absent across runs on the same day. That supply
    // is not this suite's to control, so absence is a skip, not a failure.
    test.skip(
      !(await knewsPage.hasBreakingTicker()),
      'No breaking-news content right now — the third-party breaking feed returned nothing, so the ticker did not mount.',
    );

    await knewsPage.expectBreakingTicker();
  });
});

test.describe('KNews categories @regression @knews', () => {
  test('the sidebar offers every verified category', async ({ homePage, knewsPage }) => {
    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    await knewsPage.expectCategoriesAvailable();
  });

  test('selecting World, Sports and All News keeps the module coherent', async ({
    homePage,
    knewsPage,
  }) => {
    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    // "Top Stories" does not exist in this build; All News is the broad feed.
    for (const category of ['World', 'Sports', 'All News'] as const) {
      await knewsPage.openCategory(category);
      await knewsPage.expectLoaded();
    }
  });
});

test.describe('KNews cards @regression @knews', () => {
  test('news cards support click-through (real links with targets)', async ({
    homePage,
    knewsPage,
  }) => {
    // Intermittent for the same reason as "the news feed renders cards".
    noteKnownDefect(KNOWN_APP_DEFECTS.KNEWS_EMPTY_FEED_ON_SOURCE_FAILURE);

    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    await knewsPage.expectFeedHasCards();
    await knewsPage.expectCardsClickable(3);
  });

  test('the headline search accepts a query', async ({ homePage, knewsPage }) => {
    await homePage.open();
    await knewsPage.openFromLauncher();
    await knewsPage.expectLoaded();

    await knewsPage.searchHeadlines('cricket');
    // Filtering behaviour is client-side and content-dependent; the committed
    // query plus a coherent module is what is stable to assert.
    await knewsPage.expectNoAppError();
  });
});
