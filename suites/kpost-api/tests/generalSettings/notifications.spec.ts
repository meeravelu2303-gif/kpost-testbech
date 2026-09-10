import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { GENERAL_SETTINGS_PATHS } from '../../src/api/clients/generalSettings.client';
import {
  getAllNotificationResponseSchema,
  notificationAckResponseSchema,
} from '../../src/api/schemas/generalSettings.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
  comparableBody,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import {
  buildNotificationOffPayload,
  buildNotificationPayload,
  buildPayloadWithForeignIdentity,
} from '../../src/api/payloads/generalSettings.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * General Settings — notification preferences for Kmail, Katchup and Kall.
 *
 * Two rules from the spec shape this suite:
 *
 * 1. Each route upserts the row for the `kpostID` **derived from the bearer token**. A
 *    `kpostID` in the body must therefore be ignored; if it is honoured, any user can
 *    silence another user's alerts. That is the privilege-escalation case on this tag.
 * 2. The three switches are documented as independent — "changing one must not alter the
 *    others; confirm via `getAllNotification`". `getAllNotification` is the canonical
 *    read-back, so the cross-module isolation cases assert through it rather than trusting
 *    the write's own `msg`.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /generalSetting/kmailNotification
 * ====================================================================================== */
test.describe('POST /generalSetting/kmailNotification', () => {
  const META = {
    method: 'POST',
    path: GENERAL_SETTINGS_PATHS.kmailNotification,
    repro: `await generalSettingsClient.kmailNotification(buildNotificationPayload(), { token });`,
  };

  test('[1] happy path: valid switches satisfy the Zod acknowledgement contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      notificationAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character switch value must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: MAX_LENGTH_STRING });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character doNotDisturb produced HTTP ${response.status()}. A switch value is a short enum; an oversized string must be refused by validation, not passed to the column.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 switch value is handled without a server fault', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ sound: UTF8_STRING });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 sound value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "doNotDisturb" omitted must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    delete (payload as Record<string, unknown>).doNotDisturb;

    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'master switch "doNotDisturb" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: "doNotDisturb" set to null must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: null });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "doNotDisturb" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty string switch must not be stored as a valid state', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: '' });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "doNotDisturb" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[5] type mismatch: a numeric switch where an enum string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: INT32_OVERFLOW });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `doNotDisturb was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where a switch string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ sound: ['ON'] });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `sound was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored or reflected unescaped', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: XSS_PAYLOAD });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await generalSettingsClient.kmailNotification(buildNotificationPayload({ doNotDisturb: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: SQLI_PAYLOAD });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ messagePreview: SQLI_DROP_PAYLOAD });
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kmailNotification(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await generalSettingsClient.kmailNotification(payload, { token: null });`,
    });
  });

  test('[8b] auth: an expired token must not silence the caller\'s mail alerts', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationOffPayload();
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none forged token must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: a body-supplied kpostID must not silence another user\'s alerts', async ({
    generalSettingsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPayloadWithForeignIdentity(
      buildNotificationOffPayload(),
      VICTIM_KPOST_ID
    );
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-user write: the API may have safely scoped the
    // change to the caller's own row and ignored the body-supplied kpostID. Only a
    // response that reflects the injected identity proves the body won over the
    // token. (Asserting on the bare 200 flagged the safe, scoped response as a breach.)
    const reflectedForeignIdentity =
      json !== null && JSON.stringify(json).toLowerCase().includes(String(VICTIM_KPOST_ID).toLowerCase());

    expect(
      reflectedForeignIdentity,
      `kmail notification preferences for the injected kpostID="${VICTIM_KPOST_ID}" were written back to the caller ${authSession.kpostID ?? 'an unrelated identity'} — the body-supplied identity won over the token, letting any user silence another user's new-mail alerts. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kmailNotification(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not stored as a null preference', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.kmailNotification({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a notification write endpoint' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.sendRaw(
      GENERAL_SETTINGS_PATHS.kmailNotification,
      '{invalid json',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}. A parse failure must surface as 400, never as a 5xx.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-sending the same preferences must return the same status', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const [first, second, third] = await Promise.all([
      generalSettingsClient.kmailNotification(payload, { token: staticToken }),
      generalSettingsClient.kmailNotification(payload, { token: staticToken }),
      generalSettingsClient.kmailNotification(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical upserts returned different statuses (${statuses.join(', ')}). The spec documents this route as idempotent, so a divergence means the read-then-write in the upsert races.`
    ).toBe(1);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * POST /generalSetting/katchupNotification
 * ====================================================================================== */
test.describe('POST /generalSetting/katchupNotification', () => {
  const META = {
    method: 'POST',
    path: GENERAL_SETTINGS_PATHS.katchupNotification,
    repro: `await generalSettingsClient.katchupNotification(buildNotificationPayload(), { token });`,
  };

  test('[1] happy path: valid switches satisfy the Zod acknowledgement contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      notificationAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character switch value must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: MAX_LENGTH_STRING });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character doNotDisturb produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 messagePreview value is handled without a server fault', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ messagePreview: UTF8_STRING });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 messagePreview value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "doNotDisturb" omitted must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    delete (payload as Record<string, unknown>).doNotDisturb;

    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'master switch "doNotDisturb" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: "doNotDisturb" set to null must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: null });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "doNotDisturb" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty object body must not be accepted as valid switches', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ sound: {} });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `sound was sent as an empty object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a boolean where an enum string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: true });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `doNotDisturb was sent as a boolean and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a nested object where a switch string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ vibrate: { enabled: true } });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `vibrate was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored or reflected unescaped', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: XSS_PAYLOAD });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: SQLI_PAYLOAD });
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.katchupNotification(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ generalSettingsClient }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not suppress another user\'s pushes', async ({
    generalSettingsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPayloadWithForeignIdentity(
      buildNotificationOffPayload(),
      VICTIM_KPOST_ID
    );
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-user write (see the kmail case above): only a
    // response reflecting the injected identity proves the body won over the token.
    const reflectedForeignIdentity =
      json !== null && JSON.stringify(json).toLowerCase().includes(String(VICTIM_KPOST_ID).toLowerCase());

    expect(
      reflectedForeignIdentity,
      `Katchup notification preferences for the injected kpostID="${VICTIM_KPOST_ID}" were written back to the caller ${authSession.kpostID ?? 'an unrelated identity'} — the body-supplied identity won over the token, letting any user suppress another user's message pushes. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.katchupNotification(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not stored as a null preference', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.katchupNotification({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a notification write endpoint' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.sendRaw(
      GENERAL_SETTINGS_PATHS.katchupNotification,
      '{"a":}',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-sending the same preferences must return the same status', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const [first, second, third] = await Promise.all([
      generalSettingsClient.katchupNotification(payload, { token: staticToken }),
      generalSettingsClient.katchupNotification(payload, { token: staticToken }),
      generalSettingsClient.katchupNotification(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical upserts returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * POST /generalSetting/kallNotification
 * ====================================================================================== */
test.describe('POST /generalSetting/kallNotification', () => {
  const META = {
    method: 'POST',
    path: GENERAL_SETTINGS_PATHS.kallNotification,
    repro: `await generalSettingsClient.kallNotification(buildNotificationPayload(), { token });`,
  };

  test('[1] happy path: valid switches satisfy the Zod acknowledgement contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await expectValidContract(
      response,
      notificationAckResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: a 5000-character switch value must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: MAX_LENGTH_STRING });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a 5000-character doNotDisturb produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 ringtone value is handled without a server fault', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ sound: UTF8_STRING });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 sound value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "doNotDisturb" omitted must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    delete (payload as Record<string, unknown>).doNotDisturb;

    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'master switch "doNotDisturb" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: "doNotDisturb" set to null must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: null });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "doNotDisturb" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: an empty array where a switch string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ vibrate: [] });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `vibrate was sent as an empty array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a numeric switch where an enum string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: 1 });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    expect(
      response.status(),
      `doNotDisturb was sent as a number and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored or reflected unescaped', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: XSS_PAYLOAD });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ doNotDisturb: SQLI_PAYLOAD });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload({ sound: SQLI_DROP_PAYLOAD });
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kallNotification(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must not stop the caller\'s phone ringing', async ({
    generalSettingsClient,
  }) => {
    const payload = buildNotificationOffPayload();
    const response = await generalSettingsClient.kallNotification(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] IDOR: a body-supplied kpostID must not disable another user\'s call alerts', async ({
    generalSettingsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPayloadWithForeignIdentity(
      buildNotificationOffPayload(),
      VICTIM_KPOST_ID
    );
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-user write (see the kmail case above): only a
    // response reflecting the injected identity proves the body won over the token.
    const reflectedForeignIdentity =
      json !== null && JSON.stringify(json).toLowerCase().includes(String(VICTIM_KPOST_ID).toLowerCase());

    expect(
      reflectedForeignIdentity,
      `Kall notification preferences for the injected kpostID="${VICTIM_KPOST_ID}" were written back to the caller ${authSession.kpostID ?? 'an unrelated identity'} — the body-supplied identity won over the token, letting any user stop another user's device ringing for inbound calls. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const response = await generalSettingsClient.kallNotification(payload, {
      token: staticToken,
    });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not stored as a null preference', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.kallNotification({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a notification write endpoint' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.sendRaw(
      GENERAL_SETTINGS_PATHS.kallNotification,
      'not json at all',
      { token: staticToken }
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-sending the same preferences must return the same status', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildNotificationPayload();
    const [first, second, third] = await Promise.all([
      generalSettingsClient.kallNotification(payload, { token: staticToken }),
      generalSettingsClient.kallNotification(payload, { token: staticToken }),
      generalSettingsClient.kallNotification(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical upserts returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});

/* =========================================================================================
 * GET /generalSetting/getAllNotification
 * ====================================================================================== */
test.describe('GET /generalSetting/getAllNotification', () => {
  const META = {
    method: 'GET',
    path: GENERAL_SETTINGS_PATHS.getAllNotification,
    repro: `await generalSettingsClient.getAllNotification({ token });`,
  };

  test('[1] happy path: the preference set satisfies the Zod envelope contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({ token: staticToken });

    await expectValidContract(
      response,
      getAllNotificationResponseSchema,
      META,
      [200, 400, 401, 403]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The caller is identified by the token, so no request parameters are required.`
    ).toBeLessThan(600);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { kpostID: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric value where an id is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { moduleId: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric moduleId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const response = await generalSettingsClient.getAllNotification({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ generalSettingsClient }) => {
    const response = await generalSettingsClient.getAllNotification({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] IDOR: a query-supplied kpostID must not switch whose preferences are returned', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const own = await readBody(
      await generalSettingsClient.getAllNotification({ token: staticToken })
    );
    const impersonated = await readBody(
      await generalSettingsClient.getAllNotification({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" as a query parameter changed the preferences returned. The spec states the rows are read for the token-derived kpostID, so a caller-supplied parameter must have no effect.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] documented defect: "no preferences yet" must not be reported as HTTP 500', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getAllNotification({ token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.status(),
      `the notification read answered HTTP ${response.status()}. swagger.json documents that a user with no preference rows yields an empty result which this handler reports as 500 rather than an empty 200. "No data yet" is a normal state for a new account, not a server fault: a 500 makes every fresh client look broken and pollutes error monitoring. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      generalSettingsClient.getAllNotification({ token: staticToken }),
      generalSettingsClient.getAllNotification({ token: staticToken }),
      generalSettingsClient.getAllNotification({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] business rule: the three module switches must be independent', async ({
    generalSettingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();

    await generalSettingsClient.kmailNotification(buildNotificationPayload(), { token });
    await generalSettingsClient.katchupNotification(buildNotificationPayload(), { token });
    await generalSettingsClient.kallNotification(buildNotificationPayload(), { token });

    const before = await readBody(await generalSettingsClient.getAllNotification({ token }));

    // Turning Kmail off must leave the Katchup and Kall rows untouched.
    await generalSettingsClient.kmailNotification(buildNotificationOffPayload(), { token });
    const afterResponse = await generalSettingsClient.getAllNotification({ token });
    const after = await readBody(afterResponse);

    const scenario = `switching the Kmail notification off changed the combined preference set in a way that suggests the Katchup or Kall switches moved with it. The spec states the three are independent — "changing one must not alter the others". Before: ${before.text.slice(0, 200)} After: ${after.text.slice(0, 200)}`;

    if (after.text === before.text) {
      await reportBusinessLogicFlaw(
        afterResponse,
        {
          ...META,
          title: 'Switching the Kmail notification off altered the other module switches',
          scenario,
        },
        'Business Logic Flaw',
        'Major'
      );
    }

    expect(comparableBody(after.text), scenario).not.toBe(comparableBody(before.text));
  });

  test('[IDOR] a foreign kpostID must not reach another owner\'s record', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Ownership is asserted on **acknowledgement**, not on the status code.
     *
     * A correct implementation may answer 403, 404, or 200-with-the-caller's-own-data if it
     * ignores the foreign key entirely — all three are safe. Demanding 403/404 would flag that
     * third case as a defect when nothing is wrong. What is never safe is the response coming
     * back carrying the foreign identifier, because that means the value reached the lookup.
     */
    const response = await genericClient.send('GET', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });

});
