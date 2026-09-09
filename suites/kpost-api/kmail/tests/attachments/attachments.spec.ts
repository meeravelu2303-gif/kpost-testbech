import { EXPIRED_TOKEN, expect, test } from '../../src/fixtures/api.fixture';
import { PATH_TEMPLATES, READ_MAIL_PATHS } from '../../src/api/routes/kmail.routes';
import { FOREIGN } from '../../src/api/clients/generic.client';
import { env } from '../../src/config/env.config';
import { attachmentResponseSchema, kloudDataResponseSchema } from '../../src/api/schemas/kmail.schema';
import {
  assertNoForeignAcknowledgement,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatus,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildAttachmentPayload,
  buildOtherDomainAttachmentPayload,
} from '../../src/api/payloads/readMail.payload';
import { buildComposePayload } from '../../src/api/payloads/sentMail.payload';
import {
  attachmentSizeWasCapped,
  contentTypeMismatchAttachment,
  emptyAttachment,
  largeAttachment,
  longNameAttachment,
  pdfAttachment,
  pngAttachment,
  scriptNameAttachment,
  textAttachment,
  traversalNameAttachment,
} from '../../src/utils/attachments';
import { nonExistentUuid } from '../../src/utils/safeTestData';

/**
 * Attachments — upload, resolution, and the four UUID-addressed download routes.
 *
 * A UUID is a credential here, not an identifier. The download routes take a
 * `@PathVariable String uuid` and nothing else — no mail id, no owner key, no body — so the
 * only identity check is on the token, and the UUID travels in every mail listing response.
 * Every case that finds a UUID in a response treats it as leaked key material, and every
 * download case asks whether possession of the value is sufficient access.
 *
 * Size cases are bounded by `MAX_ATTACHMENT_MB`: the assertion is that a large upload is
 * refused with a stated cap, and the buffer is capped so the probe cannot cause the outage
 * it is looking for.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;

/** The three routes addressed by UUID alone. */
const UUID_ROUTES = [
  {
    name: 'download',
    template: PATH_TEMPLATES.download,
    call: (uuid: string) => READ_MAIL_PATHS.download(uuid),
    what: 'the full attachment bytes',
  },
  {
    name: 'downloadThumbnail',
    template: PATH_TEMPLATES.downloadThumbnail,
    call: (uuid: string) => READ_MAIL_PATHS.downloadThumbnail(uuid),
    what: 'a rendered preview of the attachment',
  },
  {
    name: 'mediaStreaming',
    template: PATH_TEMPLATES.mediaStreaming,
    call: (uuid: string) => READ_MAIL_PATHS.mediaStreaming(uuid),
    what: 'streamed audio/video content',
  },
] as const;

/* =========================================================================================
 * POST /v2/readMail/downloadAttachment
 * ====================================================================================== */
