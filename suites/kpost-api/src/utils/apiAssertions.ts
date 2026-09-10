import { APIResponse, expect } from '@playwright/test';
import { z } from 'zod';
import { capturedRequestFor } from '../api/clients/base.client';
import { CALLER_IDENTITY_FIELDS, isTokenDerivedEndpoint } from '../api/registry/tokenDerived.generated';
import { errorEnvelopeSchema } from '../api/schemas/envelope.schema';
import { validateSchema } from './schemaValidator';
import {
  BugCategory,
  FlawClassification,
  recordBug,
  recordEndpointExercised,
  recordSystemicObservation,
  Severity,
} from './bugTracker';

export interface EndpointMeta {
  method: string;
  path: string;
  /** Minimal Playwright code that reproduces the call. */
  repro: string;
  /** Request body sent, for the bug ledger's Steps to Reproduce. */
  body?: unknown;
  /** Headers sent, for the bug ledger. Defaults to the standard JSON + bearer pair. */
  headers?: Record<string, string>;
  title?: string;
  severity?: Severity;
  /**
   * Overrides the category derived from the flaw classification.
   *
   * The derivation in `bugTracker.categoryFor` is right for the overwhelming majority of
   * findings, so this exists for the cases where one classification spans two categories — a
   * header contract defect that is genuinely a hardening gap, or a functional assertion whose
   * real consequence is a slow response rather than a wrong one.
   */
  category?: BugCategory;
}

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

/**
 * The transport records what it actually sent, so the ledger reports the real request
 * rather than whatever a test remembered to pass through. Explicit `meta` values still win,
 * for the rare case where a test wants to describe the call differently.
 */
function headersOf(meta: EndpointMeta, response?: APIResponse): Record<string, string> {
  if (meta.headers) return meta.headers;
  const captured = response ? capturedRequestFor(response) : undefined;
  return captured?.headers ?? DEFAULT_HEADERS;
}

/**
 * HTTP 429 — the server throttled us, so the response says nothing about the endpoint.
 *
 * This is the bench observing its own load, not a defect. The suite fires ~4,500 requests in
 * nine minutes and several KPOST routes rate-limit; when they do, the reply is a well-formed
 * `429 "Too many requests. Please retry in 15 seconds."` in place of whatever the endpoint
 * would otherwise have returned. Every assertion downstream then reads it as the wrong status:
 * a validation probe reports "invalid input was not rejected", a contract check reports "the
 * envelope is wrong", and each files a ticket against an endpoint that behaved correctly.
 *
 * On the run of 2026-08-24 that was **62 of 425 filed defects — 15%** — across
 * `adminRegistration`, `generateJWTokens`, `changePassword`, `sendOTPtoMail` and the
 * forgot-password routes: the endpoints the suite hits hardest.
 *
 * Treating 429 as inconclusive rather than as a finding is the same principle the specs already
 * apply with `test.skip(json === null, …)`: a response that could not exercise the behaviour
 * proves nothing, and reporting it as a defect is worse than reporting nothing. Rate limiting
 * itself is still asserted where it belongs — `Security/Rate Limiting` findings assert a 429
 * **should** appear on repeated failures, and those are unaffected by this guard.
 */
function isRateLimited(response: APIResponse): boolean {
  return response.status() === 429;
}

/**
 * Whether this scenario fuzzes a payload field the server overwrites from the bearer token.
 *
 * On the 234 endpoints in `tokenDerived.generated.ts` the controller calls
 * `request.getAttribute("kpostID")` and writes the caller's verified identity over whatever the
 * body carried. An identity field there is decorative: sending it null, empty or belonging to
 * someone else changes nothing, so a 2xx is the contract rather than a validation gap. Swagger
 * agrees — "Overwritten from the bearer token on most authenticated routes."
 *
 * Confirmed on `/v2/dashboard/katchupDashboardMsg` and `/v2/dashboard/homeDashboardMsgs`
 * (2026-08-24): `sender` omitted, null, and set to a foreign account all returned 200 with the
 * caller's own data and never the foreign identifier. Five tickets had been filed against that,
 * three of them Critical.
 *
 * **Both halves are required.** The workbook records which endpoints read the token, not which
 * field they assign, so matching on the endpoint alone over-suppresses: only `sender` is
 * token-derived on `/v2/katchup/messageCountBetweenSenderAndReceiver`, while `receiver` is the
 * other party and cannot come from the caller's token. Its `receiver: null` finding is real and
 * still files, because `receiver` is absent from `CALLER_IDENTITY_FIELDS`.
 *
 * The field is read from the scenario text the caller already writes — `field "sender" set to
 * null`, `required field "sender" omitted` — so no test needs editing to benefit.
 */
function fuzzesTokenDerivedIdentity(meta: EndpointMeta & { scenario: string }): boolean {
  if (!isTokenDerivedEndpoint(meta.method, meta.path)) return false;
  const quoted = [...meta.scenario.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) =>
    m[1].toLowerCase()
  );
  return quoted.some((field) => CALLER_IDENTITY_FIELDS.has(field));
}

/**
 * Whether the request that produced this response carried a bearer token.
 *
 * Recorded on the ticket because the expected-status line reads, to a developer, as though the
 * test had been probing an unauthenticated call. `assertRejectsInvalidInput` prints every
 * status it would have accepted — "HTTP 400 or 401 or 403 or 404 or 422" — and a reviewer who
 * sees 401 in that list reasonably answers "we already return 401 for a bad token, so this is
 * handled" and closes the ticket. It is a misreading, but an entirely fair one: nothing else on
 * the ticket says the caller was signed in, and the curl carries `$KPOST_TOKEN`, which looks
 * like it might be empty.
 *
 * Those codes are alternative *rejection* codes, any of which would have satisfied the
 * assertion. The scenario is invalid input from an **authenticated** caller, and the finding is
 * that it was accepted. Stating that on the ticket ends the exchange before it starts.
 */
