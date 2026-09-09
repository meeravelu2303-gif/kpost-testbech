import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * Path-driven client — issues any verb at any path. Exists for OWNERSHIP probes: an IDOR case is
 * the same question at every endpoint ("does a foreign identifier reach someone else's record?"),
 * so a uniform shape fits. Endpoint-behaviour tests stay in their typed clients.
 */
export class GenericClient extends BaseClient {
  /**
   * Sends `body` at `path` using `method`. GET/DELETE/HEAD carry no body, so their payload is folded
   * into the query string — otherwise an ownership probe against a GET route would send nothing and
   * pass for the wrong reason.
   */
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
      return verb === 'GET' || verb === 'HEAD'
        ? this.get(path, { ...options, params })
        : this.fetchWithVerb('delete', path, { ...options, params });
    }

    return this.post(path, body ?? {}, options);
  }

  /**
   * Sends a raw, unparsed body — for malformed-JSON fuzzing. The universal type-fuzz probe: every
   * JSON endpoint must reject syntactically-invalid JSON with 400/415, whereas a wrong-typed field
   * is ambiguous (an endpoint that ignores it and succeeds is correct) and would manufacture false findings.
   */
  sendRaw(method: string, path: string, rawBody: string, options: RequestOptions = {}): Promise<APIResponse> {
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
}

/**
 * Identifiers belonging to nobody the caller owns. `admin` is included deliberately — it is the one
 * identity likely to EXIST on any KPOST environment, so a probe that resolves it proves real
 * cross-tenant reach, not just that a random string 404s. The rest are synthetic and safe at writes.
 */
export const FOREIGN = {
  kpostID: 'qavictim0001@kpostindia.com',
  adminKpostID: 'admin',
  // A REAL second account (owning data the caller must not see) — an unknown id proves nothing, since
  // the API ignores it and serves the caller's own data. Override with QA_VICTIM_KPOST_ID.
  victimKpostID: process.env.QA_VICTIM_KPOST_ID || 'qabenchnwvfb@kpostindia.com',
  // A REAL second BUSINESS account — the receiver so a business sender has a business counterparty.
  // Not yet KMail-provisioned, so business KMail sends target a personal receiver. Override with QA_BUSINESS_RECEIVER_KPOST_ID.
  businessReceiverKpostID: process.env.QA_BUSINESS_RECEIVER_KPOST_ID || 'md@qaadmv29531.kpost.in',
  groupID: 987654321,
  messageID: 987654321,
  contactID: 987654321,
  // A call id in the same impossible range the kall payload builders use (997_000_000+), NOT a
  // plausibly-real id — the generic [IDOR] probe posts this at destructive routes (endKoolKall),
  // so it must never resolve to a live call.
  kallID: 997_999_999,
  companyID: 987654321,
  uuid: '00000000-0000-4000-8000-000000000001',
  scheduleID: 987654321,
  documentID: 987654321,
} as const;
