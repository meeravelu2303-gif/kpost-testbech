import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the KPresentation controller, in one place. */
export const KPRESENTATION_PATHS = {
  create: '/kpresentation/create',
  savePresentation: '/kpresentation/savePresentation',
  presentations: '/kpresentation/presentations',
  presentationById: (presentationId: string) =>
    `/kpresentation/presentations/${encodeURIComponent(presentationId)}`,
  delete: '/kpresentation/delete',
} as const;

/** Template form used for bug-ledger metadata, so findings group by route not by id. */
export const KPRESENTATION_PATH_TEMPLATES = {
  presentationById: '/kpresentation/presentations/{presentationId}',
} as const;

// `deletePresentation` is a destructive GET keyed by a query parameter — preserved on purpose.
export class KPresentationClient extends BaseClient {
  /** Create a deck owned by the caller; returns the generated presentationId. */
  create(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KPRESENTATION_PATHS.create, data, options);
  }

  /** Persist edits: slide content, ordering and title. Overwrites the stored deck. */
  savePresentation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(KPRESENTATION_PATHS.savePresentation, data, options);
  }

  /** List the caller's decks as lightweight summaries, without slide content. */
  presentations(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KPRESENTATION_PATHS.presentations, options);
  }

  /** Load one full deck including slide content. */
  presentationById(presentationId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(KPRESENTATION_PATHS.presentationById(presentationId), options);
  }

  /** Delete a deck — a destructive action exposed as `GET /kpresentation/delete?presentationId=…`. */
  deletePresentation(
    presentationId: string | number,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.get(KPRESENTATION_PATHS.delete, {
      ...options,
      params: { presentationId, ...options.params },
    });
  }

  /** Calls the delete route with no arguments at all, for binding-failure cases. */
  deleteWithoutId(options?: RequestOptions): Promise<APIResponse> {
    return this.get(KPRESENTATION_PATHS.delete, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
