import { faker } from '../../utils/dataGen';
import {
  jdbcTimestamp,
  nonExistentKmailId,
  nonExistentTransactionId,
  qaLabel,
  qaMailBody,
  syntheticExternalRecipient,
  syntheticRecipient,
} from '../../utils/safeTestData';

/**
 * Request builders for the Mailbox & Contacts controller (`/v2/common/**`).
 *
 * `KmailCommonRequestObject` is the shared DTO; three fields carry the key semantics:
 *  - **`fetchMailType`** — read-state filter: `Y` opened, `N` unopened, `A` all. This is how KMail
 *    expresses read/unread (no `markAsRead` endpoint; state is a transaction-row property).
 *  - **`kmailStatusFlag`** — follow-up bucket: `0` sent-not-opened, `1` reply-not-received, etc.
 *  - **`transactionIDs`** — per-recipient `KmailTransaction` rows, **not** mails. Deletion and
 *    clear-status key on these, so sending a `kmailID` here targets nothing.
 *
 * `kpostUser` is left unset: every controller overwrites it from the JWT, ownership cases set it.
 */

/** Read-state filter for the listing routes. */
export const FETCH_MAIL_TYPE = {
  openedOnly: 'Y',
  unopenedOnly: 'N',
  all: 'A',
} as const;

/** Follow-up bucket selector for `kmailStatusFlag`. Named so specs read as intent. */
export const KMAIL_STATUS_FLAG = {
  sentNotOpened: 0,
  replyNotReceived: 1,
  replyNotSent: 2,
} as const;

/** The `KmailCommonRequestObject` DTO — the workhorse of this controller. */
export function buildCommonPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    count: 50,
    fetchMailType: FETCH_MAIL_TYPE.all,
    groupFlag: false,
    ...overrides,
  };
}

/**
 * A page of the inbox (`getKmailDashboardMsg`). `kmailID` is the **keyset** cursor per Excel `[F]`
 * (`{ "kmailID": "" }` first fetch, `{ "kmailID": "1001" }` next page) — a string, not an offset:
 * the client sends the oldest id it holds and receives the page before it, `""` means first page.
 * Treating it as an offset pages the wrong rows. The newer direction is `firstKmailID`
 * (`buildDashboardRefreshPayload`).
 */
export function buildDashboardPagePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    kmailID: '',
    ...overrides,
  });
}

/** The incremental refresh — anything newer than `firstKmailID`. */
export function buildDashboardRefreshPayload(
  firstKmailID = 0,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    firstKmailID,
    ...overrides,
  });
}

/** The conversation with one contact. */
export function buildContactMailsPayload(
  selectedContact: string = syntheticRecipient(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    selectedContact,
    lastKmailID: 0,
    ...overrides,
  });
}

/** A follow-up bucket read, driven by `kmailStatusFlag`. */
export function buildFollowUpPayload(
  kmailStatusFlag: number = KMAIL_STATUS_FLAG.replyNotReceived,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    kmailStatusFlag,
    lastKmailID: 0,
    ...overrides,
  });
}

/** Flags or unflags mail as important. Acts on `kmailIDs`. */
export function buildSetImportantPayload(
  kmailIDs: number[] = [nonExistentKmailId()],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    kmailIDs,
    kmailID: kmailIDs[0],
    ...overrides,
  });
}

/**
 * The `DeleteKmailRequestObject` DTO. Deletion is a per-user soft delete: it stamps a deleted-by
 * marker on the caller's own `KmailTransaction` rows, leaving other recipients' intact. Keyed on
 * `transactionIDs` for that reason — a `kmailID` identifies the shared mail, a transaction one
 * person's copy.
 */
export function buildDeleteKmailPayload(
  transactionIDs: number[] = [nonExistentTransactionId()],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    transactionIDs,
    groupFlag: false,
    ...overrides,
  };
}

/** Clears a follow-up status for selected mail. */
export function buildClearStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    kmailStatusFlag: KMAIL_STATUS_FLAG.replyNotReceived,
    kmailIDs: [nonExistentKmailId()],
    selectMailType: FETCH_MAIL_TYPE.all,
    ...overrides,
  });
}

/**
 * The `MailPDFConverterRequestObject` DTO. Stateless: it renders exactly the content given and
 * never looks the mail up, so `kmailContent` is attacker-controlled HTML into a PDF renderer (what
 * `tests/actions/` probes). `fromAddress` is a plain field the API documents as "not validated
 * against the caller's identity", so the PDF header can claim anyone as sender.
 */
export function buildPdfConvertPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    fromAddress: syntheticRecipient(),
    toAddress: syntheticRecipient(),
    kpostID: syntheticRecipient(),
    ccList: [],
    bccList: [],
    attachmentNames: [],
    kmailSubject: qaLabel('pdf'),
    kmailNumber: 1,
    kmailSendDate: jdbcTimestamp(),
    kmailContent: qaMailBody('pdf'),
    kmailType: 'sent',
    ...overrides,
  };
}

/**
 * The `KmailOtherDomainContacts` DTO — a contact with no KPOST account. `id` is omitted on create
 * and required on edit/delete (the whole difference between the operations). `kpostID` is
 * server-assigned, left unset.
 */
export function buildOtherDomainContactPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel row 30 (addOtherDomainContacts) [F] is exactly these three; blockedContactFlag/
    // deleteStatus/subscribe are server-managed contact state, not part of the add body.
    contactEmailID: syntheticExternalRecipient(),
    contactName: faker.person.fullName(),
    referenceName: qaLabel('vendor'),
    ...overrides,
  };
}

/** Addresses an existing external contact by primary key. */
export function buildContactIdPayload(
  id: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildOtherDomainContactPayload({ id, ...overrides });
}

/**
 * The `KmailCommonRequestObjectV2` DTO — the contact-sync cursor. Omitting `lastFetchTime` requests
 * a **full** sync of every contact — the unbounded case worth asserting (an address book has no
 * natural size limit).
 */
export function buildContactSyncPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...overrides,
  };
}

/** An incremental contact sync from a given cursor. */
export function buildIncrementalSyncPayload(
  lastFetchTime: string = jdbcTimestamp(-60),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { lastFetchTime, ...overrides };
}

/**
 * The `KmailUnsubscriber` DTO. Both `sender` and `receiver` are read from the body with no token
 * binding (documented behaviour): specs assert the resulting blast radius rather than a 401 the
 * API never promised.
 */
export function buildUnsubscriberPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sender: syntheticRecipient(),
    receiver: syntheticExternalRecipient(),
    reason: qaLabel('unsubscribe-reason'),
    ...overrides,
  };
}

/** Per-member read status for a mail sent to a group. */
export function buildGroupReadStatusPayload(
  kmailID: number = nonExistentKmailId(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildCommonPayload({
    kmailID,
    groupFlag: true,
    ...overrides,
  });
}

/**
 * Mail counts. The OpenAPI doc declares a bare `{"type":"object"}` body, so the shape is inferred:
 * counts mailbox-wide or narrowed by `selectedContact`, using the common DTO's recognised fields
 * to stay inside what Jackson binds.
 */
export function buildMailCountPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel row 74 (getAllMailCount): { selectedContact, groupFlag } — a per-contact count.
    // The mailbox-wide total is the undocumented empty-body form (send {} explicitly for that).
    selectedContact: syntheticRecipient(),
    groupFlag: false,
    ...overrides,
  };
}
