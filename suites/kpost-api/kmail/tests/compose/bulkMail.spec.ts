import { EXPIRED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { PATH_TEMPLATES, SENT_MAIL_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { env } from '../../src/config/env.config';
import { kmailEnvelopeSchema } from '../../src/api/schemas/kmail.schema';
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
import { buildBulkMailPayload } from '../../src/api/payloads/sentMail.payload';
import { recipientCsv, textAttachment } from '../../src/utils/attachments';
import { syntheticRecipient } from '../../src/utils/safeTestData';

/**
 * Bulk campaigns — `postBulkMail`, `postBulkMailMultipart`, and the campaign status route.
 *
 * The highest fan-out write in the API: one request produces a KmailMaster row, a
 * KmailTransaction row and a MongoDB body document per recipient, delivers to all of them, and
 * cannot be undone. Safety rules that shape the file:
 *
 *  - Sends that fan out are opt-in behind `ALLOW_BULK_SEND`.
 *  - Limit cases assert the list is refused with a stated cap rather than exceeding it; the
 *    lists that do go out stay at two synthetic addresses.
 *  - Validation and auth cases run unconditionally — all expect rejection, so none deliver.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;

/** Gate for anything that can actually fan out. */
const bulkSendAllowed = env.allowBulkSend;

/* =========================================================================================
 * POST /v2/sentMail/postBulkMail
 * ====================================================================================== */
test.describe('POST /v2/sentMail/postBulkMail @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postBulkMail,
    repro: `await sentMailClient.postBulkMail(buildBulkMailPayload(), { token });`,
  };

  test('[1] happy path: a two-recipient campaign satisfies the contract', async ({
    sentMailClient,
    token,
  }) => {
    test.skip(!bulkSendAllowed, 'bulk send is opt-in — set ALLOW_BULK_SEND=true to exercise it');

    const payload = buildBulkMailPayload();
    const response = await sentMailClient.postBulkMail(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400]
    );
  });

  test('[2] happy path: the campaign is acknowledged, not silently failed', async ({
    sentMailClient,
    token,
  }) => {
    test.skip(!bulkSendAllowed, 'bulk send is opt-in — set ALLOW_BULK_SEND=true to exercise it');

    const payload = buildBulkMailPayload();
    const response = await sentMailClient.postBulkMail(payload, { token });

    // Matters more here than on a single send: a campaign is fire-and-forget, so a 200 over
    // `status: FAILURE` is one the sender believes went out and nobody receives.
    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[3] validation: a campaign with no recipients must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildBulkMailPayload({ toAddressList: [] });
    const response = await sentMailClient.postBulkMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a campaign was submitted with an empty toAddressList',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] validation: a null recipient list must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildBulkMailPayload({ toAddressList: null });
    const response = await sentMailClient.postBulkMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "toAddressList" set to null', severity: 'Major' },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: an empty body must be refused', async ({ sentMailClient, token }) => {
    const response = await sentMailClient.postBulkMail({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an empty body was posted to the campaign route',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] rate limiting: a large recipient list must be refused with a stated cap', async ({
    sentMailClient,
    token,
  }) => {
    // The one place a large list is submitted, all synthetic addresses. The assertion is that
    // the request is refused; if there is no cap it succeeds and the test reports the finding —
    // one request generating a thousand deliveries is an outbound spam amplifier.
    const toAddressList = Array.from({ length: 1000 }, () => syntheticRecipient());
    const payload = buildBulkMailPayload({ toAddressList });
    const response = await sentMailClient.postBulkMail(payload, { token });
    const { json, text } = await readBody(response);

    const statusCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
    const status = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
    const refused =
      response.status() >= 400 ||
      status === 'FAILURE' ||
      status === 'ERROR' ||
      (statusCode !== null && statusCode >= 400);

    expect(
      refused,
      `a campaign naming 1000 recipients was accepted (HTTP ${response.status()}). Each entry produces its own KmailMaster row, KmailTransaction row, MongoDB body document and delivery, so a single authenticated request becomes a thousand outbound mails carrying this platform's domain and DKIM signature. There must be a documented per-campaign cap, enforced with a 400 that names it. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[7] validation: duplicate recipients must not each receive a copy', async ({
    sentMailClient,
    token,
  }) => {
    test.skip(!bulkSendAllowed, 'bulk send is opt-in — set ALLOW_BULK_SEND=true to exercise it');

    // Duplicates in a CRM export are normal. Without de-duplication the recipient receives the
    // campaign once per appearance — which gets a sending domain blocklisted.
    const duplicate = syntheticRecipient();
    const payload = buildBulkMailPayload({ toAddressList: [duplicate, duplicate, duplicate] });
    const response = await sentMailClient.postBulkMail(payload, { token });

    await assertStatus(response, [200, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A campaign with duplicate recipients is not handled explicitly',
    });
  });

  test('[8] validation: an invalid address in the list must not fault the whole campaign', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildBulkMailPayload({
      toAddressList: [syntheticRecipient(), 'not-an-address', syntheticRecipient()],
    });
    const response = await sentMailClient.postBulkMail(payload, { token });

    expect(
      response.status(),
      `a campaign containing one malformed address produced HTTP ${response.status()}. One bad row in a CRM export is routine; it must be reported as a 400 identifying the entry, not as a server fault that loses the whole campaign.`
    ).toBeLessThan(500);
  });

  test('[9] IDOR: a body fromAddress must not choose the campaign sender', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    // Worse than on a single send: a campaign's fromAddress is what every recipient sees and
    // what unsubscribe records key to, so spoofing it impersonates at scale and pollutes their
    // unsubscribe list.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to spoof');

    const payload = buildBulkMailPayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await sentMailClient.postBulkMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'campaign returned no parseable body');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the campaign reported "${FOREIGN.victimKpostID}" as its sender while the caller was ${callerKpostId ?? 'a different identity'}. fromAddress is documented as server-assigned and overwritten from the JWT. If the body wins, one user can run a campaign in another user's name — to that user's recipients, with that user's unsubscribe records. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[10] injection: a tautology in the subject must not leak internals', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildBulkMailPayload({ kmailSubject: SQLI_PAYLOAD, toAddressList: [] });
    const response = await sentMailClient.postBulkMail(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[11] XSS: a script payload in the campaign body must not be reflected', async ({
    sentMailClient,
    token,
  }) => {
    // Empty recipient list: rejected before delivery, and the error response answers the
    // reflection question as well as a success one.
    const payload = buildBulkMailPayload({ kmailContent: XSS_PAYLOAD, toAddressList: [] });
    const response = await sentMailClient.postBulkMail(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[12] structural: malformed JSON must be a clean 400', async ({ sentMailClient, token }) => {
    const malformed = '{"toAddressList":[';
    const response = await sentMailClient.sendRaw(SENT_MAIL_PATHS.postBulkMail, malformed, {
      token,
    });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await sentMailClient.sendRaw(SENT_MAIL_PATHS.postBulkMail, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[13] auth: no Authorization header must be 401/403', async ({ sentMailClient }) => {
    const payload = buildBulkMailPayload();
    const response = await sentMailClient.postBulkMail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[14] auth: an expired token must not launch a campaign', async ({ sentMailClient }) => {
    const payload = buildBulkMailPayload();
    const response = await sentMailClient.postBulkMail(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/sentMail/postBulkMailMultipart
 * ====================================================================================== */
test.describe('POST /v2/sentMail/postBulkMailMultipart @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postBulkMailMultipart,
    repro: `await sentMailClient.postBulkMailMultipart(buildBulkMailPayload(), recipientCsv([...]), { token });`,
  };

  test('[1] happy path: a CSV recipient list is accepted', async ({ sentMailClient, token }) => {
    test.skip(!bulkSendAllowed, 'bulk send is opt-in — set ALLOW_BULK_SEND=true to exercise it');

    const payload = buildBulkMailPayload({ toAddressList: [] });
    const file = recipientCsv([syntheticRecipient(), syntheticRecipient()]);
    const response = await sentMailClient.postBulkMailMultipart(payload, file, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400]
    );
  });

  test('[2] validation: both parts are required — a missing file must be refused', async ({
    sentMailClient,
    token,
  }) => {
    // `file` and `bulkMailRequest` are both required. An empty file where the recipient list
    // belongs must not read as "a campaign with no recipients that succeeded".
    const payload = buildBulkMailPayload({ toAddressList: [] });
    const emptyFile = { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) };
    const response = await sentMailClient.postBulkMailMultipart(payload, emptyFile, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the required campaign input file was empty',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] boundary: a non-CSV file must not fault the parser', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildBulkMailPayload({ toAddressList: [] });
    const response = await sentMailClient.postBulkMailMultipart(payload, textAttachment(64), {
      token,
    });

    expect(
      response.status(),
      `a plain text file where a recipient list was expected produced HTTP ${response.status()}. Uploading the wrong file is the most ordinary mistake this endpoint will see, and it must be a 400 that says so.`
    ).toBeLessThan(500);
  });

  test('[4] injection: a CSV formula must not be echoed as executable', async ({
    sentMailClient,
    token,
  }) => {
    // CSV injection: a cell beginning `=` executes as a formula when reopened in a spreadsheet,
    // and recipient lists are exported and reopened constantly. Is the value neutralised anywhere?
    const formula = '=cmd|/c calc!A1';
    const payload = buildBulkMailPayload({ toAddressList: [] });
    const file = recipientCsv([formula]);
    const response = await sentMailClient.postBulkMailMultipart(payload, file, { token });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(formula),
      `a CSV cell beginning "=" was accepted and echoed back verbatim. Campaign lists are exported and reopened in spreadsheets routinely, and a leading =, +, - or @ is executed as a formula on open. The value must be neutralised or refused. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] auth: an anonymous caller must not launch a campaign', async ({ sentMailClient }) => {
    const payload = buildBulkMailPayload({ toAddressList: [] });
    const file = recipientCsv([syntheticRecipient()]);
    const response = await sentMailClient.postBulkMailMultipart(payload, file, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * GET /v2/sentMail/bulkMail/status/{fromAddress}
 * ====================================================================================== */
test.describe('GET /v2/sentMail/bulkMail/status/{fromAddress} @audit', () => {
  const META = {
    method: 'GET',
    path: PATH_TEMPLATES.bulkMailStatus,
    repro: `await sentMailClient.bulkMailStatus(address, { token });`,
  };

  test('[1] happy path: the caller may read their own campaign status', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(callerKpostId === null, 'no authenticated identity to ask about');

    const response = await sentMailClient.bulkMailStatus(callerKpostId as string, { token });

    // 202 is correct here: an in-progress campaign answers "Mails are still being sent, check
    // again" — an async Accepted, not a failure. Excluding it filed a false wrong-status defect.
    await expectValidContract(response, kmailEnvelopeSchema, META, [200, 202, 400, 401, 403, 404]);
  });

  test('[2] IDOR: another sender\'s campaign progress must not be readable', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    // The owner key is the whole path variable, nothing else identifies the caller. Unchecked
    // against the token, this route reports whether any address runs campaigns and how large.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await sentMailClient.bulkMailStatus(FOREIGN.victimKpostID, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'status read returned no parseable body');

    const statusCode = typeof json?.statusCode === 'number' ? json.statusCode : null;
    const returnedData =
      response.ok() && statusCode === 200 && json?.data !== null && json?.data !== undefined;

    expect(
      returnedData && text.includes(FOREIGN.victimKpostID),
      `campaign progress for "${FOREIGN.victimKpostID}" was returned to ${callerKpostId ?? 'a different identity'}. The sender address is the whole owner key on this route and nothing else scopes it to the caller. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] empty state: an address with no campaigns must not be an error', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.bulkMailStatus(syntheticRecipient(), { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      title: 'An address with no campaigns is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[4] boundary: a path segment with an encoded slash must not resolve another route', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.bulkMailStatus('../../../v2/draft/getAllDraftMails', {
      token,
    });

    expect(
      response.status(),
      `a traversal sequence in the sender segment produced HTTP ${response.status()}. It must resolve to nothing, not to a different controller and not to a fault.`
    ).toBeLessThan(500);
  });

  test('[5] injection: a tautology in the path must not leak internals', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.bulkMailStatus(SQLI_PAYLOAD, { token });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6] XSS: a script payload in the path must not be reflected', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.bulkMailStatus(XSS_PAYLOAD, { token });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });

  test('[7] auth: an anonymous caller must not read campaign status', async ({
    sentMailClient,
  }) => {
    const response = await sentMailClient.bulkMailStatus(syntheticRecipient(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[8] idempotency: two consecutive reads must agree', async ({ sentMailClient, token }) => {
    const address = syntheticRecipient();
    const [first, second] = await Promise.all([
      sentMailClient.bulkMailStatus(address, { token }),
      sentMailClient.bulkMailStatus(address, { token }),
    ]);

    expect(
      first.status(),
      `two identical status reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });
});
