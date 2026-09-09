/**
 * KEcommercePage — the KPost marketplace module (route: `/e-commerce`).
 *
 * ── Verification status (probed against the live app on 2026-08-12) ──
 * VERIFIED · Offered by Quick Access as `button "K KEcommerce Open marketplace Open"`.
 * VERIFIED · Launching it routes to **`/e-commerce`** — hyphenated, and not the
 *            `/kecommerce` the module name would suggest.
 * VERIFIED · The catalog is a grid of ~60 merchant logos exposed as images with
 *            alt text: amazon, flipkart, myntra, snapdeal, paytm, swiggy,
 *            adidas, decathlon, croma, lenskart, makemytrip, and so on.
 * VERIFIED · Zero failed requests on load — the cleanest module in the app.
 *
 * ── What the module does NOT have ──
 * No heading, no search box, no filters, no cart, and no per-product controls:
 * the only interactive elements on the page are the four app-shell header
 * controls. So "product catalog / header visibility" is asserted as the shell
 * header plus the merchant grid; there is no module-level header to assert, and
 * claiming otherwise would be inventing UI.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

/**
 * Merchants used as a load signal. Deliberately a small, stable subset of the
 * catalog — asserting all ~60 would turn any merchandising change into a test
 * failure.
 */
export const SAMPLE_MERCHANTS = ['amazon', 'flipkart', 'myntra', 'snapdeal'] as const;

export class KEcommercePage extends AppShellPage {
  protected readonly path = '/e-commerce';

  private readonly merchantLogos: Locator;

  constructor(page: Page) {
    super(page);
    // Every catalog entry is an <img> with the merchant name as its alt text.
    this.merchantLogos = page.getByRole('img');
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Open KEcommerce through the Quick Access launcher (accessible nav path). */
  async navigateToKEcommerce(): Promise<void> {
    await test.step('Open KEcommerce from Quick Access', async () => {
      await this.launchModule('KEcommerce');
      await this.expectPath(/\/e-commerce/i);
    });
  }

  /** Alias matching the other module page objects. */
  async openFromLauncher(): Promise<void> {
    await this.navigateToKEcommerce();
  }

  /** Open KEcommerce from the left icon rail (`div.icon-KP_14-KCommerce`). */
  async openFromRail(): Promise<void> {
    await test.step('Open KEcommerce from the icon rail', async () => {
      await this.openModuleFromRail('KEcommerce');
      await this.expectPath(/\/e-commerce/i);
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the KEcommerce module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await this.expectPath(/\/e-commerce/i);
      await this.expectShellVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Merchant catalog
  // ---------------------------------------------------------------------------

  /** A catalog entry, located by the merchant's alt text. */
  private merchant(name: string): Locator {
    return this.page.getByRole('img', { name }).first();
  }

  async expectMerchantVisible(name: string): Promise<void> {
    await test.step(`Expect the "${name}" merchant tile`, async () => {
      await expect(this.merchant(name)).toBeVisible();
    });
  }

  /** Assert the catalog rendered, using a stable sample of merchants. */
  async expectCatalogLoaded(): Promise<void> {
    await test.step('Expect the merchant catalog', async () => {
      for (const merchant of SAMPLE_MERCHANTS) {
        await expect(this.merchant(merchant)).toBeVisible();
      }
    });
  }

  /** How many images the catalog page renders (merchant tiles plus shell logos). */
  async tileCount(): Promise<number> {
    return test.step('Count catalog tiles', async () => this.merchantLogos.count());
  }

  /**
   * Assert the catalog is populated rather than a near-empty shell.
   *
   * A floor, not an exact count: the merchant list is merchandising data and
   * will change, so pinning it exactly would make this fail for the wrong reason.
   */
  async expectCatalogPopulated(minimumTiles = 20): Promise<void> {
    await test.step(`Expect at least ${minimumTiles} catalog tiles`, async () => {
      expect(await this.tileCount()).toBeGreaterThanOrEqual(minimumTiles);
    });
  }
}
