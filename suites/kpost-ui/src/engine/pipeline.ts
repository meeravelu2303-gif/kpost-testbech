import type {
  ScreenContext,
  ScreenDefinition,
  ScreenResult,
  ScreenStage,
  ScreenValidator,
  StageResult,
} from './types';

/**
 * Stage order is contractual: `navigation` opens the screen and starts the console/network
 * listeners every later stage reads, so nothing after it can run if it fails.
 */
export const STAGE_ORDER: ScreenStage[] = [
  'navigation',
  'rendering',
  'console',
  'network',
  'accessibility',
  'performance',
  'responsive',
  'session',
  'journey',
];

const REQUIRES_PAGE: ReadonlySet<ScreenStage> = new Set([
  'rendering',
  'console',
  'network',
  'accessibility',
  'performance',
  'responsive',
]);

export class ScreenEngine {
  private readonly validators = new Map<ScreenStage, ScreenValidator>();

  registerAll(validators: ScreenValidator[]): this {
    validators.forEach((v) => this.validators.set(v.stage, v));
    return this;
  }

  async run(screen: ScreenDefinition, context: Omit<ScreenContext, 'screen'>): Promise<ScreenResult> {
    const stages: StageResult[] = [];
    const ctx: ScreenContext = { ...context, screen };
    let navigationFailed = false;

    for (const stage of STAGE_ORDER) {
      const validator = this.validators.get(stage);
      const skipReason = screen.skip?.[stage];

      if (!validator) {
        stages.push({ stage, outcome: 'skipped', detail: 'no validator registered', durationMs: 0 });
        continue;
      }
      if (skipReason) {
        stages.push({ stage, outcome: 'skipped', detail: skipReason, durationMs: 0 });
        continue;
      }
      if (!validator.appliesTo(screen)) {
        stages.push({ stage, outcome: 'skipped', detail: 'not applicable', durationMs: 0 });
        continue;
      }
      if (navigationFailed && REQUIRES_PAGE.has(stage)) {
        stages.push({ stage, outcome: 'skipped', detail: 'the screen did not load', durationMs: 0 });
        continue;
      }

      const startedAt = Date.now();
      let result: Omit<StageResult, 'stage' | 'durationMs'>;
      try {
        result = await validator.run(ctx);
      } catch (error) {
        // An expect failure is a real finding; anything else is a bench fault. See the API
        // engine's pipeline — conflating the two once mislabelled a genuine defect.
        const isAssertion = typeof error === 'object' && error !== null && 'matcherResult' in error;
        const message = ((error as Error).message ?? String(error)).split('\n')[0];
        result = isAssertion
          ? { outcome: 'failed', detail: message }
          : { outcome: 'failed', detail: `BENCH FAULT (not an app defect): ${message}` };
      }

      stages.push({ ...result, stage, durationMs: Date.now() - startedAt });
      if (stage === 'navigation' && result.outcome === 'failed') navigationFailed = true;
    }

    return { screen, stages, passed: stages.every((s) => s.outcome !== 'failed') };
  }
}

export function describeFailures(result: ScreenResult): string {
  return result.stages
    .filter((s) => s.outcome === 'failed')
    .map((s) => `  [${s.stage}] ${s.detail ?? 'failed with no detail'}`)
    .join('\n');
}

export function describeStages(result: ScreenResult): string {
  return result.stages.map((s) => `${s.stage}:${s.outcome === 'passed' ? 'ok' : s.outcome}`).join(' ');
}
