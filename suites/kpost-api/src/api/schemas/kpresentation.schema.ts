import { z } from 'zod';

/**
 * Zod contracts for the KPresentation controller (`/kpresentation/**`).
 *
 * The delete route is the reason `msg` is pinned rather than left to `passthrough`: success
 * and not-found both answer HTTP 200 with `statusCode: 200`, and are distinguished only by
 * `status` (`Success` vs `Failure`) and the message text. A client that keys on the status
 * code alone cannot tell a deletion from a no-op, so the tests read those two fields.
 */

/** Envelope shared by KPresentation success responses. */
export const kpresentationEnvelopeSchema = z
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
export const kpresentationErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** A presentation record. `slides` is a serialised blob in the API, not a structured list. */
export const presentationSchema = z
  .object({
    presentationId: z.number().nullish(),
    presentationTitle: z.string().nullish(),
    titleOfPresentation: z.string().nullish(),
    subject: z.string().nullish(),
    topic: z.string().nullish(),
    subTopic: z.string().nullish(),
    kpostID: z.string().nullish(),
    slides: z.string().nullish(),
  })
  .passthrough();

/** POST /kpresentation/create — `data` must carry the generated presentationId. */
export const createPresentationResponseSchema = kpresentationEnvelopeSchema.extend({
  data: z.union([presentationSchema, z.array(presentationSchema), z.null()]).optional(),
});

/** POST /kpresentation/savePresentation — returns the refreshed record. */
export const savePresentationResponseSchema = kpresentationEnvelopeSchema.extend({
  data: z
    .union([presentationSchema, z.array(presentationSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * GET /kpresentation/presentations — lightweight summaries, deliberately without slide
 * content. `slides` stays in the schema so a test can assert it is absent from the listing.
 */
export const presentationListResponseSchema = kpresentationEnvelopeSchema.extend({
  data: z
    .union([z.array(presentationSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** GET /kpresentation/presentations/{presentationId} — the full deck the editor loads. */
export const presentationDetailResponseSchema = kpresentationEnvelopeSchema.extend({
  data: z.union([presentationSchema, z.array(presentationSchema), z.null()]).optional(),
});

/**
 * GET /kpresentation/delete — a numeric outcome: 1 for deleted, anything else for
 * "no matching owned record".
 */
export const deletePresentationResponseSchema = kpresentationEnvelopeSchema.extend({
  data: z.union([z.number(), z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type Presentation = z.infer<typeof presentationSchema>;
