import { APIResponse } from '@playwright/test';
import { BaseClient, FilePart, MultipartPart, RequestOptions } from '../../helpers/base.client';
import { LEGACY_PATHS, SENT_MAIL_PATHS } from '../routes/kmail.routes';

/**
 * Client for the Sent Mail controller (`/v2/sentMail/**`) — the compose and send surface.
 *
 * SAFETY: these routes deliver REAL mail. Recipient defaults in `sentMail.payload.ts` are synthetic
 * non-existent addresses; `postBulkMail` is opt-in behind `ALLOW_BULK_SEND` — it writes one
 * KmailMaster + KmailTransaction row and one MongoDB body per recipient and cannot be undone.
 *
 *  - `fromAddress` is server-assigned (overwritten from the JWT `kpostID`); spoofing tests set it anyway.
 *  - The multipart routes carry the JSON DTO in the `text` QUERY parameter, not as a JSON part;
 *    binaries are the `files` parts. Assuming a normal multipart mix yields a 500.
 */
export class SentMailClient extends BaseClient {
  /** Send a composed mail. Attachments must already be uploaded, referenced by `attachmentUuid`. */
  postMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SENT_MAIL_PATHS.postMail, data, options);
  }

  /**
   * Send with binaries. `text` is the JSON DTO as a query parameter; `files` are attachment parts.
   * An empty `files` array sends one zero-length part, which the service reads as "no attachments".
   */
  postMailMultiPart(
    text: string,
    files: FilePart[],
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.postMultipartRaw(SENT_MAIL_PATHS.postMailMultiPart, toFileParts(files), {
      ...options,
      params: { ...options.params, text },
    });
  }

  /** One mail per entry in `toAddressList`. The highest fan-out write in this API. */
  postBulkMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SENT_MAIL_PATHS.postBulkMail, data, options);
  }

  /**
   * A campaign whose recipient list or attachment arrives as an uploaded file. Unlike the other
   * multipart routes, the DTO is a genuine `bulkMailRequest` part alongside the `file` part.
   */
  postBulkMailMultipart(
    bulkMailRequest: unknown,
    file: FilePart,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.postMultipartRaw(
      SENT_MAIL_PATHS.postBulkMailMultipart,
      [
        { name: 'bulkMailRequest', value: JSON.stringify(bulkMailRequest) },
        { name: 'file', filename: file.name, mimeType: file.mimeType, buffer: file.buffer },
      ],
      options
    );
  }

  /** Echoes a compose payload back. Writes nothing — used to prove the DTO round-trips. */
  loadMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SENT_MAIL_PATHS.loadMail, data, options);
  }

  /**
   * Resolves mail-server credentials. The account is read from the BODY (`kpostID`), not the token
   * — so if the body's `kpostID` is honoured, one user can fetch another's credentials (ownership test).
   */
  getMailCredentials(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SENT_MAIL_PATHS.getMailCredentials, data, options);
  }

  /** Polls the external mail server and ingests anything new into the user's mailbox. */
  loadOtherDomainMails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SENT_MAIL_PATHS.loadOtherDomainMails, options);
  }

  /** Progress of a running campaign, addressed by sender. */
  bulkMailStatus(fromAddress: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(SENT_MAIL_PATHS.bulkMailStatus(fromAddress), options);
  }

  /** The unversioned duplicate of `postMailMultiPart`, still mapped by the controller. */
  legacyPostMailMultiPart(
    text: string,
    files: FilePart[],
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.postMultipartRaw(LEGACY_PATHS.postMailMultiPart, toFileParts(files), {
      ...options,
      params: { ...options.params, text },
    });
  }

  /** Sends a raw, possibly malformed body to any send route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}

/**
 * Turns the attachment list into repeated `files` parts. An empty list still emits one zero-length
 * part: the service reads "first part size 0" as "no attachments"; omitting the field takes a different branch.
 */
function toFileParts(files: FilePart[]): MultipartPart[] {
  if (files.length === 0) {
    return [
      { name: 'files', filename: '', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    ];
  }
  return files.map((file) => ({
    name: 'files',
    filename: file.name,
    mimeType: file.mimeType,
    buffer: file.buffer,
  }));
}
