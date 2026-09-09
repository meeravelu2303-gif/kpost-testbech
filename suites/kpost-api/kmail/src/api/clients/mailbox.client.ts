import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from '../../helpers/base.client';
import { MAILBOX_PATHS, RETIRED_PATHS } from '../routes/kmail.routes';

/**
 * Client for the Mailbox & Contacts controller (`/v2/common/**`) — the largest controller (33 routes):
 * folders/listing, follow-up status buckets, actions (flag/soft-delete/PDF), and external contacts.
 *
 *  - `kpostUser` is server-assigned on every route (overwritten from the JWT); ownership tests set it anyway.
 *  - Deletion is keyed on `transactionIDs` (the per-recipient row), NOT `kmailID` — sending a `kmailID`
 *    where a transaction id belongs deletes nothing and passes for the wrong reason.
 */
export class MailboxClient extends BaseClient {
  /* ------------------------------------------------------------- folders and listing -- */

  /** A page of the inbox. Keyset-paged backwards on `lastKmailID`. */
  getKmailDashboardMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.getKmailDashboardMsg, data, options);
  }

  /** Anything newer than `firstKmailID` — the incremental refresh the UI polls. */
  getKmailDashboardNewMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.getKmailDashboardNewMsg, data, options);
  }

  /** The bulk-campaign folder. */
  getBulkKmailDashboardMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.getBulkKmailDashboardMsg, data, options);
  }

  /** Per-folder totals, mailbox-wide or scoped to one contact. Counts only, no mail objects. */
  getAllMailCount(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.getAllMailCount, data, options);
  }

  /** The Important folder. */
  getAllImportantMails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.getAllImportantMails, data, options);
  }

  /** The conversation with one contact. */
  selectedContactMails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.selectedContactMails, data, options);
  }

  /** Distinct subjects exchanged with one contact — the subject-search surface. */
  mailSubjectSelectedContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.mailSubjectSelectedContact, data, options);
  }

  /** Unread counts, total and per sender. The badge on the mail icon. */
  unOpenedMailCountBySenderID(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.unOpenedMailCountBySenderID, options);
  }

  /** Per-member read status for a mail sent to a group. */
  kmailGroupReadStatus(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.kmailGroupReadStatus, data, options);
  }

  /* ---------------------------------------------------------- follow-up status buckets -- */

  /** Sent mail the recipient has not opened. */
  sentMailNotOpened(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.sentMailNotOpened, data, options);
  }

  /** Sent mail still awaiting a reply. */
  replyNotReceived(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.replyNotReceived, data, options);
  }

  /** Received mail the user still owes a reply to. */
  replyNotSent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.replyNotSent, data, options);
  }

  /** Marks threads as needing no reply, from the sender's side. */
  replyNotRequiredBySender(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.replyNotRequiredBySender, data, options);
  }

  /** Dismisses a reply obligation, from the receiver's side. */
  replyNotRequiredByReceiver(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.replyNotRequiredByReceiver, data, options);
  }

  /** Groups follow-up contacts by status, with counts. Driven by `kmailStatusFlag`. */
  statusOfKmailsContactsWithCount(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.statusOfKmailsContactsWithCount, data, options);
  }

  /** Total across every follow-up bucket. */
  statusOfKmailsContactsTotalCount(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.statusOfKmailsContactsTotalCount, options);
  }

  /** Clears a follow-up status for selected mail. */
  clearStatusOfKmailsContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.clearStatusOfKmailsContacts, data, options);
  }

  /**
   * Clears a follow-up status for EVERY mail in the bucket — the only unbounded write in the
   * controller. SAFETY: fired only against a status flag the bench itself set.
   */
  clearStatusOfAllKmailsContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.clearStatusOfAllKmailsContacts, data, options);
  }

  /* ------------------------------------------------------------------ actions on mail -- */

  /** Flags or unflags mail as important. */
  setKmailAsImportant(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.setKmailAsImportant, data, options);
  }

  /** Per-user soft delete, keyed on `transactionIDs` — hides the caller's copy only. */
  deleteKmailWithDeletedBy(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.deleteKmailWithDeletedBy, data, options);
  }

  /**
   * Renders a mail as PDF from the content supplied in the request — stateless, never looks the mail
   * up. A rendering surface for attacker-controlled HTML, which `tests/actions/` probes it for.
   */
  convertMailAsPDF(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.convertMailAsPDF, data, options);
  }

  /* ---------------------------------------------------------------------- contacts -- */

  /** Adds an external (non-KPOST) contact. */
  addOtherDomainContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.addOtherDomainContacts, data, options);
  }

  /** Updates an external contact. */
  editOtherDomainContactsDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.editOtherDomainContactsDetails, data, options);
  }

  /** Soft-deletes an external contact — sets `deleteStatus` so sync clients learn about it. */
  deleteOtherDomainContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.deleteOtherDomainContact, data, options);
  }

  /** Full sync when `lastFetchTime` is omitted; incremental when it is supplied. */
  knownPostBoxContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.knownPostBoxContacts, data, options);
  }

  /** Contacts that fit no other bucket. */
  miscellaneousContacts(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.miscellaneousContacts, options);
  }

  /** The caller's most-corresponded-with contacts — a social graph, and treated as one. */
  frequentKmailContact(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.frequentKmailContact, options);
  }

  /* ------------------------------------------------ reference data and infrastructure -- */

  /** The salutation list the compose screen offers. */
  getSaluations(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.getSaluations, options);
  }

  /** The canned instant replies offered under an open mail. */
  getInstantReply(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.getInstantReply, options);
  }

  /** Health probe for the upstream mail-server connection. */
  mailServerConnection(options?: RequestOptions): Promise<APIResponse> {
    return this.get(MAILBOX_PATHS.mailServerConnection, options);
  }

  /**
   * Records an unsubscribe request. Reads `sender`/`receiver` from the body with NO token binding
   * (documented) — anyone reaching it can opt any address out of any sender's campaigns.
   */
  saveUnsubscriberDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(MAILBOX_PATHS.saveUnsubscriberDetails, data, options);
  }

  /* ------------------------------------------------------------------------ retired -- */

  /** `[Legacy]` per the API's own documentation. Still mapped, so still reachable. */
  unusedStatusOfKmailsContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(RETIRED_PATHS.unusedstatusOfKmailsContacts, data, options);
  }

  /** `[Legacy]` per the API's own documentation. Still mapped, so still reachable. */
  unusedPostBoxContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(RETIRED_PATHS.unusedpostBoxContacts, data, options);
  }

  /** Sends a raw, possibly malformed body to any route on this controller. */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
