import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the General Settings controller, in one place. */
export const GENERAL_SETTINGS_PATHS = {
  kmailNotification: '/generalSetting/kmailNotification',
  katchupNotification: '/generalSetting/katchupNotification',
  kallNotification: '/generalSetting/kallNotification',
  fontSetting: '/generalSetting/fontSetting',
  changeTheme: '/generalSetting/changeTheme',
  getPersonalize: '/generalSetting/getPersonalize',
  getAllNotification: '/generalSetting/getAllNotification',
} as const;

// Every route resolves the target user from the token (no kpostID arg); payloads are typed `unknown`
// so fuzzing drives malformed bodies through the happy-path code.
export class GeneralSettingsClient extends BaseClient {
  /** Upsert the caller's Kmail notification switches. */
  kmailNotification(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GENERAL_SETTINGS_PATHS.kmailNotification, data, options);
  }

  /** Upsert the caller's Katchup notification switches. */
  katchupNotification(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GENERAL_SETTINGS_PATHS.katchupNotification, data, options);
  }

  /** Upsert the caller's Kall (voice/video) notification switches. */
  kallNotification(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GENERAL_SETTINGS_PATHS.kallNotification, data, options);
  }

  /** Persist the caller's font size / style preference. */
  fontSetting(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GENERAL_SETTINGS_PATHS.fontSetting, data, options);
  }

  /** Switch the caller's UI theme; the response echoes the persisted settings. */
  changeTheme(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GENERAL_SETTINGS_PATHS.changeTheme, data, options);
  }

  /** Read the caller's personalisation block (theme plus font). */
  getPersonalize(options?: RequestOptions): Promise<APIResponse> {
    return this.get(GENERAL_SETTINGS_PATHS.getPersonalize, options);
  }

  /** Read every notification preference for the caller — the canonical write read-back. */
  getAllNotification(options?: RequestOptions): Promise<APIResponse> {
    return this.get(GENERAL_SETTINGS_PATHS.getAllNotification, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
