import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Katchup Messaging V2 controller, in one place. */
export const KATCHUP_PATHS = {
  // Sending
  sendMessage: '/v2/katchup/sendMessage',
  sendMessageForForwardSelectedAttachment: '/v2/katchup/sendMessageForForwardSelectedAttachment',
  sendBulkKatchupMsg: '/v2/katchup/sendBulkKatchupMsg',
  sendKatchupMsgMultiPart: '/v2/katchup/sendKatchupMsgMultiPart/',
  sendBulkKatchupMsgMultiPart: '/v2/katchup/sendBulkKatchupMsgMultiPart/',
  saveKatchupMessages: '/v2/katchup/saveKatchupMessages',
  patchWorkForGroup: '/v2/katchup/patchWorkForGroup',
  changeCaption: '/v2/katchup/changeCaption',

  // Forwarding and references
  forwardKatchupMessage: '/v2/katchup/forwardKatchupMessage',
  forwardKatchupMessageNew: '/v2/katchup/forwardKatchupMessageNew',
  forwardKatchupMultipleMsgs: '/v2/katchup/forwardKatchupMultipleMsgs',
  forwardMessageBacktrackByMsgID: '/v2/katchup/forwardMessageBacktrackByMsgID',
  getSharedMessageInfo: '/v2/katchup/getSharedMessageInfo',
  getSharedMessageDetails: (msgID: string | number) =>
    `/v2/katchup/getSharedMessageDetails/${encodeURIComponent(String(msgID))}`,
  getBulkMessageInfo: '/v2/katchup/getBulkMessageInfo',
  getReferenceMessagesDetails: '/v2/katchup/getReferenceMessagesDetails',
  getReferenceMSGDetails: '/v2/katchup/getReferenceMSGDetails',
  getMessagesByReferenceMessageList: '/v2/katchup/getMessagesByReferenceMessageList',

  // Search and read
  searchKatchUpMessage: '/v2/katchup/searchKatchUpMessage',
  searchKatchUpMessageSubject: '/v2/katchup/searchKatchUpMessageSubject',
  katchupSearch: '/v2/katchup/katchupSearch',
  filterKatchUpMessage: '/v2/katchup/filterKatchUpMessage',
  katchupMessagesForSelectedContactID: '/v2/katchup/katchupMessagesForSelectedContactID',
  getKatchupMessagesSubject: (selectedContact: string) =>
    `/v2/katchup/getKatchupMessagesSubject/${encodeURIComponent(selectedContact)}`,
  messageCountBetweenSenderAndReceiver: '/v2/katchup/messageCountBetweenSenderAndReceiver',
  frequentlyAccessContacts: '/v2/katchup/frequentlyAccessContacts',
  getUnopenedMessagesCount: '/v2/katchup/getUnopenedMessagesCount',
  getUnopenedMessagesAndKmailsTotalCount:
    '/v2/katchup/getUnopenedMessagesAndKmailsTotalCount',
  getReadStatusGroupMessage: '/v2/katchup/getReadStatusGroupMessage',
  getDeletedKatchupMsgIds: (lastMsgID: string | number) =>
    `/v2/katchup/getDeletedKatchupMsgIds/${encodeURIComponent(String(lastMsgID))}`,

  // Lifecycle
  deleteKatchUpMessage: '/v2/katchup/deleteKatchUpMessage',
  recallMessage: '/v2/katchup/recallMessage',
  markOrUnmarkImportantMessage: '/v2/katchup/markOrUnmarkImportantMessage',
  reportAbuse: '/v2/katchup/reportAbuse',
  getAllReportMsg: '/v2/katchup/getAllReportMsg',

  // Attachments
  uploadMultipartFiles: '/v2/katchup/uploadMultipartFiles/',
  generateThumbnailUsingUUID: '/v2/katchup/generateThumbnailUsingUUID',
  download: (uuid: string) => `/v2/katchup/download/${encodeURIComponent(uuid)}`,
  downloadAttachment: (uuid: string) => `/v2/katchup/downloadAttachment/${encodeURIComponent(uuid)}`,
  downloadFromS3: (uuid: string) => `/v2/katchup/downloadFromS3/${encodeURIComponent(uuid)}`,
  downloadThumbnail: (uuid: string) => `/v2/katchup/downloadThumbnail/${encodeURIComponent(uuid)}`,
  oldDownload: (uuid: string) => `/v2/katchup/oldDownload/${encodeURIComponent(uuid)}`,
  mediaStreaming: (uuid: string) => `/v2/katchup/mediaStreaming/${encodeURIComponent(uuid)}`,
} as const;

/** Template form for bug-ledger metadata, so findings group by route not by id. */
export const KATCHUP_PATH_TEMPLATES = {
  getSharedMessageDetails: '/v2/katchup/getSharedMessageDetails/{msgID}',
  getKatchupMessagesSubject: '/v2/katchup/getKatchupMessagesSubject/{selectedContact}',
  getDeletedKatchupMsgIds: '/v2/katchup/getDeletedKatchupMsgIds/{lastMsgID}',
  download: '/v2/katchup/download/{uuid}',
  downloadAttachment: '/v2/katchup/downloadAttachment/{uuid}',
  downloadFromS3: '/v2/katchup/downloadFromS3/{uuid}',
  downloadThumbnail: '/v2/katchup/downloadThumbnail/{uuid}',
  oldDownload: '/v2/katchup/oldDownload/{uuid}',
  mediaStreaming: '/v2/katchup/mediaStreaming/{uuid}',
} as const;

