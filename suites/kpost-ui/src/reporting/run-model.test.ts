import { describe, expect, it } from 'vitest';
import type { KnownDefect } from '../utils/known-defects';
import {
  type DefectSighting,
  buildRunModel,
  passRate,
  severityRank,
  verdict,
  withBugzillaLinks,
} from './run-model';

/**
 * Unit tests for the run model.
 *
 * This is the highest-consequence code in the bench: `BUG_REPORT.*`,
 * `DEV_DIGEST.*` and the QA-Dashboard payload are all projections of what
 * `buildRunModel` returns. A miscount here does not crash anything — it produces
 * four well-formed artifacts that confidently state the wrong thing, which is
 * exactly the failure this bench exists to prevent.
 *
 * The cases below pin the honesty rules documented in the module header and in
 * CLAUDE.md: the planned total is never rescaled, one vote per test, interrupted
 * is its own outcome, and an incomplete run says so.
 */

function outcomesOf(...statuses: readonly string[]): Map<string, string> {
  return new Map(statuses.map((status, index) => [`test-${index}`, status]));
}

function defect(overrides: Partial<KnownDefect> = {}): KnownDefect {
  return {
    id: 'KPOST-TEST-001',
    summary: 'Something in the app is wrong.',
    evidence: 'Observed against the live app.',
    expected: 'The app behaves correctly.',
    severity: 'Medium',
    module: 'TestModule',
    ...overrides,
  };
}

function sightingsOf(
  ...entries: readonly { defect: KnownDefect; seen: DefectSighting[] }[]
): Map<string, { defect: KnownDefect; seen: DefectSighting[] }> {
  return new Map(entries.map((entry) => [entry.defect.id, entry]));
}

function seenOnce(status = 'failed'): DefectSighting[] {
  return [{ testTitle: 'a test', project: 'chromium', status }];
}

function build(overrides: Partial<Parameters<typeof buildRunModel>[0]> = {}) {
  return buildRunModel({
    status: 'passed',
    environment: 'Local',
    baseURL: 'https://localhost:3000',
    totalTests: 0,
    projects: ['chromium'],
    durationMs: 0,
    outcomes: new Map(),
    sightings: new Map(),
    defectOwner: 'Ayyappan',
    ...overrides,
  });
}

describe('buildRunModel — counting outcomes', () => {
  it('counts each terminal status into its own bucket', () => {
    const model = build({
      totalTests: 4,
      outcomes: outcomesOf('passed', 'failed', 'skipped', 'interrupted'),
    });

    expect(model.run.passed).toBe(1);
    expect(model.run.failed).toBe(1);
    expect(model.run.skipped).toBe(1);
    expect(model.run.interrupted).toBe(1);
  });

  it('counts a timed-out test as failed', () => {
    const model = build({ totalTests: 1, outcomes: outcomesOf('timedOut') });

    expect(model.run.failed).toBe(1);
    expect(model.run.passed).toBe(0);
  });

  it('counts an unrecognised status as failed rather than dropping it', () => {
    // Dropping it would shrink `accounted` and misreport the run as more
    // complete than it was — the conservative reading is the honest one.
    const model = build({ totalTests: 1, outcomes: outcomesOf('some-future-status') });

    expect(model.run.failed).toBe(1);
    expect(model.run.accounted).toBe(1);
  });

  it('keeps interrupted out of accounted, because it neither passed nor failed nor was skipped', () => {
    const model = build({
      totalTests: 3,
      outcomes: outcomesOf('passed', 'failed', 'interrupted'),
    });

    expect(model.run.accounted).toBe(2);
    expect(model.run.interrupted).toBe(1);
  });

  it('takes one vote per test, so a map holds only the last attempt', () => {
    // The reporter keys outcomes by test id, so a retried flaky test that ended
    // green is one passed test — not one failure plus one pass.
    const outcomes = new Map<string, string>();
    outcomes.set('flaky-test', 'failed');
    outcomes.set('flaky-test', 'passed');

    const model = build({ totalTests: 1, outcomes });

    expect(model.run.passed).toBe(1);
    expect(model.run.failed).toBe(0);
    expect(model.run.accounted).toBe(1);
  });
});

