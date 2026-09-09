import { z } from 'zod';

/**
 * Zod contracts for the RedBus integration (`/redbus/**`).
 *
 * **This tag does not use the platform envelope.** Every other controller answers
 * `{ statusCode, status, urlPath, data|msg }`. RedBus answers
 * `{ status, value, errorcode, errorvalue }` — no `statusCode`, no `urlPath`, and the payload
 * lives under `value` rather than `data`. A client written against the documented platform
 * contract cannot read these responses at all, so the deviation is pinned here and asserted
 * rather than smoothed over.
 *
 * The absence of `statusCode` also means `assertStatusCodeParity` has nothing to compare on
 * this tag; the parity story is instead "HTTP 200 with `status: FAILURE`", which is the
 * normal shape for every upstream error.
 */

/** The bespoke RedBus envelope. `errorcode`/`errorvalue` carry "Not Applicable" on success. */
export const redbusEnvelopeSchema = z
  .object({
    status: z.string(),
    value: z.unknown().optional(),
    errorcode: z.union([z.string(), z.number(), z.null()]).optional(),
    errorvalue: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

/** Error shape produced by the platform's own filter, not the RedBus controller. */
export const redbusErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    message: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** A serviceable city in the RedBus catalogue. */
export const redbusCitySchema = z
  .object({
    id: z.number().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();

/** GET /redbus/citysuggestion/{cityname} — a flat list of matches. */
export const citySuggestionResponseSchema = redbusEnvelopeSchema.extend({
  value: z.union([z.array(redbusCitySchema), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** POST /redbus/destinations/ — `value` wraps the list in a `cities` key. */
export const destinationsResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([
      z.object({ cities: z.array(redbusCitySchema).nullish() }).passthrough(),
      z.array(redbusCitySchema),
      z.null(),
    ])
    .optional(),
});

/** A bookable trip returned by the search. */
export const redbusTripSchema = z
  .object({
    availableTripId: z.union([z.number(), z.string()]).nullish(),
    travelsName: z.string().nullish(),
    busType: z.string().nullish(),
    departureTime: z.string().nullish(),
    arrivalTime: z.string().nullish(),
    fare: z.union([z.number(), z.string()]).nullish(),
    availableSeats: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

/** Search, trip-detail and seat-layout responses — shapes come from the partner jar. */
export const redbusTripListResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([
      z.array(redbusTripSchema),
      z.record(z.string(), z.unknown()),
      z.array(z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** A boarding or dropping point. */
export const boardingPointSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullish(),
    name: z.string().nullish(),
    time: z.string().nullish(),
    landmark: z.string().nullish(),
    address: z.string().nullish(),
  })
  .passthrough();

export const boardingPointResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([
      z.array(boardingPointSchema),
      z.record(z.string(), z.unknown()),
      z.array(z.unknown()),
      z.null(),
    ])
    .optional(),
});

/**
 * A booked ticket.
 *
 * The passenger fields are pinned deliberately: they are exactly what must never appear in a
 * response to someone who is not the traveller, and the ownership tests read them.
 */
export const redbusTicketSchema = z
  .object({
    ticketNumber: z.union([z.string(), z.number()]).nullish(),
    tin: z.union([z.string(), z.number()]).nullish(),
    pnr: z.union([z.string(), z.number()]).nullish(),
    kpostID: z.string().nullish(),
    passengerName: z.string().nullish(),
    passengerMobile: z.union([z.string(), z.number()]).nullish(),
    passengerEmail: z.string().nullish(),
    seatNumbers: z.union([z.string(), z.array(z.unknown())]).nullish(),
    fare: z.union([z.number(), z.string()]).nullish(),
    travelDate: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

/** getTicket / ticketdetails / checkBookedTicket. */
export const redbusTicketResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([
      z.array(redbusTicketSchema),
      redbusTicketSchema,
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** blockTicket — returns the temporary PNR that bookticket later confirms. */
export const blockTicketResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([
      z.object({ tempPNR: z.union([z.string(), z.number()]).nullish() }).passthrough(),
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
});

/** bookticket / cancelticket / getUpdatedFare — partner objects, envelope pinned only. */
export const redbusOperationResponseSchema = redbusEnvelopeSchema.extend({
  value: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.null()])
    .optional(),
});

export type RedbusCity = z.infer<typeof redbusCitySchema>;
export type RedbusTicket = z.infer<typeof redbusTicketSchema>;
export type RedbusTrip = z.infer<typeof redbusTripSchema>;
