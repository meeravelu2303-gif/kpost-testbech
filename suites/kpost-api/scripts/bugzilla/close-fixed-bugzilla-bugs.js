#!/usr/bin/env node
/**
 * Closes Bugzilla tickets whose defect no longer reproduces.
 *
 * Why this exists. The bench files tickets and comments on recurring ones, but nothing in it
 * ever *closes* one — a passing test says nothing to Bugzilla. So a fixed defect leaves an
 * open ticket behind forever, and the product's bug count only ever rises, even while the API
 * measurably improves. Observed directly on this bench: between two runs the real defect count
 * fell 581 -> 533 while Bugzilla went 529 -> 558.
 *
 * This script closes that gap from the other end: it reads the latest run model, finds open
 * tickets this bench filed whose defect did **not** recur, and resolves them with the evidence
 * attached.
 *
 * ## "Did not recur" is not the same as "fixed"
 *
 * A defect can be absent from a run for three quite different reasons, and only one of them
 * justifies closing a ticket as FIXED:
 *
 *   1. it was genuinely fixed                      -> close FIXED
 *   2. its test never ran (skipped, filtered out)  -> DO NOT CLOSE, nothing was verified
 *   3. it was an artifact of a broken environment  -> close INVALID, not FIXED
 *
 * Case 2 is the dangerous one, because a skipped test and a passing test look identical from
 * the outside: both produce silence. This script therefore refuses to close a ticket unless
 * the defect's endpoint was **actually exercised** by a non-skipped test in the run being
 * used as evidence. `run model.tests[]` carries `method`, `path` and `status`, so that set is
 * recoverable exactly rather than assumed.
 *
 * Case 3 is reported separately rather than closed automatically. An infrastructure-shaped
 * status (403 from a security filter that was misconfigured, 502/503/504 from a service that
 * was down) disappearing between runs usually means the environment was repaired, not that a
 * developer changed code. Resolving those as FIXED credits work nobody did and quietly
 * corrupts the fix-rate metric, so they are listed under a separate heading and only acted on
 * with `--include-artifacts`, which resolves them INVALID.
 *
 * ## Safety
 *
 * Bugzilla's REST API has no delete, only resolve — every write here is one-way. So, matching
 * `reconcile-bugzilla-duplicates.js`:
 *
 *   - dry run is the default and prints the complete plan;
 *   - `--apply` is required to write, and refuses to run without `--yes` as well;
 *   - `--limit N` stages the rollout, and re-running is safe because an already-resolved
 *     ticket is skipped rather than re-resolved;
 *   - a bug whose summary carries no `[BUG-API-...]` tag is never touched — this script only
 *     ever acts on tickets this bench filed;
 *   - a run that the validity gate rejected is refused outright, because a collapsed run
 *     reports every defect as absent and would close the entire product.
 *
 * Usage:
 *   node scripts/close-fixed-bugzilla-bugs.js                        # dry run, full plan
 *   node scripts/close-fixed-bugzilla-bugs.js --limit 20             # dry run, first 20
 *   node scripts/close-fixed-bugzilla-bugs.js --apply --yes --limit 20
 *   node scripts/close-fixed-bugzilla-bugs.js --apply --yes --include-artifacts
 */

const fs = require('fs');
const path = require('path');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const LOG = '[close-fixed]';
const TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
const INCLUDE_ARTIFACTS = argv.includes('--include-artifacts');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(argv[limitArg + 1]) : 0;

/**
 * How many of the most recent runs a defect must be absent from before its ticket is closed.
 *
 * Two, not one, and that default was bought the hard way. Closing on a single run's silence
 * resolved 45 tickets on 2026-08-24; the very next run re-filed 18 of them as new tickets,
 * because a closed ticket is invisible to the filer's dedup (which matches open bugs only).
 * Every one of those 18 was a signup / OTP / password-validation defect, and in the run used
 * as evidence the OTP flow was rate-limited — "Try after 24 Hours, OTP sent more than 3
 * times". The endpoint was called, so the exercised-endpoint guard passed it, but the test
 * never reached the assertion that detects the fault.
 *
 * That is the failure this exists for: **a test can run and still verify nothing.** Requiring
 * the same silence from several independent runs is what separates "fixed" from "this run
 * happened not to look".
 */
const absentArg = argv.indexOf('--min-absent-runs');
const MIN_ABSENT_RUNS = absentArg !== -1 ? Math.max(1, Number(argv[absentArg + 1]) || 1) : 2;

if (APPLY && !CONFIRMED) {
  console.error(
    `${LOG} --apply also requires --yes. Bugzilla has no delete, only resolve: every write here\n` +
      `${LOG} is irreversible. Read the dry-run plan first, then re-run with both flags.`
  );
  process.exit(2);
}

