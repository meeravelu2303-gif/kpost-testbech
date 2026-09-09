#!/usr/bin/env node
/**
 * Backfills the summaries of already-filed input-validation tickets to the outcome-accurate
 * wording introduced in `assertRejectsInvalidInput`.
 *
 * ## Why this exists
 *
 * Before the fix, every non-4xx outcome of an invalid-input case produced the SAME title —
 * `"<scenario> is not rejected with 400/422"` — whether the input was *accepted* (HTTP 2xx,
 * a missing-validation / corrupt-row bug) or *crashed* the endpoint (HTTP 5xx, an unhandled
 * NPE). Those are different faults with different fixes, but the identical summary made them
 * read as duplicates in Bugzilla. The source now titles each by its actual outcome; the defect
 * **id is unchanged** (it is pinned via `identityTitle`), so a re-run comments on the same
 * ticket — but the summary already on the ticket still shows the old wording until this runs.
 *
 * This script derives the new title from each defect's `classification` + observed HTTP status
 * in the CURRENT `BUG_REPORT.json` (no re-run needed) and updates the matching Bugzilla ticket's
 * summary in place, keyed by the `[<id>]` tag. The tag — and therefore dedup — is untouched.
 *
 * ## Safety (matches the other bugzilla maintenance scripts)
 *   - dry run is the DEFAULT and prints the full plan;
 *   - `--apply` is required to write and refuses without `--yes`;
 *   - `--limit N` stages the rollout; re-running is safe (a ticket already at the new wording is
 *     skipped), and only the summary text changes — never the tag, status, or any other field.
 *
 * Usage:
 *   node scripts/bugzilla/relabel-input-validation.js                 # admin bench, dry run
 *   node scripts/bugzilla/relabel-input-validation.js --bench .       # KPost API bench, dry run
 *   node scripts/bugzilla/relabel-input-validation.js --apply --yes   # write (admin)
 *   node scripts/bugzilla/relabel-input-validation.js --bench . --apply --yes --limit 10
 */
const fs = require('fs');
const path = require('path');

const LOG = '[relabel-input-validation]';
const TIMEOUT_MS = 20_000;
const OLD_SUFFIX = ' is not rejected with 400/422';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
const bi = argv.indexOf('--bench');
const BENCH = bi !== -1 ? argv[bi + 1] : 'admin';
const li = argv.indexOf('--limit');
const LIMIT = li !== -1 ? Number(argv[li + 1]) : 0;

if (APPLY && !CONFIRMED) {
  console.error(`${LOG} --apply also requires --yes. Read the dry-run plan first, then re-run with both flags.`);
  process.exit(2);
}

// Repo root is the parent of scripts/; the bench dir is resolved against it ("." = KPost root).
const ROOT = path.resolve(__dirname, '..', '..');
const BENCH_DIR = path.resolve(ROOT, BENCH);

function loadEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#')) o[m[1]] = m[2];
  }
  return o;
}

/** Derives the outcome-accurate title — MUST stay identical to assertRejectsInvalidInput. */
function newTitleFor(defect) {
  const scenario = defect.title.slice(0, -OLD_SUFFIX.length);
  const m = String(defect.actual || '').match(/HTTP (\d{3})/);
  const httpStatus = m ? m[1] : '5xx';
  if (defect.classification === 'Input Validation Gap') return `Invalid input accepted: ${scenario}`;
  if (defect.classification === 'Unhandled NPE / Server Error')
    return `${scenario} triggers a server error (HTTP ${httpStatus}) instead of 400/422`;
  return `${scenario} is rejected with HTTP ${httpStatus} instead of 400/422`;
}

async function bz(base, key, method, pathAndQuery, body) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${base}${pathAndQuery}${sep}api_key=${encodeURIComponent(key)}`;
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
  const env = loadEnv(path.join(BENCH_DIR, '.env'));
  const BASE = (env.BUGZILLA_URL || '').replace(/\/+$/, '');
  const KEY = env.BUGZILLA_API_KEY;
  const PRODUCT = env.BUGZILLA_PRODUCT;
  const reportPath = path.join(BENCH_DIR, 'BUG_REPORT.json');

  if (!BASE || !KEY || !PRODUCT) {
    console.error(`${LOG} BUGZILLA_URL / BUGZILLA_API_KEY / BUGZILLA_PRODUCT missing in ${BENCH_DIR}/.env`);
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`${LOG} ${reportPath} not found — run the bench first.`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const defects = report.defects || [];
  // Only the input-validation defects carry the old shared title.
  const targets = new Map(); // id -> newTitle
  for (const d of defects) {
    if (typeof d.title === 'string' && d.title.endsWith(OLD_SUFFIX)) targets.set(d.id, newTitleFor(d));
  }
  console.log(`${LOG} bench "${BENCH}" | product "${PRODUCT}" | input-validation defects in report: ${targets.size}`);
  if (targets.size === 0) { console.log(`${LOG} nothing to relabel (report already uses the new wording).`); return; }

  const res = await bz(BASE, KEY, 'GET', `/bug?product=${encodeURIComponent(PRODUCT)}&include_fields=id,summary,is_open`);
  const bugs = (res.json && res.json.bugs) || [];

  const plan = [];
  for (const b of bugs) {
    if (b.is_open === false) continue;
    const m = (b.summary || '').match(/\[(BUG-API-[0-9A-F]{6})\]/);
    if (!m) continue;
    const tag = m[1];
    const newTitle = targets.get(tag);
    if (!newTitle) continue; // not an input-validation ticket
    const wanted = `[${tag}] ${newTitle}`;
    if (b.summary === wanted) continue; // already relabelled — idempotent
    plan.push({ id: b.id, tag, from: b.summary, to: wanted });
  }

  console.log(`${LOG} open tickets needing a summary update: ${plan.length}`);
  if (plan.length === 0) { console.log(`${LOG} nothing to do.`); return; }

  const batch = LIMIT > 0 ? plan.slice(0, LIMIT) : plan;
  console.log(`\n${LOG} plan${LIMIT > 0 ? ` (first ${batch.length} of ${plan.length})` : ''}:`);
  batch.forEach((p) => {
    console.log(`  bug ${p.id}  ${p.tag}`);
    console.log(`     OLD: ${p.from.replace(/\s+/g, ' ')}`);
    console.log(`     NEW: ${p.to.replace(/\s+/g, ' ')}`);
  });

  if (!APPLY) {
    console.log(`\n${LOG} DRY RUN — no changes made. Re-run with --apply --yes to write these summaries.`);
    return;
  }

  let done = 0, failed = 0;
  for (const p of batch) {
    const r = await bz(BASE, KEY, 'PUT', `/bug/${p.id}`, { ids: [p.id], summary: p.to });
    if (r.ok) { done++; } else { failed++; console.warn(`  ${LOG} bug ${p.id} FAILED: HTTP ${r.status} ${r.text.slice(0, 120)}`); }
  }
  console.log(`\n${LOG} updated ${done} summaries, ${failed} failed${LIMIT > 0 && plan.length > batch.length ? `; ${plan.length - batch.length} left (raise --limit)` : ''}.`);
})().catch((e) => { console.error(`${LOG} ERROR`, e.message); process.exit(1); });
