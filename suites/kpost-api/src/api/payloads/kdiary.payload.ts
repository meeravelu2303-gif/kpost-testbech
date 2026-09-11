import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';
import { KALL_MODE, KDIARY_REMARKS } from '../enums/kpostTypes';

/**
 * Request builders for the Kdiary controller (`/dairySchedule/**`).
 *
 * Two safety rules are baked into the defaults, because this suite runs against a live,
 * stateful backend:
 *
 *  - `eventID` and report `id` default to implausibly high values that must not resolve to a
 *    real record. `deleteEvent` and `deleteReport` are not reversible through the API, so a
 *    builder must never default to something that could be a live diary entry.
 *  - Schedules are created in the **future** and titled with `qaLabel`, so anything this
 *    suite leaves behind is recognisable and never collides with a real appointment.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** An event id that must not resolve to a real diary entry. */
/**
 * A well-formed participant id that is not a real subscriber. Adding someone to a schedule
 * invites and notifies them, so participants are always synthetic.
 */
export function syntheticParticipant(): string {
  return `qa-participant-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@kpostindia.com`;
}

export function nonExistentEventId(): number {
  return 999_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** A report id that must not resolve to a real report. */
export function nonExistentReportId(): number {
  return 998_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/**
 * ISO-8601 `yyyy-MM-ddTHH:mm:ss` (string), the schedule-boundary format the diary routes use.
 * The endpoints accept either an epoch or an ISO value, but it must be sent AS A STRING — this
 * emits the ISO form the Excel `[E]` bodies show (`2026-06-15T13:05:00`).
 */
export function diaryTimestamp(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/** `yyyy-MM-dd` for the date-filter routes. */
export function diaryDate(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface DiarySchedulePayload {
  title: string;
  description: string;
  priority: number;
  type: number;
  scheduleStartDateAndTime: string;
  scheduleEndDateAndTime: string;
  isReminder: boolean;
  isKoolKall: boolean;
  [key: string]: unknown;
}

/**
 * The `DiarySchedule` DTO, used by createSchedule, updateEvent, editScheduleEvent,
 * deleteEvent, addparticipants and getEventSelectedDate.
 *
 * Note `preferredDays` and friends are **strings** on this DTO but **arrays** on `KdiaryRO`,
 * so the two builders below deliberately differ on those fields rather than sharing one shape.
 */
export function buildSchedulePayload(
  overrides: Record<string, unknown> = {},
): DiarySchedulePayload {
  return {
    title: qaLabel('schedule'),
    description: faker.lorem.sentence(),
    priority: 1,
    type: 1,
    // Excel createSchedule also carries: kallSession, meetingLink, snoozeDetails.
    kallSession: `Koolkallsession${faker.string.alphanumeric(6)}`,
    meetingLink: `KoolKall${faker.string.alphanumeric(7)}`,
    snoozeDetails: '{"reminderBeforeMinutes":15,"snoozeEnabled":true}',
    // Always in the future: a past schedule would fire reminders immediately.
    scheduleStartDateAndTime: diaryTimestamp(60),
    scheduleEndDateAndTime: diaryTimestamp(120),
    isReminder: false,
    isKoolKall: false,
    kallMode: KALL_MODE.audio,
    preferredDays: '',
    preferredWeek: '',
    preferredDate: '',
    preferredMonth: '',
    participants: [{ participant: syntheticParticipant(), userType: 'PERSONAL' }],
    ...overrides,
  } as DiarySchedulePayload;
}

/**
 * A `DiarySchedule` addressing an existing record. Defaults to a non-existent id.
 *
 * Excel row 6 (updateEvent) documents `{ eventID, repeat, weekly }` — the two recurrence flags
 * decide whether the edit applies to one occurrence or the whole series, so leaving them unsent
 * meant no case could ever exercise the series branch.
 */
export function buildExistingSchedulePayload(
  overrides: Record<string, unknown> = {},
): DiarySchedulePayload {
  return buildSchedulePayload({
    eventID: nonExistentEventId(),
    repeat: false,
    weekly: false,
    ...overrides,
  });
}

/**
 * The `KdiaryRO` DTO, used by createEvent, getEventDate and updateScheduleRemarks.
 *
 * It carries a `kpostID` the client controls. On `updateScheduleRemarks` the controller
 * overwrites that from the bearer token, but on `getEventDate` it does not — which is exactly
 * what the ownership tests target.
 */
export function buildKdiaryROPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: qaLabel('event'),
    description: faker.lorem.sentence(),
    priority: 1,
    type: 1,
    scheduleStartDateAndTime: diaryTimestamp(60),
    scheduleEndDateAndTime: diaryTimestamp(120),
    // Excel createEvent also carries: snoozeDetails (stringified JSON) and seriesEndDate.
    snoozeDetails: '{"reminderBeforeMinutes":15,"snoozeEnabled":true}',
    seriesEndDate: diaryDate(30),
    isReminder: false,
    isKoolKall: false,
    kallMode: KALL_MODE.audio,
    // Array-typed on this DTO, unlike DiarySchedule.
    preferredDays: [],
    preferredWeek: [],
    preferredDate: [],
    preferredMonth: [],
    receiverList: [],
    repeatDate: [],
    eventIds: [],
    repeat: false,
    daily: false,
    weekly: false,
    monthly: false,
    participants: [{ participant: syntheticParticipant(), userType: 'PERSONAL' }],
    ...overrides,
  };
}

/** A remarks update against an existing event. Defaults to a non-existent id. */
export function buildRemarksPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildKdiaryROPayload({
    eventID: nonExistentEventId(),
    eventIds: [nonExistentEventId()],
    remarks: KDIARY_REMARKS.completed,
    remarksDescription: faker.lorem.sentence(),
    ...overrides,
  });
}

/** A date filter for getEventDate / getEventSelectedDate. */
export function buildDateFilterPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildKdiaryROPayload({
    scheduleStartDateAndTime: `${diaryDate()} 00:00:00`,
    scheduleEndDateAndTime: `${diaryDate()} 23:59:59`,
    preferredDate: [diaryDate()],
    ...overrides,
  });
}

/**
 * The `KdiaryReportRO` DTO — save, edit and delete of the daily task report.
 *
 * `kpostID` is present on the DTO but the controller overwrites it from the token on all
 * three routes, so a body value must never determine whose report is written.
 */
export function buildReportPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskReport: `${qaLabel('report')} :: ${faker.lorem.sentence()}`,
    ...overrides,
  };
}

/** A report edit/delete addressing an existing row. Defaults to a non-existent id. */
export function buildExistingReportPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildReportPayload({ id: nonExistentReportId(), ...overrides });
}

/** A participant list addition against an existing event. */
export function buildAddParticipantsPayload(
  overrides: Record<string, unknown> = {},
): DiarySchedulePayload {
  return buildSchedulePayload({
    eventID: nonExistentEventId(),
    participants: [
      {
        participant: syntheticParticipant(),
        userType: 'PERSONAL',
      },
    ],
    ...overrides,
  });
}
