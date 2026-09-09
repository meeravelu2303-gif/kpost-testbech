#!/usr/bin/env node
/**
 * Closes KMail Bugzilla tickets whose defect no longer reproduces.
 *
 * KMail's reporter files and comments on recurring defects but never *closes* one — a passing
 * test says nothing to Bugzilla. So after the developers fix a defect, its ticket stays open
 * forever and the product's bug count only ever rises. This closes that gap from the other
 * end: it reads the freshest `kmail/BUG_REPORT.json`, and resolves the open KMail tickets whose
 * `KM-XXXXXX` id is NOT in that report (i.e. the defect did not recur this run) as FIXED.
 *
 * ## "Absent from the report" only means "fixed" after a FULL run
 *
 * A defect is absent from a run for two very different reasons, and only one justifies closing:
 *   1. it was genuinely fixed                       -> close FIXED
 *   2. its test never ran (a single-project run)    -> DO NOT CLOSE, nothing was verified
 *
 * KPost's close-fixed distinguishes these per endpoint from its run model's `tests[]`. KMail's
 * BUG_REPORT.json has no per-test list, so this script enforces the safety at the RUN level:
 * it refuses to act unless the report is a FULL suite run (>= FULL_RUN_MIN tests). Run the whole
 * suite (`npm run test:kmail`) before closing — never a single `--project`.
 *
 * ## Safety (matches the KPost / reconcile scripts)
 *   - dry run is the DEFAULT and prints the complete plan;
 *   - `--apply` is required to write, and refuses to run without `--yes`;
 *   - `--limit N` stages the rollout; re-running is safe (an already-resolved ticket is skipped);
 *   - Bugzilla has no delete — every write here is one-way (RESOLVED/FIXED, reversible only by a human reopening).
 *
 * Usage:
 *   node scripts/bugzilla/close-fixed-kmail.js                   # dry run, full plan
 *   node scripts/bugzilla/close-fixed-kmail.js --apply --yes     # resolve FIXED
 *   node scripts/bugzilla/close-fixed-kmail.js --apply --yes --limit 10
 */
const fs = require('fs');
const path = require('path');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
const LOG = '[kmail-close-fixed]';
const FULL_RUN_MIN = 600; // the KMail suite is ~815 tests; below this it was a partial run
const TIMEOUT_MS = 20_000;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
const li = argv.indexOf('--limit');
const LIMIT = li !== -1 ? Number(argv[li + 1]) : 0;

if (APPLY && !CONFIRMED) {
  console.error(`${LOG} --apply also requires --yes. Bugzilla has no delete, only resolve — every write is one-way.`);
  console.error(`${LOG} Read the dry-run plan first, then re-run with both flags.`);
  process.exit(2);
}

function loadEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#')) o[m[1]] = m[2];
  }
  return o;
}

const env = loadEnv(path.join(ROOT, 'kmail', '.env'));
const BASE = (env.BUGZILLA_URL || '').replace(/\/+$/, '');
const KEY = env.BUGZILLA_API_KEY;
const PRODUCT = env.BUGZILLA_PRODUCT || 'KMail API';

if (!BASE || !KEY) {
  console.error(`${LOG} BUGZILLA_URL / BUGZILLA_API_KEY not set in kmail/.env — nothing to do.`);
  process.exit(1);
}

async function bz(method, pathAndQuery, body) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}api_key=${encodeURIComponent(KEY)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const reportPath = path.join(ROOT, 'kmail', 'BUG_REPORT.json');
  if (!fs.existsSync(reportPath)) {
    console.error(`${LOG} kmail/BUG_REPORT.json not found — run \`npm run test:kmail\` first.`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const total = report.run?.totalTests ?? 0;
  console.log(`${LOG} report: ${report.defects?.length ?? 0} defect(s) from a run of ${total} test(s) on ${report.run?.environment} at ${report.run?.generatedAt}`);

  if (total < FULL_RUN_MIN) {
    console.error(`${LOG} REFUSING: the report has only ${total} tests (< ${FULL_RUN_MIN}). That is a partial run — closing on it would close bugs whose tests never ran. Run the FULL suite (\`npm run test:kmail\`) then retry.`);
    process.exit(1);
  }

  const reproducing = new Set((report.defects || []).map((d) => d.id)); // KM-ids still reproducing this run

  // Open KMail tickets this bench filed (carry a [KM-XXXXXX] tag).
  const res = await bz('GET', `/bug?product=${encodeURIComponent(PRODUCT)}&include_fields=id,summary,is_open,status,resolution`);
  const bugs = (res.json && res.json.bugs) || [];
  const open = bugs.filter((b) => b.is_open !== false);

  const toClose = [];
  for (const b of open) {
    const m = (b.summary || '').match(/\[(KM-[0-9A-F]{6})\]/);
    if (!m) continue; // never touch a ticket this bench did not file
    if (reproducing.has(m[1])) continue; // still reproduces — leave open
    toClose.push({ id: b.id, tag: m[1], summary: b.summary });
  }

  console.log(`${LOG} open KMail tickets: ${open.length} | still reproducing: ${open.length - toClose.length} | NO LONGER reproduce -> FIXED: ${toClose.length}`);
  if (toClose.length === 0) { console.log(`${LOG} nothing to close.`); return; }

  const batch = LIMIT > 0 ? toClose.slice(0, LIMIT) : toClose;
  console.log(`\n${LOG} plan${LIMIT > 0 ? ` (first ${batch.length} of ${toClose.length})` : ''}:`);
  batch.forEach((b) => console.log(`  bug ${b.id}  ${b.tag}  -> RESOLVED/FIXED  | ${b.summary.replace(/\s+/g, ' ').slice(0, 80)}`));

  if (!APPLY) {
    console.log(`\n${LOG} DRY RUN — no changes made. Re-run with --apply --yes to resolve these as FIXED.`);
    return;
  }

  let done = 0, failed = 0;
  const comment = `No longer reproduces as of the KMail automation run on ${report.run?.generatedAt} (${report.run?.environment}). Resolving FIXED.`;
  for (const b of batch) {
    const r = await bz('PUT', `/bug/${b.id}`, { ids: [b.id], status: 'RESOLVED', resolution: 'FIXED', comment: { body: comment } });
    if (r.ok) { done++; } else { failed++; console.warn(`  ${LOG} bug ${b.id} FAILED: HTTP ${r.status} ${r.text.slice(0, 120)}`); }
  }
  console.log(`\n${LOG} resolved ${done} FIXED, ${failed} failed${LIMIT > 0 && toClose.length > batch.length ? `; ${toClose.length - batch.length} left (raise --limit)` : ''}.`);
})().catch((e) => { console.error(`${LOG} ERROR`, e.message); process.exit(1); });
