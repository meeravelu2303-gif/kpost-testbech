import { readBody } from '../../utils/apiAssertions';
import type { Validator } from '../types';

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);

/** Issues the one well-formed request every later stage reads. */
export const executionValidator: Validator = {
  stage: 'execution',
  appliesTo: () => true,

  async run(context) {
    const { endpoint, request, token } = context;
    const headers: Record<string, string> = {
      'Content-Type': endpoint.requestContentType ?? 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const body = endpoint.buildRequest?.();
    const options: Record<string, unknown> = { headers, failOnStatusCode: false };
    if (body !== undefined && !BODYLESS.has(endpoint.method)) options.data = body;

    const startedAt = Date.now();
    const response = await request.fetch(endpoint.path, { method: endpoint.method, ...options });

    context.response = response;
    context.responseBody = await readBody(response);
    context.executionMs = Date.now() - startedAt;

    return { outcome: 'passed' };
  },
};
