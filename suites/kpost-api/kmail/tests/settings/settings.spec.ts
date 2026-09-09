import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { SETTING_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { kmailEnvelopeSchema, settingResponseSchema } from '../../src/api/schemas/kmail.schema';
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
  buildFullSignaturePayload,
  buildInstantReplyIdPayload,
  buildInstantReplyPayload,
  buildLetterHeadIdPayload,
  buildMailCountDaysLimitPayload,
  buildSaluationIdPayload,
  buildSaluationPayload,
  buildSignatureCompanyDataPayload,
  buildSignatureGraphicsPayload,
  buildSignaturePersonalDataPayload,
  buildSignatureSocialMediaPayload,
  buildSignatureStylePayload,
  buildSignatureTemplateIdPayload,
} from '../../src/api/payloads/kmailSetting.payload';
import { letterHeadPair, pngAttachment, textAttachment } from '../../src/utils/attachments';
import { qaLabel } from '../../src/utils/safeTestData';

/**
 * KMail settings — signature, letterhead, salutations, instant replies.
 *
 * Everything writes into one row (`UsersKmailSetting`) owned by `kpostID` from the JWT. Key facts:
 *  - Seven endpoints write one signature JSON column: six per-block writes plus
 *    `saveOrUpdateMailSignature` which replaces all blocks; a per-block write must preserve its
 *    siblings (round-trip cases check this).
 *  - Letterhead activation is exclusive: `setLetterHead` deactivates whichever was active.
 *  - Identifier field differs by design: a salutation uses `saluationID`, an instant reply `id`.
 *
 * Per-block signature payloads take their fields flat; `saveOrUpdateMailSignature` nests them
 * under `personalData` / `companyData` / `graphics` / `style` / `socialMedialink`. Assertions
 * are about round-trip behaviour — fails when the service loses data.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* =========================================================================================
 * Mail signature — reads
 * ====================================================================================== */
test.describe('Mail signature reads', () => {
  test('[getMailSignature] happy path satisfies the contract', async ({ settingClient, token }) => {
    const META = {
      method: 'GET',
      path: SETTING_PATHS.getMailSignature,
      repro: `await settingClient.getMailSignature({ token });`,
    };
    const response = await settingClient.getMailSignature({ token });

    await expectValidContract(response, settingResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[getMailSignature] an anonymous caller must be refused', async ({ settingClient }) => {
    // A signature carries name, title, phone and address — personal data. Observed: this route
    // answers HTTP 500 to an anonymous caller rather than 401.
    const response = await settingClient.getMailSignature({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: SETTING_PATHS.getMailSignature,
      repro: `await settingClient.getMailSignature({ token: null });`,
    });
  });

  test('[getMailSignature] IDOR: a kpostID parameter must not read another signature', async ({
    settingClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await settingClient.getMailSignature({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      method: 'GET',
      path: SETTING_PATHS.getMailSignature,
      repro: `await settingClient.getMailSignature({ token, params: { kpostID: '<victim>' } });`,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
    });
  });

  test('[getDigitalSignature] happy path satisfies the contract', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: SETTING_PATHS.getDigitalSignature,
      repro: `await settingClient.getDigitalSignature({ token });`,
    };
    const response = await settingClient.getDigitalSignature({ token });

    await expectValidContract(response, settingResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[getDigitalSignature] the raw settings row must not disclose credentials', async ({
    settingClient,
    token,
  }) => {
    // Returns the whole `UsersKmailSetting` row, not the assembled signature. `kmailPassword` is
    // a real column, so an unfiltered read leaks a mail-server credential.
    const response = await settingClient.getDigitalSignature({ token });
    const { text } = await readBody(response);

    test.skip(!response.ok(), 'the settings read did not succeed on this environment');

    expect(
      /"(password|kmailPassword|mailServerPassword|accessCode|token)"\s*:\s*"[^"]{3,}"/i.test(text),
      `the raw KMail settings record includes a credential field. This route returns the whole UsersKmailSetting row rather than the assembled signature, so any column added to that entity is published by default — a settings read must project the fields it means to expose rather than serialising the entity. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[getDigitalSignature] an anonymous caller must be refused', async ({ settingClient }) => {
    const response = await settingClient.getDigitalSignature({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: SETTING_PATHS.getDigitalSignature,
      repro: `await settingClient.getDigitalSignature({ token: null });`,
    });
  });

  test('[getLetterHeadTemplate] system templates satisfy the contract', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'GET',
      path: SETTING_PATHS.getLetterHeadTemplate,
      repro: `await settingClient.getLetterHeadTemplate({ token });`,
    };
    const response = await settingClient.getLetterHeadTemplate({ token });

    await expectValidContract(response, settingResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[getLetterHeadTemplate] shared reference data must not carry user content', async ({
    settingClient,
    token,
  }) => {
    // System templates are shared reference data. A user's own letterhead appearing here means
    // the shared lookup has become a cross-tenant read.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — cannot identify foreign content');

    const response = await settingClient.getLetterHeadTemplate({ token });
    const { text } = await readBody(response);

    test.skip(!response.ok(), 'the template read did not succeed on this environment');

    expect(
      text.includes(FOREIGN.victimKpostID),
      `the system letterhead template list contains content owned by "${FOREIGN.victimKpostID}". These templates are shared reference data; a user-owned letterhead appearing among them means the shared lookup is reading the per-user column. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });
});

