import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { LEGACY_PATHS, SENT_MAIL_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import {
  kmailEnvelopeSchema,
  mailCredentialsResponseSchema,
} from '../../src/api/schemas/kmail.schema';
import {
  assertNoForeignAcknowledgement,
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
  KMAIL_TYPE,
  buildComposePayload,
  buildComposeWithAttachmentUuids,
  buildDatedComposePayload,
  buildExternalComposePayload,
  buildForwardPayload,
  buildGroupComposePayload,
  buildMailCredentialsPayload,
  buildReplyPayload,
} from '../../src/api/payloads/sentMail.payload';
import { pdfAttachment, textAttachment } from '../../src/utils/attachments';
import {
  nonExistentKmailId,
  nonExistentUuid,
  syntheticRecipient,
} from '../../src/utils/safeTestData';

/**
 * Compose and send — `/v2/sentMail/**`.
 *
 * Every test here can put mail in a mailbox: recipients come only from `syntheticRecipient()`
 * (unguessable non-existent addresses), never a real account.
 *
 * Recurring theme: sender identity. `fromAddress` is server-assigned — overwritten from the
 * JWT `kpostID` on every send route. If the body can choose it, the API becomes an
 * authenticated mail-spoofing service. Many cases below assert it stays server-assigned.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const SQLI_UNION_PAYLOAD = `' UNION SELECT null,null,null--`;
const HTML_IMG_PAYLOAD = `<img src=x onerror="alert(1)">`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = 'ಕನ್ನಡ-日本語-🚀-Ñoño';

/* =========================================================================================
 * POST /v2/sentMail/postMail
 * ====================================================================================== */
test.describe('POST /v2/sentMail/postMail @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postMail,
    repro: `await sentMailClient.postMail(buildComposePayload(), { token });`,
  };

  test('[FR-M01][FR-M02][1] happy path: a composed mail satisfies the contract', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMail(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400]
    );
  });

  test('[2] happy path: the send is acknowledged, not silently failed', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMail(payload, { token });

    // Checked via the envelope, not transport status: this API answers HTTP 200 over
    // `status: FAILURE` routinely, so a 200 with a failure body is mail the user thinks was sent.
    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[3] happy path: the server assigns a kmailID', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload({ kmailID: 0 });
    const response = await sentMailClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed on this environment');

    const assigned = JSON.stringify(json?.data ?? json);
    expect(
      /"kmailID"\s*:\s*(?!0\b)\d+/.test(assigned) || /\d{2,}/.test(assigned),
      `the send reported success but returned no assigned identifier. The compose contract is that kmailID 0 means "the server assigns it and returns it" — without that value the client cannot thread a reply, attach a follow-up, or clear the draft the mail came from. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[4] IDOR: a body fromAddress must not choose the sender', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to spoof');

    const payload = buildComposePayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await sentMailClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'send returned no parseable body');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the response reported the mail as sent from "${FOREIGN.victimKpostID}" while the caller was ${callerKpostId ?? 'a different identity'}. fromAddress is documented as overwritten from the bearer token on every send route, precisely so the body cannot choose the sender. If the body wins, this endpoint sends mail AS another user — with the platform's own domain, DKIM and recipient trust behind it. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[5] IDOR: a foreign originalKmailID must not be quoted into a reply', async ({
    sentMailClient,
    token,
  }) => {
    // A reply embeds the original sender/subject/date. If `originalKmailID` is resolved without
    // checking the caller received that mail, a reply to any id becomes a read of another inbox.
    const payload = buildReplyPayload(FOREIGN.kmailID);
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'originalKmailID',
      repro: `await sentMailClient.postMail(buildReplyPayload(${FOREIGN.kmailID}), { token });`,
    });
  });

  test('[6] IDOR: a foreign attachmentUuid must not be attached', async ({
    sentMailClient,
    token,
  }) => {
    // `attachmentUuid` references an object in S3. If it is attached without an uploader check,
    // a caller who sees a UUID in any listing can re-attach that file and mail it to themselves.
    const payload = buildComposeWithAttachmentUuids([FOREIGN.uuid]);
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.uuid,
      what: 'attachmentUuid',
      repro: `await sentMailClient.postMail(buildComposeWithAttachmentUuids(['${FOREIGN.uuid}']), { token });`,
    });
  });

  test('[7] validation: a mail with no recipient must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload();
    delete (payload as Record<string, unknown>).toAddress;
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a mail was composed with no recipient',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[8] validation: a null recipient must be refused', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload({ toAddress: null });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "toAddress" set to null', severity: 'Major' },
      [400, 401, 403, 422]
    );
  });

  test('[9] validation: a syntactically invalid recipient must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ toAddress: 'not-an-address-at-all' });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'the recipient is not a valid address in any form',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[10] validation: an empty body must be refused', async ({ sentMailClient, token }) => {
    const response = await sentMailClient.postMail({}, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'an empty body was posted to the send route', severity: 'Major' },
      [400, 401, 403, 422]
    );
  });

  test('[11] structural: malformed JSON must be a clean 400 with no stack trace', async ({
    sentMailClient,
    token,
  }) => {
    const malformed = '{"kmailSubject":';
    const response = await sentMailClient.sendRaw(SENT_MAIL_PATHS.postMail, malformed, { token });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await sentMailClient.sendRaw(SENT_MAIL_PATHS.postMail, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });

    // The same response, checked for what it disclosed. Spring's default error body carries a
    // full `trace` field, which turns every parse failure into a stack-trace disclosure.
    await assertNoInternalLeak(response, { ...META, body: malformed }, malformed);
  });

  test('[12] structural: an unknown field must not leak a stack trace', async ({
    sentMailClient,
    token,
  }) => {
    // These DTOs reject unknown properties with a Jackson 400 — defensible. Answering with the
    // exception class, entity name and stack trace is not: it maps the internals to any caller.
    const payload = buildComposePayload({ notAFieldOnThisEntity: 'probe' });
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, 'notAFieldOnThisEntity');
  });

  test('[13] injection: a SQL tautology in the subject must not leak internals', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: SQLI_PAYLOAD });
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[14] injection: a UNION probe in the recipient must not leak internals', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ toAddress: SQLI_UNION_PAYLOAD });
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_UNION_PAYLOAD);
  });

  test('[15] XSS: a script payload in the subject must not be reflected unescaped', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: XSS_PAYLOAD });
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[16] header injection: CRLF in the subject must not split the message', async ({
    sentMailClient,
    token,
  }) => {
    // Classic mail-injection: a CRLF then `Bcc:` in the subject adds a recipient the sender
    // never chose, relayed with the platform's reputation.
    const injected = 'QA subject\r\nBcc: attacker@example.com\r\nX-Injected: yes';
    const payload = buildComposePayload({ kmailSubject: injected });
    const response = await sentMailClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'send returned no parseable body');

    expect(
      text.includes('attacker@example.com'),
      `a CRLF sequence in kmailSubject was echoed back with the injected "Bcc:" header intact. If this value reaches the outbound message headers, any sender can add invisible recipients to their own mail — the platform relays it, with its domain and DKIM signature behind it. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[17] boundary: a 5000-character subject must not fault the server', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: MAX_LENGTH_STRING });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `a 5000-character subject produced HTTP ${response.status()}. Either it is refused with a 400 naming the limit, or it is truncated and stored — a 5xx means the column length was discovered by the database rather than by the validator.`
    ).toBeLessThan(500);
  });

  test('[18] boundary: a multi-byte UTF-8 subject must survive', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: UTF8_STRING });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `a multi-byte UTF-8 subject produced HTTP ${response.status()}. A mail platform that cannot carry Kannada, Japanese or an emoji in a subject line is broken for most of its users.`
    ).toBeLessThan(500);
  });

  test('[19] boundary: an oversized body must be bounded, not fatal', async ({
    sentMailClient,
    token,
  }) => {
    // 1 MB of HTML — within normal compose range, and where an unbounded MongoDB write matters.
    const payload = buildComposePayload({ kmailContent: `<p>${'x'.repeat(1_000_000)}</p>` });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `a 1 MB mail body produced HTTP ${response.status()}. It must be accepted or refused with a stated limit; a 5xx means the bound is enforced by whatever runs out of memory first.`
    ).toBeLessThan(500);
  });

  test('[20] boundary: a large ccList must be bounded', async ({ sentMailClient, token }) => {
    // Each cc is its own KmailTransaction row and delivery. An unbounded list makes one request
    // a fan-out limited only by body size — a spam amplifier.
    const ccList = Array.from({ length: 200 }, () => syntheticRecipient());
    const payload = buildComposePayload({ ccList });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `a 200-recipient ccList produced HTTP ${response.status()}. Each entry is a separate delivery, so an unbounded cc list makes one request a fan-out primitive. It must be refused with a stated cap rather than faulting.`
    ).toBeLessThan(500);
  });

  test('[21] type mismatch: a string where kmailType expects an integer', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailType: 'normal' });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `kmailType was sent as a string where the contract declares an integer, producing HTTP ${response.status()}. A type mismatch is a 400, not a 500.`
    ).toBeLessThan(500);
  });

  test('[22] type mismatch: a bare string where ccList expects an array', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ ccList: syntheticRecipient() });
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `ccList was sent as a bare string where the contract declares an array, producing HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[23] business rule: an unknown kmailType must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailType: 9999 });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailType 9999 is not one of the documented mail semantics',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[24] business rule: a send date far in the past must not be honoured', async ({
    sentMailClient,
    token,
  }) => {
    // kmailSendDate is normally server-assigned. If a client-supplied date is honoured, a sender
    // can place mail anywhere in the recipient's timeline — at the top or buried below.
    const payload = buildDatedComposePayload(-60 * 24 * 365 * 5);
    const response = await sentMailClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'send did not succeed on this environment');

    expect(
      text.includes('2021-') || text.includes('2020-'),
      `a send date five years in the past was echoed back on a mail sent now. kmailSendDate is documented as server-assigned; if the body's value is stored, a sender chooses where their mail lands in the recipient's inbox ordering. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[25] auth: no Authorization header must be 401/403', async ({ sentMailClient }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[26] auth: an expired token must not send mail', async ({ sentMailClient }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMail(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[27] auth: a malformed token must not send mail', async ({ sentMailClient }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMail(payload, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/sentMail/postMailMultiPart/
 *
 * Excel row 20 marks this route YELLOW — superseded, not in use by the client. Coverage is
 * kept anyway, and deliberately: the route is still MAPPED and still accepts authenticated
 * writes, so its auth, IDOR and injection surface is live whether or not a client calls it. A
 * deprecated-but-reachable write is the kind of route a `/v2/**` prefix filter and a security
 * review both miss. Do not extend this describe with functional/contract depth — the Excel
 * says nobody is calling it — but do not delete the security cases either.
 * ====================================================================================== */
test.describe('POST /v2/sentMail/postMailMultiPart/ @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postMailMultiPart,
    repro: `await sentMailClient.postMailMultiPart(JSON.stringify(buildComposePayload()), [textAttachment()], { token });`,
  };

  test('[FR-M03][1] happy path: a mail with one attachment satisfies the contract', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400]
    );
  });

  test('[2] happy path: several attachments in one send', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment(), pdfAttachment()],
      { token }
    );

    await assertStatus(response, [200, 400, 401, 403], { ...META, body: payload });
  });

  test('[3] boundary: an empty first part means "no attachments"', async ({
    sentMailClient,
    token,
  }) => {
    // Documented: an empty first part (size 0) means "no attachments" and skips the S3 upload.
    // This is the branch every attachment-less send takes, so a regression breaks ordinary sending.
    const payload = buildComposePayload();
    const response = await sentMailClient.postMailMultiPart(JSON.stringify(payload), [], { token });

    await assertStatus(response, [200, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A zero-length first part is not treated as "no attachments"',
    });
  });

  test('[4] validation: a missing text parameter must be refused', async ({
    sentMailClient,
    token,
  }) => {
    // `text` is required and carries the whole compose DTO; without it this must be a 400, not a
    // 500 from a null DTO.
    const response = await sentMailClient.postMailMultiPart('', [textAttachment()], { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: '<empty text parameter>',
        scenario: 'the required "text" parameter carrying the compose DTO was empty',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a malformed text parameter must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.postMailMultiPart('{not json', [textAttachment()], {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: '{not json',
        scenario: 'the "text" parameter was not parseable JSON',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] auth: an anonymous caller must not upload or send', async ({ sentMailClient }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token: null }
    );

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[7] IDOR: a body fromAddress must not choose the sender on the multipart path', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    // Separate from the JSON route: the multipart path deserialises its DTO from a query
    // parameter, a different code path where sender-assignment can be forgotten.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to spoof');

    const payload = buildComposePayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );
    const { json, text } = await readBody(response);

    test.skip(json === null, 'send returned no parseable body');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the multipart send route reported the mail as sent from "${FOREIGN.victimKpostID}" while the caller was ${callerKpostId ?? 'a different identity'}. This route deserialises its DTO from the "text" query parameter rather than from the body, so it is a separate code path from postMail and needs the same sender assignment. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[8] injection: a SQL payload in the query-param DTO must not reach the database', async ({
    sentMailClient,
    token,
  }) => {
    // The DTO is parsed from the "text" QUERY PARAMETER here — a separate parse path from postMail,
    // so postMail's injection coverage does not transfer. A stack trace or SQL error confirms the
    // input reached the engine.
    const payload = buildComposePayload({ kmailSubject: SQLI_PAYLOAD });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] injection: a script payload must not be reflected unescaped', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: XSS_PAYLOAD });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] contract: a success transport status must match the envelope statusCode', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );

    await assertStatusCodeParity(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /sentMail/postMailMultiPart/  — the unversioned duplicate
 * ====================================================================================== */
test.describe('POST /sentMail/postMailMultiPart/ (legacy path) @audit', () => {
  const META = {
    method: 'POST',
    path: LEGACY_PATHS.postMailMultiPart,
    repro: `await sentMailClient.legacyPostMailMultiPart(JSON.stringify(buildComposePayload()), [textAttachment()], { token });`,
  };

  test('[1] the legacy path must enforce authentication', async ({ sentMailClient }) => {
    // Why this route is in the suite: an unversioned duplicate of an authenticated write, still
    // mapped, is what a path-prefix filter (`/v2/**`) misses and a security review overlooks.
    const payload = buildComposePayload();
    const response = await sentMailClient.legacyPostMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token: null }
    );

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[2] the legacy path must not be more permissive than its /v2 twin', async ({
    sentMailClient,
  }) => {
    const payload = buildComposePayload();
    const [legacy, versioned] = await Promise.all([
      sentMailClient.legacyPostMailMultiPart(JSON.stringify(payload), [textAttachment()], {
        token: null,
      }),
      sentMailClient.postMailMultiPart(JSON.stringify(payload), [textAttachment()], {
        token: null,
      }),
    ]);

    expect(
      legacy.status(),
      `the unversioned /sentMail/postMailMultiPart/ answered HTTP ${legacy.status()} to an anonymous caller while its /v2 twin answered ${versioned.status()}. Two mappings for the same operation must enforce the same rules; a difference means the authentication filter is scoped by path and the older path is outside it.`
    ).toBe(versioned.status());
  });

  test('[3] an authenticated legacy send behaves as the /v2 route does', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.legacyPostMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token }
    );

    await assertStatus(response, [200, 400, 401, 403, 404], { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/sentMail/loadMail
 * ====================================================================================== */
test.describe('POST /v2/sentMail/loadMail @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.loadMail,
    repro: `await sentMailClient.loadMail(buildComposePayload(), { token });`,
  };

  test('[1] happy path: the compose payload round-trips', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.loadMail(payload, { token });

    await expectValidContract(response, kmailEnvelopeSchema, { ...META, body: payload }, [200, 400]);
  });

  test('[2] the echo must not become a reflection sink', async ({ sentMailClient, token }) => {
    // An echo route is a reflection surface. It stores nothing, but anything that renders the
    // response executes it — so it is asserted, not waved through as "just a diagnostic".
    const payload = buildComposePayload({ kmailContent: HTML_IMG_PAYLOAD });
    const response = await sentMailClient.loadMail(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, HTML_IMG_PAYLOAD);
  });

  test('[3] a diagnostic route must still require a token', async ({ sentMailClient }) => {
    const payload = buildComposePayload();
    const response = await sentMailClient.loadMail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[4] an empty body must not fault', async ({ sentMailClient, token }) => {
    const response = await sentMailClient.loadMail({}, { token });

    expect(
      response.status(),
      `an empty body to the echo route produced HTTP ${response.status()}. It writes nothing and reads nothing, so there is no path here that should reach a 5xx.`
    ).toBeLessThan(500);
  });
});

