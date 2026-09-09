/**
 * KPayPage — the KPost payments module. **Not implemented in this build.**
 *
 * ── Verification status (probed against the live app on 2026-08-13) ──
 * VERIFIED · The icon rail shows a KPay entry (`div.icon-KP_12-KWallet`), and
 *            the rail's expanded labels include "KPay".
 * VERIFIED · The Quick Access launcher does **not** offer KPay.
 * VERIFIED · Clicking the rail icon does not navigate — the URL stays exactly
 *            where it was. Clicking the expanded "KPay" label doesn't either.
 * VERIFIED · Every plausible route — `/kpay`, `/kwallet`, `/pay` — renders the
 *            404 page ("404 Page not found !").
 *
 * So there is no balance view, no transaction history, and no empty state to
 * assert against — those surfaces do not exist anywhere in the app yet. What
 * this page object models instead is the **current contract**: a visible but
 * dead nav entry (registered as KPOST-KPAY-001 — from a user's chair, an icon
 * that silently does nothing is broken UX regardless of roadmap).
 *
 * The specs built on this are designed to FAIL the day KPay ships, so the
 * page object gets rebuilt from the real DOM then — the same lifecycle the
 * KMail composer went through. Do not pre-write balance/history locators here;
 * inventing UI is how the blog-era page objects went wrong.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

export class KPayPage extends AppShellPage {
  /** The route KPay would own; today it renders the 404 page (see class doc). */
  protected readonly path = '/kpay';

  private readonly railIcon: Locator;
  private readonly notFoundImage: Locator;
  private readonly notFoundMessage: Locator;

  constructor(page: Page) {
    super(page);
    this.railIcon = page.locator('div[class*="icon-KP_12-KWallet"]').first();
    // The 404 page splits its copy across elements ("404" and "Page not
    // found !" are separate nodes), so no one element contains the full
    // phrase — match the pieces the DOM actually has.
    this.notFoundImage = page.getByRole('img', { name: '404' });
    this.notFoundMessage = page.getByText(/page not found/i);
  }

  // ---------------------------------------------------------------------------
  // The current contract
  // ---------------------------------------------------------------------------

  /** Assert the rail advertises a KPay entry. */
  async expectRailEntryVisible(): Promise<void> {
    await test.step('Expect the KPay rail entry', async () => {
      await expect(this.railIcon).toBeVisible();
    });
  }

  /** Assert the launcher does NOT offer KPay (verified — it never has). */
  async expectNotOfferedInLauncher(): Promise<void> {
    await test.step('Expect KPay to be absent from Quick Access', async () => {
      await this.openQuickAccess();
      await expect(
        this.quickAccessDialog.getByRole('button', { name: /\bKPay\b/ }),
      ).toHaveCount(0);
      await this.closeQuickAccess();
    });
  }

  /**
   * Click the rail entry and assert it goes nowhere (KPOST-KPAY-001).
   * When KPay ships, this assertion fails — rebuild this page object then.
   */
  async expectRailEntryIsDead(): Promise<void> {
    await test.step('Expect the KPay rail entry to not navigate (KPOST-KPAY-001)', async () => {
      const before = this.page.url();
      await this.click(this.railIcon);
      // Give the SPA a moment to route if it ever gains one; assert it did not.
      await expect(this.page).toHaveURL(before);
      await this.expectNoAppError();
    });
  }

  /** Navigate straight to the KPay route and assert the app 404s it. */
  async expectRouteNotImplemented(): Promise<void> {
    await test.step('Expect /kpay to render the 404 page', async () => {
      await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
      // Text first: it renders immediately, while the 404 GIF can report
      // itself invisible until the media finishes streaming.
      await expect(this.notFoundMessage).toBeVisible();
      await expect(this.notFoundImage).toBeVisible();
    });
  }
}
