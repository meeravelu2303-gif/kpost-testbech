import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for Kall (Voice/Video) V2 — `/v2/kall/**`.
 *
 * Safety rules baked into the defaults, because this suite runs against a live backend that
 * can place real calls and send real push notifications:
 *
 *  - `kallID` defaults to an implausibly high value that must not resolve to a real call.
 *    `clearKallBykallIds` and the end-call routes act on whatever they match.
 *  - `receiver` defaults to a **synthetic, non-existent** kpostID. Initiating a call rings a
 *    real handset; a faker-generated identity must never be a live subscriber.
 *  - Scheduled calls are always placed in the **future**, so a schedule created by a test
 *    cannot fire immediately.
 *
 * `clearKallHistory` has no builder on purpose — it is a GET that wipes the caller's entire
 * call history and takes no arguments, so there is nothing to parameterise and no safe
 * default to offer.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>`: the fuzzing suites submit
 * wrong-typed values deliberately, which a strict override type would forbid.
 */

/** A kallID that must not resolve to a real call. */
export function nonExistentKallId(): number {
  return 997_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** A well-formed kpostID that is not a real subscriber. */
export function syntheticReceiver(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@kpostindia.com`;
}

/** `yyyy-MM-dd HH:mm:ss`, the format some kall routes use for scheduling. */
export function kallTimestamp(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/** Epoch millis — scheduledKall/scheduledRepeatKall take `scheduledStartTime`/`End` as numbers. */
export function kallEpoch(offsetMinutes: number): number {
  return Date.now() + offsetMinutes * 60_000;
}

/** `yyyy-MM-dd`, used inside the `repeatedDate` stringified-JSON window. */
export function kallDate(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The `KallROV3` DTO — the workhorse of this controller, used by initiateKall, the status
 * routes, kallInfo, contactInfo, kallDashboard and the clear routes.
 *
 * `kallStatus` is always populated. `updateSenderAndReceiverKallStatus` reads it with
 * `int status = kallDetails.getKallStatus()`, an unboxing of an `Integer` that throws NPE
 * when the field is absent — the missing-parameter cases below target that deliberately.
 */
export function buildKallROPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiver: syntheticReceiver(),
    // Excel initiateKall: `{ receiver, kalltype: 'voice', kallSessionID, kallSessionName,
    // callingToPrimaryDevice }`. KallROV3 is a superset DTO, so the status/info routes read the
    // subset they need (kallStatus, kallID, id, kallSession…) and ignore the rest.
    kalltype: 'voice',
    kallType: 1,
    kallMode: 0,
    kallStatus: 2,
    subject: qaLabel('kall'),
    kallSession: faker.string.uuid(),
    kallSessionID: faker.string.numeric(7),
    kallSessionName: qaLabel('session'),
    callingToPrimaryDevice: true,
    deviceType: 'Web',
    ...overrides,
  };
}

/** A KallROV3 addressing an existing call. Defaults to a non-existent kallID. */
export function buildExistingKallPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildKallROPayload({ kallID: nonExistentKallId(), ...overrides });
}

/**
 * updateKallStatus — Excel: `{ id, kallStatus, kallID }` (a decline, kallStatus 4, also carries
 * `reason`). Per the product owner: `kallID` is shared across the whole call, while `id` is
 * unique per receiver — a multi-receiver call has one `kallID` but a distinct `id` per receiver.
 * kallStatus is numeric on the v2 routes.
 */
export function buildUpdateKallStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: nonExistentKallId(),
    kallStatus: 2,
    kallID: nonExistentKallId(),
    ...overrides,
  };
}

/**
 * updateSenderAndReceiverKallStatus — SENDER variant, Excel: `{ sender, kallStatus, kallID }`.
 * kallStatus is restricted to 2, 3 or 9 on this route.
 */
export function buildSenderKallStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sender: syntheticReceiver(),
    kallStatus: 2,
    kallID: nonExistentKallId(),
    ...overrides,
  };
}

/**
 * updateSenderAndReceiverKallStatus — RECEIVER variant, Excel:
 * `{ id, kallStatus, receiver, kallID }`. `id` is the receiver's per-call unique id; `kallID` is
 * the shared call id. kallStatus is restricted to 2, 3 or 9.
 */
