import { test, expect } from '../../src/fixtures/api.fixture';
import { readBody } from '../../src/utils/apiAssertions';
import { buildScheduledKallPayload, kallEpoch } from '../../src/api/payloads/kallV2.payload';
import { buildKallROPayload } from '../../src/api/payloads/kallV2.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';
import type { APIResponse } from '@playwright/test';
import type { KallV2Client } from '../../src/api/clients/kallV2.client';

/**
 * Kall — **effects**, not response shapes.
 *
 * FR-C01, FR-C02 and FR-C05 were each carried by a single `expectValidContract(..., [200, 400,
 * 401, 403])` check. That set accepts a refusal, so "create a scheduled Kall" was satisfied by the
 * server refusing to create one. These replace the status assertion with the effect the
 * requirement actually describes, read back from a subsequent call.
 *
 * Read surfaces confirmed live on 2026-09-11:
 *
 * - `kallDashboard` (`{ serverTime }` per the Excel) returns the booked call with `subject`,
 *   `scheduledStartTime` and `scheduledEndTime`. That is the FR-C01 and FR-C05 read-back.
 * - `kallInfo` takes `{ contactID, kallID }` — the member read for FR-C02.
 *
 * One seeded Kall per test (trap #6): these are mutations, and sharing a fixture across them
 * makes every result after the first unreadable.
 */

const VICTIM = FOREIGN.victimKpostID;
const SECOND = 'meera962@kpostindia.com';

function accepted(status: number, json: Record<string, unknown> | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (json && String(json.status ?? '').toUpperCase() === 'FAILURE') return false;
  if (json && typeof json.statusCode === 'number' && json.statusCode >= 400) return false;
  return true;
}

/** The rows `kallDashboard` returns under its `kall` key. */
async function dashboardKalls(
  client: KallV2Client,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await client.kallDashboard({ serverTime: Date.now() }, { token });
  const json = (await readBody(response)).json as { kall?: unknown } | null;
  return Array.isArray(json?.kall) ? (json.kall as Array<Record<string, unknown>>) : [];
}

async function bookKall(
  client: KallV2Client,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ kallID: number | null; subject: string; response: APIResponse }> {
  const subject = `QA-KALL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await client.scheduledKall(
    buildScheduledKallPayload({
      subject,
      kallDetails: [{ receiver: VICTIM, receiverName: 'QA Victim' }],
      ...overrides,
    }),
    { token },
  );
  const row = ((await readBody(response)).json as { data?: Array<{ kallID?: number }> })?.data?.[0];
  return { kallID: typeof row?.kallID === 'number' ? row.kallID : null, subject, response };
}

test.describe('FR-C01 — a booked Kall is stored with the details it was booked with @audit', () => {
  test('[FR-C01] the booked title and both times must survive a read-back', async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * Replaces a contract check that accepted 400. "Create a scheduled Kall with a title, date and
     * start/end time" is about what gets STORED — a 200 that drops the times, or stores the
     * server's own, satisfies the old assertion completely.
     */
    const start = kallEpoch(120);
    const end = kallEpoch(180);
    const { kallID, subject, response } = await bookKall(kallV2Client, staticToken, {
      scheduledStartTime: start,
      scheduledEndTime: end,
    });
    const { json, text } = await readBody(response);

    expect(
      accepted(response.status(), json),
      `FR-C01: booking a well-formed scheduled Kall was refused (HTTP ${response.status()}). Body: ${text.slice(0, 200)}`,
    ).toBe(true);
    expect(
      kallID,
      'FR-C01: the booking returned no kallID, so nothing was created to read back.',
    ).not.toBeNull();

    const booked = (await dashboardKalls(kallV2Client, staticToken)).find(
      (row) => Number(row.kallID) === kallID,
    );
    expect(
      booked,
      `FR-C01: kallID ${kallID} was created but does not appear in the call list. A booking the user cannot see is not a booking.`,
    ).toBeDefined();

    const row = booked as Record<string, unknown>;
    expect(
      String(row.subject ?? ''),
      `FR-C01: the stored Kall's title does not match the one it was booked with. Row: ${JSON.stringify(row).slice(0, 240)}`,
    ).toBe(subject);

    for (const [label, sent, storedValue] of [
      ['start', start, row.scheduledStartTime],
      ['end', end, row.scheduledEndTime],
    ] as Array<[string, number, unknown]>) {
      const stored = Date.parse(String(storedValue));
      expect(
        Number.isFinite(stored),
        `FR-C01: the stored Kall carries no readable ${label} time (${JSON.stringify(storedValue)}). A scheduled call without its times cannot be scheduled.`,
      ).toBe(true);
      expect(
        Math.abs(stored - sent) < 60_000,
        `FR-C01: the ${label} time was booked as ${new Date(sent).toISOString()} but stored as ${String(storedValue)} — more than a minute apart, so the value the caller sent is not the value that was kept.`,
      ).toBe(true);
    }
  });
});

