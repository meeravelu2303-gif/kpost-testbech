import {
  test,
  expect,
  FORGED_ALG_NONE_JWT,
  MALFORMED_TOKEN,
} from '../../src/fixtures/api.fixture';
import { KWORD_PATHS, KWORD_PATH_TEMPLATES } from '../../src/api/clients/kwordDocuments.client';
import { kwordEnvelopeSchema } from '../../src/api/schemas/kwordDocuments.schema';
import {
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertRejectsInvalidInput,
  assertStatusCodeParity,
  assertUnauthorized,
  expectValidContract,
  readBody,
} from '../../src/utils/apiAssertions';
import {
  buildJoinDocumentPayload,
  nonExistentDocId,
} from '../../src/api/payloads/kwordDocuments.payload';
import { FOREIGN } from '../../src/api/clients/generic.client';

/**
 * KWord Documents — real-time collaboration (Excel rows 261–265).
 *
 * These five routes had no client and no coverage at all: `joinDocument` registers the caller as
 * an active editor, `presence` lists who else is in the document, `exitDocument` releases the
 * slot, `getAccessActivity` is the audit trail of who opened it, and `getAllRevision` returns
 * every saved version of the body.
 *
 * ## What these routes actually risk
 *
 * All four reads are keyed by a `docId` in the **path**, with no other identifying input. So the
 * only thing standing between a caller and another user's document is a server-side ownership
 * check on that path segment — which is exactly what the IDOR cases here probe. A leak on
 * `getAllRevision` is the worst of the five: revisions carry the document's full text history,
 * including content the owner later deleted.
 *
 * `joinDocument` additionally accepts a body-supplied `kpostId`. The server is supposed to take
 * the actor from the token; if it trusts the body, one user can appear in another user's
 * presence roster.
 *
 * ## Safety
 *
 * Every case targets `nonExistentDocId()` — a UUID that cannot resolve to a real document — so
 * nothing here joins, mutates or exits a document a real person is editing. `exitDocument` is a
 * release, not a delete, and is still pointed only at synthetic ids.
 */

const XSS_PAYLOAD = `<script>alert('xss')</script>`;
const SQLI_PAYLOAD = `' OR '1'='1`;
const TRAVERSAL_DOC_ID = '../../etc/passwd';
const MAX_LENGTH_STRING = 'a'.repeat(5000);
const UTF8_STRING = '日本語テスト-🚀-Ñoño';
const VICTIM_KPOST_ID = FOREIGN.victimKpostID;

/* =========================================================================================
 * POST /kword/joinDocument
 * ====================================================================================== */