function wasAuthenticated(meta: EndpointMeta, response?: APIResponse): boolean {
  const headers = headersOf(meta, response);
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  )?.[1];
  if (typeof authorization !== 'string') return false;
  // A placeholder or an empty "Bearer " is not a token; only a value with something after the
  // scheme counts, so an anonymous probe is never described as authenticated.
  return /^bearer\s+\S+/i.test(authorization.trim()) && !/^bearer\s+\$/i.test(authorization.trim());
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
 * Strips per-request fields so two response bodies can be compared for *content*.
 *
 * The ownership assertions in this suite read an endpoint twice — once as the caller, once
 * with a foreign identity supplied — and require the two bodies to be identical, because a
 * difference means a caller-supplied id widened the scope.
 *
 * Comparing the raw text cannot answer that question on this API. Every error envelope carries
 * a `timestamp` and a `traceId` minted per request, so two responses are *never* byte-identical
 * even when they describe exactly the same thing. On 2026-08-28 that filed five Critical
 * cross-tenant tickets whose evidence was two copies of the same
 * `400 "contactIDs is required and may not be empty"` — no contacts were returned to either
 * call, so nothing could have leaked. All five were withdrawn.
 *
 * Removing those fields also fixes the both-calls-failed case for free: two identical
 * rejections now compare equal and file nothing, while a genuine difference in returned data
 * still fails the assertion and is still reported.
 */
export function comparableBody(text: string): string {
  return text.replace(/"(timestamp|traceId)"\s*:\s*"[^"]*"\s*,?/g, '');
}

/** Body text plus a best-effort JSON parse — many endpoints return bare strings. */
export async function readBody(
  response: APIResponse
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return {
      text,
      json: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null,
    };
  } catch {
    return { text, json: null };
  }
}

interface FileBug {
  meta: EndpointMeta;
  title: string;
  severity: Severity;
  classification: FlawClassification;
  description: string;
  expected: string;
  actual: string;
  /**
   * Overrides the per-classification default risk wording.
   *
   * Needed because the default is chosen by classification alone, and one classification can
   * describe outcomes with very different costs. Every `Input Validation Gap` finding used to
   * inherit "Invalid data is persisted…", which is simply untrue of a lookup that validated
   * nothing and stored nothing — the ticket then told a developer to go hunting for corrupt
   * rows that do not exist.
   */
  riskImpact?: string;
  /**
   * Pins the defect id to a stable fingerprint while `title` stays free to reword, so an
   * improved summary never re-files a live Bugzilla ticket. See `BugInput.identityTitle`.
   */
  identityTitle?: string;
  /** Path-independent identity, for a defect that is systemic rather than per-endpoint. */
  dedupeKey?: string;
  /** Observation bucket, so the compiled report can state how many endpoints are affected. */
  systemicKind?: string;
  /** The response the finding came from — supplies the real request for reproduction. */
  response?: APIResponse;
  /** Overrides the classification-derived category. `meta.category` wins over this. */
  category?: BugCategory;
}

function file(bug: FileBug): string {
  return recordBug({
    title: bug.title,
    severity: bug.severity,
    module: '',
    method: bug.meta.method,
    endpointPath: bug.meta.path,
    classification: bug.classification,
    description: bug.description,
    requestHeaders: headersOf(bug.meta, bug.response),
    requestBody: bodyOf(bug.meta, bug.response),
    expected: bug.expected,
    actual: bug.actual,
    reproSnippet: bug.meta.repro,
    riskImpact: bug.riskImpact,
    identityTitle: bug.identityTitle,
    dedupeKey: bug.dedupeKey,
    systemicKind: bug.systemicKind,
    category: bug.meta.category ?? bug.category,
  });
}

/**
 * Standard status assertion. On mismatch, records a finding before failing so the reporter
 * output and the durable ledger stay in sync.
 */
export async function assertStatus(
  response: APIResponse,
  expectedStatuses: number[],
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const actual = response.status();
  if (expectedStatuses.includes(actual)) return;

  const { text } = await readBody(response);
  /*
   * A 5xx where a 4xx was required is an unhandled server fault: the request reached code that
   * did not expect it. That is **Major** — the band for internals disclosed and rules not
   * enforced — and not Critical, because on its own it corrupts nothing and grants nothing.
   * The Critical band is reserved for auth bypass, injection, IDOR, unauthenticated exposure,
   * and invalid input that was *accepted*; a 500 is none of those, and the cases where a fault
   * does leak a stack trace are already caught, and graded, by `assertNoInternalLeak`.
   *
   * Grading every 5xx Critical put ~20 ordinary NPEs alongside the payment-signing oracle, and
   * a P0 list nobody can triage is the same as no P0 list. A merely *wrong* status — 400
   * instead of 401, 200 instead of 404 — misleads the caller but corrupts nothing, which is
   * what the Minor band is for. Callers that know better pass `meta.severity` explicitly.
   */
  const severity: Severity = meta.severity ?? (actual >= 500 ? 'Major' : 'Minor');

  file({
    meta,
    response,
    title: meta.title ?? `Returns HTTP ${actual} where ${expectedStatuses.join('/')} is required`,
    severity,
    classification: actual >= 500 ? 'Unhandled NPE / Server Error' : 'Incorrect HTTP Status',
    description: `The endpoint answered HTTP ${actual}. The documented and REST-correct response for this request is ${expectedStatuses.join(' or ')}. Clients branching on the status code will take the wrong path.`,
    expected: `HTTP ${expectedStatuses.join(' or ')}`,
    actual: `HTTP ${actual} — body: ${truncate(text)}`,
  });

  expect(
    expectedStatuses,
    `Expected status [${expectedStatuses.join(', ')}] on ${meta.method} ${meta.path} but got ${actual}. Body: ${truncate(text, 300)}`
  ).toContain(actual);
}

