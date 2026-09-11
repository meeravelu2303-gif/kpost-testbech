import { EXPIRED_TOKEN, MALFORMED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { MAILBOX_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { kmailEnvelopeSchema } from '../../src/api/schemas/kmail.schema';
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
  FETCH_MAIL_TYPE,
  KMAIL_STATUS_FLAG,
  buildClearStatusPayload,
  buildCommonPayload,
  buildReplyNotRequiredPayload,
  buildDashboardPagePayload,
  buildDeleteKmailPayload,
  buildGroupReadStatusPayload,
  buildPdfConvertPayload,
  buildSetImportantPayload,
} from '../../src/api/payloads/mailbox.payload';
import {
  nonExistentKmailId,
  nonExistentTransactionId,
  qaLabel,
} from '../../src/utils/safeTestData';

/**
 * Actions on mail — flag important, delete, clear follow-up status, render to PDF. These are the
 * writes; two of them destroy state.
 *
 *  - Nothing here targets a real record: every identifier is far above any plausible bench
 *    auto-increment value, so a route acting on whatever it is handed cannot hide real mail.
 *  - The "no identifier" case is graded Critical: on a destructive route an absent filter means
 *    everything, and "no id supplied" vs "no filter applied" is one `if` statement.
 *
 * Contract fact: deletion is keyed on `transactionIDs`, not `kmailID`. A `KmailTransaction` is one
 * recipient's copy of a mail, so deleting is hiding your own copy. Sending a `kmailID` where a
 * transaction id belongs targets nothing, so the builders keep the two separate.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;

/* =========================================================================================
 * POST /v2/common/setKmailAsImportant
 * ====================================================================================== */
test.describe('POST /v2/common/setKmailAsImportant @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.setKmailAsImportant,
    repro: `await mailboxClient.setKmailAsImportant(buildSetImportantPayload(), { token });`,
  };

  test('[1] happy path: flagging satisfies the contract', async ({ mailboxClient, token }) => {
    const payload = buildSetImportantPayload();
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: another user\'s mail must not be flaggable', async ({ mailboxClient, token }) => {
    // A flag is the cheapest probe for whether the update path checks ownership at all; the same
    // missing check governs the delete route next to it.
    const payload = buildSetImportantPayload([FOREIGN.kmailID]);
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on a flag write',
    });
  });

  test('[3] IDOR: a body kpostUser must not flag in another mailbox', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildSetImportantPayload([nonExistentKmailId()], {
      kpostUser: FOREIGN.victimKpostID,
    });
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser on a flag write',
    });
  });

  test('[4] validation: a flag with no mail identified must be refused', async ({
    mailboxClient,
    token,
  }) => {
    // Graded Major: an unfiltered flag write marks everything important — destroys the Important
    // folder's usefulness but no data. The same shape on delete is Critical, graded there.
    const response = await mailboxClient.setKmailAsImportant({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a flag write was submitted with no mail identified',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: an empty kmailIDs array must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildSetImportantPayload([]);
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailIDs was an empty array on a flag write',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] validation: a null kmailIDs must be refused', async ({ mailboxClient, token }) => {
    const payload = buildSetImportantPayload([], { kmailIDs: null, kmailID: null });
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "kmailIDs" set to null', severity: 'Major' },
      [400, 401, 403, 422]
    );
  });

  test('[7] boundary: a very large batch must be capped', async ({ mailboxClient, token }) => {
    const kmailIDs = Array.from({ length: 5000 }, (_unused, index) => 990_000_000 + index);
    const payload = buildSetImportantPayload(kmailIDs);
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    expect(
      response.status(),
      `a 5000-entry flag batch produced HTTP ${response.status()}. A batch write with no cap is a single request that can hold a table lock for as long as it takes; it must be refused with a stated limit.`
    ).toBeLessThan(500);
  });

  test('[8] idempotency: flagging twice must not fault', async ({ mailboxClient, token }) => {
    const payload = buildSetImportantPayload();
    await mailboxClient.setKmailAsImportant(payload, { token });
    const second = await mailboxClient.setKmailAsImportant(payload, { token });

    expect(
      second.status(),
      `flagging the same mail twice produced HTTP ${second.status()} on the second call. A user double-tapping a star, or a client retrying after a dropped connection, must not produce an error.`
    ).toBeLessThan(500);
  });

  test('[9] injection: a tautology in kmailID must not leak internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildSetImportantPayload([], { kmailID: SQLI_PAYLOAD });
    const response = await mailboxClient.setKmailAsImportant(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[10] auth: no Authorization header must be 401/403', async ({ mailboxClient }) => {
    const payload = buildSetImportantPayload();
    const response = await mailboxClient.setKmailAsImportant(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[11] auth: an expired token must not flag mail', async ({ mailboxClient }) => {
    const payload = buildSetImportantPayload();
    const response = await mailboxClient.setKmailAsImportant(payload, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[12] status parity: HTTP status must agree with the envelope', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.setKmailAsImportant({}, { token });

    await assertStatusCodeParity(response, { ...META, body: {} });
  });

  test('[13] round-trip (business rule): a flagged mail must appear in the Important folder', async ({
    mailboxClient,
    token,
  }) => {
    // The end-to-end invariant no isolated case covers: does flagging a mail actually land it in the
    // Important folder? Uses a REAL owned mail from the inbox, not a synthetic id. Skips (never fails)
    // where no mail is readable — e.g. an environment whose mailbox read returns "No Data Found" —
    // so a degraded backend reads as "unverified", never as a false defect.
    const inbox = await mailboxClient.getKmailDashboardMsg(buildDashboardPagePayload(), { token });
    const { json: inboxJson } = await readBody(inbox);
    const rows = Array.isArray(inboxJson?.data)
      ? (inboxJson.data as Array<Record<string, unknown>>)
      : Array.isArray(inboxJson?.value)
        ? (inboxJson.value as Array<Record<string, unknown>>)
        : [];
    const owned = rows.map((r) => Number(r.kmailID)).find((id) => Number.isFinite(id) && id > 0);
    test.skip(
      owned === undefined,
      'no readable owned mail on this environment — cannot exercise the Important-flag round-trip'
    );

    const kmailID = owned as number;
    const flag = await mailboxClient.setKmailAsImportant(buildSetImportantPayload([kmailID]), { token });
    test.skip(!flag.ok(), 'flagging did not succeed on this environment');

    const folder = await mailboxClient.getAllImportantMails(buildCommonPayload({ count: 50 }), { token });
    const { json: folderJson } = await readBody(folder);
    const flagged = Array.isArray(folderJson?.data)
      ? (folderJson.data as Array<Record<string, unknown>>)
      : [];
    const present = flagged.some((r) => Number(r.kmailID) === kmailID);

    // Best-effort cleanup: the flag is a benign, reversible marker; toggle it back so re-runs start clean.
    await mailboxClient
      .setKmailAsImportant(buildSetImportantPayload([kmailID]), { token })
      .catch(() => undefined);

    expect(
      present,
      `kmailID ${kmailID} was flagged important (HTTP ${flag.status()}) but did not appear in the Important folder. A flag that reports success yet does not land the mail in its folder means the Important view silently loses flagged mail — the folder is decorative.`
    ).toBe(true);
  });
});

/* =========================================================================================
 * POST /v2/common/deleteKmailWithDeletedBy
 * ====================================================================================== */
test.describe('POST /v2/common/deleteKmailWithDeletedBy @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.deleteKmailWithDeletedBy,
    repro: `await mailboxClient.deleteKmailWithDeletedBy(buildDeleteKmailPayload(), { token });`,
  };

  test('[1] happy path: a delete satisfies the contract', async ({ mailboxClient, token }) => {
    const payload = buildDeleteKmailPayload();
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 204, 400, 401, 403, 404]
    );
  });

  test('[2] validation: a delete with no transactionIDs must be refused', async ({
    mailboxClient,
    token,
  }) => {
    // The most dangerous case here. A delete reading an absent `transactionIDs` as an unrestricted
    // WHERE clause empties the caller's whole mailbox in one request — reachable by a client bug
    // that forgets to populate the array.
    const response = await mailboxClient.deleteKmailWithDeletedBy({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'a delete was submitted with no transactionIDs',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[3] validation: an empty transactionIDs array must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDeleteKmailPayload([]);
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'transactionIDs was an empty array on a delete',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[4] validation: a null transactionIDs must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDeleteKmailPayload([], { transactionIDs: null });
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "transactionIDs" set to null on a delete',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[5] validation: a wildcard transaction id must not delete everything', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildDeleteKmailPayload([], { transactionIDs: ['%'] });
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'transactionIDs contained the SQL wildcard "%" on a delete',
        severity: 'Critical',
      },
      [400, 401, 403, 422]
    );
  });

  test('[6] IDOR: another user\'s transaction rows must not be deletable', async ({
    mailboxClient,
    token,
  }) => {
    // A KmailTransaction is one recipient's copy. Deleting someone else's row hides their mail from
    // them — destructive, silent, no notification to the owner.
    const payload = buildDeleteKmailPayload([FOREIGN.transactionID]);
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.transactionID,
      what: 'transactionID on a delete',
    });
  });

  test('[7] IDOR: a body kpostUser must not delete in another mailbox', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const payload = buildDeleteKmailPayload([nonExistentTransactionId()], {
      kpostUser: FOREIGN.victimKpostID,
    });
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser on a delete',
    });
  });

  test('[8] the delete must be per-user, not global', async ({ mailboxClient, token }) => {
    // Documented as a soft delete stamping a deleted-by marker on the caller's own transaction row.
    // Deleting your copy must not delete the sender's, or a recipient can erase a mail from the
    // sender's Sent folder. Asserted through the response (bench has one set of credentials): a
    // response reporting rows affected beyond the caller's own is the observable signal.
    const payload = buildDeleteKmailPayload([nonExistentTransactionId()]);
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'delete returned no parseable body');

    expect(
      /"(deletedForAll|hardDelete|purged)"\s*:\s*true/i.test(text),
      `the delete response reports a global or hard deletion. This route is documented as a per-user soft delete that stamps a deleted-by marker on the caller's own transaction rows; a delete that removes the underlying mail takes it out of every other recipient's mailbox and out of the sender's Sent folder. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[9] idempotency: deleting twice must not fault', async ({ mailboxClient, token }) => {
    const payload = buildDeleteKmailPayload();
    await mailboxClient.deleteKmailWithDeletedBy(payload, { token });
    const second = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    expect(
      second.status(),
      `deleting the same transaction twice produced HTTP ${second.status()}. A retry after a dropped connection is routine and the second call must be a no-op.`
    ).toBeLessThan(500);
  });

  test('[10] type mismatch: kmailIDs where transactionIDs belong must not delete', async ({
    mailboxClient,
    token,
  }) => {
    // `kmailID` and `transactionID` are both bigints from adjacent tables, so passing one where the
    // other belongs is type-correct but semantically wrong — if the service does not distinguish
    // them, it deletes a row the caller never named.
    const payload = buildDeleteKmailPayload([], { transactionIDs: [FOREIGN.kmailID] });
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'a kmailID passed where a transactionID belongs',
    });
  });

  test('[11] boundary: an unbounded delete batch must be capped', async ({
    mailboxClient,
    token,
  }) => {
    const transactionIDs = Array.from({ length: 5000 }, (_unused, index) => 996_000_000 + index);
    const payload = buildDeleteKmailPayload(transactionIDs);
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token });

    expect(
      response.status(),
      `a 5000-entry delete batch produced HTTP ${response.status()}. An uncapped destructive batch is both a lock-duration problem and a way to empty a mailbox in one call; it must be refused with a stated limit.`
    ).toBeLessThan(500);
  });

  test('[12] structural: malformed JSON must be a clean 400', async ({ mailboxClient, token }) => {
    const malformed = '{"transactionIDs":[';
    const response = await mailboxClient.sendRaw(
      MAILBOX_PATHS.deleteKmailWithDeletedBy,
      malformed,
      { token }
    );

    await assertStatus(response, [400, 401, 403, 415, 422], {
      ...META,
      body: malformed,
      repro: `await mailboxClient.sendRaw(path, '${malformed}', { token });`,
      title: 'Malformed JSON is not rejected with a clean 400',
    });
  });

  test('[13] auth: an anonymous caller must not delete mail', async ({ mailboxClient }) => {
    const payload = buildDeleteKmailPayload();
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[14] auth: a malformed token must not delete mail', async ({ mailboxClient }) => {
    const payload = buildDeleteKmailPayload();
    const response = await mailboxClient.deleteKmailWithDeletedBy(payload, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * Clear follow-up status
 * ====================================================================================== */
test.describe('Clearing follow-up status @audit', () => {
  test('[clear] happy path: clearing selected mail satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfKmailsContacts,
      repro: `await mailboxClient.clearStatusOfKmailsContacts(buildClearStatusPayload(), { token });`,
    };
    const payload = buildClearStatusPayload();
    const response = await mailboxClient.clearStatusOfKmailsContacts(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 204, 400, 401, 403]
    );
  });

  test('[clear] IDOR: another user\'s follow-up status must not be clearable', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfKmailsContacts,
      repro: `await mailboxClient.clearStatusOfKmailsContacts({ kmailIDs: [<foreign>] }, { token });`,
    };
    const payload = buildClearStatusPayload({ kmailIDs: [FOREIGN.kmailID] });
    const response = await mailboxClient.clearStatusOfKmailsContacts(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on a clear-status write',
    });
  });

  test('[clear] validation: an unknown status flag must be refused', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfKmailsContacts,
      repro: `await mailboxClient.clearStatusOfKmailsContacts({ kmailStatusFlag: 99 }, { token });`,
    };
    const payload = buildClearStatusPayload({ kmailStatusFlag: 99 });
    const response = await mailboxClient.clearStatusOfKmailsContacts(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'kmailStatusFlag 99 is not one of the documented buckets',
        severity: 'Minor',
      },
      [400, 401, 403, 422]
    );
  });

  test('[clearAll] the unbounded clear must still name a bucket', async ({
    mailboxClient,
    token,
  }) => {
    // `clearStatusOfAllKmailsContacts` is the only genuinely unbounded write: one call, no
    // identifiers, clears the whole bucket. It cannot be "must be refused" — it must require a
    // bucket. Without `kmailStatusFlag`, "clear my reply-not-received list" becomes "clear every
    // follow-up state I have".
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfAllKmailsContacts,
      repro: `await mailboxClient.clearStatusOfAllKmailsContacts({}, { token });`,
    };
    const response = await mailboxClient.clearStatusOfAllKmailsContacts({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'the clear-all write was submitted with no bucket named',
        severity: 'Major',
      },
      [400, 401, 403, 422]
    );
  });

  test('[clearAll] IDOR: a body kpostUser must not clear another user\'s buckets', async ({
    mailboxClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfAllKmailsContacts,
      repro: `await mailboxClient.clearStatusOfAllKmailsContacts({ kpostUser: '<victim>' }, { token });`,
    };
    const payload = buildCommonPayload({
      kpostUser: FOREIGN.victimKpostID,
      kmailStatusFlag: KMAIL_STATUS_FLAG.replyNotReceived,
      selectMailType: FETCH_MAIL_TYPE.all,
    });
    const response = await mailboxClient.clearStatusOfAllKmailsContacts(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostUser on an unbounded clear-all write',
    });
  });

  test('[clearAll] auth: an anonymous caller must not clear anything', async ({
    mailboxClient,
  }) => {
    const response = await mailboxClient.clearStatusOfAllKmailsContacts(
      buildCommonPayload({ kmailStatusFlag: KMAIL_STATUS_FLAG.replyNotReceived }),
      { token: null }
    );

    await assertUnauthorized(response, {
      method: 'POST',
      path: MAILBOX_PATHS.clearStatusOfAllKmailsContacts,
      repro: `await mailboxClient.clearStatusOfAllKmailsContacts(payload, { token: null });`,
    });
  });

  test('[replyNotRequiredBySender] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.replyNotRequiredBySender,
      repro: `await mailboxClient.replyNotRequiredBySender(buildCommonPayload(), { token });`,
    };
    const payload = buildReplyNotRequiredPayload({ kmailIDs: [nonExistentKmailId()] });
    const response = await mailboxClient.replyNotRequiredBySender(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 204, 400, 401, 403]
    );
  });

  test('[replyNotRequiredBySender] IDOR: another user\'s thread must not be dismissible', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.replyNotRequiredBySender,
      repro: `await mailboxClient.replyNotRequiredBySender({ kmailIDs: [<foreign>] }, { token });`,
    };
    const payload = buildCommonPayload({ kmailIDs: [FOREIGN.kmailID] });
    const response = await mailboxClient.replyNotRequiredBySender(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on a reply-obligation write',
    });
  });

  test('[replyNotRequiredByReceiver] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.replyNotRequiredByReceiver,
      repro: `await mailboxClient.replyNotRequiredByReceiver(buildCommonPayload(), { token });`,
    };
    const payload = buildReplyNotRequiredPayload({ kmailIDs: [nonExistentKmailId()] });
    const response = await mailboxClient.replyNotRequiredByReceiver(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 204, 400, 401, 403]
    );
  });

  test('[replyNotRequiredByReceiver] the two sides must not be interchangeable', async ({
    mailboxClient,
    token,
  }) => {
    // Sender-side ("I don't need a reply") and receiver-side ("I don't owe a reply") dismissal are
    // separate endpoints. If either accepts the other's role, a sender can clear a recipient's
    // obligation, removing the mail from their to-answer list without them seeing it.
    const payload = buildReplyNotRequiredPayload({ kmailIDs: [nonExistentKmailId()] });
    const [bySender, byReceiver] = await Promise.all([
      mailboxClient.replyNotRequiredBySender(payload, { token }),
      mailboxClient.replyNotRequiredByReceiver(payload, { token }),
    ]);

    const [senderBody, receiverBody] = await Promise.all([readBody(bySender), readBody(byReceiver)]);
    test.skip(
      !bySender.ok() || !byReceiver.ok(),
      'neither dismissal succeeded on this environment — nothing to compare'
    );

    expect(
      senderBody.text.replace(/\d{10,}/g, '<ts>') === receiverBody.text.replace(/\d{10,}/g, '<ts>'),
      `the sender-side and receiver-side reply dismissals returned byte-identical responses for the same mail. They are separate endpoints because they act on different parties' obligations; if they are aliases, a sender can clear a recipient's to-answer list.`
    ).toBe(false);
  });

  test('[kmailGroupReadStatus] happy path satisfies the contract', async ({
    mailboxClient,
    token,
  }) => {
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.kmailGroupReadStatus,
      repro: `await mailboxClient.kmailGroupReadStatus(buildGroupReadStatusPayload(), { token });`,
    };
    const payload = buildGroupReadStatusPayload();
    const response = await mailboxClient.kmailGroupReadStatus(payload, { token });

    await expectValidContract(
      response,
      kmailEnvelopeSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[kmailGroupReadStatus] IDOR: read receipts for another user\'s group mail', async ({
    mailboxClient,
    token,
  }) => {
    // Per-member read status is a read-receipt list: who opened the mail and, by omission, who did
    // not — a behavioural profile of the group that only the sender is entitled to.
    const META = {
      method: 'POST',
      path: MAILBOX_PATHS.kmailGroupReadStatus,
      repro: `await mailboxClient.kmailGroupReadStatus({ kmailID: <foreign> }, { token });`,
    };
    const payload = buildGroupReadStatusPayload(FOREIGN.kmailID);
    const response = await mailboxClient.kmailGroupReadStatus(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on a group read-status query',
    });
  });

  test('[kmailGroupReadStatus] an anonymous caller must be refused', async ({ mailboxClient }) => {
    const response = await mailboxClient.kmailGroupReadStatus(buildGroupReadStatusPayload(), {
      token: null,
    });

    await assertUnauthorized(response, {
      method: 'POST',
      path: MAILBOX_PATHS.kmailGroupReadStatus,
      repro: `await mailboxClient.kmailGroupReadStatus(payload, { token: null });`,
    });
  });
});

/* =========================================================================================
 * POST /v2/common/convertMailAsPDF
 * ====================================================================================== */
test.describe('POST /v2/common/convertMailAsPDF @audit', () => {
  const META = {
    method: 'POST',
    path: MAILBOX_PATHS.convertMailAsPDF,
    repro: `await mailboxClient.convertMailAsPDF(buildPdfConvertPayload(), { token });`,
  };

  test('[1] happy path: a mail renders to a PDF', async ({ mailboxClient, token }) => {
    const payload = buildPdfConvertPayload();
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    await assertStatus(response, [200, 400, 401, 403], { ...META, body: payload });
  });

  test('[2] the response must be typed as a PDF, not as HTML', async ({ mailboxClient, token }) => {
    // This route renders caller-supplied HTML; if the result comes back as `text/html`, the browser
    // renders the input rather than downloading a document.
    const payload = buildPdfConvertPayload();
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    test.skip(!response.ok(), 'PDF conversion did not succeed on this environment');

    const contentType = response.headers()['content-type'] ?? '';
    expect(
      /application\/pdf|application\/octet-stream|application\/json/i.test(contentType),
      `the PDF export returned Content-Type "${contentType || '<absent>'}". This endpoint renders HTML supplied in the request body; served as text/html the browser executes that input instead of downloading a document.`
    ).toBe(true);
  });

  test('[3] XSS: script content must not survive into the rendered output', async ({
    mailboxClient,
    token,
  }) => {
    // Documented as stateless — renders exactly what it is given. So `kmailContent` is
    // attacker-controlled markup into an HTML-to-PDF renderer: the classic SSRF and local-file
    // disclosure path via `<img src="file:///...">` or an external stylesheet.
    const payload = buildPdfConvertPayload({ kmailContent: XSS_PAYLOAD });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[4] SSRF: an external reference in the body must not be fetched', async ({
    mailboxClient,
    token,
  }) => {
    // A renderer that resolves references runs inside the service's network and will fetch a
    // link-local metadata address the caller cannot reach. `169.254.169.254` is the canonical cloud
    // metadata endpoint; a `file://` reference is the local-disclosure variant.
    const payload = buildPdfConvertPayload({
      kmailContent:
        '<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/"><img src="file:///etc/passwd">',
    });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });
    const { text } = await readBody(response);

    expect(
      /AccessKeyId|SecretAccessKey|root:.*:0:0:/i.test(text),
      `the PDF renderer resolved an external reference and returned its content. This endpoint renders HTML supplied in the request body from inside the service's network, so a renderer that fetches references reaches the cloud metadata endpoint and the local filesystem — neither of which the caller can reach directly. Body: ${text.slice(0, 300)}`
    ).toBe(false);

    await assertNoInternalLeak(response, { ...META, body: payload }, '169.254.169.254');
  });

  test('[5] the export must not let the caller claim an arbitrary sender', async ({
    mailboxClient,
    token,
    callerKpostId,
  }) => {
    // The API documents `fromAddress` here as unvalidated against the caller's identity. This test
    // records the consequence: the output is a platform-branded PDF recording a mail that was never
    // sent, from a sender who never sent it.
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to name');

    const payload = buildPdfConvertPayload({
      fromAddress: FOREIGN.victimKpostID,
      kpostID: FOREIGN.victimKpostID,
      kmailSubject: qaLabel('forged-export'),
    });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    test.skip(!response.ok(), 'PDF conversion did not succeed on this environment');

    const { text } = await readBody(response);
    expect(
      text.includes(FOREIGN.victimKpostID),
      `the PDF export was generated attributing the mail to "${FOREIGN.victimKpostID}" while the caller was ${callerKpostId ?? 'a different identity'}. The API documents this field as unvalidated, so this is stated behaviour rather than a surprise — but the output is a platform-branded document recording a mail that was never sent, from a sender who never sent it. If that is intended, the export needs a visible marker saying it is caller-supplied.`
    ).toBe(false);
  });

  test('[6] validation: an empty body must be handled explicitly', async ({
    mailboxClient,
    token,
  }) => {
    const response = await mailboxClient.convertMailAsPDF({}, { token });

    expect(
      response.status(),
      `an empty body to the PDF converter produced HTTP ${response.status()}. With nothing to render it is a 400, not a fault.`
    ).toBeLessThan(500);
  });

  test('[7] boundary: an enormous body must be bounded', async ({ mailboxClient, token }) => {
    const payload = buildPdfConvertPayload({ kmailContent: `<p>${'x'.repeat(2_000_000)}</p>` });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    expect(
      response.status(),
      `a 2 MB HTML body produced HTTP ${response.status()}. PDF rendering is CPU- and memory-bound, so an uncapped input is a denial-of-service primitive that costs the caller one request.`
    ).toBeLessThan(500);
  });

  test('[8] boundary: deeply nested markup must not exhaust the renderer', async ({
    mailboxClient,
    token,
  }) => {
    // 5000 levels of nesting. A recursive-descent renderer blows its stack long before this.
    const nested = `${'<div>'.repeat(5000)}deep${'</div>'.repeat(5000)}`;
    const payload = buildPdfConvertPayload({ kmailContent: nested });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    expect(
      response.status(),
      `5000 levels of nested markup produced HTTP ${response.status()}. A renderer that recurses per element must bound the depth rather than exhausting its stack.`
    ).toBeLessThan(500);
  });

  test('[9] auth: an anonymous caller must not render a PDF', async ({ mailboxClient }) => {
    // Even though the route stores nothing, unauthenticated access makes it a free, CPU-expensive
    // HTML-to-PDF service that gets found and abused.
    const payload = buildPdfConvertPayload();
    const response = await mailboxClient.convertMailAsPDF(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[10] injection: a tautology in the subject must not leak internals', async ({
    mailboxClient,
    token,
  }) => {
    const payload = buildPdfConvertPayload({ kmailSubject: SQLI_PAYLOAD });
    const response = await mailboxClient.convertMailAsPDF(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });
});
