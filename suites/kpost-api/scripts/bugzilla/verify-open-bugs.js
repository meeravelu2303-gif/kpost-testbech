#!/usr/bin/env node
/**
 * Re-runs only the tests behind the currently OPEN Bugzilla tickets.
 *
 * The full suite is ~4,570 tests and ~16 minutes. When the question is narrowly "have the
 * open defects been fixed?", almost all of that is wasted work. This resolves each open
 * ticket to the exact test cases that observed it and runs just those.
 *
 * How a ticket becomes a test case:
 *
 *   Bugzilla summary "[BUG-API-XXXXXX] ..."  ->  the defect of that id in BUG_REPORT.json
 *   ->  its `observedByTests` (Playwright TestCase ids)  ->  file:line, via `--list`.
 *
 * Playwright accepts `file.spec.ts:LINE` as a positional filter, so the selection is exact
 * and needs no regex at all - which also means no quoting or escaping can silently mangle it.
 *
 * Two things it is deliberately careful about:
 *
 * 1. IT MUST NOT PUBLISH. `publishingGate()` counts tests collected *after* the filter, so a
 *    40-test run looks 100% executed and passes the gate as though it were a complete run.
 *    Left alone that fragment would be POSTed to the QA Dashboard, appended to the trend
 *    history as a run point, and pushed at Bugzilla. The child is always started with
 *    `--reporter=line`, which overrides every configured reporter and shuts all four tiers
 *    and all three dispatchers off.
 *
 * 2. IT REPORTS PASS/FAIL ONLY. globalSetup calls resetBugLedger(), and with the reporters
 *    overridden nothing recompiles the ledger afterwards, so BUG_REPORT.md / .json are left
 *    as the stub globalSetup wrote. Read the console, not the ledger. Run the bare `npm test`
 *    when you want the artifacts - and note that doing so also refreshes the BUG_REPORT.json
 *    this script reads to resolve tickets.
 *
 * Usage:
 *   npm run verify:open              # show the plan, run nothing
 *   npm run verify:open -- --list    # collect the selected tests, without calling the API
 *   npm run verify:open -- --run     # run them
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const URL_BASE = (process.env.BUGZILLA_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.BUGZILLA_API_KEY || '';
const PRODUCT = process.env.BUGZILLA_PRODUCT || 'KPost API';
const PW_CLI = require.resolve('@playwright/test/cli');

/**
 * How many observing tests to keep per defect.
 *
 * A systemic defect is observed by hundreds of tests - one missing security header seen on
 * 266 routes. Re-running all of them proves nothing the first two do not, and it would drag
 * most of the suite back into a run whose entire point was to be small. Narrowing is reported
 * in the plan rather than applied silently.
 */
const REPRESENTATIVES_PER_DEFECT = 2;

if (!URL_BASE || !API_KEY) {
  console.error('BUGZILLA_URL and BUGZILLA_API_KEY must be set in .env');
  process.exit(1);
}

