/**
 * Every route on the KPOST KMail API (v5.0) — 82 operations across seven controllers, transcribed
 * from the service's OpenAPI document. Grouped by controller to line up with the client files.
 *
 * Path-variable routes are exposed twice: a builder that encodes the segment, and a template string.
 * The template is what a finding records, so N failures against N ids group as one defect on one route.
 */

/* ========================================================================= sent mail == */

export const SENT_MAIL_PATHS = {
  /** Compose and send. Attachments must already be uploaded (`attachmentUuid`). */
  postMail: '/v2/sentMail/postMail',
  /** Send with binaries in the same request. The JSON DTO travels in the `text` query param. */
  postMailMultiPart: '/v2/sentMail/postMailMultiPart/',
  /** One mail per entry in `toAddressList` — the highest fan-out write in this API. */
  postBulkMail: '/v2/sentMail/postBulkMail',
  postBulkMailMultipart: '/v2/sentMail/postBulkMailMultipart',
  /** Diagnostic echo of a compose payload. Writes nothing. */
  loadMail: '/v2/sentMail/loadMail',
  /** Resolves mail-server credentials. Asserts the account in the BODY, not from the token. */
  getMailCredentials: '/v2/sentMail/getMailCredentials',
  /** Polls the external mail server and ingests anything new. */
  loadOtherDomainMails: '/v2/sentMail/loadOtherDomainMails',
  bulkMailStatus: (fromAddress: string): string =>
    `/v2/sentMail/bulkMail/status/${encodeURIComponent(fromAddress)}`,
} as const;

/**
 * The pre-`/v2` send route, still mapped by the controller. Kept first-class: an unversioned duplicate
 * of an authenticated write is worth firing at to see whether it enforces the same rules.
 */
export const LEGACY_PATHS = {
  postMailMultiPart: '/sentMail/postMailMultiPart/',
} as const;

/* ========================================================================= read mail == */

export const READ_MAIL_PATHS = {
  /** Opens one mail and returns its body. `kmailType` is `@NotBlank` — blank yields 400. */
  sentAndInboxMailContent: '/v2/readMail/sentAndInboxMailContent',
  /** Reads every body in a thread, driven by `referenceMails`. */
  referenceMailContent: '/v2/readMail/referenceMailContent',
  /** Batch metadata fetch, driven by `kmailIDs`. */
  getKmailDetailsUsingKmailID: '/v2/readMail/getKmailDetailsUsingKmailID',
  /** Reads a saved draft's body, driven by `draftKmailID`. */
  draftMailContent: '/v2/readMail/draftMailContent',
  /** Attachment on a mail that arrived from outside the KPOST domain. */
  downloadODAttachment: '/v2/readMail/downloadODAttachment',
  /** Resolves a mail's attachment metadata; `targetFileName` selects which one. */
  downloadAttachment: '/v2/readMail/downloadAttachment',
  mediaStreaming: (uuid: string): string =>
    `/v2/readMail/mediaStreaming/${encodeURIComponent(uuid)}`,
  getCopiesInfo: (kmailID: string | number): string =>
    `/v2/readMail/getCopiesInfo/${encodeURIComponent(String(kmailID))}`,
  downloadThumbnail: (uuid: string): string =>
    `/v2/readMail/downloadThumbnail/${encodeURIComponent(uuid)}`,
  download: (uuid: string): string => `/v2/readMail/download/${encodeURIComponent(uuid)}`,
} as const;

/* ============================================================================= draft == */

export const DRAFT_PATHS = {
  getDraftMailsForSelectedContact: '/v2/draft/getDraftMailsForSelectedContact',
  /** Save or update a draft. Takes the full compose DTO, same as `postMail`. */
  draftMail: '/v2/draft/draftMail',
  /** Save a draft with binaries. The JSON DTO travels in the `text` query param. */
  draftMailMultiPart: '/v2/draft/draftMailMultiPart/',
  deleteDraftMail: '/v2/draft/deleteDraftMail',
  getDraftMailsContacts: '/v2/draft/getDraftMailsContacts',
  getAllDraftMails: '/v2/draft/getAllDraftMails',
} as const;

/* ======================================================== mailbox, folders, contacts == */

