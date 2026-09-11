import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import { recordBug, type BugInput } from '../../src/utils/bugTracker';

/*
 * Offline coverage for the validity gate in `recordBug` — no network, no live backend.
 *
 * ## What this guards
 *
 * On 2026-09-10 a full run filed 17 Criticals. Reproducing each by hand against the live API
 * disproved three of them, and the disproof was visible in the ticket's own recorded evidence:
 *
 *  - `BUG-API-0442A0` claimed a dashboard feed "echoed a smuggled participant". The feed was
 *    byte-identical with and without the smuggled id.
 *  - `BUG-API-46FB1B` claimed sequential AI session ids were enumerable. Ids 1-3 all returned 404.
 *  - a class of ownership findings rested on a response the server had **refused**.
 *
 * The gate rejects only contradictions readable off the record itself. That narrowness is the
 * point: a gate that guesses suppresses real defects, which is worse than filing a weak one. The
 * cases below pin both halves — what it must refuse, and what it must never touch.
 *
 * `recordBug` writes into `.bug-cache/`, so anything that *is* recorded is deleted afterwards.
 */

const BUG_CACHE_DIR = path.resolve(__dirname, '..', '..', '.bug-cache');
const OCCURRENCE_DIR = path.join(BUG_CACHE_DIR, 'occurrences');

function input(overrides: Partial<BugInput> = {}): BugInput {
  return {
    title: 'A finding',
    severity: 'Major',
    module: 'Auth',
    method: 'POST',
    endpointPath: '/v2/example/route',
    classification: 'Security/Access Control',
    description: 'Recorded by a unit test.',
    requestHeaders: {},
    expected: 'something',
    actual: 'HTTP 200 — body: {}',
    reproSnippet: 'n/a',
    ...overrides,
  } as BugInput;
}

function cleanUp(ids: string[]): void {
  for (const id of ids) {
    if (!id) continue;
    try {
      fs.unlinkSync(path.join(BUG_CACHE_DIR, `${id}.json`));
    } catch {
      /* never written */
    }
    fs.rmSync(path.join(OCCURRENCE_DIR, id), { recursive: true, force: true });
  }
}

test.describe('recordBug validity gate', () => {
  test('refuses an exposure claim whose evidence is a refused request (401)', () => {
    const id = recordBug(
      input({
        title: "Another user's contacts were exposed to the caller",
        actual: 'HTTP 401 — body: {"message":"Authentication token is invalid."}',
      }),
    );

    expect(
      id,
      'a request the server REFUSED cannot evidence that data was exposed — this must file nothing',
    ).toBe('');
  });

  test('refuses an enumeration claim whose evidence is a 404', () => {
    const id = recordBug(
      input({
        title: 'Sequential session ids can be enumerated to walk the conversation store',
        actual: 'HTTP 404 — body: {"message":"The requested resource does not exist."}',
      }),
    );

    expect(id, 'nothing resolved, so nothing was enumerable').toBe('');
  });

  test('ALLOWS a declared-public route that is gated — there the 401 IS the finding', () => {
    /*
     * `assertPublicRouteReachable` reports exactly this: a route the contract declares public
     * has been dropped behind the auth filter, so a pre-token flow is blocked. The 401 is the
     * evidence, not a contradiction, and the gate must not swallow it.
     */
    const id = recordBug(
      input({
        title: 'Route declared public rejects anonymous callers',
        description: 'The contract marks this route public; the implementation gates it.',
        actual: 'HTTP 401 — the auth filter refused an anonymous request.',
      }),
    );

    expect(id, 'the public-route finding must still file').not.toBe('');
    cleanUp([id]);
  });

  test('ALLOWS an ordinary exposure finding backed by a 200', () => {
    const id = recordBug(
      input({
        title: 'Anonymous module lookup exposes account handles (user directory)',
        actual: 'HTTP 200 — body: {"data":[{"kpostID":"info@kpost.in"}]}',
      }),
    );

    expect(id, 'a 200 that returned handles is exactly the evidence this claim needs').not.toBe('');
    cleanUp([id]);
  });

  test('ALLOWS an internals-leak finding, which legitimately contains the word "leak"', () => {
    /*
     * Guards the gate's own wording: "leaks database internals" is a Major diagnostic finding
     * whose evidence is often a 500, and it must not be mistaken for a data-exposure claim.
     */
    const id = recordBug(
      input({
        title: 'Injected input triggers an internals leak (Hibernate internals)',
        classification: 'Unhandled NPE / Server Error',
        actual: 'HTTP 500 — body: org.hibernate.exception.SQLGrammarException',
      }),
    );

    expect(id, 'an internals leak on a 500 is a real finding').not.toBe('');
    cleanUp([id]);
  });
});

