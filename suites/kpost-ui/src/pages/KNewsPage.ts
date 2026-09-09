/**
 * KNewsPage — the KPost news module (route: `/knews`).
 *
 * ── Verification status (probed against the live app on 2026-08-13) ──
 * VERIFIED · Offered by Quick Access as `button "K KNews Open news module Open"`;
 *            also reachable from the icon rail (`div.icon-KP_08-KNews`).
 * VERIFIED · A real `banner` landmark: "KNews" title, a `textbox "Search
 *            headlines…"`, today's date, and a refresh button (name "⟳").
 * VERIFIED · A `region "Breaking news ticker"` of real links.
 * VERIFIED · A `complementary` landmark (the category sidebar) of real buttons:
 *            "📰 All News" / "🌍 World", national publishers (TOI, The Hindu,
 *            Ind. Express, NDTV), regional languages (Tamil … Bengali),
 *            international outlets (BBC … Guardian), and topic buttons
 *            (🏛 Politics, 💻 Technology, 🔬 Science, 🏥 Health, 💼 Business,
 *            🏏 Sports, 🌿 Environment, 🎬 Entertainment, ✍️ Opinion, 🌍 World).
 *            Every category name carries an emoji prefix, so category locators
 *            match on the text, not exact strings.
 * VERIFIED · Feed cards render inside `main` as real links with an href, an
 *            image, and a heading. Sub-filter chips render above them.
 *
 * ── Two things worth knowing before editing tests ──
 * 1. There is no "Top Stories" category in this build — the default/broadest
 *    feed is "All News". The spec uses the categories that exist.
 * 2. Content comes from third-party RSS bridges (corsproxy.io, rss2json.com)
 *    that intermittently answer 503/422/429. The module has been observed
 *    rendering cards regardless (multiple sources), but card-count assertions
 *    stay deliberately modest — a floor of one, not a census.
 *
 * Click-through: cards are external links (news sites). The click-through
 * check asserts each sampled card is a genuine link with a non-empty href
 * rather than navigating the browser off to a third-party site mid-suite.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

/** Category buttons verified in the sidebar (matched as text, emoji ignored). */
export const NEWS_CATEGORIES = [
  'All News',
  'World',
  'Politics',
  'Technology',
  'Science',
  'Health',
  'Business',
  'Sports',
  'Environment',
  'Entertainment',
  'Opinion',
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export class KNewsPage extends AppShellPage {
  protected readonly path = '/knews';

  private readonly newsBanner: Locator;
  private readonly headlineSearch: Locator;
  private readonly refreshButton: Locator;
  private readonly breakingTicker: Locator;
  private readonly tickerLinks: Locator;
  private readonly categorySidebar: Locator;
  private readonly feed: Locator;
  private readonly newsCards: Locator;

  constructor(page: Page) {
    super(page);
    this.newsBanner = page.getByRole('banner');
    this.headlineSearch = page.getByPlaceholder(/search headlines/i);
    this.refreshButton = this.newsBanner.getByRole('button', { name: '⟳' });
    this.breakingTicker = page.getByRole('region', { name: /breaking news ticker/i });
    this.tickerLinks = this.breakingTicker.getByRole('link');
    this.categorySidebar = page.getByRole('complementary');
    this.feed = page.getByRole('main');
    this.newsCards = this.feed.getByRole('link');
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Open KNews through the Quick Access launcher (the accessible nav path). */
  async openFromLauncher(): Promise<void> {
    await test.step('Open KNews from Quick Access', async () => {
      await this.launchModule('KNews');
      await this.expectPath(/\/knews/i);
    });
  }

  /** Open KNews from the left icon rail (`div.icon-KP_08-KNews`). */
  async openFromRail(): Promise<void> {
    await test.step('Open KNews from the icon rail', async () => {
      await this.openModuleFromRail('KNews');
      await this.expectPath(/\/knews/i);
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the KNews module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await this.expectPath(/\/knews/i);
      await this.expectShellVisible();
      // The banner and the category sidebar are client-rendered and do not
      // depend on the flaky third-party news bridges.
      await expect(this.headlineSearch).toBeVisible();
      await expect(this.categorySidebar).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  /** A category button in the sidebar. Names carry emoji, so match on text. */
  private category(name: NewsCategory | string): Locator {
    return this.categorySidebar.getByRole('button', { name: new RegExp(name, 'i') }).first();
  }

  async expectCategoryAvailable(name: NewsCategory | string): Promise<void> {
    await test.step(`Expect the "${name}" category`, async () => {
      await expect(this.category(name)).toBeVisible();
    });
  }

  /** Assert every verified category is offered. */
  async expectCategoriesAvailable(): Promise<void> {
    await test.step('Expect the verified news categories', async () => {
      for (const name of NEWS_CATEGORIES) {
        await expect(this.category(name)).toBeVisible();
      }
    });
  }

  /** Select a category and let the feed re-render. */
  async openCategory(name: NewsCategory | string): Promise<void> {
    await test.step(`Open the "${name}" news category`, async () => {
      await this.click(this.category(name));
      await this.expectNoAppError();
    });
  }

  // ---------------------------------------------------------------------------
  // Feed & ticker
  // ---------------------------------------------------------------------------

  /** How many news cards are currently rendered in the feed. */
  async cardCount(): Promise<number> {
    return test.step('Count news cards', async () => this.newsCards.count());
  }

  /** Assert the feed rendered at least `minimum` cards (a floor, not a census —
   *  the card supply comes from flaky third-party RSS bridges). */
  async expectFeedHasCards(minimum = 1): Promise<void> {
    await test.step(`Expect at least ${minimum} news card(s)`, async () => {
      await expect(this.newsCards.first()).toBeVisible({ timeout: 30_000 });
      expect(await this.newsCards.count()).toBeGreaterThanOrEqual(minimum);
    });
  }

  /**
   * Assert the first `sample` cards support click-through: each is a real link
   * with a non-empty href. Deliberately does not click one — cards point at
   * external news sites, and navigating there is not this suite's business.
   */
  async expectCardsClickable(sample = 3): Promise<void> {
    await test.step(`Expect the first ${sample} cards to be real links`, async () => {
      const count = Math.min(sample, await this.newsCards.count());
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        // `/.+/` is the web-first spelling of the previous `toBeTruthy()` on the
        // attribute: present and non-empty. Same assertion, now auto-retrying.
        await expect(this.newsCards.nth(i), `card ${i} has no href`).toHaveAttribute(
          'href',
          /.+/,
        );
      }
    });
  }

  /**
   * Whether the breaking-news ticker is currently rendered. Content-dependent:
   * the ticker only mounts when the third-party breaking feed returned data,
   * so it comes and goes between runs (verified both ways on 2026-08-13).
   */
  async hasBreakingTicker(): Promise<boolean> {
    return test.step('Check for the breaking-news ticker', async () =>
      this.isVisible(this.breakingTicker, 10_000));
  }

  async expectBreakingTicker(): Promise<void> {
    await test.step('Expect the breaking-news ticker', async () => {
      await expect(this.breakingTicker).toBeVisible();
      await expect(this.tickerLinks.first()).toBeVisible();
    });
  }

  /** Type into the headline search (client-side filter). */
  async searchHeadlines(term: string): Promise<void> {
    await test.step(`Search headlines for "${term}"`, async () => {
      await this.fill(this.headlineSearch, term);
    });
  }

  async refreshFeed(): Promise<void> {
    await test.step('Refresh the news feed', async () => {
      await this.click(this.refreshButton);
      await this.expectNoAppError();
    });
  }
}
