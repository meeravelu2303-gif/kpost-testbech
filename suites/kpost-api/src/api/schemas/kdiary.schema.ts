import { z } from 'zod';

/**
 * Zod contracts for the Kdiary controller (`/dairySchedule/**`).
 *
 * The tag name and the URL prefix disagree — the module is "Kdiary" but every route lives
 * under the misspelled `/dairySchedule`. That is why bug ownership is resolved from the
 * Swagger tag rather than the URL prefix; a prefix guess would file these against the wrong
 * team entirely.
 *
 * One envelope quirk shapes almost every schema below. The controller decides its status
 * code with `KPOSTValidation.isEmpty(responseObject)`: a **non-empty** result is HTTP 200,
 * and an **empty** result is HTTP 500 with `status: FAILURE`. "No events on this date" is a
 * perfectly ordinary outcome, so the error envelope is a routine response here, not an
 * exceptional one, and the response union has to admit both.
 */

/** Envelope shared by Kdiary success responses. */
export const kdiaryEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/500 across the tag. */
export const kdiaryErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** A participant attached to a schedule or event. */
export const scheduleParticipantSchema = z
  .object({
    participantID: z.number().nullish(),
    eventID: z.number().nullish(),
    participant: z.string().nullish(),
    createdBy: z.string().nullish(),
    createdDate: z.string().nullish(),
    modifiedDate: z.string().nullish(),
    userType: z.string().nullish(),
  })
  .passthrough();

/**
 * A diary schedule / event record.
 *
 * `preferredDays`, `preferredWeek`, `preferredDate` and `preferredMonth` are typed loosely on
 * purpose: swagger declares them as **strings** on `DiarySchedule` and as **arrays** on
 * `KdiaryRO`, and the same underlying record is returned by routes bound to either DTO. A
 * client cannot know which representation it will get, which is itself worth asserting.
 */
export const diaryScheduleSchema = z
  .object({
    eventID: z.number().nullish(),
    description: z.string().nullish(),
    title: z.string().nullish(),
    priority: z.number().nullish(),
    type: z.number().nullish(),
    scheduleStartDateAndTime: z.string().nullish(),
    scheduleEndDateAndTime: z.string().nullish(),
    isReminder: z.boolean().nullish(),
    isKoolKall: z.boolean().nullish(),
    kallID: z.number().nullish(),
    snoozeDetails: z.string().nullish(),
    remarks: z.number().nullish(),
    remarksDescription: z.string().nullish(),
    preferredDays: z.union([z.string(), z.array(z.number()), z.null()]).optional(),
    preferredWeek: z.union([z.string(), z.array(z.number()), z.null()]).optional(),
    preferredDate: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
    preferredMonth: z.union([z.string(), z.array(z.number()), z.null()]).optional(),
    kpostID: z.string().nullish(),
    createdBy: z.string().nullish(),
    createdDate: z.string().nullish(),
    modifiedBy: z.string().nullish(),
    modifiedDate: z.string().nullish(),
    participants: z.array(scheduleParticipantSchema).nullish(),
    kallSession: z.string().nullish(),
    meetingLink: z.string().nullish(),
    kallMode: z.number().nullish(),
  })
  .passthrough();

/** A saved daily task report. */
export const kdiaryReportSchema = z
  .object({
    id: z.number().nullish(),
    taskReport: z.string().nullish(),
    kpostID: z.string().nullish(),
    createdDate: z.string().nullish(),
    modifiedDate: z.string().nullish(),
  })
  .passthrough();

/** Routes returning a single schedule/event record. */
export const diaryScheduleResponseSchema = kdiaryEnvelopeSchema.extend({
  data: z
    .union([diaryScheduleSchema, z.array(diaryScheduleSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/** Routes returning a list of schedules/events. */
export const diaryScheduleListResponseSchema = kdiaryEnvelopeSchema.extend({
  data: z
    .union([z.array(diaryScheduleSchema), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
});

/**
 * GET /dairySchedule/getTodaySchedules — the controller merges the schedule list with the
 * day's report into a single map, so `data` is an object here rather than a bare array.
 */
export const todaySchedulesResponseSchema = kdiaryEnvelopeSchema.extend({
  data: z
    .union([z.record(z.string(), z.unknown()), z.array(diaryScheduleSchema), z.null()])
    .optional(),
});

/** Report save/edit/delete and getTodayReport. */
export const kdiaryReportResponseSchema = kdiaryEnvelopeSchema.extend({
  data: z
    .union([
      kdiaryReportSchema,
      z.array(kdiaryReportSchema),
      z.record(z.string(), z.unknown()),
      z.number(),
      z.string(),
      z.null(),
    ])
    .optional(),
});

/** deleteEvent returns a numeric row count: 1 for deleted, 0 for no matching owned record. */
export const deleteEventResponseSchema = kdiaryEnvelopeSchema.extend({
  data: z.union([z.number(), z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

export type DiarySchedule = z.infer<typeof diaryScheduleSchema>;
export type KdiaryReport = z.infer<typeof kdiaryReportSchema>;
export type ScheduleParticipant = z.infer<typeof scheduleParticipantSchema>;
