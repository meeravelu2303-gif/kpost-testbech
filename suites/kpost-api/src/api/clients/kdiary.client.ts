import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

// Note: the prefix is `/dairySchedule` (misspelled in the shipped API) — preserved on purpose.
export const KDIARY_PATHS = {
  createSchedule: '/dairySchedule/createSchedule',
  getTodaySchedules: '/dairySchedule/getTodaySchedules',
  updateScheduleRemarks: '/dairySchedule/updateScheduleRemarks',
  createEvent: '/dairySchedule/createEvent',
  updateEvent: '/dairySchedule/updateEvent',
  editScheduleEvent: '/dairySchedule/editScheduleEvent',
  getEvents: '/dairySchedule/getEvents',
  getEventDate: '/dairySchedule/getEventDate',
  getEventSelectedDate: '/dairySchedule/getEventSelectedDate',
  deleteEvent: '/dairySchedule/deleteEvent',
  addparticipants: '/dairySchedule/addparticipants',
  saveReport: '/dairySchedule/saveReport',
  editReport: '/dairySchedule/editReport',
  deleteReport: '/dairySchedule/deleteReport',
  getTodayReport: '/dairySchedule/getTodayReport',
} as const;

// Body-identity asymmetry (the finding): updateEvent, editScheduleEvent and getEventDate take the
// owning identity from the body, unlike their token-scoped siblings.
export class KdiaryClient extends BaseClient {
  /** Create a diary schedule owned by the token's user. */
  createSchedule(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.createSchedule, data, options);
  }

  /** Today's schedules merged with today's report, scoped to the token's user. */
  getTodaySchedules(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KDIARY_PATHS.getTodaySchedules, options);
  }

  /** Attach a remarks code and description to one or more events. */
  updateScheduleRemarks(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.updateScheduleRemarks, data, options);
  }

  /** Create a diary event (the KdiaryRO variant, with recurrence fields). */
  createEvent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.createEvent, data, options);
  }

  /** Persist edits to an existing event. Identity is taken from the body, not the token. */
  updateEvent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.updateEvent, data, options);
  }

  /** Edit a scheduled event. Identity is taken from the body, not the token. */
  editScheduleEvent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.editScheduleEvent, data, options);
  }

  /** List every event belonging to the token's user. */
  getEvents(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KDIARY_PATHS.getEvents, options);
  }

  /** Look up events by date. Identity is taken from the body, not the token. */
  getEventDate(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.getEventDate, data, options);
  }

  /** Look up events on a chosen date, scoped to the token's user. */
  getEventSelectedDate(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.getEventSelectedDate, data, options);
  }

  /** Delete an event. Scoped to the token's user; returns a row count. */
  deleteEvent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.deleteEvent, data, options);
  }

  /** Add participants to an existing event. */
  addparticipants(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.addparticipants, data, options);
  }

  /** Save the caller's daily task report. */
  saveReport(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.saveReport, data, options);
  }

  /** Edit an existing report row. */
  editReport(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.editReport, data, options);
  }

  /** Delete a report row. */
  deleteReport(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KDIARY_PATHS.deleteReport, data, options);
  }

  /** Today's report for the token's user. */
  getTodayReport(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KDIARY_PATHS.getTodayReport, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }

  /** Issues a GET against a POST-only route, for method-binding cases. */
  getRoute(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }
}
