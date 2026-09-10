import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the remaining integration tags.
 *
 * Four of these surfaces cost real money or real quota the moment a call succeeds, so the
 * defaults are chosen to keep every request cheap and unresolvable:
 *
 *  - **TA Wallet** is a payment gateway. `createHash` persists the signature keyed by
 *    `email`, so the builder emits a synthetic address and a token amount. The
 *    form-encoded callbacks write a transaction row per call, so their order ids are
 *    provably non-existent.
 *  - **AI assistant / MetaDee** call an LLM provider, billed per token. Prompts are kept to
 *    one short sentence, and the tests never loop over them.
 *  - **Voice / STT** bills per second of audio. The builder sends a reference, never a real
 *    recording.
 *  - **AWS S3 delete** is irreversible; its UUID default cannot resolve.
 */

/** An email that is not a real mailbox — the hash table is keyed on this. */
export function syntheticEmail(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@example.invalid`;
}

/** An order id that cannot match a real transaction. */
export function nonExistentOrderId(): string {
  return `QA-NOORDER-${faker.string.alphanumeric({ length: 10, casing: 'upper' })}`;
}

/** An object UUID that cannot resolve to a stored attachment. */
export function nonExistentUuid(): string {
  return faker.string.uuid();
}

/* ============================================================================================
 * AWS S3 pre-signed URLs
 * ========================================================================================= */

/**
 * A pre-signed URL request.
 *
 * A pre-signed URL is a **bearer credential in link form**: once issued it works from
 * anywhere, with no KPOST token, until it expires. The tests therefore care as much about
 * *who* can obtain one, and for what key, as about the response shape.
 */
// Excel spec: `{ extension, fileName, fileSize }` (generate-presigned-url + katchup variant).
export function buildPresignedUrlPayload(overrides: Record<string, unknown> = {}) {
  return {
    extension: 'png',
    fileName: `qa-automation-${faker.string.alphanumeric(6)}.png`,
    fileSize: '940',
    ...overrides,
  };
}

// Excel spec: `{ attachmentsUuid: [<uuid>, …] }` — an array of attachment UUIDs.
export function buildCheckAttachmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    attachmentsUuid: [nonExistentUuid()],
    ...overrides,
  };
}

/* ============================================================================================
 * TA Wallet payments
 * ========================================================================================= */

/**
 * Order fields to be signed.
 *
 * The amount is deliberately a token value. If the signing oracle turns out to be open, a
 * test that requested a signature over a large amount would have produced a genuinely
 * spendable artifact; a 1.00 signature proves the same defect and is worth nothing.
 */
export function buildCreateHashPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: syntheticEmail(),
    order_id: nonExistentOrderId(),
    amount: '1.00',
    phone: '9000000000',
    productinfo: qaLabel('order'),
    ...overrides,
  };
}

/** The gateway's form-encoded callback body. Defaults to an order that cannot resolve. */
export function buildPaymentCallbackForm(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    order_id: nonExistentOrderId(),
    response_code: '1',
    amount: '1.00',
    email: syntheticEmail(),
    ...overrides,
  };
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** A transaction lookup by order id. */
export function buildTransactionLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    order_id: nonExistentOrderId(),
    ...overrides,
  };
}

/** The wallet's outbound communication hook. */
export function buildWalletCommunicationPayload(overrides: Record<string, unknown> = {}) {
  return {
    mobileNumber: '9000000000',
    message: `${qaLabel('wallet')} automated probe — not a real notification.`,
    ...overrides,
  };
}

/* ============================================================================================
 * AI assistant
 * ========================================================================================= */

/**
 * A single short prompt.
 *
 * Kept to one sentence on purpose: every call is billed per token against a real provider,
 * and a test suite is the last place that should be generating long completions. The
 * prompt-injection cases below vary the *content*, never the length.
 */
// Excel spec (messageAssist): `{ message, prompt, aiType }` — aiType is chatgpt|perplexity|gemini|mistral|deepseek.
export function buildAiMessagePayload(overrides: Record<string, unknown> = {}) {
  // Excel [L]: { message, prompt, aiType (optional, default deepseek), requestType }.
  return {
    message: 'QA automation probe. Reply with the single word OK.',
    prompt: 'Reply with the single word OK.',
    aiType: 'chatgpt',
    requestType: 'NEW',
    sessionId: faker.string.uuid(),
    ...overrides,
  };
}

/** A session id that cannot belong to the caller. */
export function nonExistentSessionId(): string {
  return faker.string.uuid();
}

/* ============================================================================================
 * Voice / MetaDee
 * ========================================================================================= */

/** A transcription request. Sends a reference, never audio — STT bills per second. */
export function buildVoiceTranslatePayload(overrides: Record<string, unknown> = {}) {
  return {
    uuid: nonExistentUuid(),
    sourceLanguage: 'en',
    targetLanguage: 'ta',
    ...overrides,
  };
}

/** A MetaDee AI message. Same token-cost constraint as the AI assistant. */
export function buildMetaDeePayload(overrides: Record<string, unknown> = {}) {
  return {
    message: 'QA automation probe. Reply with the single word OK.',
    // Excel row 82 documents the prompt body as `content` with a `requestType` selector
    // alongside `message`; sending only `message` left the documented shape unreachable.
    content: 'QA automation probe. Reply with the single word OK.',
    requestType: 'message',
    ...overrides,
  };
}

/* ============================================================================================
 * Enterprise (Medium & Large) authentication
 * ========================================================================================= */

/**
 * Enterprise sign-up.
 *
 * `userType` carries a **size suffix** — `BUSINESS_M`, `INSTITUTION_S`, `BUSINESS_L` — which
 * is what the QA tracker export revealed and what the plain `BUSINESS` value was missing.
 * Sending the un-suffixed form is what produces the otherwise inexplicable
 * "Invalid maximumMembersCount for userType" rejection.
 */
export function buildEnterpriseSignupPayload(overrides: Record<string, unknown> = {}) {
  const handle = `qaent${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
  return {
    kpostID: `md@${handle}.kpost.in`,
    companyName: qaLabel('company'),
    entity: 'QA Automation Entity',
    uniqueName: handle,
    firstName: 'QA',
    lastName: 'Automation',
    mobileNumber: `90000${faker.string.numeric(5)}`,
    otherEmail: syntheticEmail(),
    password: 'Qa@Passw0rd123',
    gender: 'male',
    dateOfBirth: '1990-01-01',
    countryID: '1',
    countryCode: '91',
    language: 'english',
    userType: 'BUSINESS_M',
    address1: '1 QA Street',
    country: 'india',
    state: 'TamilNadu',
    city: 'Chennai',
    areaName: 'Mylapore',
    designation: 'Managing Director',
    pinCode: '600004',
    ...overrides,
  };
}

/** Enterprise admin login. */
export function buildEnterpriseLoginPayload(overrides: Record<string, unknown> = {}) {
  const device = faker.string.uuid();
  return {
    kpostID: `md@qaent${faker.string.alphanumeric(6)}.kpost.in`,
    deviceType: 'Web',
    deviceIdentity_primary: device,
    deviceIdentity_secondary: 'Desktop-Chrome',
    sessionID: faker.string.uuid(),
    logintime: Date.now(),
    // Excel row 211 carries the same geo/push trio as the standard login (the misspelling of
    // "latitude" is the server's own field name, matched deliberately).
    login_lattitude: null,
    login_longitude: null,
    oneSignal_Key: '',
    module: 0,
    voip: 'voip',
    loginRO: { countryID: '1', password: 'Qa@Passw0rd123', userType: 'BUSINESS' },
    ...overrides,
  };
}

/** An admin adding a user to their enterprise. */
export function buildEnterpriseAddUserPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: `qa${faker.string.alphanumeric({ length: 6, casing: 'lower' })}@kpostindia.com`,
    firstName: 'QA',
    lastName: 'Member',
    mobileNumber: `90000${faker.string.numeric(5)}`,
    designation: 'Engineer',
    role: 'User',
    ...overrides,
  };
}
