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
          body: (() => {
            /*
             * Brace counting alone over-ran into the FOLLOWING test — a destructuring line or
             * a template literal can leave the count unbalanced — and the next test's
             * assertions were then judged as this one's. FR-K21 was reported as using
             * handledCleanly() when its own body does not. Stop at the next test declaration.
             */
            const out = [];
            for (let k = index; k < lines.length; k++) {
              if (k > index && /^\s*test(?:\.\w+)?\s*\(/.test(lines[k])) break;
              out.push(lines[k]);
            }
            return out.join('\n');
          })(),
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
/*
 * BLOCKED is its own category, and deliberately not folded into "traced".
 *
 * A requirement whose tests exist but have never been able to run is not covered — it is a
 * promise of coverage. FR-M04 and BR-M01 are the case that forced this: both were carried by
 * a test that proved something else entirely, and when real tests were written, 6 of 7 skipped
 * against a mailbox the QA accounts cannot populate. Counting that as traced would report
 * coverage to a stakeholder that has never once executed.
 *
 * Set `blocked: "<reason, dated>"` on the requirement in docs/requirements.json. It is a
 * deliberate human declaration, not an inference — and the reason names what must change for
 * it to be lifted.
 */
const blocked = automatable.filter((r) => hits.has(r.id) && typeof r.blocked === 'string');
const traced = automatable.filter((r) => hits.has(r.id) && typeof r.blocked !== 'string');
const untraced = automatable.filter((r) => !hits.has(r.id));

// A blocked declaration on a requirement nothing tags is a bookkeeping error: there is no test
// to be blocked. Surfaced rather than silently ignored.
const blockedWithoutTests = automatable.filter(
  (r) => !hits.has(r.id) && typeof r.blocked === 'string'
);

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
/*
 * TOLERANT ASSERTION — a different problem from thin coverage, and a worse one.
 *
 * A thin requirement has too few tests. A tolerant one has a test that cannot fail in the
 * direction the requirement cares about. FR-K21 "a recipient can Reply" was satisfied by
 * `handledCleanly`, which accepts any non-5xx — so the server REJECTING the reply passed it.
 * That is a wrong assertion under a right tag: the requirement reads as covered, and adding
 * more tests of the same shape would not fix it.
 *
 * Reported separately so it does not disappear into the thin list, where the remedy is
 * "write more" rather than "this one is wrong".
 */
const TOLERANT = [
  [/handledCleanly\s*\(/, 'handledCleanly() — passes on a 400, so a refusal satisfies the requirement'],
  [/toBeLessThan\(\s*500\s*\)/, 'toBeLessThan(500) — passes on a 404, a 401 and a 302'],
];

/** A status set naming both a success and a client error: both outcomes cannot be correct. */
function acceptsSuccessAndRefusal(body) {
  for (const m of body.matchAll(/\[([\s\d,]+)\]/g)) {
    const codes = m[1].split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
    if (codes.length > 1 && codes.some((c) => c >= 200 && c < 300) && codes.some((c) => c >= 400 && c < 500)) return true;
  }
  return false;
}

const tolerant = [];
for (const r of automatable) {
  for (const h of hits.get(r.id) ?? []) {
    /*
     * Comments are stripped first. A test that EXPLAINS why it replaced a tolerant assertion
     * names the old helper in its own comment, and matching that reported the fixed test as
     * still broken — FR-K21 was flagged for the sentence describing its own repair.
     */
    const body = (h.body ?? '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    const reasons = TOLERANT.filter(([re]) => re.test(body)).map(([, why]) => why);
    if (acceptsSuccessAndRefusal(body)) {
      reasons.push('status set accepts both a 2xx and a 4xx — success and refusal both pass');
    }
    if (reasons.length) tolerant.push({ id: r.id, priority: r.priority, text: r.text, where: `${h.file}:${h.line}`, reasons });
  }
}
const tolerantIds = new Set(tolerant.map((t) => t.id));

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
  console.log('| ID | Module | Pri | Status | Tests | Requirement | Traced to |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of automatable) {
    const where = (hits.get(r.id) ?? []).map((h) => `${h.file}:${h.line}`).join('<br>') || '—';
    const status = typeof r.blocked === 'string' ? 'BLOCKED' : hits.has(r.id) ? 'traced' : 'untraced';
    console.log(`| ${r.id} | ${r.module} | ${r.priority} | ${status} | ${(hits.get(r.id) ?? []).length} | ${r.text} | ${where} |`);
  }
} else {
  console.log(`\nRequirement traceability — ${specCount} spec files scanned\n`);
  console.log(`  automatable requirements : ${automatable.length}`);
  console.log(`  traced to a tagged test  : ${traced.length}  (${pct}%)`);
  console.log(`  untraced                 : ${untraced.length}`);
  console.log(`  blocked (never ran)      : ${blocked.length}`);
  console.log(`  tolerant assertion       : ${tolerantIds.size} requirement(s), ${tolerant.length} test(s)`);
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

  if (blocked.length) {
    console.log('BLOCKED — tests exist but cannot execute here, so this is NOT coverage:');
    for (const r of blocked) {
      console.log(`  ${r.id.padEnd(10)} ${r.priority.padEnd(6)} ${r.module}`);
      console.log(`             ${r.blocked}`);
    }
    console.log('');
  }

  if (blockedWithoutTests.length) {
    console.log('BLOCKED BUT UNTAGGED — declared blocked with no test carrying the id:');
    for (const r of blockedWithoutTests) console.log(`  ${r.id}`);
    console.log('');
  }

  if (tolerant.length) {
    console.log('TOLERANT ASSERTION — the tag is right, the assertion cannot fail for it:');
    for (const t of tolerant) {
      console.log(`  ${t.id.padEnd(10)} ${String(t.priority).padEnd(6)} ${t.where}`);
      console.log(`             requires: ${t.text}`);
      for (const why of t.reasons) console.log(`             but      : ${why}`);
    }
    console.log('');
    console.log('  These need the assertion REPLACED, not more tests added — they are not thin.');
    console.log('');
  }

  console.log('TESTS PER REQUIREMENT — High priority\n');
  console.log(`  ${'ID'.padEnd(11)}${'MODULE'.padEnd(17)}TESTS  DEPTH`);
  for (const r of highPriority) {
    const n = depthOf(r);
    const bar = n === 0 ? '(untraced)' : tolerantIds.has(r.id) ? '#'.repeat(n) + '  <- TOLERANT' : n < DEPTH_TARGET ? '#'.repeat(n) + '  <- thin' : '#'.repeat(Math.min(n, 12));
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
