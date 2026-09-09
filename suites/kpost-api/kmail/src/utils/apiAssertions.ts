import { APIResponse, expect } from '@playwright/test';
import { z } from 'zod';
import { capturedRequestFor } from '../helpers/base.client';
import { errorEnvelopeSchema } from '../api/schemas/envelope.schema';
import { validateSchema } from './schemaValidator';
import { Classification, recordExercised, recordFinding, Severity } from './findings';

export interface EndpointMeta {
  method: string;
  /** Template form for path-variable routes, so findings group by route not by id. */
  path: string;
  /** Minimal Playwright code that reproduces the call. */
  repro: string;
  /** Request body sent. Defaults to what the transport actually captured. */
  body?: unknown;
  /** Headers sent. Defaults to what the transport actually captured. */
  headers?: Record<string, string>;
  title?: string;
  severity?: Severity;
  /**
   * The route echoes its input and stores nothing (translator, compose preview). Reflected
   * script there is Major — inert in JSON, executable only in a renderer — never the Critical
   * "stored XSS", which this assertion cannot prove without a read-back. Without this flag a
   * 200/SUCCESS echo is mis-read as a successful *write* and over-graded Critical.
   */
  stateless?: boolean;
}

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

/**
 * The transport records what it actually sent, so a finding reports the real request rather
 * than whatever a test remembered to pass through. Explicit `meta` values still win, for the
 * rare case where a test wants to describe the call differently.
 */
function headersOf(meta: EndpointMeta, response?: APIResponse): Record<string, string> {
  if (meta.headers) return meta.headers;
  const captured = response ? capturedRequestFor(response) : undefined;
  return captured?.headers ?? DEFAULT_HEADERS;
}

function bodyOf(meta: EndpointMeta, response?: APIResponse): string | undefined {
  if (meta.body !== undefined) {
    try {
      return typeof meta.body === 'string' ? meta.body : JSON.stringify(meta.body, null, 2);
    } catch {
      return String(meta.body);
    }
  }
  return response ? capturedRequestFor(response)?.body : undefined;
}

