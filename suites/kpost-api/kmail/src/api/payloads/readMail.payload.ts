import {
  nonExistentKmailId,
  nonExistentUuid,
  qaLabel,
  syntheticRecipient,
} from '../../utils/safeTestData';

/**
 * Request builders for the Read Mail controller (`/v2/readMail/**`).
 *
 * DTO is `ReadMailRequestObject`. `kmailType` is `@NotBlank` (a blank value is a documented 400)
 * so `buildReadMailPayload` always sets it and negative cases blank it deliberately. `kpostUser`
 * is server-assigned from the token, left unset so a builder cannot mask ownership tests. Field
 * names are transcribed exactly — these DTOs reject unknown properties with a Jackson 400.
 */

/**
 * The values `kmailType` accepts on `sentAndInboxMailContent`. Per KMail Excel `[F]`, this route's
 * `kmailType` is a **direction** — `"received"` (inbox side) or `"sent"` (sent side), not a folder
 * name. It is `@NotBlank`, so blank/null/omitted is a documented 400.
 */
export const MAIL_DIRECTION = {
  received: 'received',
  sent: 'sent',
} as const;

/**
 * The `ReadMailRequestObject` DTO — opening one mail via `sentAndInboxMailContent`. Aligned to
 * Excel `[F]`: `{ kmailID, kmailType, senderUniqueMailID, receiverUniqueMailID, kmailSubject }`.
 * The unique mail ids disambiguate which stored copy is meant; default to synthetic non-resolving
 * values, ownership cases set them explicitly.
 */
export function buildReadMailPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel row 29 [F] (sentAndInboxMailContent): kmailID, kmailType, senderUniqueMailID,
    // receiverUniqueMailID, kmailSubject, kmailSendDate, kmailNumber, selectedContact.
    kmailID: nonExistentKmailId(),
    kmailType: MAIL_DIRECTION.received,
    senderUniqueMailID: `<${nonExistentUuid()}@kpostindia.com>`,
    receiverUniqueMailID: '',
    kmailSubject: qaLabel('read'),
    kmailSendDate: Date.now(),
    kmailNumber: 1,
    selectedContact: syntheticRecipient(),
    groupFlag: false,
    ...overrides,
  };
}

/**
 * A thread read, driven by the ordered `referenceMails` chain (each entry a `kmailID`). The route
 * reads a body per entry, so an unbounded chain lets the caller choose the response size unless
 * the service caps it.
 */
export function buildReferenceMailPayload(
  referenceMails: number[] = [nonExistentKmailId(), nonExistentKmailId()],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  // Excel row 28 (referenceMailContent) is exactly { referenceMails:[] } — not the full read shape.
  return {
    referenceMails,
    ...overrides,
  };
}

/**
 * A batch metadata fetch (`getKmailDetailsUsingKmailID`). Excel `[E]` is exactly
 * `{ kmailIDs: [ … ] }` — keyed solely on the id list, not the `sentAndInboxMailContent`
 * direction/unique-id fields, so built standalone rather than inheriting the read-mail base.
 */
export function buildKmailDetailsPayload(
  kmailIDs: number[] = [nonExistentKmailId(), nonExistentKmailId()],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kmailIDs,
    ...overrides,
  };
}

/**
 * A draft body read. Addressing field is `draftKmailID`, **not** `kmailID` — a draft body lives on
 * the MySQL `Draft` row, not the MongoDB content collection, so the wrong one reads nothing.
 * Aligned to Excel `[F]` for `draftMailContent`:
 * `{ draftKmailID, kmailSendDate, kmailSubject, senderUniqueMailID }`. This route does **not** take
 * `kmailType` (unlike `sentAndInboxMailContent`); the draft is located by `draftKmailID` + timestamp.
 */
export function buildDraftContentPayload(
  draftKmailID: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    draftKmailID,
    kmailSendDate: Date.now(),
    kmailSubject: qaLabel('draft'),
    senderUniqueMailID: `<${nonExistentUuid()}@kpostindia.com>`,
    ...overrides,
  };
}

/**
 * An attachment metadata resolution. `targetFileName` selects the wanted attachment, matched
 * against the stored list by display name — a weak key (two attachments can share one), which the
 * traversal and duplicate-name cases in `tests/attachments/` probe.
 */
export function buildAttachmentPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildReadMailPayload({
    targetFileName: `${qaLabel('file')}.pdf`,
    ...overrides,
  });
}

/**
 * An attachment on a mail from outside the KPOST domain. `groupFlag` switches the lookup on this
 * route specifically (per the API docs), so it is set explicitly rather than inherited.
 */
export function buildOtherDomainAttachmentPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel row 46 (downloadODAttachment): kmailID, kmailNumber, kmailType("sent"), groupFlag,
    // targetFileName — a leaner shape than the KPOST-domain downloadAttachment.
    kmailID: nonExistentKmailId(),
    kmailNumber: 1,
    kmailType: MAIL_DIRECTION.sent,
    groupFlag: false,
    targetFileName: `${qaLabel('file')}.mkv`,
    ...overrides,
  };
}
