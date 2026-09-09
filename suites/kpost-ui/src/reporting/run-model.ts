/**
 * The run model — one description of a finished run, built once, read by everyone.
 *
 * `BUG_REPORT.json`, `BUG_REPORT.md`, `DEV_DIGEST.md` and the QA-Dashboard payload
 * are all projections of this object. That is the whole point: the API bench keeps
 * its file reports and its dashboard push in separate reporters and has to document
 * an ordering constraint to stop them describing different runs. Deriving all four
 * from one in-memory model dissolves the constraint instead of managing it — they
 * cannot disagree, because there is only one set of numbers.
 *
 * This module is pure: it takes counts and sightings and returns an object. All
 * file writing lives in `bug-report.ts` / `dev-digest.ts`, and all network access in
 * `dashboard-reporter.ts`.
 *
 * ## On honesty
 *
 * `totalTests` is what Playwright PLANNED to run (`suite.allTests().length`), never
 * the number that happened to finish. When a run is cut short — the app fell over,
 * someone hit Ctrl-C, a global timeout fired — the planned total stays 236 while the
 * outcome counts stay at whatever genuinely happened. The gap between them IS the
 * signal, and `incomplete` names it. Nothing here rescales, back-fills or rounds a
 * count to close that gap.
 */
import type { KnownDefect } from '../utils/known-defects';

/**
 * A test that failed without any registered defect attached.
 *
 * These are the run's unexplained failures, and they are the number that makes
 * a bug report trustworthy: "191 failed, 17 defects" is only a coherent story
 * if the other 174 failures are accounted for by those 17. Anything left over
 * is either a defect nobody has registered yet or a broken test — both need a
 * human, and neither should be discoverable only by diffing spreadsheets.
 */
export interface UnattributedFailure {
  readonly testTitle: string;
  readonly project: string;
  readonly file: string;
  /** First line of the error, enough to group them by cause. */
  readonly error: string;
}

/** One test's observation of a known defect. */
export interface DefectSighting {
  readonly testTitle: string;
  readonly project: string;
  /** Playwright's terminal status for that test: passed / failed / timedOut / … */
  readonly status: string;
}

/** A defect as reported, shaped to the dashboard's ingest contract. */
export interface DefectRecord {
  readonly id: string;
  readonly displayId: string;
  readonly title: string;
  readonly severity: string;
  readonly module: string;
  readonly owner: string;
  readonly method: string;
  readonly endpointPath: string;
  readonly description: string;
  readonly requestBody: string;
  readonly expected: string;
  readonly actual: string;
  /**
   * Bugzilla's second classification axis, and the priority paired with it.
   * Both are optional in the ingest contract, but sending them means the
   * dashboard shows the same classification the filed ticket carries instead of
   * deriving its own — one defect, one story, in both systems.
   */
  readonly category: string;
  readonly priority: string;
  /**
   * Browsers that ran this suite and did **not** report this defect.
   *
   * The other half of "which browser?", and the half that is easy to forget.
   * "Affected: webkit" alone leaves a developer wondering whether the other
   * three were simply not tried; "not affected: chromium, firefox,
   * mobile-chrome — same suite, same run" turns it into a diagnosis: the fault
   * is in a browser API, not in application logic.
   *
   * Derived from the run's project list minus the browsers that saw it, so it
   * can only ever name browsers that genuinely ran. On a `--project=chromium`
   * run this is empty rather than claiming three untested browsers are fine.
   */
  readonly unaffectedBrowsers: readonly string[];
  /**
   * Which browsers saw this defect, and how many of their tests did.
   *
   * A defect that only fires on WebKit is a different bug from one that fires
   * everywhere, and a ticket that does not say which is a ticket a developer
   * cannot start on. This is rendered into the Bugzilla description and the
   * BUG_REPORT, so "which browser?" is answered before anyone has to ask.
   */
  readonly browsers: Readonly<Record<string, number>>;
  /** The tests that saw it, grouped under their browser. */
  readonly sightingsByBrowser: Readonly<Record<string, readonly string[]>>;
  /** Every defect this bench can find is a UI defect. */
  readonly type: 'WEBSITE';
  /**
   * The Bugzilla bug this defect was filed as, when filing ran and succeeded.
   * Populated by `withBugzillaLinks()` AFTER the run model is built, because the
   * bug number does not exist until the ticket is created. Absent on a dry run,
   * with Bugzilla unset, or when filing failed.
   */
  readonly bugzillaId?: number;
  readonly bugzillaUrl?: string;
}

