import { assertRejectsInvalidInput } from '../../utils/apiAssertions';
import type { Validator } from '../types';

/**
 * Field-level request validation, driven by the endpoint's declared required fields.
 *
 * Delegates to `assertRejectsInvalidInput`, which owns the grading (accepted → validation gap,
 * 5xx → unhandled error, wrong 4xx → status defect) and the per-endpoint dedupe key that stops an
 * unvalidated controller filing one ticket per field.
 */
const MUTATIONS: Array<[string, (body: Record<string, unknown>, field: string) => Record<string, unknown>]> = [
  ['required field "%s" omitted', (b, f) => { const c = { ...b }; delete c[f]; return c; }],
  ['field "%s" set to null', (b, f) => ({ ...b, [f]: null })],
  ['field "%s" set to an empty string', (b, f) => ({ ...b, [f]: '' })],
  ['field "%s" sent as a wrong-typed array', (b, f) => ({ ...b, [f]: [1, 2, 3] })],
  ['field "%s" set to an oversized string', (b, f) => ({ ...b, [f]: 'a'.repeat(50_000) })],
];

export const requestValidator: Validator = {
  stage: 'request',
  appliesTo: (e) => Boolean(e.buildRequest) && (e.requiredFields?.length ?? 0) > 0,

  async run({ endpoint, request, token }) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const base = endpoint.buildRequest?.() as Record<string, unknown>;
    const meta = {
      method: endpoint.method,
      path: endpoint.path,
      repro: `apiEngine.run('${endpoint.id}') — request`,
      readOnly: endpoint.readOnly,
    };

    for (const field of endpoint.requiredFields ?? []) {
      for (const [template, mutate] of MUTATIONS) {
        const body = mutate(base, field);
        const response = await request.fetch(endpoint.path, {
          method: endpoint.method,
          headers,
          data: body,
          failOnStatusCode: false,
        });
        await assertRejectsInvalidInput(
          response,
          { ...meta, body, scenario: template.replace('%s', field) },
          [400, 401, 403, 422]
        );
      }
    }

    return { outcome: 'passed' };
  },
};
