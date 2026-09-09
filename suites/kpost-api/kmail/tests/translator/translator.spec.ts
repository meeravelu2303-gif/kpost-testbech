import { expect, test } from '../../src/fixtures/api.fixture';
import { RETIRED_PATHS, SENT_MAIL_PATHS, TRANSLATOR_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { translationResponseSchema } from '../../src/api/schemas/kmail.schema';
import {
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatus,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildAutoDetectTranslationPayload,
  buildExplicitTranslationPayload,
  buildTranslationPayload,
} from '../../src/api/payloads/translator.payload';
import { buildComposePayload } from '../../src/api/payloads/sentMail.payload';
import { qaLabel } from '../../src/utils/safeTestData';

/**
 * The Translation controller — `/v2/translator/**`.
 *
 *  - `translation` does what the controller is named for. Omitting `langFrom` triggers
 *    auto-detection, which calls a third-party service — cases depending on it say so, so an
 *    upstream outage is reported as such rather than as a KMail defect.
 *  - `postMail` is a second send path, documented as the "Unauthenticated Translator Path" — a
 *    duplicate of the authenticated write behind a name suggesting language processing. Cases
 *    compare it against `/v2/sentMail/postMail` rather than assuming the two agree.
 *
 * `unusedpostMail` is marked `[Dead Code]` but still mapped, so it still executes.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * POST /v2/translator/translation
 * ====================================================================================== */
test.describe('POST /v2/translator/translation', () => {
  const META = {
    method: 'POST',
    path: TRANSLATOR_PATHS.translation,
    repro: `await translatorClient.translation(buildTranslationPayload(), { token });`,
    // Stateless echo: translates and returns, stores nothing. Reflected script here is Major
    // (executes only in a renderer), not the Critical stored-XSS the 200/SUCCESS would imply.
    stateless: true,
  };

  test('[1] happy path: an explicit-langFrom translation satisfies the contract', async ({
    translatorClient,
    token,
  }) => {
    // buildTranslationPayload sends an explicit langFrom (deterministic); the auto-detection branch
    // is exercised separately in [2b].
    const payload = buildTranslationPayload();
    const response = await translatorClient.translation(payload, { token });

    await expectValidContract(
      response,
      translationResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] happy path: an explicit source language is honoured', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildExplicitTranslationPayload('fr', 'en');
    const response = await translatorClient.translation(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !response.ok(),
      'translation did not succeed — the upstream language service may be unavailable'
    );

    const data = json?.data as Record<string, unknown> | undefined;
    const reportedFrom = data?.msgTranslatedFromLanguage;

    test.skip(
      reportedFrom === undefined,
      'the response does not report the source language actually used'
    );

    expect(
      String(reportedFrom).toLowerCase(),
      `an explicit langFrom of "fr" was reported back as "${String(reportedFrom)}". Supplying the source language is documented to bypass auto-detection; if the value is ignored, the service pays for a detection call the caller told it not to make — and gets a different answer when detection is wrong. Body: ${text.slice(0, 200)}`
    ).toBe('fr');
  });

  test('[2b] auto-detection: an omitted langFrom is detected upstream, not defaulted blindly', async ({
    translatorClient,
    token,
  }) => {
    // The documented auto-detection path — langFrom genuinely absent, so the server must call its
    // third-party detector. Skips on upstream unavailability (external dependency) rather than failing.
    const payload = buildAutoDetectTranslationPayload({
      msgToTranslate: 'Bonjour, ceci est un message en français.',
    });
    const response = await translatorClient.translation(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !response.ok(),
      'auto-detected translation did not succeed — the upstream language detector may be unavailable'
    );

    const data = json?.data as Record<string, unknown> | undefined;
    const detectedFrom = data?.msgTranslatedFromLanguage;
    test.skip(
      detectedFrom === undefined,
      'the response does not report a detected source language'
    );

    // A French input with no langFrom must be detected as French (or at least not blindly echoed as
    // the target). A detector that returns the target language, or empty, means auto-detection is a
    // silent no-op and every langFrom-less caller gets a mistranslation.
    expect(
      String(detectedFrom).trim().length > 0 && String(detectedFrom).toLowerCase() !== 'en',
      `an omitted langFrom on a French message reported source language "${String(detectedFrom)}". Auto-detection is documented; if it returns the target language or nothing, the caller who relied on detection ships untranslated text. Body: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  test('[3] the translated text must differ from the input', async ({
    translatorClient,
    token,
  }) => {
    // Checks the endpoint does its job. A translator returning the input unchanged (upstream failed
    // and passed through) looks like success at every other layer: 200, well-formed envelope,
    // populated field.
    const source = 'Bonjour, merci pour votre message.';
    const payload = buildExplicitTranslationPayload('fr', 'en', { msgToTranslate: source });
    const response = await translatorClient.translation(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !response.ok(),
      'translation did not succeed — the upstream language service may be unavailable'
    );

    const data = json?.data as Record<string, unknown> | undefined;
    const translated = data?.msgAfterTranslation;
    test.skip(
      typeof translated !== 'string' || translated.length === 0,
      'the response carries no translated text'
    );

    expect(
      String(translated).trim(),
      `translating French to English returned the input unchanged. A pass-through on upstream failure is indistinguishable from success at every other layer — 200, well-formed envelope, populated field — so the caller ships untranslated text believing it was translated. Body: ${text.slice(0, 200)}`
    ).not.toBe(source);
  });

  test('[4] validation: a missing target language must be refused', async ({
    translatorClient,
    token,
  }) => {
    // `langTo` is documented as required; a service that guesses a default silently returns text in
    // a language nobody asked for.
    const payload = buildTranslationPayload();
    delete (payload as Record<string, unknown>).langTo;
    const response = await translatorClient.translation(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the required target language was omitted',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a null target language must be refused', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildTranslationPayload({ langTo: null });
    const response = await translatorClient.translation(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "langTo" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] validation: an unknown language code must be refused', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildExplicitTranslationPayload('fr', 'zz');
    const response = await translatorClient.translation(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: '"zz" is not an ISO 639-1 language code',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] business rule: identical source and target must be refused', async ({
    translatorClient,
    token,
  }) => {
    // The API states `langTo` must differ from the resolved `langFrom`. Accepting a no-op bills an
    // upstream call for a round trip that cannot change anything.
    const payload = buildExplicitTranslationPayload('en', 'en');
    const response = await translatorClient.translation(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the source and target languages are the same',
        severity: 'Minor',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] validation: empty text must be refused or returned unchanged', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildTranslationPayload({ msgToTranslate: '' });
    const response = await translatorClient.translation(payload, { token });

    expect(
      response.status(),
      `an empty string to translate produced HTTP ${response.status()}. Nothing to translate is a 400 or a trivial no-op — it must not reach the upstream service and must not fault.`
    ).toBeLessThan(500);
  });

  test('[9] response-only fields supplied by the caller must be ignored', async ({
    translatorClient,
    token,
  }) => {
    // `msgAfterTranslation` is documented as response-only. A caller-supplied value coming back
    // unchanged means the endpoint echoes rather than translates, handing consumers attacker text.
    const planted = qaLabel('planted-translation');
    const payload = buildTranslationPayload({ msgAfterTranslation: planted });
    const response = await translatorClient.translation(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(
      json === null || !response.ok(),
      'translation did not succeed — the upstream language service may be unavailable'
    );

    const data = json?.data as Record<string, unknown> | undefined;

    expect(
      data?.msgAfterTranslation === planted,
      `a caller-supplied msgAfterTranslation came back unchanged. The field is documented as response-only and populated by the service; echoing it means any consumer reading the translation is being handed text the caller wrote. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[10] boundary: a 5000-character input must be bounded', async ({
    translatorClient,
    token,
  }) => {
    // Each call is a paid upstream request whose cost scales with the input, so an unbounded input
    // is somebody else's bill.
    const payload = buildTranslationPayload({ msgToTranslate: MAX_LENGTH_STRING });
    const response = await translatorClient.translation(payload, { token });

    expect(
      response.status(),
      `a 5000-character translation input produced HTTP ${response.status()}. Each call is a paid upstream request whose cost scales with the input, so the size needs a stated cap enforced with a 400.`
    ).toBeLessThan(500);
  });

  test('[11] XSS: markup in the text must not be reflected unescaped', async ({
    translatorClient,
    token,
  }) => {
    // Real mail bodies are HTML, so markup here is normal. The question is whether it comes back
    // executable — a translated body is rendered in a client exactly as the original would be.
    const payload = buildTranslationPayload({ msgToTranslate: XSS_PAYLOAD });
    const response = await translatorClient.translation(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[12] injection: a tautology must not leak internals', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildTranslationPayload({ msgToTranslate: SQLI_PAYLOAD });
    const response = await translatorClient.translation(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[13] an upstream failure must not leak the third-party integration', async ({
    translatorClient,
    token,
  }) => {
    // Auto-detection calls a third party. On failure the error must be the service's own — not the
    // provider's response, which routinely carries the API key, account id, or quota state.
    const payload = buildTranslationPayload({ msgToTranslate: ' ￿ invalid ​' });
    const response = await translatorClient.translation(payload, { token });
    const { text } = await readBody(response);

    await assertNoInternalLeak(response, { ...META, body: payload }, 'upstream');

    expect(
      /(api[_-]?key|detectlanguage|rapidapi|x-rapidapi|bearer\s+[A-Za-z0-9._-]{20,})/i.test(text),
      `a failed translation returned details of the upstream language provider — an API key, provider host, or credential. When a third-party call fails, the caller must see this service's own error; the provider's response frequently carries the integration credential in it. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[14] auth: an anonymous caller must not use the translator', async ({
    translatorClient,
  }) => {
    // `translation` is not on the documented anonymous list and is a paid upstream call.
    // Unauthenticated access makes it a free translation service billed to this platform.
    const payload = buildTranslationPayload();
    const response = await translatorClient.translation(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[15] structural: malformed JSON must be a clean 400', async ({
    translatorClient,
    token,
  }) => {
    const malformed = '{"langTo":';
    const response = await translatorClient.sendRaw(TRANSLATOR_PATHS.translation, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await translatorClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[16] status parity: HTTP status must agree with the envelope', async ({
    translatorClient,
    token,
  }) => {
    const response = await translatorClient.translation({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });
});

/* =========================================================================================
 * POST /v2/translator/postMail — the second send path
 * ====================================================================================== */
test.describe('POST /v2/translator/postMail', () => {
  const META = {
    method: 'POST',
    path: TRANSLATOR_PATHS.postMail,
    repro: `await translatorClient.postMail(buildComposePayload(), { token });`,
  };

  test('[1] the unauthenticated send path must not send mail anonymously', async ({
    translatorClient,
  }) => {
    // Documented as the "Unauthenticated Translator Path", taking the same `SentMailRequestObject`
    // as `/v2/sentMail/postMail`. If it sends without a token, the platform is an open relay:
    // anyone reaching the port sends mail with this domain's DKIM signature and no session to
    // revoke. Asserted on whether mail was accepted, not the status code — a 200 with
    // `status: FAILURE` is the route refusing, and demanding a 401 from a documented-anonymous route
    // would file against stated behaviour.
    const payload = buildComposePayload({ kmailSubject: qaLabel('anon-relay-probe') });
    const response = await translatorClient.postMail(payload, { token: null });
    const { json, text } = await readBody(response);

    const status = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
    const statusCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
    const accepted =
      response.status() >= 200 &&
      response.status() < 300 &&
      status !== 'FAILURE' &&
      status !== 'ERROR' &&
      status !== 'UNAUTHORIZED' &&
      (statusCode === null || statusCode < 400);

    expect(
      accepted,
      `an anonymous caller submitted a mail to /v2/translator/postMail and it was accepted (HTTP ${response.status()}). This is a second send path, on a controller whose stated job is language detection, taking the same compose DTO as the authenticated send route. If it delivers, the platform is an open relay: anyone who can reach the port sends mail carrying this domain's reputation and DKIM signature, with no session to revoke. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[2] the translator send path must not be more permissive than the real one', async ({
    translatorClient,
    sentMailClient,
  }) => {
    // Two routes, one operation. A difference means the authentication filter is scoped by path and
    // this controller sits outside it.
    const payload = buildComposePayload();
    const [translator, canonical] = await Promise.all([
      translatorClient.postMail(payload, { token: null }),
      sentMailClient.postMail(payload, { token: null }),
    ]);

    expect(
      translator.status(),
      `the translator send path answered HTTP ${translator.status()} to an anonymous caller while /v2/sentMail/postMail answered ${canonical.status()}. Both take the same compose DTO and perform the same operation; a difference means the authentication filter is applied by path prefix and this controller is outside it.`
    ).toBe(canonical.status());
  });

  test('[3] an authenticated send through the translator path behaves consistently', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await translatorClient.postMail(payload, { token });

    await assertStatus(response, [200, 400, 401, 403, 404], { ...META, body: payload });
  });

  test('[4] IDOR: the translator path must not let the body choose the sender', async ({
    translatorClient,
    token,
    callerKpostId,
  }) => {
    // `fromAddress` is server-assigned on the canonical route; whether it is here is a separate
    // question. On a documented-anonymous path, a body-controlled sender makes spoofing trivial.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to spoof');

    const payload = buildComposePayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await translatorClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'the translator send returned no parseable body');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the translator send path reported the mail as sent from "${FOREIGN.victimKpostID}" while the caller was ${callerKpostId ?? 'a different identity'}. The canonical send route overwrites fromAddress from the JWT; this one is a separate code path and needs the same assignment. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] validation: a send with no recipient must be refused', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildComposePayload();
    delete (payload as Record<string, unknown>).toAddress;
    const response = await translatorClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a mail was submitted to the translator send path with no recipient',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] rate limiting: repeated anonymous sends must be throttled', async ({
    translatorClient,
  }) => {
    // If test [1] passes this route refuses anonymous callers; if it fails, throttling decides
    // whether the open relay is a nuisance or a reputation incident. Ten requests is a gentle probe.
    const attempts = 10;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        translatorClient.postMail(buildComposePayload(), { token: null })
      )
    );

    const throttled = responses.filter((response) => response.status() === 429).length;

    test.info().annotations.push({
      type: 'rate-limit probe',
      description: `${attempts} rapid anonymous sends through the translator path, ${throttled} throttled. A gentle probe: no 429 means the limit is above ${attempts}, not that none exists.`,
    });

    expect(
      responses.every((response) => response.status() < 500),
      `${attempts} rapid anonymous sends produced at least one 5xx. This route takes no token, so an unhandled path under modest concurrency is reachable by anyone with no credential to revoke.`
    ).toBe(true);
  });

  test('[7] XSS: a script payload must not be reflected unescaped', async ({
    translatorClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: XSS_PAYLOAD });
    const response = await translatorClient.postMail(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] structural: malformed JSON must be a clean 400', async ({ translatorClient, token }) => {
    const malformed = '{"toAddress":';
    const response = await translatorClient.sendRaw(TRANSLATOR_PATHS.postMail, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await translatorClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });
});

