/**
 * Katchup module — navigation and dynamic feed behaviour.
 *
 * Runs authenticated via the default shared-storageState fixture.
 *
 * Katchup is KPost's **chats & contacts** module ("Open chats and contacts" in
 * the launcher), not a social feed. Inspected twice against the live app, the
 * whole module exposes 14 interactive elements: header controls, the
 * Recents/Contacts tabs, one conversation search, and the KNews cards. There is
 * no post composer and no feed of posts.
 *
 * So the "create and verify a dynamic post" journey is covered in the two ways
 * the product actually supports:
 *   1. Dynamic search — a per-run unique term is typed into the conversation
 *      search and the feed's response ("No results found") is verified, then
 *      verified to clear. This exercises the real dynamic filtering path and
 *      passes today.
 *   2. Post a message into a conversation — the true equivalent of "create a
 *      post, verify it appears". This account has "My Contacts • 0", so there is
 *      no thread to open; the test guards on that and reports why it skipped
 *      rather than asserting against UI nobody has seen.
 */
import { test, expect } from '../../src/fixtures/fixtures';
import { faker } from '@faker-js/faker';
import { KNOWN_APP_DEFECTS, noteKnownDefect } from '../../src/utils/known-defects';

/** Per-run unique text so parallel workers can never collide. */
function uniqueTerm(): string {
  return `qa-${Date.now()}-${faker.string.alphanumeric(6)}`;
}

test.describe('Katchup navigation @smoke @katchup', () => {
  test('opening Katchup from Quick Access loads the module', async ({
    homePage,
    katchupPage,
    page,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await katchupPage.openFromLauncher();

    await expect(page).toHaveURL(/\/katchup/i);
    await katchupPage.expectLoaded();
    await katchupPage.expectTabsAvailable();
  });

  test('Katchup is also reachable from the sidebar icon rail', async ({
    homePage,
    katchupPage,
  }) => {
    await homePage.open();
    await homePage.expectLoaded();

    await katchupPage.openFromRail();

    await katchupPage.expectLoaded();
    await katchupPage.expectPaneTitle();
  });
});

test.describe('Katchup feed @regression @katchup', () => {
  test('searching a unique term updates the feed and clears again', async ({
    homePage,
    katchupPage,
  }) => {
    const term = uniqueTerm();
    // Intermittent: passes when the contacts backend responds, fails when it 500s.
    const defect = noteKnownDefect(KNOWN_APP_DEFECTS.KATCHUP_CONTACTS_500_UNHANDLED);

    await homePage.open();
    await katchupPage.openFromLauncher();
    await katchupPage.expectLoaded();

    // The feed reports its state before we filter it.
    await katchupPage.expectUnopenedMessagesBadge();

    // Dynamic content: a term generated for this run alone can never match.
    await katchupPage.searchConversations(term);

    // Check the app did not blow up first, so this fails with the app's own
    // error rather than a bare "element(s) not found".
    await katchupPage.expectNoAppError();
    await katchupPage.expectNoSearchResults(defect);

    // ...and the feed recovers when the filter is removed.
    await katchupPage.clearConversationSearch();
    await katchupPage.expectSearchResultsCleared();
  });

  test('the Recents and Contacts tabs both render the conversation feed', async ({
    homePage,
    katchupPage,
  }) => {
    // Intermittent for the same reason as the search test above.
    noteKnownDefect(KNOWN_APP_DEFECTS.KATCHUP_CONTACTS_500_UNHANDLED);

    await homePage.open();
    await katchupPage.openFromLauncher();
    await katchupPage.expectLoaded();

    await katchupPage.openContactsTab();
    await katchupPage.expectContactsSummary();

    await katchupPage.openRecentsTab();
    await katchupPage.expectUnopenedMessagesBadge();
  });

  test('a message posted to a conversation appears in the thread', async ({
    homePage,
    katchupPage,
  }) => {
    await homePage.open();
    await katchupPage.openFromLauncher();
    await katchupPage.expectLoaded();

    test.skip(
      !(await katchupPage.hasConversations()),
      'This account has no Katchup conversations (My Contacts • 0), so there is no thread to post into. ' +
        'Seed a contact for the test user to enable this journey.',
    );

    const message = `Automated Katchup message ${uniqueTerm()}`;

    await katchupPage.openFirstConversation();
    await katchupPage.sendMessage(message);

    await katchupPage.expectMessageVisible(message);
  });
});
