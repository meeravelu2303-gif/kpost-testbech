/**
 * SettingsPage — the KPost settings module (route: `/settings`).
 *
 * ── Verification status (probed against the live app on 2026-08-12) ──
 * VERIFIED · Offered by Quick Access as `button "S Settings Open account settings Open"`.
 * VERIFIED · Launching it routes to `/settings`; the icon rail
 *            (`div.icon-KP_15-Settings`) reaches it too.
 * VERIFIED · Six sections, and they are **plain clickable text, not ARIA tabs** —
 *            there is no `tablist` anywhere on the page:
 *              Profile Creation · Digital Card Settings · General Settings
 *              KMail Settings · KNews Settings · My Account
 *            "Profile Creation" and "Digital Card Settings" each match two text
 *            nodes, so every section locator is scoped with `.first()`.
 * VERIFIED · Selecting a section does **not** change the URL — it stays
 *            `/settings` — so section state is asserted by content, not route.
 * VERIFIED · The signed-in user's name renders in the pane ("Mandy Streich" for
 *            the current account) alongside an avatar and "Add Cover Photo".
 * VERIFIED · Per-section controls are sparse: Profile Creation has an avatar
 *            delete button; KNews Settings exposes a react-select plus a
 *            "Submit" button; Digital Card / General / KMail Settings and
 *            My Account (opened directly) add no controls of their own.
 *
 * ── On the requested Profile / Preferences / Security tabs ──
 * Those names do not exist in this build — the six above are what ships. There
 * are also **no preference toggles, switches, or theme controls anywhere in
 * Settings** (zero elements with a switch/checkbox/radio role). The only real
 * preference control in the product is the language `<select>` in the app-shell
 * header, which lives on `AppShellPage` because it is shell chrome rather than
 * part of this module.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

/** The settings sections this build actually ships. */
export type SettingsSection =
  | 'Profile Creation'
  | 'Digital Card Settings'
  | 'General Settings'
  | 'KMail Settings'
  | 'KNews Settings'
  | 'My Account';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'Profile Creation',
  'Digital Card Settings',
  'General Settings',
  'KMail Settings',
  'KNews Settings',
  'My Account',
] as const;

/** The identity KPost stores for the signed-in user (localStorage `Authuser`). */
export interface SessionIdentity {
  kpostID: string;
  firstName: string;
  lastName: string;
  userType?: string;
  mobileNumber?: string;
}

export class SettingsPage extends AppShellPage {
  protected readonly path = '/settings';

  private readonly addCoverPhoto: Locator;
  private readonly profileImage: Locator;
  private readonly submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.addCoverPhoto = page.getByText(/add cover photo/i).first();
    this.profileImage = page.getByRole('img', { name: /profile/i }).first();
    this.submitButton = page.getByRole('button', { name: /^\s*submit\s*$/i });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Open Settings through the Quick Access launcher (the accessible nav path). */
  async openFromLauncher(): Promise<void> {
    await test.step('Open Settings from Quick Access', async () => {
      await this.launchModule('Settings');
      await this.expectPath(/\/settings/i);
    });
  }

  /** Open Settings from the left icon rail (`div.icon-KP_15-Settings`). */
  async openFromRail(): Promise<void> {
    await test.step('Open Settings from the icon rail', async () => {
      await this.openModuleFromRail('Settings');
      await this.expectPath(/\/settings/i);
    });
  }

  async expectLoaded(): Promise<void> {
    await test.step('Expect the Settings module to be loaded', async () => {
      await this.expectStillAuthenticated();
      await this.expectPath(/\/settings/i);
      await this.expectShellVisible();
      await expect(this.section('My Account')).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Sections (plain text, not tabs — see class doc)
  // ---------------------------------------------------------------------------

  /** A settings section entry. `.first()` because some labels match twice. */
  private section(section: SettingsSection): Locator {
    return this.page.getByText(section, { exact: true }).first();
  }

  async expectSectionAvailable(section: SettingsSection): Promise<void> {
    await test.step(`Expect the "${section}" section`, async () => {
      await expect(this.section(section)).toBeVisible();
    });
  }

  /** Assert every section this build ships is offered. */
  async expectAllSectionsAvailable(): Promise<void> {
    await test.step('Expect all Settings sections', async () => {
      for (const section of SETTINGS_SECTIONS) {
        await expect(this.section(section)).toBeVisible();
      }
    });
  }

  /** Select a section. Note the URL stays `/settings`. */
  async openSection(section: SettingsSection): Promise<void> {
    await test.step(`Open the "${section}" section`, async () => {
      await this.click(this.section(section));
    });
  }

  /** Assert a section that carries a save action exposes its Submit button. */
  async expectSubmitAvailable(): Promise<void> {
    await test.step('Expect the section Submit button', async () => {
      await expect(this.submitButton).toBeVisible();
    });
  }

  // ---------------------------------------------------------------------------
  // Profile details
  // ---------------------------------------------------------------------------

  /**
   * Read the identity KPost persisted for this session.
   *
   * Used to check the rendered profile against the account actually signed in,
   * rather than hard-coding a name that only holds for one test user. It is a
   * consistency check between the session record and the UI — not independent
   * proof of what the backend holds.
   */
  async sessionIdentity(): Promise<SessionIdentity> {
    return test.step('Read the signed-in identity from the session', async () => {
      const raw = await this.page.evaluate(() => window.localStorage.getItem('Authuser'));
      if (!raw) throw new Error('No "Authuser" in localStorage — is this context signed in?');
      return JSON.parse(raw) as SessionIdentity;
    });
  }

  /** Assert Settings renders the given display name. */
  async expectProfileName(name: string | RegExp): Promise<void> {
    await test.step(`Expect the profile name "${name}"`, async () => {
      await expect(this.page.getByText(name).first()).toBeVisible();
    });
  }

  /** Assert the profile shown matches the account that is signed in. */
  async expectProfileMatchesSession(): Promise<void> {
    await test.step('Expect the profile to match the signed-in account', async () => {
      const { firstName, lastName } = await this.sessionIdentity();
      await this.expectProfileName(`${firstName} ${lastName}`.trim());
    });
  }

  async expectProfileImage(): Promise<void> {
    await test.step('Expect the profile image', async () => {
      await expect(this.profileImage).toBeVisible();
    });
  }

  async expectCoverPhotoControl(): Promise<void> {
    await test.step('Expect the Add Cover Photo control', async () => {
      await expect(this.addCoverPhoto).toBeVisible();
    });
  }
}
