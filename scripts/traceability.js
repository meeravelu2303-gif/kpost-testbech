#!/usr/bin/env node
/**
 * Requirement → test traceability matrix.
 *
 * Answers the question the test count cannot: "is FR-K10 Recall covered?". It scans every spec
 * in every suite for requirement tags of the form `[FR-K10]` / `[BR-K01]` / `[NFR-SEC02]` and
 * reports each requirement in `docs/requirements.json` as covered or not.
 *
 * ## Why it reads tags rather than inferring from test names
 *
 * Inference guesses. A tag is a claim the engineer made deliberately, which is the only thing
 * worth putting in front of a stakeholder. The cost is that an untagged test counts as no
 * coverage even when it genuinely exercises the requirement — so a gap in this report means
 * "not traced", which is not the same as "not tested". The report says so rather than implying
 * the stronger claim.
 *
 * ## Layers
 *
 * Each requirement records where it can honestly be proven. `manual` and `client` requirements
 * (performance targets, device-native share sheets) are reported separately and never counted
 * as automation gaps, because no bench in this repo can reach them.
 *
 *   node scripts/traceability.js            # human-readable summary
 *   node scripts/traceability.js --markdown # a table to paste into a report
 *   node scripts/traceability.js --strict   # exit 1 if an automatable requirement is untraced
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SPEC_ROOTS = [
  'suites/kpost-api/gate',
  'suites/kpost-api/tests',
  'suites/kpost-api/kmail/tests',
  'suites/kpost-api/admin/tests',
  'suites/kpost-ui/tests',
];
const TAG = /\[((?:FR|BR|NFR)-[A-Z]+\d*)\]/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.spec\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const { requirements } = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/requirements.json'), 'utf8')
);

/** requirement id -> [{file, line, title}] */
const hits = new Map();
let specCount = 0;

for (const root of SPEC_ROOTS) {
  for (const file of walk(path.join(ROOT, root))) {
    specCount++;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      // Only count a tag on a line that actually declares a test — a tag in a comment is
      // documentation, not coverage.
      if (!/\btest(?:\.\w+)?\s*\(/.test(line)) return;
      TAG.lastIndex = 0;
      let match;
      while ((match = TAG.exec(line))) {
        const id = match[1];
        if (!hits.has(id)) hits.set(id, []);
        hits.get(id).push({
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: index + 1,
        });
      }
    });
  }
}

const AUTOMATABLE = new Set(['api', 'ui']);
const automatable = requirements.filter((r) => AUTOMATABLE.has(r.layer));
const outOfScope = requirements.filter((r) => !AUTOMATABLE.has(r.layer));
const traced = automatable.filter((r) => hits.has(r.id));
const untraced = automatable.filter((r) => !hits.has(r.id));

// A tag naming a requirement that does not exist is a typo, and a silent one — the test looks
// traced and is counted nowhere.
const known = new Set(requirements.map((r) => r.id));
const unknownTags = [...hits.keys()].filter((id) => !known.has(id));

const pct = ((traced.length / automatable.length) * 100).toFixed(1);

/*
 * DEPTH, not just presence.
 *
 * A requirement traced by exactly one test is traced on paper only: one test proves one path,
 * and the negative and state-transition cases — the ones a defect actually hides in — are not
 * covered by it. A percentage hides that completely, which is why this reports tests-per-
 * requirement and calls out the thin ones by name.
 */
const DEPTH_TARGET = 3;
const depthOf = (r) => (hits.get(r.id) ?? []).length;
const highPriority = automatable.filter((r) => r.priority === 'High');
const thinHigh = highPriority.filter((r) => depthOf(r) > 0 && depthOf(r) < DEPTH_TARGET);
const meanHigh = highPriority.length
  ? (highPriority.reduce((sum, r) => sum + depthOf(r), 0) / highPriority.length).toFixed(1)
  : '0';

if (process.argv.includes('--markdown')) {
  console.log(`# Requirement traceability\n`);
  console.log(`${traced.length} of ${automatable.length} automatable requirements traced (${pct}%).\n`);
  console.log('| ID | Module | Pri | Tests | Requirement | Traced to |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of automatable) {
    const where = (hits.get(r.id) ?? []).map((h) => `${h.file}:${h.line}`).join('<br>') || '—';
    console.log(`| ${r.id} | ${r.module} | ${r.priority} | ${(hits.get(r.id) ?? []).length} | ${r.text} | ${where} |`);
  }
} else {
  console.log(`\nRequirement traceability — ${specCount} spec files scanned\n`);
  console.log(`  automatable requirements : ${automatable.length}`);
  console.log(`  traced to a tagged test  : ${traced.length}  (${pct}%)`);
  console.log(`  untraced                 : ${untraced.length}`);
  console.log(`  High-priority, 1-2 tests : ${thinHigh.length} of ${highPriority.length}  (target ${DEPTH_TARGET}+)`);
  console.log(`  mean tests per High req  : ${meanHigh}`);
  console.log(`  out of automation scope  : ${outOfScope.length} (manual/client-native)\n`);

  if (untraced.length) {
    console.log('UNTRACED — no test carries this requirement id:');
    for (const r of untraced) {
      console.log(`  ${r.id.padEnd(10)} ${r.priority.padEnd(6)} ${r.module.padEnd(16)} ${r.text}`);
    }
    console.log('\n  ("untraced" means no test claims it — some may in fact be covered by an');
    console.log('   untagged test. Tag it rather than assuming either way.)\n');
  }

  if (outOfScope.length) {
    console.log('OUT OF AUTOMATION SCOPE — verified by hand, not a bench gap:');
    for (const r of outOfScope) console.log(`  ${r.id.padEnd(10)} [${r.layer}] ${r.text}`);
    console.log('');
  }

  if (unknownTags.length) {
    console.log(`UNKNOWN TAGS — these ids are not in docs/requirements.json (typo?):`);
    for (const id of unknownTags) {
      for (const h of hits.get(id)) console.log(`  ${id.padEnd(10)} ${h.file}:${h.line}`);
    }
    console.log('');
  }

  console.log('TESTS PER REQUIREMENT — High priority\n');
  console.log(`  ${'ID'.padEnd(11)}${'MODULE'.padEnd(17)}TESTS  DEPTH`);
  for (const r of highPriority) {
    const n = depthOf(r);
    const bar = n === 0 ? '(untraced)' : n < DEPTH_TARGET ? '#'.repeat(n) + '  <- thin' : '#'.repeat(Math.min(n, 12));
    console.log(`  ${r.id.padEnd(11)}${String(r.module).padEnd(17)}${String(n).padStart(5)}  ${bar}`);
  }
  console.log('');

  if (thinHigh.length) {
    console.log(`THIN — a High-priority requirement with fewer than ${DEPTH_TARGET} tests proves one path only:`);
    for (const r of thinHigh) {
      console.log(`  ${r.id.padEnd(10)} ${String(depthOf(r)).padStart(2)} test(s)  ${r.text.slice(0, 74)}`);
    }
    console.log('');
  }
}
if (unknownTags.length) process.exit(1);
if (process.argv.includes('--strict') && untraced.length) process.exit(1);
