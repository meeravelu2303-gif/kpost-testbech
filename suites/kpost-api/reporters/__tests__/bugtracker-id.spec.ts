import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import {
  compileGrouping,
  readBugLedger,
  recordBug,
  type BugInput,
  type BugRecord,
} from '../../src/utils/bugTracker';

/*
 * Offline coverage for bug identity and grouping — no network, no live backend.
 *
 * The defect this guards, and the reason it was rewritten: identity used to be scoped to the
 * reporting test, so one backend fault tripped by hundreds of cases filed hundreds of tickets.
 * The Bugzilla product reached 1283 open bugs describing a far smaller number of real defects,
 * at which point nobody could triage it. Identity is now the content fingerprint, and the
 * per-test detail survives as *occurrences* merged in the reporter process.
 *
 * `recordBug` writes into `.bug-cache/`, so each test deletes the records it creates — the real
 * ledger for a run is reset by globalSetup, which this config deliberately does not run.
 */

const BUG_CACHE_DIR = path.resolve(__dirname, '..', '..', '.bug-cache');
const OCCURRENCE_DIR = path.join(BUG_CACHE_DIR, 'occurrences');

/** Identical in every field that determines identity. */
function collidingInput(overrides: Partial<BugInput> = {}): BugInput {
  return {
    title: 'Unauthenticated requests answered 400 instead of 401/403',
    severity: 'Major',
    module: 'Auth',
    method: 'GET',
    endpointPath: '/v2/signupLogin/getActiveSession',
    classification: 'Security/Access Control',
    description: 'Identical content, filed from two different tests.',
    requestHeaders: {},
    expected: 'HTTP 401 Unauthorized or 403 Forbidden',
    actual: 'HTTP 400',
    reproSnippet: 'npx playwright test -g "getActiveSession"',
    ...overrides,
  } as BugInput;
}

function cleanUp(ids: string[]): void {
  for (const id of ids) {
    try {
      fs.unlinkSync(path.join(BUG_CACHE_DIR, `${id}.json`));
    } catch {
      // Never written, or already gone.
    }
    fs.rmSync(path.join(OCCURRENCE_DIR, id), { recursive: true, force: true });
  }
}

/** The record as it sits on disk, with its occurrence files merged in. */
function grouped(id: string): BugRecord {
  const record = JSON.parse(
    fs.readFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), 'utf-8')
  ) as BugRecord;
  compileGrouping([record]);
  return record;
}

test.describe('bug identity is the defect, not the test that found it', () => {
  test('two different tests filing identical content collapse into one defect', () => {
    const title = 'collapse: two tests, identical content';
    const first = recordBug(collidingInput({ testId: 'test-alpha', title }));
    const second = recordBug(collidingInput({ testId: 'test-beta', title }));

    expect(
      second,
      'identical content from two tests is one defect with one fix - filing it twice is what put 1283 bugs in a tracker holding far fewer real faults'
    ).toBe(first);

    const record = grouped(first);
    expect(record.occurrences, 'both observations must be counted, not discarded').toBe(2);
    expect(record.observedByTests, 'every observing test must be recoverable from the ticket').toEqual([
      'test-alpha',
      'test-beta',
    ]);

    cleanUp([first, second]);
  });

  test('an explicit dedupeKey collapses a systemic defect across endpoints too', () => {
    const key = 'SYSTEMIC:auth-status:400';
    const first = recordBug(
      collidingInput({ testId: 'test-gamma', dedupeKey: key, endpointPath: '/v2/a' })
    );
    const second = recordBug(
      collidingInput({ testId: 'test-delta', dedupeKey: key, endpointPath: '/v2/b' })
    );

    expect(
      second,
      'one filter-chain fault observed on two routes is one ticket - that is what dedupeKey is for'
    ).toBe(first);

    const record = grouped(first);
    expect(record.affectedEndpoints?.length, 'both endpoints must appear in the ticket').toBe(2);
    expect(
      record.affectedEndpoints?.map((endpoint) => endpoint.endpointPath).sort(),
      'grouping must not lose which routes are affected - that list is the whole value of the ticket'
    ).toEqual(['/v2/a', '/v2/b']);

    cleanUp([first, second]);
  });

  test('two genuinely different faults on one endpoint stay separate', () => {
    const first = recordBug(collidingInput({ testId: 'test-eta', title: 'split: fault one' }));
    const second = recordBug(collidingInput({ testId: 'test-eta', title: 'split: fault two' }));

    expect(
      second,
      'a different fault is a different ticket - over-grouping hides defects, which is worse than the duplication it fixes'
    ).not.toBe(first);

    cleanUp([first, second]);
  });

  test('one test observing the same defect twice counts once', () => {
    const title = 'dedup: same test, same endpoint, twice';
    const first = recordBug(collidingInput({ testId: 'test-epsilon', title }));
    const second = recordBug(collidingInput({ testId: 'test-epsilon', title }));

    expect(second, 'same defect, same test, same endpoint - one occurrence').toBe(first);
    expect(
      grouped(first).occurrences,
      'occurrences measure how much of the suite and surface a defect touches, not how many assertion calls were made'
    ).toBe(1);

    cleanUp([first, second]);
  });

  test('the id is stable across runs so a re-run comments instead of re-filing', () => {
    const title = 'stability: id survives a re-run';
    const first = recordBug(collidingInput({ testId: 'test-theta', title }));
    cleanUp([first]);
    const second = recordBug(collidingInput({ testId: 'test-theta', title }));

    expect(
      second,
      'Bugzilla dedup searches the summary for this hash - an id that moves between runs re-files every defect nightly'
    ).toBe(first);

    cleanUp([second]);
  });

  test('the filed record carries its testId so the safety net can tell who filed', () => {
    const id = recordBug(collidingInput({ testId: 'test-zeta', title: 'metadata: testId survives onto the record' }));
    const record = JSON.parse(fs.readFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), 'utf-8'));

    expect(
      record.testId,
      'without testId on the record, bug-safety-net cannot distinguish a test that filed from one that did not, and would double-file'
    ).toBe('test-zeta');

    cleanUp([id]);
  });
});