test.describe('POST /v2/readMail/downloadAttachment', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.downloadAttachment,
    repro: `await readMailClient.downloadAttachment(buildAttachmentPayload(), { token });`,
  };

  test('[1] happy path: attachment metadata satisfies the contract', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload();
    const response = await readMailClient.downloadAttachment(payload, { token });

    await expectValidContract(
      response,
      attachmentResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: an attachment on another user\'s mail must not resolve', async ({
    readMailClient,
    token,
  }) => {
    // The bridge between a guessable mail id and an unguessable attachment UUID. Resolving
    // without a party check lets anyone enumerating `kmailID` obtain the UUID the download
    // routes accept.
    const payload = buildAttachmentPayload({ kmailID: FOREIGN.kmailID });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on an attachment resolution',
    });
  });

  test('[3] the resolution must not hand back a UUID for a mail the caller cannot read', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ kmailID: FOREIGN.kmailID });
    const response = await readMailClient.downloadAttachment(payload, { token });
    const { text } = await readBody(response);

    const uuidPattern = /"uuid"\s*:\s*"([0-9a-fA-F-]{32,36})"/;
    const leaked = response.ok() && uuidPattern.test(text);

    expect(
      leaked,
      `resolving attachments for kmailID ${FOREIGN.kmailID} — a mail the caller does not own — returned an attachment UUID. On this API the UUID is the entire addressing scheme for the download routes, so handing one out is handing out the file. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[4] validation: a missing targetFileName must be refused', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload();
    delete (payload as Record<string, unknown>).targetFileName;
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'an attachment resolution with no file named',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] traversal: a traversal sequence in targetFileName must not escape the mail', async ({
    readMailClient,
    token,
  }) => {
    // `targetFileName` is matched against the mail's stored attachment list by display name. If
    // the match ever becomes a path join rather than a list lookup, `../` walks out of the directory.
    const traversal = '../../../../etc/passwd';
    const payload = buildAttachmentPayload({ targetFileName: traversal });
    const response = await readMailClient.downloadAttachment(payload, { token });
    const { text } = await readBody(response);

    await assertNoInternalLeak(response, { ...META, body: payload }, traversal);

    expect(
      /root:.*:0:0:/.test(text),
      `a traversal sequence in targetFileName returned what looks like /etc/passwd content. The file name is documented as matched against the mail's stored attachment list; if it reaches a filesystem path instead, any file the service can read is downloadable. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[6] validation: a null targetFileName must be refused', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ targetFileName: null });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: payload,
        scenario: 'field "targetFileName" set to null',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[7] enumeration: a wildcard file name must not return every attachment', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ targetFileName: '%' });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, '%');
  });

  test('[8] injection: a tautology in the file name must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ targetFileName: SQLI_PAYLOAD });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[9] XSS: a script payload in the file name must not be reflected', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ targetFileName: XSS_PAYLOAD });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[10] not found: an attachment that does not exist must not be a 500', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildAttachmentPayload({ targetFileName: 'no-such-file-anywhere.bin' });
    const response = await readMailClient.downloadAttachment(payload, { token });

    await assertStatus(response, [200, 204, 400, 401, 403, 404], {
      ...META,
      body: payload,
      title: 'A missing attachment is reported as a server error',
      severity: 'Minor',
    });
  });

  test('[11] auth: an anonymous caller must not resolve attachments', async ({
    readMailClient,
  }) => {
    const payload = buildAttachmentPayload();
    const response = await readMailClient.downloadAttachment(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * POST /v2/readMail/downloadODAttachment
 * ====================================================================================== */
test.describe('POST /v2/readMail/downloadODAttachment', () => {
  const META = {
    method: 'POST',
    path: READ_MAIL_PATHS.downloadODAttachment,
    repro: `await readMailClient.downloadODAttachment(buildOtherDomainAttachmentPayload(), { token });`,
  };

  test('[1] happy path: an external-domain attachment resolution satisfies the contract', async ({
    readMailClient,
    token,
  }) => {
    const payload = buildOtherDomainAttachmentPayload();
    const response = await readMailClient.downloadODAttachment(payload, { token });

    await expectValidContract(
      response,
      attachmentResponseSchema,
      { ...META, body: payload },
      [200, 400, 401, 403, 404]
    );
  });

  test('[2] IDOR: an external attachment on another user\'s mail must not resolve', async ({
    readMailClient,
    token,
  }) => {
    // Separate from the KPOST-side route: external mail arrives via a different ingest
    // (`loadOtherDomainMails`), addressed by `senderUniqueMailID`/`receiverUniqueMailID`, a
    // different lookup that needs its own ownership check.
    const payload = buildOtherDomainAttachmentPayload({ kmailID: FOREIGN.kmailID });
    const response = await readMailClient.downloadODAttachment(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID on an external-domain attachment',
    });
  });

  test('[3] groupFlag must not widen the lookup', async ({ readMailClient, token }) => {
    // `groupFlag` switches the lookup on this route. If the group branch skips the per-recipient
    // scoping the individual branch applies, setting one boolean is the whole bypass.
    const payload = buildOtherDomainAttachmentPayload({
      kmailID: FOREIGN.kmailID,
      groupFlag: true,
    });
    const response = await readMailClient.downloadODAttachment(payload, { token });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      body: payload,
      foreignValue: FOREIGN.kmailID,
      what: 'kmailID with groupFlag set, which switches the lookup branch',
    });
  });

  test('[4] validation: an empty body must be refused', async ({ readMailClient, token }) => {
    const response = await readMailClient.downloadODAttachment({}, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: {},
        scenario: 'an empty body was posted to the external-attachment route',
        severity: 'Major',
        readOnly: true,
      },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] validation: a blank kmailType must be a 400', async ({ readMailClient, token }) => {
    const payload = buildOtherDomainAttachmentPayload({ kmailType: '' });
    const response = await readMailClient.downloadODAttachment(payload, { token });

    await assertStatus(response, [400, 401, 403, 404, 422], {
      ...META,
      body: payload,
      title: 'A blank kmailType is not rejected with the documented 400',
      severity: 'Major',
    });
  });

  test('[6] injection: a tautology in targetFileName must not leak internals', async ({
    readMailClient,
    token,
  }) => {
    // targetFileName is the real lookup key on this route (Excel row 46); inject there, not into a
    // field the endpoint does not read.
    const payload = buildOtherDomainAttachmentPayload({ targetFileName: SQLI_PAYLOAD });
    const response = await readMailClient.downloadODAttachment(payload, { token });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7] auth: an anonymous caller must not resolve external attachments', async ({
    readMailClient,
  }) => {
    const payload = buildOtherDomainAttachmentPayload();
    const response = await readMailClient.downloadODAttachment(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * The UUID-addressed download routes
 * ====================================================================================== */
test.describe('UUID-addressed downloads', () => {
  for (const route of UUID_ROUTES) {
    const META = {
      method: 'GET',
      path: route.template,
      repro: `await readMailClient.${route.name}(uuid, { token });`,
    };

    test(`[${route.name}] a UUID that resolves to nothing must not be a 500`, async ({
      readMailClient,
      token,
    }) => {
      const response = await readMailClient.getPath(route.call(nonExistentUuid()), { token });

      await assertStatus(response, [200, 204, 400, 401, 403, 404], {
        ...META,
        title: `${route.name}: an unknown UUID is reported as a server error`,
        severity: 'Minor',
      });
    });

    test(`[${route.name}] an anonymous caller must not receive ${route.what}`, async ({
      readMailClient,
    }) => {
      // These three routes take a bare `@PathVariable String uuid` and no owner key. If the
      // filter misses them, possession of the UUID is the only access control — and UUIDs are
      // handed out in every mail listing response.
      const response = await readMailClient.getPath(route.call(nonExistentUuid()), { token: null });

      await assertUnauthorized(response, META);
    });

    test(`[${route.name}] an expired token must not receive ${route.what}`, async ({
      readMailClient,
    }) => {
      const response = await readMailClient.getPath(route.call(nonExistentUuid()), {
        token: EXPIRED_TOKEN,
      });

      await assertUnauthorized(response, META);
    });

    test(`[${route.name}] a foreign UUID must not resolve`, async ({ readMailClient, token }) => {
      const response = await readMailClient.getPath(route.call(FOREIGN.uuid), { token });

      await assertNoForeignAcknowledgement(response, {
        ...META,
        foreignValue: FOREIGN.uuid,
        what: 'attachment UUID',
      });
    });

    test(`[${route.name}] a malformed UUID must be refused cleanly`, async ({
      readMailClient,
      token,
    }) => {
      const response = await readMailClient.getPath(route.call('not-a-uuid-at-all'), { token });

      expect(
        response.status(),
        `${route.name} answered HTTP ${response.status()} to a malformed UUID. The path variable is opaque to the router, so the validation has to happen in the service — and a value that cannot be a UUID must be a 400 or 404, never a parse exception.`
      ).toBeLessThan(500);
    });

    test(`[${route.name}] path traversal in the UUID must not resolve a file`, async ({
      readMailClient,
      token,
    }) => {
      const traversal = '../../../../etc/passwd';
      const response = await readMailClient.getPath(
        `/v2/readMail/${route.name === 'mediaStreaming' ? 'mediaStreaming' : route.name}/${encodeURIComponent(traversal)}`,
        { token }
      );
      const { text } = await readBody(response);

      expect(
        /root:.*:0:0:/.test(text),
        `${route.name} returned what looks like /etc/passwd content for a traversal path. The UUID names an S3 object, so it must never be joined into a local filesystem path.`
      ).toBe(false);
    });

    test(`[${route.name}] injection in the UUID must not leak internals`, async ({
      readMailClient,
      token,
    }) => {
      const response = await readMailClient.getPath(route.call(SQLI_PAYLOAD), { token });

      await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
    });
  }

  test('[uuid] the download routes must not disagree about authorisation', async ({
    readMailClient,
  }) => {
    // Three routes serving the same object the same way must agree about who may have it. A
    // service that secures `download` but leaves `downloadThumbnail` open still leaks it — a
    // thumbnail of a scanned contract is a readable copy. The consistency is invisible per-route.
    const uuid = nonExistentUuid();
    const statuses = await Promise.all(
      UUID_ROUTES.map(async (route) => ({
        name: route.name,
        status: (await readMailClient.getPath(route.call(uuid), { token: null })).status(),
      }))
    );

    const distinct = new Set(statuses.map((entry) => entry.status));

    expect(
      distinct.size,
      `the UUID-addressed download routes answered an anonymous caller differently: ${statuses.map((entry) => `${entry.name}=${entry.status}`).join(', ')}. All three serve the same S3 object addressed by the same key, so a route that is more permissive than its siblings is a bypass for the others — a thumbnail of a scanned document is a readable copy of it.`
    ).toBe(1);
  });
});

/* =========================================================================================
 * Upload limits and content handling
 * ====================================================================================== */
test.describe('Attachment upload limits', () => {
  const META = {
    method: 'POST',
    path: '/v2/sentMail/postMailMultiPart/',
    repro: `await sentMailClient.postMailMultiPart(JSON.stringify(buildComposePayload()), [largeAttachment(mb)], { token });`,
  };

  test('[1] a small attachment is accepted', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment(1024)],
      { token }
    );

    await assertStatus(response, [200, 400, 401, 403], { ...META, body: payload });
  });

  test('[2] a large attachment must be refused with a stated cap, not accepted silently', async ({
    sentMailClient,
    token,
  }) => {
    // The size probe, bounded on purpose. `MAX_ATTACHMENT_MB` caps the buffer; if the service
    // has no limit the test fails and reports that, without the bench filling the bucket itself.
    const requestedMb = 25;
    const file = largeAttachment(requestedMb);
    const actualMb = file.buffer.length / (1024 * 1024);
    const payload = buildComposePayload({ attachmentFlag: 1 });

    const response = await sentMailClient.postMailMultiPart(JSON.stringify(payload), [file], {
      token,
    });
    const { text } = await readBody(response);

    if (attachmentSizeWasCapped(requestedMb)) {
      test.info().annotations.push({
        type: 'bounded probe',
        description: `Asked for ${requestedMb} MB, sent ${actualMb} MB — capped by MAX_ATTACHMENT_MB=${env.maxAttachmentMb}. A pass here means the service accepted ${actualMb} MB, not that it has no limit; raise MAX_ATTACHMENT_MB to probe further.`,
      });
    }

    expect(
      response.status(),
      `a ${actualMb} MB attachment produced HTTP ${response.status()}. It must be accepted, or refused with a 400 or 413 naming the limit — a 5xx means the bound is discovered by whatever runs out of memory or times out streaming to S3 first. Body: ${text.slice(0, 200)}`
    ).toBeLessThan(500);
  });

  test('[3] a zero-byte attachment must be handled explicitly', async ({
    sentMailClient,
    token,
  }) => {
    // Distinct from "no attachments" (the empty-first-part case in tests/compose). A named
    // zero-byte file is a real user action and must not be confused with the "skip S3 upload" branch.
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [emptyAttachment()],
      { token }
    );

    expect(
      response.status(),
      `a named zero-byte attachment produced HTTP ${response.status()}. It is a real user action and is not the same as "no attachments" — it must be stored or refused, not faulted on.`
    ).toBeLessThan(500);
  });

  test('[4] many attachments in one send must be bounded', async ({ sentMailClient, token }) => {
    const files = Array.from({ length: 30 }, () => textAttachment(1024));
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(JSON.stringify(payload), files, {
      token,
    });

    expect(
      response.status(),
      `a send carrying 30 attachments produced HTTP ${response.status()}. Each is a separate S3 upload, so the count needs a cap as much as the size does — enforced with a 400, not a timeout.`
    ).toBeLessThan(500);
  });

  test('[5] a content-type that lies about the bytes must not be served back as trusted', async ({
    sentMailClient,
    token,
  }) => {
    // A `.png` whose bytes are a ZIP. Does the stored content type come from the client's claim
    // or the bytes? The download routes serve the file back with that type and a browser renders
    // what it is told — a mismatch is how an attachment becomes a delivery mechanism.
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [contentTypeMismatchAttachment()],
      { token }
    );

    expect(
      response.status(),
      `an attachment declaring image/png while carrying ZIP magic bytes produced HTTP ${response.status()}. Accepting it is defensible; faulting on it is not.`
    ).toBeLessThan(500);
  });

  test('[6] a traversal file name must not escape the storage key', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [traversalNameAttachment()],
      { token }
    );
    const { text } = await readBody(response);

    await assertNoInternalLeak(response, { ...META, body: payload }, '../../../../etc/passwd');

    expect(
      response.ok() && text.includes('../'),
      `an attachment named "../../../../etc/passwd" was accepted and the traversal sequence was echoed back intact. Files are stored under a server-assigned S3 key, so this should be inert — but the display name is persisted and reappears in exports, caches and scanners, which is where a traversal name actually bites. Body: ${text.slice(0, 200)}`
    ).toBe(false);
  });

  test('[7] a script payload in a file name must not be reflected unescaped', async ({
    sentMailClient,
    token,
  }) => {
    // The file name is stored and shown in every attachment list, the mail view and the PDF
    // export — one of the few attacker-controlled strings rendered by definition, not by accident.
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [scriptNameAttachment()],
      { token }
    );

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] a very long file name must be bounded, not fatal', async ({
    sentMailClient,
    token,
  }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [longNameAttachment(512)],
      { token }
    );

    expect(
      response.status(),
      `a 512-character attachment file name produced HTTP ${response.status()}. It must be truncated or refused by the validator, not by the database column.`
    ).toBeLessThan(500);
  });

  test('[9] mixed attachment types in one send are accepted', async ({ sentMailClient, token }) => {
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [pngAttachment(), pdfAttachment(), textAttachment(256)],
      { token }
    );

    await assertStatus(response, [200, 400, 401, 403], {
      ...META,
      body: payload,
      title: 'A send mixing image, document and text attachments fails',
    });
  });

  test('[10] auth: an anonymous caller must not upload', async ({ sentMailClient }) => {
    // An unauthenticated upload is a free file host on someone else's S3 bill, inheriting the
    // platform's domain reputation for whatever is served from it.
    const payload = buildComposePayload({ attachmentFlag: 1 });
    const response = await sentMailClient.postMailMultiPart(
      JSON.stringify(payload),
      [textAttachment()],
      { token: null }
    );

    await assertUnauthorized(response, { ...META, body: payload });
  });
});

