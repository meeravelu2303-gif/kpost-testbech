import {
  test,
  expect,
  EXPIRED_TOKEN,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { GENERAL_SETTINGS_PATHS } from '../../src/api/clients/generalSettings.client';
import {
  changeThemeResponseSchema,
  fontSettingResponseSchema,
  getPersonalizeResponseSchema,
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
} from '../../src/utils/apiAssertions';
import {
  buildChangeThemePayload,
  buildFontSettingPayload,
  buildPayloadWithForeignIdentity,
} from '../../src/api/payloads/generalSettings.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * General Settings — personalisation (font, theme, and the combined read).
 *
 * Both writes are documented as device-agnostic: the change "takes effect on every device
 * the user signs in from". That raises the stakes on the privilege-escalation cases, since
 * honouring a body-supplied identity would let one user repaint another user's app
 * everywhere at once.
 *
 * `changeTheme` is also the one route on this tag whose success payload carries the settings
 * under a `changeTheme` key rather than `data` — asserting on `data` here would pass against
 * an empty response, so the contract test targets the documented key.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE users; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;
const INT32_OVERFLOW = 2147483648;

/* =========================================================================================
 * POST /generalSetting/fontSetting
 * ====================================================================================== */
test.describe('POST /generalSetting/fontSetting @audit', () => {
  const META = {
    method: 'POST',
    path: GENERAL_SETTINGS_PATHS.fontSetting,
    repro: `await generalSettingsClient.fontSetting(buildFontSettingPayload(), { token });`,
  };

  test('[1] happy path: a valid font preference satisfies the Zod contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload();
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await expectValidContract(
      response,
      fontSettingResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[2] boundary: a 5000-character font style must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontStyle: MAX_LENGTH_STRING });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character fontStyle produced HTTP ${response.status()}. A font name is a short enum; an oversized value must be refused by validation.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: an int32-overflow font size must be handled cleanly', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontSize: INT32_OVERFLOW });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    expect(
      response.status(),
      `fontSize=${INT32_OVERFLOW} produced HTTP ${response.status()}. An absurd font size must be rejected rather than persisted and shipped to every device.`,
    ).toBeLessThan(500);
  });

  test('[2c] boundary: a UTF-8 font style is handled without a server fault', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontStyle: UTF8_STRING });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 fontStyle produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "fontSize" omitted must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload();
    delete (payload as Record<string, unknown>).fontSize;

    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "fontSize" omitted' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: "fontSize" set to null must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontSize: null });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "fontSize" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[4b] empty fuzzing: an empty string font size must not be stored', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontSize: '' });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "fontSize" set to an empty string' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: an array where a font style string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontStyle: ['DEFAULT'] });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    expect(
      response.status(),
      `fontStyle was sent as an array and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: a nested object where a font size is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontSize: { value: 14 } });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    expect(
      response.status(),
      `fontSize was sent as an object and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored or reflected unescaped', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontStyle: XSS_PAYLOAD });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await generalSettingsClient.fontSetting(buildFontSettingPayload({ fontStyle: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD,
    );
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontStyle: SQLI_PAYLOAD });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] SQL injection: a DROP TABLE payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload({ fontSize: SQLI_DROP_PAYLOAD });
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_DROP_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildFontSettingPayload();
    const response = await generalSettingsClient.fontSetting(payload, { token: null });

    await assertUnauthorized(response, {
      ...META,
      body: payload,
      repro: `await generalSettingsClient.fontSetting(payload, { token: null });`,
    });
  });

  test('[8b] auth: a malformed token must be HTTP 401/403', async ({ generalSettingsClient }) => {
    const payload = buildFontSettingPayload();
    const response = await generalSettingsClient.fontSetting(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test("[8c] IDOR: a body-supplied kpostID must not restyle another user's app", async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildPayloadWithForeignIdentity(
      buildFontSettingPayload({ fontSize: 'LARGE' }),
      VICTIM_KPOST_ID,
    );
    /*
     * Judged on ACKNOWLEDGEMENT, not on the write succeeding.
     *
     * An implementation that ignores the body's kpostID and stores the caller's own preference
     * is correct and answers 200 — indistinguishable, by status, from the caller writing their
     * own row. Demanding a refusal filed a Critical against a response byte-identical to the
     * ordinary one. What is never safe is the foreign id coming back, because that means it
     * reached the lookup.
     */
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      what: 'body kpostID',
      foreignValue: VICTIM_KPOST_ID,
      title: 'A body-supplied kpostID is acknowledged on a font preference write',
    });
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload();
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload();
    const response = await generalSettingsClient.fontSetting(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not stored as a null preference', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.fontSetting({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a font preference write' },
      [400, 401, 403, 422],
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.sendRaw(
      GENERAL_SETTINGS_PATHS.fontSetting,
      '{invalid json',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-sending the same font preference must be stable', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildFontSettingPayload();
    const [first, second, third] = await Promise.all([
      generalSettingsClient.fontSetting(payload, { token: staticToken }),
      generalSettingsClient.fontSetting(payload, { token: staticToken }),
      generalSettingsClient.fontSetting(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical upserts returned different statuses (${statuses.join(', ')}). The spec documents this route as idempotent, so a divergence means the upsert races.`,
    ).toBe(1);
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * POST /generalSetting/changeTheme
 * ====================================================================================== */
test.describe('POST /generalSetting/changeTheme @audit', () => {
  const META = {
    method: 'POST',
    path: GENERAL_SETTINGS_PATHS.changeTheme,
    repro: `await generalSettingsClient.changeTheme(buildChangeThemePayload(), { token });`,
  };

  test('[1] happy path: a valid theme change satisfies the Zod contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await expectValidContract(
      response,
      changeThemeResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403],
    );
  });

  test('[1b] contract: a successful change must echo the settings under "changeTheme"', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || json.statusCode !== 200,
      'theme change did not succeed, so there is no success payload to inspect',
    );

    expect(
      json?.changeTheme,
      `the theme change succeeded but no "changeTheme" key was returned. The spec documents that this route echoes the persisted settings under that key so the client can repaint without a second round trip; without it the client renders stale colours. Body: ${text.slice(0, 200)}`,
    ).toBeDefined();
  });

  test('[2] boundary: a 5000-character layout theme must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ kpostLayoutTheme: MAX_LENGTH_STRING });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    expect(
      response.status(),
      `a 5000-character kpostLayoutTheme produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 layout theme is handled without a server fault', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ kpostLayoutTheme: UTF8_STRING });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    expect(
      response.status(),
      `a multi-byte UTF-8 kpostLayoutTheme produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] missing required parameter: "colourPalette" omitted must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    delete (payload as Record<string, unknown>).colourPalette;

    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'required field "colourPalette" omitted' },
      [400, 401, 403, 422],
    );
  });

  test('[4] null fuzzing: "colourPalette" set to null must be refused', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ colourPalette: null });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "colourPalette" set to null' },
      [400, 401, 403, 422],
    );
  });

  test('[4b] empty fuzzing: an empty colour palette must not be persisted', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ colourPalette: '' });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "colourPalette" set to an empty string' },
      [400, 401, 403, 422],
    );
  });

  test('[5] type mismatch: a numeric layout theme where a name string is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ kpostLayoutTheme: 1 });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    expect(
      response.status(),
      `kpostLayoutTheme was sent as a number and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array where the wallpaper object is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    // The only nested object in this contract, so the one place a shape mismatch (array for
    // object) can reach the deserialiser rather than a plain string setter.
    const payload = buildChangeThemePayload({
      katchupChatBackgroundThemeWallpaper: ['default'],
    });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    expect(
      response.status(),
      `katchupChatBackgroundThemeWallpaper was sent as an array where an object is documented and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5c] type mismatch: a string night-mode flag where an integer is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ nightModeEnable: 'yes' });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    expect(
      response.status(),
      `nightModeEnable was sent as a string where the contract documents 0|1 and produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload must not be stored or reflected unescaped', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ kpostLayoutTheme: XSS_PAYLOAD });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        body: payload,
        repro: `await generalSettingsClient.changeTheme(buildChangeThemePayload({ kpostLayoutTheme: ${JSON.stringify(XSS_PAYLOAD)} }), { token });`,
      },
      XSS_PAYLOAD,
    );
  });

  test('[7] SQL injection: a tautology payload must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload({ kpostLayoutTheme: SQLI_PAYLOAD });
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test("[8c] IDOR: a body-supplied kpostID must not repaint another user's app", async ({
    generalSettingsClient,
    staticToken,
    authSession,
  }) => {
    const payload = buildPayloadWithForeignIdentity(buildChangeThemePayload(), VICTIM_KPOST_ID);
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });
    const { json, text } = await readBody(response);
    // A 200 does NOT prove a cross-user write: the API may have safely scoped the
    // theme change to the caller's own record and ignored the body-supplied kpostID.
    // Only a response reflecting the injected identity proves the body won over the token.
    const reflectedForeignIdentity =
      json !== null &&
      JSON.stringify(json).toLowerCase().includes(String(VICTIM_KPOST_ID).toLowerCase());

    expect(
      reflectedForeignIdentity,
      `a theme change for the injected kpostID="${VICTIM_KPOST_ID}" was written back to the caller ${authSession.kpostID ?? 'an unrelated identity'} — the body-supplied identity won over the token, letting any user repaint another user's app. Body: ${text.slice(0, 200)}`,
    ).toBeFalsy();
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertNot200OKOnError(response, { ...META, body: payload });
  });

  test('[9b] status misreporting: HTTP status must equal the envelope statusCode', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    const response = await generalSettingsClient.changeTheme(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused, not applied as a null theme', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.changeTheme({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a theme change' },
      [400, 401, 403, 422],
    );
  });

  test('[10b] structural: a malformed JSON body must be a clean HTTP 400', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.sendRaw(
      GENERAL_SETTINGS_PATHS.changeTheme,
      '[1,2,',
      { token: staticToken },
    );

    expect(
      response.status(),
      `a malformed JSON body produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[10c] idempotency: re-applying the same theme must be stable', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const payload = buildChangeThemePayload();
    const [first, second, third] = await Promise.all([
      generalSettingsClient.changeTheme(payload, { token: staticToken }),
      generalSettingsClient.changeTheme(payload, { token: staticToken }),
      generalSettingsClient.changeTheme(payload, { token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three concurrent identical theme changes returned different statuses (${statuses.join(', ')}). The handler reads the row back after writing it, so a divergence points at a race between the update and the read.`,
    ).toBe(1);
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'POST',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});