function truncate(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}…<truncated>`;
}

/**
 * HTTP 429 — the server throttled us, so the response says nothing about the endpoint.
 *
 * This is the bench observing its own load, not a defect. Every assertion downstream would
 * otherwise read a throttle as the wrong status: a validation probe reports "invalid input
 * was not rejected", a contract check reports "the envelope is wrong", and each files a
 * finding against an endpoint that behaved correctly.
 *
 * Treating 429 as inconclusive rather than as a finding is the same principle the specs apply
 * with `test.skip(json === null, …)`: a response that could not exercise the behaviour proves
 * nothing, and reporting it is worse than reporting nothing. Rate limiting is still asserted
 * where it belongs — the dedicated cases assert a 429 **should** appear under repeated load,
 * and those are unaffected by this guard.
 */
function isRateLimited(response: APIResponse): boolean {
  return response.status() === 429;
}

/**
 * Whether the request that produced this response carried a bearer token.
 *
 * Recorded on the finding because the expected-status line reads, to a developer, as though
 * the test had been probing an unauthenticated call: `assertRejectsInvalidInput` prints every
 * status it would have accepted — "HTTP 400 or 401 or 403 or 422" — and a reviewer who sees
 * 401 in that list reasonably answers "we already return 401 for a bad token, so this is
 * handled" and closes it. It is a misreading, but a fair one. Those codes are alternative
 * *rejection* codes; the scenario is invalid input from an **authenticated** caller, and the
 * finding is that it was accepted. Saying so ends the exchange before it starts.
 */
function wasAuthenticated(meta: EndpointMeta, response?: APIResponse): boolean {
  const headers = headersOf(meta, response);
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  )?.[1];
  if (typeof authorization !== 'string') return false;
  return /^bearer\s+\S+/i.test(authorization.trim());
}

/** Body text plus a best-effort JSON parse — several KMail routes return bare strings. */
export async function readBody(
  response: APIResponse
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return {
      text,
      json:
        parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null,
    };
  } catch {
    return { text, json: null };
  }
}

/**
 * Reads the KMail envelope's own verdict.
 *
 * This API routinely answers HTTP 200 carrying `{"status":"FAILURE","statusCode":500}`, so no
 * assertion here may decide "the call succeeded" from the transport status alone. Every
 * helper below that needs to know whether a write actually happened goes through this.
 */
function envelopeVerdict(json: Record<string, unknown> | null): {
  statusCode: number | null;
  status: string | null;
  failed: boolean;
} {
  const statusCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  const status = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const failed =
    status === 'FAILURE' ||
    status === 'FAILED' ||
    status === 'ERROR' ||
    status === 'UNAUTHORIZED' ||
    (statusCode !== null && statusCode >= 400);
  return { statusCode, status, failed };
}

/**
 * Standard status assertion. On mismatch, records a finding before failing so the report and
 * the ledger stay in sync.
 */
export async function assertStatus(
  response: APIResponse,
  expectedStatuses: number[],
  meta: EndpointMeta
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const actual = response.status();
  if (expectedStatuses.includes(actual)) return;

  const { text } = await readBody(response);
  /*
   * A 5xx where a 4xx was required is an unhandled server fault: the request reached code
   * that did not expect it. That is **Major** — the band for internals disclosed and rules
   * not enforced — and not Critical, because on its own it corrupts nothing and grants
   * nothing. Critical is reserved for auth bypass, cross-tenant exposure and invalid input
   * that was *accepted*; a 500 is none of those, and the cases where a fault leaks a stack
   * trace are caught and graded separately by `assertNoInternalLeak`.
   *
   * A merely *wrong* status — 400 instead of 401, 200 instead of 404 — misleads the caller
   * but corrupts nothing, which is what Minor is for. Callers that know better pass
   * `meta.severity` explicitly.
   */
  const severity: Severity = meta.severity ?? (actual >= 500 ? 'Major' : 'Minor');

  const classification = actual >= 500 ? 'Unhandled Server Error' : 'Incorrect HTTP Status';

  recordFinding({
    title: meta.title ?? `Returns HTTP ${actual} where ${expectedStatuses.join('/')} is required`,
    // Generic status faults collapse per endpoint+class, so one endpoint's 5xx does not split into
    // several tickets that differ only by the expected-status set embedded in the default title.
    // A caller-supplied title names a specific scenario and keeps its own per-title identity.
    dedupeKey: meta.title ? undefined : `${classification}|${meta.path}`,
    severity,
    classification,
    method: meta.method,
    path: meta.path,
    description: `The endpoint answered HTTP ${actual}. The documented and REST-correct response for this request is ${expectedStatuses.join(' or ')}. Clients branching on the status code will take the wrong path.`,
    expected: `HTTP ${expectedStatuses.join(' or ')}`,
    actual: `HTTP ${actual} — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    expectedStatuses,
    `Expected status [${expectedStatuses.join(', ')}] on ${meta.method} ${meta.path} but got ${actual}. Body: ${truncate(text, 300)}`
  ).toContain(actual);
}

/**
 * The platform embeds its own `statusCode` in the response envelope. When that disagrees with
 * the transport status the client is actively misled — a 200 carrying `statusCode: 500` makes
 * every well-behaved HTTP client, proxy, retry policy and dashboard treat a server error as a
 * success.
 */
