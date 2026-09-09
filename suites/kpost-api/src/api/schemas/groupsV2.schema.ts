import { z } from 'zod';

/**
 * Zod contracts for the Groups V2 controller (`/v2/group/**`).
 *
 * Two shapes matter on this tag beyond the usual envelope:
 *
 * - `createUserGroup` returns the created group including its generated `groupKpostID`,
 *   which every other group route needs. The schema pins that field explicitly so a missing
 *   identifier is reported as a contract defect rather than surfacing later as a confusing
 *   404 on an unrelated route.
 * - `getGroupDetailsUsingGroupKpostID` returns the member list with each member's admin
 *   status, which is what the membership-scoping and privilege tests assert against.
 */

/** Envelope shared by Groups V2 success responses. */
export const groupEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/404/500 across the tag. */
export const groupErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    errorCode: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** One member row, including whether they hold group-admin rights. */
export const groupMemberSchema = z
  .object({
    id: z.number().nullish(),
    kpostID: z.string().nullish(),
    groupID: z.number().nullish(),
    groupKpostID: z.string().nullish(),
    hasAdminAccess: z.string().nullish(),
    memberName: z.string().nullish(),
    activeStatus: z.string().nullish(),
  })
  .passthrough();

/** A group record as returned by create and detail reads. */
export const groupRecordSchema = z
  .object({
    groupID: z.number().nullish(),
    groupKpostID: z.string().nullish(),
    groupKpostName: z.string().nullish(),
    groupPicturePath: z.string().nullish(),
    groupAdmin: z.string().nullish(),
    isPrivateGroup: z.string().nullish(),
    activeStatus: z.string().nullish(),
    domainID: z.number().nullish(),
    memberDetails: z.array(groupMemberSchema).nullish(),
  })
  .passthrough();

/** POST /v2/group/createUserGroup — `data` carries the generated groupKpostID. */
export const createUserGroupResponseSchema = groupEnvelopeSchema.extend({
  data: z.union([groupRecordSchema, z.array(groupRecordSchema), z.null()]).optional(),
});

/** GET /v2/group/getGroupDetailsUsingGroupKpostID/{groupKpostID} */
export const groupDetailsResponseSchema = groupEnvelopeSchema.extend({
  data: z.union([groupRecordSchema, z.array(groupRecordSchema), z.null()]).optional(),
});

/** POST /v2/group/addUserToGroup — returns the resulting member list. */
export const addUserToGroupResponseSchema = groupEnvelopeSchema.extend({
  data: z
    .union([z.array(groupMemberSchema), groupMemberSchema, z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * Acknowledgement envelope for the mutation routes that return no payload:
 * editGroupName, deleteGroup, removeGroupMember, leaveFromGroup,
 * addOrRemoveAdminAccess, updateGroupProfileImage, removeGroupProfileImage.
 */
export const groupAckResponseSchema = groupEnvelopeSchema;

export type GroupRecord = z.infer<typeof groupRecordSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
