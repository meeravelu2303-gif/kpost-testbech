import type { ScreenValidator } from '../types';
import {
  accessibilityValidator,
  consoleValidator,
  navigationValidator,
  networkValidator,
  performanceValidator,
  renderingValidator,
  responsiveValidator,
} from './core';
import { sessionValidator } from './session';

/**
 * Every validator the screen engine runs.
 *
 * **This is the only place a new UI validation is added.** Registering one here applies it to
 * every declared screen — no screen file changes.
 *
 * `journey` has no validator on purpose: a multi-step flow (compose to send to verify) is
 * screen-specific and belongs in a spec under `tests/`. The stage exists in the pipeline so the
 * report shows an explicit skip rather than implying the engine covers journeys.
 */
export const SCREEN_VALIDATORS: ScreenValidator[] = [
  navigationValidator,
  renderingValidator,
  consoleValidator,
  networkValidator,
  accessibilityValidator,
  performanceValidator,
  responsiveValidator,
  sessionValidator,
];

export {
  accessibilityValidator,
  consoleValidator,
  navigationValidator,
  networkValidator,
  performanceValidator,
  renderingValidator,
  responsiveValidator,
  sessionValidator,
};
