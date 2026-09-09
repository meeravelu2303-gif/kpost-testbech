import { test, expect } from '@playwright/test';
import { getNextAlias, resetAliasHighWaterMark, type BugzillaConfig } from '../dashboard-bugzilla';

/*
 * Offline unit coverage for `getNextAlias` — no Bugzilla instance, no network. `globalThis.fetch`
 * is stubbed with a server that behaves the way Bugzilla's bug search actually behaves: it
 * applies a default page size and truncates *silently*, returning a well-formed 200 with no
 * marker distinguishing "these are all the bugs" from "these are the first 20 of 250".
 *
 * That silence is the whole point of these tests. A truncated page cannot be detected at
 * runtime, so the only defence is asking for the full set up front (`limit=0`) — and the only
 * way to prove the code still asks is a server that would punish it for forgetting.
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

/** Bugzilla's stock default; the exact number does not matter, only that a cap exists. */
const DEFAULT_PAGE_SIZE = 20;

interface StubServer {
  /** Every URL the code under test requested, in order. */
  requests: string[];
  /** How many bugs the last response actually carried. */
  served: number;
}

/**
 * Installs a paginating Bugzilla. `limit=0` returns everything; any other limit (including an
 * absent one) truncates to `DEFAULT_PAGE_SIZE`, exactly as the real search does.
 */
function stubBugzilla(aliases: string[]): StubServer {
  const state: StubServer = { requests: [], served: 0 };

  const fetchStub = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    state.requests.push(url);

    const limit = new URL(url).searchParams.get('limit');
    const unlimited = limit === '0';
    const page = unlimited ? aliases : aliases.slice(0, DEFAULT_PAGE_SIZE);
    state.served = page.length;

    const body = JSON.stringify({ bugs: page.map((alias) => ({ alias: [alias] })) });
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  };

  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return state;
}

/** `KAD-001 … KAD-<count>`, ascending, so the highest number is the last one served. */
function ascendingAliases(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `KAD-${String(index + 1).padStart(3, '0')}`);
}

test.describe('getNextAlias - pagination', () => {
  const realFetch = globalThis.fetch;

  // The mark is process state; without this each case would inherit the previous case's max.
  test.beforeEach(() => resetAliasHighWaterMark());

  test.afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('asks Bugzilla for the entire result set rather than one default page', async () => {
    const server = stubBugzilla(ascendingAliases(250));

    await getNextAlias(config, 'KAD');

    expect(
      server.requests[0],
      'alias lookup must send limit=0 - without it Bugzilla returns one page, the max reads low, and the next create collides with an alias it never saw'
    ).toContain('limit=0');
  });

  test('computes the max across a product larger than one page', async () => {
    const server = stubBugzilla(ascendingAliases(250));

    const alias = await getNextAlias(config, 'KAD');

    expect(
      server.served,
      'the stub truncates to 20 unless limit=0 was sent - serving fewer than 250 means the query was paginated'
    ).toBe(250);
    expect(
      alias,
      'next alias must follow the highest alias in the whole product (KAD-250), not the highest on page one'
    ).toBe('KAD-251');
  });

  test('does not reissue an alias that exists beyond the first page', async () => {
    stubBugzilla(ascendingAliases(250));

    const alias = await getNextAlias(config, 'KAD');

    // KAD-021 is what a first-page-only max yields, and KAD-021 is already taken - Bugzilla
    // would reject the create, and the caller would misreport it as "filing without alias".
    expect(
      alias,
      'a first-page-only max would mint KAD-021, an alias already held by an existing bug'
    ).not.toBe('KAD-021');
  });

  test('finds the highest alias when it sits on the last page behind lower ones', async () => {
    // Deliberately non-monotonic: page one looks like a complete, tidy low-numbered set, so
    // nothing about the truncated response looks suspicious.
    const aliases = [...ascendingAliases(40), 'KAD-900', ...ascendingAliases(5)];
    stubBugzilla(aliases);

    const alias = await getNextAlias(config, 'KAD');

    expect(
      alias,
      'the maximum must win regardless of where it falls in the result order - KAD-900 sits well past the page boundary'
    ).toBe('KAD-901');
  });

  test('is unchanged for a product that fits inside a single page', async () => {
    stubBugzilla(ascendingAliases(7));

    const alias = await getNextAlias(config, 'KAD');

    expect(
      alias,
      'products smaller than one page were never affected by the pagination fault and must keep counting normally'
    ).toBe('KAD-008');
  });
});