/**
 * The platform embeds its own `statusCode` in the response envelope. When that disagrees
 * with the transport status the client is actively misled — a 200 carrying `statusCode: 500`
 * makes every well-behaved HTTP client treat a server error as success.
 */
export async function assertStatusCodeParity(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  const { text, json } = await readBody(response);
  if (!json || typeof json.statusCode !== 'number') return;

  const bodyStatus = json.statusCode;
  if (bodyStatus === httpStatus) return;

  const masksError = httpStatus < 400 && bodyStatus >= 400;

  file({
    meta,
    response,
    title: `HTTP ${httpStatus} contradicts envelope statusCode ${bodyStatus}`,
    // Masking a failure behind HTTP 200 is Major: monitoring never sees it and a client
    // believes a write landed that did not. It is not Critical — nothing is granted and
    // nothing is corrupted by the misreport itself, and Critical is reserved for auth bypass,
    // injection, IDOR, exposure, and invalid input accepted. A parity mismatch that does not
    // hide a failure is a plain contract defect: Minor.
    severity: masksError ? 'Major' : 'Minor',
    classification: 'Status Code Misreporting',
    description: masksError
      ? `The transport status (${httpStatus}) reports success while the response envelope reports ${bodyStatus}. Any client, proxy, retry policy, or monitoring rule that keys on the HTTP status will treat a server-side failure as a success, so the error is invisible in dashboards and never retried.`
      : `The transport status (${httpStatus}) and the envelope statusCode (${bodyStatus}) disagree, so the same outcome is described two different ways in one response.`,
    expected: `HTTP status to equal the envelope statusCode (${bodyStatus})`,
    actual: `HTTP ${httpStatus} with body statusCode ${bodyStatus} — body: ${truncate(text)}`,
  });

  expect(
    bodyStatus,
    `${meta.method} ${meta.path}: HTTP status ${httpStatus} disagrees with envelope statusCode ${bodyStatus}. A client trusting the HTTP status is misled. Body: ${truncate(text, 300)}`
  ).toBe(httpStatus);
}

const LEAK_PATTERNS: Array<{ label: string; pattern: RegExp; classification: FlawClassification }> = [
  {
    label: 'Java stack trace',
    pattern: /(at\s+(?:com|org|java|jakarta|javax)\.[\w.$]+\([^)]*\))/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'Java exception class',
    pattern: /\b(?:java|jakarta|javax|org\.springframework)\.[\w.]*Exception\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'NullPointerException',
    pattern: /NullPointerException/i,
    classification: 'Unhandled NPE / Server Error',
  },
  {
    label: 'SQL error',
    pattern: /\b(SQLException|SQLSyntaxError|ORA-\d{4,}|ER_\w+|syntax error at or near)\b/i,
    classification: 'Security/SQL Injection',
  },
  {
    label: 'SQL statement echo',
    pattern: /\b(select\s+.+\s+from\s+\w+|insert\s+into\s+\w+|update\s+\w+\s+set)\b/i,
    classification: 'Security/SQL Injection',
  },
  {
    label: 'Hibernate internals',
    pattern: /\borg\.hibernate\b|\bHibernateException\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    // KPOST streams avatars and attachments from S3 and, on failure, returns the SDK's raw
    // error verbatim — including the S3 Request ID and Extended Request ID, which identify
    // internal infrastructure to an unauthenticated caller.
    label: 'AWS/S3 SDK error',
    pattern: /\b(S3 error|Service:\s*Amazon\s*S3|S3 Extended Request ID|AmazonS3Exception|AmazonServiceException)\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    // The RedBus controller puts the partner client's exception message straight into
    // `errorvalue`, so an ordinary "ticket not found" hands the caller the upstream base URL,
    // the exact path, the query string it was called with, and the partner's HTTP status —
    // e.g. "GET http://api.seatseller.travel/ticket?tin=… returned 403 Forbidden". That maps
    // the integration's private surface for anyone holding any valid token, and the echoed
    // query string can carry the reference the caller supplied.
    label: 'Upstream integration endpoint disclosure',
    pattern:
      /\b(?:GET|POST|PUT|DELETE|PATCH)\s+https?:\/\/[^\s"]+\s+returned a response status of\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'Cloud provider request identifier',
    pattern: /\b(Request ID:\s*[A-Z0-9]{8,}|x-amz-request-id)\b/i,
    classification: 'Security/Information Disclosure',
  },
];

/**
 * Injection payloads must not come back as database errors or stack traces — that is both an
 * information leak and a strong signal the input reached the query layer unsanitized.
 */
export async function assertNoInternalLeak(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const { text } = await readBody(response);

  for (const { label, pattern, classification } of LEAK_PATTERNS) {
    if (!pattern.test(text)) continue;

    file({
      meta,
      response,
      title: `Injected input triggers an internals leak (${label})`,
      severity: 'Critical',
      classification,
      description: `Submitting \`${injectedValue}\` caused the response to disclose ${label}. This leaks server internals to an attacker and indicates the value reached the persistence layer without being parameterised or sanitised.`,
      expected: 'Malicious input rejected or sanitised, with a generic client error and no internals disclosed',
      actual: `Response matched ${label} — body: ${truncate(text)}`,
    });

    expect(
      text,
      `${meta.method} ${meta.path}: injecting "${injectedValue}" leaked ${label}. Body: ${truncate(text, 300)}`
    ).not.toMatch(pattern);
  }
}

