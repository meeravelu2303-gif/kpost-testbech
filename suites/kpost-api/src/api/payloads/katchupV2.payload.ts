import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for Katchup Messaging V2 (`/v2/katchup/**`).
 *
 * **Katchup delivers real messages and real push notifications to real people.** That governs
 * every default here:
 *
 *  - `receiver` is always a **synthetic, non-existent kpostID**. A faker-generated identity
 *    could collide with a live subscriber, and this suite fires the send routes hundreds of
 *    times per run.
 *  - `sendBulkKatchupMsg*` is described by the API's own docs as "the highest fan-out write in
 *    the API" — one request delivers to every recipient and raises a push for each, and it
 *    cannot be undone in one action. Recipient lists here are capped at two synthetic
 *    identities, and the bulk-size probes assert the *limit* rather than trying to exceed it
 *    against real accounts.
 *  - `msgID` and `uuid` default to values that cannot resolve to a real message or
 *    attachment. `deleteKatchUpMessage` and `recallMessage` act on whatever they match.
 *  - Message bodies carry a `qaLabel` so anything that does land is obviously test traffic.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>`: the fuzzing suites submit
 * wrong-typed values deliberately, which a strict override type would forbid.
 */

/** A well-formed kpostID that is not a real subscriber. */
export function syntheticReceiver(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@kpostindia.com`;
}

/** A message id that must not resolve to a real message. */
export function nonExistentMsgId(): number {
  return 995_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** An attachment UUID that must not resolve to a real object. */
export function nonExistentUuid(): string {
  return faker.string.uuid();
}

/** Epoch millis, the format the message routes use for timestamps. */
export function messageTime(offsetMinutes = 0): number {
  return Date.now() + offsetMinutes * 60_000;
}

/**
 * The `KatchupMessageRO` DTO — the workhorse of this controller.
 *
 * `sender` is deliberately **not** set by default. Every send route is supposed to overwrite
 * it from the bearer token, so a builder that supplied one would mask the spoofing tests. The
 * cases that probe it pass `sender` explicitly.
 */
export function buildKatchupMessagePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = messageTime();
  return {
    receiver: syntheticReceiver(),
    messageType: 0,
    subject: qaLabel('katchup'),
    actualMessage: `${qaLabel('body')} ${faker.lorem.sentence()}`,
    status: 0,
    messageTime: now,
    serverTime: now,
    sessionID: `QA-${faker.string.alphanumeric(8)}`,
    deviceID: faker.string.uuid(),
    groupFlag: false,
    isHtml: false,
    isVanished: false,
    temporaryMsgID: 0,
    ...overrides,
  };
}

/** A message addressing an existing row. Defaults to a non-existent msgID. */
export function buildExistingMessagePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildKatchupMessagePayload({ msgID: nonExistentMsgId(), ...overrides });
}

/**
 * A bulk send.
 *
 * Capped at two synthetic recipients on purpose: this is the highest fan-out write in the
 * API and each recipient receives a push notification.
 */
export function buildBulkMessagePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildKatchupMessagePayload({
    receiverList: [syntheticReceiver(), syntheticReceiver()],
    messageType: 19,
    subject: qaLabel('bulk'),
    ...overrides,
  });
}

/**
 * The `FetchKatchupRO` DTO — search, fetch, mark, recall and delete.
 *
 * Like the message DTO, `sender` is left unset: the controller assigns it from the token on
 * every route that uses this shape, and the ownership tests supply it explicitly to prove
 * the body value is ignored.
 */
export function buildFetchKatchupPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    selectedContact: syntheticReceiver(),
    groupFlag: false,
    ...overrides,
  };
}

/** A fetch addressing a specific message. Defaults to a non-existent msgID. */
export function buildMessageIdPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildFetchKatchupPayload({
    msgID: nonExistentMsgId(),
    messageIds: [nonExistentMsgId()],
    ...overrides,
  });
}

/** A search over message bodies. */
export function buildSearchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildFetchKatchupPayload({
    searchMessage: 'QA-AUTOMATION',
    ...overrides,
  });
}

/** The `KatchupFilterRO` DTO — katchupSearch and filterKatchUpMessage. */
export function buildKatchupFilterPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 30 * 86_400_000);
  return {
    contactType: [],
    messageType: [],
    contentType: [],
    fromDate: iso(from),
    toDate: iso(today),
    keyWord: 'QA-AUTOMATION',
    searchMessage: 'QA-AUTOMATION',
    searchContactText: '',
    ...overrides,
  };
}

/** The `ReportDetailsRO` DTO — reportAbuse. */
export function buildReportAbusePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kpostID: syntheticReceiver(),
    msgID: nonExistentMsgId(),
    reportID: [1],
    reason: `${qaLabel('report')} automated test report`,
    ...overrides,
  };
}

/** A caption edit against an existing attachment. */
export function buildChangeCaptionPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildExistingMessagePayload({
    attachmentCaption: JSON.stringify([{ fileName: 'qa.png', caption: qaLabel('caption') }]),
    ...overrides,
  });
}

/** A forward of one or more messages to synthetic recipients. */
export function buildForwardPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildExistingMessagePayload({
    forwardReceiverList: [syntheticReceiver()],
    ...overrides,
  });
}
