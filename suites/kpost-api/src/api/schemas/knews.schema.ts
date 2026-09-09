import { z } from 'zod';

/**
 * Zod contracts for the Knews controller (`/v2/knews/**`).
 *
 * swagger.json declares every 200 on this tag as a bare `string` (Spring
 * `ResponseEntity<Object>`, which the generator could not introspect), while the platform's
 * documented envelope is `{ status, statusCode, urlPath, msg|data }`. These schemas pin the
 * documented envelope and keep `data` shaped per endpoint, so a contract failure means the
 * envelope itself drifted rather than an unrelated nested field.
 *
 * `status` is a plain string, not the documented `Success|Failure` enum, because the live
 * API emits UPPERCASE (`SUCCESS`/`FAILURE`). That deviation is asserted once by a dedicated
 * contract test instead of failing every assertion on this tag.
 */

/** Envelope shared by every Knews success response. */
export const knewsEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/404/500 across the tag. */
export const knewsErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
  })
  .passthrough();

/** A news category reference row. */
export const knewsCategorySchema = z
  .object({
    categoryId: z.number().nullish(),
    categoryName: z.string().nullish(),
    languageId: z.number().nullish(),
  })
  .passthrough();

/** GET /v2/knews/getAllCategories */
export const getAllCategoriesResponseSchema = knewsEnvelopeSchema.extend({
  data: z.union([z.array(knewsCategorySchema), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** A sub-category row, scoped to a parent category. */
export const knewsSubCategorySchema = z
  .object({
    subCategoryId: z.number().nullish(),
    subCategoryName: z.string().nullish(),
    categoryId: z.number().nullish(),
  })
  .passthrough();

/** POST /v2/knews/getSubCategoriesByCategoryId */
export const getSubCategoriesResponseSchema = knewsEnvelopeSchema.extend({
  data: z
    .union([z.array(knewsSubCategorySchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** A news source reference row. */
export const knewsNewsSourceSchema = z
  .object({
    newsSourceId: z.number().nullish(),
    newsSourceName: z.string().nullish(),
  })
  .passthrough();

/** GET /v2/knews/getAllNewsSource */
export const getAllNewsSourceResponseSchema = knewsEnvelopeSchema.extend({
  data: z
    .union([z.array(knewsNewsSourceSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** A publication row, scoped to a language. */
export const knewsPublicationSchema = z
  .object({
    publicationId: z.number().nullish(),
    publicationName: z.string().nullish(),
    languageId: z.number().nullish(),
  })
  .passthrough();

/** POST /v2/knews/getPublicationByLanguageId */
export const getPublicationByLanguageResponseSchema = knewsEnvelopeSchema.extend({
  data: z
    .union([z.array(knewsPublicationSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** The caller's persisted Knews preferences. */
export const knewsSettingsSchema = z
  .object({
    kpostId: z.string().nullish(),
    countryName: z.string().nullish(),
    stateName: z.string().nullish(),
    cityNames: z.string().nullish(),
    languageId: z.number().nullish(),
    newsType: z.string().nullish(),
    newsSource: z.string().nullish(),
    publications: z.string().nullish(),
    category: z.string().nullish(),
    subCategories: z.string().nullish(),
    retentionDays: z.number().nullish(),
    archiveDays: z.number().nullish(),
    subscriptionDetails: z.string().nullish(),
  })
  .passthrough();

/** GET /v2/knews/getKnewsSettings */
export const getKnewsSettingsResponseSchema = knewsEnvelopeSchema.extend({
  data: z.union([knewsSettingsSchema, z.array(knewsSettingsSchema), z.null()]).optional(),
});

/** POST /v2/knews/updateKnewsSettings */
export const updateKnewsSettingsResponseSchema = knewsEnvelopeSchema.extend({
  data: z.union([knewsSettingsSchema, z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type KnewsEnvelope = z.infer<typeof knewsEnvelopeSchema>;
export type KnewsSettings = z.infer<typeof knewsSettingsSchema>;