export async function assertStatusCodeParity(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  const { text, json } = await readBody(response);
  const { statusCode } = envelopeVerdict(json);
  if (statusCode === null || statusCode === httpStatus) return;

  recordFinding({
    title: `HTTP ${httpStatus} carries an envelope reporting ${statusCode}`,
    severity: httpStatus < 300 && statusCode >= 400 ? 'Major' : 'Minor',
    classification: 'Status Misreporting',
    method: meta.method,
    path: meta.path,
    description: `The transport status is ${httpStatus} while the response envelope reports statusCode ${statusCode}. Every client, proxy, retry policy and monitoring rule keys on the transport status, so a failure reported this way is invisible in dashboards and is never retried.`,
    expected: `The envelope statusCode to equal the HTTP status (${httpStatus})`,
    actual: `HTTP ${httpStatus}, envelope statusCode ${statusCode} — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    statusCode,
    `${meta.method} ${meta.path}: HTTP ${httpStatus} carries envelope statusCode ${statusCode}. Body: ${truncate(text, 300)}`
  ).toBe(httpStatus);
}

/**
 * Detects a success transport status carrying a failure payload.
 *
 * The inverse framing of `assertStatusCodeParity`: that one needs a numeric `statusCode` to
 * compare, while this catches the envelopes that report failure only through the word in
 * `status`, or through a raw exception trace in a 200 body.
 */
export async function assertNot200OKOnError(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (httpStatus < 200 || httpStatus >= 300) return;

  const { text, json } = await readBody(response);
  const { statusCode, status } = envelopeVerdict(json);

  const symptoms: string[] = [];
  if (statusCode !== null && statusCode >= 400) symptoms.push(`envelope statusCode ${statusCode}`);
  if (status !== null && ['FAILURE', 'FAILED', 'ERROR'].includes(status)) {
    symptoms.push(`envelope status "${status}"`);
  }
  if (/NullPointerException|Exception|at\s+(?:com|org|java)\./i.test(text)) {
    symptoms.push('an exception trace in the body');
  }
  if (symptoms.length === 0) return;

  recordFinding({
    title: `HTTP ${httpStatus} returned for a failed operation`,
    severity: 'Major',
    classification: 'Status Misreporting',
    method: meta.method,
    path: meta.path,
    description: `The endpoint answered a success status while the payload reports failure (${symptoms.join(', ')}). Clients cannot distinguish this from success without parsing the body, which no generic HTTP client, proxy or alerting rule does.`,
    expected: 'A 4xx or 5xx transport status when the operation did not succeed',
    actual: `HTTP ${httpStatus} with ${symptoms.join(', ')} — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    symptoms,
    `${meta.method} ${meta.path}: HTTP ${httpStatus} carries ${symptoms.join(', ')}. Body: ${truncate(text, 300)}`
  ).toHaveLength(0);
}

/**
 * Patterns that mean server internals reached the caller.
 *
 * The KMail service returns Spring's default error body on an unhandled parse failure, and
 * that body includes a full `trace` field — so this is not a hypothetical class of finding on
 * this API, it is the observed default behaviour of at least one code path.
 */
const LEAK_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  classification: Classification;
}> = [
  {
    label: 'a Java stack trace',
    pattern: /\bat\s+(?:com|org|java|jakarta|javax)\.[\w.$]+\([\w.]*:\d+\)/,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'a Spring exception class',
    pattern:
      /\b(?:org\.springframework|com\.fasterxml\.jackson|jakarta\.persistence|org\.hibernate)\.[\w.$]*Exception\b/,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'a SQL error',
    pattern:
      /\b(SQLException|SQLSyntaxErrorException|MySQLSyntaxErrorException|You have an error in your SQL syntax|ORA-\d{5}|near ".*": syntax error)\b/i,
    classification: 'Security/Injection',
  },
  {
    label: 'a MongoDB error',
    pattern: /\b(MongoException|MongoWriteException|com\.mongodb\.|BsonInvalidOperationException)\b/,
    classification: 'Security/Injection',
  },
  {
    label: 'a NullPointerException',
    pattern: /\bjava\.lang\.NullPointerException\b/,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'an AWS S3 error document',
    pattern: /\b(AmazonS3Exception|x-amz-request-id|<Error><Code>[A-Za-z]+<\/Code>)\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'a filesystem path',
    pattern: /\b(?:[A-Za-z]:\\Users\\|\/(?:home|opt|usr\/local|var\/lib)\/[\w./-]{4,})/,
    classification: 'Security/Information Disclosure',
  },
];

/**
 * Injected input must not come back as a database error or a stack trace — that is both an
 * information leak and a strong signal the value reached the query layer unsanitised.
 */
export async function assertNoInternalLeak(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const { text } = await readBody(response);

  for (const { label, pattern, classification } of LEAK_PATTERNS) {
    if (!pattern.test(text)) continue;

    recordFinding({
      title: `Injected input triggers an internals leak (${label})`,
      severity: 'Critical',
      classification,
      method: meta.method,
      path: meta.path,
      description: `Submitting \`${injectedValue}\` caused the response to disclose ${label}. This leaks server internals to the caller and, for the query-layer patterns, indicates the value reached persistence without being parameterised.`,
      expected:
        'Malicious input rejected or sanitised, with a generic client error and no internals disclosed',
      actual: `Response matched ${label} — body: ${truncate(text)}`,
      repro: meta.repro,
      requestHeaders: headersOf(meta, response),
      requestBody: bodyOf(meta, response),
    });

    expect(
      text,
      `${meta.method} ${meta.path}: injecting "${injectedValue}" leaked ${label}. Body: ${truncate(text, 300)}`
    ).not.toMatch(pattern);
  }
}

