import { BugReport, Defect } from './findingsModel';

/**
 * Files the run's defects into the `KMail API` Bugzilla product.
 *
 * **Assignment is never set here.** The reporter deliberately omits `assigned_to` on create, so
 * each bug falls to its component's default assignee — every KMail component defaults to
 * `jitendra@kpost.in`, so every KMail defect auto-assigns to Jitendra Kumar. Setting an
 * assignee explicitly would only be a way to get it wrong.
 *
 * Idempotent by design. A defect's id (`KM-XXXXXX`) is deterministic from its identity and is
 * carried as a `[KM-XXXXXX]` tag in the Bugzilla summary. On every run the publisher searches
 * for any ticket with that tag and acts on its state, so re-running never multiplies tickets and
 * never re-litigates a settled judgement:
 *   - OPEN                          → comment (the defect reproduced), no new bug
 *   - INVALID/WONTFIX/WORKSFORME/DUPLICATE (a human's judgement) → SKIP, never re-file
 *   - resolved otherwise (e.g. FIXED) but reproduced → REOPEN the original, not a new bug
 *   - no ticket found               → file one
 * A failed search files nothing, so a transient error can't mint a duplicate.
 *
 * Config-gated: with `BUGZILLA_URL` / `BUGZILLA_API_KEY` unset it does nothing and says so in
 * one line, exactly like the KPOST bench's own reporter.
 */

export interface BugzillaConfig {
  url: string; // no trailing slash
  apiKey: string;
  product: string;
  version: string;
  dryRun: boolean;
  /** Process at most this many defects (0 = no cap). A staged-rollout safety valve. */
  maxFile: number;
}

const SEVERITY_MAP: Record<Defect['severity'], string> = {
  Critical: 'critical',
  Major: 'major',
  Minor: 'minor',
  Low: 'trivial',
};

const PRIORITY_MAP: Record<Defect['priority'], string> = {
  Highest: 'Highest',
  High: 'High',
  Normal: 'Normal',
  Low: 'Low',
};

const SUMMARY_MAX = 255;
const COMMENT_MAX = 65_535;
const TIMEOUT_MS = 20_000;
const LOG = '[kmail-bugzilla]';

export function readBugzillaConfig(env: NodeJS.ProcessEnv): BugzillaConfig | null {
  const url = (env.BUGZILLA_URL ?? '').replace(/\/+$/, '');
  const apiKey = env.BUGZILLA_API_KEY ?? '';
  if (!url || !apiKey) return null;
  return {
    url,
    apiKey,
    product: env.BUGZILLA_PRODUCT || 'KMail API',
    version: env.BUGZILLA_VERSION || '5.0',
    dryRun: env.BUGZILLA_DRY_RUN === 'true' || env.BUGZILLA_DRY_RUN === '1',
    maxFile: Number.parseInt(env.BUGZILLA_MAX_FILE ?? '0', 10) || 0,
  };
}

interface CallResult {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  error?: string;
}

/**
 * A single Bugzilla REST call.
 *
 * Treats `HTTP 200` carrying `{"error": true}` as a failure — Bugzilla reports application
 * errors that way, and reading only `response.ok` would count a create that failed on a
 * constraint as a success with a mysteriously missing id. (This is the very defect class the
 * suite exists to catch, so the reporter must not commit it itself.)
 */