/**
 * A reflected script payload returned verbatim is an XSS sink for any consumer that renders it.
 */
export async function assertNoReflectedScript(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const { text, json } = await readBody(response);
  const dangerous = /<script|onerror\s*=|onload\s*=|javascript:/i;

  if (!dangerous.test(text) || !text.includes(injectedValue)) return;

  /*
   * Distinguishing "persisted" from "echoed in an error" cannot rely on the HTTP status
   * alone: this API routinely answers HTTP 200 carrying `status: FAILURE`, so a 2xx check
   * classifies every rejected-and-echoed payload as stored XSS. The envelope has to agree
   * that the write succeeded before the word "persisted" is justified.
   */
  const envelopeStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const envelopeCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  const succeeded =
    response.status() >= 200 &&
    response.status() < 300 &&
    envelopeStatus !== 'FAILURE' &&
    envelopeStatus !== 'ERROR' &&
    (envelopeCode === null || envelopeCode < 400);

  /*
   * Severity turns on whether a browser would actually run it. Script reflected into a
   * correctly-typed `application/json` body is inert on arrival — it only becomes live if a
   * client renders the field as HTML, which is a real but conditional risk. Reflected into
   * `text/html`, or persisted for later display, it executes.
   */
  const contentType = response.headers()['content-type'] ?? '';
  const rendersAsHtml = /text\/html/i.test(contentType);

  file({
    meta,
    response,
    title: succeeded
      ? 'Script payload accepted and persisted unescaped (stored XSS)'
      : rendersAsHtml
        ? 'Script payload reflected unescaped into an HTML response (reflected XSS)'
        : 'Script payload echoed unescaped in an error message',
    severity: succeeded || rendersAsHtml ? 'Critical' : 'Major',
    classification: 'Security/XSS',
    description: succeeded
      ? `The payload \`${injectedValue}\` was accepted with a success status and returned verbatim, indicating it was persisted without encoding. Any UI that later renders this record executes attacker-controlled script in the viewer's session.`
      : rendersAsHtml
        ? `The payload \`${injectedValue}\` was echoed back unencoded in a text/html response, so a browser executes it directly.`
        : `The payload \`${injectedValue}\` was echoed back verbatim inside an error message on a \`${contentType || 'unknown'}\` response. A browser will not execute it there, but the message is written for display: any client that renders the error text as HTML — a toast, a banner — runs attacker-controlled script. The input should be encoded or omitted from the message.`,
    expected: 'Input HTML-encoded or rejected before being stored or echoed',
    actual: `Raw payload returned — body: ${truncate(text)}`,
  });

  expect(
    text,
    `${meta.method} ${meta.path}: reflected unescaped script payload "${injectedValue}"`
  ).not.toContain(injectedValue);
}

/**
 * Invalid input must be refused, not silently accepted. Records the specific
 * "HTTP 200 on an error case" pattern the audit brief calls out.
 */
