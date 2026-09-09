import { z } from 'zod';

/**
 * The response envelopes this API actually emits.
 *
 * KMail returns at least three distinct shapes and the specs have to tell them apart, because
 * a helper that treats them as one cannot decide whether a call succeeded:
 *
 *  1. **The platform envelope** — `{ urlPath, status, statusCode, data|msg }`. `status` is a
 *     word (`SUCCESS`/`FAILURE`) and `statusCode` a number, and the two disagree with the
 *     transport status often enough that `assertStatusCodeParity` exists for it.
 *  2. **The auth-filter envelope** — `{ status: "UNAUTHORIZED", timestamp, message,
 *     debugMessage }`. No `statusCode`, no `urlPath`; a different code path entirely, which is
 *     why `errorEnvelopeSchema` cannot require either field.
 *  3. **Spring's own default error body** — `{ timestamp, status, error, trace, message,
 *     path }`, produced when Jackson fails to bind the request. `status` is a **number** here
 *     while it is a **string** in the other two, so anything reading `status` without checking
 *     the type will silently misread it.
 *
 * Every schema below is `passthrough`: pinning the fields that carry meaning, while letting
 * the service add whatever else it likes without failing a contract assertion for it.
 */

/**
 * Loose base envelope, safe to apply to any response.
 *
 * `status` accepts a string **or** a number precisely because of shape 3 above. Typing it as
 * a string would make every Jackson bind failure report a schema violation on top of the real
 * finding, which is a second ticket describing the same event.
 */
export const looseEnvelopeSchema = z
  .object({
    status: z.union([z.string(), z.number()]).optional(),
    statusCode: z.number().optional(),
    urlPath: z.string().nullish(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type LooseEnvelope = z.infer<typeof looseEnvelopeSchema>;

/**
 * The envelope carried by 4xx/5xx responses.
 *
 * Every field is optional. Three different components produce error bodies here — the auth
 * filter, the controllers' own handler, and Spring's default — and they share no mandatory
 * field between them. Requiring any one of them would report a contract violation on a
 * perfectly ordinary rejection.
 */
export const errorEnvelopeSchema = z
  .object({
    status: z.union([z.string(), z.number()]).optional(),
    statusCode: z.number().optional(),
    urlPath: z.string().nullish(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    debugMessage: z.string().nullish(),
    timestamp: z.union([z.string(), z.number()]).nullish(),
    error: z.string().nullish(),
    path: z.string().nullish(),
  })
  .passthrough();

/**
 * The structured success envelope — asserted where the route genuinely returns one.
 *
 * `status` is typed as a plain string rather than an enum: the service emits UPPERCASE
 * (`SUCCESS`/`FAILURE`) while OpenAPI documentation across the platform describes title case.
 * Enforcing the documented casing here would fail every assertion in the suite on one known
 * deviation and drown everything else, so it is asserted once, on its own, by the envelope
 * contract test in `tests/folders/`.
 */
export const dataEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    urlPath: z.string().nullish(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Casing exactly as the platform's own documentation describes it. */
export const DOCUMENTED_STATUS_VALUES = ['Success', 'Failure', 'Error'] as const;

/** Strict variant used only by the dedicated envelope-contract test. */
export const strictDocumentedEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.enum(DOCUMENTED_STATUS_VALUES),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();
