import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Kall V2 controller (`KallControllerV3`), in one place. */
export const KALL_V2_PATHS = {
  initiateKall: '/v2/kall/initiateKall',
  updateKallStatus: '/v2/kall/updateKallStatus',
  updateSenderAndReceiverKallStatus: '/v2/kall/updateSenderAndReceiverKallStatus',
  getKallStatus: '/v2/kall/getKallStatus',
  getKallStatusUsingKallID: '/v2/kall/getKallStatusUsingKallID',
  /*
   * Excel row 88. Distinct from `endKoolKall` (the group/Kool Kall form) and
   * `endIndividualKall`: the documented body is `{ id, kallID }`, carrying BOTH the
   * participant row id and the call id.
   */
  endKall: '/v2/kall/endKall',
  endKoolKall: '/v2/kall/endKoolKall',
  endIndividualKall: '/v2/kall/endIndividualKall',
  scheduledKall: '/v2/kall/scheduledKall',
  reScheduleKall: '/v2/kall/reScheduleKall',
  scheduledRepeatKall: '/v2/kall/scheduledRepeatKall',
  fetchScheduledRepeatKall: '/v2/kall/fetchScheduledRepeatKall',
  joinScheduleKall: '/v2/kall/joinScheduleKall',
  todayKoolKall: '/v2/kall/todayKoolKall',
  addMembersToKall: '/v2/kall/addMembersToKall',
  modifyKallMembers: '/v2/kall/modifyKallMembers',
  kallInfo: '/v2/kall/kallInfo',
  contactInfo: '/v2/kall/contactInfo',
  kallDashboard: '/v2/kall/kallDashboard',
  frequentKallContacts: '/v2/kall/frequentKallContacts',
  clearKallBykallIds: '/v2/kall/clearKallBykallIds',
  clearKallHistory: '/v2/kall/clearKallHistory',
} as const;

// Shapes preserved on purpose: clearKallHistory is a GET that destroys the caller's whole call
// history (the method choice is itself the finding); updateSenderAndReceiverKallStatus/getKallStatus
// take identity from the body (siblings overwrite it from the token — on getKallStatus that line is
// commented out).
export class KallV2Client extends BaseClient {
  /** Place a call. Rings the receiver's device. */
  initiateKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.initiateKall, data, options);
  }

  /** Move a call's status. Identity is overwritten from the token. */
  updateKallStatus(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.updateKallStatus, data, options);
  }

  /** Move both parties' status. Identity comes from the body, not the token. */
  updateSenderAndReceiverKallStatus(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.updateSenderAndReceiverKallStatus, data, options);
  }

  /** Read a call's status. Identity comes from the body, not the token. */
  getKallStatus(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.getKallStatus, data, options);
  }

  /** Read one call's status by id, scoped to the token's user. */
  getKallStatusUsingKallID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.getKallStatusUsingKallID, data, options);
  }

  /** End a group call for everyone. */
  endKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.endKall, data, options);
  }

  endKoolKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.endKoolKall, data, options);
  }

  /** Drop a single participant's leg of a call. */
  endIndividualKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.endIndividualKall, data, options);
  }

  /** Book a call for later. Bean-validated (`@Valid`). */
  scheduledKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.scheduledKall, data, options);
  }

  /** Move a booked call. Bean-validated (`@Valid`). */
  reScheduleKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.reScheduleKall, data, options);
  }

  /** Create a recurring call series. Bean-validated (`@Valid`). */
  scheduledRepeatKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.scheduledRepeatKall, data, options);
  }

  /** Read back a recurring series. */
  fetchScheduledRepeatKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.fetchScheduledRepeatKall, data, options);
  }

  /** Join a scheduled call; mints the media-server join credentials. */
  joinScheduleKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.joinScheduleKall, data, options);
  }

  /** Today's scheduled calls for the token's user. */
  todayKoolKall(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KALL_V2_PATHS.todayKoolKall, options);
  }

  /** Add participants to an existing call. */
  addMembersToKall(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.addMembersToKall, data, options);
  }

  /** Add and remove participants in one request. */
  modifyKallMembers(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.modifyKallMembers, data, options);
  }

  /** Details of one call, scoped to the token's user. */
  kallInfo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.kallInfo, data, options);
  }

  /** Contact details for the dial screen, scoped to the token's user. */
  contactInfo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.contactInfo, data, options);
  }

  /** Call history for the token's user. */
  kallDashboard(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.kallDashboard, data, options);
  }

  /** Most-called contacts for the token's user. */
  frequentKallContacts(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KALL_V2_PATHS.frequentKallContacts, options);
  }

  /** Remove specific calls from the caller's history. */
  clearKallBykallIds(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KALL_V2_PATHS.clearKallBykallIds, data, options);
  }

  /** Wipe the caller's entire call history — a destructive action exposed as a prefetchable GET. */
  clearKallHistory(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KALL_V2_PATHS.clearKallHistory, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }

  /** Issues a GET against a POST-only route, for method-binding cases. */
  getRoute(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }
}