export async function assertRejectsInvalidInput(
  response: APIResponse,
  meta: EndpointMeta & {
    scenario: string;
    /**
     * Set on endpoints that only ever read — availability checks, reference lookups, list
     * queries. Accepting a bad parameter there is still a validation gap, but nothing is
     * written, so the finding is graded Major and never claims data was persisted.
     *
     * Without it the helper has to assume the worst, because it cannot tell a lookup from a
     * write. That assumption put five read-only KPOST lookups (`domain`, `isCompanyNameExist`,
     * `mobileNoExist`, `getDesignationByProfessionId`) on the P0 list alongside
     * `saveEnquiryDetails`, which genuinely does persist an all-null row — and a P0 list that
     * mixes the two is one nobody triages.
     */
    readOnly?: boolean;
  },
  acceptableStatuses: number[] = [400, 422]
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (acceptableStatuses.includes(httpStatus)) return;

  const { text, json } = await readBody(response);
  const bodyStatus = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  /*
   * `statusCode` is absent from some envelopes — the RedBus tag answers
   * `{ status, value, errorcode, errorvalue }` with no numeric code at all. Reading only
   * `statusCode` there yields null, and "no code" must not be mistaken for "succeeded": the
   * word in `status` is the only signal those routes give, and it is routinely FAILURE on an
   * HTTP 200. Without this the helper reports every rejected-upstream call as silently
   * accepted, which is the difference between Critical and Major.
   */
  const envelopeStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const envelopeSaysFailed = envelopeStatus === 'FAILURE' || envelopeStatus === 'ERROR';
  const silentlyAccepted =
    httpStatus >= 200 &&
    httpStatus < 300 &&
    !envelopeSaysFailed &&
    (bodyStatus === null || bodyStatus < 400);

  /*
   * Accepted, but the field could not have changed the outcome — the server overwrote it from
   * the token. Nothing is filed and the assertion passes, because the endpoint did exactly what
   * its contract says. Only acceptance is exempt: if the same route answers 500 on a fuzzed
   * identity field, the value clearly did reach the code and that still files below.
   */
  if (silentlyAccepted && fuzzesTokenDerivedIdentity(meta)) return;

  const readOnly = meta.readOnly === true;

  file({
    meta,
    response,
    /*
     * The title names the ACTUAL outcome, so two genuinely different faults never share a
     * summary: invalid input *accepted* (HTTP 2xx — missing validation, a corrupt row) reads
     * differently from the same field *crashing* the endpoint (HTTP 5xx — an unhandled NPE) or
     * being *rejected with the wrong code*. These are different bugs with different fixes, and
     * before this each produced the identical "…is not rejected with 400/422" line. The accepted
     * wording matches the KMail bench for cross-product consistency.
     */
    title: silentlyAccepted
      ? `Invalid input accepted: ${meta.scenario}`
      : httpStatus >= 500
        ? `${meta.scenario} triggers a server error (HTTP ${httpStatus}) instead of 400/422`
        : `${meta.scenario} is rejected with HTTP ${httpStatus} instead of 400/422`,
    /*
     * Identity stays pinned to the ORIGINAL fingerprint so the reworded title never re-files a
     * ticket already open in Bugzilla — verified to reproduce every existing id exactly. This
     * string is load-bearing: keep it byte-stable forever.
     */
    identityTitle: `${meta.scenario} is not rejected with 400/422`,
    /*
     * Callers may downgrade explicitly. The default treats a 2xx as acceptance, which is right
     * for a write — an invalid body that returns 200 has persisted a corrupt row. A read marked
     * `readOnly` accepts nothing and creates nothing, so it is graded Major: a real validation
     * defect and a misleading response, but not a data-integrity breach.
     */
    severity: meta.severity ?? (silentlyAccepted ? (readOnly ? 'Major' : 'Critical') : 'Minor'),
    classification: silentlyAccepted
      ? 'Input Validation Gap'
      : httpStatus >= 500
        ? 'Unhandled NPE / Server Error'
        : 'Incorrect HTTP Status',
    description: silentlyAccepted
      ? readOnly
        ? `Invalid input (${meta.scenario}) was ACCEPTED with HTTP ${httpStatus} on a read-only lookup. Nothing is written, so no record is corrupted — but the endpoint answered as though the request were meaningful, so the caller cannot distinguish a genuine result from one derived from a parameter the server never validated. A client acting on that answer makes a decision on a value the API silently ignored.`
        : `Invalid input (${meta.scenario}) was ACCEPTED with HTTP ${httpStatus}. The request should have been refused; instead the API either silently defaulted the value or persisted an invalid record, so corrupt data enters the system with no error surfaced to the caller.`
      : `Invalid input (${meta.scenario}) was refused with HTTP ${httpStatus} instead of a 4xx client error. A ${httpStatus} tells the caller the server malfunctioned rather than that their request was wrong, which hides a user-correctable error and triggers pointless retries and alerts.`,
    riskImpact:
      silentlyAccepted && readOnly
        ? 'A lookup answers confidently on input it never validated, so callers act on results that do not mean what they appear to. Nothing is persisted, so there is no data to clean up — the cost is wrong client behaviour and a validation rule that exists in the contract but not in the code.'
        : undefined,
    expected:
      `HTTP ${acceptableStatuses.join(' or ')} (input validation failure)` +
      (wasAuthenticated(meta, response)
        ? ' — any one of these would have been accepted. The request carried a VALID session ' +
          'token, so this is not an authentication test: a 401 here would have been a fine ' +
          'outcome, and the defect is that the endpoint returned success instead.'
        : ''),
    actual: silentlyAccepted
      ? `HTTP ${httpStatus} — invalid input accepted. Body: ${truncate(text)}`
      : `HTTP ${httpStatus}${bodyStatus !== null ? ` (envelope statusCode ${bodyStatus})` : ''} — body: ${truncate(text)}`,
  });

  expect(
    acceptableStatuses,
    `${meta.method} ${meta.path} [${meta.scenario}]: expected ${acceptableStatuses.join('/')} but got ${httpStatus}. Body: ${truncate(text, 300)}`
  ).toContain(httpStatus);
}

/**
 * Markers that an anonymous response actually handed back protected material, rather than
 * public reference data. Used to separate a true auth bypass from a spec/implementation
 * mismatch on a deliberately-public lookup.
 */
const SENSITIVE_RESPONSE_MARKERS =
  /"(mobileNumber|alternateMobileno|email|otherEmail|aadhaarNumber|panNumber|password|kmailPassword|accessCode|accessToken|refreshToken|dateOfBirth|presentAddress|permanentAddress)"\s*:\s*"[^"]{3,}"/i;

/**
 * A secured endpoint reached without a usable token must answer 401/403 — never 400
 * (which reads as "your payload was wrong") and never 200.
 */
