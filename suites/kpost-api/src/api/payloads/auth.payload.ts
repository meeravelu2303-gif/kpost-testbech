import { faker } from '../../utils/dataGen';
import { env } from '../../config/env.config';

/**
 * A mobile number in the reserved synthetic test block (9000000xxx), the same pattern as
 * TEST_MOBILE. Used ONLY for the OTP-driven signup flow so that sendOTP never dispatches an
 * SMS to a real subscriber. This is deliberately NOT randomMobileNumber(), whose faker output
 * is a real 10-digit number - see the OTP-pinning note in CLAUDE.md.
 */
export function syntheticTestMobile(): string {
  return `9000000${faker.string.numeric(3)}`;
}

export function randomMobileNumber(): string {
  // 10-digit Indian-format mobile number, matches the sendOTP country-length rule.
  return `9${faker.string.numeric(9)}`;
}

/**
 * KPOST account domains, keyed by account type.
 *
 * Verified against `POST /v2/common/domain` on the live backend rather than assumed:
 *
 *   PERSONAL     -> ["@kpostindia.com"]
 *   BUSINESS     -> ["@kpost.in"]
 *   INSTITUTION  -> ["@kpostindia.com"]
 *
 * Note the split is **two domains across three account types** — INSTITUTION shares the
 * personal domain, so "business vs personal" is not a clean binary and hardcoding a domain
 * per test is how the wrong one gets used.
 *
 * `@kpost.in` is the business **base** domain, not a usable suffix on its own: plain signup
 * refuses `qadom13299@kpost.in` with "Domain is not available". A business identity is
 * `<handle>@<uniqueName>.kpost.in`, where `uniqueName` is the company's own field on the same
 * request — `api.json` shows `uniqueName: "rkveg"` paired with `kpostID: "md@rkveg.kpost.in"`.
 * Use `businessKpostId()` so the two can never drift apart.
 */
export const DOMAIN_BY_USER_TYPE: Readonly<Record<string, string>> = {
  PERSONAL: '@kpostindia.com',
  BUSINESS: '@kpost.in',
  INSTITUTION: '@kpostindia.com',
};

/**
 * Resolves the domain for a user type, tolerating the **size-suffixed** forms the enterprise
 * tier uses (`BUSINESS_M`, `INSTITUTION_S`, `BUSINESS_L`) by matching on the leading word.
 * Unknown types fall back to the personal domain, which is the safe default: it is the one
 * the registration flow accepts for every non-business tier.
 */
export function domainFor(userType: string): string {
  const base = String(userType).toUpperCase().split('_')[0];
  return DOMAIN_BY_USER_TYPE[base] ?? DOMAIN_BY_USER_TYPE.PERSONAL;
}

/**
 * A throwaway identity, **domain included and matched to the account type**.
 *
 * The domain is not optional and the server does not append it. Sending a bare handle is
 * rejected before any row is written, with one of two misleading messages depending on the
 * characters used:
 *
 *   "qaet5q51fu" -> "kpostID must start with a letter or Invalid kpostID"   (it does)
 *   "qatester"   -> "Domain is not available"                               (it is)
 *
 * Neither names the real rule. `POST /v2/common/domain` reports the domain as available the
 * whole time, so the second message is actively wrong — the domain exists, it simply was not
 * present *in the kpostID*. Verified live: the identical payload with
 * "qaseed5116@kpostindia.com" returns 200 and creates the account.
 *
 * This cost the suite an entire unauthenticated run: the token expired, and the throwaway
 * fallback that exists to recover from exactly that could never succeed.
 */
export function randomKpostId(userType: string = 'PERSONAL'): string {
  const base = String(userType).toUpperCase().split('_')[0];
  if (base === 'BUSINESS') return businessKpostId(randomUniqueName());
  return `qa${faker.string.alphanumeric({ length: 8, casing: 'lower' })}${domainFor(userType)}`;
}

