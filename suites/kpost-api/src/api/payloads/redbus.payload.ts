import { faker } from '../../utils/dataGen';

/**
 * Request builders for the RedBus integration (`/redbus/**`).
 *
 * **This tag talks to a live third-party booking system.** `blockTicket`, `bookticket` and
 * `cancelticket` place, confirm and cancel real reservations against the RedBus partner API,
 * consuming real inventory and moving real money. That constrains every builder here:
 *
 *  - `tempPNR` and `ticketNumber` default to **provably non-existent** references. A builder
 *    must never default to a value that could match a live booking — confirming a stranger's
 *    held seat or cancelling their ticket is not a recoverable test side effect.
 *  - Passenger details are obviously-synthetic QA values, never faker-generated names and
 *    numbers that could resemble a real traveller on a real manifest.
 *  - Travel dates are far in the future, where inventory is thin and a stray hold expires
 *    long before it could matter.
 *
 * The booking routes are therefore exercised on **refusal paths only**, exactly as the suite
 * already treats account deactivation and password changes. There is no happy-path booking
 * test and there should not be one.
 *
 * `updatecitylist` has no builder: it is a GET that bulk-rewrites the local city table and
 * consumes upstream quota, so it is an administrative task rather than something a test
 * matrix should hammer.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>`: the fuzzing suites submit
 * wrong-typed values deliberately, which a strict override type would forbid.
 */

/** Chennai — a stable, real city id, used so searches exercise a genuine route. */
export const SOURCE_CITY_ID = 122;
/** Bangalore. */
export const DESTINATION_CITY_ID = 124;

/** A PNR that cannot match a live hold. */
export function nonExistentTempPnr(): string {
  return `QA-NOPNR-${faker.string.alphanumeric({ length: 10, casing: 'upper' })}`;
}

/** A ticket number that cannot match a live booking. */
export function nonExistentTicketNumber(): string {
  return `QA-NOTIN-${faker.string.alphanumeric({ length: 10, casing: 'upper' })}`;
}

/** A trip id well outside the partner's allocated range. */
export function nonExistentTripId(): number {
  return 996_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** `yyyy-MM-dd`, far enough out that a stray hold cannot affect real travel. */
export function futureTravelDate(daysAhead = 120): string {
  const at = new Date(Date.now() + daysAhead * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The `RedBusSearch` DTO — shared by destinations, availabletrips, tripdetails, seatLayout,
 * getUpdatedFare, boardingPoint, ticketdetails, checkBookedTicket, bookticket and
 * cancelticket.
 *
 * One DTO covering both a city search and a ticket cancellation is itself notable: the same
 * object carries `sourceCityID` and `seatsToCancel`, so no route can validate it meaningfully
 * and every field is optional from the binder's point of view.
 */
export function buildRedbusSearchPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sourceCityID: SOURCE_CITY_ID,
    destinationCityID: DESTINATION_CITY_ID,
    travelDate: futureTravelDate(),
    ...overrides,
  };
}

/** A destinations lookup — only the source city matters. */
export function buildDestinationsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { sourceCityID: SOURCE_CITY_ID, ...overrides };
}

/** An available-trips search on a real route, far in the future. */
export function buildAvailableTripsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildRedbusSearchPayload(overrides);
}

/** A trip-detail lookup. Excel: `{ tripID }`. Defaults to a trip id that cannot resolve. */
export function buildTripDetailsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { tripID: String(nonExistentTripId()), ...overrides };
}

/** The V2 trip-detail route. Excel: `{ inventoryId }`. */
export function buildTripDetailsV2Payload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    inventoryId: String(nonExistentTripId()),
    ...overrides,
  };
}

/**
 * The `BlockRequest` DTO — holds seats ahead of payment.
 *
 * Defaults to a non-existent trip so the hold cannot succeed. Passenger details are
 * unmistakably synthetic; a held seat carries a name onto a real manifest.
 */
export function buildBlockTicketPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  // Excel blockTicket: { availableTripId, boardingPointId, destination, source, inventoryItems:
  // [{ fare, ladiesSeat, passenger: { address, age, email, gender, idNumber, idType, mobile,
  // name, primary, title, seatName } }] }. seatName lives inside passenger, not on the item.
  return {
    availableTripId: String(nonExistentTripId()),
    boardingPointId: 1,
    destination: DESTINATION_CITY_ID,
    source: SOURCE_CITY_ID,
    inventoryItems: [
      {
        fare: 1,
        ladiesSeat: false,
        passenger: {
          address: 'QA Automation - do not deliver',
          age: '30',
          email: 'qa-test@example.com',
          gender: 'male',
          idNumber: 'QA0000',
          idType: 'PAN_CARD',
          mobile: '9000000000',
          name: 'QA AUTOMATION DO NOT BOARD',
          primary: 'true',
          title: 'Mr',
          seatName: 'QA1',
        },
      },
    ],
    ...overrides,
  };
}

/**
 * A booking confirmation. Defaults to a non-existent tempPNR.
 *
 * `bookticket` takes no identity argument at all — no `HttpServletRequest`, no path variable —
 * so the only thing standing between a caller and someone else's held seat is knowing the
 * PNR. That is what the ownership tests probe, and why this builder must never emit a real one.
 */
export function buildBookTicketPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { tempPNR: nonExistentTempPnr(), ...overrides };
}

/**
 * A cancellation. Defaults to a non-existent ticket number.
 *
 * `cancelticket` likewise takes no identity argument, so a ticket number alone is enough to
 * cancel a stranger's travel. Never default this to anything that could resolve.
 */
export function buildCancelTicketPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ticketNumber: nonExistentTicketNumber(),
    seatsToCancel: ['QA1'],
    ...overrides,
  };
}

/** A ticket-detail lookup. Defaults to a non-existent ticket number. */
export function buildTicketDetailsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ticketNumber: nonExistentTicketNumber(), ...overrides };
}

/** A fare re-quote against a held PNR. */
export function buildUpdatedFarePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { tempPNR: nonExistentTempPnr(), ...overrides };
}

/** A boarding-point lookup for a trip. */
// Excel spec: `{ boardingID, tripID }`.
export function buildBoardingPointPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    boardingID: String(nonExistentTripId()),
    tripID: String(nonExistentTripId()),
    ...overrides,
  };
}
