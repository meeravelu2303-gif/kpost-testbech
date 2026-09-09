/**
 * AppShellPage — the persistent KPost application chrome.
 *
 * Every authenticated screen (verified on `/home` and `/kdirectory`) renders the
 * same shell: a top bar (logo, Global Search, voice command, Quick Access,
 * account name, language picker) and a narrow left icon rail. Module pages
 * extend this class so they inherit navigation, launching, and logout.
 *
 * ── How KPost navigation actually works (verified against the live app) ──
 * The left rail is **icon-only**: `<div class="... icon-KP_03-KMail">` with no
 * text, no `aria-label`, no `title`. It is therefore unreachable by any
 * accessible locator — a genuine accessibility gap in the product, and the one
 * place this framework is forced to fall back to a CSS class selector.
 *
 * The robust, accessible path is the **Quick Access launcher** (top-bar button,
 * or Ctrl/Cmd+K): a real ARIA dialog whose module entries are real buttons with
 * real accessible names, e.g. `button "K KMail Open inbox and mails Open"`.
 * `launchModule()` uses that path; `openModuleFromRail()` exists only to cover
 * the rail itself.
 *
 * Note: `/home` always has one background `role="dialog"` in the DOM, so the
 * launcher must be selected by its content, never by role alone.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { BasePage } from './BasePage';
import { assertNoAppErrorOverlay, dismissRuntimeErrorOverlay } from '../utils/react-helpers';
import { KNOWN_APP_DEFECTS, type KnownDefect, noteKnownDefect } from '../utils/known-defects';
import { logger } from '../utils/logger';
import type { KPostModule } from '../types';

/** CSS classes of the icon-only left rail, read off the live DOM. Last-resort
 *  selectors: the rail exposes no accessible name to target (see class doc).
 *  Partial by design — "KDOC" and "My Profile" are launcher-only entries with
 *  no verified rail icon. */
const RAIL_ICON_CLASS: Partial<Record<KPostModule, string>> = {
  Home: 'icon-KP_01-Home',
  'Write Mail': 'icon-KP_02-Write-Letter',
  KMail: 'icon-KP_03-KMail',
  Katchup: 'icon-KP_04-Katchup',
  Kall: 'icon-KP_05-Kall',
  KDirectory: 'icon-KP_06-KDirectory',
  KCloud: 'icon-KP_295_Cloud-Storage',
  KBooking: 'icon-KP_88-Bus',
  KEcommerce: 'icon-KP_14-KCommerce',
  KNews: 'icon-KP_08-KNews',
  // Present in the rail but dead: clicking it does not navigate (KPOST-KPAY-001).
  KPay: 'icon-KP_12-KWallet',
  Settings: 'icon-KP_15-Settings',
};

const LOGOUT_RAIL_ICON = 'icon-KP_18-Logout';

/**
 * How long the shell may take to paint after a navigation.
 *
 * Measured, not guessed: KPost boots behind a `PersistGate` loader and the first
 * authenticated paint regularly lands well past the 10s default assertion
 * budget. This is the single slow gate — every assertion *after* the shell is up
 * keeps the normal timeout, so a genuine regression still fails fast.
 */
const SHELL_RENDER_TIMEOUT = 45_000;

/** Widest viewport still treated as "mobile" for defect attribution (Pixel 7 is 412px). */
const MOBILE_VIEWPORT_MAX_WIDTH = 600;

export abstract class AppShellPage extends BasePage {
  protected readonly quickAccessButton: Locator;
  protected readonly globalSearchButton: Locator;
  protected readonly voiceCommandButton: Locator;
  protected readonly quickAccessDialog: Locator;
  protected readonly quickAccessSearch: Locator;
  protected readonly sessionExpiredAlert: Locator;
  protected readonly languageSelect: Locator;
  private readonly logoutRailIcon: Locator;
  private readonly logoutConfirmButton: Locator;

  constructor(page: Page) {
    super(page);
    this.quickAccessButton = page.getByRole('button', { name: /quick access/i });
    // Verified disabled in the current build (aria-label "Global Search (Disabled)").
    this.globalSearchButton = page.getByRole('button', { name: /global search/i });
    this.voiceCommandButton = page.getByRole('button', { name: /start voice command/i });
    // `/home` carries a second, unrelated dialog — always disambiguate by content.
    this.quickAccessDialog = page.getByRole('dialog').filter({ hasText: 'Quick Access' }).first();
    this.quickAccessSearch = this.quickAccessDialog.getByPlaceholder(/search pages, contacts, messages/i);
    this.sessionExpiredAlert = page.getByRole('alert').filter({ hasText: /session has expired/i });
    // The app's only real preference control (English / Russian / Japanese).
    this.languageSelect = page.locator('select').first();
    this.logoutRailIcon = page.locator(`div[class*="${LOGOUT_RAIL_ICON}"]`).first();
    this.logoutConfirmButton = page.getByRole('button', { name: /^\s*log ?out\s*$/i });
  }

  // ---------------------------------------------------------------------------
  // Quick Access launcher
  // ---------------------------------------------------------------------------

