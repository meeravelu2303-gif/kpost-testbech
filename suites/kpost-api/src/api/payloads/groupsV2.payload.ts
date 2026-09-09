import { faker } from '../../utils/dataGen';
import { qaIdentifier, qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the Groups V2 controller.
 *
 * Two safety rules are encoded here rather than left to each spec:
 *
 * 1. **Group identifiers default to a non-existent, QA-prefixed value.** `deleteGroup`,
 *    `removeGroupMember` and `editGroupName` are destructive and irreversible through the
 *    API; the spec calls deleteGroup "the most destructive group operation". Builders
 *    therefore never default to a real group, so a misfired test cannot destroy shared data.
 *    A spec that genuinely needs a live group must pass its id in explicitly.
 * 2. **Member lists use QA identities and the safe test email.** `createUserGroup` and
 *    `addUserToGroup` are outward-facing — added users are notified — so a faker-generated
 *    identity could page a real subscriber.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** A group identifier that must not resolve to any real group. */
export function nonExistentGroupKpostId(): string {
  return `qa-nonexistent-group-${faker.string.alphanumeric(10)}`;
}

export interface CreateGroupRequest {
  groupKpostName: string;
  isPrivateGroup: string;
  activeStatus: string;
  memberDetails: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function buildCreateGroupPayload(
  overrides: Record<string, unknown> = {}
): CreateGroupRequest {
  return {
    groupKpostName: qaLabel('group'),
    isPrivateGroup: 'N',
    activeStatus: 'Y',
    // Excel/swagger: each member requires hasAdminAccess + privacyStatus (omitting them 500s the create).
    memberDetails: [{ kpostID: qaIdentifier('member'), name: 'QA Member', hasAdminAccess: 'N', privacyStatus: 'N' }],
    ...overrides,
  } as CreateGroupRequest;
}

export interface GroupMemberActionRequest {
  groupKpostID: string;
  kpostID: string;
  memberKpostIdList: string[];
  hasAdminAccess: string;
  remarks: string;
  [key: string]: unknown;
}

/**
 * Shared by removeGroupMember, leaveFromGroup, editGroupName, deleteGroup,
 * addOrRemoveAdminAccess and removeGroupProfileImage — all take the same `GroupMemberRO`.
 * Defaults to a non-existent group for the reasons above.
 */
export function buildGroupMemberActionPayload(
  overrides: Record<string, unknown> = {}
): GroupMemberActionRequest {
  return {
    // Excel: the member-action endpoints key by numeric `groupID` (with `groupKpostID` alongside).
    groupID: 999_000_000,
    groupKpostID: nonExistentGroupKpostId(),
    kpostID: qaIdentifier('member'),
    memberKpostIdList: [qaIdentifier('member')],
    hasAdminAccess: 'N',
    remarks: 'QA automation probe',
    ...overrides,
  } as GroupMemberActionRequest;
}

/** Rename payload: the new display name plus the group being renamed. */
export function buildEditGroupNamePayload(
  overrides: Record<string, unknown> = {}
): GroupMemberActionRequest {
  return buildGroupMemberActionPayload({
    groupKpostName: qaLabel('renamed'),
    ...overrides,
  });
}

/** Add-members payload. Outward-facing: members are notified, so identities stay QA-only. */
export function buildAddUserToGroupPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    groupKpostID: nonExistentGroupKpostId(),
    // Excel: each member requires name + hasAdminAccess + privacyStatus (omitting them 500s the
    // add, same as createUserGroup). Kept aligned so the happy path fails on the rule under test,
    // not on a malformed member.
    memberDetails: [
      { kpostID: qaIdentifier('member'), name: 'QA Member', hasAdminAccess: 'N', privacyStatus: 'N' },
    ],
    ...overrides,
  };
}

/**
 * Admin grant/revoke payload. The service compares `hasAdminAccess` by **exact match** on
 * `"Y"`/`"N"`; anything else (including lowercase) takes the fallthrough branch, which is
 * what the privilege-flag tests probe.
 */
export function buildAdminAccessPayload(
  hasAdminAccess: string,
  overrides: Record<string, unknown> = {}
): GroupMemberActionRequest {
  return buildGroupMemberActionPayload({ hasAdminAccess, ...overrides });
}

/** Minimal valid PNG used for avatar upload cases. */
export function pngFileBuffer(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

/** A payload disguised as an image, for upload content-type validation. */
export function scriptFileBuffer(): Buffer {
  return Buffer.from(`<?php system($_GET['c']); ?>`, 'utf-8');
}
