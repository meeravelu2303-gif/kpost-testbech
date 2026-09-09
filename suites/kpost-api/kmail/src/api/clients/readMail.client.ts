import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from '../../helpers/base.client';
import { READ_MAIL_PATHS } from '../routes/kmail.routes';

/**
 * Client for the Read Mail & Attachments controller (`/v2/readMail/**`) — serves mail bodies.
 *
 *  - The DTO carries `kpostUser`, documented as overwritten from the token; ownership tests set it anyway.
 *  - `kmailType` is `@NotBlank` — a blank value is a documented HTTP 400.
 *  - The UUID-addressed download routes take no body; possession of the UUID is the whole identity,
 *    so tests treat a UUID in any response as a credential, not an identifier.
 */
export class ReadMailClient extends BaseClient {
  /** Opens a single mail and returns its body. */
  sentAndInboxMailContent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.sentAndInboxMailContent, data, options);
  }

  /** Reads every body in a thread, driven by the `referenceMails` chain. */
  referenceMailContent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.referenceMailContent, data, options);
  }

  /** Batch metadata fetch, driven by `kmailIDs`. */
  getKmailDetailsUsingKmailID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.getKmailDetailsUsingKmailID, data, options);
  }

  /** Reads a saved draft's body, driven by `draftKmailID`. */
  draftMailContent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.draftMailContent, data, options);
  }

  /** Resolves a mail's attachment metadata; `targetFileName` selects which one. */
  downloadAttachment(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.downloadAttachment, data, options);
  }

  /** The same, for a mail that arrived from outside the KPOST domain. */
  downloadODAttachment(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(READ_MAIL_PATHS.downloadODAttachment, data, options);
  }

  /** Full-size attachment bytes, addressed only by UUID. */
  download(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(READ_MAIL_PATHS.download(uuid), options);
  }

  /** Attachment thumbnail, addressed only by UUID. */
  downloadThumbnail(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(READ_MAIL_PATHS.downloadThumbnail(uuid), options);
  }

  /** Streams audio/video attachment content, addressed only by UUID. */
  mediaStreaming(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(READ_MAIL_PATHS.mediaStreaming(uuid), options);
  }

  /** Lists who received a mail and in which capacity. Asserted for whether it filters BCC from the caller's view. */
  getCopiesInfo(kmailID: string | number, options?: RequestOptions): Promise<APIResponse> {
    return this.get(READ_MAIL_PATHS.getCopiesInfo(kmailID), options);
  }

  /** Fetches any path with an arbitrary token state, for the download-matrix cases. */
  getPath(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }

  /** Sends a raw, possibly malformed body to any read route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