// Of the six UUID attachment routes, four read the caller's identity; `downloadAttachment` and
// `downloadThumbnail` are permitAll (UUID is the only access control) — confirmed protected by the
// product owner, so the tests still assert auth on them.
export const DOWNLOAD_ROUTES = [
  { name: 'download', authenticated: true, build: KATCHUP_PATHS.download },
  { name: 'downloadAttachment', authenticated: false, build: KATCHUP_PATHS.downloadAttachment },
  { name: 'downloadFromS3', authenticated: true, build: KATCHUP_PATHS.downloadFromS3 },
  { name: 'downloadThumbnail', authenticated: false, build: KATCHUP_PATHS.downloadThumbnail },
  { name: 'oldDownload', authenticated: true, build: KATCHUP_PATHS.oldDownload },
  { name: 'mediaStreaming', authenticated: true, build: KATCHUP_PATHS.mediaStreaming },
] as const;

// Shapes preserved on purpose: sendMessageForForwardSelectedAttachment has its setSender commented
// out (sender is whatever the body says); downloadAttachment/downloadThumbnail are permitAll.
export class KatchupV2Client extends BaseClient {
  /* ---- sending ---- */

  sendMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.sendMessage, data, options);
  }

  /** Sender assignment is commented out in the controller — body-controlled. */
  sendMessageForForwardSelectedAttachment(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.sendMessageForForwardSelectedAttachment, data, options);
  }

  /** The highest fan-out write in the API — one push notification per recipient. */
  sendBulkKatchupMsg(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.sendBulkKatchupMsg, data, options);
  }

  sendKatchupMsgMultiPart(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.sendKatchupMsgMultiPart, data, options);
  }

  sendBulkKatchupMsgMultiPart(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.sendBulkKatchupMsgMultiPart, data, options);
  }

  saveKatchupMessages(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.saveKatchupMessages, data, options);
  }

  patchWorkForGroup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.patchWorkForGroup, data, options);
  }

  changeCaption(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.changeCaption, data, options);
  }

  /* ---- forwarding and references ---- */

  forwardKatchupMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.forwardKatchupMessage, data, options);
  }

  forwardKatchupMessageNew(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.forwardKatchupMessageNew, data, options);
  }

  forwardKatchupMultipleMsgs(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.forwardKatchupMultipleMsgs, data, options);
  }

  forwardMessageBacktrackByMsgID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.forwardMessageBacktrackByMsgID, data, options);
  }

  getSharedMessageInfo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getSharedMessageInfo, data, options);
  }

  getSharedMessageDetails(msgID: string | number, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getSharedMessageDetails(msgID), options);
  }

  getBulkMessageInfo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getBulkMessageInfo, data, options);
  }

  getReferenceMessagesDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getReferenceMessagesDetails, data, options);
  }

  getReferenceMSGDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getReferenceMSGDetails, data, options);
  }

  getMessagesByReferenceMessageList(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getMessagesByReferenceMessageList, data, options);
  }

  /* ---- search and read ---- */

  searchKatchUpMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.searchKatchUpMessage, data, options);
  }

  searchKatchUpMessageSubject(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.searchKatchUpMessageSubject, data, options);
  }

  katchupSearch(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.katchupSearch, data, options);
  }

  filterKatchUpMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.filterKatchUpMessage, data, options);
  }

  katchupMessagesForSelectedContactID(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.katchupMessagesForSelectedContactID, data, options);
  }

  getKatchupMessagesSubject(
    selectedContact: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getKatchupMessagesSubject(selectedContact), options);
  }

  messageCountBetweenSenderAndReceiver(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.messageCountBetweenSenderAndReceiver, data, options);
  }

  frequentlyAccessContacts(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.frequentlyAccessContacts, options);
  }

  getUnopenedMessagesCount(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getUnopenedMessagesCount, options);
  }

  getUnopenedMessagesAndKmailsTotalCount(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getUnopenedMessagesAndKmailsTotalCount, options);
  }

  getReadStatusGroupMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.getReadStatusGroupMessage, data, options);
  }

  getDeletedKatchupMsgIds(
    lastMsgID: string | number,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getDeletedKatchupMsgIds(lastMsgID), options);
  }

  /* ---- lifecycle ---- */

  deleteKatchUpMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.deleteKatchUpMessage, data, options);
  }

  recallMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.recallMessage, data, options);
  }

  markOrUnmarkImportantMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.markOrUnmarkImportantMessage, data, options);
  }

  reportAbuse(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.reportAbuse, data, options);
  }

  getAllReportMsg(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.getAllReportMsg, options);
  }

  /* ---- attachments ---- */

  uploadMultipartFiles(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.uploadMultipartFiles, data, options);
  }

  generateThumbnailUsingUUID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KATCHUP_PATHS.generateThumbnailUsingUUID, data, options);
  }

  download(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.download(uuid), options);
  }

  /** No token required by the backend — that is the finding, not a client shortcut. */
  downloadAttachment(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.downloadAttachment(uuid), options);
  }

  downloadFromS3(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.downloadFromS3(uuid), options);
  }

  /** No token required by the backend. */
  downloadThumbnail(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.downloadThumbnail(uuid), options);
  }

  oldDownload(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.oldDownload(uuid), options);
  }

  mediaStreaming(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KATCHUP_PATHS.mediaStreaming(uuid), options);
  }

  /** Fetches any path with an arbitrary token state, for the download-matrix cases. */
  getPath(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
