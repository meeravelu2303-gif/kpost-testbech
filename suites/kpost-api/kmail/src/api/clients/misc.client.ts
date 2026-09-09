import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from '../../helpers/base.client';
import { KMAIL_DATA_PATHS, RETIRED_PATHS, TRANSLATOR_PATHS } from '../routes/kmail.routes';

/**
 * Client for the Translation controller (`/v2/translator/**`). The notable route is `postMail`: a
 * second send path documented as the "Unauthenticated Translator Path" — a duplicate authenticated
 * write on a non-write controller. `tests/translator/` compares its behaviour against `/v2/sentMail/postMail`.
 */
export class TranslatorClient extends BaseClient {
  /** Detects the source language and translates. Omitting `langFrom` triggers third-party auto-detection. */
  translation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(TRANSLATOR_PATHS.translation, data, options);
  }

  /** The translator controller's send path. Documented as not requiring a token. */
  postMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(TRANSLATOR_PATHS.postMail, data, options);
  }

  /** `[Dead Code]` per the API's own documentation. Still mapped, so still reachable. */
  unusedPostMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(RETIRED_PATHS.translatorUnusedPostMail, data, options);
  }

  /** Sends a raw, possibly malformed body to any translator route. */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}

/**
 * Client for the Storage Quota controller (`/v2/kmailData/**`). One route, the cheapest authenticated
 * read in the API — `authSession.ts` uses it to verify a token actually opens the KMail host.
 */
export class KmailDataClient extends BaseClient {
  /** KLOUD storage consumption for the authenticated user. */
  getKloudUsedData(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KMAIL_DATA_PATHS.getKloudUsedData, options);
  }
}
