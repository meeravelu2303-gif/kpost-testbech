import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { MODULE_BY_PATH } from '../api/registry/moduleOwnership.generated';
import { environmentName } from './environment';

const ROOT = path.resolve(__dirname, '../..');
const BUG_REPORT_PATH = path.join(ROOT, 'BUG_REPORT.md');
/** Machine-readable twin of BUG_REPORT.md, for CI jobs and tracker importers. */
const BUG_REPORT_JSON_PATH = path.join(ROOT, 'BUG_REPORT.json');

/**
 * Findings are written first to one file per defect here, then compiled into BUG_REPORT.md
 * at teardown. Playwright runs each worker as a separate process, so appending to a single
 * shared file races: two workers can both read "not yet reported" and append the same
 * finding twice. Creating a per-finding file with the exclusive 'wx' flag is atomic, which
 * is what makes cross-worker deduplication reliable.
 */
const BUG_CACHE_DIR = path.join(ROOT, '.bug-cache');

/**
 * Four bands, deliberately. A report where everything is Critical is a report nobody reads,
 * so the grading rules in `apiAssertions.ts` reserve Critical for defects that actually
 * changed or exposed something, and push spec/implementation mismatches down.
 *
 * | Band | Priority | Means |
 * | --- | --- | --- |
 * | Critical | P0 | Crash, severe data loss, or a total feature blockade with no workaround |
 * | Major | P1 | Significant loss of core functionality; a difficult workaround may exist |
 * | Minor | P2 | Small functional failure or limitation that does not impair basic operations |
 * | Trivial | P3 | Cosmetic contract/response-shape deviation, wording, visual glitch |
 *
 * Renamed from the former `Critical | Major | Medium | Low` set. `Medium` became `Minor` and
 * `Low` became `Trivial`; `normalizeSeverity` below still reads the old words so historical
 * artifacts (the append-only trend file, a `BUG_REPORT.json` from a previous run) keep parsing.
 */
export type Severity = 'Critical' | 'Major' | 'Minor' | 'Trivial';

/**
 * The second grading axis: *what kind* of defect this is, independent of how bad it is.
 *
 * Severity answers "how much does this hurt"; category answers "who should look at it and
 * what class of fix is it". A Critical Security finding and a Critical Functional finding are
 * equally urgent and go to entirely different reviewers, which a single severity column cannot
 * express. Every defect carries exactly one.
 */
export type BugCategory = 'Functional' | 'Performance' | 'Security' | 'Compatibility';

export const BUG_CATEGORIES: readonly BugCategory[] = [
  'Functional',
  'Performance',
  'Security',
  'Compatibility',
];

/** What each category means, rendered into the report so the bands stay self-documenting. */
export const CATEGORY_MEANING: Record<BugCategory, string> = {
  Functional: 'Incorrect output, logic failure, or a broken workflow',
  Performance: 'Slow responses, excessive resource use, or degradation under stress',
  Security: 'Vulnerability, data leak, or authorization flaw',
  Compatibility: 'Behaviour specific to certain clients, versions, devices or environments',
};

/**
 * Accepts the current band names and the pre-rename ones, so a reader of an older artifact
 * does not have to branch. Anything unrecognised grades `Minor` — the middle of the scale is
 * the honest answer for a value this process cannot interpret, and silently promoting an
 * unknown to Critical would poison the P0 queue.
 */
export function normalizeSeverity(value: string): Severity {
  switch (value) {
    case 'Critical':
      return 'Critical';
    case 'Major':
      return 'Major';
    case 'Minor':
    case 'Medium':
      return 'Minor';
    case 'Trivial':
    case 'Low':
      return 'Trivial';
    default:
      return 'Minor';
  }
}

/**
 * Delivery priority, distinct from severity.
 *
 * Severity says how bad the defect is; priority says how soon it must be picked up. They
 * usually track each other, which is why the default mapping below is mechanical — but the
 * field is separate so a low-severity defect blocking a release can still be raised to P0
 * by passing `priority` explicitly.
 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

const PRIORITY_BY_SEVERITY: Record<Severity, Priority> = {
  Critical: 'P0',
  Major: 'P1',
  Minor: 'P2',
  Trivial: 'P3',
};

/** Human wording for the priority bands, kept next to the mapping they come from. */
export const PRIORITY_MEANING: Record<Priority, string> = {
  P0: 'Showstopper — fix before the next deploy',
  P1: 'Fix this sprint',
  P2: 'Schedule',
  P3: 'Backlog',
};

export const SEVERITY_MEANING: Record<Severity, string> = {
  Critical: 'System crash, severe data loss, or a total feature blockade with no workaround',
  Major: 'Significant loss of core functionality, though a difficult workaround may exist',
  Minor: 'Small functional failure or limitation that does not impair basic operations',
  Trivial: 'Cosmetic deviation — contract/response shape, wording, or presentation only',
};

/** Defect taxonomy — drives the dashboard's "flaws by classification" breakdown. */
export type FlawClassification =
  | 'Security/XSS'
  | 'Security/SQL Injection'
  | 'Security/Access Control'
  | 'Security/Information Disclosure'
  | 'Security/Rate Limiting'
  | 'Business Logic Flaw'
  | 'Input Validation Gap'
  | 'Incorrect HTTP Status'
  | 'Status Code Misreporting'
  | 'Schema Violation'
  | 'Unhandled NPE / Server Error'
  | 'Idempotency / Concurrency'
  | 'Transport/Header Contract'
  /**
   * A test that failed through a plain `expect()` rather than one of the assertion helpers,
   * filed by `reporters/bug-safety-net.ts` so no failing test goes unticketed. The metadata is
   * thinner than a helper-filed defect — the helpers capture request/response detail this path
   * can only infer from telemetry.
   */
  | 'Assertion Failure';

/**
 * Category is derived from the flaw classification rather than asked for at every call site.
 *
 * The classification taxonomy already encodes the distinction — `Security/*` is exactly the
 * Security category — so deriving it keeps the two axes from drifting apart and means no
 * existing assertion has to be rewritten to gain a category. Call sites that know better pass
 * `meta.category` explicitly; that override always wins.
 *
 * Nothing maps to `Performance` by default: latency lives in `reporters/telemetry.ts`, which is
 * observational and has no threshold to grade against on a shared, contended bench. Grading a
 * slow response as a defect from a single sample would file noise, so Performance stays
 * override-only until a call site asserts a budget it can defend. `Compatibility` is likewise
 * override-only — an API surface with one client shape has no compatibility axis to fail on
 * until a test drives a second one.
 */
const CATEGORY_BY_CLASSIFICATION: Record<FlawClassification, BugCategory> = {
  'Security/XSS': 'Security',
  'Security/SQL Injection': 'Security',
  'Security/Access Control': 'Security',
  'Security/Information Disclosure': 'Security',
  'Security/Rate Limiting': 'Security',
  'Business Logic Flaw': 'Functional',
  'Input Validation Gap': 'Functional',
  'Incorrect HTTP Status': 'Functional',
  'Status Code Misreporting': 'Functional',
  'Schema Violation': 'Functional',
  'Unhandled NPE / Server Error': 'Functional',
  'Idempotency / Concurrency': 'Functional',
  /*
   * Transport and header contract straddles the line: a missing `X-Frame-Options` is a security
   * hardening gap, while a wrong `Content-Type` is a functional contract break. It grades
   * Functional by default because the majority of findings here are the latter, and the header
   * cases that are genuinely security-relevant already pass `meta.category` from
   * `assertSecurityHeaders`.
   */
  'Transport/Header Contract': 'Functional',
  'Assertion Failure': 'Functional',
};

