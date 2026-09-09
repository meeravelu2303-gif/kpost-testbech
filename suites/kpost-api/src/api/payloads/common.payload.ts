import { faker } from '../../utils/dataGen';
import { env } from '../../config/env.config';

/**
 * OTP-dispatching payloads deliberately use the fixed TEST_MOBILE/TEST_EMAIL rather than
 * faker values: a random 10-digit Indian number is a real subscriber, and this suite fires
 * these endpoints hundreds of times.
 */
// Per the KPOST API spec, `sendOTP.requestType` is lowercase — 'signup' | 'business' | 'institution'.
export function buildSendOtpPayload(overrides: Record<string, unknown> = {}) {
  return {
    countryID: env.testCountryId,
    mobileNumber: env.testMobile,
    requestType: 'signup',
    ...overrides,
  };
}

// Excel spec: `{ otp, countryID, mobileNumber, sendDate }` — `sendDate` is the timestamp the
// matching `sendOTP` returned; no `type` field. Tests pass the real `sendDate`/`otp`.
export function buildValidateOtpPayload(
  mobileNumber: string = env.testMobile,
  otp = '000000',
  overrides: Record<string, unknown> = {}
) {
  return {
    otp,
    countryID: env.testCountryId,
    mobileNumber,
    sendDate: Date.now(),
    ...overrides,
  };
}

// Excel spec: `{ otherEmail }`.
export function buildSendMailOtpPayload(overrides: Record<string, unknown> = {}) {
  return {
    otherEmail: env.testEmail,
    ...overrides,
  };
}

// Excel spec: `{ email, sendDate, otp }` — no `type` field.
export function buildValidateMailOtpPayload(
  email: string = env.testEmail,
  otp = '000000',
  overrides: Record<string, unknown> = {}
) {
  return {
    email,
    sendDate: Date.now(),
    otp,
    ...overrides,
  };
}

/** Read-only existence check — safe to use random numbers, nothing is dispatched. */
export function buildMobileNoExistPayload(overrides: Record<string, unknown> = {}) {
  return {
    countryID: env.testCountryId,
    mobileNumber: `9${faker.string.numeric(9)}`,
    ...overrides,
  };
}

export function buildCompanyNameExistPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyName: faker.company.name(),
    ...overrides,
  };
}

export function buildCountryLookupPayload(countryID: number, overrides: Record<string, unknown> = {}) {
  return {
    countryID,
    ...overrides,
  };
}

// Excel spec: `{ postalCode: <number> }` (pinCode / postalPinCode).
export function buildPinCodePayload(overrides: Record<string, unknown> = {}) {
  return {
    postalCode: faker.number.int({ min: 100000, max: 999999 }),
    ...overrides,
  };
}

export function buildDesignationLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    designation: faker.person.jobTitle(),
    ...overrides,
  };
}

export function buildDesignationByProfessionPayload(
  professionID: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    profession: {
      professionID,
      profession: 'Engineering',
    },
    ...overrides,
  };
}

/**
 * OTP-send for the forgot-password flow — `forgotPasswordOTPOrSentKpostIDSms`.
 *
 * Per the KPOST API spec the body is exactly **`{ kpostID, requestType: 'password' }`** — the
 * token-era endpoint keys on `kpostID` (not `mobileNumber`, which the superseded
 * `/v2/profile/forgotPasswordOrKpostID/` used), and `requestType` is lowercase `'password'` to
 * reset a password (vs `'kpostID'` to send back the forgotten id). `kpostID` defaults to a
 * synthetic, non-existent id so the OTP is never dispatched to a real subscriber.
 */
export function buildForgotPasswordPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: 'qa-nonexistent@kpostindia.com',
    requestType: 'password',
    ...overrides,
  };
}

/**
 * Password reset — `forgotPasswordUpdate`. Per the KPOST API spec the body is exactly
 * `{ kpostID, forgotPassword }` — the new password in `forgotPassword`, and no other fields
 * (`mobileNumber` / `confirmPassword` / `requestType` are not part of this DTO). `kpostID`
 * defaults to a synthetic, non-existent id so a "successful" reset can never overwrite the
 * shared QA account.
 */
export function buildForgotPasswordUpdatePayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: 'qa-nonexistent@kpostindia.com',
    forgotPassword: 'Qa@NewPassw0rd456',
    ...overrides,
  };
}

// Excel spec: `{ countryID, userType }` — userType is 'PERSONAL' | 'BUSINESS' | 'INSTITUTION'.
export function buildDomainPayload(overrides: Record<string, unknown> = {}) {
  return {
    countryID: env.testCountryId,
    userType: 'BUSINESS',
    ...overrides,
  };
}

export function buildGenerateDomainPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: `qa${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`,
    companyName: faker.company.name(),
    ...overrides,
  };
}

/**
 * Persists a sales lead a human may follow up on — pinned to the safe test contact.
 * Excel spec fields: companyName, entity, maximumMembersCount, firstName, lastName,
 * designation, mobileNumber, email, timeToContact.
 */
