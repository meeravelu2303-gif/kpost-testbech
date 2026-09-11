/**
 * Bug-report auditor — duplicate clustering and validity triage.
 *
 * The bench files one ticket per *fault*, not per failing test. That rule is enforced at write
 * time by a content-hashed `dedupeKey`, which collapses the same symptom on the same endpoint.
 * What it cannot see is a fault that shows up as many symptoms across many endpoints: a
 * controller with no input validation produces one entry per field it was fuzzed with, and each
 * one has a genuinely different key. Those are duplicates in the only sense that matters — a
 * developer fixes them all with one change — and they are what make a 160-line report unreadable.
 *
 * This script reads `BUG_REPORT.json` and reports two things:
 *
 *  1. **Duplicate clusters** — entries that share a root cause, grouped so the true defect count
 *     is visible next to the ticket count.
 *  2. **Validity flags** — entries whose evidence does not support their claim, using the failure
 *     patterns this bench has actually produced (see VALIDITY_RULES).
 *
 * It flags for REVIEW; it never edits the report. Every flag names what to check by hand.
 *
 * Usage:  node scripts/audit-bug-report.js [path/to/BUG_REPORT.json] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const reportPath = argv.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'BUG_REPORT.json');

if (!fs.existsSync(reportPath)) {
  console.error(`[bug-audit] no report at ${reportPath} — run the suite first.`);
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const defects = report.defects || [];

/* ============================================================================================
 * 1. Duplicate clustering
 * ========================================================================================= */

/**
 * The symptom a title describes, with the specifics stripped out.
 *
 * `field "eventID" set to null triggers a server error (HTTP 500) instead of 400/422` and
 * `empty body on event update triggers a server error (HTTP 500) instead of 400/422` are the same
 * defect wearing two hats: the controller does not validate its input. Normalising to
 * "unvalidated input -> 500" is what lets them cluster.
 */
function symptomOf(defect) {
  const title = String(defect.title || '');
  const rules = [
    [/triggers a server error \(HTTP 500\)|produced HTTP 500|Returns HTTP 500/i, 'unvalidated-input-500'],
    [/is rejected with HTTP 404 instead of|Returns HTTP 404 where/i, 'wrong-status-404-for-bad-input'],
    [/is rejected with HTTP 409 instead of|Returns HTTP 409 where/i, 'wrong-status-409-for-bad-input'],
    [/is rejected with HTTP 405 instead of|Returns HTTP 405 where/i, 'wrong-status-405'],
    [/Invalid input accepted/i, 'accepts-invalid-input'],
    [/HTTP 200 contradicts envelope|failure payload is returned behind a success|status.*disagrees with envelope/i, 'status-envelope-mismatch'],
    [/0 throttled responses|should be throttled|rate limit/i, 'no-rate-limiting'],
    [/reflected unescaped|stored XSS|Script payload/i, 'xss-reflection'],
    [/exceeds int32/i, 'int32-overflow-500'],
    [/concurrent identical|byte-identical bodies|shared instance field/i, 'concurrency-shared-state'],
    [/kpostID=|body-supplied kpostID|changed the (contacts|groups|list) returned|smuggled/i, 'ownership-idor'],
    [/Unauthenticated requests answered/i, 'wrong-status-for-anonymous'],
  ];
  for (const [pattern, label] of rules) if (pattern.test(title)) return label;
  return 'other';
}

