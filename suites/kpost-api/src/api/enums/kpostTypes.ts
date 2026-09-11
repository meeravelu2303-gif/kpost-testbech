/**
 * KPost type codes — mirrored from the Excel workbook's `Types(Katchup,Kall&KDiary)` tab.
 *
 * That tab is the product team's definition of every numeric type code, and it is authoritative:
 * when a comment, a swagger example or a live response disagrees with it, the tab wins. The names
 * below are ours; every number and meaning is the tab's, cell by cell (cell refs in each JSDoc).
 *
 * `npm run contract:types` re-reads the tab into `docs/excel/types.json`, and `npm run test:unit`
 * fails if any constant here drifts from it in either direction — a value missing from the
 * workbook, or a workbook value with no constant. Hand-typed type labels are how this bench once
 * treated messageType 18 (Secret) as Confidential Copy and filed an invalid Critical
 * (BUG-API-6EEBB3).
 *
 * Values the live API uses but the tab does NOT list are kept apart under `*_OBSERVED`, so they can
 * never be mistaken for documented ones.
 */

/** Katchup message `status` — Types tab A3. */
export const KATCHUP_STATUS = {
  sent: 0,
  unread: 1,
  read: 2,
  notSent: 3,
  group: 4,
} as const;

/**
 * Katchup `messageType` — Types tab A3.
 *
 * **Copies (Cc) and Confidential Copy are BOTH `copies` (14).** They differ only by which list in
 * `sharedMessageDetails` carries the person: `revealContactList` = Cc (visible to the other
 * recipients), `hiddenContactList` = Confidential Copy (stripped from every copy but the
 * sender's). `secret` (18) is unrelated to either.
 */
export const KATCHUP_MESSAGE_TYPE = {
  normal: 0,
  reply: 1,
  share: 2,
  reminder: 3,
  sms: 4,
  note: 5,
  edit: 6,
  recall: 7,
  comment: 8,
  clarify: 9,
  notificationMail: 10,
  groupNotification: 11,
  copies: 14,
  forwardReveal: 15,
  forwardHidden: 16,
  scheduleCall: 17,
  secret: 18,
  bulk: 19,
  forwardMultipleThreadReveal: 20,
  forwardMultipleThreadHidden: 21,
  shareDigitalCard: 22,
  shareLocation: 23,
  forwardSelectedAttachment: 24,
  broadcastReplyEnabled: 25,
  broadcastNoReply: 26,
} as const;

/** Katchup `sharedType` — Types tab A5. Note 14 is NOT here; see `KATCHUP_OBSERVED`. */
export const KATCHUP_SHARE_TYPE = {
  reply: 1,
  share: 2,
  reminder: 3,
  note: 5,
  edit: 6,
  recall: 7,
  comment: 8,
  clarify: 9,
  mail: 10,
  forward: 15,
} as const;

/** In use on the live API but NOT listed in the Types tab. Confirm with the developers. */
export const KATCHUP_OBSERVED = {
  /**
   * The `sharedType` the live web client sends on every Copies / Confidential Copy message
   * (captured 2026-09-11). Absent from the tab's SHARE TYPE list.
   */
  copiesSharedType: 14,
  /** The `status` a recalled message carries, and the value `recallMessage` is sent with. */
  recalledStatus: 5,
} as const;

/** Kall `kallStatus`, for sender and receiver rows — Types tab C3. */
export const KALL_STATUS = {
  new: 0,
  connected: 1,
  cancelled: 2,
  noResponse: 3,
  declined: 4,
  busy: 5,
  scheduled: 6,
  rescheduled: 7,
  closed: 8,
  removed: 9,
  koolKallAccepted: 10,
  notJoined: 11,
} as const;

/** Kall `kallType` — Types tab C3. A direct call is `normal`; a booked call is `koolScheduled`. */
export const KALL_TYPE = {
  normal: 0,
  koolScheduled: 1,
} as const;

/** Kall `kallMode` — Types tab C5. */
export const KALL_MODE = {
  audio: 0,
  video: 1,
  audioToVideo: 2,
  videoToAudio: 3,
  primaryAudio: 4,
  primaryVideo: 5,
} as const;

/** Kall `repeatType` — Types tab C5 ("kallRepeatType"). */
export const KALL_REPEAT_TYPE = {
  none: 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
} as const;

/**
 * KMail `kmailType` — Types tab E3. Differs from Katchup's messageType (5 is Edit here, Note there).
 * The KMail suite keeps its own copy in `kmail/src/api/payloads/sentMail.payload.ts`.
 */
export const KMAIL_TYPE = {
  new: 0,
  reply: 1,
  forward: 2,
  reminder: 3,
  draft: 4,
  edit: 5,
  note: 6,
  delete: 7,
  comment: 8,
  clarify: 9,
  forwardThread: 10,
  share: 11,
  mailOtp: 12,
  bulkmail: 13,
} as const;

/** KMail recipient class — Types tab E3 (`RECEIVER_TYPE_*`). */
export const KMAIL_RECEIVER_TYPE = {
  to: 1,
  copy: 2,
  confidential: 3,
} as const;

/** KMail `priority` — Types tab E3. */
export const KMAIL_PRIORITY = {
  low: 0,
  medium: 1,
  high: 2,
} as const;

/** Platform `module` — Types tab E5. The workbook on disk lists 0–17. */
export const KPOST_MODULE = {
  kpost: 0,
  katbookStore: 1,
  kmedDictionary: 2,
  salesAndMarketing: 3,
  adminModule: 4,
  kmedGlobal: 5,
  kadJournal: 6,
  ktechGlobal: 7,
  ustudyGlobal: 8,
  ktechDictionary: 9,
  uEducate: 10,
  ustudyGlobalAdmin: 11,
  kmedAdmin: 12,
  sdms: 13,
  kmedPrep: 14,
  libraryMgmt: 15,
  hrms: 16,
  kmedLibrary: 17,
} as const;

/** Kdiary `remarks` — Types tab G3. */
export const KDIARY_REMARKS = {
  none: 0,
  completed: 1,
  pending: 2,
  notDone: 3,
  reschedule: 4,
  onHold: 5,
  delete: 6,
} as const;

/**
 * Business account tiers — Types tab I3. A business login must send its size-suffixed tier.
 * Personal accounts use `PERSONAL`, which the tab does not list.
 */
export const BUSINESS_USER_TYPE = ['BUSINESS_S', 'BUSINESS_M', 'BUSINESS_L'] as const;