export function categoryFor(classification: FlawClassification): BugCategory {
  return CATEGORY_BY_CLASSIFICATION[classification] ?? 'Functional';
}

/**
 * Phrases that mean a finding is a **security** issue regardless of the assertion that caught
 * it. Many auth/exposure defects are detected by a generic status/NPE assertion (so their
 * `classification` is `Incorrect HTTP Status` or `Unhandled NPE`, which maps to Functional),
 * even though the real consequence is a breach. The spec author raises the *severity* for
 * these but not the category; this recovers the category from the described consequence.
 *
 * Deliberately conservative — each marker names an actual security consequence (missing auth,
 * anonymous access, privilege crossing, bypass, exposure), so a plain validation defect
 * ("countryID that does not exist is not rejected") does not match and stays Functional, while
 * an auth one ("changePassword without the current password") does.
 */
const SECURITY_CONSEQUENCE_MARKERS = [
  /unauthenticated/i,
  /without (a|an|the)\s+(valid\s+)?(auth|token|session|current password|authorization)/i,
  /\bno auth\b|\bno token\b|with no auth/i,
  /anonymous(ly)?\b/i,
  /non-?admin can\b/i,
  /privilege|escalat/i,
  /\balg=none\b/i,
  /\bIDOR\b|cross-tenant|another (user|company|tenant)/i,
  /\bbypass(ed|es)?\b/i,
  /\bexposed\b|\bexposure\b|data leak|leak(s|ed|ing)?\b/i,
  /arbitrary (list|account|accounts|user)/i,
  /signatures? can be minted|forged token/i,
  /reachable without|downloadable with no|served without a token/i,
  /resolve a mobile (number )?to/i,
];

/**
 * The category derivation used when a call site does not pass one explicitly.
 *
 * Order: an explicit `Security/*` classification wins; then the described consequence (title +
 * description) is checked against the markers above; otherwise it falls back to the
 * classification default. An explicit `meta.category` still overrides everything (see
 * `recordBug`).
 */
export function deriveCategory(
  classification: FlawClassification,
  title: string,
  description: string
): BugCategory {
  const base = categoryFor(classification);
  if (base === 'Security') return base;
  const haystack = `${title}\n${description}`;
  if (SECURITY_CONSEQUENCE_MARKERS.some((re) => re.test(haystack))) return 'Security';
  return base;
}

/**
 * One place a grouped defect was observed.
 *
 * A defect is identified by its content fingerprint, so the same root cause tripped on forty
 * endpoints is one record with forty occurrences — this is what each of those forty contributes
 * back. Written by workers as individual files and merged in the reporter process; see
 * `recordOccurrence`.
 */
export interface BugOccurrence {
  method: string;
  endpointPath: string;
  module: string;
  owner: string;
  /** Playwright test id that observed it, when there was a test context. */
  testId?: string;
  /** What the API actually did here — kept so a grouped ticket can show the spread. */
  actual: string;
  /** ISO timestamp of the observation. */
  at: string;
}

/** One row of a grouped defect's affected-endpoint table. */
export interface AffectedEndpoint {
  method: string;
  endpointPath: string;
  module: string;
  owner: string;
  /** How many test cases observed the defect at this endpoint. */
  occurrences: number;
}

export interface BugRecord {
  /**
   * Stable, content-derived id: BUG-API-XXXXXX.
   *
   * This is *identity*, not the display label. A sequential counter cannot be minted safely
   * inside a worker — Playwright runs each worker as its own process, so a counter restarts
   * per worker and mints duplicates. The hash also collapses a defect that hundreds of tests
   * trip over into one entry, and stays stable across runs so a tracker can match it.
   *
   * The human-facing `BUG-<MODULE>-NNN` label is assigned in `displayId`, at compile time,
   * in the single reporter process where a counter *is* safe.
   */
  id: string;
  /** `BUG-AUTH-001` style label, assigned at compile time. Absent until then. */
  displayId?: string;
  title: string;
  severity: Severity;
  /** Delivery priority. Defaults from severity; can be set explicitly. */
  priority: Priority;
  /**
   * The second grading axis. Defaults from `classification` via `categoryFor`; a call site
   * that knows better passes it explicitly.
   */
  category: BugCategory;
  /** What this costs the business or the user if it ships. */
  riskImpact: string;
  /** Swagger tag / controller the endpoint belongs to. */
  module: string;
  /** Team the ticket should be routed to. */
  owner: string;
  method: string;
  endpointPath: string;
  classification: FlawClassification;
  description: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  expected: string;
  actual: string;
  reproSnippet: string;
  /** Copy-pasteable `curl` for the exact request, with the token redacted to a variable. */
  curlSnippet: string;
  /**
   * Set on a systemic finding — one root cause observed on many endpoints. Names the
   * observation bucket, and is what `writeReport` uses to fill in `scope` below.
   */
  systemicKind?: string;
  /** "Observed on N endpoints, including …" — computed at compile time from the buckets. */
  scope?: string;
  /**
   * Playwright's `TestInfo.testId` for the test that *first* filed this record, matching
   * `TestCase.id` in a reporter.
   *
   * It no longer scopes identity (see `computeId`) — it remains so
   * `reporters/bug-safety-net.ts` can tell which failing tests already filed a record and must
   * not be filed a second time. Every test that observed the defect is in `observedByTests`.
   */
  testId?: string;
  /**
   * Kept as metadata after identity stopped depending on it, so a consumer can still group a
   * systemic finding back together — the report's scope line, or a tracker-side filter.
   */
  dedupeKey?: string;

  /* ---------------------------------------------------------------- grouping
   * The fields below are filled in by the reporter at compile time, by merging the occurrence
   * files every worker contributed. They are absent on a record read straight out of
   * `.bug-cache/` and present on every record in `BUG_REPORT.json`.
   */

  /** How many test cases observed this defect across the whole run. At least 1. */
  occurrences?: number;
  /** Every distinct `METHOD /path` that exhibits it, ordered by occurrence count. */
  affectedEndpoints?: AffectedEndpoint[];
  /** Every module the affected endpoints belong to, ordered by occurrence count. */
  affectedModules?: string[];
  /** Every Playwright test id that observed it — lets a reader jump to any failing case. */
  observedByTests?: string[];
  /** ISO timestamp of the earliest / latest observation this run. */
  firstSeen?: string;
  lastSeen?: string;
  /**
   * A bounded spread of *distinct* observed behaviours, so a grouped ticket shows that (say) a
   * route answers 400 here and 500 there without pasting four hundred near-identical lines.
   * Capped at `MAX_EVIDENCE_SAMPLES`.
   */
  evidenceSamples?: Array<{ method: string; endpointPath: string; actual: string }>;
}

export type BugInput = Omit<
  BugRecord,
  | 'id'
  | 'displayId'
  | 'owner'
  | 'priority'
  | 'category'
  | 'riskImpact'
  | 'curlSnippet'
  | 'scope'
  | 'occurrences'
  | 'affectedEndpoints'
  | 'affectedModules'
  | 'observedByTests'
  | 'firstSeen'
  | 'lastSeen'
  | 'evidenceSamples'