test.describe('grouping metadata', () => {
  test('ownership follows the module holding the most affected endpoints', () => {
    /*
     * A systemic fault spans owning teams. Routing it to whichever test happened to run first
     * is an accident of scheduling; routing it to the weighted winner is defensible, and every
     * other owner is still named on the ticket.
     */
    const key = 'SYSTEMIC:ownership-test';
    const ids = [
      recordBug(
        collidingInput({ testId: 't1', dedupeKey: key, endpointPath: '/v2/x', module: 'Alpha' })
      ),
      recordBug(
        collidingInput({ testId: 't2', dedupeKey: key, endpointPath: '/v2/y', module: 'Beta' })
      ),
      recordBug(
        collidingInput({ testId: 't3', dedupeKey: key, endpointPath: '/v2/z', module: 'Beta' })
      ),
    ];

    const record = grouped(ids[0]);
    expect(
      record.affectedModules?.[0],
      'the module with the most affected endpoints owns the ticket - a ticket addressed to everyone is addressed to no one'
    ).toBe('Beta');
    expect(record.affectedModules, 'every other owner must still be named').toEqual(['Beta', 'Alpha']);

    cleanUp(ids);
  });

  test('category is derived from the flaw classification', () => {
    const security = recordBug(collidingInput({ testId: 'cat-1', title: 'category: security derivation' }));
    const functional = recordBug(
      collidingInput({
        testId: 'cat-2',
        title: 'Wrong status code',
        classification: 'Incorrect HTTP Status',
      })
    );

    const read = (id: string) =>
      JSON.parse(fs.readFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), 'utf-8')) as BugRecord;

    expect(read(security).category, 'Security/* classifications are the Security category').toBe(
      'Security'
    );
    expect(read(functional).category, 'a wrong status code is a functional defect').toBe('Functional');

    cleanUp([security, functional]);
  });

  test('an explicit category overrides the derived one', () => {
    const id = recordBug(
      collidingInput({ testId: 'cat-3', title: 'Slow under load', category: 'Performance' })
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), 'utf-8')
    ) as BugRecord;

    expect(record.category, 'a call site that knows better must win over the derivation').toBe(
      'Performance'
    );

    cleanUp([id]);
  });

  test('the same fault on two endpoints is one defect under the default fault grouping', () => {
    /*
     * The behaviour the whole change exists for. Under `endpoint` grouping these file
     * separately, which is the conservative setting; the default is `fault`, because one auth
     * filter answering 400 on 227 routes is one thing a developer fixes.
     */
    const title = 'fault-grouping: same fault, two routes';
    const first = recordBug(collidingInput({ testId: 'fg-1', title, endpointPath: '/v2/one' }));
    const second = recordBug(collidingInput({ testId: 'fg-2', title, endpointPath: '/v2/two' }));

    expect(
      second,
      'the endpoint is not part of identity under fault grouping - that is what collapses 1283 findings to 565 defects'
    ).toBe(first);

    const record = grouped(first);
    expect(record.affectedEndpoints?.length, 'both routes must be listed on the one ticket').toBe(2);

    cleanUp([first, second]);
  });

  test('a different classification with the same title is a different defect', () => {
    const title = 'classification-split: identical wording';
    const first = recordBug(
      collidingInput({ testId: 'cs-1', title, classification: 'Input Validation Gap' })
    );
    const second = recordBug(
      collidingInput({ testId: 'cs-2', title, classification: 'Incorrect HTTP Status' })
    );

    expect(
      second,
      'classification is part of the fingerprint - two fault kinds that happen to share wording must not merge'
    ).not.toBe(first);

    cleanUp([first, second]);
  });

  test('a record with no occurrence files still reads as a group of one', () => {
    /*
     * Guards every consumer that reads `occurrences` unconditionally. A ledger written before
     * grouping existed, or a hand-built record in a test, has no occurrence directory — and
     * must not produce `undefined` where a count is expected.
     */
    const record = { ...collidingInput(), id: 'BUG-API-ORPHAN', owner: 'x', priority: 'P1' } as unknown as BugRecord;
    compileGrouping([record]);

    expect(record.occurrences).toBe(1);
    expect(record.affectedEndpoints?.length).toBe(1);
    expect(record.affectedModules).toEqual(['Auth']);
  });

  test('readBugLedger returns grouped records', () => {
    const first = recordBug(collidingInput({ testId: 'led-1', title: 'Ledger grouping check' }));
    recordBug(collidingInput({ testId: 'led-2', title: 'Ledger grouping check' }));

    const record = readBugLedger().find((entry) => entry.id === first);
    expect(record, 'the defect must be on the ledger').toBeTruthy();
    expect(
      record?.occurrences,
      'run-model reads this ledger before bugReporter does - both must see the same grouped shape'
    ).toBe(2);

    cleanUp([first]);
  });
});