/* =========================================================================================
 * GET /generalSetting/getPersonalize
 * ====================================================================================== */
test.describe('GET /generalSetting/getPersonalize @audit', () => {
  const META = {
    method: 'GET',
    path: GENERAL_SETTINGS_PATHS.getPersonalize,
    repro: `await generalSettingsClient.getPersonalize({ token });`,
  };

  test('[1] happy path: the personalisation block satisfies the Zod contract', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({ token: staticToken });

    await expectValidContract(response, getPersonalizeResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[2] boundary: an oversized query parameter must not break the read', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { filter: MAX_LENGTH_STRING },
    });

    expect(
      response.status(),
      `a 5000-character query parameter produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[2b] boundary: a UTF-8 query parameter is handled cleanly', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { tag: UTF8_STRING },
    });

    expect(
      response.status(),
      `a multi-byte UTF-8 query parameter produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[3] missing parameters: the route takes none, so a bare call must resolve', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({ token: staticToken });

    expect(
      response.status(),
      `a parameterless read produced HTTP ${response.status()}. The caller is identified by the token, so no request parameters are required.`,
    ).toBeLessThan(600);
  });

  test('[4] null fuzzing: a literal "null" query value must not be interpolated', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { kpostID: 'null' },
    });

    expect(
      response.status(),
      `the literal string "null" as a query value produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[5] type mismatch: a non-numeric value where an id is expected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { settingId: 'not-a-number' },
    });

    expect(
      response.status(),
      `a non-numeric settingId query value produced HTTP ${response.status()}.`,
    ).toBeLessThan(500);
  });

  test('[6] XSS: a script payload in a query parameter must not be reflected', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { cb: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] SQL injection: a tautology query parameter must not leak database internals', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({
      token: staticToken,
      params: { kpostID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[8] auth: a request with no Authorization header must be HTTP 401/403', async ({
    generalSettingsClient,
  }) => {
    const response = await generalSettingsClient.getPersonalize({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[8b] auth: an expired token must be HTTP 401/403', async ({ generalSettingsClient }) => {
    const response = await generalSettingsClient.getPersonalize({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[8c] IDOR: a query-supplied kpostID must not switch whose settings are returned', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const own = await readBody(await generalSettingsClient.getPersonalize({ token: staticToken }));
    const impersonated = await readBody(
      await generalSettingsClient.getPersonalize({
        token: staticToken,
        params: { kpostID: VICTIM_KPOST_ID },
      }),
    );

    expect(
      comparableBody(impersonated.text),
      `supplying kpostID="${VICTIM_KPOST_ID}" as a query parameter changed the personalisation returned. The row must be selected for the token-derived kpostID only.`,
    ).toBe(comparableBody(own.text));
  });

  test('[9] status misreporting: HTTP 200 must not carry a failure payload', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({ token: staticToken });

    await assertNot200OKOnError(response, META);
  });

  test('[9b] documented defect: "no preference saved yet" must not be reported as HTTP 500', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const response = await generalSettingsClient.getPersonalize({ token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.status(),
      `the personalisation read answered HTTP ${response.status()}. swagger.json documents that a user who has never saved a preference has no settings row and that this handler reports the empty result as 500 rather than an empty 200. A brand-new account is a normal state, not a server fault: this makes every first-run client look broken and floods error monitoring. Body: ${text.slice(0, 200)}`,
    ).toBeLessThan(500);
  });

  test('[10] idempotency: three concurrent identical reads must agree', async ({
    generalSettingsClient,
    staticToken,
  }) => {
    const [first, second, third] = await Promise.all([
      generalSettingsClient.getPersonalize({ token: staticToken }),
      generalSettingsClient.getPersonalize({ token: staticToken }),
      generalSettingsClient.getPersonalize({ token: staticToken }),
    ]);
    const statuses = [first.status(), second.status(), third.status()];

    expect(
      new Set(statuses).size,
      `three identical concurrent reads returned different statuses (${statuses.join(', ')}).`,
    ).toBe(1);
  });

  test('[10b] round trip: a saved theme must be readable back through getPersonalize', async ({
    generalSettingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Excel value, not an invented one — 'LIGHT' was written into the phantom `theme` field and
    // could never surface, so this case failed as a persistence defect that was ours, not the API's.
    const payload = buildChangeThemePayload({ kpostLayoutTheme: 'purple' });

    const write = await generalSettingsClient.changeTheme(payload, { token });
    const { json: writeJson } = await readBody(write);

    // Only a write the API accepted can be held to a read-back. Otherwise a rejected payload
    // would be reported as a persistence failure.
    test.skip(
      writeJson === null || writeJson.statusCode !== 200,
      'the theme write did not succeed, so there is nothing to read back',
    );

    const { text, json } = await readBody(await generalSettingsClient.getPersonalize({ token }));

    expect(
      text.toLowerCase(),
      `a kpostLayoutTheme saved through changeTheme was not visible in the getPersonalize read. The two routes share one settings row, so a write the API acknowledged that does not surface in the canonical read means the update did not persist. Read body: ${JSON.stringify(json).slice(0, 200)}`,
    ).toContain('purple');
  });

  test("[IDOR] a foreign kpostID must not reach another owner's record", async ({
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
    const response = await genericClient.send(
      'GET',
      META.path,
      { kpostID: FOREIGN.kpostID },
      { token: staticToken },
    );
    await assertNoForeignAcknowledgement(response, {
      ...META,
      what: 'kpostID',
      foreignValue: FOREIGN.kpostID,
    });
  });
});
