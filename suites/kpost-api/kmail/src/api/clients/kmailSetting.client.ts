import { APIResponse } from '@playwright/test';
import { BaseClient, FilePart, RequestOptions } from '../../helpers/base.client';
import { SETTING_PATHS } from '../routes/kmail.routes';

/**
 * Client for the KMail Settings controller (`/v2/kmailSetting/**`) — signature, letterhead,
 * salutations, instant replies. All writes land in one MySQL row (`UsersKmailSetting`) owned by
 * the JWT's `kpostID`.
 *
 *  - The signature has seven write endpoints for one JSON column: six write a single block,
 *    `saveOrUpdateMailSignature` replaces all together. Whether a block write preserves its siblings
 *    is asserted via `getMailSignature`.
 *  - A letterhead is a PAIR: `letterHeadUpload` requires both `headerFile` and `footerFile`.
 *  - Activation is exclusive: `setLetterHead` deactivates whichever was active.
 *
 * The signature block endpoints declare a bare `{"type":"object"}` body in OpenAPI; payload shapes
 * come from the `mailSignature` column, and specs assert round-trip rather than a field list.
 */
export class KmailSettingClient extends BaseClient {
  /* ------------------------------------------------------------------------ signature -- */

  /** Replaces every signature block in one call. */
  saveOrUpdateMailSignature(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignature, data, options);
  }

  /** Chooses the signature template layout. */
  saveOrUpdateMailSignatureTemplateId(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignatureTemplateId, data, options);
  }

  saveOrUpdateMailSignatureStyle(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignatureStyle, data, options);
  }

  saveOrUpdateMailSignatureSocialMediaLink(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignatureSocialMediaLink, data, options);
  }

  saveOrUpdateMailSignaturePersonalData(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignaturePersonalData, data, options);
  }

  saveOrUpdateMailSignatureGraphics(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignatureGraphics, data, options);
  }

  saveOrUpdateMailSignatureCompanyData(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateMailSignatureCompanyData, data, options);
  }

  /** The assembled signature, as the compose screen renders it. */
  getMailSignature(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getMailSignature, options);
  }

  /** The raw `UsersKmailSetting` record. Broader than `getMailSignature`. */
  getDigitalSignature(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getDigitalSignature, options);
  }

  /* ----------------------------------------------------------------------- letterhead -- */

  /** Uploads a header/footer image pair — both required, distinct field names. */
  letterHeadUpload(
    headerFile: FilePart,
    footerFile: FilePart,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.postMultipart(
      SETTING_PATHS.letterHeadUpload,
      { headerFile, footerFile },
      options
    );
  }

  /** Sends whatever parts the caller supplies — used for the missing-half boundary cases. */
  letterHeadUploadRaw(
    parts: Record<string, string | number | boolean | FilePart>,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.postMultipart(SETTING_PATHS.letterHeadUpload, parts, options);
  }

  /** Activates one letterhead, deactivating whichever was active. Body is `{ id }`. */
  setLetterHead(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.setLetterHead, data, options);
  }

  /** Deletes an uploaded letterhead. Body is `{ id }`. */
  deleteLetterHead(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.deleteLetterHead, data, options);
  }

  /** The currently active letterhead. */
  getLetterHead(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getLetterHead, options);
  }

  /** Every letterhead the user has uploaded. */
  getAllLetterHead(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getAllLetterHead, options);
  }

  /** The system-provided signature templates. Shared reference data, not user-owned. */
  getLetterHeadTemplate(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getLetterHeadTemplate, options);
  }

  /* ---------------------------------------------------------------------- canned text -- */

  /** Creates a salutation when `saluationID` is omitted; updates it when supplied. */
  saveOrUpdateCustomizedSaluations(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateCustomizedSaluations, data, options);
  }

  /** Deletes a salutation. `saluationID` is required here, unlike on the save path. */
  deleteCustomizedSaluation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.deleteCustomizedSaluation, data, options);
  }

  /** Creates an instant reply when `id` is omitted; updates it when supplied. */
  saveOrUpdateCustomizedInstantReply(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(SETTING_PATHS.saveOrUpdateCustomizedInstantReply, data, options);
  }

  /** Deletes an instant reply. `id` is required here, unlike on the save path. */
  deleteCustomizedInstantReply(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.deleteCustomizedInstantReply, data, options);
  }

  /* ------------------------------------------------------------- mail-count day window -- */

  /** Sets how many days back the mailbox counts mail. Body `{ countDaysLimit }`. */
  updateMailCountDaysLimit(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(SETTING_PATHS.updateMailCountDaysLimit, data, options);
  }

  /** Reads the current mail-count day window. GET, no body. */
  getMailCountDaysLimit(options?: RequestOptions): Promise<APIResponse> {
    return this.get(SETTING_PATHS.getMailCountDaysLimit, options);
  }

  /** Sends a raw, possibly malformed body to any settings route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
