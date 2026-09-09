/**
 * Removes run caches and exporter output.
 *
 * Deliberately does NOT touch `reports/`: run folders are pruned by KPOST_RUN_RETENTION and the
 * trend history is append-only, so wiping it would lose evidence that no re-run can recreate.
 */
const fs = require('fs');

// `allure-results` / `allure-report` used to be listed here. Allure was removed permanently,
// so nothing generates them any more and cleaning them would only ever print "absent".
//
// Every entry below is transient: a build output of a standalone `tsc` step, a per-run cache,
// or a generated report artifact. All are gitignored and recreated on demand, so wiping them
// only ever removes clutter — never evidence. `reports/` is deliberately excluded (its run
// folders are pruned by KPOST_RUN_RETENTION and its trend history is append-only).
const targets = [
  // per-run caches and Playwright output
  'test-results',
  '.bug-cache',
  '.testbench',
  // build output of the standalone tsc steps
  '.audit-build',
  '.scorecard-build',
  '.dispatch-build',
  '.triage-build',
  '.bugzilla-build',
  '.dashboard-build',
  // generated report artifacts (the tracked BUG_REPORT.* deliverables are left alone)
  'DEV_DIGEST.md',
  'DEV_DIGEST.json',
];

for (const target of targets) {
  const existed = fs.existsSync(target);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`${existed ? 'removed ' : 'absent  '} ${target}`);
}
