import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { Reporter } from '@playwright/test/reporter';
import { publishingGate } from './run-validity';

// Loaded for free during a real Playwright run (playwright.config.ts pulls in env.config.ts,
// which calls dotenv.config() before any reporter runs). This call only matters for the
// `require.main === module` standalone path below, mirroring dispatch-bugs-to-tracker.ts.
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Files this bench's defects into Bugzilla — a pure REST-API producer, never a database
 * client. Mirrors `dashboard-ingest.ts`: a plain async function that does the work, a thin
 * `Reporter` wrapper for `onEnd`, and nothing here can change the run's exit code.
 *
 * **Must run after** `src/reporters/bugReporter.ts` — it reads the same `BUG_REPORT.json`
 * that reporter writes in its own `onEnd`, so it is registered at the tail of
 * `playwright.config.ts`'s reporter array, alongside `dashboard-ingest.ts`.
 *
 * Dedup is a *live* Bugzilla search, not a local ledger (unlike
 * `dispatch-bugs-to-tracker.ts`'s `reports/dispatched-bugs.json`): each defect's id is tagged
 * into the bug summary as `[BUG-API-XXXXXX]`, and a run first searches for an open bug
 * carrying that tag before deciding to create or comment. That is also what makes re-running
 * this reporter a safe way to prove dedup — a second run against the same `BUG_REPORT.json`
 * should create nothing and only add "observed again" comments.
 *
 * Assignment is deliberately NOT set (`assigned_to` is omitted from every create call) — the
 * Bugzilla component's own default assignee handles it. Setting it here would require this
 * bench to know Bugzilla's user directory, which it doesn't and shouldn't.
 */

const TIMEOUT_MS = 15_000;
const LOG = '[bugzilla]';

/* ------------------------------------------------------------------ config */

export interface BugzillaConfig {
  /** No trailing slash. */
  url: string;
  apiKey: string;
  product: string;
  version: string;
  dryRun: boolean;
  /**
   * Whether this reporter should mint the `KPA-###` alias itself.
   *
   * Off by default, because the instance at 192.168.0.50 already assigns an alias on
   * create — verified 2026-08-17 by creating a bug with no alias and reading back `KPA-037`.
   * Where the server does that, a client-chosen alias can only ever collide with the server's
   * own numbering: an entire run of 818 defects failed on `Duplicate entry 'KPA-001'` because
   * every lookup saw no bugs it had permission to read, computed max=0, and asked for an alias
   * that was already spoken for.
   *
   * Turn it on (`BUGZILLA_CLIENT_ALIAS=true`) only for an instance that does *not* assign one.
   */
  clientAlias: boolean;
  /**
   * Component used when a defect's module has no component of that name in the product.
   *
   * `bugTracker` falls back to the module `Unclassified` for any endpoint outside
   * `MODULE_BY_PATH` — and Bugzilla refuses the create outright: *"There is no component named
   * 'Unclassified' in the 'KPost Admin' product."* Those tickets were silently lost while the QA
   * Dashboard, which validates nothing, still counted them, so the two systems disagreed on
   * how many defects the run found.
   */
  fallbackComponent: string;
  /**
   * Process at most this many defects from the ledger. `0` means no cap.
   *
   * Filing is irreversible — Bugzilla's REST API has no delete, only resolve — so committing a
   * four-figure ledger to it on faith is a one-way door. A cap makes the first pass a staged
   * rollout: file a handful, inspect them, then run the filer again and confirm it *comments*
   * rather than creating duplicates before lifting the cap.
   *
   * It slices the defect list rather than counting creates, so a second capped run revisits
   * exactly the same defects — which is what makes the dedup check meaningful.
   */
  maxFile: number;
  /**
   * Prefix for a client-minted alias, used only when `clientAlias` is on.
   *
   * Per-bench, because the shared instance at 192.168.0.50 holds one product per bench and an
   * alias is unique across the *whole* instance, not per product — `KPA-001` filed by the API
   * bench would refuse `KPA-001` here. `KAD` is this bench's.
   */
  aliasPrefix: string;
}

export function readBugzillaConfig(): { config: BugzillaConfig } | { skip: string } {
  const url = process.env.BUGZILLA_URL;
  const apiKey = process.env.BUGZILLA_API_KEY;

  // Both-or-neither, exactly like DASHBOARD_INGEST_URL/DASHBOARD_API_KEY: unset is a decision
  // most benches will make, not a fault.
  if (!url || !apiKey) {
    const missing = !url ? 'BUGZILLA_URL' : 'BUGZILLA_API_KEY';
    return { skip: `${missing} not configured` };
  }

  return {
    config: {
      url: url.replace(/\/+$/, ''),
      apiKey,
      product: process.env.BUGZILLA_PRODUCT || 'KPost Admin',
      version: process.env.BUGZILLA_VERSION || 'unspecified',
      dryRun: process.env.BUGZILLA_DRY_RUN === 'true',
      clientAlias: process.env.BUGZILLA_CLIENT_ALIAS === 'true',
      fallbackComponent: process.env.BUGZILLA_FALLBACK_COMPONENT || 'admin-module-application',
      aliasPrefix: (process.env.BUGZILLA_ALIAS_PREFIX || 'KAD').toUpperCase(),
      maxFile: Math.max(0, Number.parseInt(process.env.BUGZILLA_MAX_FILE ?? '', 10) || 0),
    },
  };
}

/* ------------------------------------------------------------------ input contract */

export interface Defect {
  id: string;
  title: string;
  severity: 'Critical' | 'Major' | 'Minor' | 'Trivial';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** The defect-type axis, orthogonal to severity. Absent on a pre-v2 ledger. */
  category?: 'Functional' | 'Performance' | 'Security' | 'Compatibility';
  module: string;
  method: string;
  endpointPath: string;
  classification: string;
  description: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  expected: string;
  actual: string;
  reproSnippet?: string;
  curlSnippet?: string;
  owner: string;
  /* --------------------------------------------------------------- grouping
   * A defect is one root cause, however many tests and endpoints exhibit it. These carry the
   * blast radius into the ticket so a single grouped bug is more actionable than the hundreds
   * of per-test bugs it replaces. Optional because a ledger written before grouping existed
   * does not have them.
   */
  occurrences?: number;
  affectedEndpoints?: Array<{
    method: string;
    endpointPath: string;
    module: string;
    occurrences: number;
  }>;
  affectedModules?: string[];
  evidenceSamples?: Array<{ method: string; endpointPath: string; actual: string }>;
}

export interface BugReportFile {
  generatedAt: string;
  environment: string;
  baseURL: string;
  defects: Defect[];
}

/*
 * Confirmed 2026-08-13 against the live instance (http://192.168.0.50/bugzilla/rest):
 *   GET /rest/field/bug/bug_severity -> blocker, critical, major, normal, minor, trivial,
 *     enhancement (the `severity` create-parameter takes one of these values; the field's
 *     own REST name is `bug_severity`, not `severity` - that only matters for this metadata
 *     lookup, not for Bug.create).
 *   GET /rest/field/bug/priority -> Highest, High, Normal, Low, Lowest, --- .
 */
/**
 * Our four bands onto Bugzilla's seven.
 *
 * `blocker` is deliberately left unused: Bugzilla's own convention reserves it for "blocks
 * development or testing work", which is a statement about *our* pipeline, not about the
 * product under test. Every defect this bench files is a product defect, so the top band it
 * can legitimately claim is `critical`. `enhancement` is likewise never emitted — nothing here
 * is a feature request.
 */
export const SEVERITY_MAP: Record<Defect['severity'], string> = {
  Critical: 'critical',
  Major: 'major',
  Minor: 'minor',
  Trivial: 'trivial',
};

/**
 * Pre-rename band names, still readable so a `BUG_REPORT.json` archived before the vocabulary
 * change can be re-filed without editing it. See `bugTracker.normalizeSeverity`.
 */
const LEGACY_SEVERITY_MAP: Record<string, string> = { Medium: 'minor', Low: 'trivial' };

export const PRIORITY_MAP: Record<string, string> = {
  P0: 'Highest',
  P1: 'High',
  P2: 'Normal',
  P3: 'Low',
};

/**
 * The defect **category** — the second classification axis — written into the Status
 * Whiteboard as `[cat:Xxx]`, because Bugzilla has no native category field.
 *
 * Whiteboard rather than `keywords` because keywords must be pre-defined by an administrator
 * on the instance — filing a bug with an unknown keyword is rejected outright, which would
 * make this bench's output depend on someone having run an admin step first. The whiteboard is
 * free text and searchable (`whiteboard` substring match in the REST API), so a triage queue
 * is simply `whiteboard contains cat:Security`.
 *
 * This is the **only** tag written to the whiteboard. Defects are classified on the two
 * production axes — severity (impact, the native Bugzilla `bug_severity`/`priority` fields)
 * and category (type, this tag) — plus the owning module (the Bugzilla component). The former
 * `[tierN]` business-tier tag was removed: module criticality is already expressed by a
 * defect's severity and its component, so a third coarse axis only added noise.
 *
 * **This format is a contract with the BUGZILLA-UI repo**, whose backend parses `[cat:Xxx]`
 * back into a structured field. Changing the shape here breaks filtering there — change both.
 */
export function categoryTag(defect: Defect): string {
  return defect.category ? `[cat:${defect.category}]` : '';
}

/* ------------------------------------------------------------------ field mapping */

/**
 * Bugzilla's hard limit on a comment, and therefore on a bug's description:
 * `Comments cannot be longer than 65535 characters.` — an HTTP 400 on create, not a truncation.
 *
 * It is reached by real defects, not pathological ones. Endpoints that carry a base64 image,
 * a presentation body or a bulk contact import produce request bodies of 200-300 KB, and the
 * curl snippet repeats the whole payload a second time. Five defects were silently lost to
 * this on the 2026-08-18 run — every one a P1 on an upload path, which is exactly the kind of
 * endpoint worth filing.
 */
const MAX_COMMENT_CHARS = 65_535;

/** Headroom for the "truncated" notices themselves, so the clamp below never has to fire. */
const SNIPPET_BUDGET = 20_000;

function clampSnippet(value: string, label: string): string {
  if (value.length <= SNIPPET_BUDGET) return value;
  return (
    `${value.slice(0, SNIPPET_BUDGET)}\n` +
    `… [${label} truncated — ${value.length} characters total. ` +
    `The complete request is in the attached ${'`'}<defect-id>-repro.txt${'`'}.]`
  );
}

/**
 * At most this many affected endpoints are listed in the ticket description.
 *
 * A systemic defect can span the entire surface, and Bugzilla's description field is not a
 * data table — past ~40 rows it stops being read. The true total is always stated on the line
 * above the list, and the complete set is in the attached repro text and in `BUG_REPORT.json`.
 */
const MAX_ENDPOINTS_IN_DESCRIPTION = 40;

/**
 * The blast-radius block: what makes one grouped ticket worth more than the many per-test
 * tickets it replaces. Omitted entirely for a defect seen at a single endpoint, where it would
 * only restate the Endpoint line above it.
 */
function buildScopeBlock(defect: Defect): string[] {
  const affected = defect.affectedEndpoints ?? [];
  if (affected.length <= 1) return [];

  const lines: string[] = [
    '',
    `Affected endpoints (${affected.length}), observed by ${defect.occurrences ?? affected.length} test case(s):`,
  ];

  for (const endpoint of affected.slice(0, MAX_ENDPOINTS_IN_DESCRIPTION)) {
    lines.push(`  - ${endpoint.method} ${endpoint.endpointPath} (${endpoint.module}) x${endpoint.occurrences}`);
  }
  const remainder = affected.length - Math.min(affected.length, MAX_ENDPOINTS_IN_DESCRIPTION);
  if (remainder > 0) {
    lines.push(`  … and ${remainder} more — see the attached repro text for the full list.`);
  }

  if ((defect.affectedModules?.length ?? 0) > 1) {
    lines.push(
      '',
      `Spans ${defect.affectedModules?.length} modules: ${defect.affectedModules?.join(', ')}.`,
      `Filed against ${defect.module}, which holds the most affected endpoints. This is one root`,
      'cause with one fix, so the other owners are named here rather than being sent a copy.'
    );
  }

  const samples = defect.evidenceSamples ?? [];
  if (samples.length > 1) {
    lines.push('', `Observed variations (${samples.length} distinct):`);
    for (const sample of samples) {
      lines.push(`  - ${sample.method} ${sample.endpointPath} -> ${sample.actual}`);
    }
  }

  return lines;
}

function buildDescription(defect: Defect, report: BugReportFile): string {
  const lines = [
    `Classification: ${defect.classification}`,
    `Category: ${defect.category ?? 'Functional'}`,
    `Representative endpoint: ${defect.method} ${defect.endpointPath}`,
    `Module: ${defect.module}`,
    ...buildScopeBlock(defect),
    '',
    defect.description,
    '',
    'Expected:',
    defect.expected,
    '',
    'Actual:',
    clampSnippet(defect.actual, 'response'),
  ];
  if (defect.reproSnippet) lines.push('', 'Repro:', clampSnippet(defect.reproSnippet, 'repro'));
  if (defect.curlSnippet) lines.push('', 'curl:', clampSnippet(defect.curlSnippet, 'curl'));
  lines.push(
    '',
    `Owner: ${defect.owner}`,
    `Environment: ${report.environment} (${report.baseURL})`,
    `Run date: ${report.generatedAt}`
  );

  /*
   * Backstop. The per-snippet budgets keep an ordinary defect well inside the limit, but a
   * defect could carry several oversized fields at once — and losing the ticket to a 400 is
   * worse than losing the tail of its description, which the attachment still holds.
   */
  const description = lines.join('\n');
  if (description.length <= MAX_COMMENT_CHARS) return description;
  const notice = '\n… [description truncated to fit Bugzilla’s 65535-character comment limit]';
  return `${description.slice(0, MAX_COMMENT_CHARS - notice.length)}${notice}`;
}

export interface BugFields {
  product: string;
  component: string;
  summary: string;
  version: string;
  description: string;
  severity: string;
  priority: string;
  op_sys: string;
  platform: string;
  /**
   * The defect category, as `[cat:Security]`. The REST create/update parameter is
   * `status_whiteboard`; the same value reads back under `whiteboard` on a bug object. Verified
   * against the 192.168.0.50 instance, whose field metadata reports `is_on_bug_entry: false` —
   * that hides it from the *web* entry form, and does not block setting it over REST.
   *
   * Substring-searchable, so a triage queue is `whiteboard contains cat:Security`. The
   * BUGZILLA-UI backend parses this exact format — see `categoryTag`.
   */
  status_whiteboard: string;
  /** Bugzilla 5.x takes `alias` as an array of strings, even for a single alias. */
  alias?: string[];
}

/** The `[<id>]` prefix is the dedup tag `findExistingOpenBug` searches for. */
export function buildBugFields(defect: Defect, config: BugzillaConfig, report: BugReportFile): BugFields {
  return {
    product: config.product,
    component: defect.module,
    summary: `[${defect.id}] ${defect.title}`,
    version: config.version,
    description: buildDescription(defect, report),
    severity: SEVERITY_MAP[defect.severity] ?? LEGACY_SEVERITY_MAP[defect.severity] ?? 'normal',
    priority: PRIORITY_MAP[defect.priority] ?? 'Normal',
    op_sys: 'All',
    platform: 'All',
    status_whiteboard: categoryTag(defect),
  };
}

function buildReproText(defect: Defect): string {
  return [
    'Request Headers:',
    defect.requestHeaders ? JSON.stringify(defect.requestHeaders, null, 2) : '(no headers)',
    '',
    'Request Body:',
    defect.requestBody ?? '(no request body)',
    '',
    'Expected:',
    defect.expected,
    '',
    'Actual:',
    defect.actual,
    '',
    'curl:',
    defect.curlSnippet ?? '(no curl snippet)',
    /*
     * The description truncates the endpoint list at MAX_ENDPOINTS_IN_DESCRIPTION so the
     * ticket stays readable. The attachment has no such constraint and is where a developer
     * scoping the fix looks, so it carries every affected endpoint, unabridged.
     */
    ...((defect.affectedEndpoints?.length ?? 0) > 1
      ? [
          '',
          `Complete affected endpoint list (${defect.affectedEndpoints?.length}):`,
          ...(defect.affectedEndpoints ?? []).map(
            (e) => `${e.method} ${e.endpointPath}\t${e.module}\tx${e.occurrences}`
          ),
        ]
      : []),
  ].join('\n');
}

/* ------------------------------------------------------------------ transport */

interface CallResult {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  error?: string;
}

/** Every Bugzilla call funnels through here: shared timeout, shared auth, never throws. */
async function bugzillaCall(
  config: BugzillaConfig,
  method: 'GET' | 'POST',
  pathAndQuery: string,
  body?: unknown
): Promise<CallResult> {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${config.url}${pathAndQuery}${sep}api_key=${encodeURIComponent(config.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    /*
     * Bugzilla reports application errors as **HTTP 200 carrying `{"error": true, ...}`** —
     * a create that failed on a database constraint still answers 200. Reading only
     * `response.ok` treated those as successes with a mysteriously absent id, and the run log
     * said "create response missing id" while the real message (a duplicate alias) sat
     * unread in the body.
     *
     * This is the exact defect class the suite exists to catch on KPOST — a success status
     * over a failed operation — reproduced in our own reporter, so it is checked here for
     * every operation rather than just for create.
     */
    const envelope = json as { error?: boolean } | undefined;
    if (!response.ok || envelope?.error === true) {
      return { ok: false, status: response.status, json, text: text.slice(0, 300) };
    }
    return { ok: true, status: response.status, json, text };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `no response within ${TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(result: CallResult): string {
  if (result.error) return result.error;
  // Bugzilla's own `message` is the useful half; the rest of the body is a Perl stack trace
  // that buries it. First line only, for the same reason.
  const message = (result.json as { message?: string } | undefined)?.message;
  if (message) return `HTTP ${result.status} - ${message.split('\n')[0].trim().slice(0, 300)}`;
  const detail = result.text ? ` - ${result.text}` : '';
  return `HTTP ${result.status}${detail}`;
}

/** A create refused because the alias is spoken for — recoverable by trying the next number. */
function isAliasCollision(reason: string): boolean {
  return /duplicate entry|bugs_aliases|alias.*(already|in use|taken)/i.test(reason);
}

/* ------------------------------------------------------------------ Bugzilla operations */

type FindResult = { id: number } | { none: true } | { error: string };

/**
 * Searches for an OPEN bug already carrying this defect's `[<id>]` tag in its summary.
 * `summary=<id>` (the bare hash, no brackets) is the search term because Bugzilla's summary
 * search is a substring/word match, not a literal-bracket match; the bracket check happens
 * client-side afterward so a coincidental hash-substring hit on an unrelated bug is rejected.
 */
export async function findExistingOpenBug(config: BugzillaConfig, defect: Defect): Promise<FindResult> {
  const tag = `[${defect.id}]`;
  const query = `/bug?summary=${encodeURIComponent(defect.id)}&product=${encodeURIComponent(config.product)}&include_fields=id,is_open,summary`;
  const result = await bugzillaCall(config, 'GET', query);
  if (!result.ok) return { error: describeFailure(result) };

  const bugs = (result.json as { bugs?: Array<{ id: number; is_open?: boolean; summary?: string }> } | undefined)?.bugs ?? [];
  const match = bugs.find((bug) => bug.is_open !== false && typeof bug.summary === 'string' && bug.summary.includes(tag));
  return match ? { id: match.id } : { none: true };
}

/**
 * Mints the next sequential, human-readable alias (`KPA-001`, `KPA-002`, …) by asking Bugzilla
 * what it already has: every alias in this product is scanned for `^<prefix>-(\d+)$` and the
 * highest number wins, so the counter lives in Bugzilla rather than in a local file that a
 * clean checkout would reset.
 *
 * Deliberately recomputed *live* immediately before each create — the filing loop awaits each
 * defect in turn, so a bug created a moment ago is already visible to the next lookup. Caching
 * a count once per run would hand every defect in that run the same alias, and Bugzilla
 * rejects a duplicate alias outright.
 *
 * Throws on a failed lookup rather than guessing a number: the caller treats that as "file
 * without an alias", which is recoverable, whereas a guessed alias can collide and lose the bug.
 */
export async function getNextAlias(config: BugzillaConfig, prefix: string): Promise<string> {
  /*
   * `limit=0` ("no limit") is load-bearing, not a tidy-up.
   *
   * Bugzilla's bug search applies a default page size, so without it this query stops
   * returning every bug in the product the moment the product outgrows one page. The max
   * would then be computed from a *prefix* of the alias set and read too low, and the create
   * that follows would collide with an alias already held by a bug outside that page. That
   * failure is also self-concealing: the collision surfaces as a create error, and the
   * caller's fallback reports it as "filing without alias" — pointing at the alias lookup
   * rather than at the pagination that actually caused it.
   *
   * The failure is silent by construction (a truncated page is a well-formed 200 with no
   * marker saying it was truncated), which is why this cannot be left to be noticed later.
   *
   * Caveat worth knowing: an admin-set `max_allowed_result` can still cap a limit=0 search on
   * the server side. That bound is far above this product's bug count and cannot be raised
   * from here; if aliases ever start repeating, that parameter is the first thing to check.
   */
  const query = `/bug?product=${encodeURIComponent(config.product)}&include_fields=alias&limit=0`;
  const result = await bugzillaCall(config, 'GET', query);
  if (!result.ok) throw new Error(`alias lookup failed: ${describeFailure(result)}`);

  const bugs = (result.json as { bugs?: Array<{ alias?: string[] | string | null }> } | undefined)?.bugs ?? [];
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);

  let max = 0;
  for (const bug of bugs) {
    // Bugzilla 5.x answers with an array; older instances answer with a bare string or null.
    const aliases = Array.isArray(bug.alias) ? bug.alias : bug.alias ? [bug.alias] : [];
    for (const alias of aliases) {
      const match = pattern.exec(alias);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }

  /*
   * The high-water mark is what keeps a run moving when the search cannot see the aliases it
   * is supposed to count.
   *
   * Observed on the fresh 192.168.0.50 instance: an alias row survived a rolled-back create,
   * so `KPA-001` was taken while `GET /bug` returned no bugs at all. Every defect therefore
   * computed max=0, asked for `KPA-001`, and was refused on the unique index — 818 creates,
   * 818 identical collisions, nothing filed. Remembering the highest number this process has
   * already handed out breaks that loop, and also stops 818 creates from each re-scanning the
   * whole product from zero.
   */
  const next = Math.max(max, highWaterMark) + 1;
  highWaterMark = next;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

/** Highest alias number handed out by this process; see the note in `getNextAlias`. */
let highWaterMark = 0;

/** Test seam — the mark is process state, and a unit test needs a clean one per case. */
export function resetAliasHighWaterMark(): void {
  highWaterMark = 0;
}

/**
 * Creates a bug, stepping past aliases that are already taken.
 *
 * An alias can be unavailable for reasons no lookup can predict — an orphaned row from a
 * rolled-back create, or a bug filed by someone else between the lookup and the create. A
 * collision is therefore treated as "try the next number", not as a failure to file: the
 * ticket matters, the number on it does not. After `MAX_ALIAS_ATTEMPTS` the bug is filed
 * without an alias rather than being dropped.
 */
const MAX_ALIAS_ATTEMPTS = 10;

export async function createBugWithAlias(
  config: BugzillaConfig,
  fields: BugFields,
  prefix: string
): Promise<{ id: number; alias?: string } | { error: string }> {
  let lastError = '';

  for (let attempt = 0; attempt < MAX_ALIAS_ATTEMPTS; attempt += 1) {
    let alias: string;
    try {
      alias = await getNextAlias(config, prefix);
    } catch (error) {
      // The alias lookup is unreachable; the ticket still matters more than its number.
      const reason = error instanceof Error ? error.message : String(error);
      const bare = await createBug(config, fields);
      return 'error' in bare ? { error: `${reason}; ${bare.error}` } : { id: bare.id };
    }

    const result = await createBug(config, { ...fields, alias: [alias] });
    if (!('error' in result)) return { id: result.id, alias };

    lastError = result.error;
    if (!isAliasCollision(result.error)) return { error: result.error };
    // Taken. `highWaterMark` has already advanced, so the next pass asks for a new number.
  }

  const fallback = await createBug(config, fields);
  if ('error' in fallback) return { error: `${lastError} (and filing without an alias failed: ${fallback.error})` };
  return { id: fallback.id };
}

/**
 * The components that actually exist in the product, read once per run.
 *
 * Empty on any failure, which `resolveComponent` treats as "do not interfere" — a reporter
 * that cannot reach the metadata endpoint must not start rewriting every ticket's component.
 */
export async function fetchProductComponents(config: BugzillaConfig): Promise<Set<string>> {
  const query = `/product?names=${encodeURIComponent(config.product)}&include_fields=components.name`;
  const result = await bugzillaCall(config, 'GET', query);
  if (!result.ok) return new Set();

  const products = (result.json as { products?: Array<{ components?: Array<{ name?: string }> }> } | undefined)?.products ?? [];
  const names = new Set<string>();
  for (const product of products) {
    for (const component of product.components ?? []) {
      if (component.name) names.add(component.name);
    }
  }
  return names;
}

/**
 * Picks a component Bugzilla will accept.
 *
 * Deliberately conservative in both directions: an unreadable component list changes nothing,
 * and a fallback that is itself not a real component is not substituted — better to let the
 * create fail with Bugzilla's own explanation than to bury the ticket under a component the
 * product does not have either.
 */
export function resolveComponent(module: string, valid: Set<string>, fallback: string): string {
  if (valid.size === 0) return module;
  if (valid.has(module)) return module;
  return valid.has(fallback) ? fallback : module;
}

export async function createBug(config: BugzillaConfig, fields: BugFields): Promise<{ id: number } | { error: string }> {
  const result = await bugzillaCall(config, 'POST', '/bug', fields);
  if (!result.ok) return { error: describeFailure(result) };
  const id = (result.json as { id?: number } | undefined)?.id;
  if (id === undefined) return { error: 'create response missing id' };
  return { id };
}

export async function commentOnBug(
  config: BugzillaConfig,
  bugId: number,
  comment: string
): Promise<{ ok: true } | { error: string }> {
  const result = await bugzillaCall(config, 'POST', `/bug/${bugId}/comment`, { comment });
  if (!result.ok) return { error: describeFailure(result) };
  return { ok: true };
}

/** Only checked before attaching to a pre-existing (commented) bug — a fresh bug cannot have one yet. */
export async function hasReproAttachment(config: BugzillaConfig, bugId: number, filename: string): Promise<boolean> {
  const result = await bugzillaCall(config, 'GET', `/bug/${bugId}/attachment?include_fields=file_name`);
  if (!result.ok) return false;
  const bugs = (result.json as { bugs?: Record<string, Array<{ file_name?: string }>> } | undefined)?.bugs ?? {};
  const attachments = bugs[String(bugId)] ?? [];
  return attachments.some((attachment) => attachment.file_name === filename);
}

export async function attachRepro(
  config: BugzillaConfig,
  bugId: number,
  defect: Defect
): Promise<{ ok: true } | { error: string }> {
  const filename = `${defect.id}-repro.txt`;
  const data = Buffer.from(buildReproText(defect), 'utf-8').toString('base64');
  const result = await bugzillaCall(config, 'POST', `/bug/${bugId}/attachment`, {
    ids: [bugId],
    data,
    file_name: filename,
    summary: `Reproduction detail for ${defect.id}`,
    content_type: 'text/plain',
  });
  if (!result.ok) return { error: describeFailure(result) };
  return { ok: true };
}

/* ------------------------------------------------------------------ orchestration */

export interface DefectOutcome {
  defectId: string;
  bugzillaId?: number;
  action: 'created' | 'commented' | 'failed' | 'dry-run';
  error?: string;
}

export interface FilingOutcome {
  ran: boolean;
  reason?: string;
  filed: number;
  commented: number;
  failed: number;
  total: number;
  results: DefectOutcome[];
}

const EMPTY: Omit<FilingOutcome, 'ran' | 'reason'> = { filed: 0, commented: 0, failed: 0, total: 0, results: [] };

export async function fileBugzillaDefects(
  reportPath = path.resolve(__dirname, '..', 'BUG_REPORT.json')
): Promise<FilingOutcome> {
  const settings = readBugzillaConfig();
  if ('skip' in settings) {
    console.log(`${LOG} skipped - ${settings.skip}`);
    return { ran: false, reason: settings.skip, ...EMPTY };
  }
  const { config } = settings;

  if (!fs.existsSync(reportPath)) {
    const reason = `${path.basename(reportPath)} not found`;
    console.log(`${LOG} skipped - ${reason}`);
    return { ran: false, reason, ...EMPTY };
  }

  /*
   * Run-validity gate — checked before the report is even read.
   *
   * This closes both directions of the same hazard. A collapsed run must not tell Bugzilla
   * "0 defects", because the early return below prints a reassuring `filed 0 new` line
   * *without making a single network call* — a success message that proves nothing. And a
   * partial run must not file its fragment of the defect list as though it were the whole,
   * because every ticket filed here is real and permanent.
   */
  const gate = publishingGate();
  if (!gate.allowed) {
    const reason = `run rejected - ${gate.reason}`;
    console.log(`${LOG} skipped - ${reason}`);
    return { ran: false, reason, ...EMPTY };
  }

  let report: BugReportFile;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as BugReportFile;
  } catch (error) {
    const reason = `unreadable report - ${error instanceof Error ? error.message : String(error)}`;
    console.log(`${LOG} skipped - ${reason}`);
    return { ran: false, reason, ...EMPTY };
  }

  const ledgerDefects = report.defects ?? [];

  /*
   * "Assertion Failure" records are TESTS that broke, not APIs that broke — a plain expect()
   * that failed, a timeout, a harness error. They are filed to the ledger (so a QA engineer
   * sees them in BUG_REPORT.md and the digest), but they must not reach Bugzilla: they are
   * frequently downstream fallout of one environment problem, they carry no curated severity
   * or category, and filing them is how the tracker fills back up with noise. On the run that
   * motivated this, they were 296 of 387 defects — filtering them here files 91 real API
   * defects instead. The developer-facing artifacts still carry all of them.
   */
  const FILE_TO_BUGZILLA = (defect: Defect): boolean => defect.classification !== 'Assertion Failure';
  const allDefects = ledgerDefects.filter(FILE_TO_BUGZILLA);
  const excludedCount = ledgerDefects.length - allDefects.length;
  if (excludedCount > 0) {
    console.log(
      `${LOG} ${excludedCount} 'Assertion Failure' record(s) kept in BUG_REPORT but NOT filed to Bugzilla ` +
        `(test failures, not API defects); ${allDefects.length} API defect(s) remain`
    );
  }

  // Announced, never silent: a capped run that printed only its own total would read as
  // "everything was filed" while most of the ledger sat untouched.
  const defects =
    config.maxFile > 0 && allDefects.length > config.maxFile ? allDefects.slice(0, config.maxFile) : allDefects;
  if (defects.length < allDefects.length) {
    console.log(
      `${LOG} BUGZILLA_MAX_FILE=${config.maxFile} - processing the first ${defects.length} of ${allDefects.length} defect(s); ` +
        `the remaining ${allDefects.length - defects.length} are NOT filed`
    );
  }

  if (defects.length === 0) {
    console.log(`${LOG} filed 0 new, commented 0 existing, 0 failed (of 0 defects)`);
    return { ran: true, ...EMPTY };
  }

  const results: DefectOutcome[] = [];

  // Dry run: pure mapping, zero network calls, so it can be reviewed before anything real
  // touches Bugzilla.
  if (config.dryRun) {
    for (const defect of defects) {
      try {
        const fields = buildBugFields(defect, config, report);
        console.log(
          `${LOG} DRY RUN ${defect.id} -> product="${fields.product}" component="${fields.component}" ` +
            `summary="${fields.summary}" severity=${fields.severity} priority=${fields.priority} ` +
            `whiteboard=${fields.status_whiteboard}`
        );
        results.push({ defectId: defect.id, action: 'dry-run' });
      } catch (error) {
        console.log(`${LOG} DRY RUN ${defect.id} - mapping failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`${LOG} DRY RUN complete - ${defects.length} defect(s) mapped, no API calls made`);
    return { ran: true, filed: 0, commented: 0, failed: 0, total: defects.length, results };
  }

  let filed = 0;
  let commented = 0;
  let failed = 0;

  // One metadata read for the whole run, so an unmappable module costs a substitution rather
  // than a lost ticket. See `resolveComponent`.
  const components = await fetchProductComponents(config);
  const remapped = new Map<string, number>();

  for (const defect of defects) {
    // One bad defect must never abort the rest.
    try {
      const fields = buildBugFields(defect, config, report);

      const component = resolveComponent(fields.component, components, config.fallbackComponent);
      if (component !== fields.component) {
        remapped.set(fields.component, (remapped.get(fields.component) ?? 0) + 1);
        fields.component = component;
      }

      const existing = await findExistingOpenBug(config, defect);
      if ('error' in existing) {
        failed += 1;
        console.log(`${LOG} ${defect.id} not filed - search failed: ${existing.error}`);
        results.push({ defectId: defect.id, action: 'failed', error: existing.error });
        continue;
      }

      let bugId: number;
      let action: 'created' | 'commented';
      let alias: string | undefined;

      if ('id' in existing) {
        bugId = existing.id;
        const commentResult = await commentOnBug(
          config,
          bugId,
          `Observed again in run ${report.generatedAt}, environment ${report.environment}.`
        );
        if ('error' in commentResult) {
          failed += 1;
          console.log(`${LOG} ${defect.id} not commented on existing bug ${bugId} - ${commentResult.error}`);
          results.push({ defectId: defect.id, bugzillaId: bugId, action: 'failed', error: commentResult.error });
          continue;
        }
        action = 'commented';
        commented += 1;
      } else {
        // New bugs only — an existing bug already carries whatever alias it was filed with,
        // and reassigning one would break every reference to it.
        const createResult = config.clientAlias
          ? await createBugWithAlias(config, fields, config.aliasPrefix)
          : await createBug(config, fields);
        if ('error' in createResult) {
          failed += 1;
          console.log(`${LOG} ${defect.id} not filed - ${createResult.error}`);
          results.push({ defectId: defect.id, action: 'failed', error: createResult.error });
          continue;
        }
        // Absent when the server assigns the alias itself — it does not come back on create,
        // and one extra GET per bug to read it back is not worth a log line.
        alias = (createResult as { alias?: string }).alias;
        bugId = createResult.id;
        action = 'created';
        filed += 1;
      }

      // Attachment is best-effort: it never changes the create/comment outcome already counted
      // above, and a failure here is one warning line, not a thrown error.
      try {
        const filename = `${defect.id}-repro.txt`;
        const alreadyAttached = action === 'commented' ? await hasReproAttachment(config, bugId, filename) : false;
        if (!alreadyAttached) {
          const attachResult = await attachRepro(config, bugId, defect);
          if ('error' in attachResult) {
            console.log(`${LOG} ${defect.id} (bug ${bugId}) attachment failed - ${attachResult.error}`);
          }
        }
      } catch (error) {
        console.log(
          `${LOG} ${defect.id} (bug ${bugId}) attachment failed - ${error instanceof Error ? error.message : String(error)}`
        );
      }

      console.log(
        `${LOG} ${defect.id} ${action === 'created' ? 'filed as' : 'commented on'} bug ${bugId}` +
          (alias ? ` (${alias})` : '')
      );
      results.push({ defectId: defect.id, bugzillaId: bugId, action });
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`${LOG} ${defect.id} not filed - ${reason}`);
      results.push({ defectId: defect.id, action: 'failed', error: reason });
    }
  }

  // Named explicitly rather than folded into the totals: a ticket filed under a substituted
  // component is routed to the wrong team until the real component exists, and that is worth
  // one line of the run log.
  for (const [module, count] of remapped) {
    console.log(
      `${LOG} ${count} defect(s) had no '${module}' component - filed under '${config.fallbackComponent}' instead`
    );
  }

  console.log(`${LOG} filed ${filed} new, commented ${commented} existing, ${failed} failed (of ${defects.length} defects)`);
  return { ran: true, filed, commented, failed, total: defects.length, results };
}

export default class BugzillaReporter implements Reporter {
  async onEnd(): Promise<void> {
    try {
      await fileBugzillaDefects();
    } catch (error) {
      // Unreachable by design; kept because a throw here would surface as a reporter crash
      // and cast doubt on an otherwise valid run.
      console.log(`${LOG} skipped - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Keeps this line out of Playwright's own error summary. */
  printsToStdio(): boolean {
    return true;
  }
}

if (require.main === module) {
  void fileBugzillaDefects();
}