/*
 * Added 2026-09-11, after a full run produced two tickets whose own evidence disproved them and
 * that the gate did not catch — both would have gone to Bugzilla:
 *
 *  - `BUG-API-CF7ADA` (Major, getUserProfile) recorded "AuthenticationUnavailableError: No
 *    authenticated session could be established, so this assertion could not be evaluated." The
 *    bench said it had proved nothing, and that sentence became a product defect.
 *  - `BUG-API-727AA4` (Major, kmailPasswordPatchWork) claimed a shared `resultMap` instance field
 *    because two responses were byte-identical. Both were `401 Authentication is required`.
 */
test.describe('validity gate — bench faults and concurrency claims', () => {
  test('refuses a finding whose assertion never ran for want of a session', () => {
    const id = recordBug(
      input({
        title: 'AuthenticationUnavailableError: No authenticated session could be established',
        actual:
          'AuthenticationUnavailableError: No authenticated session could be established, so this assertion could not be evaluated. Target: http://192.168.0.66:8989',
      }),
    );

    expect(
      id,
      'a run that could not authenticate has no verdict to report — this is a bench fault, not a defect',
    ).toBe('');
  });

  test('refuses a concurrency claim whose evidence is two refusals', () => {
    const id = recordBug(
      input({
        title:
          'a patch-job call and a concurrent storage read returned byte-identical bodies, which points at the shared resultMap instance field',
        classification: 'Idempotency / Concurrency',
        actual:
          'HTTP 401 — body: {"status":"FAILURE","statusCode":401,"message":"Authentication is required to access this resource."}',
      }),
    );

    expect(
      id,
      'two identical 401s are what correct gating looks like under concurrent load, not shared state',
    ).toBe('');
  });

  test('does NOT refuse a concurrency claim that reached the handler', () => {
    /*
     * The other half. A real concurrency fault — two simultaneous writes both 500ing — must still
     * file. The gate is narrow on purpose: one that guesses suppresses real defects.
     */
    const id = recordBug(
      input({
        title: 'concurrent identical member additions returned 500 and 500',
        classification: 'Idempotency / Concurrency',
        actual: 'HTTP 500 — body: {"message":"Failed to Add Member","status":"FAILURE"}',
      }),
    );

    expect(id, 'a concurrency fault evidenced by a 500 is real and must be filed').not.toBe('');
    cleanUp([id]);
  });
});

test.describe('validity gate — must not eat real findings', () => {
  test('a session-integrity finding on a 401 is NOT suppressed as concurrency', () => {
    /*
     * Regression pin. The first concurrency rule matched /race/ anywhere in the claim and ate
     * this exact finding — "repointing must not silently invalidate the caller's token" — because
     * the auto-generated description says "the tier 1 diagnostic trace has the full exchange".
     * The 401 here IS the defect: the caller's own token stopped working after their own write.
     */
    const id = recordBug(
      input({
        title:
          "after repointing the primary device the caller's own token answered HTTP 401 on getUserProfile. Changing a device pairing must not log the user out of the session that made the change.",
        classification: 'Incorrect HTTP Status',
        description:
          'Detected by a plain expect(); the tier 1 diagnostic trace has the full exchange.',
        actual: 'HTTP 401 — the token no longer resolves.',
      }),
    );

    expect(
      id,
      "a 401 that IS the defect must still file — the caller's own token stopped working",
    ).not.toBe('');
    cleanUp([id]);
  });
});