> & {
  owner?: string;
  priority?: Priority;
  category?: BugCategory;
  riskImpact?: string;
  /**
   * Display/identity split. When set, `identityTitle` — not the human-readable `title` — feeds
   * the content-hash `id`. This lets a ticket's wording be improved without changing its id, so
   * a reworded summary never re-files a ticket already open in Bugzilla.
   *
   * `assertRejectsInvalidInput` uses it: its `title` now names the *actual* outcome (accepted /
   * server error / wrong status) so two genuinely different faults never share a summary, while
   * its identity stays pinned to the original fingerprint. `dedupeKey` still overrides both.
   */
  identityTitle?: string;
  /**
   * Overrides the default `method + path + title` fingerprint used to derive `id`.
   *
   * A systemic defect — missing security headers set once at the filter chain — is one bug
   * observed on every endpoint, not one bug per endpoint. Left to the default fingerprint it
   * minted a separate id per path: 29 identical tickets from the `common` project alone, and
   * roughly 240 projected across the full surface. Supplying a path-independent key collapses
   * them to a single ticket, while `method`/`endpointPath` keep a real sample request so the
   * curl and the repro snippet still work.
   */
  dedupeKey?: string;
};

/**
 * Risk wording per classification, used when a call site does not supply its own.
 *
 * The point of the field is to say what the defect *costs*, in the language a product owner
 * triages in — not to restate the assertion. A generic "this is a bug" line would be worse
 * than none, so each entry names a concrete consequence.
 */
const RISK_BY_CLASSIFICATION: Record<FlawClassification, string> = {
  'Security/XSS':
    'Attacker-controlled script executes in another user’s session, enabling account takeover and data theft from the rendering client.',
  'Security/SQL Injection':
    'Query structure is influenced by user input; worst case is unauthorised read or destruction of the datastore.',
  'Security/Access Control':
    'One user can read or act on another user’s data. Direct breach of tenant isolation and, for personal data, a reportable incident.',
  'Security/Information Disclosure':
    'Internal infrastructure, credentials or third-party endpoints are exposed to callers, lowering the cost of a follow-on attack.',
  'Security/Rate Limiting':
    'An unthrottled endpoint can be enumerated or used to exhaust capacity, quota or third-party spend.',
  'Business Logic Flaw':
    'The system reaches a state the business rules forbid; downstream processes and reporting act on data that should not exist.',
  'Input Validation Gap':
    'Invalid data is persisted, so corruption spreads to every consumer of the record and cannot be traced back to a rejected request.',
  'Incorrect HTTP Status':
    'Clients branch on the status code; a wrong one sends retries, alerts and error handling down the wrong path.',
  'Status Code Misreporting':
    'A failure is transported as a success. Callers record the operation as complete when nothing happened.',
  'Transport/Header Contract':
    'The response headers contradict the body or omit standard hardening. A wrong Content-Type is the difference between a reflected payload being inert and being executed by the browser; missing headers are defence in depth.',
  'Schema Violation':
    'The response breaks its published contract, so generated clients and typed consumers fail at runtime rather than at build time.',
  'Assertion Failure':
    'A behaviour the suite asserts did not hold. The consequence depends on the assertion — read the failure message and the linked trace, which carries the full request and response.',
  'Unhandled NPE / Server Error':
    'An unhandled exception reaches the caller: no useful error, possible stack disclosure, and an alert-generating 5xx for a client mistake.',
  'Idempotency / Concurrency':
    'A retried or concurrent request produces duplicate or interleaved state — double charges, double sends, or one user served another’s data.',
};

/** Shell-safe single-quoting for a curl argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A copy-pasteable `curl` for the exact request that produced the finding.
 *
 * This is the field a backend developer actually uses: it reproduces the defect without
 * installing the test suite, checking out the repo, or reading TypeScript. The Authorization
 * header is emitted as a placeholder rather than the live token — the report is committed.
 */
export function buildCurl(record: {
  method: string;
  endpointPath: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
}): string {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:9595';
  const parts = [`curl -i -X ${record.method.toUpperCase()} ${shellQuote(baseUrl + record.endpointPath)}`];

  for (const [key, value] of Object.entries(record.requestHeaders)) {
    const emitted = key.toLowerCase() === 'authorization' ? 'Bearer $KPOST_TOKEN' : value;
    parts.push(`  -H ${shellQuote(`${key}: ${emitted}`)}`);
  }

  if (record.requestBody !== undefined) {
    // Collapse the pretty-printed body: a multi-line -d argument is awkward to paste.
    let compact = record.requestBody;
    try {
      compact = JSON.stringify(JSON.parse(record.requestBody));
    } catch {
      compact = record.requestBody.replace(/\s*\n\s*/g, ' ');
    }
    parts.push(`  -d ${shellQuote(compact)}`);
  }

  return parts.join(' \\\n');
}

/**
 * Ownership is resolved from the spec-derived map rather than from URL-prefix guesses:
 * The Admin Module's routes do not follow their tag names — `Users, Onboarding &
 * Authentication` lives under `/userDetails`, `Product ↔ Employee Licensing` under
 * `/productEmployee`, and the four hierarchy tags share the `/attribute` and `/variable`
 * prefixes — so prefix matching mis-routes tickets.
 */
export function resolveModule(endpointPath: string): { module: string; team: string } {
  const exact = MODULE_BY_PATH[endpointPath];
  if (exact) return exact;

  // Path-parameter routes are recorded with a concrete value substituted in, so fall back
  // to matching the registry's `{param}` template against the concrete path.
  for (const [template, ownership] of Object.entries(MODULE_BY_PATH)) {
    if (!template.includes('{')) continue;
    const pattern = new RegExp(
      `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`
    );
    if (pattern.test(endpointPath)) return ownership;
  }

  /*
   * Third case: the finding recorded the route's **base** path with no parameter segment at
   * all. Specs build `META.path` from the path constant (`/userDetails/delete`)
   * and append the variable at call time, so neither an exact match nor the template match
   * above can succeed — the recorded path is a strict prefix of the template.
   *
   * Without this, every path-variable route reports as "Unclassified / Platform" and its
   * tickets route to nobody. That silently affected eight defects across the image-download
   * and device-OTP routes.
   */
  for (const [template, ownership] of Object.entries(MODULE_BY_PATH)) {
    if (!template.includes('{')) continue;
    const base = template.slice(0, template.indexOf('/{')).replace(/\/+$/, '');
    if (base && base === endpointPath.replace(/\/+$/, '')) return ownership;
  }

  return { module: 'Unclassified', team: 'Platform' };
}

/**
 * Content-derived id rather than a counter: workers are separate processes, so a counter
 * restarts per worker and mints duplicates. The hash is stable run-to-run, so a ticket raised
 * from BUG-API-3F2A91 still refers to the same defect next week — which is what makes the
 * Bugzilla summary-tag dedup in `dashboard-bugzilla.ts` work across re-runs.
 *
 * **Identity is the defect, not the test that found it.** An earlier revision mixed a per-test
 * `scopeKey` into this hash so the tracker would receive a ticket per failing case. On this API
 * that is the wrong unit: a handful of systemic backend faults are tripped by hundreds of cases
 * each, and the Bugzilla product reached 1283 open bugs describing a far smaller number of
 * actual defects — at which point the tracker stops being triageable. The scope key is gone;
 * every test that observes a defect now contributes an *occurrence* (see `recordOccurrence`)
 * and the reporter merges them into one record carrying the full affected-endpoint table.
 *
 * `dedupeKey` overrides the default `method + path + title` fingerprint, which is how a
 * systemic finding — one filter-chain fix, observed everywhere — collapses across endpoints as
 * well as across tests.
 */