/**
 * A reflected script payload returned verbatim is an XSS sink for any consumer that renders
 * it — and on a mail platform, "any consumer that renders it" is the entire product.
 *
 * Whether to call it *stored* XSS cannot be decided from the HTTP status alone: this API
 * routinely answers 200 carrying `status: FAILURE`, so a 2xx check would classify every
 * rejected-and-echoed payload as persisted. The envelope has to agree the write succeeded
 * before that word is justified.
 */
export async function assertNoReflectedScript(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const { text, json } = await readBody(response);
  const dangerous = /<script|onerror\s*=|onload\s*=|javascript:/i;

  if (!dangerous.test(text) || !text.includes(injectedValue)) return;

  const { failed } = envelopeVerdict(json);
  // A 200/SUCCESS proves a write only when the route actually persists. A stateless echo returns
  // exactly that on a pure reflection, so treat it as reflected (Major), never stored (Critical).
  const persisted = !meta.stateless && response.ok() && !failed;
  const contentType = response.headers()['content-type'] ?? '';
  const servedAsHtml = /text\/html/i.test(contentType);

  recordFinding({
    title: persisted
      ? 'Script payload is accepted, stored and returned unescaped'
      : 'Script payload is reflected unescaped in the response',
    // Served as text/html the browser executes it directly, which is the difference between
    // a sink that needs a careless consumer and one that needs none.
    severity: persisted || servedAsHtml ? 'Critical' : 'Major',
    classification: 'Security/Reflected Payload',
    method: meta.method,
    path: meta.path,
    description: `The value \`${injectedValue}\` was returned verbatim, unescaped, with Content-Type "${contentType || 'unset'}". ${persisted ? 'The envelope reports the write succeeded, so the payload is stored and will be served to every reader of this record.' : 'The payload was echoed rather than stored, which still executes in any consumer that renders the response.'}`,
    expected: 'Markup escaped or rejected, never returned executable',
    actual: `Reflected verbatim — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    text,
    `${meta.method} ${meta.path}: reflected unescaped script payload "${injectedValue}"`
  ).not.toContain(injectedValue);
}

/**
 * Invalid input must be refused, not silently accepted.
 *
 * `acceptableStatuses` is generous by default because this API expresses rejection in several
 * ways and the finding is "it was accepted", not "it was rejected with the wrong code" —
 * that second question belongs to `assertStatus`, where it can be graded on its own terms.
 */
export async function assertRejectsInvalidInput(
  response: APIResponse,
  meta: EndpointMeta & {
    scenario: string;
    /**
     * Set on endpoints that only ever read — lookups, list queries, reference data.
     * Accepting a bad parameter there is still a validation gap, but nothing is written, so
     * the finding is graded Major and never claims data was persisted. Without it the helper
     * has to assume the worst, and a P0 list that mixes a corrupt-row write with a lookup
     * that validated nothing is one nobody triages.
     */
    readOnly?: boolean;
  },
  acceptableStatuses: number[] = [400, 422]
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (acceptableStatuses.includes(httpStatus)) return;

  const { text, json } = await readBody(response);
  const { statusCode, failed } = envelopeVerdict(json);

  /*
   * "Rejected" is not the same as "the transport status was a 4xx". A 200 carrying
   * `status: FAILURE` is a rejection this API expresses badly — badly enough to be its own
   * finding via `assertStatusCodeParity`, but not a validation gap. Only a response that
   * reports success on invalid input belongs here.
   */
  const silentlyAccepted =
    httpStatus >= 200 && httpStatus < 300 && !failed && (statusCode === null || statusCode < 400);

  if (!silentlyAccepted) {
    // Rejected, but with a status outside the acceptable set. That is a status-correctness
    // question, and reporting it as a validation gap would be wrong.
    await assertStatusCodeParity(response, meta);
    return;
  }

  recordFinding({
    title: meta.title ?? `Invalid input accepted: ${meta.scenario}`,
    severity: meta.severity ?? (meta.readOnly ? 'Major' : 'Critical'),
    classification: 'Input Validation Gap',
    method: meta.method,
    path: meta.path,
    description: `The endpoint reported success for a request where ${meta.scenario}${wasAuthenticated(meta, response) ? ', sent by an authenticated caller' : ''}. ${meta.readOnly ? 'This route only reads, so nothing was stored — but the parameter was not validated before it reached the query.' : 'This route writes, so the invalid value is now persisted and every later read of the record inherits it.'}`,
    expected: `HTTP ${acceptableStatuses.join(' or ')} — the request is invalid and must be refused`,
    actual: `HTTP ${httpStatus} reporting success — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
    riskImpact: meta.readOnly
      ? 'Invalid input reaches the query layer unvalidated. Nothing is stored, but the endpoint cannot be relied on to reject anything.'
      : 'Invalid data is persisted and every subsequent read inherits it, so the corruption outlives the request that caused it.',
  });

  expect(
    silentlyAccepted,
    `${meta.method} ${meta.path}: ${meta.scenario} was accepted with HTTP ${httpStatus}. Expected ${acceptableStatuses.join('/')}. Body: ${truncate(text, 300)}`
  ).toBe(false);
}