/* =========================================================================================
 * POST /v2/sentMail/getMailCredentials
 * ====================================================================================== */
test.describe('POST /v2/sentMail/getMailCredentials @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.getMailCredentials,
    repro: `await sentMailClient.getMailCredentials(buildMailCredentialsPayload(kpostID), { token });`,
  };

  test('[1] happy path: the caller may resolve their own credentials', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(callerKpostId === null, 'no authenticated identity to ask about');

    const payload = buildMailCredentialsPayload(callerKpostId as string);
    const response = await sentMailClient.getMailCredentials(payload, { token });

    await expectValidContract(
      response,
      mailCredentialsResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] IDOR: a foreign kpostID must not resolve another account\'s credentials', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    // The most dangerous request in this API. Every other endpoint derives the account from the
    // JWT; this one reads `kpostID` from the body. If that is honoured, one user obtains
    // another's mail-server credentials — mailbox takeover outside the platform, no further
    // KMail access needed.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildMailCredentialsPayload(FOREIGN.victimKpostID);
    const response = await sentMailClient.getMailCredentials(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'credential resolution returned no parseable body');

    const returnedCredential = /"(password|token|mailServerPassword)"\s*:\s*"[^"]{3,}"/i.test(text);

    expect(
      returnedCredential && text.includes(FOREIGN.victimKpostID),
      `asking for "${FOREIGN.victimKpostID}"'s mail-server credentials, while authenticated as ${callerKpostId ?? 'a different identity'}, returned a credential field. This route reads the account from the request body rather than from the bearer token, so any authenticated user can name any other account. The result is direct access to that user's mailbox on the mail server — outside this API, and unaffected by revoking their KMail session. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] validation: a request with no kpostID must be refused', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.getMailCredentials({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a credential lookup with no account named',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] enumeration: a wildcard kpostID must not resolve anything', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildMailCredentialsPayload('%');
    const response = await sentMailClient.getMailCredentials(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, '%');
  });

  test('[5] injection: a tautology in kpostID must not leak internals', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildMailCredentialsPayload(SQLI_PAYLOAD);
    const response = await sentMailClient.getMailCredentials(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[6] auth: an anonymous caller must never resolve credentials', async ({
    sentMailClient,
  }) => {
    const payload = buildMailCredentialsPayload('anyone@kpostindia.com');
    const response = await sentMailClient.getMailCredentials(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[7] a credential response must not be cacheable', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(callerKpostId === null, 'no authenticated identity to ask about');

    const payload = buildMailCredentialsPayload(callerKpostId as string);
    const response = await sentMailClient.getMailCredentials(payload, { token });

    test.skip(!response.ok(), 'credential resolution did not succeed on this environment');

    const cacheControl = response.headers()['cache-control'] ?? '';
    expect(
      /no-store|no-cache|private/i.test(cacheControl),
      `the credential response carries Cache-Control "${cacheControl || '<absent>'}". A response containing mail-server credentials must be marked no-store, or every proxy and browser cache between the service and the client becomes a place those credentials live at rest.`
    ).toBe(true);
  });
});

/* =========================================================================================
 * GET /v2/sentMail/loadOtherDomainMails
 * ====================================================================================== */
test.describe('GET /v2/sentMail/loadOtherDomainMails @audit', () => {
  const META = {
    method: 'GET',
    path: SENT_MAIL_PATHS.loadOtherDomainMails,
    repro: `await sentMailClient.loadOtherDomainMails({ token });`,
  };

  test('[1] happy path: the poll satisfies the contract', async ({ sentMailClient, token }) => {
    const response = await sentMailClient.loadOtherDomainMails({ token });

    await expectValidContract(response, kmailEnvelopeSchema, META, [200, 400, 401, 403]);
  });

  test('[2] auth: an anonymous caller must not trigger an ingest', async ({ sentMailClient }) => {
    const response = await sentMailClient.loadOtherDomainMails({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[3] IDOR: a kpostID query parameter must not re-scope the ingest', async ({
    sentMailClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await sentMailClient.loadOtherDomainMails({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });
    const { text } = await readBody(response);

    expect(
      response.ok() && text.includes(FOREIGN.victimKpostID),
      `passing ?kpostID=${FOREIGN.victimKpostID} to the external-mail ingest was acknowledged, while the caller was ${callerKpostId ?? 'a different identity'}. This route pulls mail from an upstream server into a mailbox; if the target mailbox can be named in the query string, a caller can trigger an ingest into somebody else's account. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] the poll must be idempotent across two immediate calls', async ({
    sentMailClient,
    token,
  }) => {
    // This route ingests: if two back-to-back polls disagree, the same upstream message may be
    // imported twice, surfacing as duplicated mail.
    const [first, second] = await Promise.all([
      sentMailClient.loadOtherDomainMails({ token }),
      sentMailClient.loadOtherDomainMails({ token }),
    ]);

    expect(
      first.status(),
      `two immediate polls of the external-mail ingest returned ${first.status()} and ${second.status()}. An ingest that behaves differently when called twice will import the same upstream message more than once.`
    ).toBe(second.status());
  });

  test('[5] an unknown query parameter must be ignored, not fatal', async ({
    sentMailClient,
    token,
  }) => {
    const response = await sentMailClient.loadOtherDomainMails({
      token,
      params: { unexpectedParameter: 'value' },
    });

    expect(
      response.status(),
      `an unrecognised query parameter produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });
});

/* =========================================================================================
 * Forward and reply semantics
 * ====================================================================================== */
test.describe('Forward and reply disclosure @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postMail,
    repro: `await sentMailClient.postMail(buildForwardPayload(kmailID), { token });`,
  };

  test('[1] a forward with revealSource false must not disclose the original sender', async ({
    sentMailClient,
    token,
  }) => {
    // `forwardRevealDetails` applies "when isRevealSource is true". With it false, the original
    // fromAddress/ccList/send date must not travel — otherwise a forward discloses a third
    // party's correspondence to a new recipient who was never part of it.
    const payload = buildForwardPayload(nonExistentKmailId(), {
      revealSource: false,
      forwardRevealDetails: {
        fromAddress: 'original-sender@example.com',
        toAddress: 'original-recipient@example.com',
        ccList: ['original-cc@example.com'],
        sendDate: '',
      },
    });
    const response = await sentMailClient.postMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'forward did not succeed on this environment');

    expect(
      text.includes('original-cc@example.com'),
      `a forward sent with revealSource false echoed the original ccList back. The flag exists to control exactly this disclosure; if the reveal details travel regardless, forwarding a mail hands the new recipient the original thread's participants. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[2] a reply must not accept a mismatched kmailType and originalKmailID', async ({
    sentMailClient,
    token,
  }) => {
    // kmailType 1 says "reply"; originalKmailID 0 says "to nothing". Accepting both produces a
    // reply referencing no parent — an orphan in every thread view.
    const payload = buildComposePayload({
      kmailType: KMAIL_TYPE.reply,
      originalKmailID: 0,
    });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a reply was composed with no original mail to reply to',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] a forward to no recipients must be refused', async ({ sentMailClient, token }) => {
    const payload = buildForwardPayload(nonExistentKmailId(), { forwardList: [] });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a forward was composed with an empty forwardList',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });
});

/* =========================================================================================
 * Group and external sends
 * ====================================================================================== */
test.describe('Group and external recipients @audit', () => {
  const META = {
    method: 'POST',
    path: SENT_MAIL_PATHS.postMail,
    repro: `await sentMailClient.postMail(buildGroupComposePayload(), { token });`,
  };

  test('[1] a group send expands membership without faulting', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildGroupComposePayload();
    const response = await sentMailClient.postMail(payload, { token });

    await assertStatus(response, [200, 400, 401, 403], { ...META, body: payload });
  });

  test('[2] IDOR: a group the caller does not belong to must not be addressable', async ({
    sentMailClient,
    token,
  }) => {
    // With groupFlag true, toAddress names a group expanded into one transaction per member. If
    // membership is not checked against the caller, naming any group mails all its members.
    const payload = buildGroupComposePayload({ toAddress: String(FOREIGN.kmailID) });
    const response = await sentMailClient.postMail(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'group identifier',
    });
  });

  test('[3] selectedMembers "Y" with an empty member list must be refused', async ({
    sentMailClient,
    token,
  }) => {
    // "Y" means "only these members receive it". An empty list makes that meaningless, and a
    // fan-out implementation rarely takes the safe reading (send to nobody).
    const payload = buildGroupComposePayload({
      selectedMembers: 'Y',
      groupReceiverList: [],
    });
    const response = await sentMailClient.postMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'selectedMembers is "Y" but groupReceiverList is empty',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[FR-M06][4] an external recipient is accepted and relayed', async ({ sentMailClient, token }) => {
    const payload = buildExternalComposePayload();
    const response = await sentMailClient.postMail(payload, { token });

    await assertStatus(response, [200, 400, 401, 403], { ...META, body: payload });
  });

  test('[5] an attachment UUID that resolves to nothing must not fault', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposeWithAttachmentUuids([nonExistentUuid()]);
    const response = await sentMailClient.postMail(payload, { token });

    expect(
      response.status(),
      `a send referencing an attachment UUID that resolves to nothing produced HTTP ${response.status()}. A stale UUID is an ordinary client state — the draft's attachment expired, or was deleted in another tab — and must be a 400 naming the problem, not a fault.`
    ).toBeLessThan(500);
  });
});
