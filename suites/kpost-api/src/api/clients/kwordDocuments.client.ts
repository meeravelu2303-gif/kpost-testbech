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
  // Real-time collaboration (Excel rows 261-265). All but joinDocument are GETs keyed by docId.
  joinDocument: '/kword/joinDocument',
  presence: (docId: string) => `/kword/presence/${encodeURIComponent(docId)}`,
  exitDocument: (docId: string) => `/kword/exitDocument/${encodeURIComponent(docId)}`,
  getAccessActivity: (docId: string) => `/kword/getAccessActivity/${encodeURIComponent(docId)}`,
  getAllRevision: (docId: string) => `/kword/getAllRevision/${encodeURIComponent(docId)}`,
} as const;

/** Template form used for bug-ledger metadata, so findings group by route not by id. */
export const KWORD_PATH_TEMPLATES = {
  documentById: '/kword/documents/{docId}',
  presence: '/kword/presence/{docId}',
  exitDocument: '/kword/exitDocument/{docId}',
  getAccessActivity: '/kword/getAccessActivity/{docId}',
  getAllRevision: '/kword/getAllRevision/{docId}',
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

  /** Register the caller as an active editor of a document. */
  joinDocument(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KWORD_PATHS.joinDocument, data, options);
  }

  /** Who is currently in a document — a live roster of collaborators. */
  presence(docId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.presence(docId), options);
  }

  /** Release the caller's editing slot on a document. */
  exitDocument(docId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.exitDocument(docId), options);
  }

  /** The access audit trail for a document — who opened it and when. */
  getAccessActivity(docId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.getAccessActivity(docId), options);
  }

  /** Every saved revision of a document's body. */
  getAllRevision(docId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KWORD_PATHS.getAllRevision(docId), options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