/* =========================================================================================
 * Mail signature — writes
 * ====================================================================================== */
test.describe('Mail signature writes', () => {
  const BLOCKS = [
    {
      name: 'PersonalData',
      path: SETTING_PATHS.saveOrUpdateMailSignaturePersonalData,
      call: 'saveOrUpdateMailSignaturePersonalData' as const,
      build: buildSignaturePersonalDataPayload,
    },
    {
      name: 'CompanyData',
      path: SETTING_PATHS.saveOrUpdateMailSignatureCompanyData,
      call: 'saveOrUpdateMailSignatureCompanyData' as const,
      build: buildSignatureCompanyDataPayload,
    },
    {
      name: 'Graphics',
      path: SETTING_PATHS.saveOrUpdateMailSignatureGraphics,
      call: 'saveOrUpdateMailSignatureGraphics' as const,
      build: buildSignatureGraphicsPayload,
    },
    {
      name: 'Style',
      path: SETTING_PATHS.saveOrUpdateMailSignatureStyle,
      call: 'saveOrUpdateMailSignatureStyle' as const,
      build: buildSignatureStylePayload,
    },
    {
      name: 'SocialMediaLink',
      path: SETTING_PATHS.saveOrUpdateMailSignatureSocialMediaLink,
      call: 'saveOrUpdateMailSignatureSocialMediaLink' as const,
      build: buildSignatureSocialMediaPayload,
    },
  ];

  for (const block of BLOCKS) {
    const META = {
      method: 'POST',
      path: block.path,
      repro: `await settingClient.${block.call}(build...(), { token });`,
    };

    test(`[${block.name}] happy path: the block saves`, async ({ settingClient, token }) => {
      const payload = block.build();
      const response = await settingClient[block.call](payload, { token });

      await expectValidContract(
        response,
        kmailEnvelopeSchema,
        { ...META, body: payload },
        [200, 204, 400, 401, 403]
      );
    });

    test(`[${block.name}] an anonymous caller must not write the block`, async ({
      settingClient,
    }) => {
      const payload = block.build();
      const response = await settingClient[block.call](payload, { token: null });

      await assertUnauthorized(response, { ...META, body: payload });
    });

    test(`[${block.name}] a body kpostID must not write another user's signature`, async ({
      settingClient,
      token,
    }) => {
      test.skip(
        !FOREIGN.hasVictim,
        'QA_VICTIM_KPOST_ID is unset — no real second account to target'
      );

      const payload = block.build({ kpostID: FOREIGN.victimKpostID });
      const response = await settingClient[block.call](payload, { token });

      await assertNoForeignAcknowledgement(response, {
        ...META,
        body: payload,
        foreignValue: FOREIGN.victimKpostID,
        what: 'kpostID on a signature write',
      });
    });

    test(`[${block.name}] an empty body must not fault`, async ({ settingClient, token }) => {
      const response = await settingClient[block.call]({}, { token });

      expect(
        response.status(),
        `an empty body to the ${block.name} signature block produced HTTP ${response.status()}. Clearing a block is a legitimate user action — it must be a save or a 400, never a fault.`
      ).toBeLessThan(500);
    });
  }

  test('[signature] a block write must preserve the other blocks', async ({
    settingClient,
    token,
  }) => {
    // All five blocks live in one `mailSignature` JSON column. A per-block write must merge, not
    // replace — otherwise editing the font silently deletes the company block, all with HTTP 200.
    // Save everything, write one block, read back, look for the others.
    const companyMarker = qaLabel('company-preserve');
    const saveAll = await settingClient.saveOrUpdateMailSignature(
      buildFullSignaturePayload({
        companyData: { companyName: companyMarker, addressLine1: 'QA', website: 'https://example.com' },
      }),
      { token }
    );
    test.skip(!saveAll.ok(), 'the full signature save did not succeed on this environment');

    const beforeRead = await settingClient.getMailSignature({ token });
    const beforeBody = await readBody(beforeRead);
    test.skip(
      !beforeRead.ok() || !beforeBody.text.includes(companyMarker),
      'the saved company block did not read back — cannot test preservation'
    );

    // Now write a single, unrelated block.
    await settingClient.saveOrUpdateMailSignatureStyle(
      buildSignatureStylePayload({ fontStyle: 'Courier, monospace', color: '#101010' }),
      { token }
    );

    const afterRead = await settingClient.getMailSignature({ token });
    const afterBody = await readBody(afterRead);
    test.skip(!afterRead.ok(), 'the signature read did not succeed after the block write');

    expect(
      afterBody.text.includes(companyMarker),
      `writing only the Style block removed the Company block from the signature. All five blocks share one mailSignature JSON column, and a per-block endpoint must merge into it rather than replace it — otherwise changing a font deletes the user's company address, with every call returning 200 and nothing reporting the loss. Body: ${afterBody.text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[signature] the full save round-trips', async ({ settingClient, token }) => {
    const marker = qaLabel('sig-roundtrip');
    const save = await settingClient.saveOrUpdateMailSignature(
      buildFullSignaturePayload({
        personalData: { firstName: marker, designation: 'QA', mobileNumber: '9999999999' },
      }),
      { token }
    );
    test.skip(!save.ok(), 'the full signature save did not succeed on this environment');

    const read = await settingClient.getMailSignature({ token });
    const { text } = await readBody(read);
    test.skip(!read.ok(), 'the signature read did not succeed on this environment');

    expect(
      text.includes(marker),
      `a signature saved with name "${marker}" did not read back carrying it. The save reported success, so the content was either not persisted or is not what getMailSignature assembles from. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[signature] XSS: script content must not be stored and served unescaped', async ({
    settingClient,
    token,
  }) => {
    // A signature is appended to every outgoing mail and rendered in every recipient's client, so
    // stored markup here is delivered — not self-XSS.
    const META = {
      method: 'POST',
      path: SETTING_PATHS.saveOrUpdateMailSignaturePersonalData,
      repro: `await settingClient.saveOrUpdateMailSignaturePersonalData({ firstName: '<script>…' }, { token });`,
    };
    const payload = buildSignaturePersonalDataPayload({
      firstName: XSS_PAYLOAD,
      designation: 'QA',
    });
    const response = await settingClient.saveOrUpdateMailSignaturePersonalData(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);

    // And again on the read path: the write may sanitise while the read does not, or vice versa.
    const read = await settingClient.getMailSignature({ token });
    await assertNoReflectedScript(
      read,
      {
        method: 'GET',
        path: SETTING_PATHS.getMailSignature,
        repro: `await settingClient.getMailSignature({ token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[signature] injection: a tautology must not leak internals', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.saveOrUpdateMailSignatureCompanyData,
      repro: `await settingClient.saveOrUpdateMailSignatureCompanyData(payload, { token });`,
    };
    const payload = buildSignatureCompanyDataPayload({
      companyName: SQLI_PAYLOAD,
    });
    const response = await settingClient.saveOrUpdateMailSignatureCompanyData(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[signature] boundary: an enormous signature must be bounded', async ({
    settingClient,
    token,
  }) => {
    // A signature is attached to every mail sent, so its size multiplies across outgoing volume —
    // an unbounded one is a compounding storage/bandwidth cost.
    const payload = buildFullSignaturePayload({
      personalData: { firstName: MAX_LENGTH_STRING, designation: MAX_LENGTH_STRING },
    });
    const response = await settingClient.saveOrUpdateMailSignature(payload, { token });

    expect(
      response.status(),
      `a signature carrying two 5000-character fields produced HTTP ${response.status()}. The signature is appended to every outgoing mail, so its size is multiplied by the user's whole send volume — it needs a stated cap, enforced with a 400.`
    ).toBeLessThan(500);
  });

  test('[signature] the template id must be validated against the available templates', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.saveOrUpdateMailSignatureTemplateId,
      repro: `await settingClient.saveOrUpdateMailSignatureTemplateId({ templateID: 99999 }, { token });`,
    };
    const payload = buildSignatureTemplateIdPayload(99999);
    const response = await settingClient.saveOrUpdateMailSignatureTemplateId(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'templateID 99999 does not correspond to any available template',
        severity: 'Minor',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[signature] structural: malformed JSON must be a clean 400', async ({
    settingClient,
    token,
  }) => {
    const malformed = '{"personalData":';
    const response = await settingClient.sendRaw(
      SETTING_PATHS.saveOrUpdateMailSignature,
      malformed,
      { token }
    );

    await assertStatus(response, [400, 401, 403, 415, 422], {
      method: 'POST',
      path: SETTING_PATHS.saveOrUpdateMailSignature,
      body: malformed,
      repro: `await settingClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[signature] status parity: HTTP status must agree with the envelope', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.saveOrUpdateMailSignature({}, { token });

    await assertStatusCodeParity(response, {
      method: 'POST',
      path: SETTING_PATHS.saveOrUpdateMailSignature,
      repro: `await settingClient.saveOrUpdateMailSignature({}, { token });`,
      body: {},
    });
  });
});

/* =========================================================================================
 * Letterhead
 * ====================================================================================== */
test.describe('Letterhead', () => {
  test('[upload] happy path: a header/footer pair uploads', async ({ settingClient, token }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.letterHeadUpload,
      repro: `await settingClient.letterHeadUpload(headerFile, footerFile, { token });`,
    };
    const { headerFile, footerFile } = letterHeadPair();
    const response = await settingClient.letterHeadUpload(headerFile, footerFile, { token });

    await assertStatus(response, [200, 201, 400, 401, 403], META);
  });

  test('[upload] validation: a header without its footer must be refused', async ({
    settingClient,
    token,
  }) => {
    // A letterhead is always a pair; both parts are required. A header accepted without its footer
    // leaves a half-configured letterhead that renders broken on every outgoing mail.
    const META = {
      method: 'POST',
      path: SETTING_PATHS.letterHeadUpload,
      repro: `await settingClient.letterHeadUploadRaw({ headerFile }, { token });`,
    };
    const { headerFile } = letterHeadPair();
    const response = await settingClient.letterHeadUploadRaw({ headerFile }, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'a letterhead header was uploaded with no matching footer',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[upload] validation: a footer without its header must be refused', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.letterHeadUpload,
      repro: `await settingClient.letterHeadUploadRaw({ footerFile }, { token });`,
    };
    const { footerFile } = letterHeadPair();
    const response = await settingClient.letterHeadUploadRaw({ footerFile }, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        scenario: 'a letterhead footer was uploaded with no matching header',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[upload] a non-image file must be refused', async ({ settingClient, token }) => {
    // The letterhead is rendered into outgoing mail. A non-image fails to render, or becomes
    // active content embedded in the platform's own mail if its type is derived from its name.
    const response = await settingClient.letterHeadUploadRaw(
      { headerFile: textAttachment(64), footerFile: textAttachment(64) },
      { token }
    );

    await assertRejectsInvalidInput(
      response,
      {
        method: 'POST',
        path: SETTING_PATHS.letterHeadUpload,
        repro: `await settingClient.letterHeadUploadRaw({ headerFile: <text/plain>, footerFile: <text/plain> }, { token });`,
        scenario: 'a plain text file was uploaded where a letterhead image is required',
        severity: 'Major',
      },
      [400, 401, 403, 415, 422]
    );
  });

  test('[upload] an anonymous caller must not upload a letterhead', async ({ settingClient }) => {
    const { headerFile, footerFile } = letterHeadPair();
    const response = await settingClient.letterHeadUpload(headerFile, footerFile, { token: null });

    await assertUnauthorized(response, {
      method: 'POST',
      path: SETTING_PATHS.letterHeadUpload,
      repro: `await settingClient.letterHeadUpload(headerFile, footerFile, { token: null });`,
    });
  });

  test('[getAllLetterHead] happy path satisfies the contract', async ({ settingClient, token }) => {
    const META = {
      method: 'GET',
      path: SETTING_PATHS.getAllLetterHead,
      repro: `await settingClient.getAllLetterHead({ token });`,
    };
    const response = await settingClient.getAllLetterHead({ token });

    await expectValidContract(response, settingResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[getLetterHead] happy path satisfies the contract', async ({ settingClient, token }) => {
    const META = {
      method: 'GET',
      path: SETTING_PATHS.getLetterHead,
      repro: `await settingClient.getLetterHead({ token });`,
    };
    const response = await settingClient.getLetterHead({ token });

    await expectValidContract(response, settingResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[setLetterHead] activation must be exclusive', async ({ settingClient, token }) => {
    // Activating one letterhead deactivates whichever was active. Two active at once means the
    // renderer picks non-deterministically. Upload two, activate one, read back, confirm one active.
    const { headerFile, footerFile } = letterHeadPair();
    await settingClient.letterHeadUpload(headerFile, footerFile, { token });
    await settingClient.letterHeadUpload(headerFile, footerFile, { token });

    const listing = await settingClient.getAllLetterHead({ token });
    const listingBody = await readBody(listing);
    test.skip(!listing.ok() || listingBody.json === null, 'letterhead listing returned no data');

    const rows = Array.isArray(listingBody.json?.data)
      ? (listingBody.json?.data as Array<Record<string, unknown>>)
      : [];
    test.skip(rows.length < 2, 'fewer than two letterheads available — cannot test exclusivity');

    const target = rows.find((row) => row.id !== undefined);
    test.skip(target === undefined, 'the letterhead listing carries no id to activate');

    await settingClient.setLetterHead(buildLetterHeadIdPayload(String(target?.id)), { token });

    const after = await settingClient.getAllLetterHead({ token });
    const afterBody = await readBody(after);
    test.skip(!after.ok() || afterBody.json === null, 'letterhead listing returned no data');

    const afterRows = Array.isArray(afterBody.json?.data)
      ? (afterBody.json?.data as Array<Record<string, unknown>>)
      : [];
    const active = afterRows.filter(
      (row) => row.active === true || row.isActive === true || row.activeFlag === 'Y'
    );
    test.skip(
      afterRows.length > 0 && active.length === 0,
      'the listing does not expose an active flag — exclusivity cannot be observed from the API'
    );

    expect(
      active.length,
      `${active.length} letterheads are marked active after activating one. Activation is documented as exclusive; with more than one active the renderer picks non-deterministically and the user's outgoing mail carries whichever branding it happened to choose.`
    ).toBeLessThanOrEqual(1);
  });

  test('[setLetterHead] IDOR: another user\'s letterhead must not be activatable', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.setLetterHead,
      repro: `await settingClient.setLetterHead(buildLetterHeadIdPayload('<foreign>'), { token });`,
    };
    const payload = buildLetterHeadIdPayload(FOREIGN.letterHeadID);
    const response = await settingClient.setLetterHead(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.letterHeadID,
      what: 'letterhead id',
    });
  });

  test('[setLetterHead] validation: a missing id must be refused', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.setLetterHead({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        method: 'POST',
        path: SETTING_PATHS.setLetterHead,
        repro: `await settingClient.setLetterHead({}, { token });`,
        body: {},
        scenario: 'a letterhead activation with no id',
        severity: 'Major',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[setLetterHead] type mismatch: a numeric id where the contract declares a string', async ({
    settingClient,
    token,
  }) => {
    // The documented example gives `id` as a string (`{"id":"2"}`) though it addresses a numeric
    // entry. A client sending the number must not get a 500.
    const response = await settingClient.setLetterHead({ id: 2 }, { token });

    expect(
      response.status(),
      `id was sent as a number where the documented example gives a string, producing HTTP ${response.status()}. The value addresses a numeric entry, so sending a number is the natural client behaviour and must not fault.`
    ).toBeLessThan(500);
  });

  test('[deleteLetterHead] IDOR: another user\'s letterhead must not be deletable', async ({
    settingClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: SETTING_PATHS.deleteLetterHead,
      repro: `await settingClient.deleteLetterHead(buildLetterHeadIdPayload('<foreign>'), { token });`,
    };
    const payload = buildLetterHeadIdPayload(FOREIGN.letterHeadID);
    const response = await settingClient.deleteLetterHead(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.letterHeadID,
      what: 'letterhead id on a delete',
    });
  });

  test('[deleteLetterHead] validation: a missing id must be refused', async ({
    settingClient,
    token,
  }) => {
    // The letterhead column is a JSON array. A delete with no id read as "no filter" empties the
    // whole array in one request.
    const response = await settingClient.deleteLetterHead({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        method: 'POST',
        path: SETTING_PATHS.deleteLetterHead,
        repro: `await settingClient.deleteLetterHead({}, { token });`,
        body: {},
        scenario: 'a letterhead delete with no id',
        severity: 'Critical',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[deleteLetterHead] an anonymous caller must not delete a letterhead', async ({
    settingClient,
  }) => {
    const response = await settingClient.deleteLetterHead(
      buildLetterHeadIdPayload(FOREIGN.letterHeadID),
      { token: null }
    );

    await assertUnauthorized(response, {
      method: 'POST',
      path: SETTING_PATHS.deleteLetterHead,
      repro: `await settingClient.deleteLetterHead(payload, { token: null });`,
    });
  });

  test('[upload] a large image pair must be bounded', async ({ settingClient, token }) => {
    const large = { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(3 * 1024 * 1024) };
    const response = await settingClient.letterHeadUploadRaw(
      { headerFile: large, footerFile: pngAttachment() },
      { token }
    );

    expect(
      response.status(),
      `a 3 MB letterhead header produced HTTP ${response.status()}. The letterhead is embedded in every outgoing mail, so its size multiplies across the user's whole send volume — it needs a cap enforced with a 400 rather than a timeout.`
    ).toBeLessThan(500);
  });
});

