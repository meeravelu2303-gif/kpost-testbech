/**
 * KatchupPage — the KPost chats & contacts module (route: `/katchup`).
 *
 * Extends `AppShellPage`, which extends `BasePage`, so it inherits both the
 * generic interaction layer and the KPost chrome (Quick Access launcher, icon
 * rail, logout).
 *
 * ── Verification status (probed against the live app on 2026-08-12) ──
 * VERIFIED · Offered by Quick Access as `button "K Katchup Open chats and contacts Open"`.
 * VERIFIED · Launching it routes to `https://localhost:3000/katchup`.
 * VERIFIED · Also reachable from the icon rail (`div.icon-KP_04-Katchup`).
 * VERIFIED · The pane is a `tablist` of `tab "Recents"` (default) and
 *            `tab "Contacts"`, with `aria-selected` tracking correctly.
 * VERIFIED · An unopened-message counter renders as "<n> Unopened Messages".
 * VERIFIED · Two `searchbox "Search"` controls render (conversation search and
 *            the Frequently Accessed search) — scope with `.first()`.
 * VERIFIED · Searching a term with no match renders "No results found"; with no
 *            conversations at all the pane shows "No Data found".
 * VERIFIED · Backend noise that does NOT break the module: 500s from
 *            `localhost:8989/v2/contacts/getImportedPhoneContacts/` and
 *            `.../myUnknownKatchupContacts/`. The pane still renders (unlike
 *            KMail, whose 401s force a logout).
 *
 * ── Two deliberate deviations from the original request ──
 * 1. **No `getByText('Katchup')` sidebar navigation.** The left rail is
 *    icon-only — no text, `aria-label`, or `title` — so that locator matches
 *    nothing on `/home` and cannot work. (The string "Katchup" appears only
 *    inside the Quick Access dialog and as the pane title *after* you arrive.)
 *    Navigation is therefore `openFromLauncher()` — the accessible path — and
 *    `openFromRail()`, which covers the real rail via its CSS class.
 * 2. **Katchup has no post composer and no feed of posts.** It was inspected
 *    twice: the entire module exposes 14 interactive elements — header controls,
 *    the two tabs, one search box, and the KNews cards. "Create a post / view
 *    feed updates / verify post visibility" has no counterpart here. The nearest
 *    real equivalent is a chat thread, so that is what the conversation methods
 *    at the bottom model. They are UNVERIFIED: this account has "My Contacts • 0",
 *    so no thread could be opened to observe the composer.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

export class KatchupPage extends AppShellPage {
  protected readonly path = '/katchup';

  // ---- Verified ----
  private readonly paneTitle: Locator;
  private readonly recentsTab: Locator;
  private readonly contactsTab: Locator;
  private readonly conversationSearch: Locator;
  private readonly unopenedMessages: Locator;
  private readonly noResultsState: Locator;
  private readonly noDataState: Locator;
  private readonly myContactsSummary: Locator;

  // ---- Unverified: needs an account with at least one contact ----
  private readonly conversationList: Locator;
  private readonly conversationItems: Locator;
  private readonly messageInput: Locator;
  private readonly sendButton: Locator;
  private readonly messageThread: Locator;

  constructor(page: Page) {
    super(page);
    this.paneTitle = page.getByText(/^\s*Katchup\s*$/).first();
    this.recentsTab = page.getByRole('tab', { name: /recents/i });
    this.contactsTab = page.getByRole('tab', { name: /contacts/i });
    // Two "Search" boxes render; the first is the conversation search.
    this.conversationSearch = page.getByRole('searchbox', { name: /search/i }).first();
    this.unopenedMessages = page.getByText(/unopened messages/i);
    this.noResultsState = page.getByText(/no results found/i);
    this.noDataState = page.getByText(/no data found/i);
    this.myContactsSummary = page.getByText(/my contacts/i);

    this.conversationList = page.getByRole('list', { name: /chats?|conversations?|recents/i }).first();
    this.conversationItems = this.conversationList.getByRole('listitem');
    this.messageInput = page.getByRole('textbox', { name: /type a message|message/i });
    this.sendButton = page.getByRole('button', { name: /^\s*send\s*$/i });
    this.messageThread = page.getByRole('log').or(page.getByTestId('message-thread')).first();
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Open Katchup through the Quick Access launcher (the accessible nav path). */
  async openFromLauncher(): Promise<void> {
    await test.step('Open Katchup from Quick Access', async () => {
      await this.launchModule('Katchup');
      await this.expectPath(/\/katchup/i);
    });
  }

  /**
   * Open Katchup from the left icon rail.
   *
   * This is the "sidebar" navigation. It targets `div.icon-KP_04-Katchup`
   * because the rail renders no text and no accessible name — see the class doc.
   */
  async openFromRail(): Promise<void> {
    await test.step('Open Katchup from the icon rail', async () => {
      await this.openModuleFromRail('Katchup');
      await this.expectPath(/\/katchup/i);
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the Katchup module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await this.expectPath(/\/katchup/i);
      await this.expectShellVisible();
      await expect(this.recentsTab).toBeVisible();
    });
  }

  async expectPaneTitle(): Promise<void> {
    await test.step('Expect the Katchup pane title', async () => {
      await expect(this.paneTitle).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Recents / Contacts tabs — "viewing feed updates"
  // ---------------------------------------------------------------------------

  async expectTabsAvailable(): Promise<void> {
    await test.step('Expect the Recents and Contacts tabs', async () => {
      await expect(this.recentsTab).toBeVisible();
      await expect(this.contactsTab).toBeVisible();
    });
  }

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

  /** Assert the unopened-message counter is present. */
  async expectUnopenedMessagesBadge(): Promise<void> {
    await test.step('Expect the unopened-messages counter', async () => {
      await expect(this.unopenedMessages).toBeVisible();
    });
  }

  /** The number in "<n> Unopened Messages", or 0 when it cannot be read. */
  async unopenedMessageCount(): Promise<number> {
    return test.step('Read the unopened-message count', async () => {
      const text = await this.getText(this.unopenedMessages);
      const match = /(\d+)/.exec(text);
      return match ? Number(match[1]) : 0;
    });
  }

  /** Assert the "no conversations yet" empty state ("No Data found"). */
  async expectEmptyState(): Promise<void> {
    await test.step('Expect the "No Data found" empty conversation state', async () => {
      await expect(this.noDataState).toBeVisible();
    });
  }

  async expectContactsSummary(): Promise<void> {
    await test.step('Expect the My Contacts summary', async () => {
      await expect(this.myContactsSummary).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Conversation search
  // ---------------------------------------------------------------------------

  async searchConversations(term: string): Promise<void> {
    await test.step(`Search Katchup for "${term}"`, async () => {
      await this.fill(this.conversationSearch, term);
    });
  }

  async clearConversationSearch(): Promise<void> {
    await test.step('Clear the Katchup search', async () => {
      await this.fill(this.conversationSearch, '');
    });
  }

  /**
   * Assert the search reported no matches ("No results found" — Katchup's
   * distinct filtered-empty state, unlike KMail which reuses "No Data Found").
   *
   * @param message Optional context surfaced on failure, e.g. a known-defect note.
   */
  async expectNoSearchResults(message?: string): Promise<void> {
    await test.step('Expect the "No results found" state', async () => {
      await expect(this.noResultsState, message).toBeVisible();
    });
  }

  async expectSearchResultsCleared(): Promise<void> {
    await test.step('Expect the no-results state to be gone', async () => {
      await expect(this.noResultsState).toBeHidden();
    });
  }

  // ---------------------------------------------------------------------------
  // Conversations — UNVERIFIED (needs an account with at least one contact)
  // ---------------------------------------------------------------------------

  /** How many conversations are listed. Returns 0 when the list never renders. */
  async conversationCount(): Promise<number> {
    return test.step('Count conversations', async () => {
      if (!(await this.isVisible(this.conversationList, 5_000))) return 0;
      return this.conversationItems.count();
    });
  }

  /** True when this account has at least one conversation to open. */
  async hasConversations(): Promise<boolean> {
    return test.step('Check for existing conversations', async () =>
      (await this.conversationCount()) > 0);
  }

  async openConversation(name: string | RegExp): Promise<void> {
    await test.step(`Open the conversation with "${name}"`, async () => {
      await this.click(this.conversationItems.filter({ hasText: name }).first());
      await expect(this.messageInput).toBeVisible();
    });
  }

  /** Open whichever conversation is listed first. */
  async openFirstConversation(): Promise<void> {
    await test.step('Open the first conversation', async () => {
      await this.click(this.conversationItems.first());
      await expect(this.messageInput).toBeVisible();
    });
  }

  /**
   * Post a message into the open conversation — the Katchup equivalent of
   * "creating a post".
   */
  async sendMessage(text: string): Promise<void> {
    await test.step(`Send the message "${text}"`, async () => {
      await this.fill(this.messageInput, text);
      await this.click(this.sendButton);
    });
  }

  /** Assert a message is visible in the open thread. */
  async expectMessageVisible(text: string | RegExp): Promise<void> {
    await test.step(`Expect the message "${text}" in the thread`, async () => {
      await expect(this.messageThread.getByText(text).first()).toBeVisible();
    });
  }

  /** Assert a message surfaced in the Recents list (the feed update). */
  async expectRecentsPreview(text: string | RegExp): Promise<void> {
    await test.step(`Expect "${text}" to appear in Recents`, async () => {
      await expect(this.conversationItems.filter({ hasText: text }).first()).toBeVisible();
    });
  }
}
