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
        title: 'Another user\'s contacts were exposed to the caller',
        actual: 'HTTP 401 — body: {"message":"Authentication token is invalid."}',
      })
    );

    expect(
      id,
      'a request the server REFUSED cannot evidence that data was exposed — this must file nothing'
    ).toBe('');
  });

  test('refuses an enumeration claim whose evidence is a 404', () => {
    const id = recordBug(
      input({
        title: 'Sequential session ids can be enumerated to walk the conversation store',
        actual: 'HTTP 404 — body: {"message":"The requested resource does not exist."}',
      })
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
      })
    );

    expect(id, 'the public-route finding must still file').not.toBe('');
    cleanUp([id]);
  });

  test('ALLOWS an ordinary exposure finding backed by a 200', () => {
    const id = recordBug(
      input({
        title: 'Anonymous module lookup exposes account handles (user directory)',
        actual: 'HTTP 200 — body: {"data":[{"kpostID":"info@kpost.in"}]}',
      })
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
      })
    );

    expect(id, 'an internals leak on a 500 is a real finding').not.toBe('');
    cleanUp([id]);
  });
});
