import { z } from 'zod';

/**
 * Zod contracts for Kall (Voice/Video) V2 — `/v2/kall/**`, served by `KallControllerV3`.
 *
 * Two structural notes that shape everything below.
 *
 * **`data` is a list even for single-call routes.** The controller funnels almost every
 * response through `KpostWelcomeMailAndMessage.modifyKallResponse(...)`, which returns a
 * `List<KallResponseObject>`. So `kallInfo` and `getKallStatusUsingKallID` answer with a
 * one-element array rather than an object, and clients have to unwrap.
 *
 * **Empty is an error here too.** Like Kdiary, these routes branch on
 * `KPOSTValidation.isEmpty(...)`: a non-empty result is 200, an empty one is a FAILURE
 * envelope. "No calls today" and "no frequent contacts" are ordinary states for a new user,
 * so the response union has to admit both shapes.
 */

/** Envelope shared by Kall V2 success responses. */
export const kallEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/500 across the tag. */
export const kallErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** One participant leg of a call — the per-receiver row. */
export const kallDetailSchema = z
  .object({
    id: z.number().nullish(),
    kallID: z.number().nullish(),
    receiver: z.string().nullish(),
    receiverName: z.string().nullish(),
    receiverKallStatus: z.number().nullish(),
    joinStatus: z.number().nullish(),
    reason: z.string().nullish(),
    deleteStatus: z.boolean().nullish(),
    rtcToken: z.string().nullish(),
    uid: z.string().nullish(),
  })
  .passthrough();

/**
 * A call record.
 *
 * `rtcToken` and `uid` are the media-server join credentials. They are pinned here rather
 * than left to `passthrough` so a test can assert they are absent from responses that had no
 * business minting them — a token handed to a non-participant is a live call they can join.
 */
export const kallMasterSchema = z
  .object({
    kallID: z.number().nullish(),
    sender: z.string().nullish(),
    senderName: z.string().nullish(),
    kallMode: z.number().nullish(),
    kallType: z.number().nullish(),
    senderKallStatus: z.number().nullish(),
    senderJoinStatus: z.number().nullish(),
    subject: z.string().nullish(),
    kallSession: z.string().nullish(),
    meetingLink: z.string().nullish(),
    rtcToken: z.string().nullish(),
    uid: z.string().nullish(),
    kallStartTime: z.string().nullish(),
    kallEndTime: z.string().nullish(),
    scheduledStartTime: z.string().nullish(),
    scheduledEndTime: z.string().nullish(),
    kallDuration: z.string().nullish(),
    scheduleDuration: z.string().nullish(),
    repeatType: z.number().nullish(),
    repeatedDate: z.string().nullish(),
    parentKallId: z.number().nullish(),
    nextOccurrenceTime: z.string().nullish(),
    seriesActive: z.boolean().nullish(),
    seriesEndDate: z.string().nullish(),
    deletedBySender: z.boolean().nullish(),
    createDate: z.string().nullish(),
    modifiedDate: z.string().nullish(),
    kallDetails: z.array(kallDetailSchema).nullish(),
  })
  .passthrough();

/** A frequent-contact row on the dial screen. */
export const frequentContactSchema = z
  .object({
    kpostID: z.string().nullish(),
    contactID: z.string().nullish(),
    name: z.string().nullish(),
    kallCount: z.number().nullish(),
    profileImage: z.string().nullish(),
  })
  .passthrough();

/** Routes returning one or more call records. */
export const kallResponseSchema = kallEnvelopeSchema.extend({
  data: z
    .union([
      z.array(kallMasterSchema),
      kallMasterSchema,
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** Call history / dashboard listings. */
export const kallListResponseSchema = kallEnvelopeSchema.extend({
  data: z
    .union([z.array(kallMasterSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** GET /v2/kall/frequentKallContacts. */
export const frequentContactsResponseSchema = kallEnvelopeSchema.extend({
  data: z
    .union([z.array(frequentContactSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** Clear-history and clear-by-id routes return a status word or a row count. */
export const kallClearResponseSchema = kallEnvelopeSchema.extend({
  data: z.union([z.string(), z.number(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type KallMaster = z.infer<typeof kallMasterSchema>;
export type KallDetail = z.infer<typeof kallDetailSchema>;
export type FrequentContact = z.infer<typeof frequentContactSchema>;
