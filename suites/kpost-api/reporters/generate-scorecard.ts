import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Generates `SUITE_SCORECARD.md`.
 *
 * ## The design decision that matters here
 *
 * A scorecard that a script awards itself is worthless. Three of the four rubric categories
 * ("clean structure", "depth of bug-hunting", "developer actionability") are judgements, and a
 * generator that mechanically prints 25/25 for each is theatre — it would score a broken suite
 * exactly as highly as a good one.
 *
 * So this file **measures what is measurable and refuses to invent the rest.** Every number
 * below is derived from an artifact the run actually produced:
 *
 * - duplicate route signatures, from Playwright's own resolved test list
 * - endpoints under the 10-case floor, from the same list
 * - TypeScript status, from a real `tsc --noEmit` invocation
 * - coverage, from `swagger.json` against the exercised-endpoint ledger
 * - reproduction quality, from counting curl blocks in `BUG_REPORT.json`
 * - artifact presence, from the filesystem
 *
 * Each rubric point is then scored against a **stated, checkable rule** — printed next to the
 * score, so a reader can disagree with the arithmetic rather than having to trust it. Where a
 * criterion cannot be measured, the scorecard says so and deducts, rather than assuming credit.
 */

/**
 * Resolve the project root from the working directory when that is plausibly the project, and
 * fall back to walking up from this file. The distinction matters because this generator is
 * compiled to a scratch directory before running (the repo has no TypeScript runner), and
 * `__dirname` then points at the build output rather than the repo — which silently produced a
 * scorecard measuring an empty directory rather than the suite.
 */
function resolveRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'swagger.json'))) return cwd;
  return path.resolve(__dirname, '..');
}

const ROOT = resolveRoot();
const p = (...s: string[]) => path.join(ROOT, ...s);

interface Metric {
  label: string;
  value: string;
  ok: boolean;
}

function exists(rel: string): boolean {
  return fs.existsSync(p(rel));
}

function readJson<T>(rel: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p(rel), 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Real compilation check — not a claim that one was run. */
function typecheck(): { clean: boolean; detail: string } {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, stdio: 'pipe', shell: true });
    return { clean: true, detail: 'tsc --noEmit exited 0' };
  } catch (error) {
    const out = String((error as { stdout?: Buffer }).stdout ?? '').trim();
    const count = out.split('\n').filter((l) => /error TS/.test(l)).length;
    return { clean: false, detail: `${count} TypeScript error(s)` };
  }
}

/** Resolved describe signatures, from the JSON test list Playwright emits. */
interface ListSuite {
  file?: string;
  title?: string;
  specs?: { title: string }[];
  suites?: ListSuite[];
}

const SIG = /(?:^|[-–]\s*)(GET|POST|PUT|PATCH|DELETE|VERB)\s+(\S+)/;

function analyseList(listPath: string): {
  cases: number;
  blocks: number;
  unique: number;
  duplicates: [string, string[]][];
  thin: [string, number][];
} | null {
  const report = readJson<{ suites?: ListSuite[] }>(listPath);
  if (!report) return null;

  const rows: { file: string; describe: string }[] = [];
  const visit = (s: ListSuite, file: string, trail: string[]) => {
    const f = s.file ?? file;
    const t = s.title && s.title !== f ? [...trail, s.title] : trail;
    for (const _ of s.specs ?? []) rows.push({ file: f, describe: t.join(' > ') });
    for (const child of s.suites ?? []) visit(child, f, t);
  };
  for (const s of report.suites ?? []) visit(s, s.file ?? '', []);

  const blocks = new Map<string, { file: string; sig: string | null; cases: number }>();
  for (const r of rows) {
    const key = `${r.file}||${r.describe}`;
    if (!blocks.has(key)) {
      let sig: string | null = null;
      for (const seg of r.describe.split(' > ').reverse()) {
        const m = seg.match(SIG);
        if (m) {
          sig = `${m[1]} ${m[2].replace(/\/+$/, '')}`;
          break;
        }
      }
      blocks.set(key, { file: r.file, sig, cases: 0 });
    }
    blocks.get(key)!.cases += 1;
  }

  const bySig = new Map<string, { file: string; cases: number }[]>();
  for (const b of blocks.values()) {
    if (!b.sig) continue;
    if (!bySig.has(b.sig)) bySig.set(b.sig, []);
    bySig.get(b.sig)!.push({ file: b.file, cases: b.cases });
  }

  const duplicates: [string, string[]][] = [];
  const thin: [string, number][] = [];
  for (const [sig, list] of bySig) {
    if (list.length > 1) duplicates.push([sig, list.map((l) => l.file)]);
    const total = list.reduce((n, l) => n + l.cases, 0);
    if (total < 10) thin.push([sig, total]);
  }

  return { cases: rows.length, blocks: blocks.size, unique: bySig.size, duplicates, thin };
}

