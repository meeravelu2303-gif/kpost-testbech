#!/usr/bin/env node
/**
 * Gate-quality auditor — offline, no network, no run required.
 *
 * The bench has two kinds of test and they need opposite assertions:
 *
 *   @audit  surveys a live system whose behaviour is not yet agreed. Tolerant assertions
 *           (`toBeLessThan(500)`), broad status sets and acquire-or-skip guards are CORRECT
 *           here — the point is to observe and report, not to block.
 *   @gate   pins behaviour that has been agreed and must never regress. One expected outcome,
 *           no skips, no tolerance, and a requirement id so the reason survives the author.
 *
 * Without this split, tolerance spreads: a tolerant assertion is the path of least resistance
 * when a test goes red, so the survey style leaks into the regression suite and the suite stops
 * being able to fail. This script is what stops that, and it runs in CI beside audit:excel and
 * audit:vectors.
 *
 * It judges ONLY @gate tests. @audit tests are left alone by design — reporting them would be
 * noise, and the tolerance is the correct choice there.
 *
 *   node scripts/audit-gate.js [--dir <path> ...]
 *
 * Exit 0 = every @gate test is strict. Exit 1 = at least one violation.
 */

const fs = require('fs');
const path = require('path');

const RULES = {
  SKIP: 'test.skip( — a gate test may not opt out of running; move it to @audit if it cannot always run',
  TOLERANT_STATUS:
    'toBeLessThan(500) — passes on a 404, a 401 and a 302; a gate test must name the status it expects',
  MIXED_STATUS_SET:
    'status set accepts both a 2xx and a 4xx — success and refusal cannot both be correct for one agreed behaviour',
  NO_REQUIREMENT:
    'no [FR-*] / [BR-*] / [NFR-*] tag — a gate test without a requirement id cannot be triaged when it fails',
};

/** Collect every *.spec.ts under a directory. */
function specFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(full, out);
    else if (entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * Split a file into test blocks.
 *
 * Brace counting from the `test(` line, which is enough because these files are prettier-
 * formatted. A block carries the tags of its own title plus those of every enclosing describe,
 * so tagging a describe @gate covers the tests inside it.
 */
function testBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  const describeStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // leaving a describe
    while (describeStack.length && describeStack[describeStack.length - 1].depth === 0) {
      describeStack.pop();
    }
    for (const d of describeStack) d.depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

    if (/test\.describe\(/.test(line)) {
      describeStack.push({ title: line, depth: 1 });
      continue;
    }
    if (!/(^|\s)test(\.only|\.fixme)?\(/.test(line)) continue;

    let depth = 0;
    let started = false;
    const body = [];
    let j = i;
    for (; j < lines.length; j++) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      if ((lines[j].match(/\{/g) ?? []).length) started = true;
      if (started && depth <= 0) break;
    }
    blocks.push({
      line: i + 1,
      title: line,
      scope: describeStack.map((d) => d.title).join(' '),
      body: body.join('\n'),
    });
    i = j;
  }
  return blocks;
}

/** A status set naming both a success and a client error — `[200, 400]`, `[200, 401, 403]`. */
function hasMixedStatusSet(body) {
  for (const match of body.matchAll(/\[([\s\d,]+)\]/g)) {
    const codes = match[1]
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
    if (codes.length < 2) continue;
    if (codes.some((c) => c >= 200 && c < 300) && codes.some((c) => c >= 400 && c < 500)) return true;
  }
  return false;
}

function auditFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const violations = [];

  for (const block of testBlocks(source)) {
    const tagged = /@gate/.test(block.title) || /@gate/.test(block.scope) || /@gate/.test(block.body);
    if (!tagged) continue;

    const found = [];
    if (/test\.skip\(/.test(block.body)) found.push(RULES.SKIP);
    if (/toBeLessThan\(\s*500\s*\)/.test(block.body)) found.push(RULES.TOLERANT_STATUS);
    if (hasMixedStatusSet(block.body)) found.push(RULES.MIXED_STATUS_SET);
    if (!/\[(FR|BR|NFR)-[A-Z0-9-]+\]/.test(block.title + block.scope)) found.push(RULES.NO_REQUIREMENT);

    if (found.length) {
      const title = (block.title.match(/['"`](.+?)['"`]/) ?? [, block.title.trim()])[1];
      violations.push({ file, line: block.line, title, found });
    }
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--dir') dirs.push(args[++i]);
  if (!dirs.length) dirs.push('gate', 'tests', 'kmail/tests');

  const root = path.resolve(__dirname, '..');
  const files = dirs.flatMap((d) => specFiles(path.resolve(root, d)));
  const violations = files.flatMap(auditFile);

  let gateTests = 0;
  for (const file of files) {
    for (const block of testBlocks(fs.readFileSync(file, 'utf8'))) {
      if (/@gate/.test(block.title) || /@gate/.test(block.scope)) gateTests++;
    }
  }

  console.log('\nKPOST gate-quality audit\n');
  console.log(`  directories scanned : ${dirs.join(', ')}`);
  console.log(`  spec files          : ${files.length}`);
  console.log(`  @gate test blocks   : ${gateTests}  (a parameterised loop counts once)`);
  console.log(`  violations          : ${violations.length}\n`);

  if (violations.length) {
    console.log('=== VIOLATIONS (a @gate test must be strict) ===\n');
    for (const v of violations) {
      console.log(`  ${path.relative(root, v.file)}:${v.line}  ${v.title}`);
      for (const f of v.found) console.log(`      - ${f}`);
      console.log('');
    }
    console.log('[gate] FAIL\n');
    process.exit(1);
  }

  console.log('[gate] PASS\n');
}

main();
