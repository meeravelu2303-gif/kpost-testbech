import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { ZodTypeAny } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type Role =
  | 'ADMIN'
  | 'COMPANY_ADMIN'
  | 'USER'
  | 'BUSINESS_S'
  | 'BUSINESS_M'
  | 'BUSINESS_L'
  | 'UNAUTHENTICATED';

export type AccessDecision = 'ALLOW' | 'DENY';

/** Latency budgets in ms. Single-request guards, not load-test targets. */
export const PERFORMANCE_TIERS = {
  fastRead: 500,
  write: 1_000,
  search: 2_000,
  report: 5_000,
} as const;

export type PerformanceTier = keyof typeof PERFORMANCE_TIERS;

export interface DatabaseExpectation {
  table: string;
  /** Column → how to derive the expected value from the response body. */
  match: Record<string, (responseBody: unknown) => unknown>;
  /** Columns the write must populate, whatever their value. */
  auditColumns?: string[];
  /** When set, the row must be soft-deleted rather than removed. */
  softDeleteColumn?: string;
  expectedRows?: number;
}

export type ValidationStage =
  | 'authentication'
  | 'authorization'
  | 'request'
  | 'execution'
  | 'status'
  | 'structure'
  | 'schema'
  | 'contentType'
  | 'headers'
  | 'errorContract'
  | 'performance'
  | 'security'
  | 'database'
  | 'businessRules';

/**
 * Everything the engine needs about one endpoint. Most fields are optional; a typical
 * declaration is a few lines and still receives every stage in the pipeline.
 */
export interface EndpointDefinition {
  id: string;
  method: HttpMethod;
  path: string;
  module?: string;

  /**
   * Statuses this endpoint may legitimately return. No global default — an endpoint that
   * accepts "any 2xx" can never fail, which is how a bench stops noticing regressions.
   */
  expectedStatuses: number[];

  buildRequest?: () => unknown;
  responseSchema?: ZodTypeAny;
  requestContentType?: string;
  responseContentType?: string;

  /** `public` routes are asserted REACHABLE anonymously; `secured` must refuse bad credentials. */
  auth: 'secured' | 'public';

  authorization?: Partial<Record<Role, AccessDecision>>;
  performance?: PerformanceTier | number;
  requiredResponseHeaders?: string[];

  /** Fields the request and security stages fuzz. Derived from the Excel row when omitted. */
  requiredFields?: string[];

  database?: DatabaseExpectation;

  /** Stages to skip. A reason is required so a suppressed check stays visible in the report. */
  skip?: Partial<Record<ValidationStage, string>>;

  /** A read that creates nothing — downgrades the severity of accepted invalid input. */
  readOnly?: boolean;

  /** Sources a disposable token instead of the shared session. Set on irreversible routes. */
  destructive?: boolean;
}

export type StageOutcome = 'passed' | 'failed' | 'skipped';

export interface StageResult {
  stage: ValidationStage;
  outcome: StageOutcome;
  detail?: string;
  defectIds?: string[];
  durationMs: number;
}

export interface EngineResult {
  endpoint: EndpointDefinition;
  stages: StageResult[];
  responseTimeMs: number | null;
  passed: boolean;
}

export interface ValidationContext {
  endpoint: EndpointDefinition;
  request: APIRequestContext;
  token: string | null;
  response?: APIResponse;
  responseBody?: { text: string; json: Record<string, unknown> | null };
  /** Latency of the `execution` stage, read by `performance`. */
  executionMs?: number;
  /** Tokens for the authorization matrix. A missing role is reported, never silently passed. */
  roleTokens?: Partial<Record<Role, string>>;
}

export interface Validator {
  stage: ValidationStage;
  appliesTo(endpoint: EndpointDefinition): boolean;
  run(context: ValidationContext): Promise<Omit<StageResult, 'stage' | 'durationMs'>>;
}