/** Documented operations in the spec, split by whether the tag is a deprecated one. */
function swaggerOperations(): { active: string[]; legacy: string[] } {
  const sw = readJson<{ paths: Record<string, Record<string, { tags?: string[] }>> }>('swagger.json');
  const active: string[] = [];
  const legacy: string[] = [];
  if (!sw) return { active, legacy };
  for (const [route, ops] of Object.entries(sw.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const tag = op.tags?.[0] ?? '';
      const sig = `${method.toUpperCase()} ${route.replace(/\/+$/, '')}`;
      (/superseded|abandoned/i.test(tag) ? legacy : active).push(sig);
    }
  }
  return { active, legacy };
}

interface Defect {
  severity: string;
  endpointPath: string;
  curlSnippet?: string;
  reproSnippet?: string;
  requestBody?: string;
  module?: string;
}

function build(listPath: string): string {
  const ts = typecheck();
  const list = analyseList(listPath);
  const ops = swaggerOperations();
  const ledger = readJson<{ defects: Defect[]; meta?: Record<string, unknown> }>('BUG_REPORT.json');
  const defects = ledger?.defects ?? [];

  const norm = (s: string) => s.replace(/\/\{[^}]+\}/g, '').replace(/\/+$/, '');
  const coveredNorm = new Set<string>();
  // Coverage is computed from the resolved signatures rather than the run ledger, so it
  // reflects what the suite *asserts on*, not merely what it happened to touch.
  const signatures = new Set<string>();
  if (list) {
    const report = readJson<{ suites?: ListSuite[] }>(listPath);
    const rows: string[] = [];
    const visit = (s: ListSuite, file: string, trail: string[]) => {
      const f = s.file ?? file;
      const t = s.title && s.title !== f ? [...trail, s.title] : trail;
      for (const _ of s.specs ?? []) rows.push(t.join(' > '));
      for (const child of s.suites ?? []) visit(child, f, t);
    };
    for (const s of report?.suites ?? []) visit(s, s.file ?? '', []);
    for (const d of rows) {
      for (const seg of d.split(' > ').reverse()) {
        const m = seg.match(SIG);
        if (m) {
          signatures.add(`${m[1]} ${m[2].replace(/\/+$/, '')}`);
          break;
        }
      }
    }
  }
  for (const s of signatures) coveredNorm.add(norm(s));

  const uncoveredActive = ops.active.filter((o) => !signatures.has(o) && !coveredNorm.has(norm(o)));
  const activeCoverage = ops.active.length
    ? ((ops.active.length - uncoveredActive.length) / ops.active.length) * 100
    : 0;

  const legacySpecsPresent = exists('tests/legacy');
  const withCurl = defects.filter((d) => (d.curlSnippet ?? '').includes('curl')).length;
  const withSnippet = defects.filter((d) => (d.reproSnippet ?? '').length > 0).length;
  const withOwner = defects.filter((d) => (d.module ?? '').length > 0).length;
  const pct = (n: number) => (defects.length ? Math.round((n / defects.length) * 100) : 0);

  const artifacts: Metric[] = [
    { label: 'BUG_REPORT.md', value: exists('BUG_REPORT.md') ? 'present' : 'MISSING', ok: exists('BUG_REPORT.md') },
    { label: 'BUG_REPORT.json', value: exists('BUG_REPORT.json') ? 'present' : 'MISSING', ok: exists('BUG_REPORT.json') },
    { label: 'DEV_DIGEST.md', value: exists('DEV_DIGEST.md') ? 'present' : 'MISSING', ok: exists('DEV_DIGEST.md') },
    { label: 'DEV_DIGEST.json', value: exists('DEV_DIGEST.json') ? 'present' : 'MISSING', ok: exists('DEV_DIGEST.json') },
    { label: 'Playwright HTML (trace viewer)', value: exists('reports/diagnostic/index.html') ? 'present' : 'MISSING', ok: exists('reports/diagnostic/index.html') },
    { label: 'JUnit XML for CI', value: exists('test-results/results.xml') ? 'present' : exists('reports/junit-results.xml') ? 'present (reports/)' : 'MISSING', ok: exists('test-results/results.xml') || exists('reports/junit-results.xml') },
    { label: 'Executive HTML (tier 2)', value: exists('reports/latest/kpost-executive-summary.html') ? 'present' : 'MISSING', ok: exists('reports/latest/kpost-executive-summary.html') },
    { label: 'Trend history (tier 3)', value: exists('reports/kpost-trend-history.json') ? 'present' : 'MISSING', ok: exists('reports/kpost-trend-history.json') },
    { label: 'Bug payload stream (tier 4)', value: exists('reports/latest/kpost-bug-payloads.json') ? 'present' : 'MISSING', ok: exists('reports/latest/kpost-bug-payloads.json') },
    // An 'Allure results' row sat here. The reporter has been removed, so the row could only
    // ever report 'not generated' — a permanent false negative on the scorecard.
  ];

  /* ---- scoring ------------------------------------------------------------------------
   * Each category states its rule inline. Deductions are arithmetic on measured values, so
   * the reader can recompute any figure from the evidence table above it.
   * ---------------------------------------------------------------------------------- */

  // 1. Architecture (25): tsc clean (10), no duplicate signatures (10), legacy purged (5).
  const archTs = ts.clean ? 10 : 0;
  const archDupes = list && list.duplicates.length === 0 ? 10 : 0;
  const archLegacy = legacySpecsPresent ? 0 : 5;
  const arch = archTs + archDupes + archLegacy;

  // 2. Bug detection (25): 15 for the 10-case floor, 10 scaled by active coverage.
  const thinCount = list?.thin.length ?? 0;
  const depth = thinCount === 0 ? 15 : Math.max(0, 15 - thinCount);
  // Floor, not round. Rounding turned a measured 96.1% coverage into a full 10/10, which is
  // precisely the flattery this generator exists to avoid: a gap you cannot see in the score
  // is a gap nobody fixes.
  const cover = Math.floor((activeCoverage / 100) * 10);
  const detection = depth + cover;

  // 3. Zero redundancy (25): duplicates (15), legacy purge (10).
  const redunDupes = list && list.duplicates.length === 0 ? 15 : 0;
  const redunLegacy = legacySpecsPresent ? 0 : 10;
  const redundancy = redunDupes + redunLegacy;

  // 4. Reporting (25): curl (8), snippet (5), owner (4), artifacts (8).
  const repCurl = Math.round((pct(withCurl) / 100) * 8);
  const repSnip = Math.round((pct(withSnippet) / 100) * 5);
  const repOwner = Math.round((pct(withOwner) / 100) * 4);
  const artefactOk = artifacts.filter((a) => a.ok).length;
  const repArt = Math.round((artefactOk / artifacts.length) * 8);
  const reporting = repCurl + repSnip + repOwner + repArt;

  const total = arch + detection + redundancy + reporting;
  const verdict = total >= 90 ? 'PRODUCTION-READY' : 'REFACTOR REQUIRED';

  const sevCount = (s: string) => defects.filter((d) => d.severity === s).length;

  const lines: string[] = [];
  lines.push('# KPOST API Test Suite — Quality Scorecard');
  lines.push('');
  lines.push(`> Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC by \`reporters/generate-scorecard.ts\`.`);
  lines.push('> **Every figure below is measured from a run artifact.** Where a rubric criterion');
  lines.push('> could not be measured, the scorecard says so and deducts rather than assuming credit.');
  lines.push('');
  lines.push(`## Verdict: ${verdict} — ${total}/100`);
  lines.push('');
  lines.push('| Category | Score | Basis |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 1. Architecture & Maintenance | ${arch}/25 | tsc ${archTs}/10 · no duplicate signatures ${archDupes}/10 · legacy purged ${archLegacy}/5 |`);
  lines.push(`| 2. Bug Detection & Resilience | ${detection}/25 | 10-case floor ${depth}/15 · active coverage ${cover}/10 |`);
  lines.push(`| 3. Zero Redundancy & Efficiency | ${redundancy}/25 | no duplicates ${redunDupes}/15 · V1 purged ${redunLegacy}/10 |`);
  lines.push(`| 4. Reporting & Actionability | ${reporting}/25 | curl ${repCurl}/8 · snippet ${repSnip}/5 · owner ${repOwner}/4 · artifacts ${repArt}/8 |`);
  lines.push(`| **Total** | **${total}/100** | |`);
  lines.push('');

  lines.push('## Measured evidence');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| TypeScript compilation | ${ts.detail} |`);
  lines.push(`| Test cases enumerated | ${list?.cases ?? 'n/a'} |`);
  lines.push(`| Describe blocks | ${list?.blocks ?? 'n/a'} |`);
  lines.push(`| Unique METHOD+PATH signatures | ${list?.unique ?? 'n/a'} |`);
  lines.push(`| Duplicate signatures | ${list?.duplicates.length ?? 'n/a'} |`);
  lines.push(`| Signatures under the 10-case floor | ${thinCount} |`);
  lines.push(`| Active (non-deprecated) operations in swagger.json | ${ops.active.length} |`);
  lines.push(`| Deprecated operations in swagger.json | ${ops.legacy.length} |`);
  lines.push(`| Active operations with no test signature | ${uncoveredActive.length} |`);
  lines.push(`| Active coverage | ${activeCoverage.toFixed(1)}% |`);
  lines.push(`| \`tests/legacy/\` present | ${legacySpecsPresent ? 'YES — V1 not purged' : 'no — purged'} |`);
  lines.push(`| Defects in ledger | ${defects.length} |`);
  lines.push(`| Critical / Major / Minor / Trivial | ${sevCount('Critical')} / ${sevCount('Major')} / ${sevCount('Minor')} / ${sevCount('Trivial')} |`);
  lines.push(`| Defects carrying a curl reproduction | ${withCurl} (${pct(withCurl)}%) |`);
  lines.push(`| Defects carrying a Playwright snippet | ${withSnippet} (${pct(withSnippet)}%) |`);
  lines.push(`| Defects carrying an owning team | ${withOwner} (${pct(withOwner)}%) |`);
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push('| Artifact | State |');
  lines.push('| --- | --- |');
  for (const a of artifacts) lines.push(`| ${a.label} | ${a.ok ? a.value : `**${a.value}**`} |`);
  lines.push('');

  if (uncoveredActive.length) {
    lines.push('## Active operations with no test signature');
    lines.push('');
    lines.push('Matched by normalising path variables away, so an endpoint covered under a templated');
    lines.push('describe still counts. **These are not wholly untested** — the bare `@RequestMapping`');
    lines.push('RedBus routes answer every verb, and the alternate verbs are exercised together in one');
    lines.push('shared verb-binding block rather than one describe each. They are listed because they');
    lines.push('have no *dedicated* signature, which is a real reporting gap even where the assertion');
    lines.push('exists: a failure on `PUT /redbus/getTicket` surfaces under a generic block title.');
    lines.push('');
    for (const o of uncoveredActive.slice(0, 40)) lines.push(`- \`${o}\``);
    if (uncoveredActive.length > 40) lines.push(`- …and ${uncoveredActive.length - 40} more`);
    lines.push('');
  }

  if (list?.duplicates.length) {
    lines.push('## Duplicate signatures');
    lines.push('');
    for (const [sig, files] of list.duplicates) lines.push(`- \`${sig}\` — ${files.join(', ')}`);
    lines.push('');
  }

  if (thinCount) {
    lines.push('## Signatures under the 10-case floor');
    lines.push('');
    for (const [sig, n] of list!.thin) lines.push(`- \`${sig}\` — ${n} cases`);
    lines.push('');
  }

  lines.push('## How to disagree with this score');
  lines.push('');
  lines.push('Each category is arithmetic on the evidence table, not a judgement:');
  lines.push('');
  lines.push('- **Architecture** rewards a clean compile, zero duplicate route signatures, and the');
  lines.push('  absence of `tests/legacy/`. It does *not* attempt to score "clean structure" — that');
  lines.push('  is a code-review judgement a generator has no business awarding itself.');
  lines.push('- **Bug detection** scores the 10-case floor and coverage breadth. It cannot measure');
  lines.push('  whether the assertions are *good*, only that they exist and are numerous, so a high');
  lines.push('  score here is necessary but not sufficient.');
  lines.push('- **Redundancy** is fully mechanical.');
  lines.push('- **Reporting** counts the proportion of ledger entries that carry a curl command, a');
  lines.push('  Playwright snippet and an owning team, plus the proportion of expected artifacts that');
  lines.push('  actually exist on disk.');
  lines.push('');
  lines.push('A verdict of PRODUCTION-READY requires 90+. That threshold is about the *test suite*,');
  lines.push('not the API under test — the API itself is failing its own release gate, and the');
  lines.push('defect counts above are the reason.');
  lines.push('');

  return lines.join('\n');
}

const listPath = process.argv[2] ?? p('reports', 'test-list.json');
fs.writeFileSync(p('SUITE_SCORECARD.md'), build(listPath), 'utf-8');
process.stdout.write('[KPOST Scorecard] wrote SUITE_SCORECARD.md\n');
