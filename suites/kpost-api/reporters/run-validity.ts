import fs from 'fs';
import path from 'path';

/**
 * Run-validity gate — decides whether a run is trustworthy enough to publish.
 *
 * ## Why this exists
 *
 * On 2026-08-14 every one of the 53 spec files failed to load (an ESM-only dependency under a
 * CommonJS transform), so the suite executed **zero** tests. The reporting engine then:
 *
 *   - wrote BUG_REPORT.md saying "**CLEAN** — no deviations detected in this run"
 *   - published the run to the QA Dashboard as a completed run with 0 defects
 *   - told Bugzilla there were 0 defects to file
 *   - exited 0
 *
 * A total collapse of the bench was indistinguishable, in every artifact and to every
 * downstream system, from a perfectly healthy API. On a trend line it reads as *improvement*.
 *
 * That is the most dangerous failure a test bench can have, and it gets worse the better the
 * automation is: because defects auto-file into Bugzilla and auto-publish to the dashboard, a
 * false clean is not a bad file on disk — it is an authoritative record in two systems that a
 * human will later trust.
 *
 * ## The rule
 *
 * **A bench that cannot run must be loud, never clean.** Nothing publishes unless the run is
 * demonstrably real. Silence is reported as failure, not as success.
 *
 * ## Why the checks are filter-safe
 *
 * `executed` is compared against `collected` — what Playwright actually gathered for *this*
 * invocation — rather than against the suite's full 4,583. A deliberate `--project=common` or
 * `-g sendOTP` collects fewer tests and executes all of them, so it passes. Only a run that
 * collected work and then failed to do it trips the ratio check.
 */

/** Written next to the other run artifacts so the dispatchers can read one another's verdict. */
const VALIDITY_FILE = path.resolve(__dirname, '..', 'reports', 'run-validity.json');
const BUG_REPORT_JSON = path.resolve(__dirname, '..', 'BUG_REPORT.json');

/**
 * Fraction of collected tests that must actually produce a result. Below this the run is
 * treated as collapsed rather than merely failing — a crashed worker or an aborted run, whose
 * defect list is a sample of unknown size and must not be published as if it were complete.
 */
const MIN_EXECUTION_RATIO = 0.5;

export interface RunValidity {
  valid: boolean;
  /** Human-readable, printed in the console banner and in every skip line. */
  reason: string;
  executed: number;
  collected: number;
  loadErrors: number;
  checkedAt: string;
}

export interface RunValidityInput {
  /** Tests that produced a result, including skips. */
  executed: number;
  /** Tests Playwright gathered for this invocation, after any --project / -g filter. */
  collected: number;
  /** Errors outside any test — spec files that failed to import, global setup faults. */
  loadErrors: number;
  /** Playwright's own verdict, so an interrupted run is never published as complete. */
  status?: string;
}

/**
 * Pure decision function, exported separately from the file I/O so it can be reasoned about
 * (and unit-tested) without a run.
 */
export function assessRunValidity(input: RunValidityInput): RunValidity {
  const { executed, collected, loadErrors, status } = input;
  const base = { executed, collected, loadErrors, checkedAt: new Date().toISOString() };

  if (loadErrors > 0) {
    return {
      ...base,
      valid: false,
      reason:
        `${loadErrors} error(s) occurred outside any test — spec files failed to load or ` +
        `global setup faulted. The suite never ran, so "no defects" means "nothing was checked".`,
    };
  }

  if (status === 'interrupted' || status === 'timedout') {
    return {
      ...base,
      valid: false,
      reason: `the run was ${status}, so its results are a partial sample of unknown size.`,
    };
  }

  if (executed === 0) {
    return {
      ...base,
      valid: false,
      reason:
        'zero tests executed. An empty run cannot be evidence of a healthy API, and publishing ' +
        'it would record a false clean in the dashboard and in Bugzilla.',
    };
  }

  if (collected > 0 && executed < collected * MIN_EXECUTION_RATIO) {
    return {
      ...base,
      valid: false,
      reason:
        `only ${executed} of ${collected} collected tests produced a result ` +
        `(under ${Math.round(MIN_EXECUTION_RATIO * 100)}%). The run collapsed part-way, so its ` +
        `defect list is an incomplete sample and must not be published as a full run.`,
    };
  }

  /*
   * Optional absolute floor for scheduled runs. Unset by default: a developer running a
   * single spec is doing something legitimate, and a gate that fires on that gets disabled.
   * Set KPOST_MIN_TESTS in CI, where the expected size *is* known.
   */
  const floor = Number(process.env.KPOST_MIN_TESTS ?? '0');
  if (Number.isFinite(floor) && floor > 0 && executed < floor) {
    return {
      ...base,
      valid: false,
      reason: `only ${executed} tests executed, below the KPOST_MIN_TESTS floor of ${floor}.`,
    };
  }

  return { ...base, valid: true, reason: `${executed} of ${collected} collected tests executed.` };
}

export function writeRunValidity(validity: RunValidity): void {
  try {
    fs.mkdirSync(path.dirname(VALIDITY_FILE), { recursive: true });
    fs.writeFileSync(VALIDITY_FILE, `${JSON.stringify(validity, null, 2)}\n`, 'utf-8');
  } catch {
    // A verdict that cannot be written must not take the run down; the dispatchers fall back
    // to deriving one from BUG_REPORT.json below.
  }
}

export function readRunValidity(): RunValidity | null {
  try {
    return JSON.parse(fs.readFileSync(VALIDITY_FILE, 'utf-8')) as RunValidity;
  } catch {
    return null;
  }
}

/**
 * The gate every publisher calls before writing to an external system.
 *
 * Prefers the verdict the master reporter recorded for this run. When that is absent — the
 * standalone `npm run bugzilla:file` path, where no Playwright run just happened — it falls
 * back to the run block inside BUG_REPORT.json, so a stale zero-test report still cannot be
 * pushed by hand.
 */
export function publishingGate(): { allowed: boolean; reason: string } {
  const recorded = readRunValidity();
  if (recorded) {
    return { allowed: recorded.valid, reason: recorded.reason };
  }

  try {
    const report = JSON.parse(fs.readFileSync(BUG_REPORT_JSON, 'utf-8')) as {
      run?: { totalTests?: number };
    };
    const total = report.run?.totalTests ?? 0;
    if (total <= 0) {
      return {
        allowed: false,
        reason: 'BUG_REPORT.json records 0 tests executed — nothing was checked.',
      };
    }
    return { allowed: true, reason: `BUG_REPORT.json records ${total} tests executed.` };
  } catch {
    return { allowed: false, reason: 'no run validity record and BUG_REPORT.json is unreadable.' };
  }
}
