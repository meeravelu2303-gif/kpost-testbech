/**
 * KEcommerce module — module load and merchant catalog.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * Verified against the live app on 2026-08-12: the module routes to
 * `/e-commerce` (hyphenated, not `/kecommerce`) and renders a grid of ~60
 * merchant logos as images with alt text. It loads with zero failed requests.
 *
 * It has no module-level header, search, filters, or cart — the only
 * interactive elements are the four app-shell header controls. So "header
 * visibility" is asserted as the app shell, and the catalog via a small stable
 * sample of merchants plus a floor on tile count. Asserting the full merchant
 * list would turn any merchandising change into a red build.
 */
import { test } from '../../src/fixtures/fixtures';
import { SAMPLE_MERCHANTS } from '../../src/pages/KEcommercePage';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

test.describe('KEcommerce @smoke @kecommerce', () => {
  test('KEcommerce is offered in the Quick Access launcher', async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await homePage.openQuickAccess();
    await homePage.expectModuleAvailable('KEcommerce');
  });

  test('opening KEcommerce loads the module at /e-commerce', async ({
    homePage,
    kecommercePage,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kecommercePage.navigateToKEcommerce();

    await kecommercePage.expectLoaded();
  });

  test('KEcommerce is also reachable from the icon rail', async ({ homePage, kecommercePage }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await kecommercePage.openFromRail();

    await kecommercePage.expectLoaded();
  });

  test('the merchant catalog renders', async ({ homePage, kecommercePage }) => {
    // Intermittent: the catalog sometimes renders as an empty pane (KECOM-001).
    noteKnownDefect(KNOWN_APP_DEFECTS.KECOMMERCE_CATALOG_INTERMITTENTLY_EMPTY);

    await homePage.open();
    await kecommercePage.navigateToKEcommerce();
    await kecommercePage.expectLoaded();

    await kecommercePage.expectCatalogLoaded();
    await kecommercePage.expectCatalogPopulated();
  });
});

test.describe('KEcommerce catalog @regression @kecommerce', () => {
  test('each sampled merchant tile is visible', async ({ homePage, kecommercePage }) => {
    // Intermittent: the catalog sometimes renders as an empty pane (KECOM-001).
    noteKnownDefect(KNOWN_APP_DEFECTS.KECOMMERCE_CATALOG_INTERMITTENTLY_EMPTY);

    await homePage.open();
    await kecommercePage.navigateToKEcommerce();
    await kecommercePage.expectLoaded();

    for (const merchant of SAMPLE_MERCHANTS) {
      await kecommercePage.expectMerchantVisible(merchant);
    }
  });
});