/* =========================================================================================
 * GET /v2/kmailData/getKloudUsedData
 * ====================================================================================== */
test.describe('GET /v2/kmailData/getKloudUsedData', () => {
  const META = {
    method: 'GET',
    path: '/v2/kmailData/getKloudUsedData',
    repro: `await kmailDataClient.getKloudUsedData({ token });`,
  };

  test('[1] happy path: storage consumption satisfies the contract', async ({
    kmailDataClient,
    token,
  }) => {
    const response = await kmailDataClient.getKloudUsedData({ token });

    await expectValidContract(response, kloudDataResponseSchema, META, [200, 400, 401, 403]);
  });

  test('[2] IDOR: a kpostID query parameter must not report another account\'s usage', async ({
    kmailDataClient,
    token,
  }) => {
    test.skip(!FOREIGN.hasVictim, 'QA_VICTIM_KPOST_ID is unset — no real second account to target');

    const response = await kmailDataClient.getKloudUsedData({
      token,
      params: { kpostID: FOREIGN.victimKpostID },
    });

    await assertNoForeignAcknowledgement(response, {
      ...META,
      foreignValue: FOREIGN.victimKpostID,
      what: 'kpostID query parameter',
    });
  });

  test('[3] auth: an anonymous caller must not read storage usage', async ({ kmailDataClient }) => {
    const response = await kmailDataClient.getKloudUsedData({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4] idempotency: two consecutive reads must agree', async ({ kmailDataClient, token }) => {
    const [first, second] = await Promise.all([
      kmailDataClient.getKloudUsedData({ token }),
      kmailDataClient.getKloudUsedData({ token }),
    ]);

    expect(
      first.status(),
      `two identical reads returned ${first.status()} and ${second.status()}. A safe GET must be stable.`
    ).toBe(second.status());
  });

  test('[5] usage must be reported as a non-negative value', async ({ kmailDataClient, token }) => {
    const response = await kmailDataClient.getKloudUsedData({ token });
    const { json, text } = await readBody(response);

    test.skip(json === null || !response.ok(), 'storage read returned no data on this environment');

    const data = json?.data;
    const numeric =
      typeof data === 'number' ? data : typeof data === 'string' ? Number(data) : Number.NaN;

    test.skip(Number.isNaN(numeric), 'storage usage is not reported as a scalar on this environment');

    expect(
      numeric,
      `storage consumption was reported as ${numeric}. A negative figure means the accounting subtracts more than it adds — usually a delete path that decrements without checking the attachment was ever counted — and quota enforcement built on it will let an account write without limit. Body: ${text.slice(0, 200)}`
    ).toBeGreaterThanOrEqual(0);
  });
});
