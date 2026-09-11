import { ApiEngine } from './pipeline';
import { VALIDATORS } from './validators';

/**
 * The assembled engine.
 *
 *   const result = await apiEngine.run(definition, { request, token, roleTokens });
 *
 * Adding a validation: register it in `src/engine/validators/index.ts` — it then applies to every
 * endpoint in the registry. Adding an endpoint: declare it in `src/endpoints/` — it then receives
 * every validation. Neither requires touching the other.
 */
export const apiEngine = new ApiEngine().registerAll(VALIDATORS);

export { ApiEngine, describeFailures, describeStages, STAGE_ORDER } from './pipeline';
export {
  defineEndpoint,
  defineEndpoints,
  fromContract,
  registeredEndpoints,
  registryCoverage,
} from './registry';
export { PERFORMANCE_TIERS } from './types';
export { VALIDATORS } from './validators';
export type {
  AccessDecision,
  DatabaseExpectation,
  EndpointDefinition,
  EngineResult,
  HttpMethod,
  PerformanceTier,
  Role,
  StageResult,
  ValidationStage,
  Validator,
} from './types';
