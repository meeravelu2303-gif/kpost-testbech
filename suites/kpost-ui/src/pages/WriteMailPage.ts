import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';
import type { MailDraft } from './KMailPage';
import { KNOWN_APP_DEFECTS } from '../utils/known-defects';

/**
 * "Write Mail" — the KPost mail composer.
 *
 * Composing is its own module, not part of KMail: KMail has no composer at all.
 * `/writemail` renders the form alongside the KMail pane, which is why this page
 * object still has to cope with KMail's dev-error overlay (KPOST-KMAIL-001).
 *
 * ## Verification status
 *
 * Verified live on 2026-08-12. Every locator and behaviour below was observed
 * against the running app, with two exceptions called out at their methods:
 * a *successful* send has never been seen (it needs `MAIL_RECIPIENT`), and the
 * Sent-folder assertion that follows one lives on `KMailPage`.
 *
 * ## Why this class is full of CSS selectors
 *
 * The composer ships **no labels and no accessible names**: To is
 * `input[name="to"]`, Subject is `input.toInput`, the body is a Quill
 * `div.ql-editor`, and Send is an icon-only `button.post_button_size`. There is
 * no role, label, placeholder or text to target. Together with the icon rail on
 * `AppShellPage` this is one of the only two places in the codebase where CSS is
 * sanctioned — and, like the rail, it is a product accessibility defect worth
 * raising rather than a locator style choice. `tests/a11y/` exists partly to
 * pin that.
 *
 * ## The To field's type-ahead
 *
 * The recipient input normalises on blur — a full native address is rewritten to
 * its bare KPOST ID (`qag37966sa@kpostindia.com` → `qag37966sa`) while the app
 * still submits the *full* address in the postMail payload, verified by
 * capturing the request. Never press Enter to "commit" the recipient: Enter can
 * fire the rewrite mid-type-ahead and drop it entirely, after which Send
 * silently refuses to fire.
 */
export class WriteMailPage extends AppShellPage {
  protected readonly path = '/writemail';

  // ---- Verified live; CSS by necessity, the app ships no accessible names ----
  private readonly composeTo: Locator;
  private readonly composeSubject: Locator;
  private readonly composeBody: Locator;
  private readonly sendButton: Locator;
  private readonly sendErrorAlert: Locator;

  constructor(page: Page) {
    super(page);
    this.composeTo = page.locator('input[name="to"]');
    this.composeSubject = page.locator('input.toInput');
    this.composeBody = page.locator('.ql-editor').first();
    this.sendButton = page.locator('button.post_button_size').first();
    this.sendErrorAlert = page.getByRole('alert').filter({ hasText: /some error occurred/i });
  }

  /** Launch the composer from Quick Access and wait for its form to render. */
  async openFromLauncher(): Promise<void> {
    await test.step('Open the Write Mail composer', async () => {
      await this.launchModule('Write Mail');
      // The composer renders alongside the KMail pane, so it inherits KMail's
      // sign-out (KPOST-KMAIL-003) — verified in the 2026-08-28 run, where this
      // navigation landed on /login. Name that cause instead of reporting a bare
      // "toHaveURL failed" with no defect attached.
      await this.expectModuleRoute(/\/writemail/i, KNOWN_APP_DEFECTS.KMAIL_OPENING_SIGNS_USER_OUT);
      // KMail's pane loads alongside the composer and still raises
      // KPOST-KMAIL-001; clear its dev-only overlay so the form is clickable.
      await this.dismissDevErrorOverlay();
      await expect(this.composeSubject).toBeVisible();
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the Write Mail composer to be loaded', async () => {
      await expect(this.composeTo).toBeVisible();
      await expect(this.composeSubject).toBeVisible();
      await expect(this.composeBody).toBeVisible();
    });
  }

  /** Fill recipient, subject, and body. */
  async fillDraft(draft: MailDraft): Promise<void> {
    await test.step(`Fill the draft "${draft.subject}"`, async () => {
      await this.fill(this.composeTo, draft.to);
      // Do NOT press Enter here — see the class doc on the type-ahead.
      await this.fill(this.composeSubject, draft.subject);
      await this.composeBody.click();
      await this.composeBody.fill(draft.body);
      await expect(this.composeBody).toContainText(draft.body);
      // Guard: the field must still identify the recipient — either the full
      // address or its normalised KPOST ID. Anything else means the type-ahead
      // ate the recipient and send would silently refuse to fire.
      const local = draft.to.split('@')[0];
      await expect(this.composeTo).toHaveValue(
        new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(@.+)?$`),
      );
    });
  }

  /**
   * Click Send and wait for the `postMail` API response in one race-free step.
   * Returns the server's verdict so the caller can assert either outcome —
   * acceptance is not assumed, because the backend rejects self-sends.
   */
  async send(): Promise<{ status: number; message: string }> {
    return test.step('Send the mail and await the postMail response', async () => {
      // KPOST-KMAIL-001 refires on the KMail pane's refresh cycle, so the
      // overlay dismissed by openFromLauncher() can be back by now — and unlike
      // fills, clicks are hit-tested and get intercepted. Clear it again
      // immediately before the one click this flow depends on.
      await this.dismissDevErrorOverlay();
      const response = await this.clickAndWaitForResponse(
        this.sendButton,
        /\/sentMail\/postMail/i,
        () => true, // capture the response whatever its status
      );
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      return { status: response.status(), message: body.message ?? '' };
    });
  }

  /** Compose and send in one call, returning the server's verdict. */
  async composeAndSend(draft: MailDraft): Promise<{ status: number; message: string }> {
    return test.step(`Compose and send "${draft.subject}"`, async () => {
      await this.openFromLauncher();
      await this.fillDraft(draft);
      return this.send();
    });
  }

  /** Assert the UI surfaced the send-failure alert ("Some Error Occurred!"). */
  async expectSendErrorAlert(): Promise<void> {
    await test.step('Expect the send-failure alert', async () => {
      await expect(this.sendErrorAlert).toBeVisible();
    });
  }

  /**
   * Assert the composer reported no failure.
   *
   * UNVERIFIED: a successful send has never been observed (it needs
   * `MAIL_RECIPIENT`). Confirming the mail actually landed is `KMailPage`'s job
   * — the Sent folder belongs to KMail, not to the composer.
   */
  async expectNoSendError(): Promise<void> {
    await test.step('Expect no send-failure alert', async () => {
      await expect(this.sendErrorAlert).toBeHidden();
    });
  }
}
