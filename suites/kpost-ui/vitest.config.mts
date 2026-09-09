import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic under `src/` — today, the reporting engine.
 *
 * These are deliberately NOT Playwright tests. They need no browser, no app and
 * no test account, so they run in CI on every push regardless of whether the
 * KPost stack is available. That matters: `run-model.ts` decides what every
 * report and the QA dashboard claim about a run, and until now nothing verified
 * it. A miscount there is invisible — the artifacts stay well-formed and simply
 * state the wrong thing.
 *
 * `include` is pinned to `src/**` on purpose. Vitest's default glob also matches
 * `tests/**\/*.spec.ts`, which is Playwright's suite; picking those up would run
 * browser specs under the wrong runner and fail confusingly.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