async function call(
  config: BugzillaConfig,
  method: 'GET' | 'POST' | 'PUT',
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

function fitSummary(tag: string, title: string): string {
  const full = `${tag} ${title}`;
  if (full.length <= SUMMARY_MAX) return full;
  const room = SUMMARY_MAX - tag.length - 2;
  return `${tag} ${title.slice(0, room).trimEnd()}…`;
}

/** A copy-pasteable curl for the failing call, built from the defect's own request metadata. */
function buildCurl(defect: Defect, environment: string): string {
  const base = /^https?:\/\//.test(environment) ? environment : `http://${environment}`;
  const parts = [`curl -i -X ${defect.method} '${base}${defect.endpointPath}'`, `  -H 'Content-Type: application/json'`];
  if (defect.requestHeaders) {
    for (const [k, v] of Object.entries(defect.requestHeaders)) {
      if (k.toLowerCase() === 'content-type') continue;
      parts.push(`  -H '${k}: ${v}'`);
    }
  }
  if (defect.requestBody) parts.push(`  -d '${defect.requestBody}'`);
  return parts.join(' \\\n');
}

/**
 * Formatted to the SAME line-anchored shape the KPost reporter uses, so the Bug Tracker UI's
 * `DescriptionReport` parser renders the rich view — a metadata grid, a green Expected / red
 * Actual contrast, and curl + Playwright reproduce cards — instead of a raw monospace dump.
 *
 * The parser keys on exact anchors (`Classification:` / `Category:` / `Representative endpoint:`
 * / `Module:` for the grid; `Expected:` / `Actual:` / `curl:` / `Reproduce with Playwright:` /
 * `Owner:` / `Environment:` / `Run date:` for the blocks), so each label must be a single space
 * after the colon with NO alignment padding and NO `----` underline — the previous format had
 * both and fell through to the plain-text fallback.
 */
function buildDescription(defect: Defect, run: BugReport['run']): string {
  const lines: string[] = [
    `Classification: ${defect.classification}`,
    `Category: ${defect.category}`,
    `Representative endpoint: ${defect.method} ${defect.endpointPath}`,
    `Module: ${defect.module}`,
  ];
  if (defect.affectedEndpoints.length > 1) {
    lines.push(`Seen on: ${defect.occurrences} test case(s) across ${defect.affectedEndpoints.length} endpoint(s)`);
  }
  lines.push('', defect.description, '', 'Expected:', defect.expected, '', 'Actual:', defect.actual);
  if (defect.reproSnippet) lines.push('', 'Reproduce with Playwright:', defect.reproSnippet);
  lines.push('', 'curl:', buildCurl(defect, run.environment));
  lines.push('', `Owner: Jitendra Kumar`, `Environment: ${run.environment}`, `Run date: ${run.generatedAt}`);

  const description = lines.join('\n');
  if (description.length <= COMMENT_MAX) return description;
  const notice = '\n… [truncated to fit Bugzilla comment limit]';
  return `${description.slice(0, COMMENT_MAX - notice.length)}${notice}`;
}

/**
 * The `<id>-repro.txt` attachment body — the same reproduction detail KPost attaches, so a
 * KMail ticket carries the full request/response and the complete affected-endpoint list a
 * developer needs, unabridged (the comment description is capped; the attachment is not).
 */
function buildReproText(defect: Defect, environment: string): string {
  const lines = [
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
    buildCurl(defect, environment),
  ];
  if (defect.affectedEndpoints.length > 1) {
    lines.push('', `Complete affected endpoint list (${defect.affectedEndpoints.length}):`, ...defect.affectedEndpoints.map((e) => `  - ${e}`));
  }
  return lines.join('\n');
}

/**
 * Attaches `<id>-repro.txt` to a freshly filed bug — matches the KPost reporter so every
 * product's tickets carry the same downloadable reproduction file. Fail-safe: a failed
 * attachment warns but never fails the run (the ticket already exists with the full description).
 */
async function attachRepro(config: BugzillaConfig, bugId: number, defect: Defect, environment: string): Promise<void> {
  const data = Buffer.from(buildReproText(defect, environment), 'utf-8').toString('base64');
  const res = await call(config, 'POST', `/bug/${bugId}/attachment`, {
    ids: [bugId],
    data,
    file_name: `${defect.id}-repro.txt`,
    summary: `Reproduction detail for ${defect.id}`,
    content_type: 'text/plain',
  });
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.warn(`${LOG} filed ${defect.id} (bug ${bugId}) but could not attach repro: ${res.error ?? res.text ?? 'unknown error'}`);
  }
}

/**
 * Resolutions that mean "a human judged this NOT a defect". A ticket closed with one of these
 * must never be re-filed under a new number: the suite re-observes the same behaviour on every
 * run, so re-filing turns one settled judgement into a nightly duplicate.
 */
const JUDGED_NOT_A_DEFECT = new Set(['INVALID', 'WONTFIX', 'WORKSFORME', 'DUPLICATE']);

type FindResult =
  | { open: number }
  | { judged: number; resolution: string }
  | { reopen: number; resolution: string }
  | { none: true }
  | { error: string };

/**
 * Locates any existing ticket for this defect by its `[KM-XXXXXX]` summary tag and decides what
 * to do with it. Returns:
 *   - open   → an OPEN ticket exists; comment on it (no new bug)
 *   - judged → closed as not-a-defect; SKIP entirely (do not re-file)
 *   - reopen → closed some other way (e.g. FIXED) but the fault is back; reopen that ticket
 *   - none   → no ticket carries this tag; file a new one
 *   - error  → the search itself failed; do NOT file (would risk a duplicate)
 */
async function findExisting(config: BugzillaConfig, defect: Defect): Promise<FindResult> {
  const q =
    `/bug?quicksearch=${encodeURIComponent(`ALL "[${defect.id}]"`)}` +
    `&include_fields=id,summary,status,is_open,resolution`;
  const res = await call(config, 'GET', q);
  if (!res.ok) return { error: res.error ?? res.text ?? 'search failed' };
  const bugs =
    (res.json as {
      bugs?: Array<{ id: number; summary: string; is_open: boolean; resolution?: string }>;
    })?.bugs ?? [];
  const tagged = bugs.filter((b) => b.summary.includes(`[${defect.id}]`));

  const open = tagged.find((b) => b.is_open);
  if (open) return { open: open.id };

  const judged = tagged.find((b) => JUDGED_NOT_A_DEFECT.has(String(b.resolution ?? '').toUpperCase()));
  if (judged) return { judged: judged.id, resolution: String(judged.resolution) };

  const stale = tagged.find((b) => b.resolution);
  if (stale) return { reopen: stale.id, resolution: String(stale.resolution) };

  return { none: true };
}

