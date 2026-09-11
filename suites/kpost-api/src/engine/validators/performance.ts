import { PERFORMANCE_TIERS, type Validator } from '../types';

/**
 * Single-request latency against a declared budget. A guard, not a load test — a parallel
 * Playwright run cannot produce a throughput number worth acting on. Use k6/JMeter for that.
 */
export const performanceValidator: Validator = {
  stage: 'performance',
  appliesTo: () => true,

  async run({ endpoint, response, executionMs }) {
    if (!response) return { outcome: 'skipped', detail: 'no response' };

    // An error or throttled path's latency is not the endpoint's latency.
    if (response.status() === 429 || response.status() >= 500) {
      return { outcome: 'skipped', detail: `HTTP ${response.status()} — not a representative path` };
    }

    const elapsed = executionMs ?? 0;
    const budget =
      typeof endpoint.performance === 'number'
        ? endpoint.performance
        : PERFORMANCE_TIERS[endpoint.performance ?? (endpoint.method === 'GET' ? 'fastRead' : 'write')];

    return elapsed > budget
      ? { outcome: 'failed', detail: `${elapsed}ms against a ${budget}ms budget` }
      : { outcome: 'passed', detail: `${elapsed}ms / ${budget}ms` };
  },
};