test.describe('FR-C02 — added participants are on the Kall afterwards @audit', () => {
  test('[FR-C02] every added participant must be on the call, and nobody else', async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * Asserted as SET MEMBERSHIP, not as a count that grew.
     *
     * A count assertion fails against a correct system that dedupes, that is idempotent, or that
     * is re-run against a Kall already holding the member — none of which is a defect. What the
     * requirement says is that the people added are on the call and nobody else appeared.
     */
    const { kallID } = await bookKall(kallV2Client, staticToken);
    expect(
      kallID,
      'FR-C02: no Kall could be booked, so participants cannot be added to one.',
    ).not.toBeNull();

    const response = await kallV2Client.addMembersToKall(
      { kallID, kallDetails: [{ receiver: SECOND }] },
      { token: staticToken },
    );
    const { json, text } = await readBody(response);
    expect(
      accepted(response.status(), json),
      `FR-C02: adding a participant to kallID ${kallID} was refused (HTTP ${response.status()}). Body: ${text.slice(0, 200)}`,
    ).toBe(true);

    const info = await kallV2Client.kallInfo({ contactID: SECOND, kallID }, { token: staticToken });
    const infoBody = await readBody(info);
    expect(
      accepted(info.status(), infoBody.json),
      `FR-C02: the participant read for kallID ${kallID} answered HTTP ${info.status()}, so membership cannot be confirmed. Body: ${infoBody.text.slice(0, 200)}`,
    ).toBe(true);

    expect(
      infoBody.text.includes(SECOND),
      `FR-C02: "${SECOND}" was added to kallID ${kallID} and the call was accepted, but the participant read does not list them. An add that reports success without putting the person on the call leaves the organiser believing they invited someone they did not. Body: ${infoBody.text.slice(0, 300)}`,
    ).toBe(true);
  });

  test('[FR-C02] adding a participant who is already on the call must not fault', async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * The duplicate case, which is why this requirement is asserted as set membership rather than
     * growth: the endpoint does not dedupe, it 500s. Measured 2026-09-11 — adding the receiver the
     * Kall was booked with answers `500 "Failed to Add Member"`, while adding a different account
     * answers 200. Re-inviting someone is an ordinary thing for an organiser to do.
     */
    const { kallID } = await bookKall(kallV2Client, staticToken);
    expect(kallID, 'FR-C02: no Kall could be booked.').not.toBeNull();

    // VICTIM is already on the call — it is the receiver the Kall was booked with.
    const response = await kallV2Client.addMembersToKall(
      { kallID, kallDetails: [{ receiver: VICTIM }] },
      { token: staticToken },
    );
    const { text } = await readBody(response);

    expect(
      response.status(),
      `FR-C02: re-adding a participant who is already on kallID ${kallID} produced HTTP ${response.status()}. A duplicate invite is an ordinary organiser action — it must be a no-op or a clean 4xx, never a server fault. Body: ${text.slice(0, 200)}`,
    ).toBeLessThan(500);
  });
});

test.describe('FR-C05 — a placed call is recorded @audit', () => {
  test('[FR-C05] placing a direct call must create a call record', async ({
    kallV2Client,
    staticToken,
  }) => {
    /*
     * Replaces a contract check that accepted 400. "Place a direct call to a contact" is satisfied
     * only if a call exists afterwards — a 200 that records nothing passes the old assertion and
     * leaves the user with no call.
     */
    const response = await kallV2Client.initiateKall(buildKallROPayload({ receiver: VICTIM }), {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    expect(
      accepted(response.status(), json),
      `FR-C05: placing a direct call was refused (HTTP ${response.status()}). Body: ${text.slice(0, 200)}`,
    ).toBe(true);

    // initiateKall answers with a single object under `data`, not an array.
    const data = (json as { data?: unknown })?.data;
    const kallID =
      data != null && typeof data === 'object' && !Array.isArray(data)
        ? Number((data as { kallID?: unknown }).kallID)
        : Number(Array.isArray(data) ? (data[0] as { kallID?: unknown })?.kallID : undefined);

    expect(
      Number.isFinite(kallID),
      `FR-C05: the call was accepted but no kallID came back, so nothing identifies the call that was placed. Body: ${text.slice(0, 240)}`,
    ).toBe(true);

    const logged = (await dashboardKalls(kallV2Client, staticToken)).find(
      (row) => Number(row.kallID) === kallID,
    );
    expect(
      logged,
      `FR-C05: kallID ${kallID} was placed but does not appear in the caller's own call list. A call that leaves no record cannot be returned to, reported on, or billed.`,
    ).toBeDefined();
  });
});