describe('buildRunModel — the planned total is never rescaled', () => {
  it('reports the gap between planned and accounted instead of closing it', () => {
    const model = build({ totalTests: 236, outcomes: outcomesOf('passed', 'failed') });

    expect(model.run.totalTests).toBe(236);
    expect(model.run.accounted).toBe(2);
    expect(model.run.unaccounted).toBe(234);
  });

  it('never reports a negative unaccounted count', () => {
    const model = build({ totalTests: 1, outcomes: outcomesOf('passed', 'passed', 'passed') });

    expect(model.run.unaccounted).toBe(0);
  });
});

describe('buildRunModel — completeness', () => {
  it('treats a run that accounted for everything it planned as complete', () => {
    const model = build({ totalTests: 2, outcomes: outcomesOf('passed', 'failed') });

    expect(model.run.incomplete).toBe(false);
    expect(model.run.incompleteReasons).toEqual([]);
  });

  it('flags a run that left planned tests without a result', () => {
    const model = build({ totalTests: 10, outcomes: outcomesOf('passed') });

    expect(model.run.incomplete).toBe(true);
    expect(model.run.incompleteReasons.join(' ')).toContain('1 of 10 planned tests');
  });

  it('flags a run Playwright ended as interrupted', () => {
    const model = build({ status: 'interrupted', totalTests: 1, outcomes: outcomesOf('passed') });

    expect(model.run.incomplete).toBe(true);
    expect(model.run.incompleteReasons[0]).toContain('interrupted');
  });

  it('flags a run Playwright ended as timed out', () => {
    const model = build({ status: 'timedout', totalTests: 1, outcomes: outcomesOf('passed') });

    expect(model.run.incomplete).toBe(true);
  });

  it('names every reason a run was incomplete, not just the first', () => {
    const model = build({
      status: 'interrupted',
      totalTests: 10,
      outcomes: outcomesOf('passed', 'interrupted'),
    });

    expect(model.run.incompleteReasons).toHaveLength(3);
    expect(model.run.incompleteReasons.join(' ')).toContain('cut off mid-flight');
  });
});

describe('buildRunModel — duration', () => {
  it('converts milliseconds to one decimal place of seconds', () => {
    const model = build({ durationMs: 1_541_800 });

    expect(model.run.durationSeconds).toBe(1541.8);
  });

  it('clamps a negative duration to zero rather than reporting negative time', () => {
    const model = build({ durationMs: -5000 });

    expect(model.run.durationMs).toBe(0);
    expect(model.run.durationSeconds).toBe(0);
  });
});

