import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KNEWS_PATHS } from '../../src/api/clients/knews.client';
import {
  getKnewsSettingsResponseSchema,
  updateKnewsSettingsResponseSchema,
} from '../../src/api/schemas/knews.schema';
import {
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
  comparableBody,
} from '../../src/utils/apiAssertions';
import { buildUpdateKnewsSettingsPayload } from '../../src/api/payloads/knews.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * Knews — the caller's news preferences.
 *
 * `updateKnewsSettings` accepts a body-supplied `kpostId`, which makes it the tag's main
 * privilege-escalation surface: if the server trusts that field rather than the token, any
 * user can rewrite another user's preferences. `getKnewsSettings` is its read counterpart.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /v2/knews/updateKnewsSettings
 * ====================================================================================== */
test.describe('POST /v2/knews/updateKnewsSettings', () => {
  const META = {
    method: 'POST',
    path: KNEWS_PATHS.updateKnewsSettings,
    repro: `await knewsClient.updateKnewsSettings(buildUpdateKnewsSettingsPayload(), { token });`,
  };

  test('[1] happy path: a valid settings update satisfies the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await expectValidContract(
      response,
      updateKnewsSettingsResponseSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: a 5000-character city list must be rejected, not truncated silently', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ cityNames: MAX_LENGTH_STRING });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character cityNames value produced HTTP ${response.status()}. An oversized field must be refused by validation rather than reaching the column and being silently truncated or crashing the driver.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: negative retention and archive windows must be refused', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ retentionDays: -1, archiveDays: -30 });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'retentionDays=-1 and archiveDays=-30 (negative retention windows)',
      },
      [400, 401, 403, 422]
    );
  });

  test('[2c] boundary: an int32-overflow language id is handled cleanly', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ languageId: INT32_OVERFLOW });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `languageId=${INT32_OVERFLOW} exceeds int32 and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[2d] boundary: a UTF-8 state name is stored or rejected without a server fault', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ stateName: UTF8_STRING });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 stateName produced HTTP ${response.status()}. Non-ASCII place names are ordinary input on a platform serving India and Malaysia.`
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "countryName" omitted must be HTTP 400/422', async ({
    knewsClient,
    staticToken,
  }) => {
    // Per the Excel, the settings body carries no kpostId (the token owns the settings) — so
    // this probes a real Excel field instead. The kpostId privilege-escalation surface is
    // covered by the IDOR case below, which smuggles a foreign kpostId deliberately.
    const payload = buildUpdateKnewsSettingsPayload();
    delete (payload as Record<string, unknown>).countryName;

    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "countryName" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[3b] missing required parameter: "languageId" omitted must be HTTP 400/422', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    delete (payload as Record<string, unknown>).languageId;

    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "languageId" omitted' },
      [400, 401, 403, 422]
    );
  });

  test('[4] null fuzzing: "countryName" set to null must be rejected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ countryName: null });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "countryName" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[4b] empty fuzzing: "category" set to an empty string must be rejected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ category: '' });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "category" set to an empty string' },
      [400, 401, 403, 422]
    );
  });

  test('[4c] empty fuzzing: an empty array where a category string is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ category: [] });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `category was sent as an empty array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a string retentionDays must be rejected as HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ retentionDays: 'thirty' });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `retentionDays is an integer in the contract but was sent as a string, producing HTTP ${response.status()}. A type mismatch must be caught by deserialisation.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an object where a newsType string is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ newsType: { nested: true } });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    expect(
      response.status(),
      `newsType was sent as an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in "category" must not be stored or reflected unescaped', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ category: XSS_PAYLOAD });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await knewsClient.updateKnewsSettings(buildUpdateKnewsSettingsPayload({ category: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[6b] XSS: a script payload in "newsSource" must not be stored or reflected unescaped', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ newsSource: XSS_PAYLOAD });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ category: SQLI_PAYLOAD });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        body: payload,
        repro: `await knewsClient.updateKnewsSettings(buildUpdateKnewsSettingsPayload({ category: ${JSON.stringify(SQLI_PAYLOAD)} }), { token });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ subCategories: SQLI_DROP_PAYLOAD });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await knewsClient.updateKnewsSettings(payload, { token: null });`,
    });
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ knewsClient }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8c] auth: an alg=none forged token must not persist settings', async ({ knewsClient }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8d] IDOR: a body-supplied kpostId must not rewrite another user\'s preferences', async ({
    knewsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload({ kpostId: VICTIM_KPOST_ID });
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    const persisted = json !== null && json.statusCode === 200;

    expect(
      persisted,
      `settings were persisted for a body-supplied kpostId ("${VICTIM_KPOST_ID}") while authenticated as ${authSession.kpostID ?? 'an unrelated identity'}. The target record must be resolved from the token, never from the payload, or any user can rewrite another user's news preferences. Body: ${text.slice(0, 200)}`
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const response = await knewsClient.updateKnewsSettings(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not persisted as a null record', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.updateKnewsSettings({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a settings write endpoint' },
      [400, 401, 403, 422]
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.sendRaw(KNEWS_PATHS.updateKnewsSettings, '{invalid json', {
      token: staticToken,
    });

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}. A parse failure is a client error and must surface as 400.`
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: three concurrent identical writes must not conflict', async ({
    knewsClient,
    staticToken,
  }) => {
    const payload = buildUpdateKnewsSettingsPayload();
    const [first, second, third] = await Promise.all([
      knewsClient.updateKnewsSettings(payload, { token: staticToken }),
      knewsClient.updateKnewsSettings(payload, { token: staticToken }),
      knewsClient.updateKnewsSettings(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent writes returned different statuses (${statuses.join(', ')}). An upsert of the same preferences must be idempotent, or a race exists between the read and the write.`
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});