/**
 * How aggressively findings collapse into one defect.
 *
 * - `fault` (default) — identity is the **fault**: classification + title, with the endpoint
 *   excluded. "Unauthenticated requests answered 400 instead of 401/403" is one defect whether
 *   227 routes exhibit it or one, because it is one auth filter and one fix.
 * - `endpoint` — identity additionally includes `METHOD /path`, so the same fault on two routes
 *   files two defects. Only explicitly systemic findings (those carrying a `dedupeKey`) still
 *   collapse.
 *
 * Measured against the 1283-entry ledger that motivated this: `fault` yields **565** defects,
 * `endpoint` yields **707**, and the pre-grouping behaviour yielded 1283.
 *
 * `fault` is the default because it is what a tracker actually wants — one ticket per thing a
 * developer fixes. It is the more aggressive setting, though, and the honest caveat is that a
 * shared *title* is not proof of a shared *fix*: "Response body violates the documented
 * contract" collapses 21 endpoints across 13 modules into one ticket, and those are 21
 * different response DTOs. The affected-endpoint table means nothing is lost either way, but if
 * triage finds tickets that cannot be actioned as a unit, set `KPOST_GROUPING=endpoint` and
 * re-file — the ids change, so treat that as a deliberate migration, not a toggle to flip
 * casually.
 */
export type GroupingMode = 'fault' | 'endpoint';

export function groupingMode(): GroupingMode {
  return process.env.KPOST_GROUPING === 'endpoint' ? 'endpoint' : 'fault';
}

function computeId(
  method: string,
  endpointPath: string,
  title: string,
  classification: FlawClassification,
  dedupeKey?: string
): string {
  const fingerprint =
    dedupeKey ??
    (groupingMode() === 'endpoint'
      ? `${method} ${endpointPath} :: ${classification} :: ${title}`
      : `${classification} :: ${title}`);
  const digest = crypto.createHash('sha1').update(fingerprint).digest('hex');
  return `BUG-API-${digest.slice(0, 6).toUpperCase()}`;
}

/**
 * The test currently executing, or null when `recordBug` is called outside a test — worker
 * fixture setup, or the safety-net reporter, which passes its own `testId` instead.
 *
 * Lazily required, exactly as `telemetry.ts` does it: importing the runner at module scope
 * would pull it into plain node scripts that import this file only to read the ledger.
 */
function currentTestId(): string | null {
  try {
    const { test } = require('@playwright/test') as typeof import('@playwright/test');
    return test.info().testId;
  } catch {
    return null;
  }
}

/** Where per-endpoint observations of a systemic defect accumulate, one file per endpoint. */
const SYSTEMIC_DIR = path.join(BUG_CACHE_DIR, 'systemic');

/**
 * Records that a systemic defect was observed on one more endpoint.
 *
 * The defect itself is filed once (see `dedupeKey`), but the ticket is far more actionable
 * when it can say *how much* of the API is affected — "observed on 240 endpoints" is what
 * turns a Low-severity header note into an obviously-worth-doing filter-chain change.
 *
 * Same atomic `wx` write as the coverage and defect caches, for the same reason: workers are
 * separate processes and read-then-append races.
 */
export function recordSystemicObservation(kind: string, endpointKey: string): void {
  const dir = path.join(SYSTEMIC_DIR, kind);
  const name = crypto.createHash('sha1').update(endpointKey).digest('hex').slice(0, 12);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ endpointKey }), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // Already recorded, by this worker or another.
  }
}

/** Every endpoint that exhibited a systemic defect this run, sorted for stable output. */
export function listSystemicObservations(kind: string): string[] {
  try {
    return fs
      .readdirSync(path.join(SYSTEMIC_DIR, kind))
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(SYSTEMIC_DIR, kind, f), 'utf-8')
          ) as { endpointKey: string };
          return parsed.endpointKey;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

const COVERAGE_DIR = path.join(ROOT, '.bug-cache', 'coverage');

