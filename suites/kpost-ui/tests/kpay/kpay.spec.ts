/**
 * KPay module — the not-yet-implemented contract.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * Probed live on 2026-08-13: the rail advertises KPay (`icon-KP_12-KWallet`,
 * plus a "KPay" label when the rail expands), but the launcher does not offer
 * it, clicking the rail entry navigates nowhere, and `/kpay`, `/kwallet`, and
 * `/pay` all render the 404 page. There is no module to open — which means
 * there is also **no balance view, no transaction history, and no empty state
 * to verify**; asserting on any of those would be asserting on invented UI,
 * which is exactly how the blog-era specs went wrong.
 *
 * What these tests pin down instead is the current contract, annotated with
 * KPOST-KPAY-001 (a visible nav entry that silently does nothing is broken UX
 * from the user's chair, whatever the roadmap says). They are built to FAIL
 * the day KPay ships — that failure is the signal to rebuild `KPayPage` from
 * the real DOM, exactly as the KMail composer was.
 */
import { test } from '../../src/fixtures/fixtures';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

test.describe('KPay contract @smoke @kpay', () => {
  test('the rail advertises KPay but the launcher does not offer it', async ({
    homePage,
    kpayPage,
  }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.KPAY_DEAD_NAV_ENTRY);

    await homePage.open();
    await homePage.expectLoaded();

    await kpayPage.expectRailEntryVisible();
    await kpayPage.expectNotOfferedInLauncher();
  });

  test('clicking the KPay rail entry navigates nowhere', async ({ homePage, kpayPage }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.KPAY_DEAD_NAV_ENTRY);

    await homePage.open();
    await homePage.expectLoaded();

    await kpayPage.expectRailEntryIsDead();
  });

  test('the KPay route is not implemented and 404s', async ({ homePage, kpayPage }) => {
    noteKnownDefect(KNOWN_APP_DEFECTS.KPAY_DEAD_NAV_ENTRY);

    await homePage.open();
    await homePage.expectLoaded();

    await kpayPage.expectRouteNotImplemented();
  });
});