export const MAILBOX_PATHS = {
  /* --- listing and folders --- */
  /** A page of the inbox/dashboard. Keyset-paged on `kmailID` (a string cursor, Excel [E]). */
  getKmailDashboardMsg: '/v2/common/getKmailDashboardMsg',
  /** Anything newer than `firstKmailID` — the incremental refresh the UI polls. */
  getKmailDashboardNewMsg: '/v2/common/getKmailDashboardNewMsg',
  /** The bulk-campaign folder. */
  getBulkKmailDashboardMsg: '/v2/common/getBulkKmailDashboardMsg',
  /** Per-folder totals, mailbox-wide or scoped to one contact. */
  getAllMailCount: '/v2/common/getAllMailCount',
  /** The Important folder. */
  getAllImportantMails: '/v2/common/getAllImportantMails',
  /** The conversation with one contact. */
  selectedContactMails: '/v2/common/selectedContactMails',
  /** Distinct subjects exchanged with one contact — the subject-search surface. */
  mailSubjectSelectedContact: '/v2/common/mailSubjectSelectedContact',
  unOpenedMailCountBySenderID: '/v2/common/unOpenedMailCountBySenderID',
  kmailGroupReadStatus: '/v2/common/kmailGroupReadStatus',

  /* --- follow-up status buckets --- */
  /** Sent mail the recipient has not opened. */
  sentMailNotOpened: '/v2/common/sentMailNotOpened',
  /** Sent mail still awaiting a reply. */
  replyNotReceived: '/v2/common/replyNotReceived',
  /** Received mail the user still owes a reply to. */
  replyNotSent: '/v2/common/replyNotSent',
  replyNotRequiredBySender: '/v2/common/replyNotRequiredBySender',
  replyNotRequiredByReceiver: '/v2/common/replyNotRequiredByReceiver',
  statusOfKmailsContactsWithCount: '/v2/common/statusOfKmailsContactsWithCount',
  statusOfKmailsContactsTotalCount: '/v2/common/statusOfKmailsContactsTotalCount',
  clearStatusOfKmailsContacts: '/v2/common/clearStatusOfKmailsContacts',
  clearStatusOfAllKmailsContacts: '/v2/common/clearStatusOfAllKmailsContacts',

  /* --- actions on mail --- */
  /** Flag or unflag as important. */
  setKmailAsImportant: '/v2/common/setKmailAsImportant',
  /** Per-user soft delete, keyed on `transactionIDs` — NOT on `kmailID`. */
  deleteKmailWithDeletedBy: '/v2/common/deleteKmailWithDeletedBy',
  /** Renders a mail to PDF from the body supplied in the request. Stateless. */
  convertMailAsPDF: '/v2/common/convertMailAsPDF',

  /* --- contacts --- */
  addOtherDomainContacts: '/v2/common/addOtherDomainContacts',
  editOtherDomainContactsDetails: '/v2/common/editOtherDomainContactsDetails',
  /** Soft delete — sets `deleteStatus`, so sync clients learn the contact went away. */
  deleteOtherDomainContact: '/v2/common/deleteOtherDomainContact',
  /** Full or incremental external-contact sync, driven by `lastFetchTime`. */
  knownPostBoxContacts: '/v2/common/knownPostBoxContacts',
  miscellaneousContacts: '/v2/common/miscellaneousContacts',
  frequentKmailContact: '/v2/common/frequentKmailContact',

  /* --- reference data and infrastructure --- */
  getSaluations: '/v2/common/getSaluations',
  getInstantReply: '/v2/common/getInstantReply',
  mailServerConnection: '/v2/common/mailServerConnection',
  /** Records an opt-out. Reads sender and receiver from the body with no token binding. */
  saveUnsubscriberDetails: '/v2/common/saveUnsubscriberDetails',
} as const;

/**
 * Routes the OpenAPI document marks `[Legacy]` or `[Dead Code]`. Exercised deliberately: a retired
 * route that is still mapped still executes, and is where an authorisation check goes stale unnoticed.
 */
export const RETIRED_PATHS = {
  unusedstatusOfKmailsContacts: '/v2/common/unusedstatusOfKmailsContacts',
  unusedpostBoxContacts: '/v2/common/unusedpostBoxContacts',
  translatorUnusedPostMail: '/v2/translator/unusedpostMail',
} as const;

/* ========================================================================== settings == */

