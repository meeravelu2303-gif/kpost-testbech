import { z } from 'zod';

/**
 * Zod contracts for the Company Administration controller (`/admin/**`).
 *
 * `SecurityConfiguration` gates this whole tree with `hasRole("admin")`, so every schema
 * here describes a response that only a company administrator should ever see. Two of them
 * matter more than the rest:
 *
 * - `getBankAndCompanyDetails` returns settlement details. The schema pins the account
 *   fields explicitly so a test can assert whether they came back in full, masked, or not
 *   at all — "did the account number leak" is not answerable against an opaque `data`.
 * - `userManagementDetails` returns the company roster with each employee's role and
 *   account state, which is what the cross-company scoping tests assert against.
 */

/** Envelope shared by Company Administration success responses. */
export const adminEnvelopeSchema = z
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
export const adminErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    errorMsg: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** Acknowledgement for the mutation routes that return no payload. */
export const adminAckResponseSchema = adminEnvelopeSchema;

/** One employee row in the user-management console. */
export const managedUserSchema = z
  .object({
    kpostID: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    mobileNumber: z.string().nullish(),
    designation: z.string().nullish(),
    role: z.string().nullish(),
    activeStatus: z.string().nullish(),
    companyID: z.number().nullish(),
    isBackUpAdmin: z.union([z.boolean(), z.string()]).nullish(),
  })
  .passthrough();

/** GET /admin/userManagementDetails/{companyID} */
export const userManagementResponseSchema = adminEnvelopeSchema.extend({
  data: z
    .union([z.array(managedUserSchema), managedUserSchema, z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * The settlement record. Field names are pinned so the disclosure tests can ask a precise
 * question: whether a full account number reached the response body.
 */
export const bankDetailsSchema = z
  .object({
    accountNumber: z.string().nullish(),
    accountHolderName: z.string().nullish(),
    ifscCode: z.string().nullish(),
    bankName: z.string().nullish(),
    branch: z.string().nullish(),
    panNumber: z.string().nullish(),
    gstNumber: z.string().nullish(),
  })
  .passthrough();

/** The company profile as returned alongside the bank record. */
export const companyProfileSchema = z
  .object({
    companyID: z.number().nullish(),
    companyName: z.string().nullish(),
    uniqueName: z.string().nullish(),
    typeOfCompany: z.string().nullish(),
    entity: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    pinCode: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();

/** GET /admin/getBankAndCompanyDetails/{companyID} */
export const bankAndCompanyResponseSchema = adminEnvelopeSchema.extend({
  data: z
    .union([
      companyProfileSchema.merge(bankDetailsSchema),
      z.array(companyProfileSchema.merge(bankDetailsSchema)),
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** POST /admin/createKpostIDAndDesignationSuggestion and /admin/displayNameSuggestion. */
export const suggestionResponseSchema = adminEnvelopeSchema.extend({
  data: z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

export type ManagedUser = z.infer<typeof managedUserSchema>;
export type BankDetails = z.infer<typeof bankDetailsSchema>;
