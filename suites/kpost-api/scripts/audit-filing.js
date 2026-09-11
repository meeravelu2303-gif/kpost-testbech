#!/usr/bin/env node
/**
 * Pre-flight check — run this BEFORE setting BUGZILLA_DRY_RUN=false.
 *
 * Everything that reaches Bugzilla is permanent in practice: a wrong ticket costs a developer's
 * afternoon, and a hundred wrong tickets cost the report its credibility. This refuses the
 * filing if the report is not safe to send, and says exactly which ticket and why.
 *
 * It re-applies the same contradictions `recordBug`'s validity gate enforces at write time,
 * because the report on disk may predate a gate rule — the ledger is only re-gated on the run
 * that produced it.
 *
 *   node scripts/audit-filing.js              offline checks only
 *   node scripts/audit-filing.js --live       also verifies every module maps to a real
 *                                             Bugzilla component on the configured product
 *
 * Exit 0 = safe to file. Exit 1 = do not flip the flag.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'BUG_REPORT.json');

/** Values the ledger uses for a claim that could not be evaluated. */
const BENCH_FAULT =
  /AuthenticationUnavailableError|could not be evaluated|No authenticated session could be established|BENCH FAULT/i;

function httpStatusOf(actual) {
  const direct = /HTTP (\d{3})/.exec(actual);
  if (direct) return Number(direct[1]);
  const envelope = /"statusCode"\s*:\s*(\d{3})/.exec(actual);
  return envelope ? Number(envelope[1]) : NaN;
}

/** The write-time gate, re-applied to a report that may predate a rule. */
function contradiction(d) {
  const claim = `${d.title ?? ''} ${d.description ?? ''}`;
  const actual = String(d.actual ?? '');
  const status = httpStatusOf(actual);

  if (BENCH_FAULT.test(`${claim} ${actual}`)) {
    return 'the assertion never ran (bench fault) — there is no verdict to file';
  }

  const declaredPublic = /declared public|contract marks|route is public/i.test(claim);
  const claimsExposure =
    /expos|disclos|leak(?!s? database internals)|bypass|another user'?s|enumerat|smuggl/i.test(claim);
  if (claimsExposure && (status === 401 || status === 403) && !declaredPublic) {
    return `claims exposure or bypass but the recorded response is HTTP ${status} — the server refused the request`;
  }

  if (/enumerat/i.test(claim) && status === 404) {
    return 'claims identifiers are enumerable but the recorded response is HTTP 404 — nothing resolved';
  }

  if (d.classification === 'Idempotency / Concurrency' && (status === 401 || status === 403)) {
    return `claims a concurrency fault but the recorded response is HTTP ${status} — two identical refusals are correct gating`;
  }

  return null;
}

async function bugzillaComponents() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return null;
  const env = fs.readFileSync(envPath, 'utf8');
  const read = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim();
  const url = read('BUGZILLA_URL');
  const key = read('BUGZILLA_API_KEY');
  const product = read('BUGZILLA_PRODUCT');
  if (!url || !key || !product) return null;

  try {
    const response = await fetch(
      `${url}/product?names=${encodeURIComponent(product)}&api_key=${encodeURIComponent(key)}`
    );
    const body = await response.json();
    const found = (body.products ?? [])[0];
    if (!found) return { product, components: null };
    return { product, components: new Set((found.components ?? []).map((c) => c.name)) };
  } catch {
    return { product, components: null };
  }
}

