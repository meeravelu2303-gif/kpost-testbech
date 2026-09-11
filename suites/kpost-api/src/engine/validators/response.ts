import {
  assertResponseHeaders,
  assertStatus,
  assertStatusCodeParity,
  expectValidContract,
} from '../../utils/apiAssertions';
import type { Validator } from '../types';

const meta = (endpoint: { method: string; path: string; id: string }, stage: string) => ({
  method: endpoint.method,
  path: endpoint.path,
  repro: `apiEngine.run('${endpoint.id}') — ${stage}`,
});

export const statusValidator: Validator = {
  stage: 'status',
  appliesTo: (e) => e.expectedStatuses.length > 0,
  async run({ endpoint, response }) {
    if (!response) return { outcome: 'skipped', detail: 'no response' };
    await assertStatus(response, endpoint.expectedStatuses, meta(endpoint, 'status'));
    return { outcome: 'passed' };
  },
};

/**
 * Envelope parity. Separate from `schema` because this API answers HTTP 200 with
 * `statusCode: 500` in the body, which a shape check alone would pass.
 */
export const structureValidator: Validator = {
  stage: 'structure',
  appliesTo: () => true,
  async run({ endpoint, response }) {
    if (!response) return { outcome: 'skipped', detail: 'no response' };
    await assertStatusCodeParity(response, meta(endpoint, 'structure'));
    return { outcome: 'passed' };
  },
};

export const schemaValidator: Validator = {
  stage: 'schema',
  appliesTo: (e) => Boolean(e.responseSchema),
  async run({ endpoint, response }) {
    if (!response || !endpoint.responseSchema) {
      return { outcome: 'skipped', detail: 'no schema declared' };
    }
    await expectValidContract(
      response,
      endpoint.responseSchema,
      meta(endpoint, 'schema'),
      endpoint.expectedStatuses
    );
    return { outcome: 'passed' };
  },
};

export const contentTypeValidator: Validator = {
  stage: 'contentType',
  appliesTo: (e) => Boolean(e.responseContentType),
  async run({ endpoint, response }) {
    if (!response) return { outcome: 'skipped', detail: 'no response' };
    // Media type only — a charset suffix is not a contract difference.
    const actual = (response.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const expected = (endpoint.responseContentType as string).toLowerCase();
    return actual === expected
      ? { outcome: 'passed' }
      : {
          outcome: 'failed',
          detail: `Content-Type "${actual || '(absent)'}" where the contract declares "${expected}"`,
        };
  },
};

export const headerValidator: Validator = {
  stage: 'headers',
  appliesTo: (e) => (e.requiredResponseHeaders?.length ?? 0) > 0,
  async run({ endpoint, response }) {
    if (!response) return { outcome: 'skipped', detail: 'no response' };
    await assertResponseHeaders(response, meta(endpoint, 'headers'));
    return { outcome: 'passed' };
  },
};