export async function assertUnauthorized(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (httpStatus === 401 || httpStatus === 403) return;

  const { text } = await readBody(response);
  const served = httpStatus >= 200 && httpStatus < 300;
  // Serving anonymously only rises to Critical when protected material actually came back.
  // Many KPOST routes are registration-time lookups (name availability, language lists)
  // that must work before a token exists; grading those Critical would bury the real
  // bypasses in noise.
  const leakedData = served && SENSITIVE_RESPONSE_MARKERS.test(text);

  let title: string;
  let severity: Severity;
  let description: string;
  /*
   * Only the third branch below is systemic.
   *
   * Branches one and two say something about *this endpoint* — that it handed a stranger
   * personal data, or that a route the spec marks secured is in fact open. Which endpoint that
   * is, is the whole finding, so those stay one ticket each.
   *
   * The third branch says something about the *auth filter*: it rejects correctly but answers
   * 400 instead of 401/403. That is one wrong status in one shared component, and the full run
   * filed it 227 times — 70% of every defect in the report. Collapsed per status code, the same
   * information becomes two tickets that name the real fix.
   */
  let dedupeKey: string | undefined;
  let systemicKind: string | undefined;

  if (leakedData) {
    title = 'Unauthenticated caller received protected user data';
    severity = 'Critical';
    description =
      'The endpoint returned a success status, and personal or credential fields, to a caller presenting no valid token. This is an authentication bypass exposing protected data.';
  } else if (served) {
    title = 'Endpoint declared as secured serves anonymous callers';
    severity = 'Major';
    description =
      'swagger.json places this route under the global `bearerAuth` requirement, but it answered successfully with no Authorization header. The response did not contain personal data, so this is not an outright data breach; it is still a contract defect. Either the route is deliberately public and the spec must declare `security: []`, or the authentication filter is not applied to it. Left unresolved, the published contract cannot be trusted to describe which routes are protected.';
  } else {
    systemicKind = `auth-status-${httpStatus}`;
    dedupeKey = `SYSTEMIC:auth-status:${httpStatus}`;
    recordSystemicObservation(systemicKind, `${meta.method} ${meta.path}`);

    title = `Unauthenticated requests answered ${httpStatus} instead of 401/403`;
    severity = 'Major';
    description = `Unauthenticated callers receive HTTP ${httpStatus} rather than 401/403. Clients cannot distinguish "you are not signed in" from "your request was malformed", so token-refresh and re-login flows never trigger; a ${httpStatus} also hides genuine auth failures from security monitoring. The rejection itself is correct — access is refused — so this is one wrong status code in the shared authentication filter, not a per-route defect. It is filed as a single ticket; the Scope line records how many routes were observed answering this way.`;
  }

  file({
    meta,
    response,
    title,
    severity,
    classification: 'Security/Access Control',
    description,
    dedupeKey,
    systemicKind,
    expected: 'HTTP 401 Unauthorized or 403 Forbidden',
    actual: `HTTP ${httpStatus} on the sampled endpoint — body: ${truncate(text)}`,
  });

  expect(
    [401, 403],
    `${meta.method} ${meta.path}: expected 401/403 without a valid token but got ${httpStatus}. Body: ${truncate(text, 300)}`
  ).toContain(httpStatus);
}

/**
 * The inverse of {@link assertUnauthorized}.
 *
 * Some routes are **declared public** — `security: []` in swagger.json, `permitAll` in the
 * Spring `SecurityConfiguration`. They exist to be reached *before a token can exist*: the
 * login-time company picker, `kpostIdExist`, the reference-data lookups, signup itself. If the
 * implementation nonetheless drops one behind the auth filter, an anonymous caller is turned
 * away with **401/403** and the pre-token flow the route exists to serve is blocked outright —
 * a first-time user can never sign up, a returning user can never fetch the companies they may
 * log into. The developer "handled" a route the contract says needs no handling.
 *
 * Pass the response from a **token-less** request (`{ token: null }`). 401 or 403 is the
 * defect. Anything else — 200, 400, 404, even 500 — means the request reached application code
 * rather than being refused at the door, so the *gating* is not the problem; the response's own
 * correctness is covered by assertStatus / assertNoInternalLeak / assertRejectsInvalidInput.
 *
 * Graded **Major** by default: a published-contract mismatch that blocks a flow but leaks and
 * corrupts nothing, matching the sibling grade in `assertUnauthorized` for "declared secured,
 * serves anonymous". Pass `meta.severity: 'Critical'` for a route whose gating is a total
 * feature blockade with no workaround — signup and login, where no one holds a token yet.
 *
 * One ticket per gated route: *which* public route was closed off is the whole finding, and the
 * path is stable across runs, so the content-hash id stays constant and never re-files.
 */
export async function assertPublicRouteReachable(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (httpStatus !== 401 && httpStatus !== 403) return; // reached the app — gating is fine

  const { text } = await readBody(response);
  file({
    meta,
    response,
    title: meta.title ?? 'Route declared public rejects anonymous callers',
    severity: meta.severity ?? 'Major',
    classification: 'Security/Access Control',
    description: `This route is documented public — \`permitAll\` in the platform \`SecurityConfiguration\`, and \`security: []\` in swagger.json for the core auth routes — so the published contract says it is reachable before a token exists. The implementation instead answered HTTP ${httpStatus} to a caller sending no Authorization header. Contract and implementation disagree, so the published contract cannot be trusted to describe which routes are protected, and the fix depends on intent: if the route is genuinely a pre-token flow — login, an onboarding lookup, the company picker — the auth filter must be lifted, because a client that has no token yet can never reach it; if the route is genuinely meant to be protected — an attachment or signature download keyed to a real subject — then swagger.json must drop \`security: []\` and declare \`bearerAuth\` so the contract matches. Either way the mismatch is the defect.`,
    dedupeKey: `PUBLIC-GATED:${meta.method} ${meta.path}`,
    expected: 'Contract and implementation agree on whether a token is required — either the route is reachable anonymously (any status other than 401/403), or the contract declares it protected',
    actual: `HTTP ${httpStatus} — the auth filter refused an anonymous request to a route the contract marks public. Body: ${truncate(text)}`,
  });

  expect(
    [401, 403],
    `${meta.method} ${meta.path} is documented public but answered ${httpStatus} to an anonymous caller — contract and implementation disagree on whether a token is required. Body: ${truncate(text, 300)}`
  ).not.toContain(httpStatus);
}

/**
 * Detects a success transport status carrying a failure payload.
 *
 * KPOST frequently answers HTTP 200 with `status: "FAILURE"`, `statusCode: 500`, or a raw
 * exception trace in the body. Every client, proxy, retry policy and monitoring rule keys on
 * the HTTP status, so these failures are invisible in dashboards and never retried.
 */