async function main() {
  if (!fs.existsSync(REPORT)) {
    console.log('\n[filing] FAIL — no BUG_REPORT.json. Run the suite first.\n');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const defects = report.defects ?? [];
  const problems = [];

  // --- 1. contradictions the gate would have refused -----------------------------------------
  for (const d of defects) {
    const why = contradiction(d);
    if (why) problems.push({ kind: 'INVALID', id: d.id, detail: `${d.title?.slice(0, 70)} — ${why}` });
  }

  // --- 2. duplicates: two tickets that a single fix would close together ---------------------
  const byKey = new Map();
  for (const d of defects) {
    const key = `${d.dedupeKey || d.title}::${d.method}::${d.endpointPath}`;
    byKey.set(key, (byKey.get(key) ?? []).concat(d.id));
  }
  for (const [key, ids] of byKey) {
    if (ids.length > 1) {
      problems.push({ kind: 'DUPLICATE', id: ids.join(' + '), detail: key.slice(0, 90) });
    }
  }

  // --- 3. fields a developer needs to act -----------------------------------------------------
  for (const d of defects) {
    const missing = ['id', 'title', 'severity', 'method', 'endpointPath', 'classification']
      .filter((f) => !d[f])
      .concat(d.reproSnippet || d.curlSnippet ? [] : ['repro']);
    if (missing.length) {
      problems.push({ kind: 'INCOMPLETE', id: d.id ?? '(no id)', detail: `missing: ${missing.join(', ')}` });
    }
  }

  // --- 4. a Critical must rest on something that reached the application ---------------------
  for (const d of defects.filter((x) => x.severity === 'Critical')) {
    const status = httpStatusOf(String(d.actual ?? ''));
    if ([404, 405].includes(status)) {
      problems.push({
        kind: 'CRITICAL-WEAK',
        id: d.id,
        detail: `Critical evidenced by HTTP ${status} — the request never reached the handler`,
      });
    }
  }

  // --- 5. every module must be a real component on the product -------------------------------
  const live = process.argv.includes('--live') ? await bugzillaComponents() : null;
  const modules = [...new Set(defects.map((d) => d.module))];
  for (const m of modules) {
    if (m === 'Unclassified') {
      const n = defects.filter((d) => d.module === m).length;
      problems.push({ kind: 'NO-COMPONENT', id: `${n} ticket(s)`, detail: '"Unclassified" is not a Bugzilla component — these reach no owner' });
    } else if (live?.components && !live.components.has(m)) {
      const n = defects.filter((d) => d.module === m).length;
      problems.push({ kind: 'NO-COMPONENT', id: `${n} ticket(s)`, detail: `module "${m}" is not a component on "${live.product}"` });
    }
  }

  // --- report ---------------------------------------------------------------------------------
  const bySeverity = defects.reduce((acc, d) => ({ ...acc, [d.severity]: (acc[d.severity] ?? 0) + 1 }), {});
  const willFile = process.env.BUGZILLA_FILE_ASSERTION_FAILURES === 'true'
    ? defects.length
    : defects.filter((d) => d.classification !== 'Assertion Failure').length;

  console.log('\nKPOST filing pre-flight\n');
  console.log(`  tickets in report     : ${defects.length}`);
  console.log(`  would file            : ${willFile}   (BUGZILLA_FILE_ASSERTION_FAILURES=${process.env.BUGZILLA_FILE_ASSERTION_FAILURES ?? 'false'})`);
  console.log(`  severity              : ${JSON.stringify(bySeverity)}`);
  console.log(`  modules               : ${modules.length}`);
  if (live) {
    console.log(
      `  Bugzilla product      : ${live.components ? `${live.product} (${live.components.size} components)` : `${live.product} — UNREACHABLE, component check skipped`}`
    );
  }
  console.log(`  problems              : ${problems.length}\n`);

  if (problems.length) {
    console.log('=== DO NOT FILE — fix these first ===\n');
    for (const p of problems) {
      console.log(`  [${p.kind}] ${p.id}`);
      console.log(`      ${p.detail}\n`);
    }
    console.log('[filing] FAIL — leave BUGZILLA_DRY_RUN=true\n');
    process.exit(1);
  }

  console.log('  no contradictions, no duplicates, every ticket complete and routable.');
  console.log('\n[filing] PASS — safe to set BUGZILLA_DRY_RUN=false for one run\n');
}

main();