/** A company's short slug — becomes both `uniqueName` and the kpostID subdomain. */
export function randomUniqueName(): string {
  return `qa${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
}

/**
 * A business identity: `<handle>@<uniqueName>.kpost.in`.
 *
 * The subdomain must equal the `uniqueName` sent on the same registration, so both come from
 * one value rather than being composed independently at two call sites.
 */
export function businessKpostId(uniqueName: string, handle = 'md'): string {
  return `${handle}@${uniqueName}.kpost.in`;
}

/**
 * The sign-up request as the KPOST functional document defines it (section 1.7).
 *
 * Deliberately narrower than the swagger DTO: `userType`, `countryID` and `domainID` are not
 * part of this request; the server echoes the resulting `email` in the response.
 *
 * It does **not** derive the domain. `kpostID` must already carry it — `@kpostindia.com` for
 * personal and institution accounts, `@kpost.in` for business. Use `randomKpostId(userType)`
 * rather than composing one by hand.
 */
export interface SignupPayload {
  /**
   * Full address including the domain, e.g. `qauser1234@kpostindia.com`. The server does
   * **not** append the domain — see `randomKpostId` for the evidence and the two misleading
   * errors a bare handle produces.
   */
  kpostID: string;
  firstName: string;
  lastName: string;
  mobileNumber: string;
  /** Epoch millis. */
  createdDate: number;
  password: string;
  /** `male` | `female` | `others`, lower-case. */
  gender: string;
  dateOfBirth: string;
  /** `"91"`, without a leading "+". */
  countryCode: string;
  userProfile: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Overrides are intentionally `Record<string, unknown>`, not `Partial<SignupPayload>`: the
 * fuzz suites need to substitute wrong-typed values (a string countryID, an array
 * mobileNumber) to prove the API validates them, which a strict override type would forbid.
 */
/**
 * The sign-up body exactly as the KPOST functional document specifies it (section 1.7).
 *
 * `swagger.json` describes the DTO shape but not what the service accepts, so the functional
 * doc is the authority here. Three things it settles:
 *
 *  - `kpostID` is a **bare handle with no domain**. The server appends the domain itself and
 *    returns `email: "<handle>@kpostindia.com"`. Sending `handle@kpostindia.com`, or passing
 *    the domain separately as `domainID`, is not the documented contract.
 *  - `countryCode` is "91" (no "+"), `gender` is lowercase, `createdDate` is epoch millis.
 *  - There is no `userType`, `countryID`, `domainID` or `email` field on this request.
 *
 * Sign-up is the last step of a six-step pipeline and assumes the mobile number and kpostID
 * were already validated — see `seedUser.ts`, which walks the whole sequence.
 */
export function buildSignupPayload(overrides: Record<string, unknown> = {}): SignupPayload {
  return {
    kpostID: randomKpostId(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    mobileNumber: randomMobileNumber(),
    createdDate: Date.now(),
    password: 'Qa@Passw0rd123',
    gender: 'male',
    dateOfBirth: '1989-07-09',
    countryCode: '91',
    userProfile: {
      landLineNumber: '044444343784',
      referalId: '',
    },
    ...overrides,
  } as SignupPayload;
}

export interface LoginPayload {
  kpostID: string;
  deviceType: string;
  deviceIdentity_primary: string;
  module?: number;
  loginRO: {
    kpostID: string;
    password: string;
    deviceType: string;
    deviceIdentity_primary: string;
    requestType?: string;
  };
  [key: string]: unknown;
}

/**
 * The login body exactly as the KPOST functional document specifies it (section 2.2).
 *
 * `loginRO` carries only `{countryID, password}` — it does **not** take `kpostID`,
 * `deviceType` or `requestType`. Sending `requestType` outside `^(Admin|User|SubAdmin)$` is
 * reported as "Invalid officeType", naming a field that is not part of this DTO at all
 * (`officeType` belongs to `UserProfile`), so the safest thing is to omit it as the document
 * does.
 *
 * The outer `kpostID` accepts either the handle or the registered **mobile number**.
 *
 * `deviceIdentity_primary` is effectively mandatory: `AuthenticationFilter` matches the
 * token's `deviceID` claim against the session table on every later request, so a token
 * minted without one authenticates nothing. `sessionID` follows the document's convention of
 * `deviceIdentity_primary + logintime`.
 *
 * On success `accessToken` is returned at the **top level**, not inside `data`.
 */
export function buildLoginPayload(
  kpostID: string,
  password: string,
  overrides: Record<string, unknown> = {}
): LoginPayload {
  /*
   * The device identity is STABLE by default, not a fresh UUID per call.
   *
   * `AuthenticationFilter` matches the token's `deviceID` claim against the login-session
   * table on every request, so `deviceIdentity_primary` is not decoration - it is half the
   * session's identity. Generating a new UUID here (which this builder used to do) meant:
   *
   *   - every worker's login opened another login-session row, so one `npm test` with four
   *     workers left four sessions behind and weeks of runs left hundreds;
   *   - no token could ever be cached or shared, because each was bound to a device that
   *     only the caller that minted it knew about;
   *   - on an account with a device cap, logins eventually start being refused - reported,
   *     like every other login failure on this platform, as "Invalid Credential".
   *
   * A real client installation presents one stable device id for its lifetime. So does the
   * bench now. Callers that genuinely need a throwaway device - the logout and
   * revoke-all-sessions tests, which must not destroy the shared session - pass
   * `deviceIdentity_primary` explicitly.
   */
  const overriddenDevice = overrides.deviceIdentity_primary;
  const deviceIdentity =
    typeof overriddenDevice === 'string' && overriddenDevice.length > 0
      ? overriddenDevice
      : env.qaDeviceId;
  const logintime = Date.now();

  /*
   * Shape captured from the live KPOST web client (192.168.0.158:3000) on 2026-08-14, verified
   * byte-for-byte against a real userLogin request. Two corrections over the previous shape:
   *
   *   1. `loginRO` carries `userType` alongside `countryID`/`password`. Without it the server
   *      answered `BAD_REQUEST — "Invalid Request or Exception Occurred"` on some accounts,
   *      failing *before* credential validation — so a correct password could never
   *      authenticate. `loginRO:{countryID,password,userType}` reaches the credential check.
   *   2. `login_lattitude` / `login_longitude` / `oneSignal_Key` are present (the misspelling
   *      of "latitude" is the server's own field name, matched deliberately).
   *
   * `userType` defaults to PERSONAL, the tier these QA accounts are registered under; callers
   * with a business/institution identity override it.
   */
  return {
    kpostID,
    deviceType: 'Web',
    deviceIdentity_primary: deviceIdentity,
    deviceIdentity_secondary: 'Desktop-Chrome-151',
    sessionID: `${deviceIdentity}${logintime}`,
    logintime,
    login_lattitude: null,
    login_longitude: null,
    oneSignal_Key: '',
    loginRO: {
      countryID: env.qaCountryId,
      password,
      /*
       * `userType` comes from QA_USER_TYPE rather than being hardcoded. Personal accounts
       * are PERSONAL; a business identity (`<handle>@<uniqueName>.kpost.in`) must send the
       * size-suffixed tier its company was registered under, e.g. BUSINESS_M. Sending the
       * wrong tier fails BEFORE credential validation on some accounts, so a correct
       * password still cannot authenticate - and the error names neither field.
       */
      userType: env.qaUserType,
    },
    // Spread last, so a fuzz case can replace any field - including `loginRO` wholesale -
    // exactly as before.
    ...overrides,
  } as unknown as LoginPayload;
}

export function buildLogoutPayload(kpostID: string, overrides: Record<string, unknown> = {}) {
  return {
    kpostID,
    deviceType: 'WEB',
    deviceIdentity_primary: faker.string.uuid(),
    logoutTime: new Date().toISOString(),
    module: 1,
    ...overrides,
  };
}

// Excel spec: `{ kpostID, currentPassword, accessCode }`.
export function buildSetAccessCodePayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: randomKpostId(),
    currentPassword: 'Qa@Passw0rd123',
    accessCode: faker.string.numeric(6),
    ...overrides,
  };
}

// Excel spec: `{ kpostID, firstName, lastName, mobileNumber }`.
export function buildKpostIdExistPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: randomKpostId(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    mobileNumber: randomMobileNumber(),
    ...overrides,
  };
}

// Excel spec: `{ firstName, lastName, mobileNumber }`.
export function buildKpostIdSuggestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    mobileNumber: randomMobileNumber(),
    ...overrides,
  };
}

export function buildGetLoginHistoryPayload(overrides: Record<string, unknown> = {}) {
  return {
    selectedDate: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

export function buildGenerateJWTokensPayload(
  kpostID: string,
  refreshToken: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    kpostID,
    refreshToken,
    ...overrides,
  };
}

export function buildFetchUserDetailsPayload(kpostID: string, overrides: Record<string, unknown> = {}) {
  return {
    kpostID,
    ...overrides,
  };
}

/**
 * Business/institution registration, built to the shape `api.json` actually shows working.
 *
 * The previous builder sent nine fields and could never succeed. The live backend rejects it
 * in three stages, each message naming a different thing and none naming what is missing:
 *
 *   1. no designation/role -> "Either designation or role must be provided"
 *   2. userType "Business" -> "Invalid maximumMembersCount for userType"
 *   3. userType "BUSINESS_M" + maximumMembersCount: 50 -> same message again
 *
 * Stage 3 is the trap: `maximumMembersCount` is **not a field on this request** — the tracker
 * shows it only on `saveEnquiryDetails`. The message names a parameter the caller is not
 * supposed to send, so adding it (the obvious reading) cannot help. The real requirement is
 * the size-suffixed `userType` plus the full address block below.
 *
 * `kpostID` and `uniqueName` are derived from one slug so the identity always matches the
 * company subdomain — `md@<uniqueName>.kpost.in`.
 */
export function buildAdminRegistrationPayload(overrides: Record<string, unknown> = {}) {
  const uniqueName = randomUniqueName();
  return {
    kpostID: businessKpostId(uniqueName),
    companyName: faker.company.name(),
    entity: 'Vegetable Shop',
    uniqueName,
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    mobileNumber: randomMobileNumber(),
    otherEmail: faker.internet.email(),
    password: 'Qa@Passw0rd123',
    gender: 'male',
    dateOfBirth: '1989-07-09',
    countryID: '1',
    countryCode: '91',
    language: 'english',
    userType: 'BUSINESS_M',
    address1: faker.location.streetAddress(),
    address2: faker.location.secondaryAddress(),
    country: 'india',
    state: 'TamilNadu',
    city: 'Chennai',
    areaName: 'Mylapore',
    designation: 'Managing Director',
    role: '',
    pinCode: '600004',
    referenceName: 'QAREF',
    ...overrides,
  };
}

