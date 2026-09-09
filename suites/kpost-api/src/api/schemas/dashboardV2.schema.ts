import { z } from 'zod';

/**
 * Zod contracts for the Dashboard V2 controller (`/v2/dashboard/**`).
 *
 * swagger.json declares every 200 response on this tag as a bare `string` (Spring
 * `ResponseEntity<Object>`, which the generator could not introspect), while the platform's
 * documented envelope is `{ status, statusCode, urlPath, msg|data }`. These schemas encode
 * the documented envelope and keep `data` opaque, so a contract failure means the envelope
 * itself is wrong rather than that a nested field drifted.
 *
 * `status` is typed as a plain string rather than the documented `Success|Failure` enum
 * because the live API emits UPPERCASE (`SUCCESS`/`FAILURE`). That casing deviation is
 * asserted once, by a dedicated contract test, instead of failing every assertion here.
 */

/** Envelope shared by every Dashboard V2 success response. */
export const dashboardEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/500 across the tag. */
export const dashboardErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    errorcode: z.string().nullish(),
    errorValue: z.string().nullish(),
  })
  .passthrough();

/** A Katchup message row as surfaced on the dashboard. */
export const katchupDashboardRowSchema = z
  .object({
    msgID: z.number().nullish(),
    sender: z.string().nullish(),
    receiver: z.string().nullish(),
    messageType: z.number().nullish(),
    actualMessage: z.string().nullish(),
    status: z.number().nullish(),
    messageTime: z.string().nullish(),
  })
  .passthrough();

export const katchupDashboardResponseSchema = dashboardEnvelopeSchema.extend({
  data: z.union([z.array(katchupDashboardRowSchema), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** A Kall (voice/video) history row. */
export const kallDashboardRowSchema = z
  .object({
    kallID: z.number().nullish(),
    sender: z.string().nullish(),
    receiver: z.string().nullish(),
    kalltype: z.string().nullish(),
    kallStatus: z.string().nullish(),
    kallStartTime: z.string().nullish(),
    kallEndTime: z.string().nullish(),
    callDuration: z.string().nullish(),
  })
  .passthrough();

export const kallDashboardResponseSchema = dashboardEnvelopeSchema.extend({
  data: z.union([z.array(kallDashboardRowSchema), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** Home dashboard aggregates — shape varies, so only the envelope is pinned. */
export const homeDashboardResponseSchema = dashboardEnvelopeSchema;

/** A Kmail row on the dashboard. */
export const kmailDashboardRowSchema = z
  .object({
    kmailID: z.number().nullish(),
    kpostUser: z.string().nullish(),
    selectedContact: z.string().nullish(),
    kmailStatusFlag: z.number().nullish(),
    kmailNumber: z.number().nullish(),
  })
  .passthrough();

export const kmailDashboardResponseSchema = dashboardEnvelopeSchema.extend({
  data: z.union([z.array(kmailDashboardRowSchema), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type DashboardEnvelope = z.infer<typeof dashboardEnvelopeSchema>;
export type KatchupDashboardResponse = z.infer<typeof katchupDashboardResponseSchema>;
export type KallDashboardResponse = z.infer<typeof kallDashboardResponseSchema>;
export type KmailDashboardResponse = z.infer<typeof kmailDashboardResponseSchema>;
