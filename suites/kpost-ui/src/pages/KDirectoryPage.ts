/**
 * KDirectoryPage — the KPost contact directory module.
 *
 * ── Verification status (probed against the live app on 2026-08-12) ──
 * VERIFIED · Offered by Quick Access as `button "K KDirectory Open directory Open"`.
 * VERIFIED · Launching it navigates to `https://localhost:3000/kdirectory` with
 *            zero failed requests, and renders `heading "KDirectory"`.
 * VERIFIED · Reachable from the left icon rail too (`div.icon-KP_06-KDirectory`).
 * VERIFIED · For a not-yet-onboarded account the module opens on a **first-run
 *            setup wizard** — Country, Language, and a vertical (Personal /
 *            Business / Institution / Government) — with `button "Continue"`
 *            disabled until the required selections are made.
 *
 * GATED    · The contact search, directory list, and result filters sit behind
 *            that wizard, so they could not be observed with the standard test
 *            user. Re-probed on 2026-08-12: still gated, still the same wizard.
 *            Completing it permanently onboards the account into a vertical,
 *            which is a real account mutation — deliberately not performed
 *            without the owner's say-so. Those locators are therefore
 *            conventional, not verified, and are written role-first so only
 *            these declarations should need revisiting once a pre-onboarded
 *            fixture user exists.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

export type DirectoryVertical = 'Personal' | 'Business' | 'Institution' | 'Government';

/** Result filters/tabs the directory offers once onboarding is complete. */
export type DirectoryFilter = DirectoryVertical | 'All';

export class KDirectoryPage extends AppShellPage {
  protected readonly path = '/kdirectory';

  // ---- Verified ----
  private readonly moduleHeading: Locator;
  private readonly continueButton: Locator;
  private readonly countryLabel: Locator;
  private readonly languageLabel: Locator;

  // ---- Gated behind the setup wizard (conventional locators) ----
  private readonly contactSearch: Locator;
  private readonly directoryList: Locator;
  private readonly directoryEntries: Locator;
  private readonly addContactButton: Locator;
  private readonly noResultsState: Locator;

  constructor(page: Page) {
    super(page);
    this.moduleHeading = page.getByRole('heading', { name: /^\s*kdirectory\s*$/i });
    this.continueButton = page.getByRole('button', { name: /^\s*continue\s*$/i });
    this.countryLabel = page.getByText(/select country/i);
    this.languageLabel = page.getByText(/choose language/i);

    this.contactSearch = page.getByRole('searchbox').first();
    this.directoryList = page.getByRole('list').first();
    this.directoryEntries = this.directoryList.getByRole('listitem');
    this.addContactButton = page.getByRole('button', { name: /add contact|new contact/i });
    this.noResultsState = page.getByText(/no data found|no contacts|no results/i);
  }

  // ---------------------------------------------------------------------------
  // Launch & load
  // ---------------------------------------------------------------------------

  /** Open KDirectory through the Quick Access launcher (accessible nav path). */
  async openFromLauncher(): Promise<void> {
    await test.step('Open KDirectory from Quick Access', async () => {
      await this.launchModule('KDirectory');
      await this.expectPath(/\/kdirectory/i);
    });
  }