export function buildReceiverKallStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: nonExistentKallId(),
    kallStatus: 2,
    receiver: syntheticReceiver(),
    kallID: nonExistentKallId(),
    ...overrides,
  };
}

/** The clear-by-ids payload — a list of calls to remove from the caller's history. */
export function buildClearKallPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildKallROPayload({ kallIds: [nonExistentKallId(), nonExistentKallId()], ...overrides });
}

/** The dashboard/history filter. */
export function buildKallDashboardPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildKallROPayload({
    selectedDate: kallTimestamp(0).slice(0, 10),
    fetchType: 'all',
    ...overrides,
  });
}

/**
 * The `KallMaster` DTO — scheduledKall, reScheduleKall and addMembersToKall.
 *
 * These three are `@Valid`, so bean validation runs before the controller body. That makes
 * them the routes most likely to answer a clean 400, and a good contrast with the unvalidated
 * `KallROV3` routes next door.
 */
export function buildScheduledKallPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  // Excel scheduledKall: { kallSession, kallMode, subject, scheduledStartTime (epoch ms),
  // scheduledEndTime (epoch ms), meetingLink, repeatType, repeatedDate (stringified
  // {start_date,end_date}), kallDetails: [{ receiver }] }.
  return {
    kallSession: faker.string.numeric(6),
    kallMode: 0,
    subject: qaLabel('scheduled-kall'),
    scheduledStartTime: kallEpoch(120),
    scheduledEndTime: kallEpoch(180),
    meetingLink: `https://meet.jit.si/qa-${faker.string.alphanumeric(8)}`,
    repeatType: 0,
    repeatedDate: JSON.stringify({ start_date: kallDate(120), end_date: kallDate(180) }),
    kallDetails: [{ receiver: syntheticReceiver() }],
    ...overrides,
  };
}

/** A reschedule addressing an existing call. Defaults to a non-existent kallID. */
export function buildReScheduleKallPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  // Excel reScheduleKall: `{ start_date, end_date }` — included alongside the camelCase KallMaster
  // fields so the reschedule works whichever the deployed build reads.
  return buildScheduledKallPayload({
    kallID: nonExistentKallId(),
    scheduledStartTime: kallEpoch(300),
    scheduledEndTime: kallEpoch(360),
    start_date: kallDate(300),
    end_date: kallDate(360),
    ...overrides,
  });
}

/** Adding members to an existing call. */
export function buildAddMembersPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildScheduledKallPayload({
    kallID: nonExistentKallId(),
    kallDetails: [
      { receiver: syntheticReceiver(), receiverName: 'QA Added Member' },
    ],
    ...overrides,
  });
}

/** The `KallModificationRequest` DTO — modifyKallMembers. */
export function buildModifyMembersPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kallID: nonExistentKallId(),
    addingUserIds: [syntheticReceiver()],
    removingUserIds: [],
    ...overrides,
  };
}

/**
 * The `RepeatKoolKallRO` DTO — scheduledRepeatKall and fetchScheduledRepeatKall.
 *
 * A recurring call series is the highest-blast-radius object in this module: one request can
 * generate an unbounded set of future calls, so `seriesEndDate` is always populated here and
 * the tests probe what happens when it is not.
 */
export function buildRepeatKallPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    subject: qaLabel('repeat-kall'),
    kallType: 1,
    kallMode: 0,
    kallSession: faker.string.numeric(6),
    scheduledStartTime: kallEpoch(1440),
    scheduledEndTime: kallEpoch(1500),
    meetingLink: `https://meet.jit.si/qa-${faker.string.alphanumeric(8)}`,
    // Excel scheduledRepeatKall carries repeatedDate as a stringified {start_date,end_date} window.
    repeatedDate: JSON.stringify({ start_date: kallDate(1440), end_date: kallDate(1440 * 7) }),
    start_date: kallDate(1440),
    end_date: kallDate(1440 * 7),
    seriesEndDate: kallDate(1440 * 7),
    repeatType: 1,
    preferredDays: [1],
    preferredWeek: [],
    preferredDate: [],
    preferredMonth: [],
    receiverList: [syntheticReceiver()],
    repeatDate: [],
    description: faker.lorem.sentence(),
    isReminder: false,
    priority: 1,
    kdairyEvent: false,
    ...overrides,
  };
}