/* =========================================================================================
 * Salutations
 * ====================================================================================== */
test.describe('Custom salutations', () => {
  const META = {
    method: 'POST',
    path: SETTING_PATHS.saveOrUpdateCustomizedSaluations,
    repro: `await settingClient.saveOrUpdateCustomizedSaluations(buildSaluationPayload(), { token });`,
  };

  test('[1] happy path: creating a salutation satisfies the contract', async ({
    settingClient,
    token,
  }) => {
    const payload = buildSaluationPayload();
    const response = await settingClient.saveOrUpdateCustomizedSaluations(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 204, 400, 401, 403]
    );
  });

  test('[2] lifecycle: a created salutation is returned by the lookup', async ({
    settingClient,
    mailboxClient,
    token,
  }) => {
    const marker = qaLabel('saluation');
    const create = await settingClient.saveOrUpdateCustomizedSaluations(
      buildSaluationPayload({ saluation: marker }),
      { token }
    );
    test.skip(!create.ok(), 'the salutation create did not succeed on this environment');

    const read = await mailboxClient.getSaluations({ token });
    const { text } = await readBody(read);
    test.skip(!read.ok(), 'the salutation lookup did not succeed on this environment');

    expect(
      text.includes(marker),
      `a salutation created as "${marker}" was not returned by getSaluations. The create reported success, so either it was not persisted or the lookup does not read the customizedSaluation column the create writes. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[3] create vs update: omitting saluationID must create, not overwrite', async ({
    settingClient,
    token,
  }) => {
    // Contract: omit `saluationID` to create, supply it to update. If an absent id overwrites the
    // first salutation instead, "add a greeting" becomes "replace it" — 200 both times.
    const first = qaLabel('sal-first');
    const second = qaLabel('sal-second');
    await settingClient.saveOrUpdateCustomizedSaluations(buildSaluationPayload({ saluation: first }), {
      token,
    });
    await settingClient.saveOrUpdateCustomizedSaluations(
      buildSaluationPayload({ saluation: second }),
      { token }
    );

    const read = await settingClient.getDigitalSignature({ token });
    const { text } = await readBody(read);
    test.skip(!read.ok(), 'the settings read did not succeed on this environment');
    test.skip(
      !text.includes(second),
      'the second salutation is not visible in the settings record — cannot compare'
    );

    expect(
      text.includes(first),
      `creating a second salutation removed the first. Both were created with saluationID omitted, which is documented to mean "create a new one" — if an absent id updates in place instead, adding a greeting silently replaces the previous one and both calls return 200.`
    ).toBe(true);
  });

  test('[4] validation: a salutation with no text must be refused', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.saveOrUpdateCustomizedSaluations({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a salutation was created with no text',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] XSS: a script payload must not survive into outgoing mail', async ({
    settingClient,
    token,
  }) => {
    // A salutation opens the mail body and is rendered in every recipient's client.
    const payload = buildSaluationPayload({ saluation: XSS_PAYLOAD });
    const response = await settingClient.saveOrUpdateCustomizedSaluations(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[6] boundary: a 5000-character salutation must be bounded', async ({
    settingClient,
    token,
  }) => {
    const payload = buildSaluationPayload({ saluation: MAX_LENGTH_STRING });
    const response = await settingClient.saveOrUpdateCustomizedSaluations(payload, { token });

    expect(
      response.status(),
      `a 5000-character salutation produced HTTP ${response.status()}. A greeting has a natural length; the cap belongs in the validator.`
    ).toBeLessThan(500);
  });

  test('[7] IDOR: another user\'s salutation must not be deletable', async ({
    settingClient,
    token,
  }) => {
    const deleteMeta = {
      method: 'POST',
      path: SETTING_PATHS.deleteCustomizedSaluation,
      repro: `await settingClient.deleteCustomizedSaluation(buildSaluationIdPayload('<foreign>'), { token });`,
    };
    const payload = buildSaluationIdPayload(FOREIGN.saluationID);
    const response = await settingClient.deleteCustomizedSaluation(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...deleteMeta,
      body: payload,
      foreignValue: FOREIGN.saluationID,
      what: 'saluationID on a delete',
    });
  });

  test('[8] validation: a delete with no saluationID must be refused', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.deleteCustomizedSaluation({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        method: 'POST',
        path: SETTING_PATHS.deleteCustomizedSaluation,
        repro: `await settingClient.deleteCustomizedSaluation({}, { token });`,
        body: {},
        scenario: 'a salutation delete with no id',
        severity: 'Major',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[9] auth: an anonymous caller must not write a salutation', async ({ settingClient }) => {
    const payload = buildSaluationPayload();
    const response = await settingClient.saveOrUpdateCustomizedSaluations(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[10] auth: an expired token must not write a salutation', async ({ settingClient }) => {
    const payload = buildSaluationPayload();
    const response = await settingClient.saveOrUpdateCustomizedSaluations(payload, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * Instant replies
 * ====================================================================================== */
test.describe('Canned instant replies', () => {
  const META = {
    method: 'POST',
    path: SETTING_PATHS.saveOrUpdateCustomizedInstantReply,
    repro: `await settingClient.saveOrUpdateCustomizedInstantReply(buildInstantReplyPayload(), { token });`,
  };

  test('[1] happy path: creating an instant reply satisfies the contract', async ({
    settingClient,
    token,
  }) => {
    const payload = buildInstantReplyPayload();
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 204, 400, 401, 403]
    );
  });

  test('[2] lifecycle: a created instant reply is returned by the lookup', async ({
    settingClient,
    mailboxClient,
    token,
  }) => {
    const marker = qaLabel('instant-reply');
    const create = await settingClient.saveOrUpdateCustomizedInstantReply(
      buildInstantReplyPayload({ instantReply: marker }),
      { token }
    );
    test.skip(!create.ok(), 'the instant-reply create did not succeed on this environment');

    const read = await mailboxClient.getInstantReply({ token });
    const { text } = await readBody(read);
    test.skip(!read.ok(), 'the instant-reply lookup did not succeed on this environment');

    expect(
      text.includes(marker),
      `an instant reply created as "${marker}" was not returned by getInstantReply. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[3] the identifier field differs from the salutation route, by design', async ({
    settingClient,
    token,
  }) => {
    // Identical semantics, different identifier field: salutation uses `saluationID`, instant reply
    // uses `id`. A client assuming symmetry sends `saluationID` here, addresses nothing, and
    // creates a duplicate instead of updating.
    const payload = buildInstantReplyPayload({ saluationID: FOREIGN.instantReplyID });
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, { token });

    expect(
      response.status(),
      `sending "saluationID" — the salutation route's identifier — to the instant-reply route produced HTTP ${response.status()}. These DTOs reject unknown properties, so a 400 is correct and expected; a 500 means the mismatch escaped as an exception, and a 200 means the field was silently ignored and the caller has created a duplicate believing they updated one.`
    ).toBeLessThan(500);
  });

  test('[4] validation: an instant reply with no text must be refused', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.saveOrUpdateCustomizedInstantReply({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an instant reply was created with no text',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] XSS: a script payload must not survive into outgoing mail', async ({
    settingClient,
    token,
  }) => {
    // An instant reply is sent as an actual mail with one tap, so stored markup here is delivered.
    const payload = buildInstantReplyPayload({ instantReply: XSS_PAYLOAD });
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[6] boundary: a 5000-character instant reply must be bounded', async ({
    settingClient,
    token,
  }) => {
    const payload = buildInstantReplyPayload({ instantReply: MAX_LENGTH_STRING });
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, { token });

    expect(
      response.status(),
      `a 5000-character instant reply produced HTTP ${response.status()}. A one-tap canned response has a natural length; the cap belongs in the validator.`
    ).toBeLessThan(500);
  });

  test('[7] IDOR: another user\'s instant reply must not be deletable', async ({
    settingClient,
    token,
  }) => {
    const deleteMeta = {
      method: 'POST',
      path: SETTING_PATHS.deleteCustomizedInstantReply,
      repro: `await settingClient.deleteCustomizedInstantReply(buildInstantReplyIdPayload('<foreign>'), { token });`,
    };
    const payload = buildInstantReplyIdPayload(FOREIGN.instantReplyID);
    const response = await settingClient.deleteCustomizedInstantReply(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...deleteMeta,
      body: payload,
      foreignValue: FOREIGN.instantReplyID,
      what: 'instant reply id on a delete',
    });
  });

  test('[8] validation: a delete with no id must be refused', async ({ settingClient, token }) => {
    const response = await settingClient.deleteCustomizedInstantReply({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        method: 'POST',
        path: SETTING_PATHS.deleteCustomizedInstantReply,
        repro: `await settingClient.deleteCustomizedInstantReply({}, { token });`,
        body: {},
        scenario: 'an instant-reply delete with no id',
        severity: 'Major',
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[9] injection: a tautology must not leak internals', async ({ settingClient, token }) => {
    const payload = buildInstantReplyPayload({ instantReply: SQLI_PAYLOAD });
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] auth: an anonymous caller must not write an instant reply', async ({
    settingClient,
  }) => {
    const payload = buildInstantReplyPayload();
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[11] auth: a malformed token must not write an instant reply', async ({
    settingClient,
  }) => {
    const payload = buildInstantReplyPayload();
    const response = await settingClient.saveOrUpdateCustomizedInstantReply(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * Mail-count day window — updateMailCountDaysLimit (POST) / getMailCountDaysLimit (GET)
 * ====================================================================================== */
test.describe('Mail-count day window', () => {
  const META = {
    method: 'POST',
    path: SETTING_PATHS.updateMailCountDaysLimit,
    repro: `await settingClient.updateMailCountDaysLimit(buildMailCountDaysLimitPayload(), { token });`,
  };

  test('[1] happy path: setting the day window satisfies the contract', async ({
    settingClient,
    token,
  }) => {
    const payload = buildMailCountDaysLimitPayload();
    const response = await settingClient.updateMailCountDaysLimit(payload, { token });

    // 404 tolerated: this route is in the KMail Excel but NOT yet deployed on the service (absent
    // from kmail.swagger.json; verified 2026-09-09 — GET and POST both answer 404 "No handler").
    // That is a "not implemented" gap to raise with developers, not a wrong-status defect to file.
    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 204, 400, 401, 403, 404]
    );
  });

  test('[1b] getMailCountDaysLimit happy path satisfies the contract', async ({
    settingClient,
    token,
  }) => {
    const readMeta = {
      method: 'GET',
      path: SETTING_PATHS.getMailCountDaysLimit,
      repro: `await settingClient.getMailCountDaysLimit({ token });`,
    };
    const response = await settingClient.getMailCountDaysLimit({ token });

    // 404 tolerated — see [1]: endpoint is Excel-only, not deployed on the service (raise with devs).
    await expectValidContract(response, kmailEnvelopeSchema, readMeta, [200, 400, 401, 403, 404]);
  });

  test('[2] lifecycle: a set day window reads back', async ({ settingClient, token }) => {
    // The window governs how far back every mailbox count reaches; a value that saves but does not
    // read back means every count silently uses a stale window. getMailCountDaysLimit is a GET.
    const distinctive = 47;
    const save = await settingClient.updateMailCountDaysLimit(
      buildMailCountDaysLimitPayload(distinctive),
      { token }
    );
    test.skip(!save.ok(), 'the day-window save did not succeed on this environment');

    const read = await settingClient.getMailCountDaysLimit({ token });
    const { text } = await readBody(read);
    test.skip(!read.ok(), 'the day-window read did not succeed on this environment');

    expect(
      text.includes(String(distinctive)),
      `a mail-count window saved as ${distinctive} did not read back carrying it. The save reported success, so the value was either not persisted or is not what getMailCountDaysLimit returns — every subsequent mailbox count then uses a stale window. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[3] boundary: a negative day window must be refused', async ({ settingClient, token }) => {
    const payload = buildMailCountDaysLimitPayload(-1);
    const response = await settingClient.updateMailCountDaysLimit(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a negative countDaysLimit was accepted',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] type fuzz: a non-numeric day window must not fault', async ({
    settingClient,
    token,
  }) => {
    const payload = buildMailCountDaysLimitPayload(0, { countDaysLimit: 'sixty' });
    const response = await settingClient.updateMailCountDaysLimit(payload, { token });

    expect(
      response.status(),
      `a string countDaysLimit produced HTTP ${response.status()}. A wrong-typed value is a client bug the API must reject with a 400, not crash on with a 500.`
    ).toBeLessThan(500);
  });

  test('[5] validation: a missing countDaysLimit must be refused', async ({
    settingClient,
    token,
  }) => {
    const response = await settingClient.updateMailCountDaysLimit({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'the required field "countDaysLimit" was omitted',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] auth: an anonymous caller must not set the day window', async ({ settingClient }) => {
    const payload = buildMailCountDaysLimitPayload();
    const response = await settingClient.updateMailCountDaysLimit(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[6b] auth: an anonymous caller must not read the day window', async ({ settingClient }) => {
    const response = await settingClient.getMailCountDaysLimit({ token: null });

    await assertUnauthorized(response, {
      method: 'GET',
      path: SETTING_PATHS.getMailCountDaysLimit,
      repro: `await settingClient.getMailCountDaysLimit({ token: null });`,
    });
  });

  test('[7] status parity: HTTP status must agree with the envelope', async ({
    settingClient,
    token,
  }) => {
    const payload = buildMailCountDaysLimitPayload();
    const response = await settingClient.updateMailCountDaysLimit(payload, { token });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });
});
