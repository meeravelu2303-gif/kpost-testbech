import { z } from 'zod';
import { looseEnvelopeSchema } from './envelope.schema';

/**
 * Zod contracts for the KMail API. Fields that must never reach the wrong reader are pinned by name
 * (`kmailContent`, `fromAddress`, `toAddress`, `bccList`, `uuid`, `password`) so ownership assertions
 * can read them and so one cannot silently vanish from a response. Everything else is optional and
 * `passthrough` — these are `ResponseEntity<Object>` routes whose payloads vary by branch.
 */

/* ============================================================================ pieces == */

/** An attachment record, as it appears inside a mail or draft. */
export const attachmentSchema = z
  .object({
    /** The attachment handle. On the UUID-addressed download routes it is the whole identity — tests treat it as a credential. */
    uuid: z.string().nullish(),
    fileName: z.string().nullish(),
    s3FileName: z.string().nullish(),
    filePath: z.string().nullish(),
    fileSize: z.union([z.number(), z.string()]).nullish(),
    caption: z.string().nullish(),
    s3ThumbnailFileName: z.string().nullish(),
    thumbnailFilePath: z.string().nullish(),
    deleteStatus: z.boolean().nullish(),
    createDate: z.string().nullish(),
  })
  .passthrough();

/** A mail as returned by the listing and read routes. */
export const kmailSchema = z
  .object({
    kmailID: z.number().nullish(),
    kmailNumber: z.number().nullish(),
    kmailType: z.union([z.string(), z.number()]).nullish(),
    kmailSubject: z.string().nullish(),
    /** The mail body. Every cross-tenant assertion in this suite ultimately asks about it. */
    kmailContent: z.string().nullish(),
    kmailSendDate: z.string().nullish(),
    fromAddress: z.string().nullish(),
    toAddress: z.string().nullish(),
    ccList: z.array(z.string()).nullish(),
    /** Blind copies. `getCopiesInfo` is documented to filter these — asserted in tests/read. */
    bccList: z.array(z.string()).nullish(),
    senderName: z.string().nullish(),
    receiverName: z.string().nullish(),
    senderUniqueMailID: z.string().nullish(),
    receiverUniqueMailID: z.string().nullish(),
    priority: z.number().nullish(),
    attachmentFlag: z.union([z.number(), z.boolean()]).nullish(),
    groupFlag: z.boolean().nullish(),
    saluation: z.string().nullish(),
    saluationName: z.string().nullish(),
    referenceKmailID: z.array(z.union([z.string(), z.number()])).nullish(),
    originalKmailID: z.number().nullish(),
    attachmentPath: z.array(attachmentSchema).nullish(),
    kmailAttachmetDetails: z.array(attachmentSchema).nullish(),
    transactionID: z.number().nullish(),
    openedStatus: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    importantFlag: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  })
  .passthrough();

/** A draft row from `TBL_KPOST_KMAIL_DRAFTS`. */
export const draftSchema = z
  .object({
    kmailID: z.number().nullish(),
    fromAddress: z.string().nullish(),
    toAddress: z.string().nullish(),
    kmailSubject: z.string().nullish(),
    kmailSendDate: z.string().nullish(),
    saluation: z.string().nullish(),
    saluationName: z.string().nullish(),
    priority: z.number().nullish(),
    /** A draft stores cc/bcc as single delimited STRINGS, not as the send DTO's arrays. */
    cc: z.string().nullish(),
    bcc: z.string().nullish(),
    draftMailID: z.string().nullish(),
    attachmentFlag: z.union([z.number(), z.boolean()]).nullish(),
    attachmentUuid: z.array(z.string()).nullish(),
    attachmentDetails: z.array(attachmentSchema).nullish(),
    groupFlag: z.boolean().nullish(),
    mailServerReferenceID: z.string().nullish(),
  })
  .passthrough();

/** An external (non-KPOST) contact. */
export const otherDomainContactSchema = z
  .object({
    id: z.number().nullish(),
    kpostID: z.string().nullish(),
    contactEmailID: z.string().nullish(),
    contactName: z.string().nullish(),
    referenceName: z.string().nullish(),
    blockedContactFlag: z.boolean().nullish(),
    deleteStatus: z.boolean().nullish(),
    subscribe: z.boolean().nullish(),
    createdDate: z.string().nullish(),
    modifiedDate: z.string().nullish(),
  })
  .passthrough();

/** A follow-up contact bucket entry, as returned by the status routes. */
export const followUpContactSchema = z
  .object({
    selectedContact: z.string().nullish(),
    contactName: z.string().nullish(),
    count: z.number().nullish(),
    kmailStatusFlag: z.number().nullish(),
    lastKmailID: z.number().nullish(),
  })
  .passthrough();

/* ========================================================================= envelopes == */

/** Any KMail response. The baseline every happy-path case can safely assert. */
export const kmailEnvelopeSchema = looseEnvelopeSchema;

/** A response whose `data` is a list of mails. */
export const kmailListResponseSchema = looseEnvelopeSchema.extend({
  data: z.array(kmailSchema).nullish(),
});

/** A response carrying exactly one mail, or its body. */
export const kmailContentResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([kmailSchema, z.array(kmailSchema), z.string()]).nullish(),
});

/** A response whose `data` is a list of drafts. */
export const draftListResponseSchema = looseEnvelopeSchema.extend({
  data: z.array(draftSchema).nullish(),
});

/** A response carrying a single numeric total, or a map of them. */
export const countResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.number(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
});

/** A response whose `data` is a list of contacts, KPOST or external. */
export const contactListResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.array(otherDomainContactSchema), z.record(z.string(), z.unknown())]).nullish(),
});

/** A response whose `data` is a list of follow-up buckets. */
export const followUpResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.array(followUpContactSchema), z.record(z.string(), z.unknown())]).nullish(),
});

/** A response whose `data` is a list of attachment records. */
export const attachmentResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.array(attachmentSchema), attachmentSchema, z.string()]).nullish(),
});

/** The assembled mail signature, or the raw `UsersKmailSetting` row. */
export const settingResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).nullish(),
});

/**
 * The mail-server credential response. `password` is pinned: this route reads the account from the
 * BODY not the token, so the ownership test must know whether a password field came back, not just the status.
 */
export const mailCredentialsResponseSchema = looseEnvelopeSchema.extend({
  data: z
    .object({
      kpostID: z.string().nullish(),
      password: z.string().nullish(),
      token: z.string().nullish(),
      mailServerHost: z.string().nullish(),
      mailServerPort: z.union([z.number(), z.string()]).nullish(),
    })
    .passthrough()
    .nullish(),
});

/** The translation response. */
export const translationResponseSchema = looseEnvelopeSchema.extend({
  data: z
    .object({
      msgToTranslate: z.string().nullish(),
      msgAfterTranslation: z.string().nullish(),
      msgTranslatedToLanguage: z.string().nullish(),
      msgTranslatedFromLanguage: z.string().nullish(),
    })
    .passthrough()
    .nullish(),
});

/** KLOUD storage consumption. */
export const kloudDataResponseSchema = looseEnvelopeSchema.extend({
  data: z.union([z.number(), z.string(), z.record(z.string(), z.unknown())]).nullish(),
});
