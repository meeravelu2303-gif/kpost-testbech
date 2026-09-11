import { assertNoInternalLeak } from '../../utils/apiAssertions';
import type { Validator } from '../types';

/** Error bodies must be branchable and must not leak internals. Only asserted on 4xx/5xx. */
export const errorContractValidator: Validator = {
  stage: 'errorContract',
  appliesTo: () => true,

  async run({ endpoint, response, responseBody }) {
    if (!response || !responseBody) return { outcome: 'skipped', detail: 'no response' };
    if (response.status() < 400) {
      return { outcome: 'skipped', detail: 'not an error response' };
    }

    await assertNoInternalLeak(
      response,
      {
        method: endpoint.method,
        path: endpoint.path,
        repro: `apiEngine.run('${endpoint.id}') — errorContract`,
      },
      ''
    );

    const missing = ['message', 'statusCode'].filter((f) => responseBody.json?.[f] === undefined);
    return missing.length
      ? {
          outcome: 'failed',
          detail: `error body omits ${missing.join(' and ')} — a client cannot branch on it`,
        }
      : { outcome: 'passed' };
  },
};