const config = {
  url: (process.env.BUGZILLA_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.BUGZILLA_API_KEY,
  product: process.env.BUGZILLA_PRODUCT || 'KPost API',
};

if (!config.url || !config.apiKey) {
  console.error(`${LOG} BUGZILLA_URL and BUGZILLA_API_KEY must both be set. Nothing done.`);
  process.exit(2);
}

/* ------------------------------------------------------------------ transport */

async function call(method, endpoint, body) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${config.url}${endpoint}${separator}api_key=${encodeURIComponent(config.apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ run models */

/**
 * Newest run first. Resolved through `reports/latest/run.json` where it exists, falling back to
 * a sort of `reports/runs/` — the same two-step the dispatchers use, so a deleted `latest/`
 * does not strand this script.
 */
function findRunModels() {
  const runsDir = path.join(ROOT, 'reports', 'runs');
  if (!fs.existsSync(runsDir)) return [];

  const models = [];
  for (const entry of fs.readdirSync(runsDir).sort().reverse()) {
    const model = path.join(runsDir, entry, 'kpost-run-model.json');
    if (fs.existsSync(model)) models.push(model);
  }
  return models;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    console.error(`${LOG} could not read ${path.relative(ROOT, file)}: ${error.message}`);
    return undefined;
  }
}

/** `[BUG-API-XXXXXX]` as filed into the summary by `dashboard-bugzilla.ts`. */
const TAG = /\[(BUG-API-[0-9A-F]+)\]/i;

/**
 * A status that describes the environment or our own request rate, rather than the endpoint's
 * logic. Used to separate "the condition passed" from "a developer fixed it", so these retire
 * as INVALID rather than being credited as fixes.
 *
 * Two families sit here. 403/502/503/504 are the outage signatures - the service was down or
 * refusing everything. 429 is the opposite problem and ours, not theirs: the suite fires ~4,500
 * requests in nine minutes and the busiest routes throttle, which every downstream assertion
 * read as a wrong status. That accounted for 62 filed tickets on 2026-08-24. The assertion
 * helpers and the safety net now both ignore a 429, so no new ones appear; this entry retires
 * the ones already filed.
 *
 * Matched against the **observed** status only, never the expected one. `expected` routinely
 * enumerates the acceptable statuses for a route — "HTTP 400 or 401 or 403 or 404 or 422 or
 * 500 (input validation failure)" — so scanning it flags almost every defect in the ledger.
 * On this bench that mistake mislabelled 240 of 581 defects as infrastructure artifacts,
 * including a Critical "null password accepted" whose actual result was a plain HTTP 200.
 */
const OBSERVED_INFRA =
  /\bgot (403|429|502|503|504)\b|\b(?:HTTP|returned) (429|502|503|504)\b|^HTTP 403\b|Too many requests/i;

function isArtifact(defect) {
  return OBSERVED_INFRA.test(String(defect.actual || ''));
}

/* ------------------------------------------------------------------ main */

async function main() {
  /* ---------------------------------------------------------- evidence run */

  const models = findRunModels();
  if (models.length === 0) {
    console.error(`${LOG} no run model under reports/runs/. Run the suite first — there is no evidence to close against.`);
    process.exit(2);
  }

  const latest = readJson(models[0]);
  if (!latest) process.exit(2);

  /*
   * A collapsed run reports every defect as absent, so closing against one would resolve the
   * entire product in a single command. The gate that already stops such a run from publishing
   * stops it from closing tickets too.
   */
  const validityFile = path.join(ROOT, 'reports', 'run-validity.json');
  if (fs.existsSync(validityFile)) {
    const validity = readJson(validityFile);
    if (validity && validity.valid === false) {
      console.error(`${LOG} the latest run was rejected by the validity gate (${validity.reason}).`);
      console.error(`${LOG} Closing tickets against it would resolve defects that were never re-tested. Nothing done.`);
      process.exit(2);
    }
  }

  const runId = latest.runId || path.basename(path.dirname(models[0]));
  const totals = latest.totals || {};

  /* ---------------------------------------------------------- what this run saw */

  const present = new Set();
  for (const defect of latest.defects || []) {
    if (defect.ledgerId) present.add(defect.ledgerId.toUpperCase());
  }

  /*
   * The N most recent runs a defect must be silent in. Each entry is that run's set of ledger
   * ids; a hash present in ANY of them is still reproducing and is never closed, however quiet
   * the newest run was.
   */
  const recentRuns = [];
  for (const file of models.slice(0, MIN_ABSENT_RUNS)) {
    const model = readJson(file);
    if (!model) continue;
    const seen = new Set();
    for (const defect of model.defects || []) {
      if (defect.ledgerId) seen.add(defect.ledgerId.toUpperCase());
    }
    recentRuns.push({ runId: model.runId || path.basename(path.dirname(file)), seen });
  }

  if (recentRuns.length < MIN_ABSENT_RUNS) {
    console.error(
      `${LOG} --min-absent-runs ${MIN_ABSENT_RUNS} needs ${MIN_ABSENT_RUNS} archived run model(s); only ${recentRuns.length} found.\n` +
        `${LOG} Run the suite again, or lower the bar with --min-absent-runs ${recentRuns.length} ` +
        `(understanding that one run's silence is weak evidence).`
    );
    process.exit(2);
  }

  /** Absent from every one of the recent runs — not merely from the newest. */
  const absentThroughout = (hash) => recentRuns.every((run) => !run.seen.has(hash));

  /*
   * Endpoints a non-skipped test actually drove in this run. This is the whole skip guard: a
   * defect on an endpoint absent from this set was not re-tested, so its silence is not
   * evidence of anything.
   */
  const exercised = new Set();
  for (const test of latest.tests || []) {
    if (test.status !== 'skipped' && test.method && test.path) {
      exercised.add(`${test.method} ${test.path}`);
    }
  }

  /*
   * Endpoint and title for a hash, taken from whichever run last carried it. A ticket's own
   * summary holds the title but not the endpoint, and the endpoint is what the skip guard
   * needs — so it is recovered from the archived run models rather than guessed.
   */
  const known = new Map();
  for (const file of models) {
    const model = readJson(file);
    if (!model) continue;
    for (const defect of model.defects || []) {
      const hash = (defect.ledgerId || '').toUpperCase();
      if (!hash || known.has(hash)) continue;
      known.set(hash, {
        method: defect.method,
        path: defect.path,
        title: defect.title,
        severity: defect.severity,
        module: defect.module,
        artifact: isArtifact(defect),
        seenIn: model.runId || path.basename(path.dirname(file)),
      });
    }
  }

  console.log('');
  console.log('='.repeat(78));
  console.log(`${LOG} evidence run : ${runId}`);
  console.log(`${LOG} must be absent from the ${MIN_ABSENT_RUNS} most recent run(s) (--min-absent-runs)`);
  console.log(`${LOG} tests        : ${totals.total ?? '?'} total · ${totals.passed ?? '?'} passed · ${totals.failed ?? '?'} failed · ${totals.skipped ?? '?'} skipped`);
  console.log(`${LOG} defects seen : ${present.size}`);
  console.log(`${LOG} endpoints exercised (non-skipped): ${exercised.size}`);
  console.log(`${LOG} defect history loaded from ${models.length} run model(s)`);
  console.log('='.repeat(78));

  /* ---------------------------------------------------------- open tickets */

  const search = await call(
    'GET',
    `/bug?product=${encodeURIComponent(config.product)}&status=__open__&include_fields=id,summary,status,resolution&limit=0`
  );
  if (!search.ok) {
    console.error(`${LOG} bug search failed: ${search.error || search.status} ${(search.text || '').slice(0, 200)}`);
    process.exit(1);
  }

  const openBugs = (search.json && search.json.bugs) || [];
  console.log(`${LOG} open tickets in "${config.product}": ${openBugs.length}`);
  console.log('');

  /* ---------------------------------------------------------- classify */

  const toClose = [];   // absent throughout, endpoint exercised, not infra-shaped
  const artifacts = []; // absent throughout, endpoint exercised, infra-shaped
  const notRun = [];    // absent, but endpoint never exercised in the newest run
  const unknown = [];   // absent, and no run model knows its endpoint
  const flaky = [];     // absent from the newest run, but seen in an earlier recent run
  let stillOpen = 0;
  let untagged = 0;

  for (const bug of openBugs) {
    const match = TAG.exec(bug.summary || '');
    if (!match) {
      untagged += 1;
      continue;
    }
    const hash = match[1].toUpperCase();

    if (present.has(hash)) {
      stillOpen += 1;
      continue;
    }

    const info = known.get(hash);
    const row = {
      id: bug.id,
      hash,
      title: (info && info.title) || (bug.summary || '').replace(TAG, '').trim(),
      severity: (info && info.severity) || '?',
      module: (info && info.module) || '?',
      endpoint: info && info.method && info.path ? `${info.method} ${info.path}` : null,
    };

    if (!absentThroughout(hash)) {
      // Quiet in the newest run, but one of the other recent runs still saw it. This is the
      // exact population that produced 18 re-filed tickets when a single run was trusted.
      row.lastSeenIn = (recentRuns.find((run) => run.seen.has(hash)) || {}).runId;
      flaky.push(row);
    } else if (!row.endpoint) {
      unknown.push(row);
    } else if (!exercised.has(row.endpoint)) {
      notRun.push(row);
    } else if (info.artifact) {
      artifacts.push(row);
    } else {
      toClose.push(row);
    }
  }

  const rank = { Critical: 1, Major: 2, Minor: 3, Trivial: 4 };
  const bySeverity = (a, b) => (rank[a.severity] || 9) - (rank[b.severity] || 9) || a.id - b.id;
  toClose.sort(bySeverity);
  artifacts.sort(bySeverity);

  /* ---------------------------------------------------------- report */

  const show = (label, rows, note) => {
    console.log('-'.repeat(78));
    console.log(`${label}: ${rows.length}`);
    if (note) console.log(`  ${note}`);
    for (const r of rows.slice(0, LIMIT || rows.length)) {
      console.log(`  bug ${String(r.id).padEnd(5)} ${String(r.severity).padEnd(8)} ${r.endpoint || '(endpoint unknown)'}`);
      console.log(`            ${r.title.slice(0, 96)}`);
    }
    if (LIMIT && rows.length > LIMIT) console.log(`  … ${rows.length - LIMIT} more not shown (--limit ${LIMIT})`);
    console.log('');
  };

  console.log(`${LOG} still reproducing, left alone : ${stillOpen}`);
  console.log(`${LOG} not filed by this bench       : ${untagged}`);
  console.log('');

  show(
    'WILL CLOSE as FIXED',
    toClose,
    `absent from all ${MIN_ABSENT_RUNS} most recent runs, and its endpoint was exercised by a non-skipped test`
  );
  show(
    'LEFT OPEN — intermittent, seen in another recent run',
    flaky,
    'quiet in the newest run only; closing these is what re-files them as fresh tickets'
  );
  show(
    INCLUDE_ARTIFACTS ? 'WILL CLOSE as INVALID' : 'ENVIRONMENT ARTIFACTS (not closed without --include-artifacts)',
    artifacts,
    'absent, but the finding was an infra-shaped status (403/502/503/504) — likely an outage ending, not a fix'
  );
  show('LEFT OPEN — endpoint not exercised this run', notRun, 'silence here is not evidence; nothing was re-tested');
  show('LEFT OPEN — no run model knows this endpoint', unknown, 'filed before the archived runs, so the skip guard cannot be applied');

  /* ---------------------------------------------------------- apply */

  const targets = [
    ...toClose.map((r) => ({ ...r, resolution: 'FIXED' })),
    ...(INCLUDE_ARTIFACTS ? artifacts.map((r) => ({ ...r, resolution: 'INVALID' })) : []),
  ];
  const planned = LIMIT ? targets.slice(0, LIMIT) : targets;

  if (!APPLY) {
    console.log('='.repeat(78));
    console.log(`${LOG} DRY RUN — nothing written. ${planned.length} ticket(s) would be resolved.`);
    console.log(`${LOG} Re-run with --apply --yes to write${LIMIT ? `, keeping --limit ${LIMIT}` : ''}.`);
    console.log('='.repeat(78));
    return;
  }

  console.log('='.repeat(78));
  console.log(`${LOG} APPLYING to ${planned.length} ticket(s)`);
  console.log('='.repeat(78));

  let closed = 0;
  let failed = 0;

  for (const target of planned) {
    const comment =
      `Not reproduced in run ${runId}.\n\n` +
      `Endpoint ${target.endpoint} was exercised by a non-skipped test in that run ` +
      `(${totals.total} tests: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped), ` +
      `and this defect (${target.hash}) was not among the ${present.size} findings.\n\n` +
      (target.resolution === 'INVALID'
        ? 'Resolved INVALID rather than FIXED: the original finding was an infrastructure-shaped ' +
          'status (403/502/503/504), so its disappearance most likely reflects the environment ' +
          'being repaired rather than an application change.\n\n'
        : '') +
      'Closed automatically by scripts/close-fixed-bugzilla-bugs.js. Reopen if it recurs — a ' +
      'later run will file a fresh ticket for the same fault if this one is closed.';

    const result = await call('PUT', `/bug/${target.id}`, {
      status: 'RESOLVED',
      resolution: target.resolution,
      comment: { body: comment },
    });

    if (result.ok) {
      closed += 1;
      console.log(`${LOG}   ✓ bug ${target.id} -> RESOLVED/${target.resolution}`);
    } else {
      failed += 1;
      console.error(
        `${LOG}   ! bug ${target.id} not resolved: ${result.error || result.status} ${(result.text || '').slice(0, 160)}`
      );
    }
  }

  console.log('');
  console.log('='.repeat(78));
  console.log(`${LOG} done — ${closed} resolved, ${failed} failed.`);
  if (failed) console.log(`${LOG} Re-running is safe: already-resolved tickets drop out of the open search.`);
  console.log('='.repeat(78));
}

main().catch((error) => {
  console.error(`${LOG} fatal:`, error);
  process.exit(1);
});
