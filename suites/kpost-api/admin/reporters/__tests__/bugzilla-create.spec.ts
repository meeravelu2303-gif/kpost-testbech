import { test, expect } from '@playwright/test';
import {
  createBug,
  createBugWithAlias,
  resetAliasHighWaterMark,
  resolveComponent,
  type BugFields,
  type BugzillaConfig,
} from '../dashboard-bugzilla';

/*
 * Regression cover for the 2026-08-17 filing failure, where 818 defects produced 818 identical
 * errors and no tickets.
 *
 * Two faults compounded. Bugzilla answers an application error with **HTTP 200 and
 * `{"error": true}`**, so a create refused by the database read as a success whose id had gone
 * missing — the log said "create response missing id" and the real message (a duplicate alias)
 * was discarded. And because an orphaned `KAD-001` row survived a rolled-back create while the
 * bug search returned nothing, every defect computed the same next alias and collided forever.
 */

const config: BugzillaConfig = {
  url: 'http://bugzilla.test/rest',
  apiKey: 'test-key',
  product: 'KPost Admin',
  version: 'unspecified',
  dryRun: false,
  clientAlias: true,
  fallbackComponent: 'admin-module-application',
  aliasPrefix: 'KAD',
  maxFile: 0,
};

const fields: BugFields = {
  product: 'KPost Admin',
  component: 'Departments',
  summary: '[BUG-API-ABC123] something is wrong',
  version: 'unspecified',
  description: 'body',
  severity: 'major',
  priority: 'High',
  op_sys: 'All',
  platform: 'All',
  status_whiteboard: '[cat:Functional]',
};

const DUPLICATE_ALIAS_BODY = {
  error: true,
  code: 100500,
  message:
    "DBD::MariaDB::st execute failed: Duplicate entry 'KAD-001' for key 'bugs_aliases_alias_idx' [for Statement \"INSERT INTO bugs_aliases\"] at Bugzilla/Bug.pm line 835.\n\tBugzilla::Bug::create called at line 744",
};

interface Server {
  requests: { url: string; body: unknown }[];
  createdAliases: string[];
}

/**
 * A Bugzilla whose alias index already holds everything in `taken`, and whose bug search is
 * blind to them — the live instance's exact state.
 */
function stubBugzilla(taken: string[]): Server {
  const state: Server = { requests: [], createdAliases: [] };
  const held = new Set(taken);

  globalThis.fetch = (async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ url, body });

    // Alias lookup: the search cannot see the bugs holding `taken`.
    if (!init?.body) return json({ bugs: [] });

    const alias: string | undefined = body?.alias?.[0];
    if (alias && held.has(alias)) return json(DUPLICATE_ALIAS_BODY);
    if (alias) {
      held.add(alias);
      state.createdAliases.push(alias);
    }
    return json({ id: 100 + state.createdAliases.length });
  }) as unknown as typeof fetch;

  return state;
}

/** Bugzilla returns application errors with HTTP 200, which is the point of these tests. */
function json(payload: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
}

test.describe('Bugzilla create error handling', () => {
  const realFetch = globalThis.fetch;

  test.beforeEach(() => resetAliasHighWaterMark());
  test.afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('an HTTP 200 carrying error:true is reported as a failure, not a missing id', async () => {
    stubBugzilla(['KAD-001']);

    const result = await createBug(config, { ...fields, alias: ['KAD-001'] });

    expect('error' in result, 'a 200 with {"error":true} must not be read as a successful create').toBe(true);
    if ('error' in result) {
      expect(
        result.error,
        'the operator needs Bugzilla\'s own message - "create response missing id" named the symptom and hid the cause'
      ).toContain('Duplicate entry');
    }
  });

  test('a taken alias is stepped over instead of failing the ticket', async () => {
    const server = stubBugzilla(['KAD-001']);

    const result = await createBugWithAlias(config, fields, 'KAD');

    expect('error' in result, 'an unavailable alias must not cost the defect its ticket').toBe(false);
    if (!('error' in result)) {
      expect(result.alias, 'KAD-001 was taken, so the next free number must be used').toBe('KAD-002');
    }
    expect(server.createdAliases, 'exactly one bug should exist, under the free alias').toEqual(['KAD-002']);
  });

  test('consecutive defects keep advancing when the search cannot see prior aliases', async () => {
    // The live failure: the bug search returns nothing, so every defect recomputed max=0.
    const server = stubBugzilla([]);

    const first = await createBugWithAlias(config, fields, 'KAD');
    const second = await createBugWithAlias(config, fields, 'KAD');
    const third = await createBugWithAlias(config, fields, 'KAD');

    expect(
      [first, second, third].every((r) => !('error' in r)),
      'three defects in one run must all file'
    ).toBe(true);
    expect(
      server.createdAliases,
      'a blind search must not make every defect ask for KAD-001 - that is the loop that filed nothing'
    ).toEqual(['KAD-001', 'KAD-002', 'KAD-003']);
  });

  test('a module with no matching component is filed under the fallback', () => {
    const valid = new Set(['Departments', 'admin-module-application']);

    expect(
      resolveComponent('Unclassified', valid, 'admin-module-application'),
      "Bugzilla refuses an unknown component outright - an 'Unclassified' defect would otherwise never be filed while the dashboard still counted it"
    ).toBe('admin-module-application');
  });

  test('a module that does have a component is left alone', () => {
    const valid = new Set(['Departments', 'admin-module-application']);

    expect(
      resolveComponent('Departments', valid, 'admin-module-application'),
      'a real component must never be rewritten - that would route the ticket to the wrong team'
    ).toBe('Departments');
  });

  test('an unreadable component list changes nothing', () => {
    expect(
      resolveComponent('Departments', new Set(), 'admin-module-application'),
      'a failed metadata read must not make the reporter rewrite every ticket'
    ).toBe('Departments');
  });

  test('a fallback that is itself not a component is not substituted', () => {
    const valid = new Set(['Departments']);

    expect(
      resolveComponent('Unclassified', valid, 'does-not-exist'),
      "swapping one invalid component for another only hides Bugzilla's explanation"
    ).toBe('Unclassified');
  });

  test('a non-alias error is surfaced immediately rather than retried', async () => {
    globalThis.fetch = (async (_input: string | URL, init?: { body?: string }) => {
      if (!init?.body) return json({ bugs: [] });
      return json({ error: true, code: 51, message: 'The component you specified does not exist.' });
    }) as unknown as typeof fetch;

    const result = await createBugWithAlias(config, fields, 'KAD');

    expect('error' in result, 'a bad component is not fixable by changing the alias').toBe(true);
    if ('error' in result) {
      expect(result.error, 'the real reason must reach the log').toContain('component you specified does not exist');
    }
  });
});
