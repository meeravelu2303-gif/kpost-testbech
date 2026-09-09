import { test } from '@playwright/test';

/**
 * The findings ledger.
 *
 * An assertion that merely fails tells a reviewer *that* something is wrong. A finding tells
 * them what was sent, what came back, what the contract said, and why it matters — which is
 * the difference between a ticket a developer can act on and one they close as "cannot
 * reproduce". Every assertion helper in `apiAssertions.ts` records one before it fails.
 *
 * Recorded as a Playwright **annotation plus an attachment** rather than into a bespoke
 * report file. Annotations survive retries, appear inline in the native HTML report next to
 * the test that produced them, and are carried in the JSON reporter output — so the ledger
 * needs no reporter of its own, no shared file handle between workers, and no cleanup step.
 * A suite that spends its complexity budget on its own reporting infrastructure has less left
 * for testing the API.
 */

export type Severity = 'Critical' | 'Major' | 'Minor' | 'Low';

/**
 * What kind of defect this is. Kept to the classifications this API actually produces —
 * a taxonomy with categories nothing ever lands in is noise in a triage meeting.
 */
export type Classification =
  | 'Authentication Bypass'
  | 'Broken Object-Level Authorisation'
  | 'Cross-Tenant Data Exposure'
  | 'Incorrect HTTP Status'
  | 'Input Validation Gap'
  | 'Schema Violation'
  | 'Security/Information Disclosure'
  | 'Security/Injection'
  | 'Security/Reflected Payload'
  | 'Status Misreporting'
  | 'Unbounded Response'
  | 'Unhandled Server Error';

export interface Finding {
  title: string;
  severity: Severity;
  classification: Classification;
  method: string;
  /** Template form for path-variable routes, so findings group by route not by id. */
  path: string;
  description: string;
  expected: string;
  actual: string;
  /** Minimal code that reproduces the call. */
  repro: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  /** Why this matters in production terms. Defaulted per classification when omitted. */
  riskImpact?: string;
  /**
   * Path-independent identity, for a fault that is systemic rather than per-endpoint. When set,
   * every finding sharing this key collapses to ONE defect (its `affectedEndpoints` list every
   * route observed), instead of one ticket per endpoint. Used for the shared auth-filter status
   * defect, where a single fix in one component resolves every route at once.
   */
  dedupeKey?: string;
}

/**
 * Default consequence wording per classification.
 *
 * Exists because a severity label alone does not survive contact with a triage meeting —
 * "Major" invites an argument, "an authenticated user can read another user's mail" does not.
 * Overridable per finding, because one classification can cover outcomes with very different
 * costs: a validation gap on a lookup stores nothing, while the same gap on a write persists
 * a corrupt row, and telling a developer to go hunting for rows that do not exist wastes
 * their afternoon.
 */
const DEFAULT_RISK: Record<Classification, string> = {
  'Authentication Bypass':
    'A caller with no valid session reaches a protected route. Every access-control rule behind it is unenforced.',
  'Broken Object-Level Authorisation':
    'A caller-supplied identifier selects a record the caller does not own, so authorisation depends on the client choosing not to ask.',
  'Cross-Tenant Data Exposure':
    "One account's mail, contacts or metadata is served to another. This is the failure mode a mail platform cannot have.",
  'Incorrect HTTP Status':
    'Clients, proxies, retry policies and monitoring all branch on the status code, and each takes the wrong path.',
  'Input Validation Gap':
    'Invalid input is accepted rather than refused, so the error surfaces later and further away from its cause.',
  'Schema Violation':
    'Generated clients and typed consumers fail to deserialise the response — invisible to a human reading the JSON, a runtime outage for a real client.',
  'Security/Information Disclosure':
    'Server internals reach the caller, giving an attacker the stack, the framework versions and often the query that failed.',
  'Security/Injection':
    'Input reached the query or command layer without being parameterised, which is the precondition for data theft rather than merely a symptom.',
  'Security/Reflected Payload':
    'Attacker-controlled markup is returned verbatim and executes in any consumer that renders it.',
  'Status Misreporting':
    'A success transport status carries a failure payload, so the failure is invisible in dashboards and is never retried.',
  'Unbounded Response':
    'A single request returns an unbounded result set, which exhausts server memory and saturates the connection.',
  'Unhandled Server Error':
    'The request reached code that did not expect it. On its own it corrupts nothing, but it is an unhandled path in a live route.',
};

function truncate(value: string, max = 600): string {
  return value.length <= max ? value : `${value.slice(0, max)}…<truncated>`;
}

/**
 * Records a finding against the running test.
 *
 * Never throws. A ledger that can fail a passing test is worse than no ledger — the caller
 * is always an assertion helper that is about to make its own pass/fail decision, and that
 * decision must not depend on whether the reporting worked.
 */
export function recordFinding(finding: Finding): void {
  try {
    const info = test.info();
    if (!info) return;

    info.annotations.push({
      type: `${finding.severity}: ${finding.classification}`,
      description: `${finding.method} ${finding.path} — ${finding.title}`,
    });

    void info.attach(`finding — ${finding.method} ${finding.path} — ${finding.title}`, {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify(
          {
            title: finding.title,
            severity: finding.severity,
            classification: finding.classification,
            endpoint: `${finding.method} ${finding.path}`,
            dedupeKey: finding.dedupeKey,
            description: finding.description,
            expected: finding.expected,
            actual: truncate(finding.actual),
            riskImpact: finding.riskImpact ?? DEFAULT_RISK[finding.classification],
            stepsToReproduce: {
              request: finding.repro,
              headers: finding.requestHeaders,
              body: finding.requestBody === undefined ? null : truncate(finding.requestBody, 2000),
            },
          },
          null,
          2
        )
      ),
    });
  } catch {
    // No active test, or the attachment failed. Never allowed to affect the assertion.
  }
}

/**
 * Notes that a route was exercised, whether or not anything was wrong with it.
 *
 * Coverage of an API is not "how many tests ran" but "how many endpoints were actually
 * reached", and those two numbers diverge badly once tests start skipping on missing
 * fixtures. Recording the reach separately means a run can report the second honestly.
 */
export function recordExercised(method: string, path: string): void {
  try {
    const info = test.info();
    if (!info) return;
    const alreadyRecorded = info.annotations.some(
      (annotation) =>
        annotation.type === 'endpoint' && annotation.description === `${method} ${path}`
    );
    if (!alreadyRecorded) {
      info.annotations.push({ type: 'endpoint', description: `${method} ${path}` });
    }
  } catch {
    /* outside a test */
  }
}