async function bz(p) {
  const res = await fetch(`${URL_BASE}${p}${p.includes('?') ? '&' : '?'}api_key=${API_KEY}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

/** Every test in the suite, keyed by Playwright's TestCase id - the same id the ledger stores. */
function indexTests() {
  const res = spawnSync(process.execPath, [PW_CLI, 'test', '--list', '--reporter=json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    console.error('Could not list the suite. Playwright said:\n' + (res.stderr || res.stdout || '').slice(0, 800));
    process.exit(1);
  }

  const byId = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      byId.set(spec.id, {
        // `file` is relative to rootDir (tests/); Playwright wants a path it can resolve.
        location: `tests/${String(spec.file).replace(/\\/g, '/')}:${spec.line}`,
        title: spec.title,
      });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);
  return byId;
}

(async () => {
  const list = await bz(`/bug?product=${encodeURIComponent(PRODUCT)}&resolution=---&include_fields=id,summary,severity&limit=0`);
  const open = (list.bugs || []).sort((a, b) => a.id - b.id);
  if (open.length === 0) {
    console.log('No open tickets in Bugzilla - nothing to verify.');
    return;
  }

  const ledgerPath = path.join(ROOT, 'BUG_REPORT.json');
  if (!fs.existsSync(ledgerPath)) {
    console.error('BUG_REPORT.json not found - run the full `npm test` once so tickets can be resolved.');
    process.exit(1);
  }
  const ledger = new Map(
    ((JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).defects) || []).map((d) => [d.id, d])
  );

  console.log(`open tickets: ${open.length}`);
  console.log('listing the suite to resolve them to test locations...\n');
  const byId = indexTests();

  const locations = new Map();   // "file:line" -> Set of bug ids
  const narrowed = [];           // [bugId, observed, kept]
  const unresolved = [];

  for (const bug of open) {
    const tag = String(bug.summary).match(/\[(BUG-API-[0-9A-F]+)\]/);
    const defect = tag && ledger.get(tag[1]);
    const observed = (defect?.observedByTests || []).filter((t) => byId.has(t));

    if (observed.length === 0) { unresolved.push(bug); continue; }
    if (observed.length > REPRESENTATIVES_PER_DEFECT) {
      narrowed.push([bug.id, observed.length, REPRESENTATIVES_PER_DEFECT]);
    }
    for (const id of observed.slice(0, REPRESENTATIVES_PER_DEFECT)) {
      const loc = byId.get(id).location;
      if (!locations.has(loc)) locations.set(loc, new Set());
      locations.get(loc).add(bug.id);
    }
  }

  const selected = [...locations.keys()].sort();
  console.log(`resolved to ${selected.length} test case(s) across ${new Set(selected.map((s) => s.split(':')[0])).size} file(s):\n`);
  for (const loc of selected) {
    const ids = [...locations.get(loc)].sort((a, b) => a - b);
    console.log(`  ${loc.padEnd(46)} bug ${ids.join(', ')}`);
  }

  if (narrowed.length) {
    console.log(`\n  systemic - kept ${REPRESENTATIVES_PER_DEFECT} representative test(s) of many:`);
    for (const [id, observed, kept] of narrowed.sort((a, b) => b[1] - a[1])) {
      console.log(`    bug ${id} was observed by ${observed} tests, running ${kept}`);
    }
  }

  if (unresolved.length) {
    console.log('\n  NOT RESOLVED - no entry in the current BUG_REPORT.json, so these are NOT');
    console.log('  in the run below. They predate the last full run, or their test was removed:');
    for (const b of unresolved) console.log(`    bug ${b.id}  ${String(b.summary).slice(0, 64)}`);
  }

  if (selected.length === 0) {
    console.log('\nNothing to run.');
    return;
  }

  // --reporter=line is not a preference: it is what keeps this partial run from being
  // published as a complete one. See the header.
  const flags = ['test', ...selected, '--reporter=line'];
  console.log(`\nequivalent command:\n  npx playwright test ${selected.join(' ')} --reporter=line\n`);

  const listOnly = process.argv.includes('--list');
  if (listOnly) flags.push('--list');

  if (!listOnly && !process.argv.includes('--run')) {
    console.log('Nothing was run. Re-invoke with --run to execute, or --list to see the');
    console.log('selected tests without contacting the API.');
    return;
  }

  // A raw pass/fail count cannot be acted on - "10 passed" says nothing about WHICH defects
  // are gone. The json reporter is added alongside line so each result can be mapped back to
  // the ticket it belongs to. --reporter still overrides the configured ones entirely, so
  // this adds a machine-readable copy without re-enabling any publisher.
  const resultsPath = path.join(ROOT, '.verify-open-results.json');
  if (!listOnly) {
    flags.push('--reporter=line,json');
    console.log('Running. Reporters are overridden, so nothing is filed to Bugzilla, the QA');
    console.log('Dashboard, or the trend history - and BUG_REPORT.md is left as a stub.\n');
  }

  // Spawned WITHOUT a shell, straight at Playwright's own cli.js, so no shell dialect gets a
  // vote on how the arguments are parsed.
  const res = spawnSync(process.execPath, [PW_CLI, ...flags], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: resultsPath },
  });

  if (listOnly) process.exit(res.status ?? 1);
  verdicts(resultsPath, locations, new Map(narrowed.map(([id, observed]) => [id, observed])));
  process.exit(res.status ?? 1);
})();

/**
 * Turns per-test results back into a per-ticket verdict.
 *
 * A ticket is only reported as no longer reproducing when EVERY test that was run for it
 * passed - one green sample among several does not clear a defect.
 */
function verdicts(resultsPath, locations, systemic) {
  if (!fs.existsSync(resultsPath)) {
    console.log('\n(no machine-readable results were written, so no per-ticket verdict)');
    return;
  }
  const report = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

  const outcomeByLocation = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      outcomeByLocation.set(`tests/${String(spec.file).replace(/\\/g, '/')}:${spec.line}`, spec.ok);
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);

  const perBug = new Map();   // bug id -> { passed, failed }
  for (const [loc, bugIds] of locations) {
    const ok = outcomeByLocation.get(loc);
    if (ok === undefined) continue;
    for (const id of bugIds) {
      if (!perBug.has(id)) perBug.set(id, { passed: 0, failed: 0 });
      perBug.get(id)[ok ? 'passed' : 'failed'] += 1;
    }
  }

  const clear = [...perBug].filter(([, v]) => v.failed === 0).map(([id]) => id).sort((a, b) => a - b);
  const still = [...perBug].filter(([, v]) => v.failed > 0).map(([id]) => id).sort((a, b) => a - b);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`STILL REPRODUCES - leave open: ${still.length}`);
  console.log('='.repeat(72));
  for (const id of still) console.log(`  bug ${id}`);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`NO LONGER REPRODUCES - candidates to close: ${clear.length}`);
  console.log('='.repeat(72));
  for (const id of clear) {
    const n = systemic.get(id);
    console.log(`  bug ${id}${n ? `   CAUTION: systemic - only 2 of ${n} observing tests ran` : ''}`);
  }
  if (clear.some((id) => systemic.has(id))) {
    console.log('\n  A systemic defect is NOT cleared by its samples passing. Re-run those');
    console.log('  tickets against the full suite before closing them.');
  }
  console.log(`\nper-ticket detail written to ${path.relative(ROOT, resultsPath)}`);
}
