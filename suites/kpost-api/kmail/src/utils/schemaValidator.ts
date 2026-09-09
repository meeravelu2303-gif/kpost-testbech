import { z } from 'zod';
import { expect } from '@playwright/test';
import { recordExercised, recordFinding } from './findings';

export interface ValidateContext {
  method: string;
  path: string;
  repro: string;
  body?: unknown;
  headers?: Record<string, string>;
  title?: string;
}

/**
 * Runtime contract assertion. Parses `data` against `schema`; on failure records a finding
 * carrying the full Zod issue list, then fails the test.
 *
 * Graded **Minor** rather than Trivial. A schema break is invisible to a human reading the
 * JSON — the response looks fine — but it fails a generated or typed client at runtime, which
 * is a real consumer outage rather than a cosmetic one.
 */
export function validateSchema<T extends z.ZodTypeAny>(
  data: unknown,
  schema: T,
  ctx: ValidateContext
): z.infer<T> {
  recordExercised(ctx.method, ctx.path);

  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `[${issue.path.join('.') || '<root>'}] ${issue.message}`)
    .join('; ');

  recordFinding({
    title: ctx.title ?? 'Response body violates the documented contract',
    severity: 'Minor',
    classification: 'Schema Violation',
    method: ctx.method,
    path: ctx.path,
    description: `The response does not conform to the contract published in the KMail OpenAPI document: ${issues}.`,
    expected: 'Response body conforms to the documented contract schema',
    actual: `Zod validation failed: ${issues}. Body: ${JSON.stringify(data).slice(0, 400)}`,
    repro: ctx.repro,
    requestHeaders: ctx.headers,
    requestBody:
      ctx.body === undefined
        ? undefined
        : typeof ctx.body === 'string'
          ? ctx.body
          : JSON.stringify(ctx.body, null, 2),
  });

  expect(result.success, `Schema validation failed for ${ctx.method} ${ctx.path}: ${issues}`).toBe(
    true
  );
  throw new Error('unreachable');
}