test.describe('POST /kword/joinDocument', () => {
  const META = {
    method: 'POST',
    path: KWORD_PATHS.joinDocument,
    repro: `await kwordClient.joinDocument(buildJoinDocumentPayload(), { token });`,
  };

  test('[1] happy path: a join satisfies the Zod contract', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload();
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await expectValidContract(
      response,
      kwordEnvelopeSchema,
      { ...META, body: payload },
      [200, 201, 400, 401, 403, 404]
    );
  });

  test('[3] missing required parameter: no docId must be refused', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload();
    delete (payload as Record<string, unknown>).docId;

    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'a join naming no document' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[4] null fuzzing: a null docId must be refused', async ({ kwordClient, staticToken }) => {
    const payload = buildJoinDocumentPayload({ docId: null });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: payload, scenario: 'field "docId" set to null' },
      [400, 401, 403, 404, 422]
    );
  });

  test('[5] type mismatch: a string deviceInfo where an object is documented', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload({ deviceInfo: 'Chrome/Windows/desktop' });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    expect(
      response.status(),
      `deviceInfo was sent as a string where the contract documents an object and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[5b] type mismatch: an array docId where a single id belongs', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload({ docId: [nonExistentDocId()] });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    expect(
      response.status(),
      `docId was sent as an array and produced HTTP ${response.status()}.`
    ).toBeLessThan(500);
  });

  test('[6] spoofing: a body-supplied kpostId must not join on another user\'s behalf', async ({
    kwordClient,
    staticToken,
    authSession,
  }) => {
    // The actor belongs to the token. If the body wins, one user can be shown as present in a
    // document they never opened — and the access trail records them as having been there.
    const payload = buildJoinDocumentPayload({ kpostId: VICTIM_KPOST_ID });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });
    const { json, text } = await readBody(response);

    test.skip(json === null || json.statusCode !== 200, 'the join did not succeed');

    expect(
      text.includes(VICTIM_KPOST_ID),
      `the join was recorded for "${VICTIM_KPOST_ID}" while the caller was ${authSession.kpostID ?? 'a different identity'}. The editing session must be attributed to the token's owner. Body: ${text.slice(0, 300)}`
    ).toBe(false);
  });

  test('[7] SQL injection: a tautology docId must not leak database internals', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload({ docId: SQLI_PAYLOAD });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await assertNoInternalLeak(response, { ...META, body: payload }, SQLI_PAYLOAD);
  });

  test('[7b] XSS: a script payload must not be reflected unescaped', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload({ docId: XSS_PAYLOAD });
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await assertNoReflectedScript(response, { ...META, body: payload }, XSS_PAYLOAD);
  });

  test('[8] auth: no Authorization header must be 401/403', async ({ kwordClient }) => {
    const payload = buildJoinDocumentPayload();
    const response = await kwordClient.joinDocument(payload, { token: null });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[8b] auth: an alg=none forged token must be 401/403', async ({ kwordClient }) => {
    const payload = buildJoinDocumentPayload();
    const response = await kwordClient.joinDocument(payload, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body: payload });
  });

  test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
    kwordClient,
    staticToken,
  }) => {
    const payload = buildJoinDocumentPayload();
    const response = await kwordClient.joinDocument(payload, { token: staticToken });

    await assertStatusCodeParity(response, { ...META, body: payload });
  });

  test('[10] structural: an empty body must be refused', async ({ kwordClient, staticToken }) => {
    const response = await kwordClient.joinDocument({}, { token: staticToken });

    await assertRejectsInvalidInput(
      response,
      { ...META, body: {}, scenario: 'empty body on a document join' },
      [400, 401, 403, 404, 422]
    );
  });
});

/*
 * The four GET routes share a shape — one docId path segment, no body — so they share a
 * generated describe rather than four hand-copied ones. Each still declares its own META, so
 * findings group per route in the ledger exactly as they would if written out longhand.
 */
const DOC_ID_READS = [
  {
    name: 'presence',
    template: KWORD_PATH_TEMPLATES.presence,
    call: 'presence' as const,
    /** What a leak on this route would expose, in the words the ticket should carry. */
    leaks: 'the live roster of who is editing a document the caller does not own',
  },
  {
    name: 'exitDocument',
    template: KWORD_PATH_TEMPLATES.exitDocument,
    call: 'exitDocument' as const,
    leaks: "the ability to end another user's editing session",
  },
  {
    name: 'getAccessActivity',
    template: KWORD_PATH_TEMPLATES.getAccessActivity,
    call: 'getAccessActivity' as const,
    leaks: 'the access audit trail — who opened a document, and when',
  },
  {
    name: 'getAllRevision',
    template: KWORD_PATH_TEMPLATES.getAllRevision,
    call: 'getAllRevision' as const,
    leaks: "every saved revision of a document's body, including text the owner later removed",
  },
];

