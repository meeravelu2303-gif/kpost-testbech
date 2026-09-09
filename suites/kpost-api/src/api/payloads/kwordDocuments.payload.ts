import { faker } from '../../utils/dataGen';
import { qaIdentifier, qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the KWord Documents controller.
 *
 * `docId` defaults to a non-existent, QA-prefixed value. `delete` removes a document
 * together with its heading and content rows and invalidates every share of it, and
 * `deleteHeading` destroys the content stored beneath a heading — neither is reversible
 * through the API, so a builder must never default to a document that could be real.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** A document identifier that must not resolve to a real document. */
export function nonExistentDocId(): string {
  return `qa-nonexistent-doc-${faker.string.alphanumeric(10)}`;
}

export interface KwordDocumentRequest {
  [key: string]: unknown;
}

/** create — Excel: `{ titleOfDocument, subject, topic, subTopic }`. */
export function buildDocumentPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return {
    titleOfDocument: qaLabel('title'),
    subject: faker.lorem.sentence(),
    topic: 'Technology',
    subTopic: 'Machine Learning',
    ...overrides,
  };
}

/** A body addressing an existing document by id (for docId-keyed routes). */
export function buildDocumentActionPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return { docId: nonExistentDocId(), ...overrides };
}

/**
 * Content save. Excel: `{ docTitle, compose, docId }`. The editor's autosave loop drives this,
 * so it is the hottest write here.
 */
export function buildSaveContentPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return {
    docTitle: qaLabel('doc'),
    compose: faker.lorem.paragraphs(2),
    docId: nonExistentDocId(),
    ...overrides,
  };
}

/** Heading removal. Excel deleteHeading: `{ docId, headingId }`. */
export function buildDeleteHeadingPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return buildDocumentActionPayload({ headingId: 1, ...overrides });
}

/**
 * Document update. Excel: `{ docId, heading: [{ topic, children: [...] }] }` — `heading` is the
 * document's outline, a recursive tree of `{ topic, children }` nodes.
 */
export function buildUpdateHeadingPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return {
    docId: nonExistentDocId(),
    heading: [
      { topic: qaLabel('section'), children: [{ topic: qaLabel('subsection'), children: [] }] },
      { topic: qaLabel('section'), children: [] },
    ],
    ...overrides,
  };
}

/**
 * Share grant. Excel: `{ docId, kWordDocshares: [{ kpostId, role, validUpto }] }`. Outward-
 * facing — the named users gain access and are typically notified — so recipients default to
 * QA identities rather than faker-generated ones.
 */
export function buildSharePayload(
  recipients: string[] = [qaIdentifier('recipient')],
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return {
    docId: nonExistentDocId(),
    kWordDocshares: recipients.map((kpostId) => ({
      kpostId,
      role: 'editor',
      validUpto: Date.now() + 30 * 86_400_000,
    })),
    ...overrides,
  };
}

/** Join a collaborative document. Excel: `{ docId, kpostId, deviceInfo: { browser, os, deviceType } }`. */
export function buildJoinDocumentPayload(
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return {
    docId: nonExistentDocId(),
    kpostId: qaIdentifier('member'),
    deviceInfo: { browser: 'Chrome', os: 'Windows', deviceType: 'desktop' },
    ...overrides,
  };
}

/** KAD conversion toggle — the one route that does not stamp kpostID from the token. */
export function buildConvertToKadPayload(
  convertToKad: boolean,
  overrides: Record<string, unknown> = {}
): KwordDocumentRequest {
  return buildDocumentActionPayload({ convertToKad, ...overrides });
}
