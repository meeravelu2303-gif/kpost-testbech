import { faker } from '../../utils/dataGen';
import { qaLabel, safeTestMobile } from '../../utils/safeTestData';

/**
 * Request builders for the Company Administration controller.
 *
 * Safety rules encoded here rather than left to each spec — this tag contains the most
 * damaging operations on the platform:
 *
 * 1. **Targets default to a non-existent, QA-prefixed identity.** `terminateUser` is
 *    permanent, `resetPassword` overwrites a credential the previous value of which is
 *    unrecoverable and typically dispatches the new one, and `holdOrRelease` blocks a real
 *    person from signing in. A builder must never default to an identity that could resolve
 *    to a real employee.
 * 2. **Every mobile number routes through `safeTestMobile()`.** Several of these routes
 *    dispatch credentials or notifications by SMS, and a faker-generated 10-digit Indian
 *    number is a real subscriber.
 * 3. **`companyID` defaults to an implausible value** so cross-company reads cannot
 *    accidentally pull a genuine company's roster or settlement details.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** An identity that must not resolve to any real employee. */
export function nonExistentKpostId(): string {
  return `qa-nonexistent-${faker.string.alphanumeric(10)}`;
}

/** A company id that must not resolve to any real company. */
export function nonExistentCompanyId(): string {
  return '999999999';
}

export interface AdminUserRegistrationRequest {
  kpostID: string;
  companyID: number;
  companyName: string;
  firstName: string;
  lastName: string;
  mobileNumber: string;
  userType: string;
  requestType: string;
  [key: string]: unknown;
}

/** Shared by addingUserByAdmin, addingUserForReallocateByAdmin, terminateUser, updateRole. */
export function buildAdminUserRegistrationPayload(
  overrides: Record<string, unknown> = {}
): AdminUserRegistrationRequest {
  // Per the Excel "Admin" rows, addingUserByAdmin allocates a BUSINESS user to a company —
  // it is not a personal signup, so it carries userType/requestType/referenceName, not
  // uniqueName/pinCode/password.
  return {
    kpostID: nonExistentKpostId(),
    companyID: Number(nonExistentCompanyId()),
    companyName: qaLabel('company'),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    mobileNumber: safeTestMobile(),
    gender: 'female',
    countryID: 1,
    countryCode: 91,
    userType: 'BUSINESS_S',
    requestType: 'allocate',
    language: 'english',
    country: 'india',
    designation: faker.person.jobTitle(),
    role: null,
    state: 'tamil nadu',
    activeStatus: 'yes',
    referenceName: qaLabel('ref'),
    ...overrides,
  } as AdminUserRegistrationRequest;
}

/** addingUserForReallocateByAdmin — same shape, requestType flips to `reallocate`. */
export function buildReallocateUserPayload(
  overrides: Record<string, unknown> = {}
): AdminUserRegistrationRequest {
  return buildAdminUserRegistrationPayload({ requestType: 'reallocate', ...overrides });
}

export interface AdminUserActionRequest {
  kpostID: string;
  companyID: number;
  [key: string]: unknown;
}

/**
 * The base user-action body — `{ kpostID, companyID }` per the Excel. Used directly by
 * terminateUser; holdOrRelease adds `activeStatus` and createOrRemoveBackupAdmin adds
 * `isBackUpAdmin`.
 */
export function buildAdminUserActionPayload(
  overrides: Record<string, unknown> = {}
): AdminUserActionRequest {
  return {
    kpostID: nonExistentKpostId(),
    companyID: Number(nonExistentCompanyId()),
    ...overrides,
  } as AdminUserActionRequest;
}

/** terminateUser — the bare `{ kpostID, companyID }` action. */
export function buildTerminateUserPayload(overrides: Record<string, unknown> = {}) {
  return buildAdminUserActionPayload(overrides);
}

/** holdOrRelease — `activeStatus: 'no'` places the account on hold, `'yes'` releases it. */
export function buildHoldPayload(overrides: Record<string, unknown> = {}) {
  return buildAdminUserActionPayload({ activeStatus: 'no', ...overrides });
}

/** createOrRemoveBackupAdmin — `isBackUpAdmin` drives the delegation. */
export function buildBackupAdminPayload(
  isBackUpAdmin: boolean,
  overrides: Record<string, unknown> = {}
) {
  return buildAdminUserActionPayload({ isBackUpAdmin, ...overrides });
}

export interface CompanyDetailsRequest {
  companyName: string;
  address1: string;
  address2: string;
  panNumber: string;
  gstNumber: string;
  [key: string]: unknown;
}

export function buildCompanyDetailsPayload(
  overrides: Record<string, unknown> = {}
): CompanyDetailsRequest {
  // Excel updateCompanyDetails: { companyName, address1, address2, panNumber, gstNumber }.
  return {
    companyName: qaLabel('company'),
    address1: faker.location.streetAddress(),
    address2: faker.location.secondaryAddress(),
    panNumber: 'AAAAA0000A',
    gstNumber: '00AAAAA0000A0Z0',
    ...overrides,
  } as CompanyDetailsRequest;
}

export interface BankAccountRequest {
  accountNumber: string;
  accountHolderName: string;
  ifscCode: string;
  bankName: string;
  branch: string;
  [key: string]: unknown;
}

/**
 * Settlement details. Excel updateBankAccountDetails:
 * { accountNumber, accountHolderName, ifscCode, bankName, branch }. Values are obviously
 * synthetic so that if this payload ever were persisted, the row is recognisable as test data.
 */
export function buildBankAccountPayload(
  overrides: Record<string, unknown> = {}
): BankAccountRequest {
  return {
    accountNumber: '000000000000',
    accountHolderName: qaLabel('holder'),
    ifscCode: 'QATE0000000',
    bankName: 'QA Automation Test Bank',
    branch: 'QA Branch',
    ...overrides,
  } as BankAccountRequest;
}

/**
 * Password reset target. Excel resetPassword: { kpostID, companyID, mobileNumber, countryID,
 * userType } — the backend generates and dispatches the new credential, so no password field
 * is sent. Defaults to a non-existent identity for the reasons above.
 */
export function buildResetPasswordPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: nonExistentKpostId(),
    companyID: Number(nonExistentCompanyId()),
    mobileNumber: safeTestMobile(),
    countryID: 1,
    userType: 'BUSINESS',
    ...overrides,
  };
}

/**
 * Role change. Excel updateRole: { kpostID, role }. Granting "admin" unlocks the whole
 * /admin/** tree for the target, which is why the ownership tests point this at a foreign id.
 */
export function buildUpdateRolePayload(role: string, overrides: Record<string, unknown> = {}) {
  return { kpostID: nonExistentKpostId(), role, ...overrides };
}

/** removeCompanyLogo — Excel: { companyID }. */
export function buildRemoveCompanyLogoPayload(overrides: Record<string, unknown> = {}) {
  return { companyID: Number(nonExistentCompanyId()), ...overrides };
}

/** displayNameSuggestion — Excel: { companyName, designation }. */
export function buildDisplayNameSuggestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyName: qaLabel('company'),
    designation: faker.person.jobTitle(),
    ...overrides,
  };
}

/** createKpostIDAndDesignationSuggestion — Excel: { companyName, designation, companyID }. */
export function buildKpostIdSuggestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyName: qaLabel('company'),
    designation: faker.person.jobTitle(),
    companyID: Number(nonExistentCompanyId()),
    ...overrides,
  };
}
