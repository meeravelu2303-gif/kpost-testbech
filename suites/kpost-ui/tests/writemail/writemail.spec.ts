/**
 * Write Mail — the compose → send journey.
 *
 * Composing is its own KPost module, not part of KMail: KMail has no composer.
 * These cases moved here from `tests/kmail/` when the composer got its own page
 * object; the assertions are unchanged, and the send path itself was verified
 * live on 2026-08-12.
 *
 * Runs authenticated via the default shared-storageState fixture.
 */
import { faker } from '@faker-js/faker';
import { env } from '../../src/config/env';
import { test, expect } from '../../src/fixtures/fixtures';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

test.describe('Write Mail compose & send @regression @writemail', () => {
  /**
   * The full compose → send → Sent-folder journey. Needs a SECOND KPost
   * account (`MAIL_RECIPIENT`): the backend rejects sending to yourself, so
   * with only the standard account configured there is no valid recipient and
   * this skips with the reason below. The self-send contract test that follows
   * keeps the whole mechanical path covered in every environment.
   */
  test('a sent mail is accepted and appears in the Sent folder', async ({
    homePage,
    writeMailPage,
    kmailPage,
  }) => {
    test.skip(
      !env.mail.recipient,
      'No MAIL_RECIPIENT configured. KPost rejects self-sends ("Duplicate IDs are present in ' +
        'ToAddress…"), so the success path needs a second KPOST account to address.',
    );
    test.skip(
      env.mail.recipient === env.users.standard.email,
      'MAIL_RECIPIENT is set to the SAME account as STANDARD_USER_EMAIL, which the backend ' +
        'is guaranteed to reject as a self-send ("Duplicate IDs are present in ToAddress…"). ' +
        'Point it at a different KPOST account to unlock this journey.',
    );

    const subject = `QA automated mail ${Date.now()}-${faker.string.alphanumeric(4)}`;

    await homePage.open();
    await homePage.expectLoaded();

    const verdict = await writeMailPage.composeAndSend({
      to: env.mail.recipient as string,
      subject,
      body: `Automated end-to-end mail sent by the KPost UI suite (${subject}).`,
    });

    expect(verdict.status, `postMail rejected: ${verdict.message}`).toBeLessThan(300);
    // Two page objects on purpose: the composer owns the send verdict, KMail
    // owns the Sent folder.
    await writeMailPage.expectNoSendError();
    await kmailPage.expectMailInSentFolder(subject);
  });

  /**
   * The self-send rejection contract, verified live on 2026-08-12: composing
   * to your own address exercises the entire real pipeline — form, type-ahead
   * normalisation, Quill body, the unlabelled send button, the postMail API
   * round-trip, and the UI's feedback.
   *
   * The stable invariant asserted is "a self-send is never accepted, and the
   * UI says so". The *specific* status is deliberately not pinned: the correct
   * verdict is 400 "Duplicate IDs are present in ToAddress, CopyList, or
   * ConfidentialCopyList", but the backend intermittently answers 401 for the
   * same valid session instead (KPOST-KMAIL-002, annotated below). If KPost
   * ever starts accepting self-sends, this fails and should be updated
   * deliberately, not patched around.
   */
  test('sending a mail to yourself is rejected with the documented error', async ({
    homePage,
    writeMailPage,
    standardUser,
  }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.KMAIL_POSTMAIL_INTERMITTENT_401);
    const subject = `QA automated mail ${Date.now()}-${faker.string.alphanumeric(4)}`;

    await homePage.open();
    await homePage.expectLoaded();

    const verdict = await writeMailPage.composeAndSend({
      to: standardUser.email,
      subject,
      body: `Automated self-send contract check (${subject}).`,
    });

    expect(verdict.status, `postMail verdict: ${verdict.status} ${verdict.message}`).toBeGreaterThanOrEqual(400);
    expect(verdict.status).toBeLessThan(500);
    await writeMailPage.expectSendErrorAlert();
  });

  /** The composer renders its three fields — the contract every send depends on. */
  test('the composer exposes recipient, subject and body fields', async ({
    homePage,
    writeMailPage,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await writeMailPage.openFromLauncher();
    await writeMailPage.expectLoaded();
  });
});