export const SETTING_PATHS = {
  /* --- signature --- */
  /** Replaces every signature block in one call. */
  saveOrUpdateMailSignature: '/v2/kmailSetting/saveOrUpdateMailSignature',
  saveOrUpdateMailSignatureTemplateId: '/v2/kmailSetting/saveOrUpdateMailSignatureTemplateId',
  saveOrUpdateMailSignatureStyle: '/v2/kmailSetting/saveOrUpdateMailSignatureStyle',
  saveOrUpdateMailSignatureSocialMediaLink:
    '/v2/kmailSetting/saveOrUpdateMailSignatureSocialMediaLink',
  saveOrUpdateMailSignaturePersonalData: '/v2/kmailSetting/saveOrUpdateMailSignaturePersonalData',
  saveOrUpdateMailSignatureGraphics: '/v2/kmailSetting/saveOrUpdateMailSignatureGraphics',
  saveOrUpdateMailSignatureCompanyData: '/v2/kmailSetting/saveOrUpdateMailSignatureCompanyData',
  getMailSignature: '/v2/kmailSetting/getMailSignature',
  getDigitalSignature: '/v2/kmailSetting/getDigitalSignature',

  /* --- letterhead --- */
  /** A letterhead is always a PAIR: both `headerFile` and `footerFile` are required. */
  letterHeadUpload: '/v2/kmailSetting/letterHeadUpload',
  /** Activation is exclusive — selecting one deactivates whichever was active. */
  setLetterHead: '/v2/kmailSetting/setLetterHead',
  deleteLetterHead: '/v2/kmailSetting/deleteLetterHead',
  getLetterHead: '/v2/kmailSetting/getLetterHead',
  getAllLetterHead: '/v2/kmailSetting/getAllLetterHead',
  getLetterHeadTemplate: '/v2/kmailSetting/getLetterHeadTemplate',

  /* --- canned text --- */
  saveOrUpdateCustomizedSaluations: '/v2/kmailSetting/saveOrUpdateCustomizedSaluations',
  deleteCustomizedSaluation: '/v2/kmailSetting/deleteCustomizedSaluation',
  saveOrUpdateCustomizedInstantReply: '/v2/kmailSetting/saveOrUpdateCustomizedInstantReply',
  deleteCustomizedInstantReply: '/v2/kmailSetting/deleteCustomizedInstantReply',

  /* --- mail-count day window --- */
  /** Sets how many days back the mailbox counts. Body `{ countDaysLimit }` (Excel [E]). */
  updateMailCountDaysLimit: '/v2/kmailSetting/updateMailCountDaysLimit',
  /** Reads the current window. GET, no body (corrected to GET in Excel v5). */
  getMailCountDaysLimit: '/v2/kmailSetting/getMailCountDaysLimit',
} as const;

/* ======================================================================== translator == */

export const TRANSLATOR_PATHS = {
  /** Detects the source language when `langFrom` is omitted, then translates. */
  translation: '/v2/translator/translation',
  /** Send path on the translator controller — documented as the unauthenticated variant. */
  postMail: '/v2/translator/postMail',
} as const;

/* ============================================================================ kloud === */

export const KMAIL_DATA_PATHS = {
  getKloudUsedData: '/v2/kmailData/getKloudUsedData',
} as const;

/* ========================================================================= templates == */

/**
 * Template form of every path-variable route, so findings group by route not by id. These are the
 * strings a spec passes as `META.path`; the builders above are what the client actually calls.
 */
export const PATH_TEMPLATES = {
  bulkMailStatus: '/v2/sentMail/bulkMail/status/{fromAddress}',
  mediaStreaming: '/v2/readMail/mediaStreaming/{uuid}',
  getCopiesInfo: '/v2/readMail/getCopiesInfo/{kmailID}',
  downloadThumbnail: '/v2/readMail/downloadThumbnail/{uuid}',
  download: '/v2/readMail/download/{uuid}',
} as const;

/**
 * Every authenticated route in the API, as `[method, path]`. Drives the cross-cutting auth matrix
 * in `tests/auth/` (does an absent/expired/malformed/forged token reach this route?).
 *
 * `saveUnsubscriberDetails` and the translator's `postMail` are deliberately absent — documented as
 * unauthenticated by design, so asserting 401 would file against intended behaviour.
 */