export function resetBugLedger(): void {
  fs.rmSync(BUG_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  fs.writeFileSync(
    BUG_REPORT_PATH,
    '# KPOST Admin API — Automated Bug Report\n\n_Run in progress; this file is rewritten when the suite completes._\n',
    'utf-8'
  );
}

/**
 * Endpoints this worker has exercised. Kept in-process so each distinct endpoint costs one
 * filesystem write per worker rather than one per assertion.
 */
const seenEndpoints = new Set<string>();

/** Records that an endpoint was exercised, for the dashboard's coverage figure. */
export function recordEndpointExercised(method: string, endpointPath: string): void {
  const key = `${method} ${endpointPath}`;
  if (seenEndpoints.has(key)) return;
  seenEndpoints.add(key);

  const name = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  try {
    fs.mkdirSync(COVERAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(COVERAGE_DIR, `${name}.json`), JSON.stringify({ key }), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // Already recorded by another worker.
  }
}

/**
 * Distinct method+path pairs this run touched. Shared by both report formats.
 *
 * This counts **unique endpoints, not executions** — `recordEndpointExercised` keys on
 * `METHOD PATH` and writes one file per key with the exclusive `wx` flag, so an endpoint
 * covered by forty assertions still contributes one. Two tests hitting the same signature
 * therefore cannot inflate it.
 *
 * It legitimately exceeds the 112 operations in `api.json`, and that is not double
 * counting: the verb-binding cases deliberately drive `PUT`/`DELETE`/`PATCH` at paths the
 * spec documents only for `GET` or `POST`, to prove a bare `@RequestMapping` is not answering
 * verbs it should refuse. Each of those is a genuinely distinct method+path pair, and an
 * *undocumented* one — which is exactly why it is worth probing. `countDocumentedEndpoints`
 * below separates the two so the dashboard can report coverage against the spec rather than a
 * raw total that looks like over-counting.
 */
export function countExercisedEndpoints(): number {
  try {
    return fs.readdirSync(COVERAGE_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** Every `METHOD PATH` key recorded this run, for callers that need the set rather than a count. */
export function listExercisedEndpoints(): string[] {
  try {
    return fs
      .readdirSync(COVERAGE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(COVERAGE_DIR, f), 'utf-8')) as { key: string })
            .key;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

const AUTH_STRATEGY_FILE = path.join(BUG_CACHE_DIR, 'auth-strategy.txt');

/**
 * Workers are separate processes from the reporter, so the resolved auth strategy is
 * handed over through the cache directory rather than an environment variable.
 */
export function recordAuthStrategy(summary: string): void {
  try {
    fs.mkdirSync(BUG_CACHE_DIR, { recursive: true });
    fs.writeFileSync(AUTH_STRATEGY_FILE, summary, { flag: 'wx', encoding: 'utf-8' });
  } catch {
    // First worker to resolve a session wins.
  }
}

export function readAuthStrategy(): string {
  try {
    return fs.readFileSync(AUTH_STRATEGY_FILE, 'utf-8');
  } catch {
    return 'unresolved — see run log';
  }
}

/** Where per-defect occurrences accumulate: `occurrences/<bug id>/<observation>.json`. */
const OCCURRENCE_DIR = path.join(BUG_CACHE_DIR, 'occurrences');

/**
 * At most this many distinct observed behaviours are quoted in a grouped ticket.
 *
 * Three is enough to show that a defect is not uniform — a route answering 400 on one path and
 * 500 on another is worth seeing — while keeping the ticket readable. The *complete* endpoint
 * list is never truncated in `BUG_REPORT.json`; only the prose evidence is bounded, and only
 * distinct `actual` strings count toward the cap, so forty identical observations still spend
 * one slot.
 */
export const MAX_EVIDENCE_SAMPLES = 3;

/**
 * Records that a defect was observed once more, at a particular endpoint, by a particular test.
 *
 * Same atomic `wx` write as every other cross-worker cache here, and for the same reason:
 * workers are separate processes, so read-then-append races and loses observations. The key is
 * `(endpoint, test)` so a single test asserting the same defect twice on one endpoint counts
 * once — occurrences measure how much of the *suite* and *surface* a defect touches, not how
 * many assertion calls were made.
 */
function recordOccurrence(id: string, occurrence: BugOccurrence): void {
  const dir = path.join(OCCURRENCE_DIR, id);
  const key = `${occurrence.method} ${occurrence.endpointPath} @@ ${occurrence.testId ?? 'session'}`;
  const name = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(occurrence), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // Already recorded, by this worker or another.
  }
}

/** Every occurrence recorded against a defect this run. */
export function listOccurrences(id: string): BugOccurrence[] {
  const dir = path.join(OCCURRENCE_DIR, id);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out: BugOccurrence[] = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as BugOccurrence);
    } catch {
      // Skip a partially written observation rather than losing the group.
    }
  }
  return out;
}

/**
 * Records a defect — **one entry per distinct defect**, however many tests trip over it.
 *
 * Identity is the content fingerprint (see `computeId`), so the first test to observe a fault
 * writes the canonical record and every later observer is deduplicated by the exclusive `wx`
 * create. What the later observers *do* contribute is an occurrence: which endpoint, which
 * test, what the API actually did. `compileGrouping` merges those in the reporter process,
 * where every worker has finished — workers never mutate a shared file.
 *
 * Returns the defect id, which is stable across runs.
 */
export function recordBug(input: BugInput): string {
  const testId = input.testId ?? currentTestId();
  // `identityTitle` (when set) pins the id to a stable fingerprint while `title` stays free to
  // reword — see BugInput.identityTitle. It never reaches the stored record; strip it below.
  const { identityTitle, ...rest } = input;
  const id = computeId(
    rest.method,
    rest.endpointPath,
    identityTitle ?? rest.title,
    rest.classification,
    rest.dedupeKey
  );
  const resolved = resolveModule(rest.endpointPath);
  const module = rest.module || resolved.module;
  const owner = rest.owner ?? `Backend Dev - ${resolved.team} Team`;

  const record: BugRecord = {
    ...rest,
    testId: testId ?? undefined,
    id,
    module,
    owner,
    priority: rest.priority ?? PRIORITY_BY_SEVERITY[rest.severity],
    category: rest.category ?? deriveCategory(rest.classification, rest.title, rest.description),
    riskImpact: rest.riskImpact ?? RISK_BY_CLASSIFICATION[rest.classification],
    curlSnippet: buildCurl(rest),
  };

  try {
    fs.mkdirSync(BUG_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), JSON.stringify(record), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // 'wx' failed because this defect is already on the ledger — expected, and the whole point.
  }

  recordOccurrence(id, {
    method: input.method,
    endpointPath: input.endpointPath,
    module,
    owner,
    testId: testId ?? undefined,
    actual: input.actual,
    at: new Date().toISOString(),
  });

  return id;
}

const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, Major: 1, Minor: 2, Trivial: 3 };

/**
 * How central each module is to the product, used **only to order the ledger** — never shown,
 * never tagged, never a classification axis (that is severity + category). It answers one
 * question: when two defects share a severity, which does a reader see first?
 *
 * The ranking follows what the Admin Module cannot operate without: identity and onboarding
 * first (a breach or a lockout here costs a tenant its administrators), then the employee and
 * org-structure master data every other module reads by foreign key, then the hierarchy
 * definitions built on top of it, then licensing and commercial surfaces, then pure reference
 * data. A module not listed ranks at the boundary between core and platform (50) — visible,
 * not buried, pending a human placing it.
 *
 * This is an invisible sort key, not a classification axis. Severity still decides the band;
 * this only decides order within it, so the most business-critical Critical defect — a
 * tenant-isolation or onboarding showstopper — sits at the very top of the P0 list.
 *
 * The names are the Swagger tags in `moduleOwnership.generated.ts`; regenerating that file
 * after an API change is what keeps this list honest, and an added tag simply ranks 50 until
 * someone places it.
 */
const COMPONENT_CRITICALITY: Readonly<Record<string, number>> = {
  // identity, onboarding & tenant administration — a breach or lockout here is existential
  'Users, Onboarding & Authentication': 0,
  'Admin Details': 1,
  // employee & org-structure master data — every other module joins to these records
  'Employee Master Data': 10,
  'Employee ↔ Role Posting Mapping': 11,
  'Role Postings': 12,
  Departments: 13,
  Designations: 14,
  'Workplace Locations': 15,
  // hierarchy definitions built on top of the master data
  'Workplace Hierarchy Links': 20,
  'Workplace Tier — Attributes (Levels)': 21,
  'Workplace Tier — Variables (Nodes)': 22,
  'Generic Attributes (Base Hierarchy Levels)': 23,
  'Generic Variables (Base Hierarchy Nodes)': 24,
  'HR Tier — Levels': 25,
  'HR Tier — Variables (Nodes)': 26,
  'HR Set-Up Tier — Levels': 27,
  'HR Set-Up Tier — Variables (Nodes)': 28,
  // licensing & commercial surfaces
  'Product Subscriptions': 40,
  'Product ↔ Employee Licensing': 41,
  'Product Catalogue': 42,
  'Project Catalogue': 43,
  'Product Demo Requests': 44,
  // scheduling & reference data read by, but not owned by, the modules above
  'Holiday Calendar': 60,
  'Country & Address Reference Data': 61,
  'admin-module-application': 70,
};

/** Lower ranks first; unknown modules sit between core and platform so they stay visible. */
function componentRank(module: string): number {
  return COMPONENT_CRITICALITY[module] ?? 50;
}

/**
 * Every finding recorded so far, **grouped** — one record per distinct defect, carrying its
 * occurrence count and affected-endpoint table.
 *
 * Exported so the TestBench HTML reporter can render the same ledger the Markdown report is
 * compiled from — both read the cache, neither owns it. Grouping is applied here rather than
 * in `writeReport` so every consumer sees the same shape; `run-model.ts` runs first (reporter
 * order is load-bearing) and would otherwise render an ungrouped view of the same run.
 */
export function readBugLedger(): BugRecord[] {
  const records = readRawBugLedger();
  compileGrouping(records);
  return records;
}

