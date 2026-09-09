import { z } from 'zod';

/**
 * Loose base envelope. Many endpoints in swagger.json only declare their 200 response
 * as a bare "string" (Spring `ResponseEntity<Object>` swagger couldn't infer), but the
 * API's documented contract (info.description) is:
 *   { status, statusCode, urlPath, msg|data }
 * This schema validates that documented contract loosely (fields optional, extra
 * fields allowed) so it's safe to use as a baseline against every endpoint.
 */
export const looseEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    urlPath: z.string().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
    errorMsg: z.string().nullish(),
    errorValue: z.string().nullish(),
  })
  .passthrough();

export type LooseEnvelope = z.infer<typeof looseEnvelopeSchema>;

/**
 * Standard error envelope used consistently across 401/403 responses in the spec.
 */
export const errorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    urlPath: z.string().optional(),
  })
  .passthrough();

/**
 * Structured success envelope used by endpoints that declare a real `data` object
 * (e.g. updateBasicInformation, sendOTP, advancedSearch).
 *
 * `status` is typed as a plain string, not the spec's `Success|Failure|Error` enum: the
 * live API actually emits UPPERCASE (`SUCCESS`/`FAILURE`). Enforcing the documented casing
 * here would fail every single assertion on the same known deviation, so it is asserted
 * once by a dedicated contract test instead (see DOCUMENTED_STATUS_VALUES).
 */
export const dataEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    message: z.string().nullish(),
    urlPath: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Casing exactly as documented in swagger.json. */
export const DOCUMENTED_STATUS_VALUES = ['Success', 'Failure', 'Error'] as const;

/** Strict variant used only by the dedicated envelope-contract test. */
export const strictDocumentedEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.enum(DOCUMENTED_STATUS_VALUES),
    message: z.string().nullish(),
    urlPath: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();
