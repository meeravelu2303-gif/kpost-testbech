import { EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../fixtures/api.fixture';
import { assertPublicRouteReachable, assertUnauthorized } from '../../utils/apiAssertions';
import type { Validator } from '../types';

/**
 * Credential shapes every secured endpoint must refuse.
 *
 * `assertUnauthorized` judges on 401/403 specifically, not on "not 2xx" — this API's auth filter
 * runs BEFORE routing, so a non-existent route also answers 401 to a bad token. A "must not
 * succeed" check would pass against a route that does not exist.
 */
const BAD_CREDENTIALS: Array<{ label: string; token: string | null; header?: string }> = [
  { label: 'no Authorization header', token: null },
  { label: 'an empty token', token: '' },
  { label: 'a malformed token', token: MALFORMED_TOKEN },
  { label: 'an expired token', token: EXPIRED_TOKEN },
  { label: 'an alg=none forged token claiming to be admin', token: FORGED_ALG_NONE_JWT },
  {
    label: 'a tampered signature',
    token: `${EXPIRED_TOKEN.split('.').slice(0, 2).join('.')}.tampered-signature`,
  },
  { label: 'Basic where Bearer is required', token: null, header: 'Basic cWE6cGFzc3dvcmQ=' },
  { label: 'a bare token with no scheme', token: null, header: EXPIRED_TOKEN },
];

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);

export const authenticationValidator: Validator = {
  stage: 'authentication',
  appliesTo: () => true,

  async run({ endpoint, request }) {
    const body = endpoint.buildRequest?.();
    const meta = {
      method: endpoint.method,
      path: endpoint.path,
      repro: `apiEngine.run('${endpoint.id}') — authentication`,
      body,
    };

    const send = (token: string | null, rawHeader?: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (rawHeader) headers.Authorization = rawHeader;
      else if (token !== null) headers.Authorization = `Bearer ${token}`;
      const options: Record<string, unknown> = { headers, failOnStatusCode: false };
      if (body !== undefined && !BODYLESS.has(endpoint.method)) options.data = body;
      return request.fetch(endpoint.path, { method: endpoint.method, ...options });
    };

    // A public route is the inverse assertion: it must be REACHABLE without a token.
    if (endpoint.auth === 'public') {
      await assertPublicRouteReachable(await send(null), meta);
      return { outcome: 'passed' };
    }

    const failures: string[] = [];
    for (const credential of BAD_CREDENTIALS) {
      const response = await send(credential.token, credential.header);
      const status = response.status();

      if (status === 429) continue; // throttling describes our rate, not the endpoint
      if (status === 401 || status === 403) continue;

      failures.push(`${credential.label} → HTTP ${status}`);
      // Delegated so the ledger grades it: served-protected-material differs from wrong-status.
      await assertUnauthorized(response, {
        ...meta,
        repro: `${meta.repro} — ${credential.label}`,
      });
    }

    return failures.length
      ? { outcome: 'failed', detail: `expected 401/403 — ${failures.join('; ')}` }
      : { outcome: 'passed' };
  },
};