export const AUTHENTICATED_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'POST', path: SENT_MAIL_PATHS.postMail },
  { method: 'POST', path: SENT_MAIL_PATHS.postBulkMail },
  { method: 'POST', path: SENT_MAIL_PATHS.loadMail },
  { method: 'POST', path: SENT_MAIL_PATHS.getMailCredentials },
  { method: 'GET', path: SENT_MAIL_PATHS.loadOtherDomainMails },

  { method: 'POST', path: READ_MAIL_PATHS.sentAndInboxMailContent },
  { method: 'POST', path: READ_MAIL_PATHS.referenceMailContent },
  { method: 'POST', path: READ_MAIL_PATHS.getKmailDetailsUsingKmailID },
  { method: 'POST', path: READ_MAIL_PATHS.draftMailContent },
  { method: 'POST', path: READ_MAIL_PATHS.downloadAttachment },
  { method: 'POST', path: READ_MAIL_PATHS.downloadODAttachment },

  { method: 'POST', path: DRAFT_PATHS.draftMail },
  { method: 'POST', path: DRAFT_PATHS.deleteDraftMail },
  { method: 'POST', path: DRAFT_PATHS.getDraftMailsForSelectedContact },
  { method: 'GET', path: DRAFT_PATHS.getAllDraftMails },
  { method: 'GET', path: DRAFT_PATHS.getDraftMailsContacts },

  { method: 'POST', path: MAILBOX_PATHS.getKmailDashboardMsg },
  { method: 'POST', path: MAILBOX_PATHS.getKmailDashboardNewMsg },
  { method: 'POST', path: MAILBOX_PATHS.getBulkKmailDashboardMsg },
  { method: 'POST', path: MAILBOX_PATHS.getAllMailCount },
  { method: 'POST', path: MAILBOX_PATHS.getAllImportantMails },
  { method: 'POST', path: MAILBOX_PATHS.selectedContactMails },
  { method: 'POST', path: MAILBOX_PATHS.mailSubjectSelectedContact },
  { method: 'POST', path: MAILBOX_PATHS.setKmailAsImportant },
  { method: 'POST', path: MAILBOX_PATHS.deleteKmailWithDeletedBy },
  { method: 'POST', path: MAILBOX_PATHS.sentMailNotOpened },
  { method: 'POST', path: MAILBOX_PATHS.replyNotReceived },
  { method: 'POST', path: MAILBOX_PATHS.replyNotSent },
  { method: 'POST', path: MAILBOX_PATHS.clearStatusOfKmailsContacts },
  { method: 'POST', path: MAILBOX_PATHS.addOtherDomainContacts },
  { method: 'POST', path: MAILBOX_PATHS.editOtherDomainContactsDetails },
  { method: 'POST', path: MAILBOX_PATHS.deleteOtherDomainContact },
  { method: 'POST', path: MAILBOX_PATHS.knownPostBoxContacts },
  { method: 'GET', path: MAILBOX_PATHS.unOpenedMailCountBySenderID },
  { method: 'GET', path: MAILBOX_PATHS.miscellaneousContacts },
  { method: 'GET', path: MAILBOX_PATHS.frequentKmailContact },
  { method: 'GET', path: MAILBOX_PATHS.statusOfKmailsContactsTotalCount },
  // Added 2026-09-09 (coverage audit): secured /common routes that previously had at most a single
  // token:null test and so never faced the alg=none forgery / wrong-key token the matrix applies.
  { method: 'POST', path: MAILBOX_PATHS.kmailGroupReadStatus },
  { method: 'POST', path: MAILBOX_PATHS.replyNotRequiredBySender },
  { method: 'POST', path: MAILBOX_PATHS.replyNotRequiredByReceiver },
  { method: 'POST', path: MAILBOX_PATHS.statusOfKmailsContactsWithCount },
  { method: 'POST', path: MAILBOX_PATHS.clearStatusOfAllKmailsContacts },
  { method: 'POST', path: MAILBOX_PATHS.convertMailAsPDF },
  { method: 'GET', path: MAILBOX_PATHS.getSaluations },
  { method: 'GET', path: MAILBOX_PATHS.getInstantReply },

  { method: 'GET', path: SETTING_PATHS.getMailSignature },
  { method: 'GET', path: SETTING_PATHS.getDigitalSignature },
  { method: 'GET', path: SETTING_PATHS.getLetterHead },
  { method: 'GET', path: SETTING_PATHS.getAllLetterHead },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignature },
  { method: 'POST', path: SETTING_PATHS.setLetterHead },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateCustomizedSaluations },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateCustomizedInstantReply },
  { method: 'POST', path: SETTING_PATHS.updateMailCountDaysLimit },
  { method: 'GET', path: SETTING_PATHS.getMailCountDaysLimit },
  // Added 2026-09-09 (coverage audit): the per-block signature setters, the letterhead/salutation/
  // instant-reply deletes, and the letterhead-template read all mutate or expose per-user data yet
  // had no forged-token coverage. (letterHeadUpload stays out — it is multipart; the JSON matrix
  // cannot probe it, so its auth is asserted in settings.spec.)
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignaturePersonalData },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignatureCompanyData },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignatureGraphics },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignatureStyle },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignatureSocialMediaLink },
  { method: 'POST', path: SETTING_PATHS.saveOrUpdateMailSignatureTemplateId },
  { method: 'POST', path: SETTING_PATHS.deleteLetterHead },
  { method: 'POST', path: SETTING_PATHS.deleteCustomizedSaluation },
  { method: 'POST', path: SETTING_PATHS.deleteCustomizedInstantReply },
  { method: 'GET', path: SETTING_PATHS.getLetterHeadTemplate },

  { method: 'GET', path: KMAIL_DATA_PATHS.getKloudUsedData },
];

/**
 * Routes the API documents as reachable WITHOUT a token. Listed so the auth matrix skips them, and so
 * the unsubscribe spec can assert the documented risk (anyone reaching it can opt any address out).
 */
export const DOCUMENTED_ANONYMOUS_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> =
  [
    { method: 'POST', path: MAILBOX_PATHS.saveUnsubscriberDetails },
    { method: 'POST', path: TRANSLATOR_PATHS.postMail },
  ];
