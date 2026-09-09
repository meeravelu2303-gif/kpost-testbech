import { test, expect, EXPIRED_TOKEN, FORGED_ALG_NONE_JWT, MALFORMED_TOKEN } from '../../src/fixtures/api.fixture';
import { dataEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  assertStatus,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  assertPublicRouteReachable,
  expectValidContract,
  readBody,
  comparableBody,
} from '../../src/utils/apiAssertions';
import {
  buildEnterpriseAddUserPayload,
  buildEnterpriseLoginPayload,
  buildEnterpriseSignupPayload,
} from '../../src/api/payloads/integrations.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/*
 * Registration provisions a real account and measured at ~14.3s against a sub-200ms suite
 * baseline. The idempotency case fires three concurrently, so the default 30s global timeout
 * is not enough headroom — a timeout there would read as a defect when it is only slowness.
 */
test.describe.configure({ timeout: 90_000 });


/**
 * Authentication — Medium & Large Enterprise (`/signupLoginForMediumAndLarge/**`).
 *
 * A **second, parallel authentication stack** alongside `/v2/signupLogin/**`. That is the
 * structural finding this file is built around: two sign-up and two login implementations
 * mean every auth fix has to be applied twice, and the one nobody remembers becomes the way
 * in. The tests therefore compare the two stacks directly wherever the same rule should hold.
 *
 * The `userType` values here carry a **size suffix** — `BUSINESS_M`, `INSTITUTION_S`,
 * `BUSINESS_L`. That came from the QA tracker export, and it explains the otherwise
 * inexplicable `"Invalid maximumMembersCount for userType"` rejection that the plain
 * `BUSINESS` value produces: the tier is encoded in the type, and the member cap is validated
 * against it.
 *
 * ## Safety
 *
 * `signup` creates a real company and a real admin account, and `addingUserByAdmin` creates
 * real users. Every identity here is synthetic (`qaent*`, `md@qaent*.kpost.in`) and every
 * mobile number is in the unallocated 90000xxxxx block, so anything that does land is
 * obviously test data and reaches no real handset.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /signupLoginForMediumAndLarge/signup
 * ====================================================================================== */