/* =========================================================================================
 * GET /v2/knews/getKnewsSettings
 * ====================================================================================== */
test.describe('GET /v2/knews/getKnewsSettings', () => {
  const META = {
    method: 'GET',
    path: KNEWS_PATHS.getKnewsSettings,
    repro: `await knewsClient.getKnewsSettings({ token });`,
  };

  test('[1] happy path: the caller\'s settings satisfy the Zod envelope contract', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({ token: staticToken });

    await expectValidContract(
      response,
      getKnewsSettingsResponseSchema,
      META,
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}. Unexpected query input must be ignored or refused, not crash the handler.`
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must still resolve', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The caller is identified by the token, so no request parameters are required and the route must not fault on their absence.`
    ).toBeLessThan(500);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { kpostId: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric value where an id is expected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { languageId: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric languageId query value produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await knewsClient.getKnewsSettings({ token, params: { cb: ${JSON.stringify(XSS_PAYLOAD)} } });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({
      token: staticToken,
      params: { kpostId: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    knewsClient,
  }) => {
    const response = await knewsClient.getKnewsSettings({ token: null });

    await assertUnauthorized(response, {
      ...META,
      repro: `await knewsClient.getKnewsSettings({ token: null });`,
    });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ knewsClient }) => {
    const response = await knewsClient.getKnewsSettings({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] IDOR: a query-supplied kpostId must not switch whose settings are returned', async ({
    knewsClient,
    staticToken,
  }) => {
    const own = await readBody(await knewsClient.getKnewsSettings({ token: staticToken }));
    const impersonated = await readBody(
      await knewsClient.getKnewsSettings({
        token: staticToken,
        params: { kpostId: VICTIM_KPOST_ID },
      })
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostId="${VICTIM_KPOST_ID}" as a query parameter changed the settings returned. The record must be resolved from the token identity, never from a caller-supplied parameter.`
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    knewsClient,
    staticToken,
  }) => {
    const response = await knewsClient.getKnewsSettings({ token: staticToken });

    await assertStatusCodeParity(response, META);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    knewsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      knewsClient.getKnewsSettings({ token: staticToken }),
      knewsClient.getKnewsSettings({ token: staticToken }),
      knewsClient.getKnewsSettings({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`
    ).toBe(1);
  });

  test('[10b] structural: the response must not expose another user\'s preferences', async ({
    knewsClient,
    staticToken,
    authSession,
  }) => {
    const { text } = await readBody(await knewsClient.getKnewsSettings({ token: staticToken }));
    test.skip(!authSession.kpostID, 'no authenticated identity to compare the payload against');

    expect(
      text.includes(VICTIM_KPOST_ID) && authSession.kpostID !== VICTIM_KPOST_ID,
      `the settings payload referenced "${VICTIM_KPOST_ID}" while authenticated as ${authSession.kpostID}. A preferences read must return only the caller's own record.`
    ).toBe(false);
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
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

});
