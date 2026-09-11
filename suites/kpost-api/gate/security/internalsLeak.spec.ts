import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildSchedulePayload } from '../../src/api/payloads/kdiary.payload';
import { buildScheduledKallPayload } from '../../src/api/payloads/kallV2.payload';

/**
 * NFR-SEC04 — framework, ORM and database internals are never exposed in a response body.
 *
 * Pins `BUG-API-7C4662`, confirmed live: an injected title on `createSchedule` returns
 * `could not execute statement; SQL [n/a]; nested exception is
 * org.hibernate.exception.DataException`. That names the ORM, the failure mode and the fact that
 * the input reached the statement — the reconnaissance an attacker needs before an injection is
 * worth attempting.
 *
 * The fix is an error handler, not input escaping, so this is asserted on the BODY of whatever
 * comes back rather than on the status. A 500 is acceptable here; a 500 that explains the stack
 * is not.
 */

const INTERNALS =
  /hibernate|org\.springframework|com\.mysql|java\.lang\.|SQLGrammar|DataException|nested exception|could not execute statement|jdbc/i;

const HOSTILE: Array<[string, string]> = [
  ['a SQL tautology', "' OR '1'='1"],
  ['an unterminated quote', "unterminated'"],
  ['a statement terminator', "x'; SELECT 1--"],
];

test.describe('NFR-SEC04 — Kdiary must not leak ORM internals @gate', () => {
  for (const [label, vector] of HOSTILE) {
    test(`[NFR-SEC04] Kdiary createSchedule: ${label} must not expose internals`, async ({
      kdiaryClient,
      staticToken,
    }) => {
      const response = await kdiaryClient.createSchedule(buildSchedulePayload({ title: vector }), {
        token: staticToken,
      });
      const { text } = await readBody(response);
      const leak = INTERNALS.exec(text);

      expect(
        leak?.[0] ?? null,
        `NFR-SEC04: ${label} produced a response naming "${leak?.[0] ?? ''}" — the ORM, the framework or the failing statement. HTTP ${response.status()} is fine; the explanation is not. Return a generic error and log the detail server-side. Body: ${text.slice(0, 240)}`
      ).toBeNull();
    });
  }
});

test.describe('NFR-SEC04 — Kall must not leak ORM internals @gate', () => {
  for (const [label, vector] of HOSTILE) {
    test(`[NFR-SEC04] Kall scheduledKall: ${label} must not expose internals`, async ({
      kallV2Client,
      staticToken,
    }) => {
      const response = await kallV2Client.scheduledKall(
        buildScheduledKallPayload({ kallTitle: vector }),
        { token: staticToken }
      );
      const { text } = await readBody(response);
      const leak = INTERNALS.exec(text);

      expect(
        leak?.[0] ?? null,
        `NFR-SEC04: ${label} produced a response naming "${leak?.[0] ?? ''}". HTTP ${response.status()} is fine; the explanation is not. Body: ${text.slice(0, 240)}`
      ).toBeNull();
    });
  }
});
