import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';
import { KATCHUP_MESSAGE_TYPE, KATCHUP_OBSERVED } from '../enums/kpostTypes';

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
  overrides: Record<string, unknown> = {},
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
    /*
     * Excel rows 37/50/99/139/140: every send carries the attachment and reference envelope,
     * defaulted to null/empty on a plain message. They are part of the DTO rather than optional
     * extras — the forward routes populate them, the ordinary send leaves them empty, and the
     * multipart/bulk variants document the same fields. `attachmentCaption` travels as a JSON
     * STRING (an array of {fileName,caption}), not an array.
     */
    attachmentCaption: '[]',
    uuid: [],
    isVoiceMessage: false,
    mapDetails: null,
    contactDetails: null,
    referenceMessage: null,
    referenceMessageIDList: null,
    referenceMessageList: null,
    forwardReceiverList: null,
    groupForwardList: null,
    groupmemberList: [],
    sharedMessageDetails: null,
    secretMessageExpireTime: null,
    sharedType: 0,
    ...overrides,
  };
}

/**
 * A Copies message — `messageType 14`, which per the Excel Types tab carries BOTH Copies (Cc) and
 * Confidential Copy. They differ only by which list in `sharedMessageDetails` names the person:
 * `copies` -> `revealContactList` (visible to every recipient), `confidential` ->
 * `hiddenContactList` (must be stripped from every copy but the sender's).
 *
 * Mirrors the live web client's payload field for field (captured 2026-09-11):
 *   - delivery is driven by `forwardReceiverList`, which lists EVERY recipient — the Cc /
 *     Confidential people and the primary. An earlier revision used `sharedDetailReceiverList`,
 *     which the client never sends, and no copy was ever delivered.
 *   - `sharedType` is 14, which the Types tab's SHARE TYPE list does NOT include (see
 *     `KATCHUP_OBSERVED.copiesSharedType`). The client sends it, so this does too.
 *   - `isCopyMessage` is not sent; the server sets it on the stored row.
 *   - `sharedDetailReceiverList` IS sent, though the live client omits it: the Excel contract
 *     (KatchupAPI row 37) lists it for sendMessage. Verified 2026-09-11 to change nothing — delivery
 *     and Cc / Confidential visibility are identical with and without it.
 */
export function buildCopyMessagePayload(
  parties: { receiver: string; receiverName?: string; copies?: string[]; confidential?: string[] },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const copies = parties.copies ?? [];
  const confidential = parties.confidential ?? [];
  return buildKatchupMessagePayload({
    receiver: parties.receiver,
    messageType: KATCHUP_MESSAGE_TYPE.copies,
    sharedType: KATCHUP_OBSERVED.copiesSharedType,
    attachmentCaption: null,
    forwardReceiverList: [...copies, ...confidential, parties.receiver],
    sharedDetailReceiverList: [...copies, ...confidential],
    groupForwardList: null,
    groupmemberList: [],
    selectedMembers: 'N',
    sharedMessageDetails: JSON.stringify({
      revealContactList: copies,
      hiddenContactList: confidential,
      receiver: parties.receiver,
      receiverName: parties.receiverName ?? 'QA Primary',
    }),
    ...overrides,
  });
}

/**
 * A referencing action — Note, Reminder, Reply, Comment, Clarify — on an EXISTING message.
 *
 * Built from the live web client's own payload (captured 2026-09-11). The action goes in
 * `sharedType`, NOT in a fresh `messageType`, and it references the original through
 * `temporaryMsgID` plus a `referenceMessage` snapshot of the original row. It deliberately does
 * NOT send `msgID`: `msgID` is the ownership-takeover vector (see gate/security/messageOwnership),
 * so a note built with it silently OVERWRITES the message it claims to annotate. FR-K12 and FR-K13
 * did exactly that and passed while proving nothing.
 *
 * The snapshot is copied from the base row verbatim — including its `sharedMessageDetails`. That
 * faithfulness is the point: on a Confidential Copy the base's `hiddenContactList` rides along in
 * the snapshot, which is how the real client leaks it (NFR-SEC02). A builder that quietly dropped
 * the field would hide the very defect the client produces.
 */
/**
 * The `referenceMessage` snapshot the live web client embeds when it references a message — copied
 * from the base row verbatim, INCLUDING `sharedMessageDetails`. On a Confidential Copy that carries
 * the base's `hiddenContactList`, which is how a Note/Reply leaks it (NFR-SEC02); a helper that
 * dropped the field would hide the defect the real client produces.
 */
