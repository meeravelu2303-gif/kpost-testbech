import { APIResponse } from '@playwright/test';
import { BaseClient, FilePart, MultipartPart, RequestOptions } from '../../helpers/base.client';
import { DRAFT_PATHS } from '../routes/kmail.routes';

/**
 * Client for the Draft Mail controller (`/v2/draft/**`). `fromAddress` is overwritten from the JWT.
 *
 *  - `cc`/`bcc` are single delimited STRINGS on a draft, not the send DTO's `ccList`/`bccList` arrays.
 *  - `kmailID` is the draft's own MySQL identity — update must send it back or a second draft is created.
 *  - `draftMail` takes the compose DTO (`SentMailRequestObject`); `getDraftMailsForSelectedContact`
 *    and `deleteDraftMail` take the `Draft` DTO. Mixing them yields a Jackson 400 (unknown fields rejected).
 */
export class DraftClient extends BaseClient {
  /** Saves a new draft, or updates an existing one when `kmailID` is set. */
  draftMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DRAFT_PATHS.draftMail, data, options);
  }

  /**
   * Saves a draft with binaries. `text` carries the JSON compose DTO as a query param; binaries are
   * repeated `files` parts. The service forces `attachmentFlag` to 1 here regardless of the DTO.
   */
  draftMailMultiPart(
    text: string,
    files: FilePart[],
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.postMultipartRaw(DRAFT_PATHS.draftMailMultiPart, toFileParts(files), {
      ...options,
      params: { ...options.params, text },
    });
  }

  /** Deletes a draft by `kmailID`. Takes the `Draft` DTO, not the compose one. */
  deleteDraftMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DRAFT_PATHS.deleteDraftMail, data, options);
  }

  /** Lists drafts addressed to one contact, filtered on `toAddress`. */
  getDraftMailsForSelectedContact(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(DRAFT_PATHS.getDraftMailsForSelectedContact, data, options);
  }

  /** Every draft belonging to the authenticated user. */
  getAllDraftMails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(DRAFT_PATHS.getAllDraftMails, options);
  }

  /** The distinct recipients across the user's drafts. */
  getDraftMailsContacts(options?: RequestOptions): Promise<APIResponse> {
    return this.get(DRAFT_PATHS.getDraftMailsContacts, options);
  }

  /** Sends a raw, possibly malformed body to any draft route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}

/** See `sentMail.client.ts` — an empty list still emits one zero-length `files` part. */
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
