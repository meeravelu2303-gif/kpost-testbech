/**
 * BasePage — the foundation every page object extends.
 *
 * It wraps Playwright's already-excellent auto-waiting with an extra layer of
 * intent-revealing, resilient methods and consistent logging. The goal is that
 * page objects read like a description of user behavior, and that flaky failure
 * modes (stale nodes, mid-animation clicks, re-render races) are handled in one
 * place rather than copy-pasted across the suite.
 *
 * Guiding principles:
 *  - Never use hard-coded sleeps. Every wait is condition-based.
 *  - Prefer Playwright's web-first assertions (auto-retrying) over manual polls.
 *  - Keep methods small, composable, and typed against Locator, not strings,
 *    so callers build robust accessible locators in the page object itself.
 */
import { type Locator, type Page, expect, type Response } from '@playwright/test';
import { logger } from '../utils/logger';
import { waitForAppReady, assertNoAppErrorOverlay } from '../utils/react-helpers';

export abstract class BasePage {
  /** Sub-classes set this so `open()` and `isLoaded()` know where they live. */
  protected abstract readonly path: string;

  constructor(protected readonly page: Page) {}

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Navigate to this page's `path` (relative to baseURL) and wait for React. */
  async open(): Promise<void> {
    logger.info(`Navigating to ${this.path}`);
    await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(this.page);
  }

  /** Current URL — handy for assertions and debugging. */
  url(): string {
    return this.page.url();
  }

  /** Assert the browser landed on the expected path (supports regex). */
  async expectPath(pathOrPattern: string | RegExp): Promise<void> {
    await expect(this.page).toHaveURL(
      typeof pathOrPattern === 'string' ? new RegExp(`${escapeRegExp(pathOrPattern)}`) : pathOrPattern,
    );
  }

  // ---------------------------------------------------------------------------
  // Resilient interactions
  // ---------------------------------------------------------------------------

  /**
   * Safe click. Waits for the element to be visible and stable (not animating)
   * and enabled before clicking. Playwright already does actionability checks;
   * this adds a scroll-into-view and an explicit visible wait so error messages
   * are clearer.
   *
   * There is deliberately no "wait for navigation" option: KPost never reaches
   * `networkidle` (see `waitForAppReady`). To couple a click to its request,
   * use `clickAndWaitForResponse`; to couple it to a route change, assert with
   * `expectPath`.
   */
  async click(locator: Locator): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    try {
      await locator.click();
    } catch (error) {
      // A failed click is the usual way an app error surfaces: the dev-server
      // overlay covers the page and "intercepts pointer events", while reads
      // keep working. Re-raise the real error if that is what happened;
      // otherwise the original failure stands.
      await assertNoAppErrorOverlay(this.page);
      throw error;
    }
  }

  /** Double click with the same actionability guarantees as `click`. */
  async doubleClick(locator: Locator): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    await locator.dblclick();
  }

  /**
   * Resilient fill for standard inputs. Clears first, then fills, then verifies
   * the committed value via a web-first assertion so controlled inputs that
   * revert on re-render fail loudly instead of silently dropping characters.
   */
  async fill(locator: Locator, value: string): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.fill('');
    await locator.fill(value);
    await expect(locator).toHaveValue(value);
  }

  /** Type text key-by-key (for inputs with masking / key handlers). */
  async type(locator: Locator, value: string, delayMs = 30): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.click();
    await locator.pressSequentially(value, { delay: delayMs });
  }

  /** Select an option from a native <select> by label. */
  async selectByLabel(locator: Locator, label: string): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.selectOption({ label });
  }

  /** Check/uncheck a checkbox or radio idempotently. */
  async setChecked(locator: Locator, checked: boolean): Promise<void> {
    await locator.waitFor({ state: 'visible' });
    await locator.setChecked(checked);
  }

  // ---------------------------------------------------------------------------
  // Reads & state queries
  // ---------------------------------------------------------------------------

  /** Trimmed visible text of an element. */
  async getText(locator: Locator): Promise<string> {
    await locator.waitFor({ state: 'visible' });
    return (await locator.textContent())?.trim() ?? '';
  }

  /** Non-throwing visibility check — safe for conditional flows. */
  async isVisible(locator: Locator, timeout = 5_000): Promise<boolean> {
    return locator
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
  }

  /** Wait until an element is visible (throws on timeout). */
  async waitForVisible(locator: Locator, timeout = 15_000): Promise<void> {
    await locator.waitFor({ state: 'visible', timeout });
  }

  /** Wait until an element is removed/hidden (e.g. a loading spinner). */
  async waitForHidden(locator: Locator, timeout = 15_000): Promise<void> {
    await locator.waitFor({ state: 'hidden', timeout });
  }

  // ---------------------------------------------------------------------------
  // Dynamic assertions (thin, self-documenting wrappers over web-first expect)
  // ---------------------------------------------------------------------------

  async expectVisible(locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
  }

  async expectHidden(locator: Locator): Promise<void> {
    await expect(locator).toBeHidden();
  }

  async expectText(locator: Locator, expected: string | RegExp): Promise<void> {
    await expect(locator).toContainText(expected);
  }

  async expectValue(locator: Locator, expected: string | RegExp): Promise<void> {
    await expect(locator).toHaveValue(expected);
  }

  async expectEnabled(locator: Locator): Promise<void> {
    await expect(locator).toBeEnabled();
  }

  async expectDisabled(locator: Locator): Promise<void> {
    await expect(locator).toBeDisabled();
  }

  async expectCount(locator: Locator, count: number): Promise<void> {
    await expect(locator).toHaveCount(count);
  }

  // ---------------------------------------------------------------------------
  // Network coordination
  // ---------------------------------------------------------------------------

  /**
   * Trigger an action and wait for the matching API response in one race-free
   * step — the canonical way to avoid "clicked before the request fired" flake.
   */
  async clickAndWaitForResponse(
    locator: Locator,
    urlPattern: string | RegExp,
    predicate: (res: Response) => boolean = (res) => res.ok(),
    options: { timeout?: number } = {},
  ): Promise<Response> {
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (res) => matchesUrl(res.url(), urlPattern) && predicate(res),
        // Default to 30s: the KPost backends routinely take longer than the
        // 15s actionTimeout that would otherwise apply to this wait.
        { timeout: options.timeout ?? 30_000 },
      ),
      this.click(locator),
    ]);
    return response;
  }

  /** Take a named screenshot attached to the report (debugging aid). */
  async screenshot(name: string): Promise<Buffer> {
    return this.page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesUrl(url: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
}