  /** Open the launcher from the top-bar button. */
  async openQuickAccess(): Promise<void> {
    await test.step('Open the Quick Access launcher', async () => {
      try {
        await this.click(this.quickAccessButton);
      } catch (error) {
        // On mobile there IS no Quick Access button, so this times out waiting
        // for an element the layout never renders (KPOST-HOME-001). Attributing
        // it only in `expectShellVisible` missed 19 real sightings in the
        // 2026-08-28 run, because most tests reach the launcher through here.
        await this.attributeMissingShell();
        throw error;
      }
      await expect(this.quickAccessDialog).toBeVisible();
    });
  }

  /** Open the launcher via the Ctrl+K shortcut (verified: Ctrl+K → Quick Access,
   *  not the global search, which is disabled in this build). */
  async openQuickAccessByShortcut(): Promise<void> {
    await test.step('Open Quick Access with Ctrl+K', async () => {
      await this.page.keyboard.press('Control+k');
      await expect(this.quickAccessDialog).toBeVisible();
    });
  }

  async closeQuickAccess(): Promise<void> {
    await test.step('Close the Quick Access launcher', async () => {
      await this.page.keyboard.press('Escape');
      await expect(this.quickAccessDialog).toBeHidden();
    });
  }

  /**
   * The launcher entry for a module, for specs that need to assert its
   * ABSENCE.
   *
   * `expectModuleAvailable()` covers "it is offered"; proving a search filtered
   * something out needs the locator itself, because there is no negative form
   * of that helper. Exposed read-only — clicking still goes through
   * `launchModule()` so every navigation keeps its `test.step` and its
   * actionability handling.
   */
  launcherEntry(module: KPostModule): Locator {
    return this.moduleCard(module);
  }

  /** The launcher card for a module, located by its accessible name. */
  protected moduleCard(module: KPostModule): Locator {
    return this.quickAccessDialog.getByRole('button', { name: new RegExp(`\\b${module}\\b`) }).first();
  }

  /** Assert a module is offered by the launcher (opens it if not already open). */
  async expectModuleAvailable(module: KPostModule): Promise<void> {
    await test.step(`Expect "${module}" to be offered in Quick Access`, async () => {
      if (!(await this.quickAccessDialog.isVisible())) await this.openQuickAccess();
      try {
        await expect(this.moduleCard(module)).toBeVisible();
      } catch (error) {
        await this.attributeMissingShell();
        throw error;
      }
    });
  }

  /** Launch a module from the launcher and wait for the SPA to settle. */
  async launchModule(module: KPostModule): Promise<void> {
    await test.step(`Launch "${module}" from Quick Access`, async () => {
      if (!(await this.quickAccessDialog.isVisible())) await this.openQuickAccess();
      try {
        await this.click(this.moduleCard(module));
      } catch (error) {
        await this.attributeMissingShell();
        throw error;
      }
      await expect(this.quickAccessDialog).toBeHidden();
    });
  }

  /** Type into the launcher's search field. */
  async searchQuickAccess(term: string): Promise<void> {
    await test.step(`Search Quick Access for "${term}"`, async () => {
      await this.fill(this.quickAccessSearch, term);
    });
  }

  // ---------------------------------------------------------------------------
  // Icon rail (CSS-class fallback — see class doc)
  // ---------------------------------------------------------------------------

  /** Navigate via the left icon rail. Only for covering the rail itself;
   *  prefer `launchModule()` everywhere else. */
  async openModuleFromRail(module: KPostModule): Promise<void> {
    const iconClass = RAIL_ICON_CLASS[module];
    if (!iconClass) {
      throw new Error(`"${module}" has no icon in the left rail — launch it with launchModule() instead.`);
    }

    await test.step(`Open "${module}" from the icon rail`, async () => {
      await this.click(this.page.locator(`div[class*="${iconClass}"]`).first());
    });
  }

  // ---------------------------------------------------------------------------
  // Language — the app's only user preference control
  // ---------------------------------------------------------------------------
  // It lives in the shell header, not in Settings: that module ships no
  // toggles, switches, or theme controls at all (verified 2026-08-12).

  /** The currently selected interface language. */
  async currentLanguage(): Promise<string> {
    return test.step('Read the selected language', async () => this.languageSelect.inputValue());
  }

  /** Assert the language picker offers the expected set of languages. */
  async expectLanguageOptions(expected: readonly string[]): Promise<void> {
    await test.step(`Expect the language options ${expected.join(', ')}`, async () => {
      await expect(this.languageSelect).toBeVisible();
      for (const language of expected) {
        await expect(this.languageSelect.getByRole('option', { name: language })).toHaveCount(1);
      }
    });
  }

