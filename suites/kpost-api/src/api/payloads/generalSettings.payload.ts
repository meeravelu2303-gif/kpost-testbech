import { faker } from '../../utils/dataGen';
import { qaIdentifier, safeTestEmail, safeTestMobile } from '../../utils/safeTestData';

/**
 * Request builders for the General Settings controller.
 *
 * swagger.json declares each request body as a free-form map
 * (`{type: object, additionalProperties: {type: object}}`), so the field names below come
 * from the operation descriptions rather than a declared schema: the notification routes
 * store "the master on/off toggle plus sound, vibration and preview options", `fontSetting`
 * stores "font size / font style", and `changeTheme` stores a named or light/dark theme.
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

export interface ChangeThemeRequest {
  theme: string;
  backGroundTheme: string;
  [key: string]: unknown;
}

export function buildChangeThemePayload(
  overrides: Record<string, unknown> = {}
): ChangeThemeRequest {
  return {
    theme: 'DARK',
    backGroundTheme: 'DARK',
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