export async function assertNot200OKOnError(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint. See isRateLimited.
  if (isRateLimited(response)) return;
  const httpStatus = response.status();
  if (httpStatus < 200 || httpStatus >= 300) return;

  const { text, json } = await readBody(response);

  const bodyStatusCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  const bodyStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const failureWord = bodyStatus !== null && ['FAILURE', 'FAILED', 'ERROR'].includes(bodyStatus);
  const exceptionTrace = /NullPointerException|Exception|at\s+(?:com|org|java)\./i.test(text);

  const symptoms: string[] = [];
  if (bodyStatusCode !== null && bodyStatusCode >= 400) {
    symptoms.push(`envelope statusCode ${bodyStatusCode}`);
  }
  if (failureWord) symptoms.push(`envelope status "${bodyStatus}"`);
  if (exceptionTrace) symptoms.push('an exception trace in the body');
  if (symptoms.length === 0) return;

  file({
    meta,
    response,
    // Stable title so the finding dedupes to one ticket across runs; the per-run httpStatus and
    // symptom list vary and would otherwise re-seed the content-hash id, so they live in the
    // description / actual fields (which do not feed the id) rather than the title.
    title: `A failure payload is returned behind a success HTTP status`,
    // An exception trace is internals disclosed, and an envelope 5xx behind an HTTP 200 is a
    // masked server fault. Both are Major. Neither grants access nor persists bad data, so
    // neither belongs in the Critical band next to the auth and injection findings.
    severity:
      exceptionTrace || (bodyStatusCode !== null && bodyStatusCode >= 500) ? 'Major' : 'Minor',
    classification: exceptionTrace ? 'Unhandled NPE / Server Error' : 'Status Code Misreporting',
    description: `The endpoint answered HTTP ${httpStatus} while the body reports failure (${symptoms.join(', ')}). Callers that branch on the HTTP status — every HTTP client library, load balancer health check, retry policy and alerting rule — will treat this error as a success. The failure is therefore silent: it is never retried and never appears in error dashboards.`,
    expected: `A 4xx or 5xx transport status matching the failure described in the body`,
    actual: `HTTP ${httpStatus} — body: ${truncate(text)}`,
  });

  expect(
    symptoms,
    `${meta.method} ${meta.path}: HTTP ${httpStatus} but the body reports failure (${symptoms.join(', ')}). Body: ${truncate(text, 300)}`
  ).toEqual([]);
}

/**
 * Asserts the response both carries an expected status and satisfies its Zod contract.
 * Pairs the transport check and the shape check so a finding records which one failed.
 *
 * The success schema is applied only to 2xx responses. A 4xx/5xx carries the platform's
 * error envelope (`{status, timestamp, message, debugMessage}`), which legitimately has no
 * `statusCode` or `data`; validating the success schema against it would report a schema
 * violation for every ordinary error response and bury real contract defects.
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
    // A bare-string body is legitimate for several KPOST routes; the status assertion above
    // has already covered the transport contract, so there is nothing further to validate.
    return null;
  }

  const ctx = {
    method: meta.method,
    path: meta.path,
    repro: meta.repro,
    body: meta.body,
    headers: meta.headers,
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

/**
 * Transport-header contract. Called automatically by `expectValidContract`, so every
 * happy-path case in the suite carries it without each spec having to remember.
 *
 * Two different questions, deliberately graded apart:
 *
 * - **`Content-Type` is a correctness issue.** A JSON body served as `text/html` is not a
 *   cosmetic mismatch: it is the difference between a reflected `<script>` being inert and
 *   being executed by the browser. That is why `assertNoReflectedScript` reads the same header
 *   to decide between Major and Critical, and why a wrong content type is filed here as a real
 *   contract defect rather than ignored.
 * - **Missing hardening headers are Low.** `X-Content-Type-Options`, `X-Frame-Options` and
 *   HSTS matter for a browser-facing surface. This is a token-authenticated JSON API whose
 *   clients are mobile apps, so their absence is a defence-in-depth gap, not an exploitable
 *   one — filing it Critical would bury the findings that are. They are reported once per
 *   endpoint, in one finding, so 300 endpoints do not produce 900 tickets.
 *
 * A response with no body (204, or a redirect) is exempt: there is nothing to type.
 */
