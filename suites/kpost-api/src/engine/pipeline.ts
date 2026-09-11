import type {
  EndpointDefinition,
  EngineResult,
  StageResult,
  ValidationContext,
  ValidationStage,
  Validator,
} from './types';

/**
 * Stage order is contractual:
 *  - `execution` populates the response every later stage reads.
 *  - `authentication` runs first so a route that refuses everything reads as an auth defect
 *    rather than twelve schema failures against a 401 body.
 *  - `errorContract` follows `status` because a well-formed error only matters once an error
 *    was the right answer.
 *  - `database` is last of the observable stages: a rejected write has no consequence to assert.
 */
export const STAGE_ORDER: ValidationStage[] = [
  'authentication',
  'authorization',
  'request',
  'execution',
  'status',
  'structure',
  'schema',
  'contentType',
  'headers',
  'errorContract',
  'performance',
  'security',
  'database',
  'businessRules',
];

const REQUIRES_RESPONSE: ReadonlySet<ValidationStage> = new Set([
  'status',
  'structure',
  'schema',
  'contentType',
  'headers',
  'errorContract',
  'performance',
  'database',
]);

export class ApiEngine {
  private readonly validators = new Map<ValidationStage, Validator>();

  register(validator: Validator): this {
    this.validators.set(validator.stage, validator);
    return this;
  }

  registerAll(validators: Validator[]): this {
    validators.forEach((v) => this.register(v));
    return this;
  }

  /**
   * Runs every applicable stage. Returns a result rather than throwing so the caller decides how
   * a failure surfaces — a spec turns it into an `expect`, CI into an exit code, the report into
   * a row. A failure does not stop the run; only a failed `execution` short-circuits, because the
   * stages after it have nothing to read.
   */
  async run(
    endpoint: EndpointDefinition,
    context: Omit<ValidationContext, 'endpoint'>
  ): Promise<EngineResult> {
    const stages: StageResult[] = [];
    const ctx: ValidationContext = { ...context, endpoint };
    let executionFailed = false;

    for (const stage of STAGE_ORDER) {
      const validator = this.validators.get(stage);
      const skipReason = endpoint.skip?.[stage];

      if (!validator) {
        stages.push({ stage, outcome: 'skipped', detail: 'no validator registered', durationMs: 0 });
        continue;
      }
      if (skipReason) {
        stages.push({ stage, outcome: 'skipped', detail: skipReason, durationMs: 0 });
        continue;
      }
      if (!validator.appliesTo(endpoint)) {
        stages.push({ stage, outcome: 'skipped', detail: 'not applicable', durationMs: 0 });
        continue;
      }
      if (executionFailed && REQUIRES_RESPONSE.has(stage)) {
        stages.push({ stage, outcome: 'skipped', detail: 'no response to validate', durationMs: 0 });
        continue;
      }

      const startedAt = Date.now();
      let result: Omit<StageResult, 'stage' | 'durationMs'>;
      try {
        result = await validator.run(ctx);
      } catch (error) {
        /*
         * The assertion helpers throw BY DESIGN when they find a defect, so a throw here is
         * usually a real finding. Only an exception without `matcherResult` is a bench fault.
         * Conflating the two once labelled a genuine stored-XSS finding as a bench fault.
         */
        const isAssertionFailure =
          typeof error === 'object' && error !== null && 'matcherResult' in error;
        const message = ((error as Error).message ?? String(error)).split('\n')[0];
        result = isAssertionFailure
          ? { outcome: 'failed', detail: message }
          : { outcome: 'failed', detail: `BENCH FAULT (not an API defect): ${message}` };
      }

      stages.push({ ...result, stage, durationMs: Date.now() - startedAt });
      if (stage === 'execution' && result.outcome === 'failed') executionFailed = true;
    }

    return {
      endpoint,
      stages,
      responseTimeMs: ctx.executionMs ?? null,
      passed: stages.every((s) => s.outcome !== 'failed'),
    };
  }
}

export function describeFailures(result: EngineResult): string {
  return result.stages
    .filter((s) => s.outcome === 'failed')
    .map((s) => `  [${s.stage}] ${s.detail ?? 'failed with no detail'}`)
    .join('\n');
}

export function describeStages(result: EngineResult): string {
  return result.stages.map((s) => `${s.stage}:${s.outcome === 'passed' ? 'ok' : s.outcome}`).join(' ');
}