/** Response fields that mean protected material actually came back, not just a 200. */
const SENSITIVE_RESPONSE_MARKERS =
  /"(kmailContent|kmailSubject|mailContent|password|kmailPassword|accessToken|refreshToken|mailServerPassword|contactEmailID|toAddress|fromAddress)"\s*:\s*"[^"]{3,}"/i;

/**
 * A secured endpoint reached without a usable token must answer 401/403 — never 400 (which
 * reads as "your payload was wrong") and never 200.
 *
 * Severity turns on what actually came back. Many responses to an anonymous caller are empty
 * lists or reference data, and grading those Critical would bury the real bypasses in noise;
 * a response carrying mail content or credentials is a different finding entirely.
 */
export async function assertUnauthorized(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (httpStatus === 401 || httpStatus === 403) return;

  const { text } = await readBody(response);
  const served = httpStatus >= 200 && httpStatus < 300;
  const leakedData = served && SENSITIVE_RESPONSE_MARKERS.test(text);

  let title: string;
  let severity: Severity;
  let classification: Classification;
  let description: string;
  // Set only for the shared-auth-filter branch below, so those collapse to one defect per
  // wrong-status-code instead of one per route. The per-endpoint branches leave it undefined.
  let dedupeKey: string | undefined;

  if (leakedData) {
    title = 'Unauthenticated caller received protected mail data';
    severity = 'Critical';
    classification = 'Authentication Bypass';
    description =
      'The endpoint returned a success status, and mail content or credential fields, to a caller presenting no valid token. This is an authentication bypass exposing protected data.';
  } else if (served) {
    title = 'Route declared as secured serves anonymous callers';
    severity = 'Major';
    classification = 'Authentication Bypass';
    description =
      'The route is declared under `bearerAuth` in the KMail OpenAPI document, but answered a caller with no valid token with a success status. Nothing sensitive was returned by this particular call, but the authentication check is not being applied.';
  } else {
    /*
     * Rejected, but with the wrong code — almost always 400 or 500 where 401/403 belongs.
     *
     * This says something about the **auth filter**, not about this endpoint: one wrong
     * status in one shared component, repeated across every route the matrix touches. Graded
     * Minor and described as shared, so a reviewer reads it as one fix rather than as forty
     * separate defects.
     */
    title = `Auth failure reported as HTTP ${httpStatus} instead of 401/403`;
    severity = 'Minor';
    classification = 'Incorrect HTTP Status';
    description = `A request with no usable token was refused with HTTP ${httpStatus}. The rejection is correct, but the code is not: ${httpStatus === 400 ? '400 tells the client its payload was malformed and invites it to retry with a different body, which will never succeed' : `${httpStatus} gives the client no way to distinguish "authenticate and retry" from "this is broken"`}. This is a property of the shared authentication filter rather than of this route. Filed once per wrong status code; the affected-endpoints list records every route observed answering this way.`;
    // Systemic: one wrong status in one shared filter, not a per-route defect. Collapse to a
    // single ticket per status code — the fix is one change to the filter, not one per endpoint.
    dedupeKey = `SYSTEMIC:auth-status:${httpStatus}`;
  }

  recordFinding({
    title,
    severity,
    classification,
    method: meta.method,
    path: meta.path,
    description,
    dedupeKey,
    expected: 'HTTP 401 or 403',
    actual: `HTTP ${httpStatus} — body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    [401, 403],
    `${meta.method} ${meta.path}: a caller with no usable token got HTTP ${httpStatus}. Body: ${truncate(text, 300)}`
  ).toContain(httpStatus);
}

/**
 * Asserts a response is bounded.
 *
 * A listing route that ignores its page size is not a cosmetic problem on a mail platform:
 * `getKmailDashboardMsg` and `selectedContactMails` read from a table that grows without
 * limit, so one unbounded response is a memory exhaustion vector and an exfiltration
 * primitive at the same time.
 */
export async function assertBoundedCollection(
  response: APIResponse,
  meta: EndpointMeta & { limit: number; what: string }
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const { text, json } = await readBody(response);
  if (!json) return;

  const data = json.data;
  if (!Array.isArray(data)) return;
  if (data.length <= meta.limit) return;

  recordFinding({
    // Title stays constant so this dedupes to one defect across runs — the returned count
    // (data.length) grows on the live backend and would re-seed the id each run; it lives in
    // the description instead, which does not feed the KM-id.
    title: `Unbounded response: page size not applied to ${meta.what}`,
    severity: 'Major',
    classification: 'Unbounded Response',
    method: meta.method,
    path: meta.path,
    description: `The request asked for at most ${meta.limit} ${meta.what} and received ${data.length}. The page size was not applied, so a single request can return the caller's entire history.`,
    expected: `At most ${meta.limit} ${meta.what}`,
    actual: `${data.length} ${meta.what} — body: ${truncate(text, 200)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    data.length,
    `${meta.method} ${meta.path}: asked for ${meta.limit} ${meta.what}, received ${data.length}. An unbounded listing over a table that grows without limit exhausts server memory and hands an attacker the whole store in one request.`
  ).toBeLessThanOrEqual(meta.limit);
}

/**
 * Asserts a foreign identifier did not reach somebody else's record.
 *
 * Ownership is asserted on **acknowledgement**, not on the status code. A correct
 * implementation may answer 403, 404, or 200-with-the-caller's-own-data if it ignores the
 * foreign key entirely — all three are safe, and demanding 403/404 would flag that third case
 * as a defect when nothing is wrong. What is never safe is the response coming back carrying
 * the foreign identifier, because that means the value reached the lookup.
 */
export async function assertNoForeignAcknowledgement(
  response: APIResponse,
  meta: EndpointMeta & { foreignValue: string | number; what: string }
): Promise<void> {
  recordExercised(meta.method, meta.path);
  if (isRateLimited(response)) return;
  const { text, json } = await readBody(response);
  const { failed } = envelopeVerdict(json);

  const acknowledged = response.ok() && !failed && text.includes(String(meta.foreignValue));
  if (!acknowledged) return;

  recordFinding({
    title: `Foreign ${meta.what} "${meta.foreignValue}" was acknowledged`,
    severity: 'Critical',
    classification: 'Broken Object-Level Authorisation',
    method: meta.method,
    path: meta.path,
    description: `The response carried ${meta.what} "${meta.foreignValue}", an identifier the caller does not own. The value reached the record lookup instead of being scoped to the identity on the token, so authorisation on this route depends on the client choosing not to ask for someone else's data.`,
    expected: `The ${meta.what} to be scoped to the caller — refused, or answered with the caller's own data`,
    actual: `Response acknowledged "${meta.foreignValue}" — HTTP ${response.status()}, body: ${truncate(text)}`,
    repro: meta.repro,
    requestHeaders: headersOf(meta, response),
    requestBody: bodyOf(meta, response),
  });

  expect(
    acknowledged,
    `${meta.method} ${meta.path}: the response acknowledged ${meta.what} "${meta.foreignValue}", which the caller does not own. Status ${response.status()}, body: ${truncate(text, 300)}`
  ).toBe(false);
}