export async function assertResponseHeaders(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  const status = response.status();
  if (status === 204 || status === 304 || (status >= 300 && status < 400)) return;

  const headers = response.headers();
  const contentType = headers['content-type'] ?? '';
  const { text } = await readBody(response);
  if (text.length === 0) return;

  const looksLikeJson = /^\s*[[{]/.test(text);
  const declaresJson = /application\/json/i.test(contentType);
  const declaresHtml = /text\/html/i.test(contentType);

  if (looksLikeJson && !declaresJson) {
    file({
      meta,
      response,
      title: `JSON body served as "${contentType || '(no content-type)'}"`,
      // Serving JSON as text/html is what turns a reflected payload from inert into
      // executable, so it is graded on that consequence rather than as a typo.
      severity: declaresHtml ? 'Major' : 'Trivial',
      classification: declaresHtml ? 'Security/XSS' : 'Transport/Header Contract',
      description: declaresHtml
        ? `The response body is JSON but the Content-Type is "${contentType}". A browser will parse it as HTML, so any caller-supplied value echoed into the body executes instead of being displayed as text. This converts an otherwise inert reflection into a working XSS vector.`
        : `The response body is JSON but the Content-Type is "${contentType || 'absent'}". Clients that branch on the content type — including strict HTTP libraries that refuse to parse — cannot consume this response reliably.`,
      expected: 'Content-Type: application/json',
      actual: `Content-Type: ${contentType || '(absent)'} — body: ${truncate(text)}`,
    });
  }

  const missing: string[] = [];
  if (!headers['x-content-type-options']) missing.push('X-Content-Type-Options: nosniff');
  if (!headers['x-frame-options'] && !headers['content-security-policy']) {
    missing.push('X-Frame-Options or Content-Security-Policy');
  }
  if (!headers['strict-transport-security']) missing.push('Strict-Transport-Security');

  if (missing.length > 0) {
    /*
     * ONE defect, not one per endpoint.
     *
     * These headers are set once in the filter chain, so their absence is a single
     * configuration defect that every route exhibits. Filing it per endpoint produced 29
     * identical tickets from the `common` project alone and projected to ~240 across the full
     * surface — enough to bury every real finding in the tracker and to teach the team that
     * automated tickets are noise.
     *
     * The dedupe key is the *missing header set*, not the path, so the ledger collapses to one
     * entry (or two, if part of the API sets some of them and part sets none — which is itself
     * worth seeing as a distinct finding). `meta.method`/`meta.path` still carry whichever
     * endpoint got there first, so the curl and Playwright repro remain real and runnable.
     */
    const kind = 'missing-security-headers';
    recordSystemicObservation(kind, `${meta.method} ${meta.path}`);

    file({
      meta,
      response,
      title: `API responses omit standard security headers (${missing.length} missing)`,
      severity: 'Trivial',
      classification: 'Transport/Header Contract',
      // The classification defaults to Functional because most header findings are contract
      // typos. This one is not: missing hardening headers is a security posture gap, even at
      // Trivial severity on a token-authenticated JSON API.
      category: 'Security',
      dedupeKey: `SYSTEMIC:${kind}:${[...missing].sort().join('|')}`,
      systemicKind: kind,
      description: `Responses carry none of: ${missing.join(', ')}. On a token-authenticated JSON API consumed by mobile clients this is defence in depth rather than an exploitable weakness — but "nosniff" in particular costs nothing and closes the content-type confusion route that the Content-Type finding above describes. This is a single filter-chain configuration, so it is reported as one defect with one fix rather than once per endpoint; the Scope line records how much of the API was observed exhibiting it.`,
      expected: `Response headers including ${missing.join(', ')}`,
      actual: `Present headers on the sampled endpoint: ${Object.keys(headers).sort().join(', ') || '(none)'}`,
    });
  }
}

/**
 * The generic ownership probe: a response must never acknowledge an identifier the caller
 * does not own.
 *
 * ## Why this exists rather than a bare `expect`
 *
 * Every `[IDOR]` case in this suite asserts the same thing in the same way — send a foreign
 * id, then check the answer does not carry it back. Written as a plain `expect`, a real breach
 * fails the test but files under **`Assertion Failure`**, which `BUGZILLA_FILE_ASSERTION_FAILURES`
 * excludes from the tracker by default. So the one class of finding that most deserves a
 * Critical ticket was the class least likely to get one. Routing it through the ledger fixes
 * that, and gives the ticket the request/response detail a safety-net entry can only infer.
 *
 * ## Why the verdict is "acknowledged", not the status code
 *
 * A correct implementation may answer 403, 404, **or** 200 with the caller's own data if it
 * ignores the foreign key entirely. All three are safe, so demanding a refusal would file a
 * defect against correct behaviour. What is never safe is the foreign value coming back — that
 * means it reached the record lookup instead of being scoped to the token.
 *
 * A `status: FAILURE` envelope under an HTTP 200 is not an acknowledgement either: this
 * platform routinely answers 200 over a failure body, and the id is often echoed in the error
 * message.
 */
export async function assertNoForeignAcknowledgement(
  response: APIResponse,
  meta: EndpointMeta & { foreignValue: string | number; what: string }
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  // Throttled: the response describes our request rate, not the endpoint's authorisation.
  if (isRateLimited(response)) return;
  const { text, json } = await readBody(response);

  const failed =
    json !== null &&
    typeof json === 'object' &&
    String((json as Record<string, unknown>).status ?? '').toUpperCase() === 'FAILURE';

  const acknowledged = response.ok() && !failed && text.includes(String(meta.foreignValue));
  if (!acknowledged) return;

  file({
    meta,
    response,
    title: meta.title ?? `Foreign ${meta.what} is acknowledged`,
    severity: meta.severity ?? 'Critical',
    classification: 'Security/Access Control',
    description: `The response carried ${meta.what} "${meta.foreignValue}", an identifier the caller does not own. The value reached the record lookup instead of being scoped to the identity on the token, so authorisation on this route depends on the client choosing not to ask for someone else's data.`,
    expected: `The ${meta.what} to be scoped to the caller — refused, or answered with the caller's own data`,
    actual: `Response acknowledged "${meta.foreignValue}" — HTTP ${response.status()}, body: ${truncate(text)}`,
  });

  expect(
    acknowledged,
    `${meta.method} ${meta.path}: the response acknowledged ${meta.what} "${meta.foreignValue}", an identifier the caller does not own. Status ${response.status()}, body: ${truncate(text)}`
  ).toBe(false);
}

/** Records a business-rule violation discovered by a hand-written assertion. */
export async function reportBusinessLogicFlaw(
  response: APIResponse,
  meta: EndpointMeta & { scenario: string },
  classification: FlawClassification = 'Business Logic Flaw',
  severity: Severity = 'Critical'
): Promise<string> {
  recordEndpointExercised(meta.method, meta.path);
  /*
   * Throttled: the caller concluded a business rule was broken, but it read that from a
   * response the server never produced for this request. Returning an empty id files nothing —
   * no caller uses the value, and an inconclusive observation must not become a ticket.
   */
  if (isRateLimited(response)) return '';
  const { text } = await readBody(response);

  return file({
    meta,
    response,
    title: meta.title ?? meta.scenario,
    severity,
    classification,
    description: meta.scenario,
    expected: 'The operation is refused and no state changes',
    actual: `HTTP ${response.status()} — body: ${truncate(text)}`,
  });
}
