import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Groups V2 controller, in one place. */
export const GROUPS_V2_PATHS = {
  createUserGroup: '/v2/group/createUserGroup',
  addUserToGroup: '/v2/group/addUserToGroup',
  addOrRemoveAdminAccess: '/v2/group/addOrRemoveAdminAccess',
  removeGroupMember: '/v2/group/removeGroupMember',
  leaveFromGroup: '/v2/group/leaveFromGroup',
  editGroupName: '/v2/group/editGroupName',
  deleteGroup: '/v2/group/deleteGroup',
  updateGroupProfileImage: '/v2/group/updateGroupProfileImage',
  removeGroupProfileImage: '/v2/group/removeGroupProfileImage',
  getGroupDetailsUsingGroupKpostID: (groupKpostID: string) =>
    `/v2/group/getGroupDetailsUsingGroupKpostID/${encodeURIComponent(groupKpostID)}`,
  downloadGroupProfileImage: (groupKpostID: string, kpostID: string) =>
    `/v2/group/downloadGroupProfileImage/${encodeURIComponent(groupKpostID)}/${encodeURIComponent(kpostID)}`,
  downloadGroupFullProfileImage: (groupKpostID: string, kpostID: string) =>
    `/v2/group/downloadGroupFullProfileImage/${encodeURIComponent(groupKpostID)}/${encodeURIComponent(kpostID)}`,
} as const;

/** Template forms used for bug-ledger metadata, so findings group by route not by id. */
export const GROUPS_V2_PATH_TEMPLATES = {
  getGroupDetailsUsingGroupKpostID: '/v2/group/getGroupDetailsUsingGroupKpostID/{groupKpostID}',
  downloadGroupProfileImage: '/v2/group/downloadGroupProfileImage/{groupKpostID}/{kpostID}',
  downloadGroupFullProfileImage: '/v2/group/downloadGroupFullProfileImage/{groupKpostID}/{kpostID}',
} as const;

// Payloads are typed `unknown` so fuzzing drives malformed bodies through the happy-path code.
export class GroupsV2Client extends BaseClient {
  /** Create a group with the authenticated caller as its administrator. */
  createUserGroup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.createUserGroup, data, options);
  }

  /** Add one or more members to an existing group (admin only). */
  addUserToGroup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.addUserToGroup, data, options);
  }

  /** Grant ("Y") or revoke ("N") group-admin rights for a member. */
  addOrRemoveAdminAccess(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.addOrRemoveAdminAccess, data, options);
  }

  /** Admin-initiated ejection of another member. */
  removeGroupMember(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.removeGroupMember, data, options);
  }

  /** Self-service departure; the subject is stamped from the token. */
  leaveFromGroup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.leaveFromGroup, data, options);
  }

  /** Rename a group (admin only). The groupKpostID must not change. */
  editGroupName(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.editGroupName, data, options);
  }

  /** Permanently delete a group — irreversible; pass a throwaway/non-existent id only. */
  deleteGroup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.deleteGroup, data, options);
  }

  /** Upload a group avatar (multipart). Visible to every member. */
  updateGroupProfileImage(
    parts: Record<string, string | number | boolean | { name: string; mimeType: string; buffer: Buffer }>,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.postMultipart(GROUPS_V2_PATHS.updateGroupProfileImage, parts, options);
  }

  /** Clear a group avatar (implemented server-side as an update-to-null). */
  removeGroupProfileImage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(GROUPS_V2_PATHS.removeGroupProfileImage, data, options);
  }

  /** Read one group's full record including its member list. */
  getGroupDetails(groupKpostID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(GROUPS_V2_PATHS.getGroupDetailsUsingGroupKpostID(groupKpostID), options);
  }

  /** Stream the thumbnail avatar. Declared `permitAll` — no token required. */
  downloadGroupProfileImage(
    groupKpostID: string,
    kpostID: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(GROUPS_V2_PATHS.downloadGroupProfileImage(groupKpostID, kpostID), options);
  }

  /** Stream the full-size avatar. Also `permitAll`. */
  downloadGroupFullProfileImage(
    groupKpostID: string,
    kpostID: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(GROUPS_V2_PATHS.downloadGroupFullProfileImage(groupKpostID, kpostID), options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
