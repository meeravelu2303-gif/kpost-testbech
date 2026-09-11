import { ScreenEngine } from './pipeline';
import { SCREEN_VALIDATORS } from './validators';

/**
 * The assembled screen engine.
 *
 *   const result = await screenEngine.run(screen, { page, baseURL, consoleErrors: [], failedRequests: [] });
 *
 * Adding a validation: register it in `src/engine/validators/index.ts` — it applies to every
 * declared screen. Adding a screen: declare it in `src/screens/` — it receives every validation.
 * Neither requires touching the other.
 */
export const screenEngine = new ScreenEngine().registerAll(SCREEN_VALIDATORS);

export { ScreenEngine, describeFailures, describeStages, STAGE_ORDER } from './pipeline';
export { SCREEN_BUDGETS } from './types';
export { SCREEN_VALIDATORS } from './validators';
export type {
  ScreenBudget,
  ScreenContext,
  ScreenDefinition,
  ScreenResult,
  ScreenStage,
  ScreenValidator,
  StageResult,
} from './types';