/** The ledger exactly as the workers wrote it, before occurrences are merged in. */
export function readRawBugLedger(): BugRecord[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(BUG_CACHE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const records: BugRecord[] = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(BUG_CACHE_DIR, file), 'utf-8')));
    } catch {
      // Skip a partially written record rather than losing the entire report.
    }
  }
  return records;
}

function formatHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (entries.length === 0) return '`(none)`';
  return entries.map(([k, v]) => `\`${k}: ${v}\``).join(', ');
}

/**
 * How many affected endpoints are listed inline in the Markdown ticket before it defers to
 * `BUG_REPORT.json`. A systemic defect can span the whole surface, and a 240-row table inside
 * every one of forty tickets makes the ledger unreadable; the JSON twin always carries all of
 * them, and the count in the header always states the true total.
 */
const MAX_ENDPOINTS_IN_MARKDOWN = 25;

function renderAffectedEndpoints(record: BugRecord): string {
  const affected = record.affectedEndpoints ?? [];
  if (affected.length <= 1) return '';

  const shown = affected.slice(0, MAX_ENDPOINTS_IN_MARKDOWN);
  const remainder = affected.length - shown.length;
  const rows = shown
    .map((e) => `  | \`${e.method} ${e.endpointPath}\` | ${e.module} | ${e.occurrences} |`)
    .join('\n');

  const multiModule =
    (record.affectedModules?.length ?? 0) > 1
      ? `\n\n  > Spans ${record.affectedModules?.length} modules (${record.affectedModules?.join(', ')}). ` +
        `Routed to **${record.module}**, which holds the most affected endpoints — the fix is one change, ` +
        'so the other owners are named here rather than being sent their own copy of this ticket.'
      : '';

  return `
- **Affected Endpoints (${affected.length}):**

  | Endpoint | Module | Occurrences |
  | --- | --- | --- |
${rows}${remainder > 0 ? `\n  | _…and ${remainder} more — see \`BUG_REPORT.json\`_ | | |` : ''}${multiModule}
`;
}

function renderEvidence(record: BugRecord): string {
  const samples = record.evidenceSamples ?? [];
  // One sample is just `actual`, which the ticket already prints on its own line.
  if (samples.length <= 1) return '';

  const rows = samples
    .map((s) => `  - \`${s.method} ${s.endpointPath}\` → ${s.actual}`)
    .join('\n');
  return `- **Observed variations (${samples.length} distinct):**\n${rows}\n`;
}

function renderBug(record: BugRecord): string {
  const bodyBlock = record.requestBody
    ? `\n     \`\`\`json\n${record.requestBody
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n')}\n     \`\`\``
    : ' _(no request body)_';

  return `---

### [${record.displayId ?? record.id}] ${record.title}

- **Bug ID:** \`${record.displayId ?? record.id}\` &nbsp;·&nbsp; **Content hash:** \`${record.id}\`
- **Severity:** ${record.severity} (${record.priority}) &nbsp;·&nbsp; **Category:** ${record.category}
- **Occurrences:** ${record.occurrences ?? 1} test case${(record.occurrences ?? 1) === 1 ? '' : 's'} across ${record.affectedEndpoints?.length ?? 1} endpoint${(record.affectedEndpoints?.length ?? 1) === 1 ? '' : 's'}
- **Module / Controller:** ${record.module}
- **Suggested Owner:** ${record.owner}
- **Representative Endpoint:** \`${record.method} ${record.endpointPath}\`
- **Flaw Classification:** ${record.classification}
- **Description:** ${record.description}${record.scope ? `\n- **Scope:** ${record.scope}` : ''}
- **System Risk Impact:** ${record.riskImpact}
${renderAffectedEndpoints(record)}${renderEvidence(record)}- **Steps to Reproduce:**
  1. Send \`${record.method}\` request to \`${record.endpointPath}\`
  2. Headers: ${formatHeaders(record.requestHeaders)}
  3. Request Body:${bodyBlock}
- **Expected Behavior:** ${record.expected}
- **Actual Behavior:** ${record.actual}
- **Reproduce with curl:**

  \`\`\`bash
${record.curlSnippet
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
  \`\`\`

- **Reproduce with Playwright:**

  \`\`\`typescript
${record.reproSnippet
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
  \`\`\`
`;
}