export interface FileOutcome {
  filed: number;
  commented: number;
  failed: number;
  /** Tickets a human closed as INVALID/WONTFIX/WORKSFORME/DUPLICATE — re-filing suppressed. */
  judgedSkipped: number;
  /** Tickets that were resolved (e.g. FIXED) but reproduced — reopened, not re-filed. */
  reopened: number;
  skipped: boolean;
  /** defect.id -> bugzilla bug id, for feeding into the dashboard payload. */
  bugIdByDefect: Record<string, number>;
}

/**
 * Files or updates every defect. Never throws — a reporting failure must not fail the run.
 */
export async function publishToBugzilla(
  report: BugReport,
  config: BugzillaConfig
): Promise<FileOutcome> {
  const out: FileOutcome = { filed: 0, commented: 0, failed: 0, judgedSkipped: 0, reopened: 0, skipped: false, bugIdByDefect: {} };
  const defects = config.maxFile > 0 ? report.defects.slice(0, config.maxFile) : report.defects;

  for (const defect of defects) {
    if (config.dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG} DRY RUN ${defect.id} -> product="${config.product}" component="${defect.module}" ` +
          `severity=${SEVERITY_MAP[defect.severity]} (assignee: component default = jitendra@kpost.in)`
      );
      continue;
    }

    const existing = await findExisting(config, defect);

    // Search failed — do NOT file, or a transient error would mint a duplicate.
    if ('error' in existing) {
      out.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`${LOG} ${defect.id} not filed — search failed: ${existing.error}`);
      continue;
    }

    // A human already ruled this NOT a defect. Respect it; never re-file.
    if ('judged' in existing) {
      out.judgedSkipped += 1;
      // eslint-disable-next-line no-console
      console.log(`${LOG} ${defect.id} not filed — bug ${existing.judged} is closed as ${existing.resolution}`);
      out.bugIdByDefect[defect.id] = existing.judged;
      continue;
    }

    // Closed (e.g. FIXED) but the fault is back — reopen the original, don't file a new one.
    if ('reopen' in existing) {
      const comment =
        `Reopening: this defect was observed again by the KMail suite on ${report.run.generatedAt} ` +
        `(${report.run.environment}), after the ticket was resolved ${existing.resolution}. ` +
        `Tracked here rather than under a new ticket number.`;
      const res = await call(config, 'PUT', `/bug/${existing.reopen}`, {
        status: 'CONFIRMED',
        resolution: '',
        comment: { body: comment.slice(0, COMMENT_MAX) },
      });
      if (res.ok) {
        out.reopened += 1;
        out.bugIdByDefect[defect.id] = existing.reopen;
      } else {
        out.failed += 1;
      }
      continue;
    }

    // An OPEN ticket already exists — comment, don't duplicate.
    if ('open' in existing) {
      const comment = `Reproduced by the KMail automation suite on ${report.run.generatedAt} (${report.run.environment}). Still open across ${defect.occurrences} test case(s).`;
      const res = await call(config, 'POST', `/bug/${existing.open}/comment`, {
        comment: comment.slice(0, COMMENT_MAX),
      });
      if (res.ok) {
        out.commented += 1;
        out.bugIdByDefect[defect.id] = existing.open;
      } else {
        out.failed += 1;
      }
      continue;
    }

    // No assigned_to — the component's default assignee (Jitendra Kumar) takes it.
    const fields = {
      product: config.product,
      component: defect.module,
      summary: fitSummary(`[${defect.id}]`, defect.title),
      version: config.version,
      description: buildDescription(defect, report.run),
      severity: SEVERITY_MAP[defect.severity],
      priority: PRIORITY_MAP[defect.priority],
      op_sys: 'All',
      platform: 'All',
      // `[cat:Xxx]` (bracketed) is a contract with the BUGZILLA-UI repo, whose backend parses
      // exactly that tag to derive the category. Without the brackets the UI can't read it and
      // falls back to guessing from the description — landing many bugs in "Unclassified".
      status_whiteboard: `[cat:${defect.category}]`,
    };
    const res = await call(config, 'POST', '/bug', fields);
    if (res.ok && (res.json as { id?: number })?.id) {
      out.filed += 1;
      const newId = (res.json as { id: number }).id;
      out.bugIdByDefect[defect.id] = newId;
      // Attach the reproduction-detail file, exactly as the KPost reporter does.
      await attachRepro(config, newId, defect, report.run.environment);
    } else {
      out.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} could not file ${defect.id} (${defect.module}): ${res.error ?? res.text ?? 'unknown error'}`
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `${LOG} ${config.dryRun ? 'DRY RUN — ' : ''}filed ${out.filed}, commented ${out.commented}, reopened ${out.reopened}, ` +
      `${out.judgedSkipped} judged-skip, ${out.failed} failed into "${config.product}" ` +
      `(auto-assigned to Jitendra Kumar via component defaults).`
  );
  return out;
}