test.describe('POST /signupLoginForMediumAndLarge/signup', () => {
  const META = {
    method: 'POST',
    path: '/signupLoginForMediumAndLarge/signup',
    repro: `await apiContext.post('/signupLoginForMediumAndLarge/signup', { data: buildEnterpriseSignupPayload() });`,
  };

  test('[public] enterprise sign-up must stay reachable without a token', async ({ apiContext }) => {
    // security: [] — a company registering has no bearer yet, so a token gate blocks every
    // medium/large onboarding outright. apiContext sends no Authorization header.
    const response = await apiContext.post(META.path, { data: buildEnterpriseSignupPayload() });
    await assertPublicRouteReachable(response, { ...META, severity: 'Critical', body: 'buildEnterpriseSignupPayload()' });
  });

  test('[1] happy path: enterprise sign-up satisfies the Zod contract', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseSignupPayload();
    const response = await apiContext.post(META.path, { data: payload });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403]
    );
  });

  test('[2] business rule: an unsuffixed userType must give a clear error', async ({
    apiContext,
  }) => {
    // Plain "BUSINESS" is rejected with "Invalid maximumMembersCount for userType" — a message
    // that names a field the caller did not send and says nothing about the real problem.
    const payload = buildEnterpriseSignupPayload({ userType: 'BUSINESS' });
    const response = await apiContext.post(META.path, { data: payload });
    const { text } = await readBody(response);

    expect(
      /maximumMembersCount/i.test(text),
      `an unsuffixed userType produced "Invalid maximumMembersCount for userType". The caller sent no maximumMembersCount; the actual requirement is a size suffix (BUSINESS_S/_M/_L). The message points at the wrong field and cost real debugging time. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[3] business rule: an unknown tier suffix must be refused', async ({ apiContext }) => {
    const payload = buildEnterpriseSignupPayload({ userType: 'BUSINESS_XXL' });
    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'userType BUSINESS_XXL is not a defined tier' },
      [400, 401, 403, 422]
    );
  });

  test('[4] missing required parameter: no companyName must be refused', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseSignupPayload();
    delete (payload as Record<string, unknown>).companyName;

    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'an enterprise registration with no company name' },
      [400, 401, 403, 422]
    );
  });

  test('[5] null fuzzing: a null password must be refused', async ({ apiContext }) => {
    const payload = buildEnterpriseSignupPayload({ password: null });
    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "password" set to null on registration' },
      [400, 401, 403, 422]
    );
  });

  test('[6] business rule: a weak password must be refused', async ({ apiContext }) => {
    const payload = buildEnterpriseSignupPayload({ password: '1' });
    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a one-character password on an enterprise admin account',
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] parity: the enterprise stack must enforce the same rules as /v2/signupLogin', async ({
    apiContext,
  }) => {
    // Two parallel sign-up implementations. If one accepts what the other refuses, the weaker
    // becomes the registration path an attacker uses.
    const weak = { password: '1' };
    const [enterprise, standard] = await Promise.all([
      apiContext.post(META.path, { data: buildEnterpriseSignupPayload(weak) }),
      apiContext.post('/v2/signupLogin/signup', { data: { ...weak, kpostID: 'qaparity' } }),
    ]);

    expect(
      enterprise.status() < 400,
      `the enterprise stack answered ${enterprise.status()} to a one-character password while /v2/signupLogin answered ${standard.status()}. Two authentication implementations must not disagree on password policy.`
    ).toBe(false);
  });

  test('[8] XSS: a script payload in the company name must not be persisted', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseSignupPayload({ companyName: XSS_PAYLOAD });
    const response = await apiContext.post(META.path, { data: payload });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[9] SQL injection: a tautology must not leak database internals', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseSignupPayload({ companyName: SQLI_PAYLOAD });
    const response = await apiContext.post(META.path, { data: payload });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] disclosure: the response must not echo the password', async ({ apiContext }) => {
    const payload = buildEnterpriseSignupPayload();
    const response = await apiContext.post(META.path, { data: payload });
    const { text } = await readBody(response);

    expect(
      text.includes('Qa@Passw0rd123'),
      `the registration response echoed the submitted password in clear text. Body: ${text.slice(0, 250)}`
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
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });


  test('[typefuzz] a syntactically malformed body must be a clean HTTP 400', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Malformed JSON rather than a wrong-typed field, deliberately.
     *
     * A field of the wrong type is ambiguous: an endpoint that ignores it and succeeds is
     * behaving correctly, so asserting rejection would manufacture findings. Invalid JSON has
     * no such defence — the parser cannot produce a DTO, so 400 (or 415) is the only correct
     * answer. A 500 here means the parse exception escaped to the caller; a 200 means the
     * endpoint did not read its body at all.
     */
    const malformed = '{"' + 'a'.repeat(8) + '": ';
    const response = await genericClient.sendRaw('POST', META.path, malformed, {
      token: staticToken,
    });

    await assertStatus(response, [400, 401, 403, 404, 405, 415, 422], {
      ...META,
      body: malformed,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

});

/* =========================================================================================
 * POST /signupLoginForMediumAndLarge/adminUserLogin
 * ====================================================================================== */
test.describe('POST /signupLoginForMediumAndLarge/adminUserLogin', () => {
  const META = {
    method: 'POST',
    path: '/signupLoginForMediumAndLarge/adminUserLogin',
    repro: `await apiContext.post('/signupLoginForMediumAndLarge/adminUserLogin', { data: buildEnterpriseLoginPayload() });`,
  };

  test('[public] enterprise admin login must stay reachable without a token', async ({ apiContext }) => {
    // security: [] — the admin has no bearer until this login returns one; a token gate is a
    // total login blockade for every medium/large tenant. Probe with an INVALID body so the
    // response is app validation (400), not the 401 this route returns for a wrong password —
    // that credential rejection is not a gate, and would mask what this test is checking.
    const response = await apiContext.post(META.path, { data: {} });
    await assertPublicRouteReachable(response, { ...META, severity: 'Critical', body: '{}' });
  });

  test('[1] happy path: an enterprise login satisfies the Zod contract', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseLoginPayload();
    const response = await apiContext.post(META.path, { data: payload });

    await expectValidContract(
      response,
      dataEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] credentials: an unknown account must not be distinguishable from a wrong password', async ({
    apiContext,
  }) => {
    const [unknownUser, wrongPassword] = await Promise.all([
      apiContext.post(META.path, {
        data: buildEnterpriseLoginPayload({ kpostID: 'md@qanosuchcompany.kpost.in' }),
      }),
      apiContext.post(META.path, {
        data: buildEnterpriseLoginPayload({
          loginRO: { countryID: '1', password: 'definitely-wrong', userType: 'BUSINESS' },
        }),
      }),
    ]);
    const a = await readBody(unknownUser);
    const b = await readBody(wrongPassword);

    expect(
      comparableBody(a.text),
      `an unknown account and a wrong password produced different responses. A difference here confirms which enterprise accounts exist, which is the first step of a targeted attack. Unknown: ${a.text.slice(0, 120)} / Wrong password: ${b.text.slice(0, 120)}`
    ).toBe(comparableBody(b.text));
  });

  test('[3] disclosure: a failed login must not reveal why', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({
      loginRO: { countryID: '1', password: 'definitely-wrong', userType: 'BUSINESS' },
    });
    const response = await apiContext.post(META.path, { data: payload });
    const { text } = await readBody(response);

    expect(
      /no such (user|account)|user not found|account does not exist/i.test(text),
      `the failure named the account as the problem. "Invalid credentials" is the only safe wording. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[4] missing required parameter: no deviceType must not NPE', async ({ apiContext }) => {
    // The standard stack NPEs on the first line when deviceType is absent
    // (loginDetails.getDeviceType().equals("iOS")). This checks the enterprise twin.
    const payload = buildEnterpriseLoginPayload();
    delete (payload as Record<string, unknown>).deviceType;

    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'deviceType omitted — the standard login stack dereferences it unchecked',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] null fuzzing: a null loginRO must be refused', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({ loginRO: null });
    const response = await apiContext.post(META.path, { data: payload });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "loginRO" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[6] SQL injection: a tautology must not authenticate', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({
      kpostID: SQLI_PAYLOAD,
      loginRO: { countryID: '1', password: SQLI_PAYLOAD, userType: 'BUSINESS' },
    });
    const response = await apiContext.post(META.path, { data: payload });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      typeof json?.accessToken === 'string' && (json.accessToken as string).length > 0,
      `a SQL tautology in the credentials produced an access token. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[6b] SQL injection: a tautology must not leak database internals', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseLoginPayload({ kpostID: SQLI_PAYLOAD });
    const response = await apiContext.post(META.path, { data: payload });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] status misreporting: HTTP status must equal the envelope statusCode', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseLoginPayload();
    const response = await apiContext.post(META.path, { data: payload });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[8] rate limiting: repeated failures must be throttled', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({
      loginRO: { countryID: '1', password: 'wrong', userType: 'BUSINESS' },
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => apiContext.post(META.path, { data: payload }))
    );
    const throttled = responses.filter((r) => r.status() === 429).length;

    expect(
      throttled,
      `eight consecutive failed enterprise logins produced ${throttled} throttled responses. An admin login with no lockout is a credential-stuffing target, and these accounts control whole companies.`
    ).toBeGreaterThan(0);
  });

  test('[9] boundary: a 5000-character kpostID must not fault', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({ kpostID: MAX_LENGTH_STRING });
    const response = await apiContext.post(META.path, { data: payload });

    expect(
      response.status(),
      `a 5000-character kpostID produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] XSS: a script payload must not be reflected unescaped', async ({ apiContext }) => {
    const payload = buildEnterpriseLoginPayload({ kpostID: XSS_PAYLOAD });
    const response = await apiContext.post(META.path, { data: payload });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
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
 * POST /signupLoginForMediumAndLarge/addingUserByAdmin
 * ====================================================================================== */
