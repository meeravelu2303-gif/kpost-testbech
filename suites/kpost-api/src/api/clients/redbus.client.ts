import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the RedBus integration controller, in one place. */
export const REDBUS_PATHS = {
  updatecitylist: '/redbus/updatecitylist',
  citysuggestion: (cityname: string) => `/redbus/citysuggestion/${encodeURIComponent(cityname)}`,
  destinations: '/redbus/destinations/',
  availabletrips: '/redbus/availabletrips/',
  tripdetails: '/redbus/tripdetails/',
  tripdetailsV2: '/redbus/tripdetailsV2/',
  seatLayout: '/redbus/seatLayout/',
  boardingPoint: '/redbus/boardingPoint/',
  blockTicket: (kPostId: string) => `/redbus/blockTicket/${encodeURIComponent(kPostId)}`,
  getUpdatedFare: '/redbus/getUpdatedFare/',
  bookticket: '/redbus/bookticket',
  ticketdetails: '/redbus/ticketdetails/',
  cancelticket: '/redbus/cancelticket/',
  checkBookedTicket: '/redbus/checkBookedTicket/',
  getTicket: '/redbus/getTicket/',
} as const;

/** Template form for bug-ledger metadata, so findings group by route not by id. */
export const REDBUS_PATH_TEMPLATES = {
  citysuggestion: '/redbus/citysuggestion/{cityname}',
  blockTicket: '/redbus/blockTicket/{kPostId}',
} as const;

/** Bare `@RequestMapping` routes — they answer EVERY HTTP verb. Iterated by the verb-binding tests. */
export const ALL_VERB_ROUTES = [
  REDBUS_PATHS.getTicket,
  REDBUS_PATHS.checkBookedTicket,
  REDBUS_PATHS.boardingPoint,
] as const;

// Shapes preserved on purpose: getTicket/checkBookedTicket/boardingPoint are bare @RequestMapping
// (answer any verb); blockTicket takes identity as a path variable; bookticket/cancelticket take none.
export class RedbusClient extends BaseClient {
  /** Administrative: bulk-refreshes the local city table from the partner API. */
  updatecitylist(options?: RequestOptions): Promise<APIResponse> {
    return this.get(REDBUS_PATHS.updatecitylist, options);
  }

  /** Type-ahead against the locally cached city catalogue. */
  citysuggestion(cityname: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(REDBUS_PATHS.citysuggestion(cityname), options);
  }

  /** Cities reachable from a given source. */
  destinations(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.destinations, data, options);
  }

  /** Search bookable trips on a route and date. */
  availabletrips(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.availabletrips, data, options);
  }

  /** Detail for one trip. */
  tripdetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.tripdetails, data, options);
  }

  /** V2 trip detail, bound to `TripDetailsRequest` rather than `RedBusSearch`. */
  tripdetailsV2(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.tripdetailsV2, data, options);
  }

  /** Seat map for a trip. */
  seatLayout(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.seatLayout, data, options);
  }

  /** Boarding/dropping points. Bare `@RequestMapping` — answers any verb. */
  boardingPoint(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.boardingPoint, data, options);
  }

  /** Hold seats ahead of payment. Identity comes from the path, not the token. */
  blockTicket(kPostId: string, data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.blockTicket(kPostId), data, options);
  }

  /** Re-quote the fare on a held PNR. */
  getUpdatedFare(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.getUpdatedFare, data, options);
  }

  /** Confirm a held PNR into a paid ticket. Takes no identity argument. */
  bookticket(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.bookticket, data, options);
  }

  /** Detail for a booked ticket. */
  ticketdetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.ticketdetails, data, options);
  }

  /** Cancel a ticket, wholly or by seat. Takes no identity argument. */
  cancelticket(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.cancelticket, data, options);
  }

  /** Booking lookup. Bare `@RequestMapping` — answers any verb. */
  checkBookedTicket(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(REDBUS_PATHS.checkBookedTicket, data, options);
  }

  /** The caller's own tickets, scoped by the token. Bare `@RequestMapping`. */
  getTicket(options?: RequestOptions): Promise<APIResponse> {
    return this.get(REDBUS_PATHS.getTicket, options);
  }

  /** Issues an arbitrary verb against a route, for the verb-binding cases. */
  sendVerb(
    method: 'get' | 'delete' | 'put' | 'patch' | 'head' | 'options',
    path: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.fetchWithVerb(method, path, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
