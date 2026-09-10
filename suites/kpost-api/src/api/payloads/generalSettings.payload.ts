import { faker } from '../../utils/dataGen';
import { qaIdentifier, safeTestEmail, safeTestMobile } from '../../utils/safeTestData';

/**
 * Request builders for the General Settings controller.
 *
 * swagger.json declares each request body as a free-form map
 * (`{type: object, additionalProperties: {type: object}}`), so it names no fields at all.
 * `changeTheme`, `fontSetting` and the notification routes therefore take their shapes from
 * the Excel workbook (rows 221–226), which is authoritative for request payloads. Field names
 * inferred from swagger operation *descriptions* are what produced the phantom `changeTheme`
 * body this file used to send — do not reintroduce that source.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values to prove the API validates them, and a
 * strict override type would make those cases uncompilable.
 *
 * None of these endpoints dispatches an SMS or email — `kpostID` is derived from the bearer
 * token, not the body. The contact helpers are still used for the optional alert-destination
 * fields so that a future change to these routes cannot start paging a real subscriber.
 */

// Excel spec: `{ messagePreview: 0|1, sound: "<file>.mp3", vibrate: 0|1, doNotDisturb: 0|1 }` —
// flags are integers (0 = disable, 1 = enable) and `sound` is a ringtone filename.
export interface NotificationSettingsRequest {
  messagePreview: number;
  sound: string;
  vibrate: number;
  doNotDisturb: number;
  [key: string]: unknown;
}

/** Shared by kmailNotification, katchupNotification and kallNotification. */
export function buildNotificationPayload(
  overrides: Record<string, unknown> = {}
): NotificationSettingsRequest {
  return {
    messagePreview: 1,
    sound: 'default_tone.mp3',
    vibrate: 1,
    doNotDisturb: 0,
    ...overrides,
  } as NotificationSettingsRequest;
}

/** A payload that switches every notification option off, for independence checks. */
export function buildNotificationOffPayload(
  overrides: Record<string, unknown> = {}
): NotificationSettingsRequest {
  return buildNotificationPayload({
    messagePreview: 0,
    sound: 'default_tone.mp3',
    vibrate: 0,
    doNotDisturb: 1,
    ...overrides,
  });
}

export interface FontSettingRequest {
  fontSize: string;
  fontStyle: string;
  [key: string]: unknown;
}

export function buildFontSettingPayload(
  overrides: Record<string, unknown> = {}
): FontSettingRequest {
  return {
    fontSize: 'MEDIUM',
    fontStyle: 'DEFAULT',
    ...overrides,
  } as FontSettingRequest;
}

/** The nested wallpaper block on `changeTheme` — Excel: `{ default, color, image }`. */
export interface ChatWallpaperRequest {
  default: boolean;
  color: string | null;
  image: string | null;
  [key: string]: unknown;
}

/**
 * Excel row 223 (`/generalSetting/changeTheme`). Nine fields, one of them a nested object.
 *
 * This replaces an earlier `{ theme, backGroundTheme }` guess taken from the swagger operation
 * description — neither name exists in the contract, so every fuzz vector aimed at them mutated
 * a field the server ignores, the request stayed valid, and `assertRejectsInvalidInput` filed a
 * fabricated "invalid input accepted" defect. Keep the field names byte-exact, including the
 * `&` in `useLocalSunset&Sunrise`.
 */
export interface ChangeThemeRequest {
  colourPalette: string;
  nightModeEnable: number;
  'useLocalSunset&Sunrise': number;
  syncwithDeviceSetting: number;
  scheduleTiming: string;
  kpostLayoutTheme: string;
  katchupChatStyle: string;
  katchupChatTheme: string;
  katchupChatBackgroundThemeWallpaper: ChatWallpaperRequest;
  [key: string]: unknown;
}

export function buildChangeThemePayload(
  overrides: Record<string, unknown> = {}
): ChangeThemeRequest {
  return {
    colourPalette: '#0001',
    nightModeEnable: 1,
    'useLocalSunset&Sunrise': 0,
    syncwithDeviceSetting: 0,
    // Excel carries the literal mask "HH ::RR :: MM"; a concrete window is sent so the happy
    // path can reach a 200. The exact accepted format is unverified against the live API.
    scheduleTiming: '22:00 :: 06:00',
    kpostLayoutTheme: 'purple',
    katchupChatStyle: 'bubble',
    katchupChatTheme: 'sunset',
    katchupChatBackgroundThemeWallpaper: { default: true, color: null, image: null },
    ...overrides,
  } as ChangeThemeRequest;
}

/**
 * A settings payload carrying an explicit identity field. Used only by the privilege
 * escalation cases: the server must derive `kpostID` from the token and ignore this.
 */
export function buildPayloadWithForeignIdentity(
  base: Record<string, unknown>,
  victimKpostId: string
): Record<string, unknown> {
  return {
    ...base,
    kpostID: victimKpostId,
    kpostId: victimKpostId,
  };
}

/** Optional alert-destination fields, pinned to the safe test contact details. */
export function buildAlertDestinationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    alertMobile: safeTestMobile(),
    alertEmail: safeTestEmail(),
    deviceLabel: qaIdentifier('device'),
    sessionTag: faker.string.uuid(),
    ...overrides,
  };
}