test.describe('POST /signupLoginForMediumAndLarge/addingUserByAdmin', () => {
  const META = {
    method: 'POST',
    path: '/signupLoginForMediumAndLarge/addingUserByAdmin',
    repro: `await apiContext.post('/signupLoginForMediumAndLarge/addingUserByAdmin', { data: buildEnterpriseAddUserPayload(), headers: { Authorization: 'Bearer <token>' } });`,
  };

  const authed = (token: string | null): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  test('[1] PRIVILEGE: an ordinary member must not add users to an enterprise', async ({
    apiContext,
    staticToken,
    authSession,
  }) => {
    const payload = buildEnterpriseAddUserPayload();
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });

    await assertStatus(response, [401, 403], {
      ...META,
      body: payload,
      title: 'A non-admin can provision users into an enterprise',
      severity: 'Critical',
      repro: `// as an ordinary member (${authSession.kpostID ?? 'any account'}):\nawait apiContext.post('${META.path}', { data: buildEnterpriseAddUserPayload(), headers: { Authorization: 'Bearer <member token>' } });`,
    });
  });

  test('[2] auth: an anonymous provisioning call must be refused', async ({ apiContext }) => {
    const payload = buildEnterpriseAddUserPayload();
    const response = await apiContext.post(META.path, { data: payload, headers: authed(null) });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[3] IDOR: a body companyID must not place a user in another company', async ({
    apiContext,
    staticToken,
    authSession,
  }) => {
    const payload = buildEnterpriseAddUserPayload({ companyID: 1, adminKpostID: VICTIM_KPOST_ID });
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'response was not JSON');

    expect(
      json?.statusCode === 200 && String(json?.status).toUpperCase() === 'SUCCESS',
      `a user was provisioned into company 1 naming "${VICTIM_KPOST_ID}" as admin, while the caller was ${authSession.kpostID ?? 'a different identity'}. The owning company must come from the admin's token, never the body — otherwise anyone can insert an account into any organisation. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[4] privilege escalation: a body role must not grant admin', async ({
    apiContext,
    staticToken,
  }) => {
    const payload = buildEnterpriseAddUserPayload({ role: 'Admin', hasAdminAccess: 'yes' });
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'provisioning did not succeed');

    expect(
      /"(role|hasAdminAccess)"\s*:\s*"(Admin|yes)"/i.test(text),
      `the new user was created with admin rights taken straight from the request body. Role assignment has to be validated against the caller's own authority, or provisioning becomes self-service privilege escalation. Body: ${text.slice(0, 250)}`
    ).toBe(false);
  });

  test('[5] missing required parameter: no kpostID must be refused', async ({
    apiContext,
    staticToken,
  }) => {
    const payload = buildEnterpriseAddUserPayload();
    delete (payload as Record<string, unknown>).kpostID;

    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'provisioning a user with no account handle' },
      [400, 401, 403, 422]
    );
  });

  test('[6] null fuzzing: a null kpostID must be refused', async ({ apiContext, staticToken }) => {
    const payload = buildEnterpriseAddUserPayload({ kpostID: null });
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kpostID" set to null' },
      [400, 401, 403, 422]
    );
  });

  test('[7] auth: an expired token must not provision a user', async ({ apiContext }) => {
    const payload = buildEnterpriseAddUserPayload();
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(EXPIRED_TOKEN),
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8] auth: an alg=none token claiming admin must never provision', async ({
    apiContext,
  }) => {
    const payload = buildEnterpriseAddUserPayload();
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(FORGED_ALG_NONE_JWT),
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: a malformed token must not provision', async ({ apiContext }) => {
    const payload = buildEnterpriseAddUserPayload();
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(MALFORMED_TOKEN),
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] XSS: a script payload in the name must not be persisted', async ({
    apiContext,
    staticToken,
  }) => {
    const payload = buildEnterpriseAddUserPayload({ firstName: XSS_PAYLOAD });
    const response = await apiContext.post(META.path, {
      data: payload,
      headers: authed(staticToken),
    });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] duplication: this must not bypass /admin/addingUserByAdmin', async ({
    apiContext,
    staticToken,
  }) => {
    // The Company Administration tag has its own addingUserByAdmin behind /admin/**, which
    // Spring Security guards with hasRole("admin"). This route is not under that prefix.
    const payload = buildEnterpriseAddUserPayload();
    const [enterprise, guarded] = await Promise.all([
      apiContext.post(META.path, { data: payload, headers: authed(staticToken) }),
      apiContext.post('/admin/addingUserByAdmin', { data: payload, headers: authed(staticToken) }),
    ]);

    expect(
      enterprise.status() < 400 && guarded.status() >= 400,
      `the enterprise provisioning route answered ${enterprise.status()} while the /admin twin answered ${guarded.status()}. Spring Security guards "/admin/**" with hasRole("admin"); this route sits outside that prefix, so a duplicate capability escapes the role check entirely.`
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
    const response = await genericClient.send('POST', META.path, { kpostID: FOREIGN.kpostID }, { token: staticToken });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(String(FOREIGN.kpostID)),
      `the response acknowledged kpostID "${FOREIGN.kpostID}", an identifier the caller does not own — the value reached the record lookup instead of being scoped to the token. Status ${response.status()}, body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[parity] HTTP status must agree with the envelope statusCode', async ({
    genericClient,
    staticToken,
  }) => {
    // Fired with an empty/unknown payload so the endpoint takes its *error* path — the branch
    // where this API most often answers HTTP 200 over an envelope reporting 500.
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await assertStatusCodeParity(response, META);
  });


  test('[contract] the response must satisfy the platform envelope', async ({
    genericClient,
    staticToken,
  }) => {
    /*
     * Validates the *documented* envelope, which is the point: several tags on this API do not
     * emit it, and a client generated from the spec cannot parse those responses. The wide
     * status list keeps this a contract assertion rather than a second status check — whatever
     * the endpoint answers, the shape it answers with is what is under test here.
     */
    const response = await genericClient.send('POST', META.path, {}, { token: staticToken });

    await expectValidContract(response, dataEnvelopeSchema, META, [
      200, 201, 204, 400, 401, 403, 404, 405, 415, 422, 500,
    ]);
  });

});