export function buildEnquiryPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyName: `QA-AUTOMATION-${faker.string.alphanumeric(6)}`,
    entity: 'Software',
    maximumMembersCount: 10,
    firstName: 'QaAutomation',
    lastName: 'Tester',
    designation: faker.person.jobTitle(),
    mobileNumber: env.testMobile,
    email: env.testEmail,
    timeToContact: '10:00 AM',
    ...overrides,
  };
}

/* ===========================================================================================
 * Common Reference V2 — the 14 endpoints beyond the original core subset.
 *
 * **The whole `/v2/common/**` tree is in the Spring Security `permitAll` list**
 * (`SecurityConfiguration.java:55`), so every route here is reachable with no token. That is
 * defensible for registration-time reference data — country lists, name availability — and
 * indefensible for the three things that also live there: a directory lookup that resolves a
 * phone number to a real person, a Katchup message sender that takes its `sender` from the
 * body, and a global app-version write.
 *
 * Two safety rules follow:
 *
 *  - `sendMessage` uses **synthetic sender and receiver only**. It delivers a real Katchup
 *    message and raises a real push; a real receiver would be spammed by a spoofed sender.
 *  - `updateFlutterAppVersion` changes the version **every Flutter client is told to run**.
 *    The builder deliberately produces a body that cannot succeed, and the tests assert the
 *    refusal rather than attempting the write.
 * ======================================================================================== */

/** A well-formed Indian mobile number in a block that should not be allocated. */
export function syntheticMobileNumber(): string {
  return `90000${faker.string.numeric(5)}`;
}

/** A kpostID that is not a real subscriber. */
export function syntheticCommonKpostId(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@kpostindia.com`;
}

// Excel spec: `{ mobileNumber }` (getUserDetailsByMobNo / getCompanyDetails / getCompanyDetailsByAdmin).
export function buildMobileLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    mobileNumber: syntheticMobileNumber(),
    ...overrides,
  };
}

/** A company lookup by id. */
export function buildCompanyLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyID: 999_000_000,
    ...overrides,
  };
}

// Excel spec: `{ mobileNumber, productId }` — productId is a product ObjectId string.
export function buildCompanyByMobilePayload(overrides: Record<string, unknown> = {}) {
  return {
    mobileNumber: syntheticMobileNumber(),
    productId: '000000000000000000000000',
    ...overrides,
  };
}

// Excel spec: `{ mobileNumber, companyID }`.
export function buildCompanyMobileExistPayload(overrides: Record<string, unknown> = {}) {
  return {
    mobileNumber: syntheticMobileNumber(),
    companyID: 999_000_000,
    ...overrides,
  };
}

// Excel spec: `{ companyName, uniqueName, domain }`.
export function buildUniqueNameExistPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyName: `QA ${faker.company.name()}`,
    uniqueName: `qa${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`,
    domain: 'kpost.in',
    ...overrides,
  };
}

// Excel spec: `{ regionId }` (getStates / getCitiesByRegionId).
export function buildRegionLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    regionId: 1,
    ...overrides,
  };
}

/** A language lookup. */
export function buildCommonLanguagePayload(overrides: Record<string, unknown> = {}) {
  return {
    countryID: 1,
    ...overrides,
  };
}

// Excel spec: `{ module: [<ids>] }` — module is an ARRAY of module ids (getKpostIdUsingModule).
export function buildModuleLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    module: [0],
    ...overrides,
  };
}

// Excel spec: `{ date: <epoch-millis> }` (getTotalCountByDate) — a single date, not a range.
export function buildCountByDatePayload(overrides: Record<string, unknown> = {}) {
  return {
    date: Date.now(),
    ...overrides,
  };
}

/**
 * The unauthenticated Katchup bridge.
 *
 * Synthetic sender and receiver only — this route delivers a real message and takes both
 * identities from the body.
 */
export function buildCommonSendMessagePayload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    sender: syntheticCommonKpostId(),
    receiver: syntheticCommonKpostId(),
    messageType: 0,
    subject: 'QA-AUTOMATION-common-bridge',
    actualMessage: 'QA-AUTOMATION automated probe — not a real message.',
    messageTime: now,
    serverTime: now,
    status: 0,
    ...overrides,
  };
}

/**
 * A Flutter app-version write that **cannot succeed**.
 *
 * The handler authorises against two hardcoded addresses; this body carries no version at
 * all, so even an allowlisted caller would write nothing. The tests assert the refusal.
 */
export function buildAppVersionPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...overrides,
  };
}

/** A company-logo update. Defaults to a company id that cannot resolve. */
export function buildCompanyLogoPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyID: 999_000_000,
    file: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ...overrides,
  };
}

/**
 * Records an unsubscribe request — `saveUnsubscriberDetails`.
 * Excel spec: `{ sender, receiver, reason, createdBy }`. Pinned to QA-labelled synthetic
 * addresses so nothing real is written.
 */
export function buildUnsubscriberPayload(overrides: Record<string, unknown> = {}) {
  return {
    sender: syntheticCommonKpostId(),
    receiver: `qa-unsubscribe-${faker.string.alphanumeric(6)}@example.com`,
    reason: 'QA-AUTOMATION unsubscribe probe',
    createdBy: syntheticCommonKpostId(),
    ...overrides,
  };
}