export function katchupSnapshotOf(base: Record<string, unknown>): string {
  return JSON.stringify({
    receiver: base.receiver,
    sender: base.sender,
    senderName: base.senderName ?? null,
    receiverName: base.receiverName ?? null,
    msgID: base.msgID,
    actualMessage: base.actualMessage,
    attachmentCaption: null,
    messageTime: base.messageTime,
    readTime: null,
    referenceMessage: null,
    selectedMembers: base.selectedMembers ?? 'N',
    serverTime: base.serverTime,
    messageType: base.messageType,
    sharedMessageDetails: base.sharedMessageDetails ?? null,
    sharedType: base.sharedType ?? 0,
    isVoiceMessage: false,
  });
}

export function buildReferenceActionPayload(
  base: Record<string, unknown>,
  sharedType: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const snapshot = katchupSnapshotOf(base);
  return buildKatchupMessagePayload({
    receiver: base.receiver,
    // The action rides on the thread's own messageType (copies note = 14; plain note = 5), with the
    // action itself in sharedType — matching the live client.
    messageType: base.messageType,
    sharedType,
    temporaryMsgID: base.msgID,
    referenceMsgID: base.msgID,
    referenceMessage: snapshot,
    ...overrides,
  });
}

/**
 * `saveKatchupMessages` (Excel row 38) — an **archive** action over existing message IDs, not a
 * compose. The whole describe used to drive `buildKatchupMessagePayload`, so it fuzzed a compose
 * body at a route that reads `{ receiver | groupKpostID, msgIDs, groupFlag }`.
 *
 * `groupFlag` is a STRING here ("true"/"false") in the Excel, unlike the boolean the send routes
 * take — kept as written rather than normalised.
 */
export function buildSaveMessagesPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    receiver: syntheticReceiver(),
    msgIDs: [nonExistentMsgId(), nonExistentMsgId()],
    groupFlag: 'false',
    ...overrides,
  };
}

/** The group form of the same archive action: keyed by `groupKpostID` instead of `receiver`. */
export function buildSaveGroupMessagesPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    groupKpostID: syntheticReceiver(),
    msgIDs: [nonExistentMsgId(), nonExistentMsgId()],
    groupFlag: 'true',
    ...overrides,
  };
}

/**
 * `getSharedMessageInfo` / `getBulkMessageInfo` (Excel rows 31 and 100) — both key on a single
 * `sharedMessageId`, an epoch-millis broadcast id, not a msgID and not a message body.
 */
export function buildSharedMessageInfoPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    // Far enough past any real broadcast timestamp that it cannot resolve to a live one.
    sharedMessageId: 1_999_000_000_000 + faker.number.int({ min: 1, max: 999_999 }),
    ...overrides,
  };
}

/** A message addressing an existing row. Defaults to a non-existent msgID. */
export function buildExistingMessagePayload(
  overrides: Record<string, unknown> = {},
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
  overrides: Record<string, unknown> = {},
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
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectedContact: syntheticReceiver(),
    groupFlag: false,
    // Excel row 40: the conversation fetch keys on `receiver` and pages with the
    // firstMsgID/lastMsgID cursor pair (null = first page); the group form pages on `msgID`.
    receiver: syntheticReceiver(),
    firstMsgID: null,
    lastMsgID: null,
    msgID: 0,
    ...overrides,
  };
}

/** A fetch addressing a specific message. Defaults to a non-existent msgID. */
export function buildMessageIdPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildFetchKatchupPayload({
    msgID: nonExistentMsgId(),
    messageIds: [nonExistentMsgId()],
    ...overrides,
  });
}

/** A search over message bodies. */
export function buildSearchPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildFetchKatchupPayload({
    searchMessage: 'QA-AUTOMATION',
    ...overrides,
  });
}

/** The `KatchupFilterRO` DTO — katchupSearch and filterKatchUpMessage. */
export function buildKatchupFilterPayload(
  overrides: Record<string, unknown> = {},
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
  overrides: Record<string, unknown> = {},
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
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildExistingMessagePayload({
    attachmentCaption: JSON.stringify([{ fileName: 'qa.png', caption: qaLabel('caption') }]),
    ...overrides,
  });
}

/** A forward of one or more messages to synthetic recipients. */
/**
 * The `messageType` values that select a forward mode (Excel rows 118 / 139 / 194 / 219).
 *
 * The type is not decoration — it decides which reference field the server reads. 15 carries
 * `referenceMessage`, 20 carries the stringified `referenceMessageList`, and 24 carries
 * `referenceMessageIDList`. Sending the wrong pairing produces a forward that references nothing.
 */
export const FORWARD_MESSAGE_TYPE = {
  /** Single-message forward. */
  single: 15,
  /** Multi-thread forward — the "forward with full thread" action. */
  multiThread: 20,
  /** Forward of selected attachments only. */
  selectedAttachment: 24,
} as const;

