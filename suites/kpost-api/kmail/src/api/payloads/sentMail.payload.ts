import { faker } from '../../utils/dataGen';
import {
  jdbcTimestamp,
  qaLabel,
  qaMailBody,
  syntheticExternalRecipient,
  syntheticRecipient,
} from '../../utils/safeTestData';

/**
 * Request builders for the Sent Mail controller (`/v2/sentMail/**`).
 *
 * **These endpoints deliver real mail.** Hence: `toAddress` is always a **synthetic, non-existent**
 * recipient (a plausible generated address could collide with a live subscriber, and the suite
 * fires send routes hundreds of times per run); `bccList` defaults to empty (a BCC creates its own
 * `KmailTransaction` row that leak tests must control precisely); subjects/bodies carry a `qaLabel`
 * so any mail that lands is traceable test traffic.
 *
 * **`fromAddress` is deliberately not set** — every send route overwrites it with the JWT
 * `kpostID`, so a supplied value would mask the spoofing tests (which pass it explicitly).
 *
 * KMail entities are **not** `@JsonIgnoreProperties(ignoreUnknown = true)`: an unknown field is a
 * hard Jackson 400 with a stack trace, so field names are transcribed from `SentMailRequestObject`
 * exactly.
 */

/** Mail semantics, per `KPOSTConstants`. Named so the specs read as intent, not as integers. */
// Per the Excel "Types" tab, KMail kmailType: 0 New, 1 Reply, 2 Forward, 3 Reminder, 4 Draft,
// 5 Edit, 6 Note, 7 Delete, 8 Comment, 9 Clarify, 10 forward-thread, 11 share, 12 mail-otp,
// 13 bulkmail. (These differ from Katchup's messageType — the previous constants used Katchup's
// values, so forward/note/share were wrong.)
export const KMAIL_TYPE = {
  normal: 0,
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

/** KMail recipient class, per the Excel "Types" tab `RECEIVER_TYPE`. Response-side field. */
export const RECEIVER_TYPE = {
  to: 1,
  copy: 2,
  confidential: 3,
} as const;

/**
 * The `SentMailRequestObject` DTO — the compose payload shared by send and draft. `kmailID: 0`
 * means "composing" (server assigns the real id); a non-zero value addresses an existing mail,
 * a different operation.
 */
export function buildComposePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Aligned to Excel row 43 (/v2/sentMail/postMail) and the live web-client capture. The server
    // ASSIGNS fromAddress/senderUniqueMailID/kmailID from the token — sending them is wrong (the IDOR
    // cases add fromAddress via override on purpose). mailFlag/senderName/receiverName are not in the
    // Excel body. Forward-only fields (forwardList/forwardNote/forwardRevealDetails/…) belong to
    // buildForwardPayload, not a plain compose.
    toAddress: syntheticRecipient(),
    kmailSubject: qaLabel('subject'),
    kmailContent: qaMailBody('compose'),
    kmailType: KMAIL_TYPE.normal,
    kmailSendDate: Date.now(),
    priority: 0,
    saluation: 'Dear',
    saluationName: faker.person.firstName(),
    selectedMembers: 'N',
    attachmentFlag: 0,
    attachmentUuid: [],
    // Excel sends this as a JSON STRING (a caption array); "[]" is the no-attachment form.
    attachmentCaption: '[]',
    ccList: [],
    bccList: [],
    groupFlag: false,
    groupReceiverList: null,
    referenceKmailID: null,
    originalKmailID: null,
    // Client-settable geo per the DTO; null on a normal compose (a geo-spoof case overrides these).
    senderLatitde: null,
    senderLongitude: null,
    ...overrides,
  };
}

/**
 * A reply to an existing mail. `kmailType` 1 and `originalKmailID` travel together — the type
 * without the identifier produces a reply referencing nothing, which the service accepts and which
 * reads back as an orphan in the thread view.
 */
export function buildReplyPayload(
  originalKmailID: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    kmailType: KMAIL_TYPE.reply,
    originalKmailID,
    referenceKmailID: [String(originalKmailID)],
    kmailSubject: `Re: ${qaLabel('subject')}`,
    mailFlag: 'reply',
    ...overrides,
  });
}

/**
 * A forward. `forwardList` is the forward recipient set (distinct from `toAddress`), `forwardNote`
 * the text above the quoted original, and `revealSource` controls how much of the original sender
 * the recipient sees — the field the disclosure cases in `tests/compose/` probe.
 */
export function buildForwardPayload(
  originalKmailID: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    kmailType: KMAIL_TYPE.forward,
    originalKmailID,
    forwardList: [syntheticRecipient()],
    forwardNote: qaLabel('forward-note'),
    revealSource: false,
    // Excel row 43 carries this alongside the other forward-only fields; empty = forward the
    // body without re-attaching the original's files.
    forwardAttachmentLists: [],
    mailFlag: 'forward',
    ...overrides,
  });
}

/** A mail addressed to an external (non-KPOST) recipient. */
export function buildExternalComposePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    toAddress: syntheticExternalRecipient(),
    ...overrides,
  });
}

/** A mail addressed to a group rather than an individual. */
export function buildGroupComposePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    groupFlag: true,
    selectedMembers: 'N',
    groupReceiverList: [syntheticRecipient(), syntheticRecipient()],
    ...overrides,
  });
}

/** A mail referencing attachments that were uploaded in an earlier request. */
export function buildComposeWithAttachmentUuids(
  uuids: string[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    attachmentFlag: 1,
    attachmentUuid: uuids,
    ...overrides,
  });
}

/**
 * The `BulkMailRequestObject` DTO. **Capped at two synthetic recipients on purpose** — the highest
 * fan-out write in the API (each `toAddressList` entry produces its own `KmailMaster` row,
 * `KmailTransaction` row and MongoDB body document, unundoable), so size-limit cases assert the
 * *documented* bound rather than exceeding it. `toAddress` is left unset: a campaign addresses
 * `toAddressList`, and setting both sends one extra mail nobody accounted for.
 */
export function buildBulkMailPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel row 71 (postBulkMail) is a lean body: toAddressList, kmailSubject, kmailContent, priority,
    // kmailType (13 = bulkmail — the bulk branch), attachmentUuid. No kmailID/attachmentFlag/mailFlag/
    // saluation/senderName (not in the bulk body); fromAddress is server-assigned (IDOR case overrides it).
    toAddressList: [syntheticRecipient(), syntheticRecipient()],
    kmailSubject: qaLabel('campaign'),
    kmailContent: qaMailBody('campaign'),
    priority: 0,
    kmailType: KMAIL_TYPE.bulkmail,
    attachmentUuid: [],
    ...overrides,
  };
}

/**
 * The `KmailCredentialsRequestObject` DTO. `kpostID` is required and read **from the body** (the
 * OpenAPI doc flags this as unusual): the ownership case supplies a foreign `kpostID` to check
 * whether the service hands over that account's mail-server settings.
 */
export function buildMailCredentialsPayload(
  kpostID: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kpostID,
    password: qaLabel('pw'),
    ...overrides,
  };
}

/**
 * A compose payload with an explicit send date. Format is JDBC (`yyyy-MM-dd HH:mm:ss.SSS`), not
 * ISO-8601: the service parses these as `java.sql.Timestamp`, and an ISO string with a `T`
 * separator fails that parse — surfacing as a 500.
 */
export function buildDatedComposePayload(
  offsetMinutes: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildComposePayload({
    kmailSendDate: jdbcTimestamp(offsetMinutes),
    ...overrides,
  });
}
