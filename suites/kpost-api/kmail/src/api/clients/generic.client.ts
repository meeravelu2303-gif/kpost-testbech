import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from '../../helpers/base.client';
import { env } from '../../config/env.config';

/**
 * Path-driven client — issues any verb at any path. For cross-cutting probes (the auth matrix, the
 * ownership cases) where the assertion is identical and only the address changes. Endpoint behaviour
 * tests stay in their typed client.
 */
export class GenericClient extends BaseClient {
  /** Sends `body` at `path` using `method`. GET/DELETE/HEAD carry no body, so the payload folds into the query string. */
  send(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const verb = method.toUpperCase();

    if (verb === 'GET' || verb === 'DELETE' || verb === 'HEAD') {
      const params: Record<string, string | number | boolean> = { ...options.params };
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value === null || value === undefined) continue;
        params[key] = typeof value === 'object' ? JSON.stringify(value) : (value as string);
      }
      return verb === 'DELETE'
        ? this.fetchWithVerb('delete', path, { ...options, params })
        : this.get(path, { ...options, params });
    }

    return this.post(path, body ?? {}, options);
  }

  /**
   * Sends a raw, unparsed body — for malformed-JSON fuzzing. The universal structural probe: invalid
   * JSON must be rejected 400/415 regardless of DTO, whereas a wrong-typed field is ambiguous.
   */
  sendRaw(
    method: string,
    path: string,
    rawBody: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const verb = method.toUpperCase();
    if (verb === 'GET' || verb === 'HEAD' || verb === 'DELETE') {
      // No body to malform on a bodyless verb; a wrong-typed query value is the analogue.
      return this.get(path, { ...options, params: { ...options.params, id: rawBody } });
    }
    return this.postRaw(path, rawBody, options);
  }

  /** Appends a path segment, for routes whose owner key travels in the URL. */
  sendToPathVariable(
    method: string,
    basePath: string,
    segment: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.send(method, `${basePath}/${encodeURIComponent(segment)}`, undefined, options);
  }

  /** Issues a verb the route does not declare, to prove the mapping is not a bare @RequestMapping. */
  withVerb(
    method: 'delete' | 'put' | 'patch' | 'head' | 'options',
    path: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.fetchWithVerb(method, path, options);
  }
}

/**
 * Identifiers belonging to nobody the caller owns. SAFETY: the numeric ids sit far above any
 * plausible auto-increment value, so a write reaching them cannot damage a real record.
 *
 * `victimKpostID` must be a REAL second account (`QA_VICTIM_KPOST_ID`): a non-existent identity is
 * served the caller's own data, so a comparison would report a breach that never happened. Ownership
 * assertions skip, with reason stated, when it is unset.
 */
export const FOREIGN = {
  get victimKpostID(): string {
    return env.qaVictimKpostId;
  },
  /** True when a real second account is configured. Ownership specs gate on this. */
  get hasVictim(): boolean {
    return env.qaVictimKpostId.length > 0;
  },
  kmailID: 987654321,
  draftKmailID: 987654322,
  transactionID: 987654323,
  contactID: 987654324,
  letterHeadID: '987654325',
  saluationID: '987654326',
  instantReplyID: '987654327',
  uuid: '00000000-0000-4000-8000-000000000001',
} as const;