/**
 * Transport-header contract. Called automatically by `expectValidContract`, so every
 * happy-path case carries it without each spec having to remember.
 *
 * Two questions, deliberately graded apart:
 *
 * - **`Content-Type` is a correctness issue.** A JSON body served as `text/html` is not a
 *   cosmetic mismatch — it is the difference between a reflected `<script>` being inert and
 *   being executed by the browser, which is why `assertNoReflectedScript` reads the same
 *   header to choose between Major and Critical.
 * - **Missing hardening headers are Low.** This is a token-authenticated JSON API whose
 *   clients are apps, so their absence is defence in depth rather than an exploitable gap.
 *   Reported once per response, in one finding, so a full run does not produce three findings
 *   per endpoint.
 *
 * A response with no body — 204, or a redirect — is exempt: there is nothing to type.
 */
export async function assertResponseHeaders(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  const status = response.status();
  if (status === 204 || status === 304 || (status >= 300 && status < 400)) return;

  const headers = response.headers();
  const { text } = await readBody(response);
  if (text.length === 0) return;

  const contentType = headers['content-type'] ?? '';
  const looksLikeJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');

  if (looksLikeJson && !/application\/json/i.test(contentType)) {
    recordFinding({
      title: `JSON body served as "${contentType || 'no Content-Type'}"`,
      severity: 'Minor',
      classification: 'Incorrect HTTP Status',
      method: meta.method,
      path: meta.path,
      description: `The response body is JSON but is typed "${contentType || 'unset'}". A JSON document served as text/html is rendered by a browser rather than parsed, which turns any reflected value in it into an executable payload.`,
      expected: 'Content-Type: application/json',
      actual: `Content-Type: ${contentType || '<absent>'}`,
      repro: meta.repro,
      requestHeaders: headersOf(meta, response),
      requestBody: bodyOf(meta, response),
    });
  }

  const missing = (
    [
      ['x-content-type-options', 'X-Content-Type-Options'],
      ['x-frame-options', 'X-Frame-Options'],
    ] as const
  )
    .filter(([key]) => headers[key] === undefined)
    .map(([, label]) => label);

  if (missing.length > 0) {
    recordFinding({
      title: `Hardening headers absent (${missing.join(', ')})`,
      severity: 'Low',
      classification: 'Security/Information Disclosure',
      method: meta.method,
      path: meta.path,
      description: `The response omits ${missing.join(' and ')}. On a token-authenticated JSON API consumed by apps this is defence in depth rather than an exploitable gap, but it costs one filter to add and it matters for any browser-rendered view of this data.`,
      expected: `${missing.join(' and ')} present on every response`,
      actual: 'Header(s) absent',
      repro: meta.repro,
      requestHeaders: headersOf(meta, response),
      requestBody: bodyOf(meta, response),
      riskImpact:
        'Defence in depth only. Content sniffing and framing protections are absent for any browser-rendered consumer of this response.',
    });
  }
}

