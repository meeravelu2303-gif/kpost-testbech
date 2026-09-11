import type { Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { readBugLedger, recordBug, resolveModule } from '../src/utils/bugTracker';
import type { FlawClassification, Severity } from '../src/utils/bugTracker';
import { ENDPOINT_IN_TITLE } from './run-model';
import { readTelemetry } from './telemetry';

/**
 * Guarantees every failing test reaches the bug ledger.
 *
 * The assertion helpers in `src/utils/apiAssertions.ts` file a ledger entry as they fail, but a
 * test that fails through a plain `expect()` files nothing. Those failures used to surface only
 * in the HTML report, as report-only entries minted by `synthesizeDefect()` in `run-model.ts` â€”
 * never as real records, so they never reached `BUG_REPORT.json`, the tracker or the dashboard.
 * On the 2026-08-17 run that was 228 of 374 findings.
 *
 * This reporter closes that gap: after the run it compares the set of failed tests against the
 * set of tests that already filed something, and files a record for the difference.
 *
 * **Why `onEnd` and not `onTestEnd`.** Telemetry is buffered inside each worker and flushed at
 * `FLUSH_AT` records or on process exit (`telemetry.ts`), so at `onTestEnd` a test's HTTP calls
 * are usually still in the worker's memory and unreadable here. Synthesizing then would attach
 * the wrong endpoint â€” or none â€” to most records. By `onEnd` every worker has exited and
 * flushed, so the endpoint inference sees the complete picture. It also sidesteps retries
 * firing the hook more than once per test.
 *
 * **Ordering.** This must sit FIRST in `playwright.config.ts`'s reporter array. Reporter
 * `onEnd` hooks run in array order, and the records written here have to exist before
 * `kpost-master-reporter` builds the run model and before `bugReporter` compiles
 * `BUG_REPORT.md`/`.json` and deletes `.bug-cache/`.
 */

const LOG = '[bug-safety-net]';
const ANSI = /\u001b\[[0-9;]*m/g;

/** Playwright colourises assertion messages; the raw escape codes render as noise in a ticket. */
function clean(value: string | undefined): string {
  return (value ?? '').replace(ANSI, '').trim();
}

function firstLine(message: string): string {
  const line = message.split('\n').find((candidate) => candidate.trim().length > 0) ?? 'Assertion failed';
  return line.trim().slice(0, 180);
}

/**
 * A run-to-run STABLE identity key for a synthesized defect.
 *
 * The title is the raw failure message, which is exactly what a reader wants to see — but it
 * carries volatile tokens (a timed-out IP, a fuzzed value, a random UUID, a port, a latency in
 * ms). Because a defect's identity is `classification + title` (or this key when supplied),
 * leaving those in the title mints a brand-new id every time the value changes, so the same
 * fault re-files nightly and dedup never catches it.
 *
 * This collapses the volatile parts to fixed placeholders so the *shape* of the failure decides
 * identity, not the incidental value. It is deliberately conservative — it removes only tokens
 * that are clearly incidental, so two genuinely different failures stay distinct. The full
 * message is still stored verbatim as the ticket title and body; only the hashing input changes.
 */
function stableKey(message: string, method: string, endpointPath: string): string {
  const normalized = message
    .replace(ANSI, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>') // IPv4
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<uuid>')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '<hex>') // long hex blobs / hashes
    .replace(/:\d{2,5}\b/g, ':<port>') // :443, :8989
    .replace(/\b\d+\s?ms\b/gi, '<ms>') // latencies
    .replace(/\b\d{4,}\b/g, '<n>') // any remaining long number run (ids, fuzz sizes, epochs)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  // Keep the endpoint in the key so the same generic error on two routes stays two defects,
  // matching how endpoint-scoped grouping treats a synthesized failure.
  return `SAFETYNET ${method} ${endpointPath} :: ${normalized}`;
}

/**
 * Recovers a real classification + severity from a bare-`expect()` failure message.
 *
 * A test that asserts with a plain `expect()` instead of one of the helpers in
 * `apiAssertions.ts` files nothing itself, so this reporter used to record every such failure
 * as a generic `Assertion Failure` — which the Bugzilla dispatcher excludes. That was fine when
 * those were assumed to be test noise, but a bucketing of a real run showed the opposite:
 * ~99% describe an actual API fault (a 500, a wrong status, a missing rate limit, an IDOR),
 * only asserted the wrong way. Leaving them all as `Assertion Failure` hid hundreds of real
 * defects from the tracker.
 *
 * So the message is read for what the fault *is*. Only genuine infrastructure noise (a network
 * timeout, a torn-down context) stays `Assertion Failure` and thus excluded; everything with a
 * recognisable product-fault signature gets a proper classification and is filed. An
 * unrecognised message stays `Assertion Failure` too — conservative on purpose, so this never
 * invents a classification it cannot justify. Category is derived downstream by
 * `deriveCategory`, which reads the same title for security markers.
 */
function classifyFailure(message: string): { classification: FlawClassification; severity: Severity } {
  const m = message;
  const rules: Array<[RegExp, FlawClassification, Severity]> = [
    // genuine infrastructure noise — the only bucket that stays excluded from Bugzilla
    [/ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang|Target closed|context was destroyed|apiRequestContext\.\w+: (connect|request)/i, 'Assertion Failure', 'Major'],
    // security — missing throttling. Stays ahead of the throttled-response rule below so that
    // "…all processed with no 429" is read as the absence of rate limiting, not as one.
    [/\bno 429\b|not rate.?limited|no rate.?limit|throttl|rapid .*(login|attempt|signup|password)|consecutive .*(login|attempt|failed)/i, 'Security/Rate Limiting', 'Major'],
    /*
     * The endpoint throttled US. Excluded from Bugzilla, like the transport noise above.
     *
     * A 429 is the server working correctly under the ~4,500 requests this suite fires in nine
     * minutes; it replaces whatever the endpoint would have answered, so every downstream
     * assertion reads it as the wrong status. On 2026-08-24 that produced 62 tickets against
     * endpoints that had behaved properly - and 12 of them were graded *Major* because the
     * word "500" happened to appear in the assertion's list of acceptable statuses.
     *
     * `assertRateLimited`-style findings are unaffected: those assert a 429 SHOULD appear and
     * are claimed by the rule above.
     */
    [/but got 429\b|\bHTTP 429\b|Too many requests/i, 'Assertion Failure', 'Major'],
    // security — access control / IDOR / cross-tenant
    /*
     * Identity injection: the caller put an identity in the request and the response changed.
     *
     * The phrasings below were all producing `Assertion Failure` on 2026-08-27 and were
     * therefore excluded from Bugzilla — 8 Major findings that are the whole point of this
     * suite: login history, contacts, groups and never-saved-contact listings all returned for
     * a body-supplied `kpostID`, a settings row written under one, and a conversation store
     * walkable by short integer ids. Each is an access-control fault, not test noise, so the
     * wording the specs actually use is matched here rather than only the word "IDOR".
     */
    [/\bIDOR\b|cross-tenant|active sessions .*(supplied|query)|query-supplied|body-supplied|caller-supplied|supplying kpostID|body carried kpostID|can be walked|another (user|company|tenant)'s|for an arbitrary|someone else'?s/i, 'Security/Access Control', 'Critical'],
    // security — internals disclosed
    [/stack ?trace|Java exception|SQL syntax|Hibernate|ORA-\d|internals? leak|exception class/i, 'Security/Information Disclosure', 'Critical'],
    // concurrency / idempotency
    [/concurrent|idempoten|unique constraint|\d+ of \d+ .*(succeeded|processed)|race condition|double/i, 'Idempotency / Concurrency', 'Major'],
    // a failure transported as success (200 disagrees with the envelope)
    [/HTTP (status )?\d+ .*(disagree|contradic)|status .*disagrees|envelope .*(status|500)|masked/i, 'Status Code Misreporting', 'Major'],
    // contract / schema break
    [/schema validation|does not match .*(schema|contract)|violates .*(contract|schema)|response .*contract/i, 'Schema Violation', 'Minor'],
    /*
     * Unhandled server error — matched on the status the endpoint **observably returned**,
     * never on one that merely appears in the assertion's expected list.
     *
     * The previous form ended in a bare `\b500\b`, and almost every assertion message on this
     * bench quotes its acceptable statuses: "Expected status [200, 400, 401, 403, 404, 500] but
     * got 404". That "500" is what the test would have *tolerated*, so the rule fired on
     * responses that were nothing of the kind. It mis-graded 31 tickets as Major server faults
     * whose endpoints had actually answered 429, 200, 404 or 204 - inflating the Major band
     * with findings that were, at worst, a wrong status code.
     */
    [/produced HTTP 5\d\d|but got 5\d\d|returned HTTP 5\d\d|\bstatus 5\d\d\b|caused a server error|Internal Server Error/i, 'Unhandled NPE / Server Error', 'Major'],
    // merely a wrong status code
    [/Expected status|expected \d+\/\d+|expected \[|wrong status|HTTP \d{3}\b/i, 'Incorrect HTTP Status', 'Minor'],
  ];
  for (const [re, classification, severity] of rules) {
    if (re.test(m)) return { classification, severity };
  }
  // Unrecognised: keep it excluded rather than mint a classification we cannot stand behind.
  return { classification: 'Assertion Failure', severity: 'Major' };
}

export default class BugSafetyNetReporter implements Reporter {
  private suite: Suite | undefined;
  private startedAt = Date.now();

  onBegin(_config: unknown, suite: Suite): void {
    this.suite = suite;
    // Matches how run-model scopes telemetry: records older than the run belong to a previous
    // one, left behind by a worker that died mid-flush.
    this.startedAt = Date.now();
  }

  onEnd(): void {
    try {
      this.fileMissing();
    } catch (error) {
      // A reporting safety net must never be the thing that fails a run.
      console.log(`${LOG} skipped - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fileMissing(): void {
    if (!this.suite) return;

    const failed: TestCase[] = this.suite
      .allTests()
      .filter((test) => test.outcome() === 'unexpected' || test.outcome() === 'flaky');

    if (failed.length === 0) {
      console.log(`${LOG} no failing tests - nothing to file`);
      return;
    }

    /**
     * Tests that already reached the ledger through an assertion helper. Reading it once is
     * what keeps this from double-filing a test that recorded its own, richer defect.
     *
     * **`observedByTests`, not just `testId`.** `recordBug` writes each defect once, with the
     * exclusive `wx` flag, so `testId` names only the *first* test to hit that fault; every
     * later test contributes an occurrence and leaves `testId` untouched. Keying on `testId`
     * alone therefore treats every subsequent observer as having filed nothing.
     *
     * That is not a rare edge — grouping is the whole point of the ledger, and the faults
     * these APIs exhibit are systemic. Measured on the sibling Admin bench, which runs this
     * same reporter: a full run produced **372 synthesized defects, every one of them on an
     * endpoint an existing group already covered**, so the ledger read 704 defects where 332
     * were real. `Returns HTTP 500 where 200/201 is required` was the clearest case — one
     * Critical defect spanning 20 endpoints and observed by 20 tests, filed alongside 19 Major
     * near-duplicates of itself. Fixing this took that run to 348 defects and 0 such
     * duplicates.
     *
     * They were also graded *lower*, because a synthesized record is classified from the raw
     * assertion message rather than by the helper that understood the response — so the
     * duplicates diluted the severity bands as well as inflating the count. That matters more
     * on this bench than on the Admin one: `BUGZILLA_DRY_RUN` is false here, so each duplicate
     * became a real, permanent ticket.
     *
     * `readBugLedger()` runs `compileGrouping()`, so `observedByTests` is populated here.
     */
    const alreadyFiled = new Set(
      readBugLedger()
        .flatMap((record) => [record.testId, ...(record.observedByTests ?? [])])
        .filter((id): id is string => Boolean(id))
    );

    // Endpoint of last resort: the busiest call the test actually made, per telemetry.
    const callsByTest = new Map<string, { method: string; path: string; body?: string }[]>();
    for (const call of readTelemetry(this.startedAt)) {
      const bucket = callsByTest.get(call.testId);
      if (bucket) bucket.push(call);
      else callsByTest.set(call.testId, [call]);
    }

    let filed = 0;
    let skipped = 0;

    for (const test of failed) {
      if (alreadyFiled.has(test.id)) {
        skipped += 1;
        continue;
      }

      const result = test.results[test.results.length - 1];
      const message = clean(result?.error?.message) || 'Assertion failed';
      const title = firstLine(message);

      // Same inference order as run-model: an endpoint named in the describe/title is the
      // test's declared subject and beats whatever it happened to call last.
      const titlePath = test.titlePath();
      const describe = titlePath.slice(3, -1).join(' â€º ');
      const match = ENDPOINT_IN_TITLE.exec(describe) ?? ENDPOINT_IN_TITLE.exec(test.title);
      const calls = callsByTest.get(test.id) ?? [];
      const fallback = calls[calls.length - 1];

      const method = (match ? match[1] : fallback?.method ?? 'â€”').toUpperCase();
      const endpointPath = match ? match[2] : fallback?.path ?? test.location.file;

      // Recover the real fault from the message. Only genuine infra noise stays
      // `Assertion Failure` (and thus excluded from Bugzilla); everything else files as a
      // properly classified defect.
      const { classification, severity } = classifyFailure(message);

      recordBug({
        // Passed explicitly: this runs in the reporter process, where `test.info()` does not
        // exist, and the id must still be scoped to the test it belongs to.
        testId: test.id,
        title,
        /*
         * Identity comes from a stable key, not the raw title: the title carries volatile tokens
         * (IPs, ports, fuzz values, UUIDs) that would otherwise mint a new bug id every run.
         *
         * An unhandled 5xx is keyed by ENDPOINT ALONE, using the same key
         * `assertRejectsInvalidInput` uses. One controller that never validates its body throws
         * on every field the suite fuzzes it with, and each throw arrives here with a different
         * message — "a 5000-character description produced HTTP 500", "adding 500 participants
         * produced HTTP 500" — so a message-derived key filed one ticket per symptom. Sharing the
         * key means those merge with each other *and* with the findings the assertion helper
         * files for the same endpoint: one endpoint, one ticket, every symptom an occurrence.
         *
         * Everything else keeps the message in its key. Two different wrong-status faults, or two
         * different missing rate limits, are genuinely different defects even on one route.
         */
        dedupeKey:
          classification === 'Unhandled NPE / Server Error'
            ? `UNVALIDATED-INPUT-5XX:${method} ${endpointPath}`
            : stableKey(message, method, endpointPath),
        severity,
        module: resolveModule(endpointPath).module,
        classification,
        description:
          'Detected by a plain expect() rather than one of the bug-tracking helpers in ' +
          'src/utils/apiAssertions.ts, so the request/response detail a helper would capture is ' +
          'thinner here — the tier 1 diagnostic trace has the full exchange. The classification ' +
          'and severity are inferred from the failure message.',
        endpointPath,
        method,
        expected: 'The assertion in the referenced spec to hold',
        actual: message.slice(0, 600),
        requestHeaders: {},
        requestBody: calls.find((call) => call.body)?.body,
        reproSnippet: `npx playwright test ${test.location.file.replace(/\\/g, '/')} -g ${JSON.stringify(test.title)}`,
      });
      filed += 1;
    }

    console.log(
      `${LOG} filed ${filed} synthesized defect(s) for failing tests that recorded none; ` +
        `${skipped} already had a ledger entry (of ${failed.length} failing tests)`
    );
  }

  /** Keeps this line out of Playwright's own error summary. */
  printsToStdio(): boolean {
    return true;
  }
}
