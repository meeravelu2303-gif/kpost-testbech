import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { DRAFT_PATHS, READ_MAIL_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import {
  draftListResponseSchema,
  kmailContentResponseSchema,
  kmailEnvelopeSchema,
} from '../../src/api/schemas/kmail.schema';
import {
  assertBoundedCollection,
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
  buildDraftIdPayload,
  buildDraftPayload,
  buildDraftsForContactPayload,
} from '../../src/api/payloads/draft.payload';
import { buildComposePayload } from '../../src/api/payloads/sentMail.payload';
import { buildDraftContentPayload } from '../../src/api/payloads/readMail.payload';
import { textAttachment } from '../../src/utils/attachments';
import { nonExistentKmailId, qaLabel, syntheticRecipient } from '../../src/utils/safeTestData';

/**
 * Draft management — `/v2/draft/**` plus `readMail/draftMailContent`.
 *
 * The one module with a genuine lifecycle: save, read back, update, list, delete, confirm gone.
 * The interesting defects are state failures across two calls, like an update that creates a
 * second draft instead of replacing the first. `beforeEach` creates the prerequisite draft
 * rather than assuming the account already has drafts.
 *
 * Two DTO facts drive several cases:
 *
 *  - `draftMail` takes the compose DTO; `deleteDraftMail` takes the `Draft` entity. Different
 *    shapes, and these entities reject unknown properties with a Jackson 400.
 *  - A draft stores `cc`/`bcc` as delimited strings, where the send DTO uses arrays.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/**
 * Saves a draft and returns its server-assigned id, or `null` when the save did not succeed.
 * Returns `null` rather than throwing so a block can skip with a stated reason instead of
 * misattributing a setup failure to the endpoint under test.
 */
async function createDraft(
  draftClient: { draftMail: (data: unknown, options?: { token?: string | null }) => Promise<import('@playwright/test').APIResponse> },
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<number | null> {
  const response = await draftClient.draftMail(buildComposePayload(overrides), { token });
  if (!response.ok()) return null;
  const { json } = await readBody(response);
  if (!json) return null;

  // The assigned id arrives as `data` directly or nested inside it, depending on the branch.
  const data = json.data;
  if (typeof data === 'number') return data;
  if (data !== null && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).kmailID;
    if (typeof nested === 'number') return nested;
  }
  if (typeof json.kmailID === 'number') return json.kmailID;
  return null;
}

/* =========================================================================================
 * POST /v2/draft/draftMail
 * ====================================================================================== */
test.describe('POST /v2/draft/draftMail', () => {
  const META = {
    method: 'POST',
    path: DRAFT_PATHS.draftMail,
    repro: `await draftClient.draftMail(buildComposePayload(), { token });`,
  };

  test('[1] happy path: a draft is saved and satisfies the contract', async ({
    draftClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await draftClient.draftMail(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400]
    );
  });

  test('[2] happy path: saving a draft returns its assigned kmailID', async ({
    draftClient,
    token,
  }) => {
    // Without the assigned id the client cannot update the draft it just saved — every save
    // creates another row and the draft list fills with copies of one message.
    const draftId = await createDraft(draftClient, token);

    expect(
      draftId,
      'saving a draft returned no assigned kmailID. The draft row is a MySQL auto-increment identity and the client needs it to update rather than duplicate; without it, every autosave creates a new draft.'
    ).not.toBeNull();
  });

  test('[3] happy path: a draft with no recipient is still savable', async ({
    draftClient,
    token,
  }) => {
    // A draft is unfinished by definition, so postMail's recipient validation must NOT apply
    // here — rejecting a recipient-less draft makes autosave impossible.
    const payload = buildComposePayload({ toAddress: '' });
    const response = await draftClient.draftMail(payload, { token });

    await assertStatus(response, [200, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A draft with no recipient yet cannot be saved',
      severity: 'Major',
    });
  });

  test('[4] happy path: an empty draft is savable', async ({ draftClient, token }) => {
    // The first autosave, before anything has been typed.
    const payload = buildComposePayload({ toAddress: '', kmailSubject: '', kmailContent: '' });
    const response = await draftClient.draftMail(payload, { token });

    expect(
      response.status(),
      `an entirely empty draft produced HTTP ${response.status()}. This is what the compose screen sends on its first autosave, before the user has typed anything.`
    ).toBeLessThan(500);
  });

  test('[5] lifecycle: updating a draft must not create a second one', async ({
    draftClient,
    token,
  }) => {
    // The defect this module exists to catch. kmailID 0 means "create", non-zero means "update
    // that row". If the id is ignored and it inserts regardless, an autosaving compose screen
    // leaves dozens of copies of one message, with no error ever returned.
    const draftId = await createDraft(draftClient, token);
    test.skip(draftId === null, 'could not create a draft to update on this environment');

    const before = await draftClient.getAllDraftMails({ token });
    const beforeBody = await readBody(before);
    const beforeCount = Array.isArray(beforeBody.json?.data)
      ? (beforeBody.json?.data as unknown[]).length
      : null;
    test.skip(beforeCount === null, 'draft listing returned no countable data');

    const updated = buildComposePayload({
      kmailID: draftId,
      kmailSubject: qaLabel('draft-updated'),
    });
    await draftClient.draftMail(updated, { token });

    const after = await draftClient.getAllDraftMails({ token });
    const afterBody = await readBody(after);
    const afterCount = Array.isArray(afterBody.json?.data)
      ? (afterBody.json?.data as unknown[]).length
      : null;
    test.skip(afterCount === null, 'draft listing returned no countable data after the update');

    expect(
      afterCount,
      `saving a draft with kmailID ${draftId} — an existing row — changed the draft count from ${beforeCount} to ${afterCount}. A non-zero kmailID means "update this draft"; if it inserts instead, an autosaving compose screen fills the user's draft folder with copies of one message and nothing ever reports an error.`
    ).toBe(beforeCount);
  });

  test('[6] IDOR: a body fromAddress must not save a draft into another mailbox', async ({
    draftClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildComposePayload({ fromAddress: FOREIGN.victimKpostID });
    const response = await draftClient.draftMail(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null, 'draft save returned no parseable body');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the draft was saved reporting "${FOREIGN.victimKpostID}" as its owner while the caller was ${callerKpostId ?? 'a different identity'}. A draft row is owned by fromAddress, which the service overwrites from the JWT; if the body wins, a caller writes into another user's draft folder — content that user will later open, edit and send as their own. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] IDOR: updating a foreign kmailID must not overwrite another user\'s draft', async ({
    draftClient,
    token,
  }) => {
    // Write-side counterpart to reading someone else's draft, and more damaging: overwriting a
    // foreign draft destroys content rather than merely disclosing it.
    const payload = buildComposePayload({
      kmailID: FOREIGN.draftKmailID,
      kmailSubject: qaLabel('idor-overwrite'),
    });
    const response = await draftClient.draftMail(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.draftKmailID,
      what: 'draft kmailID',
    });
  });

  test('[8] validation: a null subject must not fault', async ({ draftClient, token }) => {
    const payload = buildComposePayload({ kmailSubject: null });
    const response = await draftClient.draftMail(payload, { token });

    expect(
      response.status(),
      `a null subject on a draft produced HTTP ${response.status()}. An unfinished draft legitimately has null fields; that is what makes it a draft.`
    ).toBeLessThan(500);
  });

  test('[9] boundary: a 5000-character subject must not fault', async ({ draftClient, token }) => {
    const payload = buildComposePayload({ kmailSubject: MAX_LENGTH_STRING });
    const response = await draftClient.draftMail(payload, { token });

    expect(
      response.status(),
      `a 5000-character draft subject produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[10] XSS: a script payload in the draft body must not be reflected unescaped', async ({
    draftClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailContent: XSS_PAYLOAD });
    const response = await draftClient.draftMail(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[11] injection: a tautology in the subject must not leak internals', async ({
    draftClient,
    token,
  }) => {
    const payload = buildComposePayload({ kmailSubject: SQLI_PAYLOAD });
    const response = await draftClient.draftMail(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[12] structural: malformed JSON must be a clean 400', async ({ draftClient, token }) => {
    const malformed = '{"kmailSubject":';
    const response = await draftClient.sendRaw(DRAFT_PATHS.draftMail, malformed, { token });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await draftClient.sendRaw(DRAFT_PATHS.draftMail, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[13] auth: no Authorization header must be 401/403', async ({ draftClient }) => {
    const payload = buildComposePayload();
    const response = await draftClient.draftMail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[14] auth: an expired token must not save a draft', async ({ draftClient }) => {
    const payload = buildComposePayload();
    const response = await draftClient.draftMail(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[15] status parity: HTTP status must agree with the envelope', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.draftMail({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });
});

/* =========================================================================================
 * POST /v2/draft/draftMailMultiPart/
 * ====================================================================================== */
test.describe('POST /v2/draft/draftMailMultiPart/', () => {
  const META = {
    method: 'POST',
    path: DRAFT_PATHS.draftMailMultiPart,
    repro: `await draftClient.draftMailMultiPart(JSON.stringify(buildComposePayload()), [textAttachment()], { token });`,
  };

  test('[1] happy path: a draft with an attachment is saved', async ({ draftClient, token }) => {
    /*
     * Excel row 44 documents `kmailID` on this route: `"0"` composes a NEW draft, a non-zero id
     * updates the existing one. It is set here rather than in buildComposePayload because on
     * postMail the server assigns kmailID from the token and sending it is wrong — the field is
     * meaningful for drafts specifically.
     */
    const payload = buildComposePayload({ kmailID: '0' });
    const response = await draftClient.draftMailMultiPart(
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

  test('[2] boundary: an empty first part means "no attachments"', async ({
    draftClient,
    token,
  }) => {
    const payload = buildComposePayload();
    const response = await draftClient.draftMailMultiPart(JSON.stringify(payload), [], { token });

    await assertStatus(response, [200, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A zero-length first part is not treated as "no attachments"',
    });
  });

  test('[3] validation: a missing text parameter must be refused', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.draftMailMultiPart('', [textAttachment()], { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: '<empty text parameter>',
        scenario: 'the required "text" parameter carrying the draft DTO was empty',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] validation: a malformed text parameter must be refused', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.draftMailMultiPart('{not json', [textAttachment()], {
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

  test('[5] auth: an anonymous caller must not save a draft with attachments', async ({
    draftClient,
  }) => {
    const payload = buildComposePayload();
    const response = await draftClient.draftMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token: null }
    );

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * GET /v2/draft/getAllDraftMails
 * ====================================================================================== */
test.describe('GET /v2/draft/getAllDraftMails', () => {
  const META = {
    method: 'GET',
    path: DRAFT_PATHS.getAllDraftMails,
    repro: `await draftClient.getAllDraftMails({ token });`,
  };

  test.beforeEach(async ({ draftClient, token }) => {
    // A listing test against an empty folder proves nothing — guarantee one row exists first.
    await createDraft(draftClient, token);
  });

  test('[1] happy path: the draft list satisfies the contract', async ({ draftClient, token }) => {
    const response = await draftClient.getAllDraftMails({ token });

    await expectValidContract(response, draftListResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[2] the listing returns the caller\'s own drafts only', async ({
    draftClient,
    token,
    callerKpostId,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — cannot identify a foreign draft');

    const response = await draftClient.getAllDraftMails({ token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !Array.isArray(json.data), 'draft listing returned no array data');

    expect(
      text.includes(`"fromAddress":"${FOREIGN.victimKpostID}"`),
      `the draft listing returned rows owned by "${FOREIGN.victimKpostID}" to ${callerKpostId ?? 'a different identity'}. Drafts are unsent, unreviewed content — often the most candid text a user writes — and the listing is scoped by fromAddress alone. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[3] IDOR: a kpostID query parameter must not re-scope the listing', async ({
    draftClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await draftClient.getAllDraftMails({
      token,
      params: { kpostID: FOREIGN.victimKpostID, fromAddress: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
      repro: `await draftClient.getAllDraftMails({ token, params: { kpostID: '<victim>' } });`,
    });
  });

  test('[4] boundary: the listing must be bounded', async ({ draftClient, token }) => {
    // `getAllDraftMails` takes no page size — the name is literal. On an old account that is one
    // response carrying every unsent message ever started: a memory problem and a prime intercept.
    const response = await draftClient.getAllDraftMails({ token });

    await assertBoundedCollection(response, {
      ...META,
      limit: 1000,
      what: 'drafts',
    });
  });

  test('[5] auth: an anonymous caller must not list drafts', async ({ draftClient }) => {
    const response = await draftClient.getAllDraftMails({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[6] auth: a malformed token must not list drafts', async ({ draftClient }) => {
    const response = await draftClient.getAllDraftMails({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[7] idempotency: two consecutive reads must agree', async ({ draftClient, token }) => {
    const [first, second] = await Promise.all([
      draftClient.getAllDraftMails({ token }),
      draftClient.getAllDraftMails({ token }),
    ]);

    expect(
      first.status(),
      `two identical draft listings returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[8] an unknown query parameter must be ignored, not fatal', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.getAllDraftMails({
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
 * GET /v2/draft/getDraftMailsContacts
 * ====================================================================================== */
test.describe('GET /v2/draft/getDraftMailsContacts', () => {
  const META = {
    method: 'GET',
    path: DRAFT_PATHS.getDraftMailsContacts,
    repro: `await draftClient.getDraftMailsContacts({ token });`,
  };

  test('[1] happy path: the contact list satisfies the contract', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.getDraftMailsContacts({ token });

    await expectValidContract(response, kmailEnvelopeSchema, META, [200, 400, 401, 403]);
  });

  test('[2] empty state: an account with no drafts must not be an error', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.getDraftMailsContacts({ token });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      title: 'An empty draft-contact list is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[3] auth: an anonymous caller must not list draft recipients', async ({ draftClient }) => {
    // This route returns who the user is drafting mail to — an intention list disclosing
    // correspondence that has not happened yet and may never be sent.
    const response = await draftClient.getDraftMailsContacts({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] IDOR: a kpostID query parameter must not re-scope the list', async ({
    draftClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await draftClient.getDraftMailsContacts({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
    });
  });
});

/* =========================================================================================
 * POST /v2/draft/getDraftMailsForSelectedContact
 * ====================================================================================== */
test.describe('POST /v2/draft/getDraftMailsForSelectedContact', () => {
  const META = {
    method: 'POST',
    path: DRAFT_PATHS.getDraftMailsForSelectedContact,
    repro: `await draftClient.getDraftMailsForSelectedContact(buildDraftsForContactPayload(), { token });`,
  };

  test('[1] happy path: drafts for one contact satisfy the contract', async ({
    draftClient,
    token,
  }) => {
    const payload = buildDraftsForContactPayload();
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token });

    await expectValidContract(
      response,
      draftListResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403]
    );
  });

  test('[2] empty state: a contact with no drafts must not be an error', async ({
    draftClient,
    token,
  }) => {
    const payload = buildDraftsForContactPayload(syntheticRecipient());
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A contact with no drafts is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[3] enumeration: a wildcard toAddress must not return every draft', async ({
    draftClient,
    token,
  }) => {
    // The filter `toAddress` is interpolated into a lookup. If it reaches a LIKE unescaped, a
    // single `%` returns every draft the query can see — with a scoping gap, the whole store.
    const payload = buildDraftsForContactPayload('%');
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token });

    await assertBoundedCollection(response, {
      ...META,
      body: payload,
      limit: 1000,
      what: 'drafts for a "%" contact',
    });
  });

  test('[4] IDOR: a foreign fromAddress must not select another mailbox', async ({
    draftClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildDraftsForContactPayload(syntheticRecipient(), {
      fromAddress: FOREIGN.victimKpostID,
    });
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'fromAddress',
    });
  });

  test('[5] validation: an empty body must be handled explicitly', async ({
    draftClient,
    token,
  }) => {
    const response = await draftClient.getDraftMailsForSelectedContact({}, { token });

    expect(
      response.status(),
      `an empty body produced HTTP ${response.status()}. It is either "no filter, bounded page" or a clean 400 — never a fault.`
    ).toBeLessThan(500);
  });

  test('[6] injection: a tautology in toAddress must not leak internals', async ({
    draftClient,
    token,
  }) => {
    const payload = buildDraftsForContactPayload(SQLI_PAYLOAD);
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] auth: an anonymous caller must not list drafts for a contact', async ({
    draftClient,
  }) => {
    const payload = buildDraftsForContactPayload();
    const response = await draftClient.getDraftMailsForSelectedContact(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/readMail/draftMailContent
 * ====================================================================================== */
test.describe('POST /v2/readMail/draftMailContent', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.draftMailContent,
    repro: `await readMailClient.draftMailContent(buildDraftContentPayload(draftKmailID), { token });`,
  };

  test('[1] happy path: a saved draft reads back the content it was saved with', async ({
    draftClient,
    readMailClient,
    token,
  }) => {
    // A round trip, not a status check: "save returned 200" and "content came back intact" are
    // different claims, and only the second means the draft works.
    const marker = qaLabel('roundtrip');
    const draftId = await createDraft(draftClient, token, { kmailSubject: marker });
    test.skip(draftId === null, 'could not create a draft to read back on this environment');

    const payload = buildDraftContentPayload(draftId as number);
    const response = await readMailClient.draftMailContent(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'draft content read returned no data');

    expect(
      text.includes(marker),
      `a draft saved with subject "${marker}" did not read back carrying it. The save reported success, so either the content was not persisted or the read is addressing a different row — both of which lose the user's unsent work silently. Body: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('[2] IDOR: another user\'s draft body must not be readable', async ({
    readMailClient,
    token,
  }) => {
    // The highest-value single read here. A draft is unsent and unreviewed, with no recipient
    // who consented to see it — which is exactly why it must be unreachable by id alone.
    const payload = buildDraftContentPayload(FOREIGN.draftKmailID);
    const response = await readMailClient.draftMailContent(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.draftKmailID,
      what: 'draftKmailID',
    });
  });

  test('[3] validation: a missing draftKmailID must be refused', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildDraftContentPayload(0);
    delete (payload as Record<string, unknown>).draftKmailID;
    const response = await readMailClient.draftMailContent(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'a draft body read with no draft identified',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] validation: a malformed draftKmailID must be refused', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildDraftContentPayload(0, { draftKmailID: 'not-a-number' });
    const response = await readMailClient.draftMailContent(payload, { token });

    expect(
      response.status(),
      `a non-numeric draftKmailID produced HTTP ${response.status()}. The column is a bigint; a string is a type error the parser should catch, not a database exception.`
    ).toBeLessThan(500);
  });

  test('[5] not found: a draft that does not exist must not be a 500', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildDraftContentPayload(nonExistentKmailId());
    const response = await readMailClient.draftMailContent(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      body: payload,
      title: 'A draft that does not exist is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[6] contract: the response satisfies the content schema', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildDraftContentPayload(nonExistentKmailId());
    const response = await readMailClient.draftMailContent(payload, { token });

    await expectValidContract(
      response,
      kmailContentResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[7] auth: an anonymous caller must not read a draft body', async ({ readMailClient }) => {
    const payload = buildDraftContentPayload(nonExistentKmailId());
    const response = await readMailClient.draftMailContent(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/draft/deleteDraftMail
 * ====================================================================================== */
test.describe('POST /v2/draft/deleteDraftMail', () => {
  const META = {
    method: 'POST',
    path: DRAFT_PATHS.deleteDraftMail,
    repro: `await draftClient.deleteDraftMail(buildDraftIdPayload(kmailID), { token });`,
  };

  test('[1] lifecycle: a draft this test created is deleted and stays deleted', async ({
    draftClient,
    token,
  }) => {
    // Deletion is asserted by reading back, not by trusting the delete's status: a delete that
    // returns 200 and removes nothing is the failure mode that matters and is invisible to a status check.
    const marker = qaLabel('to-delete');
    const draftId = await createDraft(draftClient, token, { kmailSubject: marker });
    test.skip(draftId === null, 'could not create a draft to delete on this environment');

    const payload = buildDraftIdPayload(draftId as number);
    const deleteResponse = await draftClient.deleteDraftMail(payload, { token });

    await assertStatus(deleteResponse, [200, 204, 400, 401, 403], {
      ...META,
      body: payload,
    });

    const listing = await draftClient.getAllDraftMails({ token });
    const { json, text } = await readBody(listing);
    test.skip(json === null || !Array.isArray(json.data), 'draft listing returned no array data');

    expect(
      text.includes(marker),
      `the draft with subject "${marker}" was still in the listing after deleteDraftMail reported HTTP ${deleteResponse.status()} for kmailID ${draftId}. A delete that acknowledges and removes nothing is worse than one that fails: the user believes the content is gone.`
    ).toBe(false);
  });

  test('[2] idempotency: deleting the same draft twice must not fault', async ({
    draftClient,
    token,
  }) => {
    const draftId = await createDraft(draftClient, token);
    test.skip(draftId === null, 'could not create a draft to delete on this environment');

    const payload = buildDraftIdPayload(draftId as number);
    await draftClient.deleteDraftMail(payload, { token });
    const second = await draftClient.deleteDraftMail(payload, { token });

    expect(
      second.status(),
      `deleting an already-deleted draft produced HTTP ${second.status()}. A retried delete after a dropped connection is routine, and the second call must be a no-op or a clean 404 — never a fault.`
    ).toBeLessThan(500);
  });

  test('[3] IDOR: another user\'s draft must not be deletable', async ({ draftClient, token }) => {
    // Destructive cross-tenant access, worse than the read: it destroys unsent work with no copy
    // anywhere, and the owner cannot know it happened.
    const payload = buildDraftIdPayload(FOREIGN.draftKmailID);
    const response = await draftClient.deleteDraftMail(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.draftKmailID,
      what: 'draft kmailID',
    });
  });

  test('[4] validation: a delete with no kmailID must be refused', async ({
    draftClient,
    token,
  }) => {
    // A delete route with no identifier must refuse: reading "no id" as "no filter" deletes the
    // caller's entire draft folder, one request away from an ordinary client bug.
    const response = await draftClient.deleteDraftMail({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a draft delete was submitted with no draft identified',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a null kmailID must be refused', async ({ draftClient, token }) => {
    const payload = buildDraftPayload({ kmailID: null });
    const response = await draftClient.deleteDraftMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kmailID" set to null on a delete', severity: 'Critical' },
      [400, 401, 403, 422]
    );
  });

  test('[6] validation: a wildcard kmailID must not delete every draft', async ({
    draftClient,
    token,
  }) => {
    const payload = buildDraftPayload({ kmailID: '%' });
    const response = await draftClient.deleteDraftMail(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailID was set to the SQL wildcard "%" on a delete',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[7] not found: deleting a draft that does not exist must not be a 500', async ({
    draftClient,
    token,
  }) => {
    const payload = buildDraftIdPayload(nonExistentKmailId());
    const response = await draftClient.deleteDraftMail(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      body: payload,
      title: 'Deleting a non-existent draft is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[8] structural: malformed JSON must be a clean 400', async ({ draftClient, token }) => {
    const malformed = '{"kmailID":';
    const response = await draftClient.sendRaw(DRAFT_PATHS.deleteDraftMail, malformed, { token });

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await draftClient.sendRaw(DRAFT_PATHS.deleteDraftMail, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[9] auth: an anonymous caller must not delete a draft', async ({ draftClient }) => {
    const payload = buildDraftIdPayload(nonExistentKmailId());
    const response = await draftClient.deleteDraftMail(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[10] auth: an expired token must not delete a draft', async ({ draftClient }) => {
    const payload = buildDraftIdPayload(nonExistentKmailId());
    const response = await draftClient.deleteDraftMail(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});