function countBy<T extends string>(records: BugRecord[], key: (r: BugRecord) => T): Map<T, number> {
  const counts = new Map<T, number>();
  for (const record of records) {
    const value = key(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function renderDashboard(records: BugRecord[], meta: RunMeta): string {
  const bySeverity = countBy(records, (r) => r.severity);
  const byModule = [...countBy(records, (r) => r.module).entries()].sort((a, b) => b[1] - a[1]);
  const byClass = [...countBy(records, (r) => r.classification).entries()].sort(
    (a, b) => b[1] - a[1]
  );

  const byPriority = countBy(records, (r) => r.priority);
  const byOwner = [...countBy(records, (r) => r.owner).entries()].sort((a, b) => b[1] - a[1]);

  const byCategory = countBy(records, (r) => r.category);

  const critical = bySeverity.get('Critical') ?? 0;
  const major = bySeverity.get('Major') ?? 0;
  const minor = bySeverity.get('Minor') ?? 0;
  const trivial = bySeverity.get('Trivial') ?? 0;

  /*
   * Occurrences vs. defects is the headline number this report exists to keep honest. The
   * suite trips a handful of systemic backend faults hundreds of times each; reporting the
   * raw count made the tracker unusable. Both figures are printed so a reader can see the
   * grouping working rather than having to trust it.
   */
  const totalOccurrences = records.reduce((sum, r) => sum + (r.occurrences ?? 1), 0);

  /* Severity down the rows, category across the columns — the triage view. */
  const matrixRows = (['Critical', 'Major', 'Minor', 'Trivial'] as Severity[])
    .map((severity) => {
      const cells = BUG_CATEGORIES.map(
        (category) =>
          records.filter((r) => r.severity === severity && r.category === category).length
      );
      return `| ${severity} | ${cells.join(' | ')} | **${bySeverity.get(severity) ?? 0}** |`;
    })
    .join('\n');

  /*
   * "No defects" and "nothing was checked" are opposite findings that produce identical
   * ledgers, so the test count has to be consulted before any verdict is given. A run that
   * executed zero tests previously rendered as "**CLEAN** — no deviations detected", which is
   * how a total collapse of the bench came to read as a healthy API.
   */
  const verdict =
    meta.totalTests === 0
      ? '**RUN INVALID** — zero tests executed, so nothing was checked. This is not a clean result: the suite did not run. See the run log for spec load errors, and `reports/run-validity.json` for the rejection reason.'
      : critical > 0
        ? '**DO NOT SHIP** — critical defects (auth bypass, injection, or data exposure) are open.'
        : major > 0
          ? '**SHIP AT RISK** — no critical defects, but contract and validation gaps remain.'
          : records.length > 0
            ? '**ACCEPTABLE** — only cosmetic contract deviations recorded.'
            : '**CLEAN** — no deviations detected in this run.';

  return `# KPOST Admin API — Automated Bug Report

> Generated by the KPOST Admin API Test Bench on ${meta.generatedAt}.
> **This file is generated — do not edit by hand.** Re-run \`npm test\` to regenerate.

## Executive Summary Dashboard

| Metric | Value |
| --- | --- |
| Report generated | ${meta.generatedAt} |
| Target environment | \`${meta.baseURL}\` |
| Tests executed | ${meta.totalTests} |
| Passed / Failed / Skipped | ${meta.passed} / ${meta.failed} / ${meta.skipped} |
| Endpoints exercised | ${meta.endpointsExercised} |
| Run duration | ${meta.durationSeconds}s |
| Authentication | ${meta.authStrategy} |

### Classification by Severity

| Severity | Priority | Count | Meaning |
| --- | --- | --- | --- |
| Critical | P0 · Showstopper | ${critical} | ${SEVERITY_MEANING.Critical} |
| Major | P1 | ${major} | ${SEVERITY_MEANING.Major} |
| Minor | P2 | ${minor} | ${SEVERITY_MEANING.Minor} |
| Trivial / Cosmetic | P3 | ${trivial} | ${SEVERITY_MEANING.Trivial} |
| **Total distinct defects** | | **${records.length}** | grouped from ${totalOccurrences} observation${totalOccurrences === 1 ? '' : 's'} |

> **Distinct defects, not failing tests.** One backend fault is tripped by many cases here, so
> each entry below is a single root cause with its full affected-endpoint table. The
> ${totalOccurrences} observations this run collapse to ${records.length} defect${records.length === 1 ? '' : 's'}.
> Grouping mode: \`${groupingMode()}\` — ${
    groupingMode() === 'fault'
      ? 'identity is the fault (classification + title), so the same fault on many endpoints is one ticket carrying all of them'
      : 'identity includes the endpoint, so the same fault on two routes files two tickets'
  }.

### Classification by Type

| Category | Count | Meaning |
| --- | --- | --- |
${BUG_CATEGORIES.map((c) => `| ${c} | ${byCategory.get(c) ?? 0} | ${CATEGORY_MEANING[c]} |`).join('\n')}

### Severity × Category

| Severity ╲ Category | ${BUG_CATEGORIES.join(' | ')} | Total |
| --- | ${BUG_CATEGORIES.map(() => '---').join(' | ')} | --- |
${matrixRows}

### Defect Counts by Priority

| Priority | Count | Meaning |
| --- | --- | --- |
${(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((p) => `| ${p} | ${byPriority.get(p) ?? 0} | ${PRIORITY_MEANING[p]} |`).join('\n')}

### Release Verdict

${verdict}

### 🚩 Showstoppers — Critical (P0), fix before anything else

${
    critical === 0
      ? '_None. No Critical / P0 defects in this run._'
      : `The ${critical} defect${critical === 1 ? '' : 's'} below ${critical === 1 ? 'is a' : 'are'} showstopper${critical === 1 ? '' : 's'} — a crash, data loss, exposure, or accepted-and-persisted bad input — ordered by how central the affected module is to the product. These block release.

| ID | Category | Module | Representative Endpoint | Title |
| --- | --- | --- | --- | --- |
${records
          .filter((r) => r.severity === 'Critical')
          .map(
            (r) =>
              `| ${r.displayId ?? r.id} | ${r.category} | ${r.module} | \`${r.method} ${r.endpointPath}\` | ${r.title} |`
          )
          .join('\n')}`
  }

### Defects by Module

| Module / Controller | Defects |
| --- | --- |
${byModule.map(([m, c]) => `| ${m} | ${c} |`).join('\n') || '| _none_ | 0 |'}

### Defects by Assigned Owner

| Owner | Defects |
| --- | --- |
${byOwner.map(([o, c]) => `| ${o} | ${c} |`).join('\n') || '| _none_ | 0 |'}

### Defects by Flaw Classification

| Classification | Defects |
| --- | --- |
${byClass.map(([c, n]) => `| ${c} | ${n} |`).join('\n') || '| _none_ | 0 |'}

### Bug Index

| ID | Severity | Priority | Category | Endpoints | Occurrences | Owner | Title |
| --- | --- | --- | --- | --- | --- | --- | --- |
${
    records
      .map(
        (r) =>
          `| ${r.displayId ?? r.id} | ${r.severity} | ${r.priority} | ${r.category} | ${r.affectedEndpoints?.length ?? 1} | ${r.occurrences ?? 1} | ${r.owner} | ${r.title} |`
      )
      .join('\n') || '| _none_ | — | — | — | — | — | — | — |'
  }

## Itemized Bug Ledger

`;
}

export interface RunMeta {
  generatedAt: string;
  baseURL: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationSeconds: number;
  endpointsExercised: number;
  authStrategy: string;
}

export type RunStats = Omit<RunMeta, 'endpointsExercised'>;

/** Compiles every recorded finding into the final report. Called by the bug reporter. */
export function compileBugReport(stats: RunStats): void {
  const meta: RunMeta = { ...stats, endpointsExercised: countExercisedEndpoints() };
  writeReport(meta);
}

/**
 * Turns a module name into the short token used in a display id: "Users, Onboarding &
 * Authentication" → "USERS", "Workplace Locations" → "WORKPLAC". First alphanumeric word, capped at 8
 * characters so the label stays scannable in a table.
 */
function moduleToken(module: string): string {
  const word = module.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)[0] ?? 'API';
  return word.slice(0, 8).toUpperCase() || 'API';
}

/**
 * Assigns `BUG-<MODULE>-NNN` labels.
 *
 * Safe here and only here: this runs in the reporter, a single process, after every worker
 * has finished writing to the cache. The counter restarts per module and follows the sorted
 * order, so the same run always produces the same labels — but the label is *display only*.
 * `id` (the content hash) remains identity for deduplication and tracker matching, because a
 * positional number changes the moment a defect above it is fixed.
 */
function assignDisplayIds(records: BugRecord[]): void {
  const counters = new Map<string, number>();
  for (const record of records) {
    const token = moduleToken(record.module);
    const next = (counters.get(token) ?? 0) + 1;
    counters.set(token, next);
    record.displayId = `BUG-${token}-${String(next).padStart(3, '0')}`;
  }
}

/**
 * Merges each defect's occurrence files into the record, in the reporter process.
 *
 * This is the compile-time half of grouping. Workers write immutable one-shot observations;
 * nothing aggregates until here, after every worker has exited, which is what keeps the
 * cross-process story race-free without a lock.
 *
 * **Ownership on a multi-module defect.** A systemic fault legitimately spans several owning
 * teams — a missing auth filter shows up under Auth, Profile and Groups at once. The ticket is
 * routed to the module with the most affected endpoints, with every other module named in
 * `affectedModules` and in the report's scope line, because a ticket addressed to everyone is
 * addressed to no one. Ties break on the module name so the choice is deterministic across
 * runs rather than following filesystem order. The representative endpoint stays whatever the
 * canonical record captured, so its curl and repro snippet remain a real, runnable request.
 */
export function compileGrouping(records: BugRecord[]): void {
  for (const record of records) {
    const occurrences = listOccurrences(record.id);

    if (occurrences.length === 0) {
      /*
       * No occurrence files: a record read from a ledger written before grouping existed, or a
       * hand-constructed one in a test. Present it as a group of one rather than leaving the
       * fields undefined, so every consumer can read `occurrences` unconditionally.
       */
      record.occurrences = 1;
      record.affectedEndpoints = [
        {
          method: record.method,
          endpointPath: record.endpointPath,
          module: record.module,
          owner: record.owner,
          occurrences: 1,
        },
      ];
      record.affectedModules = [record.module];
      record.observedByTests = record.testId ? [record.testId] : [];
      record.evidenceSamples = [
        { method: record.method, endpointPath: record.endpointPath, actual: record.actual },
      ];
      continue;
    }

    const byEndpoint = new Map<string, AffectedEndpoint>();
    const tests = new Set<string>();
    const timestamps: string[] = [];
    const distinctActuals = new Map<string, { method: string; endpointPath: string; actual: string }>();

    for (const occurrence of occurrences) {
      const key = `${occurrence.method} ${occurrence.endpointPath}`;
      const existing = byEndpoint.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else {
        byEndpoint.set(key, {
          method: occurrence.method,
          endpointPath: occurrence.endpointPath,
          module: occurrence.module,
          owner: occurrence.owner,
          occurrences: 1,
        });
      }

      if (occurrence.testId) tests.add(occurrence.testId);
      if (occurrence.at) timestamps.push(occurrence.at);
      if (!distinctActuals.has(occurrence.actual)) {
        distinctActuals.set(occurrence.actual, {
          method: occurrence.method,
          endpointPath: occurrence.endpointPath,
          actual: occurrence.actual,
        });
      }
    }

    const affected = [...byEndpoint.values()].sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        a.endpointPath.localeCompare(b.endpointPath) ||
        a.method.localeCompare(b.method)
    );

    const moduleWeight = new Map<string, number>();
    for (const endpoint of affected) {
      moduleWeight.set(endpoint.module, (moduleWeight.get(endpoint.module) ?? 0) + endpoint.occurrences);
    }
    const modulesByWeight = [...moduleWeight.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );

    record.occurrences = occurrences.length;
    record.affectedEndpoints = affected;
    record.affectedModules = modulesByWeight.map(([name]) => name);
    record.observedByTests = [...tests].sort();
    timestamps.sort();
    record.firstSeen = timestamps[0];
    record.lastSeen = timestamps[timestamps.length - 1];
    record.evidenceSamples = [...distinctActuals.values()].slice(0, MAX_EVIDENCE_SAMPLES);

    /*
     * Re-route only when grouping actually revealed a different owner. The canonical record was
     * filed by whichever test happened to run first, so on a systemic defect its module is an
     * accident of scheduling; the weighted winner is not.
     */
    const dominant = modulesByWeight[0]?.[0];
    if (dominant && dominant !== record.module) {
      const owningEndpoint = affected.find((endpoint) => endpoint.module === dominant);
      record.module = dominant;
      if (owningEndpoint) record.owner = owningEndpoint.owner;
    }
  }
}

function writeReport(meta: RunMeta): void {
  const records = readBugLedger().sort((a, b) => {
    // Severity first (impact decides the band), then how central the affected module is to
    // the product, so the most business-critical defect in a band — an auth or payment
    // showstopper — sits at the top. Occurrences break a further tie so a widespread fault
    // outranks a one-off, then path/title for a fully determined, stable order.
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byComponent = componentRank(a.module) - componentRank(b.module);
    if (byComponent !== 0) return byComponent;
    const byOccurrences = (b.occurrences ?? 1) - (a.occurrences ?? 1);
    if (byOccurrences !== 0) return byOccurrences;
    const byPath = a.endpointPath.localeCompare(b.endpointPath);
    return byPath !== 0 ? byPath : a.title.localeCompare(b.title);
  });

  /*
   * Systemic findings are filed once but observed many times. Their blast radius is only
   * knowable here, in the reporter, after every worker has finished contributing to the
   * observation buckets — so the scope line is attached at compile time rather than being
   * guessed by whichever worker happened to file the defect first.
   */
  for (const record of records) {
    if (!record.systemicKind) continue;
    const observed = listSystemicObservations(record.systemicKind);
    if (observed.length === 0) continue;
    const sample = observed.slice(0, 5).join(', ');
    record.scope =
      `Observed on ${observed.length} endpoint${observed.length === 1 ? '' : 's'} this run` +
      `${observed.length > 5 ? `, including: ${sample}, …` : `: ${sample}`}. ` +
      'Filed as one defect because it has one root cause and one fix.';
  }

  assignDisplayIds(records);

  const body =
    records.length === 0
      ? '_No defects were recorded in this run._\n'
      : records.map(renderBug).join('\n');

  fs.writeFileSync(BUG_REPORT_PATH, `${renderDashboard(records, meta)}${body}`, 'utf-8');

  /*
   * The machine-readable twin of the Markdown report.
   *
   * Same records, same ids, no rendering — so a CI job, a tracker importer or a dashboard can
   * consume the run without parsing Markdown. Written next to BUG_REPORT.md rather than under
   * reports/ because the two are a pair and reviewers expect to find them together.
   */
  const jsonReport = {
    generatedAt: meta.generatedAt,
    /*
     * The short label — `Local` / `QA` / `Staging` / `Production`, with `TEST_ENV` overriding —
     * resolved by the same helper the executive report uses.
     *
     * This field previously carried the raw `baseURL`, which the QA Dashboard rendered
     * verbatim in its Env column, and which grouped two runs against one environment
     * separately whenever the hostname differed. The URL is still published, as `baseURL`
     * below, because a reader triaging a defect needs to know exactly which host answered.
     */
    environment: environmentName(meta.baseURL),
    baseURL: meta.baseURL,
    run: {
      totalTests: meta.totalTests,
      passed: meta.passed,
      failed: meta.failed,
      skipped: meta.skipped,
      durationSeconds: meta.durationSeconds,
      endpointsExercised: meta.endpointsExercised,
      authStrategy: meta.authStrategy,
    },
    /**
     * Bumped when the defect shape changes in a way a consumer must notice. `2` introduced
     * grouping (`occurrences`, `affectedEndpoints`) and the `Minor`/`Trivial` severity names
     * in place of `Medium`/`Low`, plus the `category` axis. A reader that does not check this
     * field and assumes `total` counts failing tests will under-report by roughly an order of
     * magnitude on this API.
     */
    schemaVersion: 2,
    /** How findings were collapsed into defects — `fault` or `endpoint`. See `groupingMode`. */
    grouping: groupingMode(),
    summary: {
      /** Distinct defects. */
      total: records.length,
      /** Individual observations across all tests and endpoints, before grouping. */
      totalOccurrences: records.reduce((sum, r) => sum + (r.occurrences ?? 1), 0),
      /** Distinct endpoints touched by at least one defect. */
      affectedEndpointCount: new Set(
        records.flatMap((r) =>
          (r.affectedEndpoints ?? [{ method: r.method, endpointPath: r.endpointPath }]).map(
            (e) => `${e.method} ${e.endpointPath}`
          )
        )
      ).size,
      bySeverity: tally(records, (r) => r.severity),
      byPriority: tally(records, (r) => r.priority),
      byCategory: tally(records, (r) => r.category),
      byModule: tally(records, (r) => r.module),
      byOwner: tally(records, (r) => r.owner),
      byClassification: tally(records, (r) => r.classification),
    },
    defects: records,
  };
  fs.writeFileSync(BUG_REPORT_JSON_PATH, `${JSON.stringify(jsonReport, null, 2)}\n`, 'utf-8');

  fs.rmSync(BUG_CACHE_DIR, { recursive: true, force: true });
}

function tally(records: BugRecord[], key: (r: BugRecord) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const value = key(record);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}