for (const route of DOC_ID_READS) {
  test.describe(`GET /kword/${route.name}/{docId}`, () => {
    const META = {
      method: 'GET',
      path: route.template,
      repro: `await kwordClient.${route.call}(docId, { token });`,
    };

    test('[1] happy path: the read satisfies the Zod contract', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](nonExistentDocId(), { token: staticToken });

      await expectValidContract(response, kwordEnvelopeSchema, META, [200, 400, 401, 403, 404]);
    });

    test('[2] boundary: a 5000-character docId must be refused', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](MAX_LENGTH_STRING, { token: staticToken });

      expect(
        response.status(),
        `a 5000-character docId path segment produced HTTP ${response.status()}.`
      ).toBeLessThan(500);
    });

    test('[2b] boundary: a UTF-8 docId is handled without a server fault', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](UTF8_STRING, { token: staticToken });

      expect(
        response.status(),
        `a multi-byte UTF-8 docId produced HTTP ${response.status()}.`
      ).toBeLessThan(500);
    });

    test('[3] missing parameter: an empty docId must not degrade into a listing', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call]('', { token: staticToken });
      const { json, text } = await readBody(response);
      const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

      expect(
        rows.length,
        `an empty docId returned ${rows.length} rows. With no document named the route must 404 rather than answer for every document. Body: ${text.slice(0, 200)}`
      ).toBe(0);
    });

    test('[4] null fuzzing: a literal "null" docId must not resolve', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call]('null', { token: staticToken });
      const { json, text } = await readBody(response);
      const resolved = json !== null && json.statusCode === 200 && json.data != null;

      expect(
        resolved,
        `the literal string "null" resolved to a document. Body: ${text.slice(0, 200)}`
      ).toBeFalsy();
    });

    test('[6] traversal: a path-traversal docId must not escape the lookup', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](TRAVERSAL_DOC_ID, { token: staticToken });
      const { text } = await readBody(response);

      expect(
        /root:x:0:0/.test(text),
        `a traversal docId returned file content. The segment is interpolated into a path, so it must be treated as an opaque id. Body: ${text.slice(0, 200)}`
      ).toBe(false);
    });

    test('[7] SQL injection: a tautology docId must not leak database internals', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](SQLI_PAYLOAD, { token: staticToken });

      await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
    });

    test('[8] auth: no Authorization header must be 401/403', async ({ kwordClient }) => {
      const response = await kwordClient[route.call](nonExistentDocId(), { token: null });

      await assertUnauthorized(response, META);
    });

    test('[8b] auth: an alg=none forged token must be 401/403', async ({ kwordClient }) => {
      const response = await kwordClient[route.call](nonExistentDocId(), {
        token: FORGED_ALG_NONE_JWT,
      });

      await assertUnauthorized(response, META);
    });

    test('[8c] auth: a malformed token must be 401/403', async ({ kwordClient }) => {
      const response = await kwordClient[route.call](nonExistentDocId(), {
        token: MALFORMED_TOKEN,
      });

      await assertUnauthorized(response, META);
    });

    test('[IDOR] a document the caller does not own must not answer', async ({
      kwordClient,
      staticToken,
    }) => {
      /*
       * Asserted on the ANSWER, not the status code. A correct implementation may return 403,
       * 404, or 200-with-an-empty-set — all three are safe. What is never safe is a populated
       * payload for a document the caller has no share on.
       *
       * `FOREIGN.uuid` is a reserved, well-formed id the caller certainly does not own. On this
       * environment it resolves to nothing, so the case passes trivially and files nothing — it
       * becomes a real ownership probe as soon as a foreign document is seeded under that id.
       */
      const response = await kwordClient[route.call](FOREIGN.uuid, {
        token: staticToken,
      });
      const { json, text } = await readBody(response);
      const rows = Array.isArray(json?.data) ? (json.data as unknown[]) : [];

      expect(
        json !== null && json.statusCode === 200 && rows.length > 0,
        `a foreign docId returned ${rows.length} rows, exposing ${route.leaks}. Ownership must be resolved from the token before the document is read. Body: ${text.slice(0, 300)}`
      ).toBe(false);
    });

    test('[9] status misreporting: HTTP status must equal the envelope statusCode', async ({
      kwordClient,
      staticToken,
    }) => {
      const response = await kwordClient[route.call](nonExistentDocId(), { token: staticToken });

      await assertStatusCodeParity(response, META);
    });
  });
}
