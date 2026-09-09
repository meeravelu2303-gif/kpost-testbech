/**
 * KMailPage — the KPost mail module (route: `/kmail`).
 *
 * ── Verification status (re-probed against the live app on 2026-08-12) ──
 * The 401 force-logout that previously made this module unreachable is GONE.
 * KMail now loads cleanly and makes **no calls at all** to
 * `kmail5.kpostindia.com`; its data now comes from `localhost:8989`. See
 * `TEST-BENCH-REPORT.md` for the evidence that this was never a token
 * propagation problem on our side.
 *
 * VERIFIED · Offered by Quick Access as `button "K KMail Open inbox and mails Open"`.
 * VERIFIED · Launching it routes to `/kmail` and renders the pane title "KMail".
 * VERIFIED · Also reachable from the icon rail (`div.icon-KP_03-KMail`).
 * VERIFIED · A `tablist` of THREE tabs: `Recents` (default), `Contacts`, and
 *            `Status of Mails` — one more than Katchup's two.
 * VERIFIED · An unopened counter rendered as "<n> Unopened Mails" (note: Mails,
 *            where Katchup says Messages).
 * VERIFIED · Two `searchbox "Search"` controls — scope with `.first()`.
 * VERIFIED · Empty states: "No Data Found", "No Frequently Accessed Mail",
 *            "My Contacts • 0", "No Contacts", "No Groups", plus Unknown /
 *            Other Domain Contact sections.
 * VERIFIED · A Status-of-Mail summary: Draft Mails, Sent Mail, "Not Opened • 0",
 *            "Reply Not Received • 0", "Reply Not Sent • 0".
 *
 * ── Where composing actually lives (verified 2026-08-12, second pass) ──
 * KMail has **no compose button**. Composing is the *Write Mail* module
 * (`button "W Write Mail Compose a new mail Open"` in the launcher), which
 * routes to `/writemail` and renders the composer alongside the KMail pane:
 *   · To         → `input[name="to"]`               (no label — a11y gap)
 *   · Salutation → `textbox "Select Salutation"` + `textbox "Name"`
 *   · Subject    → `input.toInput`                  (no label — a11y gap)
 *   · Body       → a Quill editor, `div.ql-editor`  (contenteditable)
 *   · Send       → `button.post_button_size`        (icon-only, NO accessible
 *                  name — the same accessibility defect as the icon rail)
 * Send fires `POST {host}/v2/sentMail/postMail/` with the composed payload.
 *
 * Observed server behaviour: sending **to yourself is rejected** — 400
 * `"Duplicate IDs are present in ToAddress, CopyList, or ConfidentialCopyList"`
 * (the app auto-appends the sender), and the UI toasts the generic alert
 * "Some Error Occurred!". A *successful* send has therefore never been
 * observed with the single configured account; the success-path assertions
 * are conventional until `MAIL_RECIPIENT` points at a second KPOST account.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';
import { KNOWN_APP_DEFECTS } from '../utils/known-defects';

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

export class KMailPage extends AppShellPage {
  protected readonly path = '/kmail';

  // ---- Verified ----
  private readonly paneTitle: Locator;
  private readonly recentsTab: Locator;
  private readonly contactsTab: Locator;
  private readonly statusOfMailsTab: Locator;
  private readonly mailSearch: Locator;
  private readonly unopenedMails: Locator;
  private readonly noDataState: Locator;
  private readonly myContactsSummary: Locator;
  private readonly draftMails: Locator;
  private readonly sentMail: Locator;

  // ---- Unverified: no mail data on this account ----
  private readonly mailList: Locator;
  private readonly mailListItems: Locator;


  constructor(page: Page) {
    super(page);
    this.paneTitle = page.getByText(/^\s*KMail\s*$/).first();
    this.recentsTab = page.getByRole('tab', { name: /recents/i });
    this.contactsTab = page.getByRole('tab', { name: /^\s*contacts\s*$/i });
    this.statusOfMailsTab = page.getByRole('tab', { name: /status of mails/i });
    this.mailSearch = page.getByRole('searchbox', { name: /search/i }).first();
    this.unopenedMails = page.getByText(/unopened mails/i);
    this.noDataState = page.getByText(/no data found/i);
    this.myContactsSummary = page.getByText(/my contacts/i);
    this.draftMails = page.getByText(/draft mails/i);
    this.sentMail = page.getByText(/sent mail/i);

    this.mailList = page.getByRole('list', { name: /mails?|inbox|messages/i }).first();
    this.mailListItems = this.mailList.getByRole('listitem');
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Open KMail through the Quick Access launcher (the accessible nav path). */
  async openFromLauncher(): Promise<void> {
    await test.step('Open KMail from Quick Access', async () => {
      await this.launchModule('KMail');
      await this.expectOnKMail();
    });
  }

  /** Open KMail from the left icon rail (`div.icon-KP_03-KMail`). */
  async openFromRail(): Promise<void> {
    await test.step('Open KMail from the icon rail', async () => {
      await this.openModuleFromRail('KMail');
      await this.expectOnKMail();
    });
  }

  /**
   * Assert we arrived at `/kmail` — and name the reason when we did not.
   *
   * Opening KMail currently signs the user out (KPOST-KMAIL-003), so the honest
   * failure is "the app logged you out", not "the URL did not match a pattern".
   * `expectModuleRoute` asserts first and only inspects the URL once that has
   * failed, because the sign-out redirect is usually still in flight at the
   * moment the navigation returns — checking up front misses it.
   */
  private async expectOnKMail(): Promise<void> {
    await this.expectModuleRoute(/\/kmail/i, KNOWN_APP_DEFECTS.KMAIL_OPENING_SIGNS_USER_OUT);
  }

  /** Assert the module loaded and the session survived (this is the assertion
   *  that used to catch the 401 force-logout). */
  async expectLoaded(): Promise<void> {
    await test.step('Expect the KMail module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await this.expectPath(/\/kmail/i);
      await this.expectShellVisible();
      await expect(this.recentsTab).toBeVisible();
    });
  }

  async expectPaneTitle(): Promise<void> {
    await test.step('Expect the KMail pane title', async () => {
      await expect(this.paneTitle).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  async expectTabsAvailable(): Promise<void> {
    await test.step('Expect the Recents, Contacts and Status of Mails tabs', async () => {
      await expect(this.recentsTab).toBeVisible();
      await expect(this.contactsTab).toBeVisible();
      await expect(this.statusOfMailsTab).toBeVisible();
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

  async openStatusOfMailsTab(): Promise<void> {
    await test.step('Open the Status of Mails tab', async () => {
      await this.click(this.statusOfMailsTab);
      await expect(this.statusOfMailsTab).toHaveAttribute('aria-selected', 'true');
    });
  }

  // ---------------------------------------------------------------------------
  // Inbox / Recents
  // ---------------------------------------------------------------------------

  async expectUnopenedMailsBadge(): Promise<void> {
    await test.step('Expect the unopened-mail counter', async () => {
      await expect(this.unopenedMails).toBeVisible();
    });
  }

  /** The number in "<n> Unopened Mails", or 0 when it cannot be read. */
  async unopenedMailCount(): Promise<number> {
    return test.step('Read the unopened-mail count', async () => {
      const text = await this.getText(this.unopenedMails);
      const match = /(\d+)/.exec(text);
      return match ? Number(match[1]) : 0;
    });
  }

  async expectEmptyMailbox(): Promise<void> {
    await test.step('Expect the "No Data Found" empty-mailbox state', async () => {
      await expect(this.noDataState).toBeVisible();
    });
  }

  async expectStatusOfMailSummary(): Promise<void> {
    await test.step('Expect the Status of Mail summary', async () => {
      await expect(this.draftMails).toBeVisible();
      await expect(this.sentMail).toBeVisible();
    });
  }

  /** How many mails are listed. Returns 0 when the list never renders. */
  async inboxCount(): Promise<number> {
    return test.step('Count inbox items', async () => {
      if (!(await this.isVisible(this.mailList, 5_000))) return 0;
      return this.mailListItems.count();
    });
  }

  async openMailBySubject(subject: string | RegExp): Promise<void> {
    await test.step(`Open the mail "${subject}"`, async () => {
      await this.click(this.mailListItems.filter({ hasText: subject }).first());
    });
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async searchMail(term: string): Promise<void> {
    await test.step(`Search mail for "${term}"`, async () => {
      await this.fill(this.mailSearch, term);
    });
  }

  async clearMailSearch(): Promise<void> {
    await test.step('Clear the mail search', async () => {
      await this.fill(this.mailSearch, '');
    });
  }

  /**
   * Assert the mailbox reports "no mails".
   *
   * Note KMail does NOT distinguish "your search matched nothing" from "your
   * mailbox is empty" — both render the same "No Data Found". (Katchup, by
   * contrast, has a distinct "No results found".) So this cannot be used to
   * prove a search actually filtered; it only proves the pane is still showing
   * a coherent empty state. Verified 2026-08-12 by searching a term that cannot
   * match and diffing the DOM against the unfiltered pane.
   */
  async expectNoMailsFound(): Promise<void> {
    await test.step('Expect the "No Data Found" mailbox state', async () => {
      await expect(this.noDataState).toBeVisible();
    });
  }

  /** The text currently in the mailbox search box. */
  async currentSearchTerm(): Promise<string> {
    return test.step('Read the mailbox search term', async () => this.mailSearch.inputValue());
  }

  async expectContactsSummary(): Promise<void> {
    await test.step('Expect the My Contacts summary', async () => {
      await expect(this.myContactsSummary).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Sent folder — composing itself lives in `WriteMailPage` (/writemail)
  // ---------------------------------------------------------------------------

  /**
   * Assert a sent mail is listed under Status of Mails → Sent Mail.
   *
   * UNVERIFIED — a successful send has never been observed (it needs
   * `MAIL_RECIPIENT`); adjust against the real DOM on first use. Whether the
   * composer reported an error is `WriteMailPage.expectNoSendError()`'s
   * business, not this method's: the Sent folder is KMail, the alert is the
   * composer, and a spec that cares about both should say so in both places.
   */
  async expectMailInSentFolder(subject: string): Promise<void> {
    await test.step(`Expect "${subject}" in the Sent folder`, async () => {
      await this.openStatusOfMailsTab();
      await this.click(this.sentMail.first());
      await expect(this.page.getByText(subject).first()).toBeVisible();
    });
  }
}
