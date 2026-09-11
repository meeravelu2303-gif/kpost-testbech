import type { Page } from '@playwright/test';

/** Latency budgets in ms for a screen to become interactive. */
export const SCREEN_BUDGETS = {
  light: 3_000,
  standard: 6_000,
  heavy: 10_000,
} as const;

export type ScreenBudget = keyof typeof SCREEN_BUDGETS;

export type ScreenStage =
  | 'navigation'
  | 'rendering'
  | 'console'
  | 'network'
  | 'accessibility'
  | 'performance'
  | 'responsive'
  | 'session'
  | 'journey';

export type StageOutcome = 'passed' | 'failed' | 'skipped';

/**
 * Everything the engine needs about one screen.
 *
 * The mirror of the API bench's `EndpointDefinition`: declare a screen and it receives every
 * validator. A screen that needs something specific declares it; a check that applies to more
 * than one screen belongs in a validator.
 */
export interface ScreenDefinition {
  id: string;
  /** Human name, used in the report. */
  name: string;
  /** Path relative to the app base URL, e.g. `/home`. */
  path: string;

  /**
   * Whether a session is required.
   *
   * `authenticated` screens additionally assert that a signed-out visitor is redirected — the
   * check that catches a route someone forgot to guard.
   */
  auth: 'authenticated' | 'anonymous';

  /**
   * Selectors that must be present once the screen has settled.
   *
   * At least one is required: a "screen loads" test with nothing asserted about its content
   * passes on a blank page, which is the UI equivalent of a 404 satisfying "must not be 2xx".
   */
  requiredElements: string[];

  /** Selectors that must NOT be present — an error banner, a crash shell. */
  forbiddenElements?: string[];

  /** Load budget. Defaults to `standard`. */
  budget?: ScreenBudget | number;

  /** Restricts the a11y scan to a region. Whole page when omitted. */
  a11yScope?: string;

  /**
   * axe rules to disable, each with a REASON.
   *
   * Never widen this to reach green: a violation is an application defect. Register it in
   * `known-defects.ts` and attach it instead.
   */
  a11yDisableRules?: Record<string, string>;

  /** Stages to skip, each with a reason. Enforced by the type. */
  skip?: Partial<Record<ScreenStage, string>>;

  /** Widths to re-render at. Defaults to a phone width. */
  responsiveWidths?: number[];
}

export interface StageResult {
  stage: ScreenStage;
  outcome: StageOutcome;
  detail?: string;
  durationMs: number;
}

export interface ScreenResult {
  screen: ScreenDefinition;
  stages: StageResult[];
  passed: boolean;
}

export interface ScreenContext {
  screen: ScreenDefinition;
  page: Page;
  baseURL: string;
  /** Console errors captured since navigation, populated by the `navigation` stage. */
  consoleErrors: string[];
  /** Requests that failed or returned >= 400, populated by the `navigation` stage. */
  failedRequests: string[];
  /** Time from navigation to the screen settling, read by `performance`. */
  loadMs?: number;
}

export interface ScreenValidator {
  stage: ScreenStage;
  appliesTo(screen: ScreenDefinition): boolean;
  run(context: ScreenContext): Promise<Omit<StageResult, 'stage' | 'durationMs'>>;
}