const clusters = new Map();
for (const defect of defects) {
  const key = `${defect.module || 'Unclassified'} :: ${symptomOf(defect)}`;
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(defect);
}
const duplicateClusters = [...clusters.entries()]
  .filter(([, list]) => list.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

/* ============================================================================================
 * 2. Validity triage
 * ========================================================================================= */

/**
 * Patterns where the recorded evidence does NOT support the recorded claim.
 *
 * Each rule below corresponds to a false finding this bench actually produced and that was
 * confirmed false by hand against the live API on 2026-09-10. They are stated as questions a
 * reviewer can answer, not as verdicts — the script cannot re-run the request.
 */
const VALIDITY_RULES = [
  {
    id: 'anonymous-401-proves-nothing',
    applies: (d) =>
      /HTTP 401/i.test(String(d.actual)) &&
      /public|anonymous|contract marks/i.test(`${d.title} ${d.expected} ${d.actual}`),
    note:
      'Claim rests on an anonymous request returning 401. This API runs its auth filter BEFORE ' +
      'routing — a 401 comes back for routes that do not exist at all — so a 401 alone cannot ' +
      'distinguish "gated route" from "any route". Verify the route is genuinely reachable and ' +
      'genuinely meant to be public before filing.',
  },
  {
    id: 'success-inferred-from-200',
    applies: (d) =>
      /accepted|succeeded|returns success|were accepted/i.test(String(d.title)) &&
      /200/.test(`${d.actual}`),
    note:
      'Claim infers that an operation SUCCEEDED from HTTP 200. Several KPost routes answer 200 ' +
      'while the envelope carries statusCode 500 (addContact, deleteContact). Confirm the ' +
      'envelope agreed before treating this as accepted input.',
  },
  {
    id: 'comparison-may-be-timestamp',
    applies: (d) => /changed the .* returned|responses differ|identical/i.test(String(d.title)),
    note:
      'Claim rests on two responses differing. Server-stamped fields (lastFetchDate, timestamp, ' +
      'traceId, serverTime) differ between any two calls. Confirm the difference was in DATA, ' +
      'and that the foreign identifier actually appeared in the response.',
  },
  {
    id: 'severity-vs-classification',
    applies: (d) =>
      String(d.severity).toLowerCase() === 'critical' &&
      /Functional/i.test(String(d.category)) &&
      !/injection|xss|disclos|bypass|idor|leak/i.test(String(d.title)),
    note:
      'Graded Critical but categorised Functional, and the title names no security impact. ' +
      'Critical is reserved for auth bypass, injection and data exposure — a report where ' +
      'everything is Critical is one nobody reads. Confirm the grade.',
  },
  {
    id: 'happy-path-failure',
    applies: (d) => /happy path|satisfies the .*contract/i.test(String(d.observedByTests ? d.title : d.title)),
    note:
      'A happy-path failure is as often a wrong payload as a broken endpoint — the contacts ' +
      'happy paths were addressing a contact id that cannot exist. Reproduce with a known-good ' +
      'payload before filing.',
  },
  {
    id: 'no-repro-evidence',
    applies: (d) => !d.reproSnippet && !d.curlSnippet,
    note: 'No repro or curl recorded, so a developer cannot reproduce it. Likely a safety-net entry.',
  },
];

const flagged = [];
for (const defect of defects) {
  const hits = VALIDITY_RULES.filter((rule) => {
    try {
      return rule.applies(defect);
    } catch {
      return false;
    }
  });
  if (hits.length) flagged.push({ defect, hits });
}

/* ============================================================================================
 * Output
 * ========================================================================================= */

const trueDefectCount = clusters.size;
const summary = {
  ticketsInReport: defects.length,
  distinctRootCauses: trueDefectCount,
  collapsibleTickets: defects.length - trueDefectCount,
  flaggedForReview: flagged.length,
  bySeverity: report.summary?.bySeverity ?? {},
};

if (asJson) {
  console.log(
    JSON.stringify(
      {
        summary,
        duplicateClusters: duplicateClusters.map(([key, list]) => ({
          cluster: key,
          tickets: list.length,
          ids: list.map((d) => d.id),
          endpoints: [...new Set(list.map((d) => `${d.method} ${d.endpointPath}`))],
        })),
        flagged: flagged.map(({ defect, hits }) => ({
          id: defect.id,
          severity: defect.severity,
          title: defect.title,
          rules: hits.map((h) => h.id),
        })),
      },
      null,
      2
    )
  );
} else {
  console.log('\nKPOST bug-report audit\n');
  console.log(`  tickets in report      : ${summary.ticketsInReport}`);
  console.log(`  distinct root causes   : ${summary.distinctRootCauses}`);
  console.log(`  collapsible into those : ${summary.collapsibleTickets}`);
  console.log(`  flagged for review     : ${summary.flaggedForReview}`);
  console.log(`  severity               : ${JSON.stringify(summary.bySeverity)}\n`);

  console.log('=== DUPLICATE CLUSTERS (one fix would close all tickets in a row) ===');
  for (const [key, list] of duplicateClusters.slice(0, 20)) {
    console.log(`  ${String(list.length).padStart(3)}  ${key}`);
    console.log(`       ${list.map((d) => d.id).slice(0, 8).join(' ')}${list.length > 8 ? ' …' : ''}`);
  }

  console.log('\n=== FLAGGED FOR REVIEW (evidence may not support the claim) ===');
  const byRule = {};
  flagged.forEach(({ hits }) => hits.forEach((h) => (byRule[h.id] = (byRule[h.id] || 0) + 1)));
  Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .forEach(([id, n]) => {
      const rule = VALIDITY_RULES.find((r) => r.id === id);
      console.log(`\n  [${id}] ${n} ticket(s)`);
      console.log(`     ${rule.note}`);
      flagged
        .filter(({ hits }) => hits.some((h) => h.id === id))
        .slice(0, 6)
        .forEach(({ defect }) =>
          console.log(`       ${defect.id} (${defect.severity}) ${String(defect.title).slice(0, 78)}`)
        );
    });
  console.log('');
}