describe('buildRunModel — defects', () => {
  it('orders defects by severity, then by id', () => {
    const model = build({
      sightings: sightingsOf(
        { defect: defect({ id: 'KPOST-B-001', severity: 'Low' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-A-001', severity: 'High' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-C-001', severity: 'Medium' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-A-002', severity: 'High' }), seen: seenOnce() },
      ),
    });

    expect(model.defects.map((d) => d.id)).toEqual([
      'KPOST-A-001',
      'KPOST-A-002',
      'KPOST-C-001',
      'KPOST-B-001',
    ]);
  });

  it('tallies defects by severity and by module', () => {
    const model = build({
      sightings: sightingsOf(
        { defect: defect({ id: 'KPOST-1', severity: 'High', module: 'KMail' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-2', severity: 'High', module: 'Auth' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-3', severity: 'Low', module: 'KMail' }), seen: seenOnce() },
      ),
    });

    expect(model.summary.total).toBe(3);
    expect(model.summary.bySeverity).toEqual({ High: 2, Low: 1 });
    expect(model.summary.byModule).toEqual({ KMail: 2, Auth: 1 });
  });

  it('records how many tests witnessed the defect, and which', () => {
    const model = build({
      status: 'failed',
      sightings: sightingsOf({
        defect: defect(),
        seen: [
          { testTitle: 'logout redirects', project: 'chromium', status: 'failed' },
          { testTitle: 'logout redirects', project: 'webkit', status: 'failed' },
        ],
      }),
    });

    // ONE record for the defect, naming both browsers that saw it.
    expect(model.defects).toHaveLength(1);
    expect(model.defects[0].actual).toContain('Observed by 2 test(s) across 2 browser(s)');
    expect(model.defects[0].actual).toContain('logout redirects [chromium] (failed)');
    expect(model.defects[0].actual).toContain('logout redirects [webkit] (failed)');
  });

  it('assigns every defect to the configured owner, so none reaches triage unassigned', () => {
    const model = build({
      defectOwner: 'Ayyappan',
      sightings: sightingsOf({ defect: defect(), seen: seenOnce() }),
    });

    expect(model.defects[0].owner).toBe('Ayyappan');
  });

  it('lets a defect name its own owner when it belongs to another team', () => {
    const model = build({
      defectOwner: 'Ayyappan',
      sightings: sightingsOf({
        defect: defect({ owner: 'Backend Team' }),
        seen: seenOnce(),
      }),
    });

    expect(model.defects[0].owner).toBe('Backend Team');
  });

  it('leaves the API bench’s endpoint vocabulary empty for a UI defect', () => {
    // Inventing a method or endpoint to fill the column would put fiction in a
    // bug ticket — a UI defect has no endpoint to name.
    const model = build({ sightings: sightingsOf({ defect: defect(), seen: seenOnce() }) });

    expect(model.defects[0].method).toBe('');
    expect(model.defects[0].endpointPath).toBe('');
    expect(model.defects[0].requestBody).toBe('');
  });

  it('carries the registry’s own wording through to the report', () => {
    const entry = defect({ summary: 'KMail throws on load.', expected: 'KMail loads cleanly.' });
    const model = build({ sightings: sightingsOf({ defect: entry, seen: seenOnce() }) });

    expect(model.defects[0].title).toBe('KMail throws on load.');
    expect(model.defects[0].expected).toBe('KMail loads cleanly.');
    expect(model.defects[0].description).toBe(entry.evidence);
  });
});

describe('severityRank', () => {
  it('ranks known severities in fix-first order', () => {
    expect(severityRank('High')).toBe(0);
    expect(severityRank('Medium')).toBe(1);
    expect(severityRank('Low')).toBe(2);
  });

  it('sorts an unknown severity last rather than first', () => {
    expect(severityRank('Cosmetic')).toBe(3);
  });
});

describe('passRate', () => {
  it('measures passes against tests that actually produced a pass or fail', () => {
    const model = build({
      totalTests: 236,
      outcomes: new Map([
        ...Array.from({ length: 49 }, (_, i) => [`p${i}`, 'passed'] as const),
        ...Array.from({ length: 181 }, (_, i) => [`f${i}`, 'failed'] as const),
      ]),
    });

    // The real 2026-08-14 run: 49 of 230 executed.
    expect(passRate(model)).toBe(21.3);
  });

  it('excludes skipped tests from the denominator', () => {
    const model = build({ totalTests: 4, outcomes: outcomesOf('passed', 'failed', 'skipped') });

    expect(passRate(model)).toBe(50);
  });

  it('returns null when nothing executed, rather than claiming zero percent', () => {
    const model = build({ totalTests: 5, outcomes: outcomesOf('skipped') });

    expect(passRate(model)).toBeNull();
  });
});

describe('verdict', () => {
  it('reports truncation ahead of anything else, so no one reads the pass rate as coverage', () => {
    const model = build({
      totalTests: 236,
      outcomes: outcomesOf('failed'),
      sightings: sightingsOf({ defect: defect({ severity: 'High' }), seen: seenOnce() }),
    });

    expect(verdict(model)).toContain('INCOMPLETE RUN');
  });

  it('calls out high-severity defects on a complete run', () => {
    const model = build({
      totalTests: 1,
      outcomes: outcomesOf('failed'),
      sightings: sightingsOf({ defect: defect({ severity: 'High' }), seen: seenOnce() }),
    });

    expect(verdict(model)).toContain('1 high-severity application defect(s) open');
  });

  it('asks for triage when tests failed with no known defect attached', () => {
    const model = build({ totalTests: 2, outcomes: outcomesOf('failed', 'passed') });

    expect(verdict(model)).toContain('triage required');
  });

  it('declares a clean run only when everything was accounted for and nothing failed', () => {
    const model = build({ totalTests: 2, outcomes: outcomesOf('passed', 'passed') });

    expect(verdict(model)).toContain('Clean run');
  });
});

describe('buildRunModel — passthrough fields', () => {
  it('stamps an ISO timestamp and a human-readable UTC variant', () => {
    const model = build();

    expect(model.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(model.generatedAtHuman).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });

  it('reports the environment code and base URL separately', () => {
    const model = build({ environment: 'QA', baseURL: 'https://qa.example.com' });

    expect(model.environment).toBe('QA');
    expect(model.baseURL).toBe('https://qa.example.com');
  });

  it('copies the project list rather than aliasing the caller’s array', () => {
    const projects = ['chromium', 'firefox'];
    const model = build({ projects });
    projects.push('webkit');

    expect(model.run.projects).toEqual(['chromium', 'firefox']);
  });
});

describe('defect classification', () => {
  it('tags every defect as a functional website defect', () => {
    const model = build({ sightings: sightingsOf({ defect: defect(), seen: seenOnce() }) });

    expect(model.defects[0].category).toBe('Functional');
    expect(model.defects[0].type).toBe('WEBSITE');
  });

  it('pairs a priority with each severity, matching what Bugzilla is sent', () => {
    const model = build({
      sightings: sightingsOf(
        { defect: defect({ id: 'KPOST-H', severity: 'High' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-M', severity: 'Medium' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-L', severity: 'Low' }), seen: seenOnce() },
      ),
    });

    const byId = Object.fromEntries(model.defects.map((d) => [d.id, d.priority]));
    expect(byId).toEqual({ 'KPOST-H': 'High', 'KPOST-M': 'Normal', 'KPOST-L': 'Low' });
  });

  it('falls back to Normal priority for an unrecognised severity', () => {
    const model = build({
      sightings: sightingsOf({ defect: defect({ severity: 'Cosmic' as never }), seen: seenOnce() }),
    });

    expect(model.defects[0].priority).toBe('Normal');
  });
});

describe('withBugzillaLinks', () => {
  const model = () =>
    build({
      sightings: sightingsOf(
        { defect: defect({ id: 'KPOST-A-001', severity: 'High' }), seen: seenOnce() },
        { defect: defect({ id: 'KPOST-B-001', severity: 'Low' }), seen: seenOnce() },
      ),
    });

  it('attaches the filed ticket to the defect it belongs to', () => {
    const linked = withBugzillaLinks(
      model(),
      new Map([['KPOST-A-001', { id: 635, url: 'http://bugzilla/show_bug.cgi?id=635' }]]),
    );

    const a = linked.defects.find((d) => d.id === 'KPOST-A-001');
    expect(a?.bugzillaId).toBe(635);
    expect(a?.bugzillaUrl).toBe('http://bugzilla/show_bug.cgi?id=635');
  });

  it('leaves a defect with no filed ticket untouched rather than half-filled', () => {
    const linked = withBugzillaLinks(
      model(),
      new Map([['KPOST-A-001', { id: 635, url: 'http://bugzilla/show_bug.cgi?id=635' }]]),
    );

    const b = linked.defects.find((d) => d.id === 'KPOST-B-001');
    expect(b?.bugzillaId).toBeUndefined();
    expect(b?.bugzillaUrl).toBeUndefined();
  });

  it('is a no-op when nothing was filed (dry run, Bugzilla unset, or filing failed)', () => {
    const original = model();

    expect(withBugzillaLinks(original, new Map())).toBe(original);
  });

  it('changes nothing about the run counts it carries', () => {
    const original = model();
    const linked = withBugzillaLinks(
      original,
      new Map([['KPOST-A-001', { id: 1, url: 'http://bugzilla/show_bug.cgi?id=1' }]]),
    );

    expect(linked.run).toEqual(original.run);
    expect(linked.summary).toEqual(original.summary);
  });
});

describe('browser attribution', () => {
  it('counts, per browser, how many tests saw the defect', () => {
    const model = build({
      sightings: sightingsOf({
        defect: defect(),
        seen: [
          { testTitle: 'a', project: 'webkit', status: 'failed' },
          { testTitle: 'b', project: 'webkit', status: 'failed' },
          { testTitle: 'c', project: 'chromium', status: 'failed' },
        ],
      }),
    });

    expect(model.defects).toHaveLength(1);
    expect(model.defects[0].browsers).toEqual({ webkit: 2, chromium: 1 });
  });

  it('lists the test titles under each browser', () => {
    const model = build({
      sightings: sightingsOf({
        defect: defect(),
        seen: [
          { testTitle: 'opens KMail', project: 'chromium', status: 'failed' },
          { testTitle: 'opens KMail', project: 'firefox', status: 'failed' },
        ],
      }),
    });

    expect(model.defects[0].sightingsByBrowser).toEqual({
      chromium: ['opens KMail'],
      firefox: ['opens KMail'],
    });
  });

  it('does not list the same test twice when a retry re-sights it', () => {
    const model = build({
      sightings: sightingsOf({
        defect: defect(),
        seen: [
          { testTitle: 'flaky one', project: 'chromium', status: 'failed' },
          { testTitle: 'flaky one', project: 'chromium', status: 'failed' },
        ],
      }),
    });

    expect(model.defects[0].sightingsByBrowser.chromium).toEqual(['flaky one']);
  });
});

describe('unattributed failures', () => {
  const orphan = (overrides = {}) => ({
    testTitle: 'something broke',
    project: 'chromium',
    file: 'home/home.spec.ts',
    error: 'Error: expect(locator).toBeVisible() failed',
    ...overrides,
  });

  it('carries them onto the model so the report can show its own residue', () => {
    const model = build({
      outcomes: outcomesOf('failed', 'failed'),
      unattributedFailures: [orphan()],
    });

    expect(model.run.unattributedFailures).toHaveLength(1);
    expect(model.run.unattributedFailures[0].testTitle).toBe('something broke');
  });

  it('defaults to an empty list rather than undefined', () => {
    expect(build().run.unattributedFailures).toEqual([]);
  });

  it('leads the verdict with them, ahead of any severity count', () => {
    const model = build({
      status: 'failed',
      outcomes: outcomesOf('failed', 'failed', 'failed'),
      sightings: sightingsOf({ defect: defect({ severity: 'High' }), seen: seenOnce() }),
      unattributedFailures: [orphan(), orphan({ testTitle: 'another' })],
    });

    // The old order announced the High defect and never mentioned the residue.
    expect(verdict(model)).toContain('2 of 3 failure(s) have NO registered defect');
    expect(verdict(model)).toContain('high-severity');
  });

  it('reports the high-severity verdict when every failure IS attributed', () => {
    const model = build({
      status: 'failed',
      outcomes: outcomesOf('failed'),
      sightings: sightingsOf({ defect: defect({ severity: 'High' }), seen: seenOnce() }),
    });

    expect(verdict(model)).toBe(
      '1 high-severity application defect(s) open — fix before the next release.',
    );
  });
});
