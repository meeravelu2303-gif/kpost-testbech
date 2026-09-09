import { z } from 'zod';

/**
 * Zod contracts for the KWord Documents controller (`/kword/**`).
 *
 * `create` returns the generated `docId` that every other route on this tag needs, so that
 * field is pinned explicitly — a missing identifier is a functional defect, not a cosmetic
 * one, because the editor cannot address the document it just created.
 *
 * The heading tree is modelled loosely: it is recursive in the API and its depth is not
 * documented, so the schema pins the fields the tests reason about and lets the rest through.
 */

/** Envelope shared by KWord success responses. */
export const kwordEnvelopeSchema = z
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
export const kwordErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    errorValue: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** One node in a document's heading tree. */
export const kwordHeadingSchema = z
  .object({
    headingId: z.number().nullish(),
    heading: z.string().nullish(),
    content: z.string().nullish(),
    docId: z.string().nullish(),
  })
  .passthrough();

/** A document record as returned by create, update and the detail read. */
export const kwordDocumentSchema = z
  .object({
    docId: z.string().nullish(),
    docTitle: z.string().nullish(),
    titleOfDocument: z.string().nullish(),
    subject: z.string().nullish(),
    documentType: z.string().nullish(),
    kpostID: z.string().nullish(),
    initiatedBy: z.string().nullish(),
    convertToKad: z.boolean().nullish(),
    compose: z.string().nullish(),
    heading: z.array(kwordHeadingSchema).nullish(),
  })
  .passthrough();

/** POST /kword/create — `data` must carry the generated docId. */
export const createDocumentResponseSchema = kwordEnvelopeSchema.extend({
  data: z.union([kwordDocumentSchema, z.array(kwordDocumentSchema), z.null()]).optional(),
});

/** POST /kword/update, /kword/saveContent, /kword/isConvertToKad. */
export const documentMutationResponseSchema = kwordEnvelopeSchema.extend({
  data: z
    .union([kwordDocumentSchema, z.array(kwordDocumentSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** GET /kword/documents/{docId} — the full document the editor loads. */
export const documentDetailResponseSchema = kwordEnvelopeSchema.extend({
  data: z.union([kwordDocumentSchema, z.array(kwordDocumentSchema), z.null()]).optional(),
});

/** GET /kword/documentsType and /kword/documentsType1 — summary records. */
export const documentListResponseSchema = kwordEnvelopeSchema.extend({
  data: z
    .union([z.array(kwordDocumentSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** One share record linking a document to a recipient. */
export const kwordShareSchema = z
  .object({
    docId: z.string().nullish(),
    kpostID: z.string().nullish(),
    sharedBy: z.string().nullish(),
    isEdit: z.boolean().nullish(),
  })
  .passthrough();

/** POST /kword/share */
export const shareDocumentResponseSchema = kwordEnvelopeSchema.extend({
  data: z
    .union([z.array(kwordShareSchema), kwordShareSchema, z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * POST /kword/delete and /kword/deleteHeading.
 *
 * The service returns 1 when a matching owned row was removed and any other value when none
 * was found, so `data` is a bare number here rather than a record.
 */
export const deleteResponseSchema = kwordEnvelopeSchema.extend({
  data: z.union([z.number(), z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type KwordDocument = z.infer<typeof kwordDocumentSchema>;
export type KwordHeading = z.infer<typeof kwordHeadingSchema>;