  /** Open KDirectory from the icon rail (covers the rail itself). */
  async openFromRail(): Promise<void> {
    await test.step('Open KDirectory from the icon rail', async () => {
      await this.openModuleFromRail('KDirectory');
      await this.expectPath(/\/kdirectory/i);
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the KDirectory module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await expect(this.moduleHeading).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // First-run setup wizard
  // ---------------------------------------------------------------------------

  /** True when the account still has to complete directory onboarding. */
  async isSetupRequired(): Promise<boolean> {
    return test.step('Check whether KDirectory setup is required', async () =>
      this.isVisible(this.continueButton, 5_000));
  }

  /** Assert the wizard is showing and refuses to continue until it is filled in. */
  async expectSetupGate(): Promise<void> {
    await test.step('Expect the setup wizard to gate Continue', async () => {
      await expect(this.countryLabel).toBeVisible();
      await expect(this.languageLabel).toBeVisible();
      await expect(this.continueButton).toBeDisabled();
    });
  }

  /** Assert each vertical option is offered by the wizard. */
  async expectVerticalOffered(vertical: DirectoryVertical): Promise<void> {
    await test.step(`Expect the "${vertical}" vertical to be offered`, async () => {
      await expect(this.page.getByText(vertical, { exact: true }).first()).toBeVisible();
    });
  }

  /**
   * Choose a vertical. NOTE: completing this wizard permanently onboards the
   * account, so only call it from a test that owns a disposable user.
   */
  async chooseVertical(vertical: DirectoryVertical): Promise<void> {
    await test.step(`Choose the "${vertical}" vertical`, async () => {
      await this.click(this.page.getByText(vertical, { exact: true }).first());
    });
  }

  async continueSetup(): Promise<void> {
    await test.step('Continue past the setup wizard', async () => {
      await this.click(this.continueButton);
    });
  }

  // ---------------------------------------------------------------------------
  // Directory search  (GATED — see class doc)
  // ---------------------------------------------------------------------------

  /** Search the directory for a query and submit it. */
  async searchDirectory(query: string): Promise<void> {
    await test.step(`Search the directory for "${query}"`, async () => {
      await this.fill(this.contactSearch, query);
      await this.contactSearch.press('Enter');
    });
  }

  /** Clear the directory search box. */
  async clearDirectorySearch(): Promise<void> {
    await test.step('Clear the directory search', async () => {
      await this.fill(this.contactSearch, '');
    });
  }

  /** Assert a contact is present in the directory results. */
  async verifyContactExists(name: string | RegExp): Promise<void> {
    await test.step(`Verify contact "${name}" exists in the directory`, async () => {
      await expect(this.directoryEntries.filter({ hasText: name }).first()).toBeVisible();
    });
  }

  /** Assert a contact is NOT present in the directory results. */
  async verifyContactAbsent(name: string | RegExp): Promise<void> {
    await test.step(`Verify contact "${name}" is absent from the directory`, async () => {
      await expect(this.directoryEntries.filter({ hasText: name })).toHaveCount(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Result filters / tabs  (GATED — see class doc)
  // ---------------------------------------------------------------------------

  /** A directory result filter, located by its accessible name. */
  private filterTab(filter: DirectoryFilter): Locator {
    return this.page
      .getByRole('tab', { name: new RegExp(`^\\s*${filter}\\s*$`, 'i') })
      .or(this.page.getByRole('button', { name: new RegExp(`^\\s*${filter}\\s*$`, 'i') }))
      .first();
  }

  /** Switch the directory results to a given filter/tab. */
  async openFilter(filter: DirectoryFilter): Promise<void> {
    await test.step(`Filter the directory by "${filter}"`, async () => {
      await this.click(this.filterTab(filter));
    });
  }

  async expectFilterAvailable(filter: DirectoryFilter): Promise<void> {
    await test.step(`Expect the "${filter}" filter to be available`, async () => {
      await expect(this.filterTab(filter)).toBeVisible();
    });
  }

  async expectFilterSelected(filter: DirectoryFilter): Promise<void> {
    await test.step(`Expect the "${filter}" filter to be selected`, async () => {
      await expect(this.filterTab(filter)).toHaveAttribute('aria-selected', 'true');
    });
  }

  /**
   * Assert the directory reported no matches.
   *
   * The exact string is UNVERIFIED — the results surface is behind the setup
   * wizard, so it has never been observed. The locator accepts the variants the
   * rest of the app uses ("No Data Found" in KMail, "No results found" in
   * Katchup, "No Data found" on Home) plus "No contacts". Narrow it to the real
   * string the first time this runs against a pre-onboarded account.
   */
  async expectNoResults(message?: string): Promise<void> {
    await test.step('Expect the empty directory results state ("No Data Found")', async () => {
      await expect(this.noResultsState, message).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Directory list
  // ---------------------------------------------------------------------------

  async expectDirectoryListVisible(): Promise<void> {
    await test.step('Expect the directory list', async () => {
      await expect(this.directoryList).toBeVisible();
    });
  }

  async directoryCount(): Promise<number> {
    return test.step('Count directory entries', async () => this.directoryEntries.count());
  }

  async openContact(name: string | RegExp): Promise<void> {
    await test.step(`Open contact "${name}"`, async () => {
      await this.click(this.directoryEntries.filter({ hasText: name }).first());
    });
  }

  async startAddContact(): Promise<void> {
    await test.step('Start adding a contact', async () => {
      await this.click(this.addContactButton);
    });
  }
}
