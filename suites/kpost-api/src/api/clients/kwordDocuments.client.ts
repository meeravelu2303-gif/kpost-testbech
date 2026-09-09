import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the KWord Documents controller, in one place. */
export const KWORD_PATHS = {
  create: '/kword/create',
  update: '/kword/update',
  saveContent: '/kword/saveContent',
  share: '/kword/share',
  isConvertToKad: '/kword/isConvertToKad',
  delete: '/kword/delete',
  deleteHeading: '/kword/deleteHeading',
  documentsType: '/kword/documentsType',
  documentsType1: '/kword/documentsType1',
  documentById: (docId: string) => `/kword/documents/${encodeURIComponent(docId)}`,
} as const;

/** Template form used for bug-ledger metadata, so findings group by route not by id. */
export const KWORD_PATH_TEMPLATES = {
  documentById: '/kword/documents/{docId}',
} as const;

// Every route except `isConvertToKad` stamps the caller's kpostID onto the DTO (handler-enforced
// ownership); `isConvertToKad` does not, so it carries its own ownership tests.
export class KwordDocumentsClient extends BaseClient {
  /** Create a document owned by the caller; returns the generated docId. */
  create(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.create, data, options);
  }

  /** Apply changes to an existing document's metadata and heading structure. */
  update(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.update, data, options);
  }

  /** Persist body text. This is the editor's save/autosave path. */
  saveContent(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.saveContent, data, options);
  }

  /** Grant other KPOST users access to a document owned by the caller. */
  share(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.share, data, options);
  }

  /** Toggle the KAD-conversion flag — the handler does NOT stamp kpostID (ownership is service-side only). */
  isConvertToKad(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.isConvertToKad, data, options);
  }

  /** Delete a document, its headings, its content and every share of it. */
  delete(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.delete, data, options);
  }

  /** Delete one heading node and the content stored beneath it. */
  deleteHeading(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.deleteHeading, data, options);
  }

  /** List the caller's documents; an optional `type` query filters by document type. */
  documentsType(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.documentsType, options);
  }

  /** List every document belonging to the caller, with no type filtering. */
  documentsType1(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.documentsType1, options);
  }

  /** Load one complete document — metadata, heading tree and body content. */
  documentById(docId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.documentById(docId), options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
