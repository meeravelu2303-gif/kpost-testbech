import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Contacts Directory V2 controller, in one place. */
export const CONTACTS_V2_PATHS = {
  addContact: '/v2/contacts/addContact',
  addMultipleContact: '/v2/contacts/addMultipleContact',
  addContactReference: '/v2/contacts/addContactReference',
  deleteContact: '/v2/contacts/deleteContact',
  blockOrUnBlockContact: '/v2/contacts/blockOrUnBlockContact',
  blockOrUnBlockMultipleContact: '/v2/contacts/blockOrUnBlockMultipleContact',
  getblockContactDetails: '/v2/contacts/getblockContactDetails',
  myContacts: '/v2/contacts/myContacts',
  myGroups: '/v2/contacts/myGroups',
  myUnknownKatchupContacts: '/v2/contacts/myUnknownKatchupContacts',
  myUnknownGroups: '/v2/contacts/myUnknownGroups',
  globalSearch: '/v2/contacts/globalSearch',
  getSearchDetails: '/v2/contacts/getSearchDetails',
  importPhoneContacts: '/v2/contacts/importPhoneContacts',
  getImportedPhoneContacts: '/v2/contacts/getImportedPhoneContacts',
  updateInviteStatus: '/v2/contacts/updateInviteStatus',
} as const;

// Every route except `getSearchDetails` resolves the caller from the token (no owning kpostID here);
// `getSearchDetails` is the exception, tested explicitly.
export class ContactsDirectoryV2Client extends BaseClient {
  /** Add one KPOST user to the caller's directory. */
  addContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.addContact, data, options);
  }

  /** Add a batch of contacts. The request body is a JSON **array**, not an object. */
  addMultipleContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.addMultipleContact, data, options);
  }

  /** Set or change the caller's personal alias for a contact. */
  addContactReference(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.addContactReference, data, options);
  }

  /** Remove a contact from the caller's directory. One-sided by design. */
  deleteContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.deleteContact, data, options);
  }

  /** Toggle the block flag on a single contact. */
  blockOrUnBlockContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.blockOrUnBlockContact, data, options);
  }

  /** Apply the same block state to several contacts in one request. */
  blockOrUnBlockMultipleContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.blockOrUnBlockMultipleContact, data, options);
  }

  /** Read the caller's block list. Accepts no parameters by design. */
  getblockContactDetails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(CONTACTS_V2_PATHS.getblockContactDetails, options);
  }

  /** Delta sync of the caller's contact directory. */
  myContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.myContacts, data, options);
  }

  /** Delta sync of the caller's groups. */
  myGroups(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.myGroups, data, options);
  }

  /** Counterparties messaged but not saved as contacts. */
  myUnknownKatchupContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.myUnknownKatchupContacts, data, options);
  }

  /** Groups the caller has activity from but has not joined. */
  myUnknownGroups(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.myUnknownGroups, data, options);
  }

  /** Platform-wide user directory search — the widest-reach read in the controller. */
  globalSearch(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.globalSearch, data, options);
  }

  /** Search-suggestion values — the one route that does NOT resolve identity server-side. */
  getSearchDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.getSearchDetails, data, options);
  }

  /** Upload the caller's device address book for matching against registered users. */
  importPhoneContacts(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.importPhoneContacts, data, options);
  }

  /** Read back the caller's previously uploaded address book. */
  getImportedPhoneContacts(options?: RequestOptions): Promise<APIResponse> {
    return this.get(CONTACTS_V2_PATHS.getImportedPhoneContacts, options);
  }

  /** Record that an imported phone-book entry has been invited. */
  updateInviteStatus(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CONTACTS_V2_PATHS.updateInviteStatus, data, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