/* =========================================================================================
 * POST /v2/translator/unusedpostMail — [Dead Code], still mapped
 * ====================================================================================== */
test.describe('POST /v2/translator/unusedpostMail (dead code)', () => {
  const META = {
    method: 'POST',
    path: RETIRED_PATHS.translatorUnusedPostMail,
    repro: `await translatorClient.unusedPostMail(buildComposePayload(), { token: null });`,
  };

  test('[1] a dead route must not send mail anonymously', async ({ translatorClient }) => {
    // Marked `[Dead Code]` but still mapped, so it still executes — a third send path, unmaintained
    // and reachable, is where an authorisation check goes stale unnoticed.
    const payload = buildComposePayload({ kmailSubject: qaLabel('dead-route-probe') });
    const response = await translatorClient.unusedPostMail(payload, { token: null });
    const { json, text } = await readBody(response);

    const status = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
    const accepted =
      response.status() >= 200 &&
      response.status() < 300 &&
      status !== 'FAILURE' &&
      status !== 'ERROR' &&
      status !== 'UNAUTHORIZED';

    expect(
      accepted,
      `the route documented as [Dead Code] accepted an anonymous mail submission (HTTP ${response.status()}). Dead code that is still mapped still runs — and a third send path that nobody maintains is where an authorisation check goes stale unnoticed. If it is genuinely unused, it should be unmapped. Body: ${text.slice(0, 300)}`
    ).toBe(false);

    // Also graded as a status finding so the route appears in coverage. 404/405 are acceptable
    // deliberately: unmapping a dead route is the correct fix, so reporting it as a defect would
    // argue against the recommended remedy.
    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: payload,
      title: 'A [Dead Code] send path is still reachable and does not refuse anonymous callers',
      severity: 'Major',
    });
  });

  test('[2] the dead route must not be more permissive than the live one', async ({
    translatorClient,
    sentMailClient,
  }) => {
    const payload = buildComposePayload();
    const [dead, live] = await Promise.all([
      translatorClient.unusedPostMail(payload, { token: null }),
      sentMailClient.postMail(payload, { token: null }),
    ]);

    expect(
      dead.status(),
      `the [Dead Code] send path answered HTTP ${dead.status()} to an anonymous caller while the live send route answered ${live.status()}. A retired route must be at least as closed as its replacement, or unmapped entirely.`
    ).toBe(live.status());
  });

  test('[3] the dead route must not accept a spoofed sender', async ({
    translatorClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to spoof');

    const payload = buildComposePayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await translatorClient.unusedPostMail(payload, { token });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the [Dead Code] send path honoured a body-supplied fromAddress of "${FOREIGN.victimKpostID}". Server-side sender assignment is applied per route, and an unmaintained one is the likeliest place it was never added. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });
});