/**
 * Asserts the response both carries an expected status and satisfies its Zod contract.
 * Pairs the transport check and the shape check so a finding records which one failed.
 *
 * The success schema is applied only to 2xx responses. A 4xx/5xx carries the platform's error
 * envelope, which legitimately has no `data` — validating the success schema against it would
 * report a schema violation for every ordinary error response and bury the real contract
 * defects underneath.
 */
export async function expectValidContract<T extends z.ZodTypeAny>(
  response: APIResponse,
  schema: T,
  meta: EndpointMeta,
  acceptableStatuses: number[] = [200, 201]
): Promise<z.infer<T> | null> {
  await assertStatus(response, acceptableStatuses, meta);
  await assertResponseHeaders(response, meta);

  const { json } = await readBody(response);
  if (json === null) {
    // A bare-string body is legitimate for several KMail routes; the status assertion above
    // has already covered the transport contract, so there is nothing further to validate.
    return null;
  }

  const ctx = {
    method: meta.method,
    path: meta.path,
    repro: meta.repro,
    body: meta.body,
    headers: headersOf(meta, response),
  };

  const httpStatus = response.status();
  if (httpStatus < 200 || httpStatus >= 300) {
    validateSchema(json, errorEnvelopeSchema, {
      ...ctx,
      title: 'Error response does not match the platform error envelope',
    });
    return null;
  }

  return validateSchema(json, schema, ctx);
}
