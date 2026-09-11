import { assertNoInternalLeak, assertNoReflectedScript } from '../../utils/apiAssertions';
import type { Validator } from '../types';

const PAYLOADS = [
  { value: `<script>alert('xss')</script>`, assertion: assertNoReflectedScript },
  { value: `' OR '1'='1`, assertion: assertNoInternalLeak },
  { value: `'; DROP TABLE users; --`, assertion: assertNoInternalLeak },
  { value: '../../../../etc/passwd', assertion: assertNoInternalLeak },
  { value: '{"$ne": null}', assertion: assertNoInternalLeak },
] as const;

/**
 * Injection and reflection on the endpoint's declared fields.
 *
 * Targeted rather than blanket: fuzzing every key on 300 endpoints is slow and mostly re-proves
 * framework behaviour. The declared fields are the ones that reach a query or a template.
 */
export const securityValidator: Validator = {
  stage: 'security',
  appliesTo: (e) => Boolean(e.buildRequest) && (e.requiredFields?.length ?? 0) > 0,

  async run({ endpoint, request, token }) {
    const field = endpoint.requiredFields?.[0];
    if (!field) return { outcome: 'skipped', detail: 'no fuzzable field declared' };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const meta = {
      method: endpoint.method,
      path: endpoint.path,
      repro: `apiEngine.run('${endpoint.id}') — security`,
    };

    for (const { value, assertion } of PAYLOADS) {
      const body = { ...(endpoint.buildRequest?.() as Record<string, unknown>), [field]: value };
      const response = await request.fetch(endpoint.path, {
        method: endpoint.method,
        headers,
        data: body,
        failOnStatusCode: false,
      });
      await assertion(response, { ...meta, body }, value);
    }

    return { outcome: 'passed' };
  },
};