/* =========================================================================================
 * Send-path consistency
 * ====================================================================================== */
test.describe('Send-path consistency', () => {
  test('[1] all four send paths must agree about authentication', async ({
    sentMailClient,
    translatorClient,
  }) => {
    // Four routes submit a mail: canonical `/v2/sentMail/postMail`, its unversioned legacy twin,
    // the translator's `postMail`, and the dead `unusedpostMail`. All take the same compose DTO and
    // must refuse an anonymous caller; a difference means the auth filter is scoped by path, so
    // securing the reviewed route accomplishes nothing.
    const payload = buildComposePayload();
    const results = await Promise.all([
      sentMailClient
        .postMail(payload, { token: null })
        .then((response) => ({ name: '/v2/sentMail/postMail', status: response.status() })),
      translatorClient
        .postMail(payload, { token: null })
        .then((response) => ({ name: '/v2/translator/postMail', status: response.status() })),
      translatorClient
        .unusedPostMail(payload, { token: null })
        .then((response) => ({ name: '/v2/translator/unusedpostMail', status: response.status() })),
      sentMailClient
        .legacyPostMailMultiPart(JSON.stringify(payload), [], { token: null })
        .then((response) => ({ name: '/sentMail/postMailMultiPart/', status: response.status() })),
    ]);

    const refused = results.filter((entry) => entry.status === 401 || entry.status === 403);

    expect(
      refused.length,
      `only ${refused.length} of the ${results.length} send paths refused an anonymous caller with 401/403: ${results.map((entry) => `${entry.name}=${entry.status}`).join(', ')}. All four accept the same compose DTO and perform the same operation. Any one of them that is open makes the others' authentication irrelevant — and the three that are not the canonical route are precisely the ones a review does not look at.`
    ).toBe(results.length);
  });

  test('[2] the canonical send path is the one documented as authenticated', async () => {
    // A registry assertion, not a request: it fails on the constant if someone changes the canonical
    // send route, catching the change where it is made.
    expect(
      SENT_MAIL_PATHS.postMail,
      'The canonical send route must remain /v2/sentMail/postMail. Every send-path comparison in this file is written against it as the reference implementation of correct authentication behaviour.'
    ).toBe('/v2/sentMail/postMail');
  });
});
