import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Dashboard V2 controller, in one place. */
export const DASHBOARD_V2_PATHS = {
  katchupDashboardMsg: '/v2/dashboard/katchupDashboardMsg',
  kallDashboard: '/v2/dashboard/kallDashboard',
  homeDashboardNewMsgs: '/v2/dashboard/homeDashboardNewMsgs',
  homeDashboardMsgs: '/v2/dashboard/homeDashboardMsgs',
  getKmailDashboardMsg: '/v2/dashboard/getKmailDashboardMsg',
} as const;

// Payloads are typed `unknown` so fuzzing drives malformed bodies through the happy-path code.
export class DashboardV2Client extends BaseClient {
  /** Katchup message feed shown on the dashboard. */
  katchupDashboardMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DASHBOARD_V2_PATHS.katchupDashboardMsg, data, options);
  }

  /** Kall (voice/video) history feed. */
  kallDashboard(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DASHBOARD_V2_PATHS.kallDashboard, data, options);
  }

  /** Unread-message aggregate for the home dashboard. */
  homeDashboardNewMsgs(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DASHBOARD_V2_PATHS.homeDashboardNewMsgs, data, options);
  }

  /** Full message aggregate for the home dashboard. */
  homeDashboardMsgs(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DASHBOARD_V2_PATHS.homeDashboardMsgs, data, options);
  }

  /** Kmail feed shown on the dashboard. */
  getKmailDashboardMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DASHBOARD_V2_PATHS.getKmailDashboardMsg, data, options);
  }

  /** Sends a raw, possibly malformed body to any Dashboard route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
