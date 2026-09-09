/**
 * HomePage — the authenticated KPost landing pane (route: `/home`).
 *
 * ── Verification status (probed against the live app on 2026-08-12) ──
 * The shell chrome (top bar, Quick Access launcher, icon rail, logout) lives in
 * `AppShellPage`; this class covers only what is specific to the Home pane:
 *
 * VERIFIED · `tablist` with `tab "Recents"` (selected by default) and `tab "Contacts"`.
 * VERIFIED · Two `searchbox "Search"` controls render in the pane — the locator
 *            is scoped with `.first()` to stay strict-mode safe.
 * VERIFIED · The pane also hosts KNews (with a `button "Sync latest news"`) and
 *            KEcommerce summary panels.
 * VERIFIED · The signed-in user's name renders in the top bar as plain text.
 *
 * Superseded assumption: an earlier version of this page object navigated by
 * clicking sidebar *text* (`getByText('KMail')`). The live rail is icon-only
 * with no text or accessible name, so that never could have worked — module
 * navigation now goes through `AppShellPage.launchModule()`.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

export class HomePage extends AppShellPage {
  protected readonly path = '/home';

  private readonly recentsTab: Locator;
  private readonly contactsTab: Locator;
  private readonly paneSearch: Locator;
  private readonly knewsPanel: Locator;
  private readonly syncNewsButton: Locator;
  private readonly kecommercePanel: Locator;

  constructor(page: Page) {
    super(page);
    this.recentsTab = page.getByRole('tab', { name: /recents/i });
    this.contactsTab = page.getByRole('tab', { name: /contacts/i });
    // The pane renders more than one "Search" box; scope to the first.
    this.paneSearch = page.getByRole('searchbox', { name: /search/i }).first();
    this.knewsPanel = page.getByText(/^\s*KNews\s*$/).first();
    this.syncNewsButton = page.getByRole('button', { name: /sync latest news/i });
    this.kecommercePanel = page.getByText(/^\s*KEcommerce\s*$/).first();
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the Home pane to be loaded', async () => {
      await this.expectPath(/\/home/i);
      await this.expectShellVisible();
      await expect(this.recentsTab).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Recents / Contacts tabs
  // ---------------------------------------------------------------------------

  async openRecentsTab(): Promise<void> {
    await test.step('Open the Recents tab', async () => {
      await this.click(this.recentsTab);
      await expect(this.recentsTab).toHaveAttribute('aria-selected', 'true');
    });
  }

  async openContactsTab(): Promise<void> {
    await test.step('Open the Contacts tab', async () => {
      await this.click(this.contactsTab);
      await expect(this.contactsTab).toHaveAttribute('aria-selected', 'true');
    });
  }

  async expectTabsAvailable(): Promise<void> {
    await test.step('Expect the Recents and Contacts tabs', async () => {
      await expect(this.recentsTab).toBeVisible();
      await expect(this.contactsTab).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Pane content
  // ---------------------------------------------------------------------------

  /** Search within the Home pane (distinct from the top-bar global search,
   *  which is disabled in this build). */
  async searchPane(term: string): Promise<void> {
    await test.step(`Search the Home pane for "${term}"`, async () => {
      await this.fill(this.paneSearch, term);
      await this.paneSearch.press('Enter');
    });
  }

  async expectNewsPanel(): Promise<void> {
    await test.step('Expect the KNews panel', async () => {
      await expect(this.knewsPanel).toBeVisible();
      await expect(this.syncNewsButton).toBeVisible();
    });
  }

  async expectMarketplacePanel(): Promise<void> {
    await test.step('Expect the KEcommerce panel', async () => {
      await expect(this.kecommercePanel).toBeVisible();
    });
  }

  /** Assert the signed-in user's name is reflected in the top bar. */
  async expectSignedInAs(name: string | RegExp): Promise<void> {
    await test.step(`Expect to be signed in as "${name}"`, async () => {
      await expect(this.page.getByText(name).first()).toBeVisible();
    });
  }
}