  /**
   * Change the interface language.
   *
   * Mutates a persisted preference (`i18nextLng`), so a test that calls this
   * owns restoring it — or should run in its own context.
   */
  async selectLanguage(language: string): Promise<void> {
    await test.step(`Select the "${language}" language`, async () => {
      await this.languageSelect.selectOption({ label: language });
    });
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  /**
   * Assert the shell is present — the cheapest proof we are still signed in.
   *
   * When the Quick Access button is missing, the failure is worth naming rather
   * than reporting as "element(s) not found". On a mobile viewport it is
   * KPOST-HOME-001: the shell renders with no navigation at all, so there is
   * nothing to launch a module from. The check runs only after the assertion has
   * genuinely failed, and only credits the defect when the page really is
   * signed-in-but-navigation-less — a logged-out page or a desktop viewport
   * falls through to the original error.
   */
  async expectShellVisible(): Promise<void> {
    await test.step('Expect the authenticated app shell', async () => {
      try {
        await expect(this.quickAccessButton).toBeVisible({ timeout: SHELL_RENDER_TIMEOUT });
      } catch (error) {
        await this.attributeMissingShell();
        throw error;
      }
    });
  }

  /**
   * Explain a missing Quick Access button when the cause is known.
   *
   * Annotates only; the caller still throws. Silent on anything it cannot
   * positively identify, because a guess in a bug report is worse than a gap.
   */
  private async attributeMissingShell(): Promise<void> {
    if (/\/login/i.test(this.page.url())) return; // Logged out — a different story.
    const viewport = this.page.viewportSize();
    const isMobile = viewport !== null && viewport.width <= MOBILE_VIEWPORT_MAX_WIDTH;
    if (!isMobile) return;
    // Confirm the page really is a rendered, signed-in shell that simply has no
    // navigation — rather than a page that failed to load, which would be a
    // different problem wearing the same symptom. Any one of these is enough:
    // the app renders different content per module, so requiring tabs alone
    // (as the first version did) missed every non-Home screen.
    const shellRendered = await Promise.all([
      this.page.getByRole('tab').first().isVisible().catch(() => false),
      this.voiceCommandButton.isVisible().catch(() => false),
      this.globalSearchButton.isVisible().catch(() => false),
    ]).then((results) => results.some(Boolean));
    if (!shellRendered) return;
    // And the defect is the ABSENCE of the launcher — if it is there, whatever
    // just failed was something else.
    if ((await this.quickAccessButton.count().catch(() => 0)) > 0) return;
    noteKnownDefect(KNOWN_APP_DEFECTS.MOBILE_SHELL_HAS_NO_NAVIGATION);
  }

  /**
   * Assert the app has not raised an uncaught error.
   *
   * Worth calling explicitly before asserting on UI that renders in response to
   * an action: when the app throws, the expected element simply never appears,
   * and a bare "element(s) not found" hides the real cause.
   */
  async expectNoAppError(): Promise<void> {
    await test.step('Expect no app error', async () => {
      await assertNoAppErrorOverlay(this.page);
    });
  }

  /**
   * Dismiss a dev-only runtime-error overlay the way a user would, so the test
   * can verify the module that is actually functioning underneath. Refuses to
   * dismiss compile failures (throws — there is nothing to test behind those).
   *
   * The dismissed error does not vanish: it is logged and attached to the test
   * as a `dismissed-app-error` annotation. Callers should pair this with
   * `noteKnownDefect()` so the report tells the whole story.
   */
  async dismissDevErrorOverlay(): Promise<void> {
    await test.step('Dismiss the dev-only runtime error overlay, if present', async () => {
      const detail = await dismissRuntimeErrorOverlay(this.page);
      if (detail !== null) {
        logger.warn('Dismissed a dev-server runtime error overlay', {
          error: detail.split('\n').slice(0, 4).join(' | '),
        });
        test.info().annotations.push({ type: 'dismissed-app-error', description: detail });
      }
    });
  }

  /**
   * Assert we landed on a module's route, and name the cause when we did not.
   *
   * Checking the URL *before* asserting looks tidier and is wrong: the sign-out
   * redirect is often still in flight at that moment, so the pre-check sees the
   * old URL, falls through, and the failure lands with no defect attached. That
   * is exactly how three real KPOST-KMAIL-003 sightings were reported as
   * anonymous "toHaveURL failed" in the 2026-08-28 run.
   *
   * So: assert first, and only once it has genuinely failed ask where we ended
   * up. By then the redirect has settled and the answer is trustworthy.
   */
  protected async expectModuleRoute(pattern: RegExp, signedOutDefect: KnownDefect): Promise<void> {
    try {
      await this.expectPath(pattern);
    } catch (error) {
      if (!/\/login/i.test(this.page.url())) throw error;
      const message = noteKnownDefect(signedOutDefect);
      throw new Error(
        `${signedOutDefect.id} — ${message}\n\nExpected to be on ${pattern}, but the app signed ` +
          `the session out and went to ${this.page.url()}.`,
      );
    }
  }

  /** Assert the app has NOT bounced us to the login screen. */
  async expectStillAuthenticated(): Promise<void> {
    await test.step('Expect the session to still be valid', async () => {
      await expect(this.page).not.toHaveURL(/\/login/i);
      await expect(this.sessionExpiredAlert).toBeHidden();
    });
  }

  /** Log out via the rail icon and its confirmation modal, landing on /login. */
  async logout(): Promise<void> {
    await test.step('Log out', async () => {
      await this.click(this.logoutRailIcon);
      await this.click(this.logoutConfirmButton);
      await expect(this.page).toHaveURL(/\/login/i);
    });
  }
}