/** One filed Bugzilla ticket, keyed back to the defect it represents. */
export interface BugzillaLink {
  readonly id: number;
  readonly url: string;
}

export interface RunTotals {
  /** Tests Playwright planned to run — projects included. Never adjusted. */
  readonly totalTests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /**
   * Tests that began but were cut off before reaching a terminal result. Kept out
   * of passed/failed/skipped on purpose: an interrupted test did not pass, did not
   * fail, and was not skipped — claiming otherwise would be the lie this bench
   * exists to avoid.
   */
  readonly interrupted: number;
  /** passed + failed + skipped — what the dashboard's consistency check sums. */
  readonly accounted: number;
  /** totalTests − accounted. Zero on a healthy run. */
  readonly unaccounted: number;
  readonly durationMs: number;
  readonly durationSeconds: number;
}

export interface RunModel {
  /** ISO-8601 — what the dashboard ingests. */
  readonly generatedAt: string;
  /** `YYYY-MM-DD HH:MM:SS UTC` — what a human reads in the report headers. */
  readonly generatedAtHuman: string;
  /** Short code: Local / QA / Staging / Production / Unknown. Never a URL. */
  readonly environment: string;
  readonly baseURL: string;
  readonly run: RunTotals & {
    /** Playwright's own verdict: passed / failed / timedout / interrupted. */
    readonly status: string;
    readonly projects: readonly string[];
    /** True when the run did not account for everything it planned. */
    readonly incomplete: boolean;
    /** Why, in plain sentences. Empty on a complete run. */
    readonly incompleteReasons: readonly string[];
    /**
     * Failures this run could not explain — no registered defect was attached.
     * Empty is the goal: it means every red test is accounted for by a defect
     * that has a ticket.
     */
    readonly unattributedFailures: readonly UnattributedFailure[];
  };
  readonly summary: {
    readonly total: number;
    readonly bySeverity: Record<string, number>;
    readonly byModule: Record<string, number>;
  };
  readonly defects: readonly DefectRecord[];
}

export interface BuildRunModelInput {
  readonly status: string;
  readonly environment: string;
  readonly baseURL: string;
  /** `suite.allTests().length` — the planned total. */
  readonly totalTests: number;
  readonly projects: readonly string[];
  readonly durationMs: number;
  /** Terminal status per test that actually ended, keyed by test id. */
  readonly outcomes: ReadonlyMap<string, string>;
  /** Sightings per known defect, keyed by defect id. */
  readonly sightings: ReadonlyMap<string, { defect: KnownDefect; seen: DefectSighting[] }>;
  /** Failed tests that carried no known-defect annotation. */
  readonly unattributedFailures?: readonly UnattributedFailure[];
  /**
   * Default assignee for defects that do not name their own owner. A report
   * that reaches a triage board with an empty Owner column gets triaged by
   * nobody, so this is the difference between filing a bug and filing it *to*
   * someone.
   */
  readonly defectOwner: string;
}

/**
 * How many sighting examples go inline in a defect's `actual` text before it
 * defers to the per-browser breakdown. Enough to recognise the pattern, few
 * enough that the field stays a sentence rather than a page.
 */
const MAX_INLINE_WITNESSES = 6;

/** Severity order used for sorting and for the digest's "look here first" list. */
export const SEVERITY_ORDER = ['High', 'Medium', 'Low'] as const;

