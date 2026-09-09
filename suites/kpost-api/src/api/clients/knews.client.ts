import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Knews controller, in one place. */
export const KNEWS_PATHS = {
  updateKnewsSettings: '/v2/knews/updateKnewsSettings',
  getSubCategoriesByCategoryId: '/v2/knews/getSubCategoriesByCategoryId',
  getPublicationByLanguageId: '/v2/knews/getPublicationByLanguageId',
  getKnewsSettings: '/v2/knews/getKnewsSettings',
  getAllNewsSource: '/v2/knews/getAllNewsSource',
  getAllCategories: '/v2/knews/getAllCategories',
} as const;

// Payloads are typed `unknown` so fuzzing drives malformed bodies through the happy-path code.
export class KnewsClient extends BaseClient {
  /** Persist the caller's Knews preferences. */
  updateKnewsSettings(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KNEWS_PATHS.updateKnewsSettings, data, options);
  }

  /** List sub-categories belonging to a parent category. */
  getSubCategoriesByCategoryId(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KNEWS_PATHS.getSubCategoriesByCategoryId, data, options);
  }

  /** List publications available in a language. */
  getPublicationByLanguageId(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KNEWS_PATHS.getPublicationByLanguageId, data, options);
  }

  /** Read the caller's persisted Knews preferences. */
  getKnewsSettings(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KNEWS_PATHS.getKnewsSettings, options);
  }

  /** List every configured news source. */
  getAllNewsSource(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KNEWS_PATHS.getAllNewsSource, options);
  }

  /** List every configured news category. */
  getAllCategories(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KNEWS_PATHS.getAllCategories, options);
  }

  /** Sends a raw, possibly malformed body to any Knews route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