/**
 * `referenceMessageList` travels as a JSON **string**, not an array:
 * `"[{\"msgIDs1\":[...]},{\"msgIDs2\":[...]}]"` — one object per source thread, keys numbered
 * from 1. Sending a real array is the mistake this helper exists to prevent.
 */
export function referenceMessageListJson(threads: number[][]): string {
  return JSON.stringify(threads.map((ids, index) => ({ [`msgIDs${index + 1}`]: ids })));
}

/**
 * The forward envelope shared by every forward route.
 *
 * `receiver` is deliberately EMPTY: on a forward the recipients travel in `forwardReceiverList`,
 * and the Excel shows `""` for the direct receiver. `sharedMessageDetails`/`groupForwardList`
 * default to null and `groupmemberList` to an empty list, exactly as the contract has them —
 * these are the fields that carry the forwarded thread, so omitting them (as this bench did
 * previously) means the route is only ever exercised as a plain send.
 */
export function buildForwardEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildKatchupMessagePayload({
    receiver: '',
    messageType: FORWARD_MESSAGE_TYPE.single,
    status: '0',
    groupFlag: 'false',
    forwardReceiverList: [syntheticReceiver()],
    groupForwardList: null,
    groupmemberList: [],
    referenceMessage: null,
    sharedMessageDetails: null,
    sharedType: 0,
    temporaryMsgID: 0,
    attachmentCaption: null,
    ...overrides,
  });
}

/** Single-message forward (messageType 15) — Excel rows 118 / 139, first variant. */
export function buildForwardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildForwardEnvelope({
    messageType: FORWARD_MESSAGE_TYPE.single,
    referenceMessage: nonExistentMsgId(),
    ...overrides,
  });
}

/**
 * Forward-with-thread (messageType 20) — the FRD's FR-K16 action. Two synthetic source threads,
 * so the stringified `referenceMessageList` is exercised in its documented multi-group form.
 */
export function buildThreadForwardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildForwardEnvelope({
    messageType: FORWARD_MESSAGE_TYPE.multiThread,
    referenceMessageList: referenceMessageListJson([
      [nonExistentMsgId(), nonExistentMsgId(), nonExistentMsgId()],
      [nonExistentMsgId(), nonExistentMsgId()],
    ]),
    ...overrides,
  });
}

/** `forwardKatchupMultipleMsgs` (Excel row 194) — a flat list of message ids, no message body. */
export function buildMultipleMsgsForwardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    forwardReceiverList: [syntheticReceiver()],
    groupForwardList: [],
    forwardMessageIDList: [nonExistentMsgId(), nonExistentMsgId()],
    attachmentCaption: '[]',
    uuid: [],
    messageType: FORWARD_MESSAGE_TYPE.single,
    sessionID: `QA-${faker.string.alphanumeric(8)}`,
    actualMessage: '[{"insert":"\\n"}]',
    ...overrides,
  };
}

/**
 * `sendMessageForForwardSelectedAttachment` (Excel row 219, messageType 24).
 *
 * This is the route whose `setSender(...)` is commented out server-side, so `sender` is left
 * unset here on purpose — the spoofing case supplies it explicitly.
 */
export function buildForwardSelectedAttachmentPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const uuids = [faker.string.uuid(), faker.string.uuid()];
  return buildForwardEnvelope({
    receiver: syntheticReceiver(),
    messageType: FORWARD_MESSAGE_TYPE.selectedAttachment,
    status: 0,
    groupFlag: false,
    forwardReceiverList: null,
    selectedMembers: 'N',
    secretMessageExpireTime: null,
    referenceMessageIDList: null,
    referenceMessageList: null,
    isVoiceMessage: false,
    uuid: uuids,
    attachmentCaption: JSON.stringify(
      uuids.map((uuid) => ({ fileName: `${uuid}.jpg`, caption: null, fileSize: '28687', uuid })),
    ),
    ...overrides,
  });
}

/** `getMessagesByReferenceMessageList` (Excel row 119) — the thread-forward read-back. */
export function buildReferenceMessageListPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    referenceMessageList: referenceMessageListJson([
      [nonExistentMsgId(), nonExistentMsgId(), nonExistentMsgId()],
      [nonExistentMsgId(), nonExistentMsgId()],
    ]),
    messageType: FORWARD_MESSAGE_TYPE.multiThread,
    ...overrides,
  };
}

/** `getReferenceMessagesDetails` (Excel row 120) — ids plus the message they were forwarded from. */
export function buildReferenceMessagesDetailsPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    referenceMessageIDList: [nonExistentMsgId(), nonExistentMsgId(), nonExistentMsgId()],
    sourceMsgID: nonExistentMsgId(),
    ...overrides,
  };
}
