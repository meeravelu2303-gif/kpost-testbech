import { z } from 'zod';

/**
 * Zod contracts for the Contacts Directory V2 controller (`/v2/contacts/**`).
 *
 * Three shapes carry weight beyond the usual envelope:
 *
 * - The delta-sync routes (`myContacts`, `myGroups`) return added/updated/deleted buckets
 *   plus a fresh `lastFetchDate` cursor. The cursor is pinned explicitly: without it the
 *   client cannot advance its sync window, so a missing field is a functional defect rather
 *   than cosmetic.
 * - `myUnknownGroups` describes groups the caller is **not** a member of. The schema keeps
 *   `memberDetails` and message fields visible so a test can assert they are absent — the
 *   spec calls this route out as one to probe for information disclosure.
 * - `getSearchDetails` returns a flat `ArrayList<String>` under `data`, not objects.
 */

/** Envelope shared by Contacts Directory V2 success responses. */
export const contactsEnvelopeSchema = z
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
export const contactsErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** One contact row in the caller's directory. */
export const contactRecordSchema = z
  .object({
    id: z.number().nullish(),
    kpostID: z.string().nullish(),
    contactID: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    referenceName: z.string().nullish(),
    contactDesignation: z.string().nullish(),
    mobileNumber: z.string().nullish(),
    email: z.string().nullish(),
    userType: z.string().nullish(),
    isBlocked: z.boolean().nullish(),
    deleteStatus: z.boolean().nullish(),
    companyName: z.string().nullish(),
  })
  .passthrough();

/** Acknowledgement for the mutation routes that return no payload. */
export const contactAckResponseSchema = contactsEnvelopeSchema;

/** POST /v2/contacts/addContact and addMultipleContact. */
export const addContactResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([contactRecordSchema, z.array(contactRecordSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * Delta-sync payload. `lastFetchDate` is the cursor the client must carry into its next
 * call, so it is pinned rather than left to `passthrough`.
 */
export const contactsDeltaSchema = z
  .object({
    newlyAdded: z.array(contactRecordSchema).nullish(),
    updated: z.array(contactRecordSchema).nullish(),
    deleted: z.array(contactRecordSchema).nullish(),
    lastFetchDate: z.string().nullish(),
  })
  .passthrough();

/** POST /v2/contacts/myContacts */
export const myContactsResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([contactsDeltaSchema, z.array(contactRecordSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** A group as surfaced by the group listing routes. */
export const contactGroupSchema = z
  .object({
    groupID: z.number().nullish(),
    groupKpostID: z.string().nullish(),
    groupKpostName: z.string().nullish(),
    groupAdmin: z.string().nullish(),
    isPrivateGroup: z.string().nullish(),
    // Kept visible so the disclosure tests can assert these are absent for a group the
    // caller does not belong to.
    memberDetails: z.array(z.unknown()).nullish(),
    actualMessage: z.string().nullish(),
  })
  .passthrough();

/** POST /v2/contacts/myGroups and /v2/contacts/myUnknownGroups. */
export const groupListingResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([
      z.array(contactGroupSchema),
      z.object({ lastFetchDate: z.string().nullish() }).passthrough(),
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** POST /v2/contacts/myUnknownKatchupContacts */
export const unknownContactsResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([z.array(contactRecordSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** A platform-wide directory hit, drawn from VW_KPOST_USER_DETAIL. */
export const globalSearchHitSchema = z
  .object({
    kpostID: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    designation: z.string().nullish(),
    companyName: z.string().nullish(),
    city: z.string().nullish(),
    // Present so the disclosure tests can assert a directory hit does not carry contact
    // details for a user who has not shared them.
    mobileNumber: z.string().nullish(),
    email: z.string().nullish(),
    privacyStatus: z.number().nullish(),
  })
  .passthrough();

/** POST /v2/contacts/globalSearch */
export const globalSearchResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([z.array(globalSearchHitSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** POST /v2/contacts/getSearchDetails — a flat list of strings, not objects. */
export const searchDetailsResponseSchema = contactsEnvelopeSchema.extend({
  data: z.union([z.array(z.string()), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** GET /v2/contacts/getblockContactDetails — the blocked kpostIDs. */
export const blockedContactsResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([z.array(z.string()), z.array(contactRecordSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** One entry from the caller's uploaded device address book. */
export const phoneContactSchema = z
  .object({
    mobileNumber: z.string().nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    joinStatus: z.string().nullish(),
    inviteStatus: z.string().nullish(),
    kpostID: z.string().nullish(),
    deviceID: z.string().nullish(),
  })
  .passthrough();

/** GET /v2/contacts/getImportedPhoneContacts and POST importPhoneContacts. */
export const phoneContactsResponseSchema = contactsEnvelopeSchema.extend({
  data: z
    .union([z.array(phoneContactSchema), phoneContactSchema, z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

export type ContactRecord = z.infer<typeof contactRecordSchema>;
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;
export type PhoneContact = z.infer<typeof phoneContactSchema>;