export function severityRank(severity: string): number {
  const index = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function buildRunModel(input: BuildRunModelInput): RunModel {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let interrupted = 0;

  /*
   * One vote per test, taken from its LAST attempt — not one per `onTestEnd`, which
   * fires once per retry and would count a flaky test twice (once red, once green).
   * A test that failed and then passed on retry is a passed test that cost time,
   * which is what Playwright's own `flaky` outcome means.
   */
  for (const status of input.outcomes.values()) {
    switch (status) {
      case 'passed':
        passed += 1;
        break;
      case 'failed':
      case 'timedOut':
        failed += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
      case 'interrupted':
        interrupted += 1;
        break;
      default:
        // An unrecognised status is still a test that did not pass. Counting it as
        // failed is the conservative reading; silently dropping it would shrink the
        // accounted total and misreport the run as more complete than it was.
        failed += 1;
    }
  }

  const accounted = passed + failed + skipped;
  const unaccounted = Math.max(0, input.totalTests - accounted);

  const incompleteReasons: string[] = [];
  if (input.status === 'interrupted' || input.status === 'timedout') {
    incompleteReasons.push(
      `Playwright ended the run with status "${input.status}" — it stopped before working ` +
        'through the plan.',
    );
  }
  if (unaccounted > 0) {
    incompleteReasons.push(
      `${accounted} of ${input.totalTests} planned tests reached a result; ${unaccounted} ` +
        'never produced one.',
    );
  }
  if (interrupted > 0) {
    incompleteReasons.push(`${interrupted} test(s) began but were cut off mid-flight.`);
  }

  /*
   * ONE RECORD PER DEFECT — with every affected browser named on it.
   *
   * A bug tracker tracks flaws in the product, and a missing `<label>` is one
   * flaw even when it surfaces in four browsers. Filing it four times gives one
   * developer four tickets to close for one line of HTML, and inflates the open
   * defect count past what actually exists.
   *
   * "Which browser?" is answered as a FIELD instead — `browsers`,
   * `sightingsByBrowser` and `unaffectedBrowsers` — which is what a standard
   * defect template's Environment field is for. A genuinely browser-specific
   * fault (Firebase on WebKit, MicInput on Firefox) still gets its own ticket,
   * because it is its own registry entry, not because the filer split it.
   */
  const defects = [...input.sightings.values()]
    .map(({ defect, seen }) =>
      toDefectRecord(defect, seen, input.status, input.defectOwner, input.projects),
    )
    .sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id),
    );

  return {
    generatedAt: new Date().toISOString(),
    generatedAtHuman: `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    environment: input.environment,
    baseURL: input.baseURL,
    run: {
      status: input.status,
      totalTests: input.totalTests,
      passed,
      failed,
      skipped,
      interrupted,
      accounted,
      unaccounted,
      durationMs: Math.max(0, input.durationMs),
      durationSeconds: Math.round(Math.max(0, input.durationMs) / 100) / 10,
      projects: [...input.projects],
      incomplete: incompleteReasons.length > 0,
      incompleteReasons,
      unattributedFailures: [...(input.unattributedFailures ?? [])],
    },
    summary: {
      total: defects.length,
      bySeverity: tally(defects.map((d) => d.severity)),
      byModule: tally(defects.map((d) => d.module)),
    },
    defects,
  };
}

/**
 * Maps a registry entry plus its sightings onto the dashboard's defect contract.
 *
 * `method` / `endpointPath` / `requestBody` stay empty: they are the API bench's
 * vocabulary and a UI defect has no endpoint to name. Inventing one to fill the
 * column would put fiction in a bug ticket.
 */
function toDefectRecord(
  defect: KnownDefect,
  seen: readonly DefectSighting[],
  runStatus: string,
  defaultOwner: string,
  projectsInRun: readonly string[],
): DefectRecord {
  /*
   * Summarise, then list a few — do not inline all of them.
   *
   * A defect sighted by 64 tests produced a single 5,000-character paragraph
   * naming every one, which is the first thing a reader meets when they open
   * the ticket and is essentially unreadable. The full list is carried below in
   * a form you can scan, so this states the shape and shows enough examples to
   * recognise the pattern.
   *
   */
  const browserCounts = countBy(seen.map((s) => s.project));
  const affected = Object.keys(browserCounts);
  // Only browsers that actually ran can be called unaffected. On a
  // single-project run this is empty rather than vouching for browsers that
  // were never opened.
  const unaffectedBrowsers = projectsInRun.filter((p) => !affected.includes(p));
  const spread = Object.entries(browserCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([browser, count]) => `${browser} (${count})`)
    .join(', ');
  const examples = seen
    .slice(0, MAX_INLINE_WITNESSES)
    .map((s) => `${s.testTitle} [${s.project}] (${s.status})`)
    .join('; ');
  const witnesses =
    seen.length > MAX_INLINE_WITNESSES
      ? `${examples}; …and ${seen.length - MAX_INLINE_WITNESSES} more — the full list is grouped by browser below.`
      : examples;

  return {
    /*
     * Unique per browser, because every downstream system keys on it: the
     * dashboard upserts defects by `id`, and evidence is uploaded to
     * `/defects/:id/attachments`. Reusing the bare defect id across browsers
     * would make three records collapse into one and take two browsers' proof
     * with them. `@` keeps it URL-safe and greppable; `displayId` carries the
     * readable form.
     */
    id: defect.id,
    displayId: defect.id,
    unaffectedBrowsers,
    title: defect.summary,
    severity: defect.severity,
    module: defect.module,
    // A defect may name its own owner when it belongs to another team; the rest
    // go to the configured default rather than reaching triage unassigned.
    owner: defect.owner ?? defaultOwner,
    method: '',
    endpointPath: '',
    description: defect.evidence,
    requestBody: '',
    expected: defect.expected,
    actual:
      `Observed by ${seen.length} test(s) across ${affected.length} browser(s) in this ` +
      `${runStatus} run — ${spread}.\nExamples: ${witnesses}`,
    // Every defect this bench finds is a functional conformance gap (a control
    // with no name, a route that does not guard, a feed that renders empty)
    // rather than a performance or compatibility finding — the same constant
    // `bugzilla-reporter.ts` writes into `status_whiteboard` as `[cat:…]`.
    category: 'Functional',
    priority: PRIORITY_BY_SEVERITY[defect.severity] ?? 'Normal',
    type: 'WEBSITE',
    browsers: browserCounts,
    sightingsByBrowser: groupTitlesByBrowser(seen),
  };
}

/** `{ chromium: 4, webkit: 64 }` — how many tests per browser saw a defect. */
function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Test titles per browser, de-duplicated and ordered, for the ticket body. */
function groupTitlesByBrowser(seen: readonly DefectSighting[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const sighting of seen) {
    const titles = (grouped[sighting.project] ??= []);
    // One test can be seen twice (a retry); the reader wants the test list, not
    // the attempt list.
    if (!titles.includes(sighting.testTitle)) titles.push(sighting.testTitle);
  }
  return grouped;
}

/**
 * Priority paired with each severity — the same mapping `bugzilla-reporter.ts`
 * sends, kept here so the dashboard and the filed ticket agree rather than each
 * deriving their own.
 */
const PRIORITY_BY_SEVERITY: Record<string, string> = {
  High: 'High',
  Medium: 'Normal',
  Low: 'Low',
};

/**
 * Return the model with each defect carrying the Bugzilla ticket it was filed
 * as. Pure, and applied AFTER filing, because a bug number does not exist until
 * the ticket is created — which is also why `dashboard-reporter.ts` now files
 * into Bugzilla before pushing to the dashboard. A defect with no entry in
 * `links` (dry run, Bugzilla unset, filing failed) comes back untouched, so this
 * is a no-op rather than a source of half-filled fields.
 */
export function withBugzillaLinks(
  model: RunModel,
  links: ReadonlyMap<string, BugzillaLink>,
): RunModel {
  if (links.size === 0) return model;
  return {
    ...model,
    defects: model.defects.map((defect) => {
      const link = links.get(defect.id);
      return link ? { ...defect, bugzillaId: link.id, bugzillaUrl: link.url } : defect;
    }),
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Pass rate over tests that actually produced a pass/fail. Null when none did. */
export function passRate(model: RunModel): number | null {
  const executed = model.run.passed + model.run.failed;
  if (executed === 0) return null;
  return Math.round((model.run.passed / executed) * 1000) / 10;
}

/**
 * The one-line verdict shared by every artifact.
 *
 * `BUG_REPORT.md`, `DEV_DIGEST.md` and the terminal all print this exact string —
 * a digest that grades a run differently from the report it summarises is worse
 * than no digest, because the two end up quoted against each other in the same
 * thread.
 */
export function verdict(model: RunModel): string {
  if (model.run.incomplete) {
    return (
      `INCOMPLETE RUN — ${model.run.accounted} of ${model.run.totalTests} planned tests ` +
      'reached a result. These numbers describe a truncated run, not a healthy one; ' +
      'do not read the pass rate as coverage.'
    );
  }
  /*
   * Unexplained failures come FIRST, before any defect count. The previous
   * order buried them: with 8 high-severity defects open, the "N failed with no
   * known defect" line could never be reached, so a run with 23 unaccounted
   * failures read exactly like a run with none. The reader's first question
   * about a red run is "is all of this explained?" — answer it first.
   */
  const orphans = model.run.unattributedFailures.length;
  const high = model.summary.bySeverity.High ?? 0;
  if (orphans > 0) {
    return (
      `${orphans} of ${model.run.failed} failure(s) have NO registered defect — triage those first` +
      (high > 0 ? `, then the ${high} high-severity defect(s) already open.` : '.')
    );
  }
  if (high > 0) {
    return `${high} high-severity application defect(s) open — fix before the next release.`;
  }
  if (model.run.failed > 0) {
    return `${model.run.failed} test(s) failed with no known defect attached — triage required.`;
  }
  return 'Clean run — every planned test reached a result and none failed.';
}
