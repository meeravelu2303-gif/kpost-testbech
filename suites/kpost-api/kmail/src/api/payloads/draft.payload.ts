import { faker } from '../../utils/dataGen';
import { nonExistentKmailId, qaLabel, syntheticRecipient } from '../../utils/safeTestData';

/**
 * Request builders for the Draft controller (`/v2/draft/**`).
 *
 * Two DTOs, mixing them is a Jackson 400: `draftMail` takes the compose DTO
 * (`SentMailRequestObject`, in `sentMail.payload.ts`); `deleteDraftMail` and
 * `getDraftMailsForSelectedContact` take the `Draft` entity built here. A draft stores `cc`/`bcc`
 * as single delimited strings, where the send DTO uses `ccList`/`bccList` arrays — reproduced,
 * not smoothed over. `fromAddress` is left unset throughout: the service overwrites it from the
 * JWT, and the ownership cases set it explicitly to prove that.
 */

/**
 * The `Draft` entity — addresses an existing draft. `kmailID` defaults to a non-resolving value
 * because `deleteDraftMail` acts on whatever it matches — a real-range default would delete
 * somebody's work.
 */
export function buildDraftPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kmailID: nonExistentKmailId(),
    // `deleteDraftMail` keys on this mail-server message id + the send timestamp (Excel [F]:
    // `{ kmailID, draftMailID, kmailSendDate }`). A synthetic, non-resolving id keeps the
    // delete pointed at nothing real.
    draftMailID: `<qa-${faker.string.alphanumeric(12)}.${nonExistentKmailId()}@kpostindia.com>`,
    kmailSendDate: Date.now(),
    toAddress: syntheticRecipient(),
    kmailSubject: qaLabel('draft'),
    saluation: 'Dear',
    saluationName: faker.person.firstName(),
    priority: 0,
    // Delimited strings, not arrays. See the note above.
    cc: '',
    bcc: '',
    attachmentFlag: 0,
    attachmentUuid: [],
    groupFlag: false,
    ...overrides,
  };
}

/** Addresses one specific draft by id — the shape `deleteDraftMail` expects. */
export function buildDraftIdPayload(
  kmailID: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildDraftPayload({ kmailID, ...overrides });
}

/**
 * Lists the drafts addressed to one contact.
 *
 * Filters on `toAddress`, so it doubles as the ownership probe: a `toAddress` the caller never
 * wrote to must return nothing, and a `fromAddress` naming somebody else must be ignored.
 */
export function buildDraftsForContactPayload(
  toAddress: string = syntheticRecipient(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildDraftPayload({ toAddress, ...overrides });
}
