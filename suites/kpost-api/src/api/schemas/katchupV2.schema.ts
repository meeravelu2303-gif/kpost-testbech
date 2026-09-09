import { z } from 'zod';

/**
 * Zod contracts for Katchup Messaging V2 (`/v2/katchup/**`).
 *
 * Katchup is the platform's private messaging surface, so the schemas here pin the fields
 * that must never reach the wrong reader — `actualMessage`, `sender`, `receiver`, `uuid` —
 * rather than leaving them to `passthrough`. Several ownership tests read them directly.
 *
 * `uuid` is the attachment handle. It is the *only* access control on two of the six download
 * routes, so wherever it appears in a response the tests treat it as a credential, not an
 * identifier.
 */

/** Envelope shared by Katchup success responses. */
export const katchupEnvelopeSchema = z
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
export const katchupErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** An attachment carried by a message. */
export const katchupAttachmentSchema = z
  .object({
    uuid: z.string().nullish(),
    fileName: z.string().nullish(),
    caption: z.string().nullish(),
    fileSize: z.union([z.number(), z.string()]).nullish(),
    contentType: z.string().nullish(),
    thumbnail: z.string().nullish(),
  })
  .passthrough();

/**
 * A Katchup message.
 *
 * `actualMessage` is the message body — the single most sensitive field in the module. Every
 * cross-tenant assertion in this tag ultimately asks whether it reached someone who is
 * neither the sender nor the receiver.
 */
export const katchupMessageSchema = z
  .object({
    msgID: z.number().nullish(),
    sender: z.string().nullish(),
    receiver: z.string().nullish(),
    messageType: z.union([z.number(), z.string()]).nullish(),
    actualMessage: z.string().nullish(),
    subject: z.string().nullish(),
    status: z.union([z.number(), z.string()]).nullish(),
    messageTime: z.union([z.string(), z.number()]).nullish(),
    readTime: z.union([z.string(), z.number()]).nullish(),
    serverTime: z.union([z.string(), z.number()]).nullish(),
    deviceID: z.string().nullish(),
    sessionID: z.string().nullish(),
    groupFlag: z.union([z.boolean(), z.string()]).nullish(),
    isVanished: z.boolean().nullish(),
    isHtml: z.boolean().nullish(),
    markFlag: z.boolean().nullish(),
    referenceMsgID: z.union([z.number(), z.string()]).nullish(),
    temporaryMsgID: z.union([z.number(), z.string()]).nullish(),
    attachmentCaption: z.string().nullish(),
    uuid: z.union([z.array(z.string()), z.string()]).nullish(),
    mapDetails: z.string().nullish(),
    secretMessageExpireTime: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

/** Routes returning one or many messages. */
export const katchupMessageResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([
      z.array(katchupMessageSchema),
      katchupMessageSchema,
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** Message list / search / filter responses. */
export const katchupMessageListResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([z.array(katchupMessageSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** A frequently-contacted correspondent. */
export const frequentContactSchema = z
  .object({
    kpostID: z.string().nullish(),
    name: z.string().nullish(),
    messageCount: z.number().nullish(),
    profileImage: z.string().nullish(),
  })
  .passthrough();

export const frequentContactsResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([z.array(frequentContactSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** Unread counters — a bare number, or an object of several counters. */
export const katchupCountResponseSchema = katchupEnvelopeSchema.extend({
  data: z.union([z.number(), z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** Abuse reports. */
export const reportMessageSchema = z
  .object({
    reportID: z.union([z.number(), z.string()]).nullish(),
    msgID: z.union([z.number(), z.string()]).nullish(),
    kpostID: z.string().nullish(),
    reportingKpostID: z.string().nullish(),
    reason: z.string().nullish(),
    reportedDate: z.string().nullish(),
  })
  .passthrough();

export const reportMessageResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([z.array(reportMessageSchema), reportMessageSchema, z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * Attachment upload / pre-signed URL responses.
 *
 * A pre-signed S3 URL is a bearer credential in link form: whoever holds it can fetch the
 * object without any KPOST token. It is pinned so tests can assert one is never handed to a
 * caller who has no claim on the attachment.
 */
export const attachmentResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([
      z.array(katchupAttachmentSchema),
      katchupAttachmentSchema,
      z.record(z.string(), z.unknown()),
      z.string(),
      z.null(),
    ])
    .optional(),
});

/** Deleted-message id sync. */
export const deletedIdsResponseSchema = katchupEnvelopeSchema.extend({
  data: z
    .union([z.array(z.union([z.number(), z.string()])), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

export type KatchupMessage = z.infer<typeof katchupMessageSchema>;
export type KatchupAttachment = z.infer<typeof katchupAttachmentSchema>;
export type ReportMessage = z.infer<typeof reportMessageSchema>;
